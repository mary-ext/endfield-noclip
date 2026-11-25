/**
 * packs the `Post` uniforms of post-schema.ts. the environment's lanes are written when it changes and the
 * frame's over them each frame; the two writers own disjoint lanes, so the buffer can be uploaded whole after
 * the frame's
 *
 * @module
 */

import type { Environment } from '../../environment/environment.ts';
import { rowWriter } from '../../gfx/buffers.ts';
import type { Camera } from '../../scene/camera.ts';

import { PostSlot } from './post-schema.ts';
import { type PostSettings, TONEMAPPERS } from './settings.ts';

/**
 * writes the lanes that change only with the environment: the sun, atmosphere, fogs, bloom, AO shape,
 * vignette, cloud layer and grading. the frame's lanes ({@link writeFrameUniforms}) are left as they are,
 * which include `cloud.w` and `cloud_shape.w`
 *
 * @param out the `Post` uniforms, {@link POST_BYTES} long
 * @param environment the shown environment
 */
export const writeEnvironmentUniforms = (out: Float32Array, environment: Environment): void => {
	const set = rowWriter(out);
	const S = PostSlot;
	set(S.sun, [...environment.sunDirection, 1]);
	set(S.sunIlluminance, [...environment.sunIlluminance, 0]);
	set(S.skySun, [...environment.skySunDirection, 0]);
	set(S.skyIlluminance, [...environment.skyIlluminance, 0]);
	const a = environment.atmosphere;
	set(S.planet, [a.bottomRadius, a.topRadius, a.mieAnisotropy, a.multiScattering]);
	set(S.rayleigh, [...a.rayleighScattering, a.rayleighDistribution]);
	set(S.mieScattering, [...a.mieScattering, a.mieDistribution]);
	set(S.mieExtinction, [
		a.mieScattering[0] + a.mieAbsorption[0],
		a.mieScattering[1] + a.mieAbsorption[1],
		a.mieScattering[2] + a.mieAbsorption[2],
		0,
	]);
	set(S.ozone, [...a.ozoneAbsorption, a.ozoneTipAltitude]);
	set(S.ozoneTent, [a.ozoneTipValue, a.ozoneWidth, 0, 0]);
	set(S.groundAlbedo, [...a.groundAlbedo, 0]);
	const fog = environment.heightFog;
	set(S.fogLayer0, [fog.layers[0].density, fog.layers[0].falloff, fog.layers[0].height, 0]);
	set(S.fogLayer1, [fog.layers[1].density, fog.layers[1].falloff, fog.layers[1].height, 0]);
	set(S.fogColor, [...fog.inscatter, 1 - fog.maxOpacity]);
	set(S.fogRange, [fog.startDistance, fog.startTransition, fog.cutoffDistance, fog.cutoffTransition]);
	set(S.fogDirectional, [...fog.directional, fog.directionalExponent]);
	set(S.fogDirectionalDirection, [...fog.directionalDirection, fog.directionalStartDistance]);
	const atmo = environment.atmosphereFog;
	// without an atmosphere fog `sky_fog.y` turns it off, and its lanes keep what they held
	if (atmo !== null) {
		set(S.atmoSun, [...atmo.sunDirection, atmo.mieAnisotropy]);
		set(S.atmoExtinction, [...atmo.extinction, atmo.startDistance]);
		set(S.atmoRayleigh, [...atmo.rayleigh, atmo.distanceScale]);
		set(S.atmoMie, [...atmo.mie, 1 / atmo.fallOffHeight]);
		set(S.atmoAmbient, [...atmo.ambient, atmo.startHeight / atmo.fallOffHeight]);
	}
	set(S.skyFog, [environment.skyDistance, atmo !== null ? 1 : 0, 0, 0]);
	const { bloom, ao, vignette } = environment.post;
	{
		// the game's threshold packing: a knee of half the threshold
		const threshold = bloom?.threshold ?? 1;
		const knee = threshold * 0.5 + 1e-5;
		set(S.bloom, [threshold, threshold - knee, 2 * knee, 0.25 / knee]);
		set(S.bloomTint, [...(bloom?.tint ?? [1, 1, 1]), bloom?.intensity ?? 0]);
		set(S.bloomShape, [bloom?.subtract ?? 0, bloom?.scatter ?? 0, 0, 0]);
	}
	set(S.aoShape, [ao?.falloff ?? 1, ao?.distribution ?? 1, ao?.thin ?? 0, 0]);
	set(S.vignetteColor, [...(vignette?.color ?? [0, 0, 0]), vignette?.roundness ?? 1]);
	set(S.vignetteCenter, [...(vignette?.center ?? [0.5, 0.5]), vignette?.rounded ? 1 : 0, 0]);
	const cloud = environment.cloud;
	// xyz only: w is the frame's
	set(S.cloud, [cloud?.rotation ?? 0, cloud?.contrast ?? 1, cloud?.singleChannel ? 1 : 0]);
	set(S.cloudTint, cloud?.tint ?? [1, 1, 1, 1]);
	set(S.cloudShape, [cloud?.opacity[0] ?? 1, cloud?.opacity[1] ?? 1, cloud?.afterPlanets ? 1 : 0]);
	const g = environment.grading;
	set(S.colorBalance, [...g.colorBalance, g.postExposure]);
	set(S.colorFilter, [...g.colorFilter, 0]);
	set(S.hueSatCon, [g.hueShift, g.saturation, g.contrast, 0]);
	set(S.mixerRed, [...g.channelMixer[0], 0]);
	set(S.mixerGreen, [...g.channelMixer[1], 0]);
	set(S.mixerBlue, [...g.channelMixer[2], 0]);
	set(S.shadows, [...g.shadows, 0]);
	set(S.midtones, [...g.midtones, 0]);
	set(S.highlights, [...g.highlights, 0]);
	set(S.shaHiLimits, g.limits);
	set(S.lift, [...g.lift, 0]);
	set(S.gamma, [...g.gamma, 0]);
	set(S.gain, [...g.gain, 0]);
	set(S.splitShadows, [...g.splitShadows, g.splitBalance]);
	set(S.splitHighlights, [...g.splitHighlights, 0]);
};

