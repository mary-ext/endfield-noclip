/**
 * scattering phase functions shared by volumetric fog and lighting shaders.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

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
