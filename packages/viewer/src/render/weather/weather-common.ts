/**
 * shared TypeGPU schemas, bind group layouts, vertical-occlusion exposure test, and lighting helper for the
 * world-space weather shaders (far rain, rain splashes, near rain streaks, falling snow).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { defaultSurface, frameLayout } from '../core/frame-core.ts';
import {
	ambientIrradiance,
	localLighting,
	sampleReflection,
	sunVisibilityFar,
} from '../lighting/frame-lighting.ts';

/** 16-vec4 (256-byte) uniform block shared by world-space weather draws, bound with dynamic offsets */
export const WeatherParamsSchema = d.struct({
	occOrigin: d.vec4f,
	occMetrics: d.vec4f,
	color: d.vec4f,
	params0: d.vec4f,
	params1: d.vec4f,
	params2: d.vec4f,
	params3: d.vec4f,
	params4: d.vec4f,
	basis0: d.vec4f,
	basis1: d.vec4f,
	basis2: d.vec4f,
	pad0: d.vec4f,
	pad1: d.vec4f,
	pad2: d.vec4f,
	pad3: d.vec4f,
	pad4: d.vec4f,
});

/** byte size of one {@link WeatherParamsSchema} slot (256 bytes, matching dynamic uniform alignment) */
export const WEATHER_SLOT_BYTES = d.sizeOf(WeatherParamsSchema);

/** group 1 bind group layout for weather passes that sample volumetric fog and scene depth */
export const weatherFogDepthLayout = tgpu
	.bindGroupLayout({
		froxels: { texture: d.texture3d(d.f32) },
		lutSampler: { sampler: 'filtering' },
		sceneDepth: { texture: d.textureDepth2d() },
	})
	.$idx(1);

/** group 2 bind group layout for world-space weather draws (dynamic uniform offset on binding 0) */
export const weatherParamsLayout = tgpu
	.bindGroupLayout({
		weather: { uniform: WeatherParamsSchema },
		verticalOcclusion: { texture: d.textureDepth2d() },
		verticalOcclusionCompare: { sampler: 'comparison' },
		verticalOcclusionRaw: { sampler: 'non-filtering' },
		weatherTex: { texture: d.texture2d(d.f32) },
		weatherSampler: { sampler: 'filtering' },
	})
	.$idx(2);

/**
 * tests whether a camera-relative point is exposed to the sky in the vertical occlusion depth map.
 *
 * @param rel camera-relative position
 * @returns exposure factor in `[0, 1]` (`1` exposed, `0` sheltered)
 */
export const weatherExposed = tgpu.fn(
	[d.vec3f],
	d.f32,
)((rel) => {
	'use gpu';
	const weather = weatherParamsLayout.$.weather;
	const occUv = d.vec2f(
		0.5 + (rel.x - weather.occOrigin.x) * weather.occOrigin.w,
		0.5 - (rel.z - weather.occOrigin.z) * weather.occOrigin.w,
	);
	const occZ = (weather.occOrigin.y - rel.y) * weather.occMetrics.x;
	let exposed = d.f32(1);
	if (
		weather.occMetrics.w > 0.5 &&
		std.all(std.gt(occUv, d.vec2f(0))) &&
		std.all(std.lt(occUv, d.vec2f(1))) &&
		occZ > 0 &&
		occZ < 1
	) {
		exposed = std.textureSampleCompareLevel(
			weatherParamsLayout.$.verticalOcclusion,
			weatherParamsLayout.$.verticalOcclusionCompare,
			occUv,
			std.max(occZ, 0.00048828125),
		);
	}
	return exposed;
});

/**
 * evaluates diffuse irradiance, rough reflection, far-shadowed sun, and local lights for a weather particle.
 *
 * @param rel camera-relative particle position
 * @param n shading normal
 * @param v unit vector towards the camera
 * @param px pixel coordinates
 * @param albedo particle linear RGB colour
 * @returns lit linear RGB radiance
 */
export const weatherLitColor = tgpu.fn(
	[d.vec3f, d.vec3f, d.vec3f, d.vec2f, d.vec3f],
	d.vec3f,
)((rel, n, v, px, albedo) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const worldPos = std.add(frame.eye.xyz, rel);
	const irradiance = ambientIrradiance(worldPos, n);
	const r = std.reflect(std.neg(v), n);
	const refl = std.mul(sampleReflection(worldPos, n, r, 1, irradiance), frame.ambient.x * 0.015696);
	const nDotL = std.saturate(std.dot(n, frame.sun.xyz));
	const sunDirect = std.mul(
		std.mul(std.div(albedo, Math.PI), std.mul(frame.sunColor.xyz, nDotL * frame.sun.w)),
		sunVisibilityFar(rel, n),
	);
	const s = defaultSurface(albedo, n);
	s.roughness = 1;
	const localDirect = localLighting(s, v, rel, px, albedo, d.vec3f(0.04), 1);
	return std.add(std.add(std.add(std.mul(irradiance, albedo), refl), sunDirect), localDirect);
});
