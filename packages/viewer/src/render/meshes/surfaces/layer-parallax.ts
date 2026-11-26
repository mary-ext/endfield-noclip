/**
 * Lit layer blending, tri-channel mask blending, emissive pulse, and parallax glow helpers.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout, Surface } from '../../core/frame-core.ts';
import { LUMINANCE, LUMINANCE_ROUNDED } from '../../core/shader-math.ts';

import {
	LookSchema,
	meshMaterialLayout,
	NORMAL_MAP,
	NORMAL_ROUGHNESS,
	NORMAL_OCCLUSION,
	PARALLAX_SLOT,
	NOISE_SLOT,
	EXTRA_OVERLAY_MASK_MAP,
	MeshVertexData,
	surfaceNormal,
} from './common.ts';

export const blendMaskChannel = tgpu.fn(
	[Surface, d.f32, d.vec3f, d.f32, d.f32],
	Surface,
)((s, w, albedo, roughness, metallic) => {
	'use gpu';
	const out = Surface(s);
	out.albedo = std.mix(s.albedo, albedo, w);
	out.roughness = std.mix(s.roughness, roughness, w);
	out.metallic = std.mix(s.metallic, metallic, w);
	return Surface(out);
});

export const reorientNormal = tgpu.fn(
	[d.vec3f, d.vec3f],
	d.vec3f,
)((base, flipped) => {
	'use gpu';
	const b = std.add(base, d.vec3f(0, 0, 1));
	return std.sub(std.div(std.mul(b, std.dot(b, flipped)), std.max(1e-5, b.z)), flipped);
});

export const topCoverage = tgpu.fn(
	[LookSchema, d.f32],
	d.f32,
)((look, up) => {
	'use gpu';
	const coverage = look.parallax;
	return std.saturate((up - coverage.y) / coverage.z);
});

export const maskCoverage = tgpu.fn(
	[d.f32, d.f32, d.f32, d.f32, d.f32],
	d.f32,
)((source, maskR, bumpA, baseA, normalA) => {
	'use gpu';
	const code = d.u32(source + 0.5);
	if (code === d.u32(1)) {
		return maskR;
	}
	if (code === d.u32(2)) {
		return bumpA;
	}
	if (code === d.u32(3)) {
		return baseA;
	}
	if (code === d.u32(4)) {
		return normalA;
	}
	return 1;
});

export const layerCoverage = tgpu.fn(
	[LookSchema, d.f32, d.f32],
	d.f32,
)((look, raw, layerA) => {
	'use gpu';
	const height = look.parallax2;
	const cover = std.saturate(raw);
	if (height.x === 0) {
		return cover;
	}
	const weights = d.vec2f(1 - cover, cover);
	const heights = std.mul(weights, d.vec2f(height.z, layerA));
	const w = std.mul(
		std.add(
			std.max(
				d.vec2f(0),
				std.sub(std.add(heights, d.vec2f(height.y)), d.vec2f(std.max(heights.x, heights.y))),
			),
			d.vec2f(1e-6),
		),
		weights,
	);
	return w.y / std.max(1.175494e-38, w.x + w.y);
});

export const layerFuzzyEdge = tgpu.fn(
	[LookSchema, d.f32],
	d.f32,
)((look, raw) => {
	'use gpu';
	const diff = raw - look.foliage.w;
	return std.saturate(1 - (diff * diff) / look.foliage.z);
});

export const layerNormal = tgpu.fn(
	[LookSchema, d.vec3f, d.vec4f],
	d.vec3f,
)((look, base, bump) => {
	'use gpu';
	const normal = look.parallaxBright;
	const xy = std.sub(std.mul(bump.xy, 2), d.vec2f(1));
	const layer = d.vec3f(std.mul(xy, normal.x), std.max(1e-16, std.sqrt(1 - std.saturate(std.dot(xy, xy)))));
	const reoriented = reorientNormal(base, std.mul(layer, d.vec3f(-1, -1, 1)));
	return std.mix(layer, reoriented, normal.y);
});

export const layerSurface = tgpu.fn(
	[Surface, LookSchema, d.f32, d.vec4f, d.vec4f, d.f32, d.f32],
	Surface,
)((surface, look, cover, layer, bump, facing, edge) => {
	'use gpu';
	const s = Surface(surface);
	const color = look.parallaxColor;
	const blend = look.parallaxDark;
	const normal = look.parallaxBright;
	const fuzzy = look.foliage;
	const fuzzy2 = look.foliageAo;
	const luma = std.dot(layer.xyz, LUMINANCE.$);
	const tinted = std.mul(std.mul(std.mix(d.vec3f(luma), layer.xyz, color.w), color.xyz), 1 - edge * fuzzy2.x);
	const core = std.mix(1 - fuzzy.x, 1, std.pow(facing, fuzzy2.y));
	const bright = core + fuzzy.y * 2 * std.dot(tinted, LUMINANCE_ROUNDED.$);
	const fuzz = std.mix(core, bright, std.pow(facing, fuzzy2.z));
	s.albedo = std.add(
		std.mul(s.albedo, 1 - cover * (1 - blend.x)),
		std.mul(tinted, fuzz * cover * std.mix(1, blend.y, blend.x)),
	);
	s.metallic = std.mix(s.metallic, std.select(blend.w, layer.w, blend.z !== 0), cover);
	s.roughness = std.mix(s.roughness, bump.z, cover);
	s.occlusion = std.mix(
		s.occlusion,
		std.select(std.mix(1, bump.w, normal.z), d.f32(1), normal.w !== 0),
		cover,
	);
	return Surface(s);
});

export const mapChannel = tgpu.fn(
	[d.u32, d.bool, d.f32, d.f32, d.vec4f, d.vec4f],
	d.f32,
)((flags, mro, channel, baseA, packed, mask) => {
	'use gpu';
	if ((flags & d.u32(NORMAL_OCCLUSION | NORMAL_ROUGHNESS)) !== d.u32(0)) {
		const hasNormal = (flags & d.u32(NORMAL_MAP)) !== d.u32(0);
		const b = std.select(d.f32(0), packed.z, hasNormal);
		const a = std.select(d.f32(0), packed.w, hasNormal);
		return std.mix(std.mix(baseA, b, std.saturate(channel - 1)), a, std.saturate(channel - 2));
	}
	return std.mix(baseA, std.select(d.f32(0), mask.w, mro), std.saturate(channel - 2));
});

export const emissivePulse = tgpu.fn(
	[LookSchema],
	d.f32,
)((look) => {
	'use gpu';
	const x =
		std.saturate(
			std.fract(frameLayout.$.frame.eye.w * look.emissivePulse.x + look.emissivePulse.y) *
				look.emissivePulse.z,
		) *
			2 -
		1;
	const low = std.min(look.emissivePulse.w, 0.999);
	const x2 = x * x;
	return (2 * std.abs(x2 * x) - 3 * x2 + 0.5 + (0.5 * (1 + low)) / (1 - low)) * (1 - low);
});

const parallaxMarch = tgpu.fn(
	[LookSchema, MeshVertexData, d.vec3f, d.bool, d.vec2f, d.vec2f, d.vec2f, d.vec2f, d.vec2f],
	d.vec2f,
)((look, v, viewDir, hasNoise, uv, uv0Dx, uv0Dy, dx, dy) => {
	'use gpu';
	const bitangent = std.mul(std.cross(v.normal, v.tangent.xyz), v.tangent.w);
	const vt = std.normalize(
		d.vec3f(std.dot(viewDir, v.tangent.xyz), std.dot(viewDir, bitangent), std.dot(viewDir, v.normal)),
	);
	const steps = look.parallax.y;
	const step = 1 / steps;
	const delta = std.mul(std.div(vt.xy, (vt.z + 0.42) * std.max(vt.z, 0.001)), -look.parallax.x * step);
	const noiseUv = std.mul(uv, look.slotUv[NOISE_SLOT].xy);

	let height = 1 - step;
	let offset = d.vec2f(delta);
	let previousOffset = d.vec2f(0);
	let previousSample = d.f32(0);
	let previousHeight = d.f32(1);
	let hit = d.f32(-1);
	for (let i = d.f32(0); i < steps + 1; i += 1) {
		const sampled = std.textureSampleGrad(
			meshMaterialLayout.$.parallaxNoiseMap,
			meshMaterialLayout.$.parallaxSampler,
			std.add(noiseUv, offset),
			uv0Dx,
			uv0Dy,
		).x;
		const found = std.select(d.f32(0), sampled, hasNoise);
		if (found > height) {
			hit = found;
			break;
		}
		previousOffset = d.vec2f(offset);
		previousSample = found;
		previousHeight = height;
		offset = std.add(offset, delta);
		height -= step;
	}
	if (hit < 0) {
		hit = previousSample;
	}
	const denominator = previousSample - hit + height - previousHeight;
	const t = (previousSample - previousHeight) / std.select(denominator, d.f32(1e-6), denominator === 0);
	const tiling = look.slotUv[PARALLAX_SLOT].xy;
	return std.textureSampleGrad(
		meshMaterialLayout.$.parallaxMap,
		meshMaterialLayout.$.parallaxSampler,
		std.mul(std.add(std.add(uv, previousOffset), std.mul(delta, t)), tiling),
		std.mul(dx, tiling),
		std.mul(dy, tiling),
	).xy;
});

const parallaxRadiance = tgpu.fn(
	[LookSchema, MeshVertexData, d.vec3f, d.vec3f, d.vec3f],
	d.vec3f,
)((look, v, viewDir, n, baseColor) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const fresnel = std.pow(std.max(std.saturate(std.dot(viewDir, n)), 0.001), look.parallax.z);
	const pulse =
		std.cos(frame.eye.w * look.parallax2.x + look.parallax2.y * v.phase) * look.parallax.w + look.parallax2.w;
	const bright = look.parallaxBright;
	const nearT = std.saturate((std.length(v.rel) - bright.x) / (bright.y - bright.x));
	const near = nearT * nearT * (3 - 2 * nearT) * bright.z;
	const color = std.mul(baseColor, fresnel * (pulse + near));
	return std.mul(std.clamp(color, d.vec3f(0), d.vec3f(1000)), std.mix(1, frame.ambient.y, look.parallax2.z));
});

export const parallaxGlow = tgpu.fn(
	[LookSchema, MeshVertexData, d.vec3f, d.vec3f, d.bool, d.vec2f, d.vec2f, d.vec2f, d.vec2f, d.vec2f],
	d.vec3f,
)((look, v, viewDir, n, hasNoise, uv, uv0Dx, uv0Dy, dx, dy) => {
	'use gpu';
	const pattern = parallaxMarch(look, v, viewDir, hasNoise, uv, uv0Dx, uv0Dy, dx, dy);
	const baseColor = std.mix(look.parallaxDark.xyz, look.parallaxColor.xyz, pattern.y);
	return parallaxRadiance(look, v, viewDir, n, baseColor);
});

export const parallaxWorldGlow = tgpu.fn(
	[
		LookSchema,
		MeshVertexData,
		d.u32,
		d.u32,
		d.vec3f,
		d.vec3f,
		d.bool,
		d.vec2f,
		d.vec2f,
		d.vec2f,
		d.vec2f,
		d.vec2f,
		d.f32,
		d.vec4f,
	],
	d.vec3f,
)((look, v, flags, extra, viewDir, n, hasNoise, uv, uv0Dx, uv0Dy, dx, dy, baseA, packed) => {
	'use gpu';
	const pattern = parallaxMarch(look, v, viewDir, hasNoise, uv, uv0Dx, uv0Dy, dx, dy);
	const baseColor = std.mix(look.parallaxDark.xyz, look.parallaxColor.xyz, pattern.y);
	const baseGlow = parallaxRadiance(look, v, viewDir, n, baseColor);

	const world = std.add(v.rel, frameLayout.$.frame.eye.xyz);
	const wp = look.parallaxWorld[0];
	const rot = look.parallaxWorld[1];
	const patBright = look.parallaxWorld[2];
	const patDark = look.parallaxWorld[3];
	const addCol = look.parallaxWorld[4];

	const deltaXz = std.sub(world.xz, wp.xy);
	const scaled = std.mul(deltaXz, wp.z);
	const rotated = d.vec2f(rot.x * scaled.x + rot.y * scaled.y, -rot.y * scaled.x + rot.x * scaled.y);
	const minBrightness = look.parallax2.w - look.parallax.w;
	const maskUv = std.add(std.add(rotated, d.vec2f(0.5)), std.mul(pattern, minBrightness));
	const geomNy = std.select(
		d.f32(0),
		std.saturate(std.abs(std.normalize(v.normal).y)),
		std.dot(v.normal, v.normal) > 1e-6,
	);
	const maskSample = std.select(
		d.vec3f(0),
		std.textureSampleLevel(
			meshMaterialLayout.$.overlayMaskMap,
			meshMaterialLayout.$.detailSampler,
			maskUv,
			std.mix(3, 0, geomNy),
		).xyz,
		(extra & d.u32(EXTRA_OVERLAY_MASK_MAP)) !== d.u32(0),
	);
	const tinted = std.mul(std.mul(baseGlow, baseColor), maskSample);
	const lerpT = std.saturate(std.length(deltaXz) + pattern.x * 20 - wp.w);
	const glow = std.mix(std.mul(tinted, patBright.xyz), std.mul(tinted, patDark.xyz), lerpT);

	const hasNormal = (flags & d.u32(NORMAL_MAP)) !== d.u32(0);
	const normB = std.select(d.f32(0), packed.z, hasNormal);
	const normA = std.select(d.f32(0), packed.w, hasNormal);
	const addCh = patDark.w;
	const addMask = std.mix(std.mix(baseA, normB, std.saturate(addCh)), normA, std.saturate(addCh - 1));
	const additional = std.mul(
		std.mul(std.add(d.vec3f(0.3), glow), addCol.xyz),
		std.saturate(v.objectPos.y - patBright.w) * addMask,
	);
	const heightMask = std.mix(baseA, std.saturate(rot.w - world.y), std.saturate(rot.w));
	return std.add(additional, std.mul(glow, heightMask * rot.z));
});

/**
 * evaluates `HGRP/LitTransparent`'s `_USE_FRESNEL`, returning `(fresnel, mask)`.
 *
 * @param look material look
 * @param v interpolated vertex data
 * @param front geometric front-face flag
 * @param faceted screen-space faceted normal
 * @param shadingN shading normal
 * @param baseA base map alpha
 * @param packed normal map sample
 * @returns `(fresnel, mask)`
 */
export const transparentFresnel = tgpu.fn(
	[LookSchema, MeshVertexData, d.bool, d.vec3f, d.vec3f, d.f32, d.vec4f],
	d.vec2f,
)((look, v, front, faceted, shadingN, baseA, packed) => {
	'use gpu';
	const ch = look.parallax2.x;
	const sampleCh = std.mix(std.mix(baseA, packed.z, std.saturate(ch)), packed.w, std.saturate(ch - 1));
	const mask = std.saturate(1 - sampleCh + look.parallax2.y);
	const meshN = surfaceNormal(v.normal, faceted, !front);
	const fnN = std.normalize(std.mix(shadingN, meshN, look.parallax2.w));
	const viewDir = std.normalize(std.neg(v.rel));
	const raw = std.pow(std.saturate(std.dot(viewDir, fnN) + look.parallax.x), look.parallax.y);
	const fresnel = std.mix(1 - raw, raw, look.parallax.z);
	return d.vec2f(fresnel, mask);
});

// #endregion
