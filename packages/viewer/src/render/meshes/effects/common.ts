/**
 * shared TypeGPU schemas, bind group layouts, vertex entrypoint, and helpers for all scene effect shaders
 * (VFXBaseV2, VFXWater, VFXDecal, LightBeam, SixWaySmoke, DecalLit, WetnessDecal, WaterDecal, VFXRefract,
 * VFXRadialBlur, FogSimple, VFXFakeVolumeFog).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import {
	fadeOpacity,
	frameLayout,
	listFade,
	listRow,
	rowBasis,
	rowBlock,
	rowCustom,
	rowPlacement,
	sheetUv,
} from '../../frame/frame-core.ts';
import { PostSchema } from '../../post/post-schema.ts';
import { gbufferBNoLitDecals, gbufferBNormal, gbufferBValid } from '../../shaders/common/gbuffer.ts';
import { octDecode } from '../../shaders/common/octahedral.ts';
import { fogPremultiplied } from '../../sky/fog-shader.ts';
import { DrawSchema, meshInstancesLayout } from '../surfaces/common.ts';

// #region schemas and layouts

/** group 2 bind group layout for effect draws (`looks` is an array of 48-vec4 raw rows per look) */
export const effectDrawLayout = tgpu
	.bindGroupLayout({
		draws: { storage: d.arrayOf(DrawSchema), access: 'readonly' },
		drawIds: { storage: d.arrayOf(d.u32), access: 'readonly' },
		post: { uniform: PostSchema },
		froxels: { texture: d.texture3d(d.f32) },
		lutSampler: { sampler: 'filtering' },
		looks: { storage: d.arrayOf(d.arrayOf(d.vec4f, 48)), access: 'readonly' },
	})
	.$idx(2);

/** group 3 bind group layout matching `createEffectLayout` (bindings 0..21) */
export const effectMaterialLayout = tgpu
	.bindGroupLayout({
		fxTex0: { texture: d.texture2d(d.f32) },
		fxTex1: { texture: d.texture2d(d.f32) },
		fxTex2: { texture: d.texture2d(d.f32) },
		fxTex3: { texture: d.texture2d(d.f32) },
		fxTex4: { texture: d.texture2d(d.f32) },
		fxTex5: { texture: d.texture2d(d.f32) },
		fxTex6: { texture: d.texture2d(d.f32) },
		fxSamp0: { sampler: 'filtering' },
		fxSamp1: { sampler: 'filtering' },
		fxSamp2: { sampler: 'filtering' },
		fxSamp3: { sampler: 'filtering' },
		fxSamp4: { sampler: 'filtering' },
		fxSamp5: { sampler: 'filtering' },
		fxSamp6: { sampler: 'filtering' },
		fxDepth: { texture: d.textureDepth2d() },
		fxSurface: { texture: d.texture2d(d.f32) },
		fxGbufferA: { texture: d.texture2d(d.f32) },
		fxVolume: { texture: d.texture3d(d.f32) },
		fxVolumeSamp: { sampler: 'filtering' },
		fxBackground: { texture: d.texture2d(d.f32) },
		fxBackgroundSamp: { sampler: 'filtering' },
		fxWaterDepth: { texture: d.textureDepth2d() },
	})
	.$idx(3);

// #endregion

// #region row and bit constants

export const FX_TINT = 0;
export const FX_UV = 1;
export const FX_ANIM = 8;
export const FX_SLOT_BITS = 15;
export const FX_BLEND_TINT = 17;
export const FX_DISTURB = 18;
export const FX_WEIGHT = 19;
export const FX_DISSOLVE = 20;
export const FX_DISSOLVE_COLOR = 21;
export const FX_FRESNEL = 22;
export const FX_SOFT = 23;
export const FX_NEAR = 24;
export const FX_MISC = 25;
export const FX_DECAL_FADE = 26;
export const FX_DECAL = 27;
export const FX_OFFSET_DIR = 28;
export const FX_OFFSET = 29;
export const FX_OFFSET_MODE = 30;
export const FX_UNFOGGED = 31;
export const FX_EDGE_COLOR = 32;
export const FX_EDGE = 33;
export const FX_EDGE_ALPHA = 34;
export const FX_CAMERA_PULL = 35;
export const FX_CUSTOM_SCROLL = 36;
export const FX_APPEAR = 40;
export const FX_APPEAR_NOISE = 41;
export const FX_APPEAR_BRIGHT = 42;
export const FX_STACK_FLAGS = 43;
export const FX_FRESNEL_COLOR = 44;
export const FX_NORMAL_MAP = 45;
export const FX_EMISSION = 46;
export const FX_MAIN2 = 47;
export const FX_PARALLAX = 40;
export const FX_CRACK = 41;
export const FX_CRACK_NOISE = 42;
export const FX_OFFSET_SLOT = 6;
export const FX_MOTION_OFFSET = 1;
export const FX_MOTION_SOFT_BODY = 2;

