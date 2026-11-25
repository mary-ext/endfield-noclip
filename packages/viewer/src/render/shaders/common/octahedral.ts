/**
 * octahedral unit-vector encoding, both components in `[-1, 1]`.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

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
