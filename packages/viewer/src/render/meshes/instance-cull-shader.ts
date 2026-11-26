/**
 * GPU instance culling compute shaders: tests each row against frustum/caster planes, local-light spheres,
 * last-frame depth-pyramid occlusion, and LOD bands; appends visible rows to per-bucket regions and builds
 * indirect draw arguments.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { BLOCK_SLOT_BITS, ROW_LOD_SIZE_MASK, ROW_LOD_SIZE_SHIFT } from '../../content/instance-rows.ts';
import { SHADOW_LAYER_MIN_SQUARED, SHADOW_LAYERS } from '../../scene/shadow-volumes.ts';
import { InstanceRow } from '../core/frame-core.ts';

import {
	BUCKET_WORDS,
	COUNTER_WORDS,
	INDIRECT_WORDS,
	ITEM_WORDS,
	ItemFlags,
	NO_BUCKET,
	SLOT_WORDS,
	STATS_WORDS,
	SlotFlags,
} from './gpu-cull-work.ts';

/** workgroups along x of a dispatch at most (WebGPU's default limit) */
export const MAX_GROUPS_X = 65_535;
/** where a bucket's draw index and submesh range start among its words, past its regions */
export const BUCKET_DRAW = 2 * (1 + SHADOW_LAYERS);

const SHADOW_MIN_SQUARED = tgpu.const(d.arrayOf(d.f32, SHADOW_LAYERS), [...SHADOW_LAYER_MIN_SQUARED]);

/** uniform view, shadow, and occlusion parameters for GPU instance culling */
export const CullViewSchema = d.struct({
	planes: d.arrayOf(d.vec4f, 5),
	casterPlanes: d.arrayOf(d.vec4f, 5),
	shadowAxes: d.arrayOf(d.vec4f, 3),
	shadowLayers: d.arrayOf(d.vec4f, 4),
	/** camera-relative spheres (xyz, radius) whose rows cast into a local light's shadow map */
	lightCasters: d.arrayOf(d.vec4f, 8),
	planeCount: d.u32,
	casterPlaneCount: d.u32,
	itemCount: d.u32,
	bucketCount: d.u32,
	pixelFactor: d.f32,
	viewportHeight: d.f32,
	minPixels: d.f32,
	shadowReach: d.f32,
	shadows: d.u32,
	slotsAt: d.u32,
	bucketsAt: d.u32,
	lightCasterCount: d.u32,
	/** last frame's camera-relative view-projection, whose depth the pyramid holds */
	previous: d.mat4x4f,
	/** this frame's eye minus last frame's */
	eyeDelta: d.vec3f,
	/** 1 to test rows in view against the pyramid */
	occlusion: d.u32,
	/** the pyramid's first level, texels, and its levels */
	pyramidSize: d.vec2f,
	pyramidLevels: d.u32,
	near: d.f32,
});

/** bind group layout for {@link csCullWrite} and {@link csCullArguments} */
export const instanceCullLayout = tgpu.bindGroupLayout({
	view: { uniform: CullViewSchema },
	rows: { storage: d.arrayOf(InstanceRow), access: 'readonly' },
	blocks: { storage: d.arrayOf(d.vec4f), access: 'readonly' },
	work: { storage: d.arrayOf(d.u32), access: 'readonly' },
	counters: { storage: d.arrayOf(d.atomic(d.u32)), access: 'mutable' },
	list: { storage: d.arrayOf(d.u32), access: 'mutable' },
	drawIds: { storage: d.arrayOf(d.u32), access: 'mutable' },
	indirect: { storage: d.arrayOf(d.u32), access: 'mutable' },
	pyramid: { texture: d.texture2d(d.f32), sampleType: 'unfilterable-float' },
});

const Tested = d.struct({
	drawn: d.bool,
	inView: d.bool,
	occluded: d.bool,
	squared: d.f32,
	mirrored: d.u32,
	layer: d.u32,
});

