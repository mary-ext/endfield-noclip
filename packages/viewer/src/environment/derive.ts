/**
 * derives the renderer's {@link Environment} from an environment profile, following the game's CPU packing
 * where it's known (docs/viewer/lighting.md)
 *
 * @module
 */

import type { LightConfig } from '@endfield-noclip/package-format/environment';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { linearRgb, rec709Luminance, srgbToLinear } from '../math/color.ts';
import { scale, vec3From } from '../math/vec3.ts';

import { gradingLook } from './color-grading.ts';
import { DEFAULT_POST, DEFAULT_PROFILE } from './default-profile.ts';
import type {
	AtmosphereFog,
	Environment,
	HeightFog,
	LightShaftLook,
	PostLook,
	VolumetricFog,
} from './environment.ts';
import { autoExposureLook } from './exposure.ts';
import type {
	AtmosphereInput,
	CloudInput,
	EnvironmentInput,
	HeightFogInput,
	LightInput,
	LightShaftInput,
	PostInput,
	SkyInput,
	VolumetricFogInput,
	WindInput,
} from './profile-input.ts';
import { effectPitchYaw, exposedSunIntensity, towardsEffectLight, towardsLight } from './sun.ts';

/**
 * converts a Unity `SphericalHarmonicsL2` (raw coefficients, channel-major) into the seven vectors Unity's
 * `ShadeSH9` evaluates: `c(n) = u0 + u1·y + u2·z + u3·x + u4·xy + u5·yz + u6·(3z² − 1) + u7·xz + u8·(x² −
 * y²)`
 *
 * @param sh 27 coefficients
 * @param factor multiplies every coefficient
 * @returns 28 floats
 */
const shaderSh = (sh: readonly number[], factor: number): Float32Array => {
	const out = new Float32Array(28);
	for (let c = 0; c < 3; c++) {
		const u = (i: number): number => (sh[c * 9 + i] ?? 0) * factor;
		out.set([u(3), u(1), u(2), u(0) - u(6)], c * 4);
		out.set([u(4), u(5), 3 * u(6), u(7)], (3 + c) * 4);
		out[24 + c] = u(8);
	}
	return out;
};

/** the height fog's density and falloff per profile unit, as the game packs them (its shaders use base 2) */
const FOG_UNIT = 0.1;

/**
 * what the game multiplies its sky-view LUT (radiance per unit sun illuminance) by
 * (docs/game-data/sky-and-fog.md#sky)
 *
 * @param light the light config
 * @param sky the sky config
 * @param atmosphere the atmosphere config
 * @returns the pre-exposed scale, linear rgb
 */
export const skyViewScale = (
	light: Pick<LightConfig, 'directLux' | 'directEV100'>,
	sky: Pick<SkyInput, 'proceduralSkyLuxFactor'>,
	atmosphere: Pick<AtmosphereInput, 'outerSunIrradianceColor'>,
): Vec3 => scale(atmosphere.outerSunIrradianceColor, exposedSunIntensity(light) * sky.proceduralSkyLuxFactor);

/** the game's march settings unless the volume opts into its own; the exponent always comes from the volume */
const AO_PRESET = { radius: 4, falloff: 1, distribution: 1, thin: 2 } as const;

const aoLook = (ao: NonNullable<PostInput['ambientOcclusion']>): NonNullable<PostLook['ao']> => {
	if (!ao.custom) {
		return { ...AO_PRESET, power: ao.finalValuePower };
	}
	return {
		radius: ao.radius * ao.radiusMultiplier,
		falloff: ao.falloffRange,
		distribution: ao.sampleDistributionPower,
		thin: ao.thinOccluderCompensation,
		power: ao.finalValuePower,
	};
};

/** the game's bloom packing (HDRP's, with a linear threshold as URP's) */
const bloomLook = (bloom: NonNullable<PostInput['bloom']>): NonNullable<PostLook['bloom']> => {
	const tint = linearRgb(bloom.tint);
	const luma = rec709Luminance(tint);
	return {
		threshold: srgbToLinear(bloom.thresholdHighQuality),
		intensity: 2 ** bloom.intensityHighQuality - 1,
		scatter: 0.05 + 0.9 * Math.min(Math.max(bloom.scatterHighQuality, 0), 1),
		tint: luma > 0 ? [tint[0] / luma, tint[1] / luma, tint[2] / luma] : [1, 1, 1],
		subtract: bloom.blendMode !== 0 ? 1 : 0,
		half: bloom.resolutionHighQuality < 3,
	};
};

