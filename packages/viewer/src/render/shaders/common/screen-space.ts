/**
 * projecting onto the main pass's targets and marching screen-space reflection rays (shared by SSR and water
 * SSR trace).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { postUniformLayout } from '../../post/post-schema.ts';

import { gradientNoise } from './noise.ts';

/** result of a screen-space reflection ray march */
export const SsrMarchHit = d.struct({
	/** hit uv (xy) and device depth (z) */
	position: d.vec3f,
	hit: d.bool,
});

/**
 * projects a camera-relative point onto the main pass's (jittered) targets: xy UV, z device depth.
 *
 * @param rel camera-relative position
 * @returns `(u, v, deviceDepth)`
 */
export const ssrProject = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((rel) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const dist = std.dot(rel, post.forward.xyz);
	const right = post.right.xyz;
	const up = post.up.xyz;
	const ndc = std.add(
		std.div(d.vec2f(std.dot(rel, right) / std.dot(right, right), std.dot(rel, up) / std.dot(up, up)), dist),
		post.jitter.xy,
	);
	return d.vec3f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, post.forward.w / dist);
});

/**
 * loads the main pass's (reversed-Z) device depth under `uv`, 0 for the sky.
 *
 * @param depthTex main pass depth texture
 * @param uv screen UV in `[0, 1]^2`
 * @returns device depth sample
 */
export const ssrDeviceDepth = tgpu.fn(
	[d.textureDepth2d(), d.vec2f],
	d.f32,
)((depthTex, uv) => {
	'use gpu';
	const viewport = postUniformLayout.$.post.viewport.xy;
	const px = std.clamp(d.vec2i(std.mul(uv, viewport)), d.vec2i(0), std.sub(d.vec2i(viewport), d.vec2i(1)));
	return std.textureLoad(depthTex, px, 0);
});

/**
 * marches a reflection ray from `start` (uv, device depth) towards `end` (uv, device depth), stretched to the
 * screen's edge (Unreal's clip-to-screen) and stepped in `steps` equal steps.
 *
 * @param depthTex main pass depth texture
 * @param start starting `(u, v, deviceDepth)`
 * @param end target `(u, v, deviceDepth)`
 * @param steps total march steps
 * @param targetSize pass size in pixels
 * @param noisePx pixel coordinate seeding per-frame start offset
 * @returns hit position and flag
 */
export const ssrMarchRay = tgpu.fn(
	[d.textureDepth2d(), d.vec3f, d.vec3f, d.f32, d.vec2f, d.vec2f],
	SsrMarchHit,
)((depthTex, start, end, steps, targetSize, noisePx) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const startNdc = d.vec2f(start.x * 2 - 1, 1 - start.y * 2);
	let delta = d.vec3f((end.x - start.x) * 2, (start.y - end.y) * 2, end.z - start.z);
	{
		const halfLength = std.max(0.5 * std.length(delta.xy), 1e-9);
		const scale = std.sub(
			d.vec2f(1),
			std.div(
				std.max(
					std.sub(std.abs(std.add(delta.xy, std.mul(startNdc, halfLength))), d.vec2f(halfLength)),
					d.vec2f(0),
				),
				std.max(std.abs(delta.xy), d.vec2f(1e-9)),
			),
		);
		delta = std.mul(delta, std.min(scale.x, scale.y) / halfLength);
	}
	const tolerance = std.max(std.abs(delta.z) / steps, 1e-4);
	const step = std.div(d.vec3f(delta.x * 0.5, -delta.y * 0.5, delta.z), steps);
	let offset = d.f32(0);
	{
		const pixels = std.abs(std.mul(step.xy, targetSize));
		const longest = std.max(pixels.x, pixels.y);
		if (longest < 1) {
			offset = 1 / (longest + 0.001);
		} else {
			offset = gradientNoise(std.add(noisePx, std.mul(d.vec2f(2.083, 4.867), post.eye.w)));
		}
	}
	let position = std.add(start, std.mul(step, offset));
	let last = position.z - ssrDeviceDepth(depthTex, position.xy);
	for (let i = d.f32(0); i < steps; i += 4) {
		const diff = d.arrayOf(d.f32, 4)();
		let found = -1;
		for (let k = 0; k < 4; k++) {
			const tap = std.add(position, std.mul(step, d.f32(k + 1)));
			diff[k] = tap.z - ssrDeviceDepth(depthTex, tap.xy);
			// a hit lies behind the depth buffer's surface by less than two steps' depth
			if (found < 0 && std.abs(diff[k] + tolerance) < tolerance) {
				found = k;
			}
		}
		if (found >= 0) {
			const before = std.select(diff[std.max(found - 1, 0)], last, found === 0);
			const after = diff[found];
			position = std.add(position, std.mul(step, d.f32(found) + std.clamp(before / (before - after), 0, 1)));
			return SsrMarchHit({ position, hit: true });
		}
		position = std.add(position, std.mul(step, 4));
		last = diff[3];
	}
	return SsrMarchHit({ position, hit: false });
});

/**
 * fades a hit towards the screen's edges and for surfaces seen head-on.
 *
 * @param uv hit screen UV
 * @param normal surface world normal
 * @param viewDir view direction from camera to surface
 * @param fadeOnScreen screen-edge fade width
 * @param mirrorMul head-on fade multiplier
 * @param mirrorAdd head-on fade bias
 * @returns combined fade factor in `[0, 1]`
 */
export const ssrFade = tgpu.fn(
	[d.vec2f, d.vec3f, d.vec3f, d.f32, d.f32, d.f32],
	d.f32,
)((uv, normal, viewDir, fadeOnScreen, mirrorMul, mirrorAdd) => {
	'use gpu';
	const edge = std.min(1 - std.max(uv.x, uv.y), std.min(uv.x, uv.y));
	const onScreen = std.clamp(std.select(edge / fadeOnScreen, 1, edge > fadeOnScreen), 0, 1);
	const mirror = 1 - std.clamp(std.abs(std.dot(normal, viewDir)) * mirrorMul + mirrorAdd, 0, 1);
	return onScreen * mirror;
});
