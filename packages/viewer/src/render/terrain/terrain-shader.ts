/**
 * CDLOD terrain shaders: vertex morphing, baked surface pages, 4-layer close-up triplanar height-blended
 * splatting with tinting, standing-water puddles, wireframe, and shadow hole-discard passes.
 *
 * @module
 */

import {
	TERRAIN_LEAF_METRES,
	TERRAIN_PAGE_SAMPLES,
	TERRAIN_SPLAT_CELL_METRES,
	TERRAIN_SPLAT_CELLS,
	TERRAIN_SURFACE_BORDER,
	TERRAIN_SURFACE_TEXELS,
} from '@endfield-noclip/package-format/terrain';

import tgpu, { d, std } from 'typegpu';

import {
	GBufferOut,
	Surface,
	defaultSurface,
	frameLayout,
	hue,
	packGbuffer,
	packGbufferUnlit,
} from '../core/frame-core.ts';

/** GPU schema of one terrain patch instance */
export const TerrainPatchSchema = d.struct({
	origin: d.vec4f,
	info: d.vec4u,
	morph: d.vec4f,
	surface: d.vec4f,
	detail: d.vec4f,
});

/** GPU schema of one close-up terrain material layer */
export const TerrainLayerSchema = d.struct({
	tiling: d.vec4f,
	diffuse: d.vec4f,
	mean: d.vec4f,
	remap0: d.vec4f,
	remap1: d.vec4f,
});

/** group 1 bind group layout matching `BindLayouts.terrain` (bindings 0..11) */
export const terrainLayout = tgpu
	.bindGroupLayout({
		heights: { storage: d.arrayOf(d.u32), access: 'readonly' },
		patches: { storage: d.arrayOf(TerrainPatchSchema), access: 'readonly' },
		surfaceAlbedo: { texture: d.texture2dArray(d.f32) },
		surfaceNormal: { texture: d.texture2dArray(d.f32) },
		surfaceSampler: { sampler: 'filtering' },
		detailControl: { texture: d.texture2dArray(d.f32) },
		detailTint: { texture: d.texture2dArray(d.f32) },
		layerDiffuse: { texture: d.texture2dArray(d.f32) },
		layerNormal: { texture: d.texture2dArray(d.f32) },
		detailIndex: { storage: d.arrayOf(d.u32), access: 'readonly' },
		layers: { storage: d.arrayOf(TerrainLayerSchema), access: 'readonly' },
		layerSampler: { sampler: 'filtering' },
	})
	.$idx(1);

const SIDE = TERRAIN_PAGE_SAMPLES;
const LAST = SIDE - 1;
const PAGE_WORDS = Math.floor((SIDE * SIDE + 1) / 2);
const GRID = Math.floor(LAST / 2) + 1;
const PAGE_TEXELS = TERRAIN_SURFACE_TEXELS;
const PAGE_BORDER = TERRAIN_SURFACE_BORDER;
const LEAF_METRES = TERRAIN_LEAF_METRES;
const CELL_METRES = TERRAIN_SPLAT_CELL_METRES;
const CELLS = TERRAIN_SPLAT_CELLS;

const DETAIL_FADE_START = 96;
const DETAIL_FADE_END = 144;
const EPSILON = 6.103515625e-5;
const PUDDLE_FULL = 0.46;
const BAKED_GROUND = 0.5;

const TerrainVertexOut = {
	position: d.builtin.position,
	rel: d.vec3f,
	normal: d.vec3f,
	hole: d.f32,
	level: d.interpolate('flat', d.u32),
	surfaceUv: d.vec2f,
	surface: d.interpolate('flat', d.u32),
	local: d.vec2f,
	world: d.vec3f,
	detail: d.interpolate('flat', d.u32),
};

const rawSample = tgpu.fn(
	[d.u32, d.i32, d.i32],
	d.u32,
)((slot, x, z) => {
	'use gpu';
	const i = d.u32(std.clamp(z, d.i32(0), d.i32(LAST)) * d.i32(SIDE) + std.clamp(x, d.i32(0), d.i32(LAST)));
	const word = terrainLayout.$.heights[slot * d.u32(PAGE_WORDS) + std.intdiv(i, d.u32(2))];
	return (word >>> ((i & d.u32(1)) * d.u32(16))) & d.u32(0xffff);
});

