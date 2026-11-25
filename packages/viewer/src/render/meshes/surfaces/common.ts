/**
 * shared TypeGPU schemas, bind group layouts, vertex/depth entrypoints, and surface helpers for all HGRP mesh
 * surface shaders (Lit, Foliage, Erosion, Sludge, Transparent, DitherAlpha).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import {
	InstanceRow,
	fadeDiscard,
	frameLayout,
	listFade,
	listRow,
	rowBasis,
	rowBlock,
	sheetUv,
} from '../../frame/frame-core.ts';
import { PostSchema } from '../../post/post-schema.ts';
import { gradientNoise } from '../../shaders/common/noise.ts';
import { octDecode } from '../../shaders/common/octahedral.ts';

// #region schemas and layouts

/** GPU schema of per-draw dequantization and look reference (`draws` buffer, group 2 binding 0) */
export const DrawSchema = d.struct({
	offset: d.vec4f,
	scale: d.vec4f,
	uv0: d.vec4f,
	uv1: d.vec4f,
});

/** GPU schema of one material look (`LOOK_FLOATS` in `look.ts`, group 2 binding 5) */
export const LookSchema = d.struct({
	tint: d.vec4f,
	slotUv: d.arrayOf(d.vec4f, 7),
	surface: d.vec4f,
	surface2: d.vec4f,
	emissive: d.vec4f,
	emissive2: d.vec4f,
	maskAlbedo: d.arrayOf(d.vec4f, 3),
	maskRoughness: d.vec4f,
	maskMetallic: d.vec4f,
	maskScale: d.vec4f,
	maskOffset: d.vec4f,
	detail: d.vec4f,
	detail2: d.vec4f,
	detailOverlay: d.vec4f,
	parallax: d.vec4f,
	parallax2: d.vec4f,
	parallaxColor: d.vec4f,
	parallaxDark: d.vec4f,
	parallaxBright: d.vec4f,
	foliage: d.vec4f,
	foliageAo: d.vec4f,
	foliage2: d.vec4f,
	canopy: d.vec4f,
	canopyColor: d.vec4f,
	emissiveChannels: d.arrayOf(d.vec4f, 3),
	emissiveAlbedo: d.vec4f,
	misc: d.vec4f,
	parallaxWorld: d.arrayOf(d.vec4f, 5),
	extraUv: d.arrayOf(d.vec4f, 2),
	emissivePulse: d.vec4f,
	emissivePulseStrength: d.vec4f,
	sway: d.vec4f,
	swayDirection: d.vec4f,
});

/** group 1 bind group layout matching `BindLayouts.instances` (bindings 0..5) */
export const meshInstancesLayout = tgpu
	.bindGroupLayout({
		rows: { storage: d.arrayOf(InstanceRow), access: 'readonly' },
		blocks: { storage: d.arrayOf(d.vec4f), access: 'readonly' },
		list: { storage: d.arrayOf(d.u32), access: 'readonly' },
		placements: { storage: d.arrayOf(d.vec4f), access: 'readonly' },
		clothSkeletons: { storage: d.arrayOf(d.vec4f), access: 'readonly' },
		prevClothSkeletons: { storage: d.arrayOf(d.vec4f), access: 'readonly' },
	})
	.$idx(1);

/** group 2 bind group layout matching `BindLayouts.draw` (bindings 0..5) */
export const meshDrawLayout = tgpu
	.bindGroupLayout({
		draws: { storage: d.arrayOf(DrawSchema), access: 'readonly' },
		drawIds: { storage: d.arrayOf(d.u32), access: 'readonly' },
		post: { uniform: PostSchema },
		froxels: { texture: d.texture3d(d.f32) },
		lutSampler: { sampler: 'filtering' },
		looks: { storage: d.arrayOf(LookSchema), access: 'readonly' },
	})
	.$idx(2);

/** group 3 bind group layout matching `createMaterialLayout` (bindings 0..12) */
export const meshMaterialLayout = tgpu
	.bindGroupLayout({
		baseMap: { texture: d.texture2d(d.f32) },
		normalMap: { texture: d.texture2d(d.f32) },
		maskMap: { texture: d.texture2d(d.f32) },
		emissiveMap: { texture: d.texture2d(d.f32) },
		detailMap: { texture: d.texture2d(d.f32) },
		parallaxMap: { texture: d.texture2d(d.f32) },
		parallaxNoiseMap: { texture: d.texture2d(d.f32) },
		triMaskMap: { texture: d.texture2d(d.f32) },
		overlayMaskMap: { texture: d.texture2d(d.f32) },
		baseSampler: { sampler: 'filtering' },
		detailSampler: { sampler: 'filtering' },
		parallaxSampler: { sampler: 'filtering' },
		noiseSampler: { sampler: 'filtering' },
	})
	.$idx(3);

// #endregion

// #region flag constants

export const BASE_MAP = 1;
export const NORMAL_MAP = 2;
export const MASK_MAP = 4;
export const EMISSIVE_MAP = 8;
export const NORMAL_RAG = 16;
export const NORMAL_ROUGHNESS = 32;
export const FOLIAGE = 64;
export const METALLIC_BASE_ALPHA = 128;
export const NORMAL_OCCLUSION = 256;
export const HAS_NORMALS = 512;
export const HAS_TANGENTS = 1024;
export const EMISSIVE_MASK = 2048;
export const UNLIT = 4096;
export const ALPHA_NORMAL = 8192;
export const TRI_CHANNEL_MASK = 16384;
export const DETAIL_MAP = 32768;
export const PARALLAX_MAP = 65536;
export const PARALLAX_NOISE_MAP = 131072;
export const UV1_SHIFT = 18;
export const EROSION = 33554432;
export const HAS_COLORS = 67108864;
export const FOLIAGE_LEAF = 134217728;
export const EFFECT = 268435456;
export const VERTEX_OFFSET = 536870912;
export const TRUNK = 1073741824;
export const LAYER_BLEND = 2147483648;

export const LAYER_SOURCE_TOP = 0;