const postLook = (post: PostInput): PostLook => {
	const { bloom, ambientOcclusion: ao, vignette, screenSpaceReflection: ssr } = post;
	return {
		bloom: bloom === null ? null : bloomLook(bloom),
		ao: ao === null || !ao.enable ? null : aoLook(ao),
		vignette:
			vignette === null
				? null
				: {
						color: linearRgb(vignette.color),
						center: vignette.center,
						intensity: vignette.intensity,
						smoothness: vignette.smoothness,
						roundness: vignette.roundness,
						rounded: vignette.rounded,
					},
		ssr:
			ssr === null || !ssr.enable
				? null
				: {
						onScreen: ssr.fadenessOnScreen,
						mirrorMul: ssr.fadenessOnMirrorMul,
						mirrorAdd: ssr.fadenessOnMirrorAdd,
					},
	};
};

/**
 * the cloud panorama as the game packs it (docs/game-data/sky-and-fog.md#sky)
 *
 * @param cloud the blended cloud section, or `null` for none
 * @param light the blended light section, for clouds lit by the sun
 * @param sky the blended sky section, for clouds lit by the sun
 * @returns the panorama to draw, or `null` without one
 */
export const cloudLook = (
	cloud: CloudInput | null,
	light: Pick<LightInput, 'directLux' | 'directEV100'>,
	sky: Pick<SkyInput, 'proceduralSkyLuxFactor'>,
): Environment['cloud'] => {
	if (cloud === null || !cloud.enable || cloud.cloudTexture === null) {
		return null;
	}
	// the raw tint (no sRGB decode) times the fade and a brightness, which reaches alpha only when asked to
	const [r, g, b, a] = cloud.cloudTint;
	const brightness = cloud.lightAffectCloud
		? (cloud.cloudBrightness + exposedSunIntensity(light) / Math.PI) * sky.proceduralSkyLuxFactor
		: cloud.cloudAbsoluteBrightness;
	const colorScale = cloud.cloudFadeAlpha * brightness;
	const alphaScale = cloud.cloudFadeAlpha * (cloud.brightnessAffectCloudAlpha ? brightness : 1);
	const singleChannel = cloud.cloudTextureMode === 0;
	return {
		texture: cloud.cloudTexture,
		tint: [r * colorScale, g * colorScale, b * colorScale, a * alphaScale],
		contrast: cloud.cloudContrast,
		opacity: singleChannel ? [cloud.cloudOpacityR, cloud.cloudOpacityG] : [1, 1],
		singleChannel,
		rotation: (cloud.rotation * Math.PI) / 180,
		afterPlanets: cloud.drawCloudAfterPlanet,
	};
};

/**
 * the cloud shadow as the game packs it, without the far-texture set
 * (docs/game-data/lighting.md#cloud-shadows)
 */
const cloudShadowLook = (cloud: CloudInput | null, light: LightInput): Environment['cloudShadow'] => {
	if (cloud === null || !cloud.enable || !cloud.enableCloudShadow) {
		return null;
	}
	const config = cloud.cloudShadowConfig;
	if (config.cloudShadowTexture === null) {
		return null;
	}
	// the light's direction of travel over |cos(pitch in degrees / 360)| taken in radians, as the game computes
	// it, so the factor stays within 1% of 1
	const pitchYaw = effectPitchYaw(light, 'cloudShadow');
	const factor = Math.min(Math.max(Math.abs(Math.cos(pitchYaw[0] / 360)), 0.001), 1);
	const [x, y, z] = towardsLight(pitchYaw).map((v) => -v);
	const [dx, dy] = config.cloudShadowFlowDirection;
	const speed = config.cloudShadowFlowSpeed;
	return {
		texture: config.cloudShadowTexture,
		center: config.cloudShadowEnvCenter,
		// coverage is the texture's span in kilometres
		scale: 0.001 / config.cloudShadowCoverage,
		flow: [(dx * speed) / 1000, (dy * speed) / 1000],
		alpha: config.cloudShadowAlpha,
		start: config.cloudShadowScaleStartDistance,
		width: config.cloudShadowScaleEndDistance,
		farScale: 1 / config.cloudShadowDistanceScale,
		projection: [x / factor, y / factor, z / factor],
	};
};

