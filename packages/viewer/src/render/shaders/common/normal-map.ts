/**
 * tangent-space normal-map unpacking shared by mesh surface and effect shaders.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

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
