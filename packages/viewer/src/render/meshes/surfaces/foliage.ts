/**
 * foliage surface helpers: trunk vertex-AO/ramp, leaf two-sided transmission/subsurface/canopy ramp, grass
 * root-to-tip occlusion/sun mask, and `_DISTORTION_FLOW` glowing foliage.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { Surface, frameLayout, hermite } from '../../core/frame-core.ts';
import { LUMINANCE } from '../../core/shader-math.ts';

import { LookSchema, MeshVertexData, meshMaterialLayout } from './common.ts';

/**
 * applies `HGRP/Foliage/Trunk` vertex AO and height ramp to a lit surface.
 *
 * @param surface base surface
 * @param look material look
 * @param v interpolated vertex data
 * @param baseA base map alpha
 * @returns updated surface
 */
export const trunkSurface = tgpu.fn(
	[Surface, LookSchema, MeshVertexData, d.f32],
	Surface,
)((surface, look, v, baseA) => {
	'use gpu';
	const s = Surface(surface);
	s.occlusion *= std.mix(1, v.color.x, look.canopy.z);
	const ramp = look.canopy.w * hermite(look.canopy.x + look.canopy.y, look.canopy.x, v.color.w) * baseA;
	s.albedo = std.mix(s.albedo, look.canopyColor.xyz, ramp);
	return Surface(s);
});

/**
 * applies `HGRP/Foliage/Leaf` transmission, subsurface, canopy ramp, `_BLEND_COLOR`, and fake sun shadow.
 *
 * @param surface base surface
 * @param look material look
 * @param v interpolated vertex data
 * @param hasNormal whether the normal map is bound
 * @param normalA normal map alpha
 * @returns updated surface
 */
export const leafSurface = tgpu.fn(
	[Surface, LookSchema, MeshVertexData, d.bool, d.f32],
	Surface,
)((surface, look, v, hasNormal, normalA) => {
	'use gpu';
	const s = Surface(surface);
	const thin = std.select(d.f32(1), std.saturate(1 - normalA), hasNormal);
	const ao = std.saturate(std.mix(1, v.color.x, look.surface2.x));
	s.occlusion = ao;
	const fadeIn = d.vec2f(
		hermite(look.foliageAo.x, look.foliageAo.x + look.foliageAo.y, ao),
		hermite(look.foliageAo.z, look.foliageAo.z + look.foliageAo.w, ao),
	);
	const far = std.select(d.f32(1), hermite(3600, 2500, std.dot(v.origin, v.origin)), look.foliage2.y > 0.5);
	s.transmission = look.surface2.z * thin * far * fadeIn.x;
	s.subsurface = look.foliage2.x * fadeIn.y;

	const height = std.select(v.color.w, 1 - v.color.w, look.foliage2.w > 0.5);
	const ramp = hermite(look.canopy.x + look.canopy.y, look.canopy.x, height) * thin * look.foliage2.z;
	const tinted = std.mix(
		std.saturate(std.mul(std.mul(s.albedo, look.canopyColor.xyz), look.canopy.z)),
		look.canopyColor.xyz,
		look.canopy.w,
	);
	s.albedo = std.mix(s.albedo, tinted, ramp);

	let vertexNormal = d.vec3f(s.normal);
	if (std.dot(v.normal, v.normal) > 1e-6) {
		vertexNormal = std.normalize(v.normal);
	}
	const blend = look.maskAlbedo[1];
	if (blend.w > 0.5) {
		const up = std.saturate(std.mix(s.normal.y, vertexNormal.y, blend.z) + 0.5 + blend.x);
		const keep = std.saturate(std.pow(up, blend.y) + 1 - std.saturate(thin * look.maskAlbedo[0].w * 10));
		s.albedo = std.mul(s.albedo, std.mix(look.maskAlbedo[0].xyz, look.tint.xyz, keep));
	}

	const sun = frameLayout.$.frame.sun.xyz;
	const fake = std.saturate(
		1 - std.pow(std.saturate(std.dot(s.normal, std.neg(sun)) * 0.5 + 0.5), look.foliage.z) * look.foliage.y,
	);
	s.sunShadow = std.mix(1, v.color.x, look.foliage.x) * fake;
	s.sunNDotL = std.saturate(std.dot(std.mix(s.normal, vertexNormal, look.foliage.w), sun));
	return Surface(s);
});

/**
 * applies `HGRP/Foliage/Grass` root-to-tip AO, sun mask, and transmission.
 *
 * @param surface base surface
 * @param look material look
 * @param v interpolated vertex data
 * @param mask normal map alpha (or `1` without a normal map)
 * @returns updated surface
 */
export const grassSurface = tgpu.fn(
	[Surface, LookSchema, MeshVertexData, d.f32],
	Surface,
)((surface, look, v, mask) => {
	'use gpu';
	const s = Surface(surface);
	const height = std.max(v.objectPos.y, 0);
	const ao = look.foliageAo;
	s.occlusion = 1 - ao.z * (1 - std.saturate((height - ao.x) * ao.y));
	const dir = 1 - look.foliage2.w * (1 - std.saturate((height - look.foliage2.y) * look.foliage2.z));
	const diffuse = dir * std.mix(1, mask, look.foliage.z);
	const transmitted = dir * std.mix(1, mask, look.foliage.w);
	s.sunShadow = std.max(diffuse, transmitted);
	s.transmission = look.surface2.z * (1 - std.abs(diffuse - transmitted));
	s.subsurface = look.foliage2.x;
	return Surface(s);
});

/**
 * evaluates `_DISTORTION_FLOW`'s self-warped scrolling glow emission for `HGRP/Foliage/Glow`.
 *
 * @param look material look
 * @param albedo surface albedo
 * @param vertexRed vertex colour red channel
 * @param uv noise UV set
 * @param dx dpdx of `uv` (pre-scaled)
 * @param dy dpdy of `uv` (pre-scaled)
 * @returns additive HDR glow emission
 */
export const flowGlow = tgpu.fn(
	[LookSchema, d.vec3f, d.f32, d.vec2f, d.vec2f, d.vec2f],
	d.vec3f,
)((look, albedo, vertexRed, uv, dx, dy) => {
	'use gpu';
	const flow = look.parallaxDark;
	const shape = look.parallaxBright;
	const t = frameLayout.$.frame.eye.w;
	const firstUv = std.mul(std.add(std.mul(uv, flow.x), d.vec2f(0, t * flow.z)), 0.25);
	const n1 = std.textureSampleGrad(
		meshMaterialLayout.$.parallaxNoiseMap,
		meshMaterialLayout.$.parallaxSampler,
		firstUv,
		std.mul(dx, flow.x * 0.25),
		std.mul(dy, flow.x * 0.25),
	).x;
	const secondUv = std.mul(
		std.add(std.add(d.vec2f((2 * n1 - 1) * shape.x), std.mul(uv, flow.y)), d.vec2f(t * flow.w)),
		0.25,
	);
	const n2 = std.textureSampleGrad(
		meshMaterialLayout.$.parallaxNoiseMap,
		meshMaterialLayout.$.parallaxSampler,
		secondUv,
		std.mul(dx, flow.y * 0.25),
		std.mul(dy, flow.y * 0.25),
	).x;
	const brightness = std.max(1 + 10 * (std.dot(albedo, LUMINANCE.$) - look.parallaxColor.w), 0);
	const strength = std.saturate((2 * n2 - 1) * shape.y + shape.z) * std.mix(1, vertexRed, shape.w);
	return std.mul(std.mul(look.parallaxColor.xyz, albedo), brightness * strength);
});