export const ROLE_DISTURB1 = 0;
export const ROLE_DISTURB2 = 1;
export const ROLE_WEIGHT = 2;
export const ROLE_MASK = 3;
export const ROLE_BLEND = 4;
export const ROLE_DISSOLVE = 5;
export const ROLE_NONE = 7;
export const SLOT_RED_ALPHA = 16;
export const SLOT_SOURCE_SHIFT = 5;
export const SLOT_NO_BASE = 128;

export const FX_HAS_TANGENTS = 1024;
export const FX_HAS_COLORS = 67108864;

export const FX_KIND_WATER_SHEET = 1;
export const WS_SOFT_MIN = 28;
export const WS_SOFT_RANGE = 29;

export const FX_KIND_BEAM = 3;

export const BM_COLOR = 0;
export const BM_CONE = 1;
export const BM_DIRECTION = 2;
export const BM_FALLOFF = 3;
export const BM_ALPHA = 4;
export const BM_GLARE = 5;
export const BM_FADE = 6;
export const BM_CLIP = 7;
export const BM_PLANE = 8;
export const BM_TILT = 9;

// #endregion

// #region vertex IO definitions

/** vertex attributes of an effect mesh draw */
export const EffectIn = {
	position: d.location(0, d.vec4f),
	normal: d.location(1, d.vec2f),
	uv0: d.location(2, d.vec2f),
	tangent: d.location(3, d.vec4f),
	uv1: d.location(4, d.vec2f),
	color: d.location(5, d.vec4f),
};

/** inter-stage varyings emitted by `vsEffect` */
export const EffectOut = {
	position: d.builtin.position,
	rel: d.location(0, d.vec3f),
	normal: d.location(1, d.vec3f),
	uv: d.location(2, d.vec4f),
	color: d.location(3, d.vec4f),
	look: d.location(4, d.interpolate('flat', d.u32)),
	toObject0: d.location(5, d.interpolate('flat', d.vec4f)),
	toObject1: d.location(6, d.interpolate('flat', d.vec4f)),
	toObject2: d.location(7, d.interpolate('flat', d.vec4f)),
	up: d.location(8, d.interpolate('flat', d.vec3f)),
	origin: d.location(9, d.interpolate('flat', d.vec4f)),
	placementColor: d.location(10, d.interpolate('flat', d.vec4f)),
	placementUv: d.location(11, d.interpolate('flat', d.vec4f)),
	custom: d.location(12, d.interpolate('flat', d.vec4f)),
	tangent: d.location(13, d.vec4f),
};

/** fragment input matching {@link EffectOut} */
export const EffectFragmentIn = {
	position: d.builtin.position,
	rel: d.location(0, d.vec3f),
	normal: d.location(1, d.vec3f),
	uv: d.location(2, d.vec4f),
	color: d.location(3, d.vec4f),
	look: d.location(4, d.interpolate('flat', d.u32)),
	toObject0: d.location(5, d.interpolate('flat', d.vec4f)),
	toObject1: d.location(6, d.interpolate('flat', d.vec4f)),
	toObject2: d.location(7, d.interpolate('flat', d.vec4f)),
	up: d.location(8, d.interpolate('flat', d.vec3f)),
	origin: d.location(9, d.interpolate('flat', d.vec4f)),
	placementColor: d.location(10, d.interpolate('flat', d.vec4f)),
	placementUv: d.location(11, d.interpolate('flat', d.vec4f)),
	custom: d.location(12, d.interpolate('flat', d.vec4f)),
	tangent: d.location(13, d.vec4f),
};

/** plain helper struct carrying {@link EffectFragmentIn} fields into effect helper functions */
export const EffectVertexData = d.struct({
	position: d.vec4f,
	rel: d.vec3f,
	normal: d.vec3f,
	uv: d.vec4f,
	color: d.vec4f,
	look: d.u32,
	toObject0: d.vec4f,
	toObject1: d.vec4f,
	toObject2: d.vec4f,
	up: d.vec3f,
	origin: d.vec4f,
	placementColor: d.vec4f,
	placementUv: d.vec4f,
	custom: d.vec4f,
	tangent: d.vec4f,
});

/** output target for transparent-accumulated effects (`TRANSPARENT_TARGETS`) */
export const EffectAccumulatedOut = {
	color: d.location(0, d.vec4f),
};

