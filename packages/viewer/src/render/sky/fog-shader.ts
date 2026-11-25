/**
 * atmosphere fog, two-layer height fog, and volumetric fog integration shared by composite, water, weather,
 * transparent mesh, and effect shaders.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { PostSchema, postUniformLayout } from '../post/post-schema.ts';

/** integrated fog: transmittance multiplying the background and inscattered radiance added in front */
export const Fog = d.struct({
	transmittance: d.vec3f,
	inscatter: d.vec3f,
});

/** volumetric fog in front of a point */
export const Froxels = d.struct({
	/** scattered light (rgb) and transmittance (a) */
	light: d.vec4f,
	/** view depth (m) the froxels cover, which the height fog leaves out */
	covered: d.f32,
});

const fogLayerDensity = tgpu.fn(
	[d.vec4f, d.f32, d.f32],
	d.f32,
)((layer, baseY, deltaY) => {
	'use gpu';
	const x = std.max(-127, layer.y * deltaY);
	let integral = 0.693147182 - 0.240226507 * x;
	if (std.abs(x) > 5.96e-8) {
		integral = (1 - std.exp2(-x)) / x;
	}
	return layer.x * std.exp2(-std.max(-127, layer.y * (baseY - layer.z))) * integral;
});

const froxelsAtWithPost = tgpu.fn(
	[PostSchema, d.texture3d(d.f32), d.sampler(), d.vec2f, d.f32],
	Froxels,
)((post, froxelTex, lutSampler, uv, depth) => {
	'use gpu';
	if (post.froxelSlices.w <= 0) {
		return Froxels({ light: d.vec4f(0, 0, 0, 1), covered: 0 });
	}
	if (depth < post.froxelRange.x) {
		return Froxels({ light: d.vec4f(0, 0, 0, 1), covered: post.froxelSlices.w });
	}
	const w = std.log2(depth * post.froxelSlices.x + post.froxelSlices.y) * post.froxelSlices.z;
	return Froxels({
		light: std.textureSampleLevel(froxelTex, lutSampler, d.vec3f(uv, w), 0),
		covered: post.froxelSlices.w,
	});
});

const fogOverWithPost = tgpu.fn(
	[PostSchema, d.vec3f, d.f32, Froxels],
	Fog,
)((post, direction, distance, froxels) => {
	'use gpu';
	let transmittance = d.vec3f(1);
	let inscatter = d.vec3f(0);
	const pointY = post.eye.y + direction.y * distance;

	// atmosphere fog: density e^((start height - y) / H), integrated from the camera's height
	if (post.flags.z !== d.u32(0) && post.skyFog.y > 0.5) {
		const below = -pointY * post.atmoMie.w;
		const a = std.max(0.01, below + post.eye.y * post.atmoMie.w);
		const depth =
			std.max(0, distance * post.atmoRayleigh.w - post.atmoExtinction.w) *
			((1 - std.exp(-a)) / a) *
			std.exp(below + post.atmoAmbient.w);
		const atmosphere = std.exp(std.mul(std.neg(post.atmoExtinction.xyz), depth));
		const mu = std.dot(direction, post.atmoSun.xyz);
		const g = post.atmoSun.w;
		const hgBase = 1 + g * g - 2 * g * mu;
		const hg = (1 - g * g) / std.max(4 * Math.PI * hgBase * std.sqrt(hgBase), 0.001);
		const rayleigh = (3 / (16 * Math.PI)) * (1 + mu * mu);
		const scattered = std.clamp(
			std.add(
				std.add(std.mul(post.atmoRayleigh.xyz, rayleigh), post.atmoAmbient.xyz),
				std.mul(post.atmoMie.xyz, hg),
			),
			d.vec3f(0),
			d.vec3f(255),
		);
		transmittance = d.vec3f(atmosphere);
		inscatter = std.mul(scattered, std.sub(d.vec3f(1), atmosphere));
	}

	// height fog
	if (post.flags.y !== d.u32(0)) {
		const cosine = std.dot(direction, post.forward.xyz);
		let covered = d.f32(0);
		if (cosine > 5.96e-8) {
			covered = froxels.covered / cosine / distance;
		}
		const deltaY = direction.y * distance;
		const baseY = post.eye.y + covered * deltaY;
		const restY = deltaY * (1 - covered);
		const rest = distance * (1 - covered);
		const density =
			fogLayerDensity(post.fogLayer0, baseY, restY) + fogLayerDensity(post.fogLayer1, baseY, restY);
		const range = post.fogRange;
		const beforeStart = std.clamp((range.x - distance) * range.y, 0, 1);
		const pastCutoff = std.clamp((distance - range.z) * range.w, 0, 1);
		const t = std.clamp(
			std.max(std.clamp(std.exp2(-density * rest), 0, 1), post.fogColor.w) + beforeStart + pastCutoff,
			0,
			1,
		);
		const towardLight = std.clamp(std.dot(direction, post.fogDirectionalDirection.xyz), 0, 1);
		const directionalDepth = density * std.max(rest - post.fogDirectionalDirection.w, 0);
		const directional = std.mul(
			post.fogDirectional.xyz,
			std.pow(towardLight, post.fogDirectional.w) *
				(1 - std.clamp(std.exp2(-directionalDepth), 0, 1)) *
				(1 - pastCutoff),
		);
		transmittance = std.mul(transmittance, t);
		inscatter = std.add(std.add(std.mul(inscatter, t), std.mul(post.fogColor.xyz, 1 - t)), directional);
	}

	// the froxels add in front of both
	const light = froxels.light;
	return Fog({
		transmittance: std.mul(transmittance, light.w),
		inscatter: std.add(std.mul(inscatter, light.w), light.xyz),
	});
});

