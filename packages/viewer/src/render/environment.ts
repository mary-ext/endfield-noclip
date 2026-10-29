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
	FogConfig,
	HeightFogLayers,
	LightConfig,
	Quat,
	SkyConfig,
	Vec2,
	VignetteSettings,
} from '@endfield-noclip/package-format/format';

import type { Vec3 } from '../scene/camera.ts';

import { linearRgb, srgbToLinear } from './colour.ts';

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
	| 'rotationAtmosphere'
	| 'rotationHeightFogDirectionalInscattering'
>;

/** the parts of the game's sky config the viewer reads */
export type SkyInput = Pick<
	SkyConfig,
	'skyAmbientSH' | 'skyDirectIntensity' | 'reflectionMap' | 'skyDistance'
>;

/** the game's atmosphere config, Unreal's SkyAtmosphere parameters: kilometres and per-kilometre */
export type AtmosphereInput = Omit<AtmosphereConfig, 'outerSunIrradianceColor'>;

/** the game's distance fog (`HGFogConfig`), an analytic single-scattering fog it calls atmosphere fog */
export type FogInput = Pick<
	FogConfig,
	| 'enable'
	| 'startDistance'
	| 'startHeight'
	| 'fallOffHeight'
	| 'fallOffDistance'
	| 'mieScattering'
	| 'mieScatteringScale'
	| 'mieAnisotropy'
	| 'rayleighScattering'
	| 'rayleighScatteringScale'
	| 'inscatterAmbientColor'
>;

/**
 * the game's two-layer exponential height fog, Unreal's ExponentialHeightFog parameters. both
 * `HGHeightFogConfig` and `HGVolumetricFogConfig` carry a set
 */
export type HeightFogInput = Pick<
	HeightFogLayers,
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
	| 'heightFogStartTransition'
	| 'heightFogCutoffDistance'
	| 'heightFogCutoffTransition'
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
	| 'cloudAbsoluteBrightness'
	| 'brightnessAffectCloudAlpha'
	| 'cloudTextureMode'
	| 'cloudOpacityR'
	| 'cloudOpacityG'
	| 'cloudFadeAlpha'
	| 'rotation'
>;