// #endregion

// #region look access and sampling helpers

/**
 * extracts the distortion share of a slot's UVs in 1/1024ths from the high bits of its slot flags.
 *
 * @param bits slot bitfield
 * @returns distortion scale
 */
export const slotDisturb = tgpu.fn(
	[d.u32],
	d.f32,
)((bits) => {
	'use gpu';
	return d.f32(bits >>> d.u32(8)) / 1024;
});

/**
 * reads row `r` of the effect look in slot `id` of `effectDrawLayout.$.looks`.
 *
 * @param id look slot index
 * @param r row index (`0..47`)
 * @returns look row vec4f
 */
export const fxRow = tgpu.fn(
	[d.u32, d.u32],
	d.vec4f,
)((id, r) => {
	'use gpu';
	return d.vec4f(effectDrawLayout.$.looks[id][r]);
});

/**
 * reads the packed bitfield for texture `slot` (`0..6`) of effect look `id`.
 *
 * @param id look slot index
 * @param slot texture slot index (`0..6`)
 * @returns slot bitfield
 */
export const fxSlotBits = tgpu.fn(
	[d.u32, d.u32],
	d.u32,
)((id, slot) => {
	'use gpu';
	const row = fxRow(id, d.u32(FX_SLOT_BITS) + std.intdiv(slot, d.u32(4)));
	const rem = slot % d.u32(4);
	if (rem === d.u32(0)) {
		return d.u32(row.x);
	}
	if (rem === d.u32(1)) {
		return d.u32(row.y);
	}
	if (rem === d.u32(2)) {
		return d.u32(row.z);
	}
	return d.u32(row.w);
});

/**
 * computes the inverse of a 3x3 matrix.
 *
 * @param m invertible 3x3 matrix
 * @returns inverse of `m`
 */
export const inverse3 = tgpu.fn(
	[d.mat3x3f],
	d.mat3x3f,
)((m) => {
	'use gpu';
	const a = std.cross(m.columns[1], m.columns[2]);
	const b = std.cross(m.columns[2], m.columns[0]);
	const c = std.cross(m.columns[0], m.columns[1]);
	const det = std.dot(m.columns[0], a);
	return std.mul(std.transpose(d.mat3x3f(a, b, c)), 1 / det);
});

/**
 * samples effect texture `slot` (`0..6`) at explicit mip `level`.
 *
 * @param slot texture slot index (`0..6`)
 * @param uv texture coordinates
 * @param level explicit mip level
 * @returns sampled texel
 */
export const fxSampleLevel = tgpu.fn(
	[d.u32, d.vec2f, d.f32],
	d.vec4f,
)((slot, uv, level) => {
	'use gpu';
	if (slot === d.u32(0)) {
		return std.textureSampleLevel(effectMaterialLayout.$.fxTex0, effectMaterialLayout.$.fxSamp0, uv, level);
	}
	if (slot === d.u32(1)) {
		return std.textureSampleLevel(effectMaterialLayout.$.fxTex1, effectMaterialLayout.$.fxSamp1, uv, level);
	}
	if (slot === d.u32(2)) {
		return std.textureSampleLevel(effectMaterialLayout.$.fxTex2, effectMaterialLayout.$.fxSamp2, uv, level);
	}
	if (slot === d.u32(3)) {
		return std.textureSampleLevel(effectMaterialLayout.$.fxTex3, effectMaterialLayout.$.fxSamp3, uv, level);
	}
	if (slot === d.u32(4)) {
		return std.textureSampleLevel(effectMaterialLayout.$.fxTex4, effectMaterialLayout.$.fxSamp4, uv, level);
	}
	if (slot === d.u32(5)) {
		return std.textureSampleLevel(effectMaterialLayout.$.fxTex5, effectMaterialLayout.$.fxSamp5, uv, level);
	}
	return std.textureSampleLevel(effectMaterialLayout.$.fxTex6, effectMaterialLayout.$.fxSamp6, uv, level);
});

/**
 * samples effect texture `slot` (`0..6`) with explicit screen-space gradients.
 *
 * @param slot texture slot index (`0..6`)
 * @param uv texture coordinates
 * @param dx dpdx of `uv`
 * @param dy dpdy of `uv`
 * @returns sampled texel
 */