export const DITHER_RED_ALPHA = 1;
export const DITHER_VERTEX_COLOR = 2;
export const DITHER_MASK = 4;
export const DITHER_MASK_RED = 8;
export const DITHER_SURFACE = 16;
export const DITHER_ALPHA_COLOR = 32;

export const BASE_SLOT = 0;
export const NORMAL_SLOT = 1;
export const MASK_SLOT = 2;
export const EMISSIVE_SLOT = 3;
export const DETAIL_SLOT = 4;
export const PARALLAX_SLOT = 5;
export const NOISE_SLOT = 6;
export const LAYER_SLOT = 5;

export const EXTRA_TRI_MASK_MAP = 1;
export const EXTRA_OVERLAY_MASK_MAP = 2;
export const EXTRA_UV1_SHIFT = 2;
export const EXTRA_TRI_MASK_SLOT = 0;
export const EXTRA_OVERLAY_MASK_SLOT = 1;

const ROW_CLOTH = 8;

// #endregion

// #region vertex IO definitions

/** vertex attributes of a full mesh draw */
export const MeshVertexIn = {
	position: d.location(0, d.vec4f),
	normal: d.location(1, d.vec2f),
	uv0: d.location(2, d.vec2f),
	tangent: d.location(3, d.vec4f),
	uv1: d.location(4, d.vec2f),
	color: d.location(5, d.vec4f),
};

/** inter-stage varyings between `vsMain` and surface fragment shaders */
export const MeshVertexOut = {
	position: d.builtin.position,
	rel: d.location(0, d.vec3f),
	normal: d.location(1, d.vec3f),
	tangent: d.location(2, d.vec4f),
	uv: d.location(3, d.vec4f),
	draw: d.location(4, d.interpolate('flat', d.u32)),
	phase: d.location(5, d.interpolate('flat', d.f32)),
	objectPos: d.location(6, d.vec3f),
	color: d.location(7, d.vec4f),
	origin: d.location(8, d.interpolate('flat', d.vec3f)),
	fade: d.location(9, d.interpolate('flat', d.u32)),
	mirrored: d.location(10, d.interpolate('flat', d.u32)),
	prevRel: d.location(11, d.vec3f),
};

/** fragment input matching {@link MeshVertexOut} (without `@invariant`, which is vertex-output only) */
export const MeshFragmentIn = {
	position: d.builtin.position,
	rel: d.location(0, d.vec3f),
	normal: d.location(1, d.vec3f),
	tangent: d.location(2, d.vec4f),
	uv: d.location(3, d.vec4f),
	draw: d.location(4, d.interpolate('flat', d.u32)),
	phase: d.location(5, d.interpolate('flat', d.f32)),
	objectPos: d.location(6, d.vec3f),
	color: d.location(7, d.vec4f),
	origin: d.location(8, d.interpolate('flat', d.vec3f)),
	fade: d.location(9, d.interpolate('flat', d.u32)),
	mirrored: d.location(10, d.interpolate('flat', d.u32)),
	prevRel: d.location(11, d.vec3f),
};

/** plain helper struct carrying {@link MeshFragmentIn} fields into surface helper functions */
export const MeshVertexData = d.struct({
	position: d.vec4f,
	rel: d.vec3f,
	normal: d.vec3f,
	tangent: d.vec4f,
	uv: d.vec4f,
	draw: d.u32,
	phase: d.f32,
	objectPos: d.vec3f,
	color: d.vec4f,
	origin: d.vec3f,
	fade: d.u32,
	mirrored: d.u32,
	prevRel: d.vec3f,
});

const DepthIn = {
	position: d.location(0, d.vec4f),
	color: d.location(5, d.vec4f),
};

const CutoutDepthIn = {
	position: d.location(0, d.vec4f),
	uv0: d.location(2, d.vec2f),
	uv1: d.location(4, d.vec2f),
	color: d.location(5, d.vec4f),
};

const FadeDepthOut = {
	position: d.builtin.position,
	fade: d.location(0, d.interpolate('flat', d.u32)),
};

const FadeDepthIn = {
	position: d.builtin.position,
	fade: d.location(0, d.interpolate('flat', d.u32)),
};

const CutoutDepthOut = {
	position: d.builtin.position,
	uv: d.location(3, d.vec4f),
	draw: d.location(4, d.interpolate('flat', d.u32)),
	color: d.location(7, d.vec4f),
	fade: d.location(9, d.interpolate('flat', d.u32)),
};

const CutoutDepthVaryings = {
	position: d.builtin.position,
	uv: d.location(3, d.vec4f),
	draw: d.location(4, d.interpolate('flat', d.u32)),
	color: d.location(7, d.vec4f),
	fade: d.location(9, d.interpolate('flat', d.u32)),
};

// #endregion

// #region draw and UV helpers

/**
 * extracts a draw's look table index from `draw.scale.w`.
 *
 * @param draw draw record
 * @returns index into `looks`
 */
export const lookSlot = tgpu.fn(
	[DrawSchema],
	d.u32,
)((draw) => {
	'use gpu';
	return std.bitcastF32toU32(draw.scale.w) & d.u32(0xffff);
});

/**
 * extracts a draw's extra mesh flags (resident and UV1 bits for slots 7+) from `draw.scale.w`.
 *
 * @param draw draw record
 * @returns extra flags bitmask
 */
export const extraFlags = tgpu.fn(
	[DrawSchema],
	d.u32,
)((draw) => {
	'use gpu';
	return std.bitcastF32toU32(draw.scale.w) >>> d.u32(16);
});

/**
 * selects UV set 0 or 1 for a material slot before its UV transform.
 *
 * @param uv UV0 in xy, UV1 in zw
 * @param flags draw look flags
 * @param slot slot index (0..6)
 * @returns selected UV set
 */
export const slotSet = tgpu.fn(
	[d.vec4f, d.u32, d.u32],
	d.vec2f,
)((uv, flags, slot) => {
	'use gpu';
	return std.select(uv.xy, uv.zw, (flags & (d.u32(1) << (d.u32(UV1_SHIFT) + slot))) !== d.u32(0));
});