/** the height fog as the game packs it */
const heightFogLook = (fog: HeightFogInput, light: LightInput): HeightFog => ({
	enabled: fog.enable,
	layers: [
		{
			density: fog.heightFogDensity * FOG_UNIT,
			falloff: fog.heightFogFalloff * FOG_UNIT,
			height: fog.heightFogStartHeight,
		},
		{
			density: fog.heightFogDensitySecond * FOG_UNIT,
			falloff: fog.heightFogFalloffSecond * FOG_UNIT,
			height: fog.heightFogStartHeightSecond,
		},
	],
	inscatter: [fog.heightFogInscatter[0], fog.heightFogInscatter[1], fog.heightFogInscatter[2]],
	maxOpacity: fog.heightFogMaxOpacity,
	startDistance: fog.heightFogStartDistance,
	startTransition: fog.heightFogStartTransition,
	cutoffDistance: fog.heightFogCutoffDistance,
	cutoffTransition: fog.heightFogCutoffTransition,
	directional: [
		fog.heightFogDirectionalInscattering[0],
		fog.heightFogDirectionalInscattering[1],
		fog.heightFogDirectionalInscattering[2],
	],
	directionalDirection: towardsEffectLight(light, 'heightFogDirectionalInscattering'),
	directionalExponent: fog.heightFogDirectionalInscatteringExponent,
	directionalStartDistance: fog.heightFogDirectionalInscatteringStartDistance,
	flowNoise:
		fog.enableFlowNoise && fog.flowNoiseIntensity > 0
			? {
					velocity: [
						fog.flowNoiseDir[0] * fog.flowNoiseSpeed,
						fog.flowNoiseDir[1] * fog.flowNoiseSpeed,
						fog.flowNoiseDir[2] * fog.flowNoiseSpeed,
					],
					intensity: fog.flowNoiseIntensity,
					tiling: fog.flowNoiseTilling,
					distance: fog.flowNoiseDistance,
				}
			: null,
});

/** the volumetric fog as the game packs it, minus the flow noise and local fog volumes */
const volumetricFogLook = (
	fog: VolumetricFogInput,
	light: LightInput,
	sunIntensity: number,
): VolumetricFog => {
	const directional = sunIntensity * fog.volumetricFogDirectLightingScatteringIntensity;
	return {
		distance: fog.volumetricFogDistance,
		startDistance: fog.volumetricFogStartDistance,
		nearFadeIn: fog.volumetricFogNearFadeInDistance,
		anisotropy: fog.volumetricFogScatteringDistribution,
		albedo: [fog.volumetricFogAlbedo[0], fog.volumetricFogAlbedo[1], fog.volumetricFogAlbedo[2]],
		extinctionScale: fog.volumetricFogExtinctionScale,
		// the game stores the emission per kilometre
		emissive: scale(fog.volumetricFogEmissive, 0.001),
		sunDirection: towardsEffectLight(light, 'atmosphere'),
		// colours go in raw, as for the atmosphere fog
		sun: scale(light.directColor, directional),
		skyIntensity: fog.volumetricFogSkyLightingScatteringIntensity,
	};
};

/** the shafts radiate from the light shaft rotation's light, as in the game */
const lightShaftLook = (config: LightShaftInput, light: LightInput): LightShaftLook | null => {
	if (!config.enable) {
		return null;
	}
	return {
		sunDirection: towardsEffectLight(light, 'lightShaft'),
		bloomScale: config.bloomScale,
		threshold: config.bloomThreshold,
		maxBrightness: config.bloomMaxBrightness,
		tint: [config.bloomTint[0], config.bloomTint[1], config.bloomTint[2]],
		blurIntensity: config.blurIntensity,
		occlusionDepthRange: config.occlusionDepthRange,
	};
};

/** the atmosphere fog as the game packs it */
const atmosphereFogLook = (source: EnvironmentInput, sunIntensity: number): AtmosphereFog | null => {
	const { fog, atmosphere, light } = source;
	if (!fog.enable) {
		return null;
	}
	// colours go in raw, as the game's C# multiplies them
	const sun = scale(light.directColor, sunIntensity);
	const mie = scale(fog.mieScattering, fog.mieScatteringScale);
	// a negative scale defers to the atmosphere's
	const rayleighScale =
		fog.rayleighScatteringScale >= 0 ? fog.rayleighScatteringScale : atmosphere.rayleighScatteringScale;
	const rayleigh = scale(fog.rayleighScattering, rayleighScale);
	const absorption = scale(atmosphere.mieAbsorption, atmosphere.mieAbsorptionScale);
	const extinction: Vec3 = vec3From((i) => mie[i] + rayleigh[i] + absorption[i]);
	const ambient = scale(fog.inscatterAmbientColor, sunIntensity);
	const over = (c: Vec3, i: number): number => c[i] / Math.max(extinction[i], 1e-9);
	return {
		sunDirection: towardsEffectLight(light, 'atmosphere'),
		extinction,
		rayleigh: vec3From((i) => over(rayleigh, i) * sun[i]),
		mie: vec3From((i) => over(mie, i) * sun[i]),
		mieAnisotropy: fog.mieAnisotropy,
		ambient: vec3From((i) => (ambient[i] * (rayleigh[i] + mie[i])) / Math.max(extinction[i], 1e-9)),
		startDistance: fog.startDistance * 0.001,
		distanceScale: fog.fallOffDistance * 0.001,
		fallOffHeight: fog.fallOffHeight,
		startHeight: fog.startHeight,
	};
};