const holeBit = tgpu.fn(
	[],
	d.u32,
)(() => {
	'use gpu';
	return std.bitcast(d.f32, d.u32)(frameLayout.$.frame.terrain.z);
});

const heightOf = tgpu.fn(
	[d.u32],
	d.f32,
)((raw) => {
	'use gpu';
	const terrain = frameLayout.$.frame.terrain;
	return terrain.x + d.f32(raw & (holeBit() - d.u32(1))) * terrain.y;
});

/** vertex entrypoint for CDLOD terrain patches */
export const vsTerrain = tgpu.vertexFn({
	in: { vi: d.builtin.vertexIndex, ii: d.builtin.instanceIndex },
	out: TerrainVertexOut,
})((input) => {
	'use gpu';
	const p = terrainLayout.$.patches[input.ii];
	const slot = p.info.x;
	const spacing = p.origin.z;
	const g = d.vec2i(
		d.i32((input.vi % d.u32(GRID)) + p.info.y),
		d.i32(std.intdiv(input.vi, d.u32(GRID)) + p.info.z),
	);

	const h0 = rawSample(slot, g.x, g.y);
	const pos0 = d.vec3f(p.origin.x + d.f32(g.x) * spacing, heightOf(h0), p.origin.y + d.f32(g.y) * spacing);
	let k = d.f32(0);
	if (p.morph.x < p.morph.y) {
		k = std.clamp((std.length(pos0) - p.morph.x) / (p.morph.y - p.morph.x), 0, 1);
	}

	const odd = d.vec2f(d.f32(g.x & d.i32(1)), d.f32(g.y & d.i32(1)));
	const m = std.sub(d.vec2f(g), std.mul(odd, k));
	const mFloor = std.floor(m);
	const i0 = d.vec2i(mFloor);
	const t = std.sub(m, mFloor);
	const s00 = rawSample(slot, i0.x, i0.y);
	const s10 = rawSample(slot, i0.x + d.i32(1), i0.y);
	const s01 = rawSample(slot, i0.x, i0.y + d.i32(1));
	const s11 = rawSample(slot, i0.x + d.i32(1), i0.y + d.i32(1));
	const h = std.mix(
		std.mix(heightOf(s00), heightOf(s10), t.x),
		std.mix(heightOf(s01), heightOf(s11), t.x),
		t.y,
	);
	const holeSamples =
		s00 |
		std.select(d.u32(0), s10, t.x > 0) |
		std.select(d.u32(0), s01, t.y > 0) |
		std.select(d.u32(0), s11, t.x > 0 && t.y > 0);
	const hole = std.select(d.f32(0), d.f32(1), (holeSamples & holeBit()) !== d.u32(0));

	const hl = heightOf(rawSample(slot, g.x - d.i32(1), g.y));
	const hr = heightOf(rawSample(slot, g.x + d.i32(1), g.y));
	const hd = heightOf(rawSample(slot, g.x, g.y - d.i32(1)));
	const hu = heightOf(rawSample(slot, g.x, g.y + d.i32(1)));
	const normal = std.normalize(d.vec3f(hl - hr, 2 * spacing, hd - hu));

	const local = std.mul(m, spacing);
	const rel = d.vec3f(p.origin.x + local.x, h, p.origin.y + local.y);
	return {
		position: std.mul(frameLayout.$.frame.viewProj, d.vec4f(rel, 1)),
		rel,
		normal,
		hole,
		level: d.u32(p.origin.w),
		surfaceUv: std.add(std.mul(std.sub(rel.xz, p.surface.xy), p.surface.z), d.vec2f(p.surface.w)),
		surface: p.info.w,
		local,
		world: d.vec3f(p.detail.x + local.x, h + p.detail.z, p.detail.y + local.y),
		detail: std.bitcast(d.f32, d.u32)(p.detail.w),
	};
});

