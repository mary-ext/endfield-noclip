/**
 * composite shader: combines deferred-lit radiance and celestial layers with the atmosphere sky-view LUT,
 * atmosphere fog, two-layer height fog, volumetric fog, and drifting 3D flow noise.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { postUniformLayout, viewDepth, viewRay } from '../core/post-schema.ts';

import { skyReadLayout } from './atmosphere-shader.ts';
import { fogOver, froxelsAt } from './fog-shader.ts';
import { skyRadiance } from './sky-shader.ts';

/** group 2 bind group layout for composite: deferred-lit scene (celestial on sky) and main-pass depth */
export const compositeSceneLayout = tgpu.bindGroupLayout({
	lit: { texture: d.texture2d(d.f32) },
	depth: { texture: d.textureDepth2d() },
});

/** group 3 bind group layout for composite: height fog 3D flow noise and repeating sampler */
export const compositeFlowNoiseLayout = tgpu.bindGroupLayout({
	flowNoise: { texture: d.texture3d(d.f32) },
	flowNoiseSampler: { sampler: 'filtering' },
});

const driftFog = tgpu.fn(
	[d.vec3f, d.vec3f, d.vec3f, d.vec3f, d.f32],
	d.vec3f,
)((unfogged, fogged, transmittance, position, distance) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const strength = post.flowNoise.w * std.clamp(1 - distance * post.flowNoiseScale.y, 0, 1);
	if (strength <= 0) {
		return d.vec3f(fogged);
	}
	const samplePos = std.add(std.mul(position, post.flowNoiseScale.x), post.flowNoise.xyz);
	const noise = std.textureSampleLevel(
		compositeFlowNoiseLayout.$.flowNoise,
		compositeFlowNoiseLayout.$.flowNoiseSampler,
		samplePos,
		0,
	).r;
	const amount = std.min(1 - strength + 2 * noise * strength, 1 + std.dot(transmittance, d.vec3f(1 / 3)));
	return std.mix(unfogged, fogged, amount);
});

/** fragment entrypoint compositing sky, celestial layers, deferred lighting, and fog into HDR */
export const fsComposite = tgpu.fragmentFn({
	in: {
		position: d.builtin.position,
		uv: d.vec2f,
	},
	out: d.vec4f,
})((input) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const px = d.vec2i(input.position.xy);
	const depth = std.textureLoad(compositeSceneLayout.$.depth, px, 0);
	const ray = viewRay(input.uv);
	const direction = std.normalize(ray);
	const lit = std.textureLoad(compositeSceneLayout.$.lit, px, 0);
	if (depth <= 0) {
		// the `clouds` debug view: the raw panorama, unfogged
		if (post.cloud.w > 0.5 && post.cloudShape.w > 0.5) {
			return d.vec4f(lit.rgb, 1);
		}
		const froxels = froxelsAt(
			skyReadLayout.$.froxels,
			skyReadLayout.$.lutSampler,
			input.uv,
			post.skyFog.x * std.dot(direction, post.forward.xyz),
		);
		const sky = std.add(std.mul(skyRadiance(direction), 1 - lit.a), lit.rgb);
		const fog = fogOver(direction, post.skyFog.x, froxels);
		return d.vec4f(std.add(std.mul(sky, fog.transmittance), fog.inscatter), 1);
	}
	const color = lit.rgb;
	const eyeDepth = viewDepth(depth);
	const distance = std.length(std.mul(ray, eyeDepth));
	const fog = fogOver(
		direction,
		distance,
		froxelsAt(skyReadLayout.$.froxels, skyReadLayout.$.lutSampler, input.uv, eyeDepth),
	);
	const fogged = driftFog(
		color,
		std.add(std.mul(color, fog.transmittance), fog.inscatter),
		fog.transmittance,
		std.add(post.eye.xyz, std.mul(ray, eyeDepth)),
		distance,
	);
	return d.vec4f(fogged, 1);
});
