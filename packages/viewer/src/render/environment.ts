/**
 * a level's environment as the renderer uses it: the sun, the ambient probe, the atmosphere, fog and post
 * settings, derived from the game's environment profile (its `HGEnvironmentPhase` sections, which keep the
 * game's field names) or from defaults when a package has none.
 *
 * the game lights in physical units with a fixed exposure: `preExposure = 1 / (1.2 · 2^EV100)` and the sun's
 * pre-exposed illuminance is `directLux · preExposure`. the ambient probe is stored pre-exposed. so shading
 * happens in pre-exposed units and the tonemapper sees values around 0–2.
 *
 * @module
 */

import type {
	AmbientOcclusionSettings,
	AtmosphereConfig,
	BloomSettings,
	CloudConfig,
	Color,
	HeightFogConfig,
	LightConfig,
	SkyConfig,
	Vec2,
	VignetteSettings,
} from '@endfield-noclip/package-format/format';

import type { Vec3 } from '../scene/camera.ts';

// #region profile input

/** the parts of the game's light config the viewer reads */
export type LightInput = Pick<
	LightConfig,
	| 'directColor'
	| 'directLux'
	| 'directEV100'
	| 'directSpecularIntensity'
	| 'directPitchYaw'
	| 'indirectDiffuseFactor'
	| 'indirectSpecularFactor'
	| 'atmospherePitchYawMode'
	| 'atmospherePitchYaw'
>;

/** the parts of the game's sky config the viewer reads */
export type SkyInput = Pick<SkyConfig, 'skyAmbientSH' | 'skyDirectIntensity' | 'reflectionMap'>;

/** the game's atmosphere config, Unreal's SkyAtmosphere parameters: kilometres and per-kilometre */
export type AtmosphereInput = Omit<AtmosphereConfig, 'outerSunIrradianceColor'>;

/** the game's two-layer exponential height fog, Unreal's ExponentialHeightFog parameters */
export type HeightFogInput = Pick<
	HeightFogConfig,
	| 'enable'
	| 'heightFogStartHeight'
	| 'heightFogDensity'
	| 'heightFogFalloff'
	| 'heightFogStartHeightSecond'
	| 'heightFogDensitySecond'
	| 'heightFogFalloffSecond'
	| 'heightFogInscatter'
	| 'heightFogMaxOpacity'
	| 'heightFogStartDistance'
	| 'heightFogCutoffDistance'
	| 'heightFogDirectionalInscatteringExponent'
	| 'heightFogDirectionalInscatteringStartDistance'
	| 'heightFogDirectionalInscattering'
>;

/** the parts of the game's post volume the viewer reads (URP-style bloom and vignette, XeGTAO's settings) */
export interface PostInput {
	bloom: Pick<
		BloomSettings,
		'thresholdHighQuality' | 'intensityHighQuality' | 'scatterHighQuality' | 'tint'
	> | null;
	ambientOcclusion: Pick<
		AmbientOcclusionSettings,
		'enable' | 'radius' | 'radiusMultiplier' | 'falloffRange' | 'sampleDistributionPower' | 'finalValuePower'
	> | null;
	vignette: Pick<
		VignetteSettings,
		'color' | 'center' | 'intensity' | 'smoothness' | 'roundness' | 'rounded'
	> | null;
}

/** the game's panoramic cloud layer */
export type CloudInput = Pick<
	CloudConfig,
	| 'enable'
	| 'cloudTexture'
	| 'cloudTint'
	| 'cloudContrast'
	| 'cloudBrightness'
	| 'cloudAbsoluteBrightness'
	| 'cloudTextureMode'
	| 'cloudOpacityR'
	| 'cloudOpacityG'
	| 'rotation'
>;

/** what the viewer reads of an environment profile; extra fields are ignored */
export interface EnvironmentInput {
	name: string;
	light: LightInput;
	sky: SkyInput;
	atmosphere: AtmosphereInput;
	heightFog: HeightFogInput;
	cloud: CloudInput | null;
	post: PostInput | null;
}

// #endregion

// #region derived environment

/** the atmosphere in the units the sky shaders use (kilometres) */
export interface Atmosphere {
	bottomRadius: number;
	topRadius: number;
	groundAlbedo: Vec3;
	multiScattering: number;
	rayleighScattering: Vec3;
	rayleighDistribution: number;
	mieScattering: Vec3;
	mieAbsorption: Vec3;
	mieAnisotropy: number;
	mieDistribution: number;
	ozoneAbsorption: Vec3;
	ozoneTipAltitude: number;
	ozoneTipValue: number;
	ozoneWidth: number;
}

/** one exponential fog layer, per metre */
export interface FogLayer {
	/** extinction at `height`, per metre */
	density: number;
	/** per metre */
	falloff: number;
	height: number;
}