/** what the viewer reads of an environment profile; extra fields are ignored */
export interface EnvironmentInput {
	name: string;
	light: LightInput;
	sky: SkyInput;
	atmosphere: AtmosphereInput;
	fog: FogInput;
	heightFog: HeightFogInput;
	/** the volumetric fog's own height-fog set, which the game uses while volumetric fog is on */
	volumetricFog: HeightFogInput;
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

/** one exponential fog layer in the game's base-2 units: optical depth `density · 2^(−falloff · (y − height))` */
export interface FogLayer {
	density: number;
	falloff: number;
	height: number;
}

/** the height fog as the game's shaders take it (`_ExponentialFogParams0..5`) */
export interface HeightFog {
	enabled: boolean;
	layers: [FogLayer, FogLayer];
	/** inscattered radiance, pre-exposed */
	inscatter: Vec3;
	maxOpacity: number;
	/** the fog fades in over `1 / transition` metres past the start distance */
	startDistance: number;
	startTransition: number;
	/** and fades out past the cutoff distance the same way */
	cutoffDistance: number;
	cutoffTransition: number;
	/** inscattered radiance towards the light below, pre-exposed */
	directional: Vec3;
	/** unit vector towards that light */
	directionalDirection: Vec3;
	directionalExponent: number;
	directionalStartDistance: number;
}

/**
 * the game's analytic atmosphere fog (`_AtmosphereFogParams0..5`, from `HGFogConfig`): single scattering in a
 * medium thinning exponentially with height. distances in kilometres
 */
export interface AtmosphereFog {
	/** unit vector towards the sun that lights it */
	sunDirection: Vec3;
	/** extinction per kilometre */
	extinction: Vec3;
	/** pre-exposed sun radiance scattered by Rayleigh and Mie, over the extinction */
	rayleigh: Vec3;
	mie: Vec3;
	mieAnisotropy: number;
	/** pre-exposed ambient radiance scattered, over the extinction */
	ambient: Vec3;
	/** kilometres of fog-free distance */
	startDistance: number;
	/** kilometres of fog per metre of distance */
	distanceScale: number;
	/** metres */
	fallOffHeight: number;
	startHeight: number;
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
	/** the atmosphere fog, or `null` when off */
	atmosphereFog: AtmosphereFog | null;
	fog: HeightFog;
	/** metres to the sky dome, for fogging the sky */
	skyDistance: number;
	post: PostLook;
	/** the panoramic cloud layer, or `null` without one */
	cloud: {
		texture: number;
		/** multiplies the texel (rgba) as the game's `_CloudTint` does; alpha blends it over the sky */
		tint: [r: number, g: number, b: number, a: number];
		contrast: number;
		/** texture mode 0: the R and G layers' opacities, and the colour taken from max(R, G) */
		opacity: Vec2;
		singleChannel: boolean;
		/** radians */
		rotation: number;
	} | null;
}

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

/** the height fog's density and falloff per profile unit, as the game packs them (its shaders use base 2) */
const FOG_UNIT = 0.1;

/**
 * @param q a Unity quaternion
 * @param v a vector
 * @returns `q · v`
 */
const rotate = ([x, y, z, w]: Readonly<Quat>, [vx, vy, vz]: Vec3): Vec3 => {
	// v + 2w(u × v) + 2u × (u × v), u = (x, y, z)
	const tx = 2 * (y * vz - z * vy);
	const ty = 2 * (z * vx - x * vz);
	const tz = 2 * (x * vy - y * vx);
	return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
};

/** @returns the unit vector towards a light whose rotation turns +Z into its direction of travel */
const towardsRotatedLight = (q: Readonly<Quat>): Vec3 => {
	const [x, y, z] = rotate(q, [0, 0, 1]);
	return [-x, -y, -z];
};

const IDENTITY: Quat = [0, 0, 0, 1];

/** a thin haze for packages without environment profiles */
const DEFAULT_HEIGHT_FOG: HeightFogInput = {
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
	heightFogStartTransition: 0.001,
	heightFogCutoffDistance: 100000,
	heightFogCutoffTransition: 0.001,
	heightFogDirectionalInscatteringExponent: 4,
	heightFogDirectionalInscatteringStartDistance: 0,
	heightFogDirectionalInscattering: [0, 0, 0, 1],
};

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
		rotationAtmosphere: IDENTITY,
		rotationHeightFogDirectionalInscattering: IDENTITY,
	},
	sky: {
		// a sky brighter overhead than at the horizon, and a darker ground
		skyAmbientSH: [
			0.36, 0.14, 0, 0, 0, 0, 0, 0, 0.0, 0.44, 0.2, 0, 0, 0, 0, 0, 0, 0.0, 0.5, 0.26, 0, 0, 0, 0, 0, 0, 0.0,
		],
		skyDirectIntensity: 1,
		reflectionMap: null,
		skyDistance: 5000,
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
	fog: {
		enable: false,
		startDistance: 0,
		startHeight: 0,
		fallOffHeight: 1000,
		fallOffDistance: 1,
		mieScattering: [0, 0, 0, 1],
		mieScatteringScale: 0,
		mieAnisotropy: 0,
		rayleighScattering: [0, 0, 0, 1],
		rayleighScatteringScale: 0,
		inscatterAmbientColor: [0, 0, 0, 1],
	},
	heightFog: DEFAULT_HEIGHT_FOG,
	volumetricFog: { ...DEFAULT_HEIGHT_FOG, enable: false },
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

/** @returns the vector of `f` over the three channels */
const map3 = (f: (i: number) => number): Vec3 => [f(0), f(1), f(2)];

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
	// HGSkyRenderer.SetupCloudParam: the raw tint (no sRGB decode) times the fade and the absolute brightness,
	// which reaches alpha only when asked to. `cloudBrightness` only counts with `lightAffectCloud`, which no
	// shipped base profile sets
	const [r, g, b, a] = cloud.cloudTint;
	const scale = cloud.cloudFadeAlpha * cloud.cloudAbsoluteBrightness;
	const alphaScale =
		cloud.cloudFadeAlpha * (cloud.brightnessAffectCloudAlpha ? cloud.cloudAbsoluteBrightness : 1);
	const singleChannel = cloud.cloudTextureMode === 0;
	return {
		texture: cloud.cloudTexture,
		tint: [r * scale, g * scale, b * scale, a * alphaScale],
		contrast: cloud.cloudContrast,
		opacity: singleChannel ? [cloud.cloudOpacityR, cloud.cloudOpacityG] : [1, 1],
		singleChannel,
		rotation: (cloud.rotation * Math.PI) / 180,
	};
};