/** the main wind as the game sets its shader globals: a quarter of the speed, and the direction's X and Z */
const windLook = ({ speed, direction }: WindInput): Environment['wind'] => ({
	intensity: speed * 0.25,
	direction: [direction[0], direction[2]],
});

/**
 * @param profile the level's environment profile, or `null` for the defaults
 * @returns the renderer's view of it
 */
export const deriveEnvironment = (profile: EnvironmentInput | null): Environment => {
	const source = profile ?? DEFAULT_PROFILE;
	const { light, sky, atmosphere, heightFog, volumetricFog } = source;
	const intensity = exposedSunIntensity(light);
	const color = linearRgb(light.directColor);
	const sunIlluminance: Vec3 = [color[0] * intensity, color[1] * intensity, color[2] * intensity];
	const sunDirection = towardsLight(light.directPitchYaw);
	const skySunDirection = towardsEffectLight(light, 'atmosphere');
	return {
		name: profile === null ? null : source.name,
		sunDirection,
		sunIlluminance,
		sunRaw: scale(light.directColor, intensity),
		sunSpecular: light.directSpecularIntensity,
		shadow: {
			strength: source.shadow.csmIntensity,
			softness: source.shadow.csmShadowSoftness,
			override: source.shadow.disableCsmBlendFactor,
			attenuation: source.shadow.csmSimulatedAttenuation,
			ramp: source.shadow.csmRampTexture,
		},
		skySunDirection,
		skyIlluminance: skyViewScale(light, sky, atmosphere),
		sh: shaderSh(sky.skyAmbientSH, light.indirectDiffuseFactor),
		indirectSpecular: light.indirectSpecularFactor,
		reflection: sky.reflectionMap,
		atmosphere: {
			bottomRadius: atmosphere.groundRadius,
			topRadius: atmosphere.groundRadius + atmosphere.atmosphereHeight,
			groundAlbedo: [atmosphere.groundAlbedo[0], atmosphere.groundAlbedo[1], atmosphere.groundAlbedo[2]],
			multiScattering: atmosphere.multiScatteringFactor,
			rayleighScattering: scale(atmosphere.rayleighScattering, atmosphere.rayleighScatteringScale),
			rayleighDistribution: atmosphere.rayleighExponentialDistribution,
			mieScattering: scale(atmosphere.mieScattering, atmosphere.mieScatteringScale),
			mieAbsorption: scale(atmosphere.mieAbsorption, atmosphere.mieAbsorptionScale),
			mieAnisotropy: atmosphere.mieAnisotropy,
			mieDistribution: atmosphere.mieExponentialDistribution,
			ozoneAbsorption: scale(atmosphere.ozoneAbsorption, atmosphere.ozoneAbsorptionScale),
			ozoneTipAltitude: atmosphere.tentTipAltitude,
			ozoneTipValue: atmosphere.tentTipValue,
			ozoneWidth: atmosphere.tentWidth,
		},
		atmosphereFog: atmosphereFogLook(source, intensity),
		// with volumetric fog on (the PC path) the game reads the volumetric section's own height-fog set
		heightFog: {
			...heightFogLook(volumetricFog.enable ? volumetricFog : heightFog, light),
			enabled: heightFog.enable,
		},
		volumetricFog: volumetricFog.enable ? volumetricFogLook(volumetricFog, light, intensity) : null,
		skyDistance: sky.skyDistance,
		post: postLook(source.post ?? DEFAULT_POST),
		grading: gradingLook(source.colorGrading),
		cloud: cloudLook(source.cloud, light, sky),
		cloudShadow: cloudShadowLook(source.cloud, light),
		autoExposure: autoExposureLook(source.autoExposure),
		lightShaft: lightShaftLook(source.lightShaft, light),
		wind: windLook(source.wind),
	};
};