export const fxSample = tgpu.fn(
	[d.u32, d.vec2f, d.vec2f, d.vec2f],
	d.vec4f,
)((slot, uv, dx, dy) => {
	'use gpu';
	if (slot === d.u32(0)) {
		return std.textureSampleGrad(effectMaterialLayout.$.fxTex0, effectMaterialLayout.$.fxSamp0, uv, dx, dy);
	}
	if (slot === d.u32(1)) {
		return std.textureSampleGrad(effectMaterialLayout.$.fxTex1, effectMaterialLayout.$.fxSamp1, uv, dx, dy);
	}
	if (slot === d.u32(2)) {
		return std.textureSampleGrad(effectMaterialLayout.$.fxTex2, effectMaterialLayout.$.fxSamp2, uv, dx, dy);
	}
	if (slot === d.u32(3)) {
		return std.textureSampleGrad(effectMaterialLayout.$.fxTex3, effectMaterialLayout.$.fxSamp3, uv, dx, dy);
	}
	if (slot === d.u32(4)) {
		return std.textureSampleGrad(effectMaterialLayout.$.fxTex4, effectMaterialLayout.$.fxSamp4, uv, dx, dy);
	}
	if (slot === d.u32(5)) {
		return std.textureSampleGrad(effectMaterialLayout.$.fxTex5, effectMaterialLayout.$.fxSamp5, uv, dx, dy);
	}
	return std.textureSampleGrad(effectMaterialLayout.$.fxTex6, effectMaterialLayout.$.fxSamp6, uv, dx, dy);
});

// #endregion

// #region vertex motion and beam shaping

const fxVertexOffset = tgpu.fn(
	[d.u32, d.mat3x3f, d.vec3f, d.vec4f, d.f32],
	d.vec3f,
)((id, m, normal, uv, vertexAlpha) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const dirRow = fxRow(id, d.u32(FX_OFFSET_DIR));
	const params = fxRow(id, d.u32(FX_OFFSET));
	let dir = std.mul(m, dirRow.xyz);
	if (dirRow.w === 1) {
		dir = d.vec3f(dirRow.xyz);
	} else if (dirRow.w === 2) {
		dir = std.mul(m, normal);
	}
	const st = fxRow(id, d.u32(FX_UV + FX_OFFSET_SLOT));
	const speed = fxRow(id, d.u32(FX_ANIM + FX_OFFSET_SLOT)).xy;
	const base = std.select(uv.xy, uv.zw, fxRow(id, d.u32(FX_OFFSET_MODE)).y !== 0);
	const t = std.textureSampleLevel(
		effectMaterialLayout.$.fxTex6,
		effectMaterialLayout.$.fxSamp6,
		std.add(std.add(std.mul(base, st.xy), st.zw), std.mul(speed, frame.eye.w)),
		0,
	).x;
	let weight = 1 - params.z + vertexAlpha * params.z;
	const mask = fxRow(id, d.u32(FX_EDGE_ALPHA)).zw;
	if (mask.y !== 0) {
		const slot = d.u32(mask.x);
		const maskSt = fxRow(id, d.u32(FX_UV) + slot);
		const maskSpeed = fxRow(id, d.u32(FX_ANIM) + slot).xy;
		const r = fxSampleLevel(
			slot,
			std.add(std.add(std.mul(base, maskSt.xy), maskSt.zw), std.mul(maskSpeed, frame.eye.w)),
			0,
		).x;
		weight *= 1 - mask.y * (1 - r);
	}
	return std.mul(dir, params.x * (t * (1 + params.y) - params.y) * weight);
});

const fxCameraPull = tgpu.fn(
	[d.vec3f, d.f32],
	d.vec3f,
)((rel, pull) => {
	'use gpu';
	const cameraDistance = std.length(rel);
	return std.mul(
		std.div(std.neg(rel), std.max(cameraDistance, 1e-6)),
		std.min(std.max(0, cameraDistance - 1), pull) + 0.001,
	);
});

const fxSoftBodyAt = tgpu.fn(
	[d.u32, d.f32, d.vec2f],
	d.vec2f,
)((id, frames, uv1) => {
	'use gpu';
	const scale = fxRow(id, d.u32(FX_UV + FX_OFFSET_SLOT)).xy;
	const play = fxRow(id, d.u32(FX_ANIM + FX_OFFSET_SLOT)).xy;
	const n = std.max(frames, 1);
	const current = std.floor(std.fract(frameLayout.$.frame.eye.w * play.x + play.y) * n);
	return d.vec2f(uv1.x * scale.x, 1 - scale.y * (1 - uv1.y + current / n));
});

const fxSoftBody = tgpu.fn(
	[d.vec3f, d.vec3f, d.vec2f, d.vec3f, d.vec2f],
	d.vec3f,
)((low, range, at, p, uv1) => {
	'use gpu';
	const texel = std.textureSampleLevel(
		effectMaterialLayout.$.fxTex6,
		effectMaterialLayout.$.fxSamp6,
		at,
		0,
	).xyz;
	return std.select(std.add(std.add(p, std.mul(range, texel)), low), d.vec3f(0), uv1.y <= 0.1);
});

