/**
 * screen-space noise shared by frame and post-processing shaders.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

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