/** what a frame's lanes of `Post` come from */
export interface FrameUniformsInput {
	/** the camera, unjittered */
	camera: Camera;
	/** the render size, px */
	width: number;
	height: number;
	/** the viewer's animation time, s, which the flow noise, water and clouds move by */
	time: number;
	frame: number;
	/** the main pass's subpixel jitter, NDC */
	jitter: readonly [x: number, y: number];
	/** the settings in effect */
	settings: PostSettings;
	/** the linear exposure the tonemap multiplies by */
	exposure: number;
	environment: Environment;
	/** the volumetric fog's sampling, or `null` when it wasn't encoded this frame */
	froxels: { slices: readonly number[]; start: number } | null;
	/** the height fog's flow noise, or `null` when the fog doesn't drift */
	flowNoise: Environment['heightFog']['flowNoise'];
	/** whether the cloud panorama is bound */
	cloud: boolean;
}

/**
 * writes the lanes that change from frame to frame: the camera, viewport and jitter, the toggles, AO
 * strength, exposure and vignette strength, the volumetric fog's sampling, the flow noise's scroll, and
 * `cloud.w` and `cloud_shape.w`. the environment's lanes ({@link writeEnvironmentUniforms}) are left as they
 * are
 *
 * @param out the `Post` uniforms, {@link POST_BYTES} long
 * @param input the frame
 */
export const writeFrameUniforms = (out: Float32Array, input: FrameUniformsInput): void => {
	const { camera, width, height, time, settings, environment, flowNoise } = input;
	const set = rowWriter(out);
	const S = PostSlot;
	const { forward, right, up } = camera.viewBasis(width / height);
	set(S.forward, [...forward, camera.near]);
	set(S.right, [...right, camera.pixelFactor(height)]);
	set(S.up, [...up, time]);
	set(S.eye, [...camera.position, input.frame % 1024]);
	set(S.viewport, [width, height, 1 / width, 1 / height]);
	set(S.jitter, [...input.jitter, settings.sharpen, 0]);
	const { bloom, ao, vignette } = environment.post;
	set(S.ao, [ao?.radius ?? 1, 1, ao?.power ?? 1, settings.ao && ao !== null ? 1 : 0]);
	set(S.grade, [
		input.exposure,
		settings.vignette && vignette !== null ? vignette.intensity : 0,
		vignette?.smoothness ?? 0,
		TONEMAPPERS.indexOf(settings.tonemapper),
	]);
	new Uint32Array(out.buffer, out.byteOffset + S.flags * 16, 4).set([
		settings.sky ? 1 : 0,
		settings.heightFog && environment.heightFog.enabled ? 1 : 0,
		settings.atmosphereFog ? 1 : 0,
		settings.bloom && bloom !== null ? 1 : 0,
	]);
	set(S.froxelSlices, input.froxels?.slices ?? [0, 0, 0, 0]);
	set(S.froxelRange, [input.froxels?.start ?? 0, 0, 0, 0]);
	set(S.reflections, [settings.reflections ? 1 : 0, 0, 0, 0]);
	set(
		S.flowNoise,
		flowNoise === null ? [0, 0, 0, 0] : [...flowNoise.velocity.map((v) => v * time), flowNoise.intensity],
	);
	set(S.flowNoiseScale, [flowNoise?.tiling ?? 0, flowNoise === null ? 0 : 1 / flowNoise.distance, 0, 0]);
	out[S.cloud * 4 + 3] = environment.cloud !== null && input.cloud ? 1 : 0;
	out[S.cloudShape * 4 + 3] = settings.debugView === 'clouds' ? 1 : 0;
};
