/**
 * shared TypeGPU schemas, bind group layouts, flags, vertex IO, and sampling helpers for HGRP mesh surface
 * shaders.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { InstanceRow } from '../../core/frame-core.ts';
import { PostSchema } from '../../core/post-schema.ts';

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

const DITHER_RED_ALPHA = 1;
const DITHER_VERTEX_COLOR = 2;
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

export const ROW_CLOTH = 8;

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

export const DepthIn = {
	position: d.location(0, d.vec4f),
	color: d.location(5, d.vec4f),
};

export const CutoutDepthIn = {
	position: d.location(0, d.vec4f),
	uv0: d.location(2, d.vec2f),
	uv1: d.location(4, d.vec2f),
	color: d.location(5, d.vec4f),
};

export const FadeDepthOut = {
	position: d.builtin.position,
	fade: d.location(0, d.interpolate('flat', d.u32)),
};

export const FadeDepthIn = {
	position: d.builtin.position,
	fade: d.location(0, d.interpolate('flat', d.u32)),
};

export const CutoutDepthOut = {
	position: d.builtin.position,
	uv: d.location(3, d.vec4f),
	draw: d.location(4, d.interpolate('flat', d.u32)),
	color: d.location(7, d.vec4f),
	fade: d.location(9, d.interpolate('flat', d.u32)),
};

export const CutoutDepthVaryings = {
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