/**
 * computes the transformed UV coordinates for a material slot.
 *
 * @param lookId index into `looks`
 * @param uv UV0 in xy, UV1 in zw
 * @param flags draw look flags
 * @param slot slot index (0..6)
 * @returns transformed UV coordinates
 */
export const slotUv = tgpu.fn(
	[d.u32, d.vec4f, d.u32, d.u32],
	d.vec2f,
)((lookId, uv, flags, slot) => {
	'use gpu';
	const t = meshDrawLayout.$.looks[lookId].slotUv[slot];
	return std.add(std.mul(slotSet(uv, flags, slot), t.xy), t.zw);
});

/**
 * computes the transformed UV coordinates for an extra mesh slot (0 = TriMask, 1 = OverlayMask).
 *
 * @param lookId index into `looks`
 * @param uv UV0 in xy, UV1 in zw
 * @param extra extra mesh flags
 * @param extraSlot extra slot index (0 or 1)
 * @returns transformed UV coordinates
 */
export const extraSlotUv = tgpu.fn(
	[d.u32, d.vec4f, d.u32, d.u32],
	d.vec2f,
)((lookId, uv, extra, extraSlot) => {
	'use gpu';
	const t = meshDrawLayout.$.looks[lookId].extraUv[extraSlot];
	const useUv1 = (extra & (d.u32(1) << (d.u32(EXTRA_UV1_SHIFT) + extraSlot))) !== d.u32(0);
	return std.add(std.mul(std.select(uv.xy, uv.zw, useUv1), t.xy), t.zw);
});

/**
 * samples a material slot with explicit screen-space derivatives so optional maps can be skipped in
 * non-uniform control flow.
 *
 * @param tex 2D texture to sample
 * @param samp filtering sampler
 * @param lookId index into `looks`
 * @param uv UV0 in xy, UV1 in zw
 * @param uv0Dx dpdx of UV0 (pre-scaled by mip bias)
 * @param uv0Dy dpdy of UV0 (pre-scaled by mip bias)
 * @param uv1Dx dpdx of UV1 (pre-scaled by mip bias)
 * @param uv1Dy dpdy of UV1 (pre-scaled by mip bias)
 * @param flags draw look flags
 * @param slot slot index (0..6)
 * @returns sampled texel
 */
export const sampleSlot = tgpu.fn(
	[d.texture2d(d.f32), d.sampler(), d.u32, d.vec4f, d.vec2f, d.vec2f, d.vec2f, d.vec2f, d.u32, d.u32],
	d.vec4f,
)((tex, samp, lookId, uv, uv0Dx, uv0Dy, uv1Dx, uv1Dy, flags, slot) => {
	'use gpu';
	const useUv1 = (flags & (d.u32(1) << (d.u32(UV1_SHIFT) + slot))) !== d.u32(0);
	const t = meshDrawLayout.$.looks[lookId].slotUv[slot];
	const coords = std.add(std.mul(std.select(uv.xy, uv.zw, useUv1), t.xy), t.zw);
	const dx = std.mul(std.select(uv0Dx, uv1Dx, useUv1), t.xy);
	const dy = std.mul(std.select(uv0Dy, uv1Dy, useUv1), t.xy);
	return std.textureSampleGrad(tex, samp, coords, dx, dy);
});

/**
 * returns `true` on a mesh's geometric front face, accounting for mirrored instance matrices.
 *
 * @param frontFacing hardware `@builtin(front_facing)`
 * @param mirrored `1` when the instance matrix has negative determinant
 * @returns geometric front-face flag
 */
export const isFrontFace = tgpu.fn(
	[d.bool, d.u32],
	d.bool,
)((frontFacing, mirrored) => {
	'use gpu';
	return frontFacing === (mirrored === d.u32(0));
});

/**
 * resolves the shading normal before normal mapping: vertex normal (optionally flipped on back faces) or
 * screen-space faceted normal for normal-less meshes.
 *
 * @param vertexNormal interpolated vertex normal (zero when absent)
 * @param faceted screen-space `cross(dpdx(rel), dpdy(rel))`
 * @param flip whether to negate the vertex normal
 * @returns unit shading normal
 */
export const surfaceNormal = tgpu.fn(
	[d.vec3f, d.vec3f, d.bool],
	d.vec3f,
)((vertexNormal, faceted, flip) => {
	'use gpu';
	if (std.dot(vertexNormal, vertexNormal) < 1e-6) {
		return std.normalize(faceted);
	}
	const n = std.normalize(vertexNormal);
	return std.select(n, std.neg(n), flip);
});

/**
 * returns a `VFXDitherAlpha` look's `DitherFlags` bitmask, or `0` on non-dithered looks.
 *
 * @param look material look
 * @param flags draw look flags
 * @returns `DitherFlags` bitmask
 */
export const ditherBits = tgpu.fn(
	[LookSchema, d.u32],
	d.u32,
)((look, flags) => {
	'use gpu';
	return std.select(
		d.u32(look.canopy.w),
		d.u32(0),
		(flags & d.u32(FOLIAGE | FOLIAGE_LEAF | TRUNK)) !== d.u32(0),
	);
});

/**
 * computes a dithered look's alpha before its mask, saturation, and power.
 *
 * @param look material look
 * @param bits `DitherFlags` bitmask
 * @param texel sampled alpha texture texel
 * @param vertexAlpha interpolated vertex alpha
 * @param depth linear view depth (`1 / position.w`)
 * @returns scaled alpha
 */
export const ditherAlpha = tgpu.fn(
	[LookSchema, d.u32, d.vec4f, d.f32, d.f32],
	d.f32,
)((look, bits, texel, vertexAlpha, depth) => {
	'use gpu';
	let alpha = std.select(texel.w, texel.x, (bits & d.u32(DITHER_RED_ALPHA)) !== d.u32(0)) * look.canopy.x;
	if ((bits & d.u32(DITHER_VERTEX_COLOR)) !== d.u32(0)) {
		alpha *= vertexAlpha;
	}
	const near = look.canopyColor;
	if (std.any(std.ne(near, d.vec4f(0)))) {
		alpha *=
			std.saturate((depth - near.x) / (near.y - near.x)) * std.saturate((depth - near.z) / (near.w - near.z));
	}
	return alpha;
});