const fxSoftBodyNormal = tgpu.fn(
	[d.vec2f, d.f32],
	d.vec3f,
)((at, packing) => {
	'use gpu';
	let q = std.textureSampleLevel(effectMaterialLayout.$.fxTex5, effectMaterialLayout.$.fxSamp5, at, 0);
	if (packing === 1) {
		q = std.sub(std.mul(q, 2), d.vec4f(1));
	}
	const up = d.vec3f(0, 1, 0);
	return std.normalize(
		std.add(up, std.mul(std.cross(q.xyz, std.add(std.mul(up, q.w), std.cross(q.xyz, up))), 2)),
	);
});

/**
 * computes a light beam's scale from its unit cone (largest radius across, length along).
 *
 * @param id look slot index
 * @returns beam scale vector
 */
export const beamScale = tgpu.fn(
	[d.u32],
	d.vec3f,
)((id) => {
	'use gpu';
	const cone = fxRow(id, d.u32(BM_CONE));
	const radius = std.max(std.max(cone.x, cone.y), 1e-6);
	return d.vec3f(radius, radius, fxRow(id, d.u32(BM_FALLOFF)).z);
});

const beamVertex = tgpu.fn(
	[d.u32, d.vec3f],
	d.vec3f,
)((id, p) => {
	'use gpu';
	const cone = fxRow(id, d.u32(BM_CONE));
	const dir = fxRow(id, d.u32(BM_DIRECTION));
	const scale = beamScale(id);
	const z = p.z * p.z;
	let xy = std.div(std.mul(p.xy, std.mix(cone.x, cone.y, z)), scale.x);
	xy = std.add(xy, std.div(std.mul(dir.xy, z * scale.z), std.mul(scale.xy, dir.z)));
	return d.vec3f(xy, z);
});

/** shared vertex entrypoint for all scene effect phases */
export const vsEffect = tgpu.vertexFn({
	in: {
		...EffectIn,
		ii: d.builtin.instanceIndex,
	},
	out: EffectOut,
})((v) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const entry = meshInstancesLayout.$.list[v.ii];
	const row = meshInstancesLayout.$.rows[listRow(entry)];
	const drawId = effectDrawLayout.$.drawIds[v.ii];
	const draw = effectDrawLayout.$.draws[drawId];
	const id = std.bitcastF32toU32(draw.scale.w) & d.u32(0xffff);
	let p = std.add(draw.offset.xyz, std.mul(v.position.xyz, draw.scale.xyz));
	if (fxRow(id, d.u32(FX_UNFOGGED)).y === FX_KIND_BEAM) {
		p = beamVertex(id, p);
	}
	const origin = std.add(
		d.vec3f(row.t0.w, row.t1.w, row.t2.w),
		meshInstancesLayout.$.blocks[rowBlock(row.block)].xyz,
	);
	const m = rowBasis(row.t0, row.t1, row.t2, row.info);
	const inv = std.transpose(inverse3(m));
	const flags = std.bitcastF32toU32(draw.offset.w);
	const uv = sheetUv(
		row.sheet,
		d.vec4f(
			std.add(std.mul(v.uv0, draw.uv0.xy), draw.uv0.zw),
			std.add(std.mul(v.uv1, draw.uv1.xy), draw.uv1.zw),
		),
	);
	const unpackedColor = std.unpack4x8unorm(row.color);
	const baseColor = std.mul(
		std.select(d.vec4f(1), v.color, (flags & d.u32(FX_HAS_COLORS)) !== d.u32(0)),
		unpackedColor,
	);
	const color = d.vec4f(baseColor.xyz, baseColor.w * fadeOpacity(listFade(entry)));
	let normal = octDecode(v.normal);
	const motion = fxRow(id, d.u32(FX_OFFSET_MODE)).x;
	if (motion === FX_MOTION_SOFT_BODY) {
		const sheet = fxRow(id, d.u32(FX_UNFOGGED)).y === FX_KIND_WATER_SHEET;
		const low = fxRow(id, std.select(d.u32(FX_OFFSET_DIR), d.u32(WS_SOFT_MIN), sheet));
		const range = fxRow(id, std.select(d.u32(FX_OFFSET), d.u32(WS_SOFT_RANGE), sheet));
		const bodyUv = std.add(std.mul(v.uv1, draw.uv1.xy), draw.uv1.zw);
		const at = fxSoftBodyAt(id, low.w, bodyUv);
		p = fxSoftBody(low.xyz, range.xyz, at, p, bodyUv);
		if (sheet) {
			normal = fxSoftBodyNormal(at, range.w);
		}
	}
	let rel = std.add(std.mul(m, p), origin);
	const pull = fxRow(id, d.u32(FX_CAMERA_PULL)).xy;
	const pulled = std.select(d.vec3f(0), fxCameraPull(rel, pull.x), pull.y !== 0);
	if (motion === FX_MOTION_OFFSET) {
		rel = std.add(rel, fxVertexOffset(id, m, normal, uv, color.w));
	}
	rel = std.add(rel, pulled);

	let tangent = d.vec4f(0);
	if ((flags & d.u32(FX_HAS_TANGENTS)) !== d.u32(0)) {
		const det = std.dot(m.columns[0], std.cross(m.columns[1], m.columns[2]));
		const sign = std.select(-1, 1, v.tangent.z >= 0) * std.select(-1, 1, det >= 0);
		tangent = d.vec4f(std.mul(m, octDecode(v.tangent.xy)), sign);
	}

	let placementColor = d.vec4f(1);
	let placementUv = d.vec4f(1, 1, 0, 0);
	const placement = rowPlacement(row.block);
	if (placement !== d.u32(0)) {
		const at = d.u32(d.i32(meshInstancesLayout.$.blocks[rowBlock(row.block)].w) + d.i32(placement));
		placementColor = d.vec4f(meshInstancesLayout.$.placements[at * d.u32(2)]);
		placementUv = d.vec4f(meshInstancesLayout.$.placements[at * d.u32(2) + d.u32(1)]);
	}

	return {
		position: std.mul(frame.viewProj, d.vec4f(rel, 1)),
		rel,
		normal: std.mul(m, normal),
		uv,
		color,
		look: id,
		toObject0: d.vec4f(inv.columns[0], -std.dot(inv.columns[0], origin)),
		toObject1: d.vec4f(inv.columns[1], -std.dot(inv.columns[1], origin)),
		toObject2: d.vec4f(inv.columns[2], -std.dot(inv.columns[2], origin)),
		up: std.normalize(m.columns[1]),
		origin: d.vec4f(origin, std.dot(origin, frame.viewForward.xyz)),
		placementColor,
		placementUv,
		custom: rowCustom(row),
		tangent,
	};
});