const standInAlbedo = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((n) => {
	'use gpu';
	const grass = d.vec3f(0.13, 0.19, 0.07);
	const rock = d.vec3f(0.24, 0.22, 0.2);
	return std.mix(rock, grass, std.smoothstep(0.72, 0.86, n.y));
});

const Footprint = d.struct({
	world: d.vec3f,
	dx: d.vec3f,
	dy: d.vec3f,
	axes: d.vec3f,
});

const sampleLayer = tgpu.fn(
	[d.texture2dArray(d.f32), TerrainLayerSchema, Footprint],
	d.vec4f,
)((tex, layer, f) => {
	'use gpu';
	const k = layer.tiling.x;
	const offset = layer.tiling.yz;
	const index = d.u32(layer.mean.w);
	let sum = d.vec4f(0);
	let weight = d.f32(0);
	if (f.axes.y > 0.02) {
		sum = std.add(
			sum,
			std.mul(
				std.textureSampleGrad(
					tex,
					terrainLayout.$.layerSampler,
					std.add(std.mul(f.world.xz, k), offset),
					index,
					std.mul(f.dx.xz, k),
					std.mul(f.dy.xz, k),
				),
				f.axes.y,
			),
		);
		weight += f.axes.y;
	}
	if (f.axes.x > 0.02) {
		sum = std.add(
			sum,
			std.mul(
				std.textureSampleGrad(
					tex,
					terrainLayout.$.layerSampler,
					std.add(std.mul(f.world.zy, k), offset),
					index,
					std.mul(f.dx.zy, k),
					std.mul(f.dy.zy, k),
				),
				f.axes.x,
			),
		);
		weight += f.axes.x;
	}
	if (f.axes.z > 0.02) {
		sum = std.add(
			sum,
			std.mul(
				std.textureSampleGrad(
					tex,
					terrainLayout.$.layerSampler,
					std.add(std.mul(f.world.xy, k), offset),
					index,
					std.mul(f.dx.xy, k),
					std.mul(f.dy.xy, k),
				),
				f.axes.z,
			),
		);
		weight += f.axes.z;
	}
	return std.div(sum, std.max(weight, EPSILON));
});

const sampleControl = tgpu.fn(
	[d.u32, d.vec2f],
	d.vec4f,
)((slot, local) => {
	'use gpu';
	const scaled = std.div(local, CELL_METRES);
	const cell = std.floor(scaled);
	const inside = std.clamp(std.fract(scaled), d.vec2f(1 / 32), d.vec2f(31 / 32));
	const texelsPerCell = (PAGE_TEXELS - 2 * PAGE_BORDER) / CELLS;
	const uv = std.div(
		std.add(d.vec2f(PAGE_BORDER), std.mul(std.add(cell, inside), texelsPerCell)),
		PAGE_TEXELS,
	);
	return std.textureSampleLevel(terrainLayout.$.detailControl, terrainLayout.$.surfaceSampler, uv, slot, 0);
});

const Detail = d.struct({
	surface: Surface,
	height: d.f32,
});