/**
 * returns the vertex colour multiplier for `VFXDitherAlpha`, or `(1, 1, 1)` on other looks.
 *
 * @param look material look
 * @param flags draw look flags
 * @param color interpolated vertex/instance colour
 * @returns RGB colour multiplier
 */
export const ditherVertexColor = tgpu.fn(
	[LookSchema, d.u32, d.vec4f],
	d.vec3f,
)((look, flags, color) => {
	'use gpu';
	return std.select(
		d.vec3f(1),
		color.xyz,
		(ditherBits(look, flags) & d.u32(DITHER_VERTEX_COLOR)) !== d.u32(0),
	);
});

// #endregion

// #region skinning, sway, vertex offset, and sludge

const clothBonePos = tgpu.fn(
	[d.u32, d.vec4f],
	d.vec3f,
)((bone, p) => {
	'use gpu';
	const base = bone * d.u32(3);
	return d.vec3f(
		std.dot(meshInstancesLayout.$.clothSkeletons[base], p),
		std.dot(meshInstancesLayout.$.clothSkeletons[base + d.u32(1)], p),
		std.dot(meshInstancesLayout.$.clothSkeletons[base + d.u32(2)], p),
	);
});

const clothSkin = tgpu.fn(
	[d.vec3f, d.vec4f, InstanceRow],
	d.vec3f,
)((p, color, row) => {
	'use gpu';
	if ((row.info & d.u32(ROW_CLOTH)) === d.u32(0)) {
		return d.vec3f(p);
	}
	const offset = row.custom.x;
	const p4 = d.vec4f(p, 1);
	const r = d.u32(std.round(color.x * 255));
	const g = d.u32(std.round(color.y * 255));
	if (row.custom.y !== d.u32(0)) {
		return clothBonePos(offset + r * d.u32(256) + g, p4);
	}
	const a = clothBonePos(offset + r, p4);
	const b = clothBonePos(offset + g, p4);
	return std.mix(a, b, color.z);
});

const prevClothBonePos = tgpu.fn(
	[d.u32, d.vec4f],
	d.vec3f,
)((bone, p) => {
	'use gpu';
	const base = bone * d.u32(3);
	return d.vec3f(
		std.dot(meshInstancesLayout.$.prevClothSkeletons[base], p),
		std.dot(meshInstancesLayout.$.prevClothSkeletons[base + d.u32(1)], p),
		std.dot(meshInstancesLayout.$.prevClothSkeletons[base + d.u32(2)], p),
	);
});

const clothSkinPrev = tgpu.fn(
	[d.vec3f, d.vec4f, InstanceRow],
	d.vec3f,
)((p, color, row) => {
	'use gpu';
	if ((row.info & d.u32(ROW_CLOTH)) === d.u32(0)) {
		return d.vec3f(p);
	}
	const offset = row.custom.x;
	const p4 = d.vec4f(p, 1);
	const r = d.u32(std.round(color.x * 255));
	const g = d.u32(std.round(color.y * 255));
	if (row.custom.y !== d.u32(0)) {
		return prevClothBonePos(offset + r * d.u32(256) + g, p4);
	}
	const a = prevClothBonePos(offset + r, p4);
	const b = prevClothBonePos(offset + g, p4);
	return std.mix(a, b, color.z);
});

const rotateAbout = tgpu.fn(
	[d.vec3f, d.f32, d.vec3f],
	d.vec3f,
)((axis, angle, v) => {
	'use gpu';
	const c = std.cos(angle);
	return std.add(
		std.add(std.mul(v, c), std.mul(std.cross(axis, v), std.sin(angle))),
		std.mul(axis, std.dot(axis, v) * (1 - c)),
	);
});

const pendulumAt = tgpu.fn(
	[LookSchema, d.f32, d.vec3f, d.vec2f, d.f32, d.f32, d.f32],
	d.vec3f,
)((look, weight, v, along, phase, x0, windClock) => {
	'use gpu';
	const intensity = look.sway.x;
	const across = d.vec3f(-along.y, -along.x, along.x);
	let swung = d.vec3f(v);
	if (std.dot(across, across) > 1e-12) {
		swung = rotateAbout(std.normalize(across), std.sin(phase) * intensity * 0.05, v);
	}
	const spin = std.sin(windClock * look.sway.w + x0) * look.swayDirection.x;
	const turned = rotateAbout(d.vec3f(0, 1, 0), spin, swung);
	const follow = std.mix(weight * intensity * 0.5, 1, look.sway.z);
	return std.mul(std.sub(turned, v), follow * weight);
});

const swayAt = tgpu.fn(
	[d.u32, LookSchema, d.vec3f, d.f32, d.vec3f, d.vec3f, d.f32],
	d.vec3f,
)((flags, look, p, weight, rel, origin, windClock) => {
	'use gpu';
	const intensity = look.sway.x;
	if (weight === 0 || intensity === 0 || (flags & d.u32(FOLIAGE | EROSION | UNLIT | EFFECT)) !== d.u32(0)) {
		return d.vec3f(0);
	}
	const frame = frameLayout.$.frame;
	const frequency = look.sway.y;
	const along = std.select(frame.wind.zw, look.swayDirection.zw, look.swayDirection.y > 0.5);
	const x0 = origin.x + frame.eye.x;
	const phase = windClock * frequency + x0;
	if (look.misc.y > 0.5) {
		return pendulumAt(look, weight, std.sub(rel, origin), along, phase, x0, windClock);
	}
	const softness = look.sway.z;
	const kite = look.sway.w;
	const tendency = look.swayDirection.x;
	let s = d.f32(0);
	let amplitude = d.f32(0);
	if (kite !== 0) {
		amplitude = intensity * 0.05;
		s = std.sin(phase + std.mix(0, p.y * softness - weight * Math.PI, kite)) * p.y;
	} else {
		amplitude = intensity * 0.5;
		s = std.sin(phase - (rel.z + frame.eye.z) * softness - weight * 3.14);
	}
	const offset = (s + 1 + tendency) * amplitude * weight;
	return std.mul(d.vec3f(along.x, 0, along.y), offset);
});

