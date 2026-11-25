/**
 * colour space conversions shared by post-processing shaders.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

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
