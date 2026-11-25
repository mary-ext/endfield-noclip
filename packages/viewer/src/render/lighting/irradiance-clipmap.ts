/**
 * irradiance clipmap layout helpers shared by the clipmap update compute shader and lighting shaders. three
 * levels stack along z in one A and one B texture, each taking a 128-slice slab plus one wrapped copy on each
 * side (130 slices per slab, 390 total).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

/** texels per level */
export const IRRADIANCE_TEXELS = tgpu.const(d.vec3f, d.vec3f(128, 64, 128));
/** slices per level's slab (wrapped copies included) */
export const IRRADIANCE_SLAB = 130;
/** total depth slices across all three levels */
export const IRRADIANCE_DEPTH = 390;

/**
 * stacked texture z coordinate for a level's local z in `[0, 1)`.
 *
 * @param level clipmap level index (0..2)
 * @param z local z in `[0, 1)`
 * @returns stacked 3D texture z coordinate
 */
export const irradianceZ = tgpu.fn(
	[d.i32, d.f32],
	d.f32,
)((level, z) => {
	'use gpu';
	return (d.f32(level) * IRRADIANCE_SLAB + 1 + z * IRRADIANCE_TEXELS.$.z) / IRRADIANCE_DEPTH;
});

/**
 * stacked texture z coordinate clamped to the level's edge texels (as a clamping sampler would).
 *
 * @param level clipmap level index (0..2)
 * @param z local z in `[0, 1)`
 * @returns clamped stacked 3D texture z coordinate
 */
export const irradianceZClamped = tgpu.fn(
	[d.i32, d.f32],
	d.f32,
)((level, z) => {
	'use gpu';
	const half = 0.5 / IRRADIANCE_TEXELS.$.z;
	return irradianceZ(level, std.clamp(z, half, 1 - half));
});