const mushroomSwayAt = tgpu.fn(
	[d.u32, LookSchema, d.f32, d.vec3f, d.vec3f, d.f32],
	d.vec3f,
)((flags, look, weight, rel, origin, time) => {
	'use gpu';
	if ((flags & d.u32(PARALLAX_MAP)) === d.u32(0)) {
		return d.vec3f(0);
	}
	const mask = std.max(std.pow(std.abs(weight), look.swayDirection.z), 0.01);
	const worldOrigin = std.add(origin, frameLayout.$.frame.eye.xyz);
	const hash = std.fract(std.dot(worldOrigin.xz, d.vec2f(0.7548776865005493, 0.5698403120040894)));
	const phase = hash * look.swayDirection.x;
	const speedScale = 1 + (std.fract(hash * 1.6180340051651 + 0.3819660246372) * 2 - 1) * look.swayDirection.y;
	const u = std.fract(time * speedScale * look.sway.x + phase);
	const lut = std.textureSampleLevel(
		meshMaterialLayout.$.parallaxMap,
		meshMaterialLayout.$.parallaxSampler,
		d.vec2f(u, 0.5),
		0,
	);
	const v = std.sub(rel, origin);
	const bend = std.mul(lut.xy, look.sway.y * mask);
	const bendDeg = std.length(bend);
	const axis = std.div(d.vec3f(bend.y, 0, -bend.x), std.max(bendDeg, 0.001));
	const baseDelta = std.mul(std.cross(axis, v), std.radians(bendDeg));
	const twistRad = std.radians(lut.w * look.sway.w * mask);
	return d.vec3f(
		baseDelta.x + v.z * twistRad,
		baseDelta.y + v.y * lut.z * look.sway.z,
		baseDelta.z - v.x * twistRad,
	);
});

const vertexSway = tgpu.fn(
	[d.u32, LookSchema, d.vec3f, d.f32, d.vec3f, d.vec3f, d.f32, d.f32],
	d.vec3f,
)((flags, look, p, weight, rel, origin, time, windClock) => {
	'use gpu';
	if (look.misc.y > 1.5) {
		return mushroomSwayAt(flags, look, weight, rel, origin, time);
	}
	return swayAt(flags, look, p, weight, rel, origin, windClock);
});

const grassLean = tgpu.fn(
	[d.u32, LookSchema, d.f32],
	d.vec3f,
)((flags, look, height) => {
	'use gpu';
	if ((flags & d.u32(FOLIAGE | FOLIAGE_LEAF)) !== d.u32(FOLIAGE)) {
		return d.vec3f(0);
	}
	const viewUp = frameLayout.$.frame.viewUp;
	return std.mul(d.vec3f(viewUp.x, 0, viewUp.z), height * look.foliage.y);
});

const instanceRel = tgpu.fn(
	[d.vec4f, d.vec4f, d.u32, DrawSchema, LookSchema],
	d.vec3f,
)((position, color, ii, draw, look) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const row = meshInstancesLayout.$.rows[listRow(meshInstancesLayout.$.list[ii])];
	const p = clothSkin(std.add(draw.offset.xyz, std.mul(position.xyz, draw.scale.xyz)), color, row);
	const origin = std.add(
		d.vec3f(row.t0.w, row.t1.w, row.t2.w),
		meshInstancesLayout.$.blocks[rowBlock(row.block)].xyz,
	);
	const rel = std.add(std.mul(rowBasis(row.t0, row.t1, row.t2, row.info), p), origin);
	const flags = std.bitcastF32toU32(draw.offset.w);
	return std.add(
		std.add(rel, grassLean(flags, look, p.y)),
		vertexSway(flags, look, p, position.w, rel, origin, frame.eye.w, frame.wind.x),
	);
});

const instancePrevRel = tgpu.fn(
	[d.vec4f, d.vec4f, d.u32, DrawSchema, LookSchema],
	d.vec3f,
)((position, color, ii, draw, look) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const row = meshInstancesLayout.$.rows[listRow(meshInstancesLayout.$.list[ii])];
	const p = clothSkinPrev(std.add(draw.offset.xyz, std.mul(position.xyz, draw.scale.xyz)), color, row);
	const origin = std.add(
		d.vec3f(row.t0.w, row.t1.w, row.t2.w),
		meshInstancesLayout.$.blocks[rowBlock(row.block)].xyz,
	);
	const rel = std.add(std.mul(rowBasis(row.t0, row.t1, row.t2, row.info), p), origin);
	const flags = std.bitcastF32toU32(draw.offset.w);
	return std.add(
		std.add(rel, grassLean(flags, look, p.y)),
		vertexSway(flags, look, p, position.w, rel, origin, frame.prevTime.x, frame.prevTime.y),
	);
});

