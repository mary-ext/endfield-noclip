/**
 * sky radiance helper shared by composite and water shaders.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { postUniformLayout } from '../core/post-schema.ts';

import { skyView } from './atmosphere-shader.ts';

/**
 * atmosphere sky radiance along a world direction, faded just below the horizon.
 *
 * @param direction unit world direction
 * @returns pre-exposed sky radiance
 */
export const skyRadiance = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((direction) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	if (post.flags.x === 0) {
		return d.vec3f(0);
	}
	return std.mul(std.mul(skyView(direction), post.skyIlluminance.rgb), std.clamp(1 + direction.y * 10, 0, 1));
});