// #endregion

// #region UV bases and slot coordinates

/**
 * polar UVs of a point about the centre: angle from +y as a fraction of a turn, and twice the distance.
 *
 * @param centred centred 2D coordinates
 * @returns polar UVs
 */
export const fxPolar = tgpu.fn(
	[d.vec2f],
	d.vec2f,
)((centred) => {
	'use gpu';
	return d.vec2f((std.atan2(centred.x, centred.y) + Math.PI) / (2 * Math.PI), 2 * std.length(centred));
});

/** UV sources a texture slot can start from (`SlotSource`), with their screen-space gradients */
export const FxBases = d.struct({
	uv0: d.vec2f,
	uv1: d.vec2f,
	uv2: d.vec2f,
	uv3: d.vec2f,
	dx0: d.vec2f,
	dx1: d.vec2f,
	dx2: d.vec2f,
	dx3: d.vec2f,
	dy0: d.vec2f,
	dy1: d.vec2f,
	dy2: d.vec2f,
	dy3: d.vec2f,
});

/** selected base UV and screen-space gradients for one slot */
export const FxSlotBase = d.struct({
	uv: d.vec2f,
	dx: d.vec2f,
	dy: d.vec2f,
});

/**
 * computes screen-space gradients for all four UV sources in uniform control flow, wrapping the polar seam.
 *
 * @param uv0 mesh UV0
 * @param uv1 mesh UV1
 * @param polar polar UVs
 * @param screen screen UVs
 * @returns UV sources and gradients
 */
export const fxBases = tgpu.fn(
	[d.vec2f, d.vec2f, d.vec2f, d.vec2f],
	FxBases,
)((uv0, uv1, polar, screen) => {
	'use gpu';
	const pdxRaw = std.dpdx(polar);
	const pdyRaw = std.dpdy(polar);
	const pdx = d.vec2f(pdxRaw.x - std.round(pdxRaw.x), pdxRaw.y);
	const pdy = d.vec2f(pdyRaw.x - std.round(pdyRaw.x), pdyRaw.y);
	return FxBases({
		uv0: d.vec2f(uv0),
		uv1: d.vec2f(uv1),
		uv2: d.vec2f(polar),
		uv3: d.vec2f(screen),
		dx0: std.dpdx(uv0),
		dx1: std.dpdx(uv1),
		dx2: pdx,
		dx3: std.dpdx(screen),
		dy0: std.dpdy(uv0),
		dy1: std.dpdy(uv1),
		dy2: pdy,
		dy3: std.dpdy(screen),
	});
});