const vertexOffsetAt = tgpu.fn(
	[d.u32, LookSchema, d.mat3x3f, d.vec4f, d.f32, d.f32],
	d.vec3f,
)((flags, look, basis, uv, weight, time) => {
	'use gpu';
	const alphaMap = std.select(d.u32(BASE_MAP), d.u32(NORMAL_MAP), (flags & d.u32(ALPHA_NORMAL)) !== d.u32(0));
	const needed = d.u32(VERTEX_OFFSET | PARALLAX_MAP) | alphaMap;
	const shape = look.parallaxDark;
	const masked = shape.w !== 0;
	if ((flags & needed) !== needed || (masked && (flags & d.u32(PARALLAX_NOISE_MAP)) === d.u32(0))) {
		return d.vec3f(0);
	}
	const direction = look.parallaxColor;
	const scroll = std.mul(look.parallaxBright, time);
	const source = slotSet(uv, flags, d.u32(PARALLAX_SLOT));
	const noiseT = look.slotUv[PARALLAX_SLOT];
	const maskT = look.slotUv[NOISE_SLOT];
	const noiseUv = std.add(std.add(std.mul(source, noiseT.xy), noiseT.zw), scroll.xy);
	const noise = std.textureSampleLevel(
		meshMaterialLayout.$.parallaxMap,
		meshMaterialLayout.$.parallaxSampler,
		noiseUv,
		0,
	).x;
	let scale = shape.x * (noise * (1 + shape.y) - shape.y);
	if (masked) {
		const maskUv = std.add(std.add(std.mul(source, maskT.xy), maskT.zw), scroll.zw);
		const mask = std.textureSampleLevel(
			meshMaterialLayout.$.parallaxNoiseMap,
			meshMaterialLayout.$.noiseSampler,
			maskUv,
			0,
		).x;
		scale *= 1 - shape.w * (1 - mask);
	}
	if (shape.z > 0.5) {
		scale *= weight;
	}
	return std.mul(std.select(std.mul(basis, direction.xyz), direction.xyz, direction.w > 0.5), scale);
});

const SludgeVertex = d.struct({
	rel: d.vec3f,
	prevRel: d.vec3f,
	normal: d.vec3f,
	tangent: d.vec4f,
	color: d.vec4f,
	discarded: d.bool,
});

const sludgeVertex = tgpu.fn(
	[d.vec2f, d.vec3f, d.mat3x3f, LookSchema],
	SludgeVertex,
)((uv, origin, m, look) => {
	'use gpu';
	const hm = std.textureSampleLevel(
		meshMaterialLayout.$.parallaxNoiseMap,
		meshMaterialLayout.$.noiseSampler,
		uv,
		0,
	);
	const h = hm.z;
	if (h < 1e-6) {
		return SludgeVertex({
			rel: d.vec3f(0),
			prevRel: d.vec3f(0),
			normal: d.vec3f(0),
			tangent: d.vec4f(0),
			color: d.vec4f(0),
			discarded: true,
		});
	}
	const sludgeSize = std.max(look.emissive2.x, 1e-4);
	const sizeY = std.max(look.emissive2.y, 1e-4);
	let local = d.vec3f(uv.x * sludgeSize, h * sizeY, uv.y * sludgeSize);
	const clip0 = look.maskScale;
	const clip1 = look.maskOffset;
	if (std.dot(clip0, d.vec4f(local, 1)) < 0 || std.dot(clip1, d.vec4f(local, 1)) < 0) {
		return SludgeVertex({
			rel: d.vec3f(0),
			prevRel: d.vec3f(0),
			normal: d.vec3f(0),
			tangent: d.vec4f(0),
			color: d.vec4f(0),
			discarded: true,
		});
	}
	const e = std.sub(std.mul(hm.xy, 2), d.vec2f(1));
	const ny = 1 - std.abs(e.x) - std.abs(e.y);
	let ln = d.vec3f(e.x, ny, e.y);
	if (ny < 0) {
		const folded = std.mul(
			std.sub(d.vec2f(1), std.abs(ln.zx)),
			std.select(d.vec2f(-1), d.vec2f(1), std.ge(ln.xz, d.vec2f(0))),
		);
		ln = d.vec3f(folded.x, ny, folded.y);
	}
	ln = std.normalize(ln);

	const coverage = hm.w;
	const center = d.vec3f(sludgeSize * 0.5, sizeY * 0.5, sludgeSize * 0.5);
	const cov2 = coverage * 2;
	const distCenter = std.distance(local, center);
	const radial = std.normalize(std.add(std.sub(local, center), d.vec3f(1e-6)));
	const waveAmp = std.mul(look.parallax, d.vec4f(std.saturate(cov2 - 1), std.saturate(cov2), 0.1, 0));

	const frame = frameLayout.$.frame;
	const prevPhase = std.sub(
		std.mul(look.parallax2, distCenter),
		std.mul(look.parallaxColor, frame.prevTime.x),
	);
	const prevWaveY = std.dot(std.add(std.sin(prevPhase), d.vec4f(1)), waveAmp);
	const prevWaveXzRaw = std.mul(radial, std.dot(std.add(std.cos(prevPhase), d.vec4f(1)), waveAmp));
	const prevWaveXz = d.vec3f(prevWaveXzRaw.x, 0, prevWaveXzRaw.z);
	let prevLocal = d.vec3f(local.x, local.y + prevWaveY, local.z);
	prevLocal = std.add(prevLocal, std.mul(std.add(ln, prevWaveXz), look.surface2.z));
	prevLocal = std.add(prevLocal, std.mul(clip0.xyz, std.max(-std.dot(clip0, d.vec4f(prevLocal, 1)), 0)));
	prevLocal = std.add(prevLocal, std.mul(clip1.xyz, std.max(-std.dot(clip1, d.vec4f(prevLocal, 1)), 0)));

	const wavePhase = std.sub(std.mul(look.parallax2, distCenter), std.mul(look.parallaxColor, frame.eye.w));
	const waveY = std.dot(std.add(std.sin(wavePhase), d.vec4f(1)), waveAmp);
	const waveXzRaw = std.mul(radial, std.dot(std.add(std.cos(wavePhase), d.vec4f(1)), waveAmp));
	const waveXz = d.vec3f(waveXzRaw.x, 0, waveXzRaw.z);
	local = d.vec3f(local.x, local.y + waveY, local.z);
	const animN = std.add(ln, waveXz);
	local = std.add(local, std.mul(animN, look.surface2.z));
	local = std.add(local, std.mul(clip0.xyz, std.max(-std.dot(clip0, d.vec4f(local, 1)), 0)));
	local = std.add(local, std.mul(clip1.xyz, std.max(-std.dot(clip1, d.vec4f(local, 1)), 0)));

	const rightU = std.div(m.columns[0], sludgeSize);
	const upU = std.div(m.columns[1], sizeY);
	const fwdU = std.div(m.columns[2], sludgeSize);
	const worldN = std.normalize(
		std.add(std.add(std.mul(rightU, animN.x), std.mul(upU, animN.y)), std.mul(fwdU, animN.z)),
	);
	return SludgeVertex({
		rel: std.add(
			std.add(std.add(origin, std.mul(rightU, local.x)), std.mul(upU, local.y)),
			std.mul(fwdU, local.z),
		),
		prevRel: std.add(
			std.add(std.add(origin, std.mul(rightU, prevLocal.x)), std.mul(upU, prevLocal.y)),
			std.mul(fwdU, prevLocal.z),
		),
		normal: worldN,
		tangent: d.vec4f(std.normalize(std.add(std.cross(worldN, fwdU), d.vec3f(1e-6))), 1),
		color: d.vec4f(coverage, 1 - waveY, 0, 1),
		discarded: false,
	});
});