/** HGAtmosphereRenderer.SetupShaderVariablesGlobalHeightFog, minus the flow noise */
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
	directionalDirection: towardsRotatedLight(light.rotationHeightFogDirectionalInscattering),
	directionalExponent: fog.heightFogDirectionalInscatteringExponent,
	directionalStartDistance: fog.heightFogDirectionalInscatteringStartDistance,
});

/** HGAtmosphereRenderer.SetupShaderVariablesGlobalAtmosphereFog */
const atmosphereFogLook = (source: EnvironmentInput, sunIntensity: number): AtmosphereFog | null => {
	const { fog, atmosphere, light } = source;
	if (!fog.enable) {
		return null;
	}
	// colours go in raw, as the game's C# multiplies them
	const sun = scaled(light.directColor, sunIntensity);
	const mie = scaled(fog.mieScattering, fog.mieScatteringScale);
	// a negative scale defers to the atmosphere's
	const rayleighScale =
		fog.rayleighScatteringScale >= 0 ? fog.rayleighScatteringScale : atmosphere.rayleighScatteringScale;
	const rayleigh = scaled(fog.rayleighScattering, rayleighScale);
	const absorption = scaled(atmosphere.mieAbsorption, atmosphere.mieAbsorptionScale);
	const extinction: Vec3 = map3((i) => mie[i] + rayleigh[i] + absorption[i]);
	const ambient = scaled(fog.inscatterAmbientColor, sunIntensity);
	const over = (c: Vec3, i: number): number => c[i] / Math.max(extinction[i], 1e-9);
	return {
		sunDirection: towardsRotatedLight(light.rotationAtmosphere),
		extinction,
		rayleigh: map3((i) => over(rayleigh, i) * sun[i]),
		mie: map3((i) => over(mie, i) * sun[i]),
		mieAnisotropy: fog.mieAnisotropy,
		ambient: map3((i) => (ambient[i] * (rayleigh[i] + mie[i])) / Math.max(extinction[i], 1e-9)),
		startDistance: fog.startDistance * 0.001,
		distanceScale: fog.fallOffDistance * 0.001,
		fallOffHeight: fog.fallOffHeight,
		startHeight: fog.startHeight,
	};
};

/**
 * @param profile the level's environment profile, or `null` for the defaults
 * @returns the renderer's view of it
 */
export const deriveEnvironment = (profile: EnvironmentInput | null): Environment => {
	const source = profile ?? DEFAULT_PROFILE;
	const { light, sky, atmosphere, heightFog, volumetricFog } = source;
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
		atmosphereFog: atmosphereFogLook(source, intensity),
		// with volumetric fog on (the PC path) the game reads the volumetric section's own height-fog set
		fog: {
			...heightFogLook(volumetricFog.enable ? volumetricFog : heightFog, light),
			enabled: heightFog.enable,
		},
		skyDistance: sky.skyDistance,
		post: postLook(source.post ?? DEFAULT_PROFILE.post),
		cloud: cloudLook(source.cloud),
	};
};

// #endregion
