/**
 * Rec. 709 luminance weights and helpers shared across shaders.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

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