const firstLayer = tgpu.fn(
	[d.vec3f, d.f32],
	d.u32,
)((p, radius) => {
	'use gpu';
	const view = instanceCullLayout.$.view;
	if (view.shadows === 0) {
		return d.u32(SHADOW_LAYERS);
	}
	const u = std.dot(p, view.shadowAxes[0].xyz);
	const v = std.dot(p, view.shadowAxes[1].xyz);
	const w = std.dot(p, view.shadowAxes[2].xyz);
	for (let layer = d.u32(0); layer < SHADOW_LAYERS; layer++) {
		const s = view.shadowLayers[layer];
		const reach = s.w + radius;
		const dw = w - s.z;
		if (
			std.abs(u - s.x) <= reach &&
			std.abs(v - s.y) <= reach &&
			dw <= reach &&
			dw >= -reach - view.shadowReach
		) {
			return layer;
		}
	}
	return d.u32(SHADOW_LAYERS);
});

const inPlanes = tgpu.fn(
	[d.vec3f, d.f32],
	d.bool,
)((p, radius) => {
	'use gpu';
	const view = instanceCullLayout.$.view;
	for (let i = d.u32(0); i < view.planeCount; i++) {
		const plane = view.planes[i];
		if (std.dot(plane.xyz, p) + plane.w < -radius) {
			return false;
		}
	}
	return true;
});

const inCasterPlanes = tgpu.fn(
	[d.vec3f, d.f32],
	d.bool,
)((p, radius) => {
	'use gpu';
	const view = instanceCullLayout.$.view;
	for (let i = d.u32(0); i < view.casterPlaneCount; i++) {
		const plane = view.casterPlanes[i];
		if (std.dot(plane.xyz, p) + plane.w < -radius) {
			return false;
		}
	}
	return true;
});

const inLightCasters = tgpu.fn(
	[d.vec3f, d.f32],
	d.bool,
)((p, radius) => {
	'use gpu';
	const view = instanceCullLayout.$.view;
	for (let i = d.u32(0); i < view.lightCasterCount; i++) {
		const sphere = view.lightCasters[i];
		const delta = std.sub(p, sphere.xyz);
		const reach = radius + sphere.w;
		if (std.dot(delta, delta) <= reach * reach) {
			return true;
		}
	}
	return false;
});

const isOccluded = tgpu.fn(
	[d.vec3f, d.f32],
	d.bool,
)((p, radius) => {
	'use gpu';
	const view = instanceCullLayout.$.view;
	const centre = std.add(p, view.eyeDelta);
	let low = d.vec2f(1);
	let high = d.vec2f(-1);
	let nearest = d.f32(0);
	for (let i = d.u32(0); i < 8; i++) {
		const corner = std.add(
			centre,
			std.mul(
				radius,
				d.vec3f(
					std.select(d.f32(-1), d.f32(1), (i & 1) !== 0),
					std.select(d.f32(-1), d.f32(1), (i & 2) !== 0),
					std.select(d.f32(-1), d.f32(1), (i & 4) !== 0),
				),
			),
		);
		const clip = std.mul(view.previous, d.vec4f(corner, 1));
		if (clip.w < view.near) {
			return false;
		}
		const ndc = std.div(clip.xyz, clip.w);
		low = std.min(low, ndc.xy);
		high = std.max(high, ndc.xy);
		nearest = std.max(nearest, ndc.z);
	}
	if (std.any(std.lt(low, d.vec2f(-1))) || std.any(std.gt(high, d.vec2f(1)))) {
		return false;
	}
	const size = view.pyramidSize;
	const first = std.sub(
		d.vec2i(std.floor(std.mul(std.add(std.mul(d.vec2f(low.x, -high.y), 0.5), d.vec2f(0.5)), size))),
		d.vec2i(1),
	);
	const last = std.add(
		d.vec2i(std.floor(std.mul(std.add(std.mul(d.vec2f(high.x, -low.y), 0.5), d.vec2f(0.5)), size))),
		d.vec2i(1),
	);
	const span = std.max(last.x - first.x, last.y - first.y);
	const level = d.u32(std.ceil(std.log2(d.f32(std.max(span, 1)))));
	if (level >= view.pyramidLevels) {
		return false;
	}
	const edge = std.sub(d.vec2i(std.textureDimensions(instanceCullLayout.$.pyramid, level)), d.vec2i(1));
	const start = std.clamp(d.vec2i(first.x >> level, first.y >> level), d.vec2i(0), edge);
	const stop = std.clamp(d.vec2i(last.x >> level, last.y >> level), d.vec2i(0), edge);
	let farthest = d.f32(1);
	for (let y = start.y; y <= stop.y; y++) {
		for (let x = start.x; x <= stop.x; x++) {
			farthest = std.min(
				farthest,
				std.textureLoad(instanceCullLayout.$.pyramid, d.vec2i(x, y), d.i32(level)).r,
			);
		}
	}
	return nearest < farthest;
});