/** the height fog in shader units */
export interface HeightFog {
	enabled: boolean;
	layers: [FogLayer, FogLayer];
	/** multiplies the ambient probe's upward radiance */
	inscatter: Vec3;
	maxOpacity: number;
	startDistance: number;
	cutoffDistance: number;
	directional: Vec3;
	directionalExponent: number;
	directionalStartDistance: number;
}

/** post-processing in shader units; `null` sections are off */
export interface PostLook {
	bloom: { threshold: number; intensity: number; scatter: number; tint: Vec3 } | null;
	ao: { radius: number; falloff: number; distribution: number; power: number } | null;
	vignette: {
		colour: Vec3;
		centre: Vec2;
		intensity: number;
		smoothness: number;
		roundness: number;
		rounded: boolean;
	} | null;
}

/** everything the renderer needs of a level's look */
export interface Environment {
	/** the profile's name, or `null` for the defaults */
	name: string | null;
	/** unit vector towards the sun */
	sunDirection: Vec3;
	/** the exposure light is pre-multiplied by: `1 / (1.2 · 2^EV100)` */
	preExposure: number;
	/** pre-exposed illuminance, linear rgb */
	sunIlluminance: Vec3;
	sunSpecular: number;
	/** unit vector towards the sun the sky is lit by (art direction can move it away from the light's) */
	skySunDirection: Vec3;
	/** the sky's sun illuminance, pre-exposed */
	skyIlluminance: Vec3;
	/** Unity shader form of the ambient probe (SHAr, SHAg, SHAb, SHBr, SHBg, SHBb, SHC), 28 floats */
	sh: Float32Array;
	indirectSpecular: number;
	/** texture-table id of the sky reflection cubemap, or `null` */
	reflection: number | null;
	atmosphere: Atmosphere;
	fog: HeightFog;
	post: PostLook;
	/** the panoramic cloud layer, or `null` without one */
	cloud: {
		texture: number;
		tint: Vec3;
		contrast: number;
		brightness: number;
		absoluteBrightness: number;
		opacity: Vec2;
		mode: number;
		/** radians */
		rotation: number;
	} | null;
}

/**
 * converts a sRGB-encoded colour channel (Unity colour fields) to linear
 *
 * @param c channel value
 * @returns the linear value
 */
export const srgbToLinear = (c: number): number => {
	if (c <= 0.04045) {
		return c / 12.92;
	}
	// HDR values: like Unity's `Mathf.GammaToLinearSpace`, a plain 2.2 power past 1
	return c < 1 ? ((c + 0.055) / 1.055) ** 2.4 : c ** 2.2;
};

/**
 * @param c a sRGB-encoded colour (alpha ignored)
 * @returns its linear rgb
 */
export const linearRgb = (c: Readonly<Color>): Vec3 => [
	srgbToLinear(c[0]),
	srgbToLinear(c[1]),
	srgbToLinear(c[2]),
];

/**
 * @param pitchYaw degrees: pitch below the horizon the light travels at, yaw from +Z towards +X
 * @returns the unit vector pointing back at the light
 */
export const towardsLight = ([pitch, yaw]: Vec2): Vec3 => {
	const p = (pitch * Math.PI) / 180;
	const y = (yaw * Math.PI) / 180;
	// the light travels along (cos p sin y, -sin p, cos p cos y)
	return [-Math.cos(p) * Math.sin(y), Math.sin(p), -Math.cos(p) * Math.cos(y)];
};

/**
 * converts a Unity `SphericalHarmonicsL2` (raw coefficients, channel-major) into the seven vectors Unity's
 * `ShadeSH9` evaluates: `c(n) = u0 + u1·y + u2·z + u3·x + u4·xy + u5·yz + u6·(3z² − 1) + u7·xz + u8·(x² −
 * y²)`
 *
 * @param sh 27 coefficients
 * @param scale multiplies every coefficient
 * @returns 28 floats
 */
export const shaderSh = (sh: readonly number[], scale: number): Float32Array => {
	const out = new Float32Array(28);
	for (let c = 0; c < 3; c++) {
		const u = (i: number): number => (sh[c * 9 + i] ?? 0) * scale;
		out.set([u(3), u(1), u(2), u(0) - u(6)], c * 4);
		out.set([u(4), u(5), 3 * u(6), u(7)], (3 + c) * 4);
		out[24 + c] = u(8);
	}
	return out;
};

/**
 * @param sh the ambient probe in shader form, from {@link shaderSh}
 * @param n a unit direction
 * @returns what `ShadeSH9` gives for it: irradiance over π, clamped at 0
 */
