/**
 * G-buffer normal, roughness and flags encoding shared by geometry passes, decals, GTAO, SSR and deferred
 * lighting.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { octDecode, octEncode } from './octahedral.ts';

/** shading model ids stored in `gbuffer_a.a` (2 bits) */
export const SHADING_LIT = 0;
export const SHADING_FOLIAGE = 1;
export const SHADING_SUBSURFACE = 2;
export const SHADING_UNLIT = 3;

/** `gbuffer_b.a` flag bits */
export const GBUFFER_VALID = 1;
export const GBUFFER_NO_LIT_DECALS = 2;

/**
 * packs a world-space normal, roughness and 2-bit flags into `gbuffer_b` (`rgb10a2unorm`).
 *
 * @param n world-space unit normal
 * @param roughness perceptual roughness in `[0, 1]`
 * @param flags 2-bit flag mask
 * @returns packed G-buffer B texel
 */
export const packGbufferB = tgpu.fn(
	[d.vec3f, d.f32, d.u32],
	d.vec4f,
)((n, roughness, flags) => {
	'use gpu';
	const e = std.clamp(std.add(std.mul(octEncode(n), 0.5), d.vec2f(0.5)), d.vec2f(0), d.vec2f(1));
	return d.vec4f(e, std.clamp(roughness, 0, 1), d.f32(flags & 3) / 3);
});

/**
 * extracts the 2-bit flag mask from `gbuffer_b`.
 *
 * @param gb G-buffer B texel
 * @returns 2-bit flags
 */
export const gbufferBFlags = tgpu.fn(
	[d.vec4f],
	d.u32,
)((gb) => {
	'use gpu';
	return d.u32(std.round(gb.a * 3));
});

/**
 * @param gb G-buffer B texel
 * @returns whether the pixel holds a valid lit surface
 */
export const gbufferBValid = tgpu.fn(
	[d.vec4f],
	d.bool,
)((gb) => {
	'use gpu';
	return (gbufferBFlags(gb) & GBUFFER_VALID) !== 0;
});

/**
 * @param gb G-buffer B texel
 * @returns whether the pixel rejects lit decals
 */
export const gbufferBNoLitDecals = tgpu.fn(
	[d.vec4f],
	d.bool,
)((gb) => {
	'use gpu';
	return (gbufferBFlags(gb) & GBUFFER_NO_LIT_DECALS) !== 0;
});

/**
 * decodes the world-space unit normal stored in `gbuffer_b.rg`.
 *
 * @param gb G-buffer B texel
 * @returns world-space unit normal
 */
export const gbufferBNormal = tgpu.fn(
	[d.vec4f],
	d.vec3f,
)((gb) => {
	'use gpu';
	return octDecode(std.sub(std.mul(gb.rg, 2), d.vec2f(1)));
});

/**
 * extracts the 2-bit shading model id from `gbuffer_a.a`.
 *
 * @param ga G-buffer A texel
 * @returns shading model id
 */
export const gbufferShadingModel = tgpu.fn(
	[d.vec4f],
	d.u32,
)((ga) => {
	'use gpu';
	return d.u32(std.round(ga.a * 3));
});