const detailSurface = tgpu.fn(
	[d.u32, d.vec2f, Surface, Footprint, d.vec4f],
	Detail,
)((detailSlot, local, base, f, control) => {
	'use gpu';
	const slot = detailSlot - d.u32(1);
	const cell = d.vec2u(std.div(local, CELL_METRES));
	const ordinals = std.unpack4xU8(
		terrainLayout.$.detailIndex[slot * d.u32(CELLS * CELLS) + cell.y * d.u32(CELLS) + cell.x],
	);
	const weights = d.vec4f(control.xyz, std.clamp(1 - control.x - control.y - control.z, 0, 1));
	const pageUv = std.div(
		std.add(d.vec2f(PAGE_BORDER), std.mul(local, (PAGE_TEXELS - 2 * PAGE_BORDER) / LEAF_METRES)),
		PAGE_TEXELS,
	);
	const tint = std.textureSampleLevel(
		terrainLayout.$.detailTint,
		terrainLayout.$.surfaceSampler,
		pageUv,
		slot,
		0,
	);

	const diffuse = d.arrayOf(d.vec4f, 4)();
	const packed = d.arrayOf(d.vec4f, 4)();
	const heights = d.vec4f(0);
	const borders = d.vec4f(EPSILON);
	for (let i = d.u32(0); i < d.u32(4); i++) {
		if (weights[i] <= 0) {
			continue;
		}
		const layer = terrainLayout.$.layers[ordinals[i]];
		const diffSample = sampleLayer(terrainLayout.$.layerDiffuse, layer, f);
		diffuse[i] = d.vec4f(diffSample);
		packed[i] = sampleLayer(terrainLayout.$.layerNormal, layer, f);
		heights[i] = diffSample.w * layer.remap0.x + layer.remap0.y;
		borders[i] = std.max(layer.diffuse.w, EPSILON);
	}

	const weighted = std.mul(heights, weights);
	const peak = std.max(std.max(weighted.x, weighted.y), std.max(weighted.z, weighted.w));
	const raw = std.mul(
		std.add(std.max(d.vec4f(0), std.add(std.sub(weighted, d.vec4f(peak)), borders)), d.vec4f(EPSILON)),
		weights,
	);
	const blend = std.div(raw, std.max(std.dot(raw, d.vec4f(1)), EPSILON));

	let albedo = d.vec3f(0);
	let mean = d.vec3f(0);
	let tangentNormal = d.vec3f(0);
	let roughness = d.f32(0);
	let occlusion = d.f32(0);
	for (let i = d.u32(0); i < d.u32(4); i++) {
		if (blend[i] <= 0) {
			continue;
		}
		const layer = terrainLayout.$.layers[ordinals[i]];
		albedo = std.add(albedo, std.mul(std.mul(diffuse[i].xyz, layer.diffuse.xyz), blend[i]));
		mean = std.add(mean, std.mul(layer.mean.xyz, blend[i]));
		const xy = std.sub(std.mul(packed[i].xy, 2), d.vec2f(1));
		const z = std.max(EPSILON, std.sqrt(1 - std.clamp(std.dot(xy, xy), 0, 1)));
		tangentNormal = std.add(tangentNormal, std.mul(d.vec3f(std.mul(xy, layer.tiling.w), z), blend[i]));
		roughness += blend[i] * (packed[i].z * layer.remap1.x + layer.remap1.y);
		occlusion += blend[i] * (packed[i].w * layer.remap0.z + layer.remap0.w);
	}

	const t2 = tint.w * tint.w;
	albedo = std.add(albedo, std.mul(std.sub(tint.xyz, mean), t2 * t2));

	const nb = d.vec3f(base.normal);
	const c = std.cross(nb, d.vec3f(0, 0, 1));
	const c2 = std.dot(c, c);
	const t = std.select(std.mul(c, std.inverseSqrt(c2)), d.vec3f(1, 0, 0), c2 < 1e-8);
	const b = std.cross(t, nb);
	const s = Surface(base);
	s.albedo = std.max(albedo, d.vec3f(0));
	s.normal = std.normalize(
		std.add(std.add(std.mul(t, tangentNormal.x), std.mul(b, tangentNormal.y)), std.mul(nb, tangentNormal.z)),
	);
	s.roughness = std.clamp(roughness, 0, 1);
	s.occlusion = std.clamp(occlusion, 0, 1);
	return Detail({ surface: Surface(s), height: std.dot(heights, weights) });
});

const wetSurface = tgpu.fn(
	[Surface, d.f32],
	Surface,
)((s, depth) => {
	'use gpu';
	const w = std.clamp(depth / PUDDLE_FULL, 0, 1);
	const out = Surface(s);
	out.albedo = std.mul(s.albedo, std.mix(1, 0.65, w));
	out.occlusion = s.occlusion * std.mix(1, 0.9, w);
	out.roughness = std.mix(s.roughness, 0, w);
	out.normal = std.normalize(std.mix(s.normal, d.vec3f(0, 1, 0), w * 0.98));
	return Surface(out);
});