export const evaluateSh = (sh: Float32Array, [x, y, z]: Vec3): Vec3 => {
	const out: Vec3 = [0, 0, 0];
	for (let c = 0; c < 3; c++) {
		const a = c * 4;
		const b = (3 + c) * 4;
		const value =
			sh[a] * x +
			sh[a + 1] * y +
			sh[a + 2] * z +
			sh[a + 3] +
			sh[b] * x * y +
			sh[b + 1] * y * z +
			sh[b + 2] * z * z +
			sh[b + 3] * z * x +
			sh[24 + c] * (x * x - y * y);
		out[c] = Math.max(0, value);
	}
	return out;
};

/**
 * the height fog's density and falloff per metre per profile unit. matched against in-game shots: Yinglung
 * Pass's falloff of 1.6 has to leave fog hundreds of metres deep in its chasm, which Unreal's ×0.1 doesn't
 */
const FOG_UNIT = 0.01;

/** the default look: a clear late-afternoon sky, for packages without environment profiles */
const DEFAULT_PROFILE: EnvironmentInput = {
	name: 'default',
	light: {
		directColor: [1, 0.97, 0.92, 1],
		directLux: 60000,
		directEV100: 13,
		directSpecularIntensity: 1,
		directPitchYaw: [38, 35],
		indirectDiffuseFactor: 1,
		indirectSpecularFactor: 1,
		atmospherePitchYawMode: 0,
		atmospherePitchYaw: [38, 35],
	},
	sky: {
		// a sky brighter overhead than at the horizon, and a darker ground
		skyAmbientSH: [
			0.36, 0.14, 0, 0, 0, 0, 0, 0, 0.0, 0.44, 0.2, 0, 0, 0, 0, 0, 0, 0.0, 0.5, 0.26, 0, 0, 0, 0, 0, 0, 0.0,
		],
		skyDirectIntensity: 1,
		reflectionMap: null,
	},
	atmosphere: {
		groundRadius: 6360,
		groundAlbedo: [0, 0, 0, 1],
		atmosphereHeight: 60,
		multiScatteringFactor: 1,
		rayleighScatteringScale: 0.0331,
		rayleighScattering: [0.175287, 0.409607, 1, 1],
		rayleighExponentialDistribution: 8,
		mieScatteringScale: 0.003996,
		mieScattering: [1, 1, 1, 1],
		mieAbsorptionScale: 0.000444,
		mieAbsorption: [1, 1, 1, 1],
		mieAnisotropy: 0.8,
		mieExponentialDistribution: 1.2,
		ozoneAbsorptionScale: 0.001881,
		ozoneAbsorption: [0.345561, 1, 0.045189, 1],
		tentTipAltitude: 25,
		tentTipValue: 1,
		tentWidth: 15,
	},
	heightFog: {
		enable: true,
		heightFogStartHeight: 0,
		heightFogDensity: 0.02,
		heightFogFalloff: 0.2,
		heightFogStartHeightSecond: 0,
		heightFogDensitySecond: 0,
		heightFogFalloffSecond: 0.2,
		heightFogInscatter: [0.6, 0.75, 1, 1],
		heightFogMaxOpacity: 1,
		heightFogStartDistance: 0,
		heightFogCutoffDistance: 0,
		heightFogDirectionalInscatteringExponent: 4,
		heightFogDirectionalInscatteringStartDistance: 0,
		heightFogDirectionalInscattering: [0, 0, 0, 1],
	},
	cloud: null,
	post: {
		bloom: {
			thresholdHighQuality: 0.95,
			intensityHighQuality: 0.5,
			scatterHighQuality: 0.4,
			tint: [1, 1, 1, 1],
		},
		ambientOcclusion: {
			enable: true,
			radius: 5,
			radiusMultiplier: 1,
			falloffRange: 0.8,
			sampleDistributionPower: 2,
			finalValuePower: 2,
		},
		vignette: {
			color: [0, 0, 0, 1],
			center: [0.5, 0.5],
			intensity: 0.3,
			smoothness: 0.2,
			roundness: 1,
			rounded: false,
		},
	},
};

const scaled = (c: Color, scale: number): Vec3 => [c[0] * scale, c[1] * scale, c[2] * scale];

const postLook = (post: PostInput | null): PostLook => {
	const bloom = post?.bloom ?? null;
	const ao = post?.ambientOcclusion ?? null;
	const vignette = post?.vignette ?? null;
	return {
		bloom:
			bloom === null
				? null
				: {
						// URP converts its gamma-space threshold to linear
						threshold: srgbToLinear(bloom.thresholdHighQuality),
						intensity: bloom.intensityHighQuality,
						scatter: bloom.scatterHighQuality,
						tint: linearRgb(bloom.tint),
					},
		ao:
			ao === null || !ao.enable
				? null
				: {
						radius: ao.radius * ao.radiusMultiplier,
						falloff: ao.falloffRange,
						distribution: ao.sampleDistributionPower,
						power: ao.finalValuePower,
					},
		vignette:
			vignette === null
				? null
				: {
						colour: linearRgb(vignette.color),
						centre: vignette.center,
						intensity: vignette.intensity,
						smoothness: vignette.smoothness,
						roundness: vignette.roundness,
						rounded: vignette.rounded,
					},
	};
};