// #endregion

// #region vertex and depth entrypoints

/** main vertex entrypoint for opaque, cutout, and transparent surface meshes */
export const vsMain = tgpu.vertexFn({
	in: { ...MeshVertexIn, ii: d.builtin.instanceIndex },
	out: MeshVertexOut,
})((input) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const entry = meshInstancesLayout.$.list[input.ii];
	const row = meshInstancesLayout.$.rows[listRow(entry)];
	const drawId = meshDrawLayout.$.drawIds[input.ii];
	const draw = meshDrawLayout.$.draws[drawId];
	const look = meshDrawLayout.$.looks[lookSlot(draw)];
	const p = std.add(draw.offset.xyz, std.mul(input.position.xyz, draw.scale.xyz));
	const origin = std.add(
		d.vec3f(row.t0.w, row.t1.w, row.t2.w),
		meshInstancesLayout.$.blocks[rowBlock(row.block)].xyz,
	);
	const m = rowBasis(row.t0, row.t1, row.t2, row.info);
	const mirrored = std.determinant(m) < 0;
	const flags = std.bitcastF32toU32(draw.offset.w);
	const uv = d.vec4f(
		std.add(std.mul(input.uv0, draw.uv0.xy), draw.uv0.zw),
		std.add(std.mul(input.uv1, draw.uv1.xy), draw.uv1.zw),
	);
	if ((flags & d.u32(EROSION)) !== d.u32(0) && look.emissive2.w > 1.5) {
		const sv = sludgeVertex(uv.xy, origin, m, look);
		if (sv.discarded) {
			return {
				position: d.vec4f(0),
				rel: d.vec3f(0),
				normal: d.vec3f(0),
				tangent: d.vec4f(0),
				uv: d.vec4f(0),
				draw: d.u32(0),
				phase: 0,
				objectPos: d.vec3f(0),
				color: d.vec4f(0),
				origin: d.vec3f(0),
				fade: d.u32(0),
				mirrored: d.u32(0),
				prevRel: d.vec3f(0),
			};
		}
		return {
			position: std.mul(frame.viewProj, d.vec4f(sv.rel, 1)),
			rel: d.vec3f(sv.rel),
			normal: d.vec3f(sv.normal),
			tangent: d.vec4f(sv.tangent),
			uv,
			draw: drawId,
			phase: 0,
			objectPos: p,
			color: d.vec4f(sv.color),
			origin,
			fade: listFade(entry),
			mirrored: std.select(d.u32(0), d.u32(1), mirrored),
			prevRel: d.vec3f(sv.prevRel),
		};
	}
	const rel = std.add(
		instanceRel(input.position, input.color, input.ii, draw, look),
		vertexOffsetAt(flags, look, m, uv, input.position.w, frame.eye.w),
	);
	const prevRel = std.add(
		instancePrevRel(input.position, input.color, input.ii, draw, look),
		vertexOffsetAt(flags, look, m, uv, input.position.w, frame.prevTime.x),
	);
	let n = d.vec3f(0);
	if ((flags & d.u32(HAS_NORMALS)) !== d.u32(0)) {
		n = std.mul(m, octDecode(input.normal));
	}
	let t = d.vec4f(0);
	if ((flags & d.u32(HAS_TANGENTS)) !== d.u32(0)) {
		const sign =
			std.select(d.f32(-1), d.f32(1), input.tangent.z >= 0) * std.select(d.f32(1), d.f32(-1), mirrored);
		t = d.vec4f(std.mul(m, octDecode(input.tangent.xy)), sign);
	}
	const world = std.add(origin, frame.eye.xyz);
	return {
		position: std.mul(frame.viewProj, d.vec4f(rel, 1)),
		rel,
		normal: n,
		tangent: t,
		uv: sheetUv(row.sheet, uv),
		draw: drawId,
		phase: world.x + world.y + world.z,
		objectPos: p,
		color: std.mul(
			std.select(d.vec4f(1), input.color, (flags & d.u32(HAS_COLORS)) !== d.u32(0)),
			std.unpack4x8unorm(row.color),
		),
		origin,
		fade: listFade(entry),
		mirrored: std.select(d.u32(0), d.u32(1), mirrored),
		prevRel,
	};
});

/** position-only vertex entrypoint for opaque depth prepass and shadow passes */
export const vsDepth = tgpu.vertexFn({
	in: { ...DepthIn, ii: d.builtin.instanceIndex },
	out: { position: d.builtin.position },
})((input) => {
	'use gpu';
	const draw = meshDrawLayout.$.draws[meshDrawLayout.$.drawIds[input.ii]];
	const look = meshDrawLayout.$.looks[lookSlot(draw)];
	return {
		position: std.mul(
			frameLayout.$.frame.viewProj,
			d.vec4f(instanceRel(input.position, input.color, input.ii, draw, look), 1),
		),
	};
});

/** empty fragment entrypoint for opaque depth prepass (writeMask = 0) */
export const fsDepth = tgpu.fragmentFn({
	in: {},
	out: d.Void,
})(() => {
	'use gpu';
});

