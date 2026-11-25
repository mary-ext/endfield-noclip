/**
 * BRDF terms shared by lighting, water, and forward surface shaders.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

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