const cloudLook = (cloud: CloudInput | null): Environment['cloud'] => {
	if (cloud === null || !cloud.enable || cloud.cloudTexture === null) {
		return null;
	}
	return {
		texture: cloud.cloudTexture,
		tint: linearRgb(cloud.cloudTint),
		contrast: cloud.cloudContrast,
		brightness: cloud.cloudBrightness,
		absoluteBrightness: cloud.cloudAbsoluteBrightness,
		opacity: [cloud.cloudOpacityR, cloud.cloudOpacityG],
		mode: cloud.cloudTextureMode,
		rotation: (cloud.rotation * Math.PI) / 180,
	};
};

/**
 * @param profile the level's environment profile, or `null` for the defaults
 * @returns the renderer's view of it
 */
export const deriveEnvironment = (profile: EnvironmentInput | null): Environment => {
	const source = profile ?? DEFAULT_PROFILE;
	const { light, sky, atmosphere, heightFog } = source;
	const preExposure = 1 / (1.2 * 2 ** light.directEV100);
	const intensity = light.directLux * preExposure;
	const colour = linearRgb(light.directColor);
	const sunIlluminance: Vec3 = [colour[0] * intensity, colour[1] * intensity, colour[2] * intensity];
	const sunDirection = towardsLight(light.directPitchYaw);
	const skySunDirection =
		light.atmospherePitchYawMode === 1 ? towardsLight(light.atmospherePitchYaw) : sunDirection;
	const skyScale = intensity * sky.skyDirectIntensity;
	return {
		name: profile === null ? null : source.name,
		preExposure,
		sunDirection,
		sunIlluminance,
		sunSpecular: light.directSpecularIntensity,
		skySunDirection,
		skyIlluminance: [skyScale, skyScale, skyScale],
		sh: shaderSh(sky.skyAmbientSH, light.indirectDiffuseFactor),
		indirectSpecular: light.indirectSpecularFactor,
		reflection: sky.reflectionMap,
		atmosphere: {
			bottomRadius: atmosphere.groundRadius,
			topRadius: atmosphere.groundRadius + atmosphere.atmosphereHeight,
			groundAlbedo: [atmosphere.groundAlbedo[0], atmosphere.groundAlbedo[1], atmosphere.groundAlbedo[2]],
			multiScattering: atmosphere.multiScatteringFactor,
			rayleighScattering: scaled(atmosphere.rayleighScattering, atmosphere.rayleighScatteringScale),
			rayleighDistribution: atmosphere.rayleighExponentialDistribution,
			mieScattering: scaled(atmosphere.mieScattering, atmosphere.mieScatteringScale),
			mieAbsorption: scaled(atmosphere.mieAbsorption, atmosphere.mieAbsorptionScale),
			mieAnisotropy: atmosphere.mieAnisotropy,
			mieDistribution: atmosphere.mieExponentialDistribution,
			ozoneAbsorption: scaled(atmosphere.ozoneAbsorption, atmosphere.ozoneAbsorptionScale),
			ozoneTipAltitude: atmosphere.tentTipAltitude,
			ozoneTipValue: atmosphere.tentTipValue,
			ozoneWidth: atmosphere.tentWidth,
		},
		fog: {
			enabled: heightFog.enable,
			layers: [
				{
					density: heightFog.heightFogDensity * FOG_UNIT,
					falloff: heightFog.heightFogFalloff * FOG_UNIT,
					height: heightFog.heightFogStartHeight,
				},
				{
					density: heightFog.heightFogDensitySecond * FOG_UNIT,
					falloff: heightFog.heightFogFalloffSecond * FOG_UNIT,
					height: heightFog.heightFogStartHeightSecond,
				},
			],
			inscatter: [
				heightFog.heightFogInscatter[0],
				heightFog.heightFogInscatter[1],
				heightFog.heightFogInscatter[2],
			],
			maxOpacity: heightFog.heightFogMaxOpacity,
			startDistance: heightFog.heightFogStartDistance,
			cutoffDistance: heightFog.heightFogCutoffDistance,
			directional: linearRgb(heightFog.heightFogDirectionalInscattering),
			directionalExponent: heightFog.heightFogDirectionalInscatteringExponent,
			directionalStartDistance: heightFog.heightFogDirectionalInscatteringStartDistance,
		},
		post: postLook(source.post ?? DEFAULT_PROFILE.post),
		cloud: cloudLook(source.cloud),
	};
};

// #endregion