const testRow = tgpu.fn(
	[d.u32, d.u32],
	Tested,
)((rowIndex, flags) => {
	'use gpu';
	const view = instanceCullLayout.$.view;
	const row = instanceCullLayout.$.rows[rowIndex];
	const extent = row.extent;
	const block = row.block & d.u32((1 << BLOCK_SLOT_BITS) - 1);
	const p = std.add(instanceCullLayout.$.blocks[block].xyz, row.center);
	const radius = std.length(extent);
	const dist = std.max(std.length(p), 0.1);
	const pixels = (radius * view.pixelFactor) / dist;
	if (pixels < view.minPixels) {
		return Tested({ drawn: false, inView: false, occluded: false, squared: 0, mirrored: 0, layer: 0 });
	}
	const inView = (flags & ItemFlags.Inside) !== 0 || inPlanes(p, radius);
	if (!inView) {
		const sunCaster = view.casterPlaneCount !== 0 && inCasterPlanes(p, radius);
		if (!sunCaster && !inLightCasters(p, radius)) {
			return Tested({ drawn: false, inView: false, occluded: false, squared: 0, mirrored: 0, layer: 0 });
		}
	}
	const layer = firstLayer(p, radius);
	if (!inView && layer >= SHADOW_LAYERS) {
		return Tested({ drawn: false, inView: false, occluded: false, squared: 0, mirrored: 0, layer: 0 });
	}
	const lodBits = (row.info >>> d.u32(ROW_LOD_SIZE_SHIFT)) & d.u32(ROW_LOD_SIZE_MASK);
	const lodSize = std.unpack2x16float(lodBits).x;
	const size = std.select(std.max(extent.x, std.max(extent.y, extent.z)), lodSize, lodBits !== d.u32(0));
	const relative = (2 * size * view.pixelFactor) / (dist * view.viewportHeight);
	const basis = d.mat3x3f(row.t0.xyz, row.t1.xyz, row.t2.xyz);
	const mirrored = std.select(d.u32(0), d.u32(1), std.determinant(basis) < 0);
	const occludedFlag = inView && view.occlusion !== 0 && (flags & 0x00ff0000) === 0 && isOccluded(p, radius);
	return Tested({
		drawn: true,
		inView,
		occluded: occludedFlag,
		squared: relative * relative,
		mirrored,
		layer,
	});
});

const itemOf = tgpu.fn(
	[d.vec3u],
	d.u32,
)((group) => {
	'use gpu';
	return group.x + group.y * MAX_GROUPS_X;
});

const appendRow = tgpu.fn(
	[d.u32, d.u32, d.u32],
	d.Void,
)((bucket, region, row) => {
	'use gpu';
	const b = instanceCullLayout.$.view.bucketsAt + bucket * BUCKET_WORDS;
	const i = std.atomicAdd(instanceCullLayout.$.counters[STATS_WORDS + bucket * COUNTER_WORDS + region], 1);
	if (i < instanceCullLayout.$.work[b + region * 2 + 1]) {
		const at = instanceCullLayout.$.work[b + region * 2] + i;
		instanceCullLayout.$.list[at] = row;
		instanceCullLayout.$.drawIds[at] = instanceCullLayout.$.work[b + BUCKET_DRAW];
	}
});