/** fragment entrypoint packing shaded terrain into the G-buffer */
export const fsTerrainMain = tgpu.fragmentFn({
	in: TerrainVertexOut,
	out: GBufferOut.propTypes,
})((input) => {
	'use gpu';
	const bias = std.exp2(frameLayout.$.frame.params.y);
	const dx = std.mul(std.dpdx(input.world), bias);
	const dy = std.mul(std.dpdy(input.world), bias);
	if (input.hole > 0) {
		std.discard();
	}
	let s = defaultSurface(d.vec3f(0), d.vec3f(0, 1, 0));
	if (input.surface === d.u32(0)) {
		const n = std.normalize(input.normal);
		s = defaultSurface(standInAlbedo(n), n);
		s.roughness = 0.9;
	} else {
		const layer = input.surface - d.u32(1);
		const albedo = std.textureSampleLevel(
			terrainLayout.$.surfaceAlbedo,
			terrainLayout.$.surfaceSampler,
			input.surfaceUv,
			layer,
			0,
		);
		const packed = std.textureSampleLevel(
			terrainLayout.$.surfaceNormal,
			terrainLayout.$.surfaceSampler,
			input.surfaceUv,
			layer,
			0,
		);
		const xz = std.sub(std.mul(packed.xy, 2), d.vec2f(1));
		const n = std.normalize(d.vec3f(xz.x, std.sqrt(std.max(1 - std.dot(xz, xz), 0)), xz.y));
		s = defaultSurface(albedo.xyz, n);
		s.roughness = packed.z;
		s.occlusion = packed.w;
	}
	if (input.detail !== d.u32(0)) {
		const local = std.clamp(input.local, d.vec2f(0), d.vec2f(LEAF_METRES - 0.001));
		const control = sampleControl(input.detail - d.u32(1), local);
		let ground = d.f32(BAKED_GROUND);
		const fade = 1 - std.smoothstep(DETAIL_FADE_START, DETAIL_FADE_END, std.length(input.rel));
		if (fade > 0) {
			const a = std.pow(std.abs(s.normal), d.vec3f(8));
			const axes = std.div(a, a.x + a.y + a.z + EPSILON);
			const f = Footprint({ world: d.vec3f(input.world), dx, dy, axes });
			const det = detailSurface(input.detail, local, s, f, control);
			s.albedo = std.mix(s.albedo, det.surface.albedo, fade);
			s.normal = std.normalize(std.mix(s.normal, det.surface.normal, fade));
			s.roughness = std.mix(s.roughness, det.surface.roughness, fade);
			s.occlusion = std.mix(s.occlusion, det.surface.occlusion, fade);
			ground = std.mix(ground, det.height, fade);
		}
		s = wetSurface(s, control.w - ground);
	}
	const out = packGbuffer(s, false, d.u32(0));
	return {
		emission: d.vec4f(out.emission),
		gbufferA: d.vec4f(out.gbufferA),
		gbufferB: d.vec4f(out.gbufferB),
		gbufferC: d.vec4f(out.gbufferC),
		mipFeedback: d.vec4u(out.mipFeedback),
		velocity: d.vec4f(out.velocity),
	};
});

/** fragment entrypoint drawing terrain wireframe coloured by CDLOD level */
export const fsTerrainWire = tgpu.fragmentFn({
	in: TerrainVertexOut,
	out: GBufferOut.propTypes,
})((input) => {
	'use gpu';
	if (input.hole > 0) {
		std.discard();
	}
	const out = packGbufferUnlit(
		std.mix(d.vec3f(0.02), std.mul(hue(d.f32(input.level) * 0.17), 0.6), 0.5),
		d.u32(0),
	);
	return {
		emission: d.vec4f(out.emission),
		gbufferA: d.vec4f(out.gbufferA),
		gbufferB: d.vec4f(out.gbufferB),
		gbufferC: d.vec4f(out.gbufferC),
		mipFeedback: d.vec4u(out.mipFeedback),
		velocity: d.vec4f(out.velocity),
	};
});

/** fragment entrypoint discarding terrain hole triangles in shadow passes */
export const fsTerrainShadow = tgpu.fragmentFn({
	in: TerrainVertexOut,
	out: d.Void,
})((input) => {
	'use gpu';
	if (input.hole > 0) {
		std.discard();
	}
});
