/**
 * pure math, colour, noise, normal-encoding, phase, and BRDF helpers shared across shaders.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

// #region luminance and colour

/** full-precision Rec. 709 luminance weights */
export const LUMINANCE = tgpu.const(d.vec3f, d.vec3f(0.2126729, 0.7151522, 0.072175));

/** four-decimal Rec. 709 luminance weights, matching `post-schema.ts`'s `luminance()` */
export const LUMINANCE_ROUNDED = tgpu.const(d.vec3f, d.vec3f(0.2126, 0.7152, 0.0722));

/**
 * @param c linear RGB colour
 * @returns Rec. 709 luminance using {@link LUMINANCE_ROUNDED}
 */
export const luminanceRounded = tgpu.fn(
	[d.vec3f],
	d.f32,
)((c) => {
	'use gpu';
	return std.dot(c, LUMINANCE_ROUNDED.$);
});

/**
 * converts linear RGB to YCoCg.
 *
 * @param c linear RGB colour
 * @returns YCoCg components
 */
export const toYcocg = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((c) => {
	'use gpu';
	return d.vec3f(
		std.dot(c, d.vec3f(0.25, 0.5, 0.25)),
		std.dot(c, d.vec3f(0.5, 0, -0.5)),
		std.dot(c, d.vec3f(-0.25, 0.5, -0.25)),
	);
});

/**
 * converts YCoCg back to linear RGB.
 *
 * @param c YCoCg colour
 * @returns linear RGB components
 */
export const fromYcocg = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((c) => {
	'use gpu';
	return d.vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
});

/**
 * converts HSV (hue in turns, saturation, value) to RGB.
 *
 * @param c HSV colour
 * @returns RGB colour
 */
export const hsvToRgb = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((c) => {
	'use gpu';
	const p = std.abs(std.sub(std.mul(std.fract(std.add(c.xxx, d.vec3f(1, 2 / 3, 1 / 3))), 6), d.vec3f(3)));
	return std.mul(c.z, std.mix(d.vec3f(1), std.clamp(std.sub(p, d.vec3f(1)), d.vec3f(0), d.vec3f(1)), c.y));
});

// #endregion

// #region noise and phase

/**
 * interleaved gradient noise (Jimenez) at a pixel coordinate.
 *
 * @param px pixel coordinates
 * @returns noise sample in `[0, 1)`
 */
export const gradientNoise = tgpu.fn(
	[d.vec2f],
	d.f32,
)((px) => {
	'use gpu';
	return std.fract(52.9829189 * std.fract(std.dot(px, d.vec2f(0.06711056, 0.00583715))));
});

/**
 * Henyey–Greenstein phase function with denominator floored off zero for strongly forward lobes.
 *
 * @param g anisotropy factor in `(-1, 1)`
 * @param mu cosine between the light's travel direction and the view ray
 * @returns phase function value
 */
export const henyeyGreenstein = tgpu.fn(
	[d.f32, d.f32],
	d.f32,
)((g, mu) => {
	'use gpu';
	const x = 1 + g * g - 2 * g * mu;
	return (1 - g * g) / std.max(4 * Math.PI * x * std.sqrt(x), 0.001);
});

// #endregion

// #region normals

/**
 * encodes a unit 3D vector into a 2D octahedral representation in `[-1, 1]^2`.
 *
 * @param n unit normal
 * @returns octahedral coordinates
 */
export const octEncode = tgpu.fn(
	[d.vec3f],
	d.vec2f,
)((n) => {
	'use gpu';
	const p = std.div(n.xy, std.abs(n.x) + std.abs(n.y) + std.abs(n.z));
	if (n.z < 0) {
		return std.mul(
			std.sub(d.vec2f(1), std.abs(p.yx)),
			std.select(d.vec2f(-1), d.vec2f(1), std.ge(p, d.vec2f(0))),
		);
	}
	return p;
});

/**
 * decodes a 2D octahedral representation in `[-1, 1]^2` back to a unit 3D vector.
 *
 * @param e octahedral coordinates
 * @returns unit normal
 */
export const octDecode = tgpu.fn(
	[d.vec2f],
	d.vec3f,
)((e) => {
	'use gpu';
	let n = d.vec3f(e, 1 - std.abs(e.x) - std.abs(e.y));
	if (n.z < 0) {
		const s = std.select(d.vec2f(-1), d.vec2f(1), std.ge(n.xy, d.vec2f(0)));
		n = d.vec3f(std.mul(std.sub(d.vec2f(1), std.abs(n.yx)), s), n.z);
	}
	return std.normalize(n);
});

/**
 * unpacks a tangent-space normal's XY from `[0, 1]^2` with the game's dead zone around flat.
 *
 * @param rg encoded RG normal channels
 * @returns tangent-space XY components
 */
export const unpackNormalXy = tgpu.fn(
	[d.vec2f],
	d.vec2f,
)((rg) => {
	'use gpu';
	const xy = std.sub(std.mul(rg, 2), d.vec2f(1));
	return std.select(xy, d.vec2f(0), std.lt(std.abs(xy), d.vec2f(0.012)));
});

/**
 * reconstructs tangent-space Z from XY with the game's Z floor (`1 / 2048`).
 *
 * @param xy tangent-space XY components
 * @returns positive Z component
 */
export const normalZ = tgpu.fn(
	[d.vec2f],
	d.f32,
)((xy) => {
	'use gpu';
	return std.max(1 / 2048, std.sqrt(std.saturate(1 - std.dot(xy, xy))));
});

// #endregion

// #region brdf

/**
 * GGX / Trowbridge–Reitz normal distribution function.
 *
 * @param nDotH cosine between normal and half vector
 * @param a2 roughness to the fourth power (`roughness^4`)
 * @returns normal distribution value
 */
export const ggxDistribution = tgpu.fn(
	[d.f32, d.f32],
	d.f32,
)((nDotH, a2) => {
	'use gpu';
	const denom = nDotH * nDotH * (a2 - 1) + 1;
	return a2 / (Math.PI * denom * denom);
});

/**
 * Schlick's Fresnel approximation.
 *
 * @param f0 reflectance at normal incidence
 * @param vDotH cosine between view and half vector
 * @returns Fresnel reflectance
 */
export const fresnelSchlick = tgpu.fn(
	[d.vec3f, d.f32],
	d.vec3f,
)((f0, vDotH) => {
	'use gpu';
	const f = std.pow(1 - vDotH, 5);
	return std.add(f0, std.mul(std.sub(d.vec3f(1), f0), f));
});

// #endregion