/** tests each row and appends it to its visible/shadow bucket regions */
export const csCullWrite = tgpu.computeFn({
	workgroupSize: [64],
	in: {
		group: d.builtin.workgroupId,
		lane: d.builtin.localInvocationIndex,
	},
})((input) => {
	'use gpu';
	const view = instanceCullLayout.$.view;
	const work = instanceCullLayout.$.work;
	const item = itemOf(input.group);
	if (item >= view.itemCount) {
		return;
	}
	const at = item * ITEM_WORDS;
	const packed = work[at + 1];
	if (input.lane >= (packed & 255)) {
		return;
	}
	const row = work[at] + input.lane;
	const tested = testRow(row, packed);
	if (!tested.drawn) {
		return;
	}
	const listEntry = row | ((packed & 0x00ff0000) << 8);
	const slots = view.slotsAt + work[at + 2] * SLOT_WORDS;
	for (let s = d.u32(0); s < work[at + 3]; s++) {
		const slot = slots + s * SLOT_WORDS;
		if (
			!(
				tested.squared > std.bitcast(d.f32, d.u32)(work[slot]) &&
				tested.squared <= std.bitcast(d.f32, d.u32)(work[slot + 1])
			)
		) {
			continue;
		}
		const flags = work[slot + 2];
		const casts = (flags & SlotFlags.Casts) !== 0;
		if (!tested.inView && !casts) {
			continue;
		}
		const bucket = work[slot + 3 + tested.mirrored];
		if (bucket === NO_BUCKET) {
			continue;
		}
		if (tested.inView && !tested.occluded && (flags & SlotFlags.ShadowOnly) === 0) {
			appendRow(bucket, 0, listEntry);
		}
		if (casts) {
			for (let layer = tested.layer; layer < SHADOW_LAYERS; layer++) {
				const takes = std.select(
					d.u32(SlotFlags.Realtime),
					d.u32(SlotFlags.Static),
					layer === SHADOW_LAYERS - 1,
				);
				if ((flags & takes) !== 0 && tested.squared > SHADOW_MIN_SQUARED.$[layer]) {
					appendRow(bucket, 1 + layer, listEntry);
				}
			}
		}
	}
});

/** writes each bucket's indirect draw arguments from its atomic counts and sums stats */
export const csCullArguments = tgpu.computeFn({
	workgroupSize: [64],
	in: { id: d.builtin.globalInvocationId },
})((input) => {
	'use gpu';
	const view = instanceCullLayout.$.view;
	const work = instanceCullLayout.$.work;
	const bucket = input.id.x;
	if (bucket >= view.bucketCount) {
		return;
	}
	const b = view.bucketsAt + bucket * BUCKET_WORDS;
	const c = STATS_WORDS + bucket * COUNTER_WORDS;
	const indexCount = work[b + BUCKET_DRAW + 1];
	const firstIndex = work[b + BUCKET_DRAW + 2];
	const baseVertex = work[b + BUCKET_DRAW + 3];
	for (let region = d.u32(0); region <= SHADOW_LAYERS; region++) {
		const count = std.min(
			std.atomicLoad(instanceCullLayout.$.counters[c + region]),
			work[b + region * 2 + 1],
		);
		const out = bucket * INDIRECT_WORDS + region * 5;
		instanceCullLayout.$.indirect[out] = indexCount;
		instanceCullLayout.$.indirect[out + 1] = count;
		instanceCullLayout.$.indirect[out + 2] = firstIndex;
		instanceCullLayout.$.indirect[out + 3] = baseVertex;
		instanceCullLayout.$.indirect[out + 4] = work[b + region * 2];
		if (region === 0 && count > 0) {
			std.atomicAdd(instanceCullLayout.$.counters[0], count);
			std.atomicAdd(instanceCullLayout.$.counters[1], count * std.intdiv(indexCount, 3));
		}
	}
});