/** vertex entrypoint for opaque depth prepass with transition fade */
export const vsDepthFade = tgpu.vertexFn({
	in: { ...DepthIn, ii: d.builtin.instanceIndex },
	out: FadeDepthOut,
})((input) => {
	'use gpu';
	const draw = meshDrawLayout.$.draws[meshDrawLayout.$.drawIds[input.ii]];
	const look = meshDrawLayout.$.looks[lookSlot(draw)];
	return {
		position: std.mul(
			frameLayout.$.frame.viewProj,
			d.vec4f(instanceRel(input.position, input.color, input.ii, draw, look), 1),
		),
		fade: listFade(meshInstancesLayout.$.list[input.ii]),
	};
});

/** fragment entrypoint discarding transitioning opaque instances in depth prepass */
export const fsDepthFade = tgpu.fragmentFn({
	in: FadeDepthIn,
	out: d.Void,
})((input) => {
	'use gpu';
	if (fadeDiscard(input.fade, input.position.xy)) {
		std.discard();
	}
});

/** vertex entrypoint for alpha-tested depth prepass and cutout shadow passes */
export const vsCutoutDepth = tgpu.vertexFn({
	in: { ...CutoutDepthIn, ii: d.builtin.instanceIndex },
	out: CutoutDepthOut,
})((input) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const drawId = meshDrawLayout.$.drawIds[input.ii];
	const draw = meshDrawLayout.$.draws[drawId];
	const look = meshDrawLayout.$.looks[lookSlot(draw)];
	const entry = meshInstancesLayout.$.list[input.ii];
	const row = meshInstancesLayout.$.rows[listRow(entry)];
	const m = rowBasis(row.t0, row.t1, row.t2, row.info);
	const flags = std.bitcastF32toU32(draw.offset.w);
	const uv = d.vec4f(
		std.add(std.mul(input.uv0, draw.uv0.xy), draw.uv0.zw),
		std.add(std.mul(input.uv1, draw.uv1.xy), draw.uv1.zw),
	);
	if ((flags & d.u32(EROSION)) !== d.u32(0) && look.emissive2.w > 1.5) {
		const origin = std.add(
			d.vec3f(row.t0.w, row.t1.w, row.t2.w),
			meshInstancesLayout.$.blocks[rowBlock(row.block)].xyz,
		);
		const sv = sludgeVertex(uv.xy, origin, m, look);
		return {
			position: std.select(std.mul(frame.viewProj, d.vec4f(sv.rel, 1)), d.vec4f(0), sv.discarded),
			uv,
			draw: drawId,
			color: d.vec4f(1),
			fade: listFade(entry),
		};
	}
	const rel = std.add(
		instanceRel(input.position, input.color, input.ii, draw, look),
		vertexOffsetAt(flags, look, m, uv, input.position.w, frame.eye.w),
	);
	return {
		position: std.mul(frame.viewProj, d.vec4f(rel, 1)),
		uv: sheetUv(row.sheet, uv),
		draw: drawId,
		color: std.unpack4x8unorm(row.color),
		fade: listFade(entry),
	};
});

/** fragment entrypoint discarding alpha-tested and dithered cutout pixels in depth/shadow passes */
export const fsCutoutDepth = tgpu.fragmentFn({
	in: CutoutDepthVaryings,
	out: d.Void,
})((input) => {
	'use gpu';
	if (fadeDiscard(input.fade, input.position.xy)) {
		std.discard();
	}
	const frame = frameLayout.$.frame;
	const draw = meshDrawLayout.$.draws[input.draw];
	const flags = std.bitcastF32toU32(draw.offset.w);
	const id = lookSlot(draw);
	const look = meshDrawLayout.$.looks[id];
	const gradientScale = std.exp2(frame.params.y);
	const uv0Dx = std.mul(std.dpdx(input.uv.xy), gradientScale);
	const uv0Dy = std.mul(std.dpdy(input.uv.xy), gradientScale);
	const uv1Dx = std.mul(std.dpdx(input.uv.zw), gradientScale);
	const uv1Dy = std.mul(std.dpdy(input.uv.zw), gradientScale);
	if ((flags & d.u32(EROSION)) !== d.u32(0) && look.emissive2.w > 1.5) {
		return;
	}
	let texel = d.vec4f(0);
	if ((flags & d.u32(ALPHA_NORMAL)) !== d.u32(0)) {
		texel = sampleSlot(
			meshMaterialLayout.$.normalMap,
			meshMaterialLayout.$.detailSampler,
			id,
			input.uv,
			uv0Dx,
			uv0Dy,
			uv1Dx,
			uv1Dy,
			flags,
			d.u32(NORMAL_SLOT),
		);
	} else {
		texel = sampleSlot(
			meshMaterialLayout.$.baseMap,
			meshMaterialLayout.$.baseSampler,
			id,
			input.uv,
			uv0Dx,
			uv0Dy,
			uv1Dx,
			uv1Dy,
			flags,
			d.u32(BASE_SLOT),
		);
	}
	if (look.tint.w < 0) {
		const dither = look.canopy;
		const bits = d.u32(dither.w);
		let scaled = ditherAlpha(look, bits, texel, input.color.w, 1 / input.position.w);
		if ((bits & d.u32(DITHER_MASK)) !== d.u32(0)) {
			const masking = sampleSlot(
				meshMaterialLayout.$.parallaxNoiseMap,
				meshMaterialLayout.$.noiseSampler,
				id,
				input.uv,
				uv0Dx,
				uv0Dy,
				uv1Dx,
				uv1Dy,
				flags,
				d.u32(NOISE_SLOT),
			);
			scaled *= std.select(masking.w, masking.x, (bits & d.u32(DITHER_MASK_RED)) !== d.u32(0));
		}
		const alpha = std.pow(std.saturate(scaled), dither.y);
		if (
			alpha - gradientNoise(std.add(std.mul(input.position.xy, dither.z), d.vec2f(frame.params.w))) <
			1e-5
		) {
			std.discard();
		}
	} else if (texel.w < look.tint.w) {
		std.discard();
	}
});

// #endregion