/**
 * selects a slot's base UV and gradients from `bases` according to `bits`, or zero when `SLOT_NO_BASE` is
 * set.
 *
 * @param bases precomputed UV sources and gradients
 * @param bits slot bitfield
 * @returns slot base UV and gradients
 */
export const fxSlotBase = tgpu.fn(
	[FxBases, d.u32],
	FxSlotBase,
)((bases, bits) => {
	'use gpu';
	if ((bits & d.u32(SLOT_NO_BASE)) !== d.u32(0)) {
		return FxSlotBase({ uv: d.vec2f(0), dx: d.vec2f(0), dy: d.vec2f(0) });
	}
	const source = (bits >>> d.u32(SLOT_SOURCE_SHIFT)) & d.u32(3);
	if (source === d.u32(0)) {
		return FxSlotBase({ uv: d.vec2f(bases.uv0), dx: d.vec2f(bases.dx0), dy: d.vec2f(bases.dy0) });
	}
	if (source === d.u32(1)) {
		return FxSlotBase({ uv: d.vec2f(bases.uv1), dx: d.vec2f(bases.dx1), dy: d.vec2f(bases.dy1) });
	}
	if (source === d.u32(2)) {
		return FxSlotBase({ uv: d.vec2f(bases.uv2), dx: d.vec2f(bases.dx2), dy: d.vec2f(bases.dy2) });
	}
	return FxSlotBase({ uv: d.vec2f(bases.uv3), dx: d.vec2f(bases.dx3), dy: d.vec2f(bases.dy3) });
});

/**
 * transforms a slot's base UV: scrolled, rotated about the texture centre, then scaled and offset by `_ST`.
 *
 * @param id look slot index
 * @param slot texture slot index (`0..6`)
 * @param base base UV coordinates
 * @returns transformed UVs
 */
export const fxSlotCoords = tgpu.fn(
	[d.u32, d.u32, d.vec2f],
	d.vec2f,
)((id, slot, base) => {
	'use gpu';
	const anim = fxRow(id, d.u32(FX_ANIM) + slot);
	const st = fxRow(id, d.u32(FX_UV) + slot);
	const p = std.sub(std.add(base, std.mul(anim.xy, frameLayout.$.frame.eye.w)), d.vec2f(0.5));
	const r = std.add(d.vec2f(anim.z * p.x - anim.w * p.y, anim.w * p.x + anim.z * p.y), d.vec2f(0.5));
	return std.add(std.mul(r, st.xy), st.zw);
});

/**
 * carries a base UV gradient through a slot's rotation and scale.
 *
 * @param id look slot index
 * @param slot texture slot index (`0..6`)
 * @param g base UV gradient
 * @returns transformed gradient
 */
export const fxSlotGradient = tgpu.fn(
	[d.u32, d.u32, d.vec2f],
	d.vec2f,
)((id, slot, g) => {
	'use gpu';
	const anim = fxRow(id, d.u32(FX_ANIM) + slot);
	const st = fxRow(id, d.u32(FX_UV) + slot);
	return std.mul(d.vec2f(anim.z * g.x - anim.w * g.y, anim.w * g.x + anim.z * g.y), st.xy);
});

/**
 * computes a texture stack slot's UV shift from particle custom data.
 *
 * @param id look slot index
 * @param slot texture slot index (`0..6`)
 * @param custom particle custom data
 * @returns UV shift
 */
export const fxCustomShift = tgpu.fn(
	[d.u32, d.u32, d.vec4f],
	d.vec2f,
)((id, slot, custom) => {
	'use gpu';
	const row = fxRow(id, d.u32(FX_CUSTOM_SCROLL) + std.intdiv(slot, d.u32(2)));
	const scroll = std.select(row.xy, row.zw, slot % d.u32(2) === d.u32(1));
	return std.mul(scroll, std.select(custom.y, custom.x, slot === d.u32(0)));
});

// #endregion

// #region depth, surface, fog, and mist frame helpers

/**
 * near-camera fade at a view depth: fades in from `near.x` to `near.y` and out from `near.z` to `near.w`.
 *
 * @param id look slot index
 * @param depth linear view depth in metres
 * @returns fade multiplier in `[0, 1]`
 */