/**
 * samples the volumetric fog in front of a point at screen `uv` and view `depth` (m) using
 * {@link postUniformLayout}.
 *
 * @param froxelTex 3D froxel volume
 * @param lutSampler bilinear clamping sampler
 * @param uv screen UV in `[0, 1]^2`
 * @param depth linear view depth in metres
 * @returns froxel light and covered depth
 */
export const froxelsAt = tgpu.fn(
	[d.texture3d(d.f32), d.sampler(), d.vec2f, d.f32],
	Froxels,
)((froxelTex, lutSampler, uv, depth) => {
	'use gpu';
	return froxelsAtWithPost(postUniformLayout.$.post, froxelTex, lutSampler, uv, depth);
});

/**
 * computes the combined atmosphere, height, and volumetric fog between the camera and a point `distance`
 * metres along unit `direction` using {@link postUniformLayout}.
 *
 * @param direction unit ray direction
 * @param distance distance in metres
 * @param froxels volumetric fog sample for this ray
 * @returns fog transmittance and inscatter
 */
export const fogOver = tgpu.fn(
	[d.vec3f, d.f32, Froxels],
	Fog,
)((direction, distance, froxels) => {
	'use gpu';
	return fogOverWithPost(postUniformLayout.$.post, direction, distance, froxels);
});

/**
 * fogs a premultiplied transparent colour at camera-relative position `rel` and screen `uv`, using an
 * explicit `Post` uniform (e.g. from `meshDrawLayout.$.post`).
 *
 * @param post post uniforms struct
 * @param froxelTex 3D froxel volume
 * @param lutSampler bilinear clamping sampler
 * @param premultiplied premultiplied linear HDR colour
 * @param alpha coverage in `[0, 1]`
 * @param rel camera-relative surface position
 * @param uv screen UV in `[0, 1]^2`
 * @returns fogged premultiplied colour
 */
export const fogPremultiplied = tgpu.fn(
	[PostSchema, d.texture3d(d.f32), d.sampler(), d.vec3f, d.f32, d.vec3f, d.vec2f],
	d.vec3f,
)((post, froxelTex, lutSampler, premultiplied, alpha, rel, uv) => {
	'use gpu';
	const distance = std.length(rel);
	if (distance <= 0) {
		return d.vec3f(premultiplied);
	}
	const direction = std.div(rel, distance);
	const froxels = froxelsAtWithPost(post, froxelTex, lutSampler, uv, std.dot(rel, post.forward.xyz));
	const fog = fogOverWithPost(post, direction, distance, froxels);
	return std.add(std.mul(premultiplied, fog.transmittance), std.mul(fog.inscatter, alpha));
});