export const fxNearFade = tgpu.fn(
	[d.u32, d.f32],
	d.f32,
)((id, depth) => {
	'use gpu';
	if (fxRow(id, d.u32(FX_MISC)).x === 0) {
		return 1;
	}
	const near = fxRow(id, d.u32(FX_NEAR));
	return (
		std.saturate((depth - near.x) / (near.y - near.x)) * std.saturate((depth - near.z) / (near.w - near.z))
	);
});

/**
 * reads the main pass's linear view depth at pixel `px`.
 *
 * @param px integer pixel coordinates
 * @returns linear view depth in metres (`1e9` on sky)
 */
export const fxSceneDepth = tgpu.fn(
	[d.vec2i],
	d.f32,
)((px) => {
	'use gpu';
	const depth = std.textureLoad(effectMaterialLayout.$.fxDepth, px, 0);
	return std.select(1e9, frameLayout.$.frame.localLights.w / depth, depth > 0);
});

/**
 * fogs a premultiplied layer over the scene at camera-relative position `rel`, unless `unfogged > 0.5`.
 *
 * @param premultiplied premultiplied linear HDR colour
 * @param alpha coverage in `[0, 1]`
 * @param rel camera-relative position
 * @param position screen pixel position (`in.position.xy`)
 * @param unfogged `> 0.5` to skip fog
 * @returns accumulated RGBA (`rgb` fogged premultiplied, `a` coverage)
 */
export const fxAccumulate = tgpu.fn(
	[d.vec3f, d.f32, d.vec3f, d.vec2f, d.f32],
	d.vec4f,
)((premultiplied, alpha, rel, position, unfogged) => {
	'use gpu';
	if (unfogged > 0.5) {
		return d.vec4f(premultiplied, alpha);
	}
	const fogged = fogPremultiplied(
		effectDrawLayout.$.post,
		effectDrawLayout.$.froxels,
		effectDrawLayout.$.lutSampler,
		premultiplied,
		alpha,
		rel,
		std.div(position, frameLayout.$.frame.renderSize.xy),
	);
	return d.vec4f(fogged, alpha);
});

/**
 * packs additive light over the scene with zero coverage (kept out of fog).
 *
 * @param light additive linear HDR colour
 * @returns accumulated RGBA with `a = 0`
 */
export const fxAdditive = tgpu.fn(
	[d.vec3f],
	d.vec4f,
)((light) => {
	'use gpu';
	return d.vec4f(light, 0);
});

/**
 * returns a no-op transparent output that leaves the scene unchanged.
 *
 * @returns zero RGBA
 */
export const fxNothing = tgpu.fn(
	[],
	d.vec4f,
)(() => {
	'use gpu';
	return d.vec4f(0);
});

/**
 * unpacks the world normal from G-buffer B at pixel `px`, or returns zero where nothing lit was drawn.
 *
 * @param px integer pixel coordinates
 * @returns world normal or zero vector
 */
export const fxSurfaceNormal = tgpu.fn(
	[d.vec2i],
	d.vec3f,
)((px) => {
	'use gpu';
	const gb = std.textureLoad(effectMaterialLayout.$.fxSurface, px, 0);
	if (!gbufferBValid(gb)) {
		return d.vec3f(0);
	}
	return gbufferBNormal(gb);
});

/**
 * returns whether the surface under pixel `px` rejects lit decals (`GBUFFER_NO_LIT_DECALS`).
 *
 * @param px integer pixel coordinates
 * @returns `true` if lit decals are rejected
 */
export const fxKeepsLitDecalsOff = tgpu.fn(
	[d.vec2i],
	d.bool,
)((px) => {
	'use gpu';
	return gbufferBNoLitDecals(std.textureLoad(effectMaterialLayout.$.fxSurface, px, 0));
});

/**
 * reconstructs an effect object's object-to-world basis from its world-to-object rows.
 *
 * @param data interpolated effect vertex data
 * @returns object-to-world 3x3 basis
 */
export const mistBasis = tgpu.fn(
	[EffectVertexData],
	d.mat3x3f,
)((data) => {
	'use gpu';
	return inverse3(std.transpose(d.mat3x3f(data.toObject0.xyz, data.toObject1.xyz, data.toObject2.xyz)));
});

/**
 * reconstructs an effect object's camera-relative origin from its world-to-object rows.
 *
 * @param data interpolated effect vertex data
 * @returns camera-relative origin
 */
export const mistOrigin = tgpu.fn(
	[EffectVertexData],
	d.vec3f,
)((data) => {
	'use gpu';
	return std.neg(std.mul(mistBasis(data), d.vec3f(data.toObject0.w, data.toObject1.w, data.toObject2.w)));
});

// #endregion
