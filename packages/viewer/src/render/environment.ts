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
	FogConfig,
	HeightFogLayers,
	LightConfig,
	LightShaftConfig,
	ScreenSpaceReflectionSettings,
	ShadowConfig,
	SkyConfig,
	VignetteSettings,
} from '@endfield-noclip/package-format/environment';
import type { Color, Quat, Vec2 } from '@endfield-noclip/package-format/values';

import type { Vec3 } from '../scene/camera.ts';

import { type ColorGradingInput, type Grading, NEUTRAL_GRADING, gradingLook } from './color-grading.ts';
import { linearRgb, srgbToLinear } from './color.ts';
import { type AutoExposureInput, type AutoExposureSettings, autoExposureLook } from './exposure.ts';

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
	| 'cloudShadowPitchYawMode'
	| 'cloudShadowPitchYaw'
	| 'rotationAtmosphere'
	| 'rotationCloudShadow'
	| 'rotationHeightFogDirectionalInscattering'
	| 'rotationLightShaft'
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
	| 'enableFlowNoise'
	| 'flowNoiseIntensity'
	| 'flowNoiseDistance'
	| 'flowNoiseTilling'
	| 'flowNoiseDir'
	| 'flowNoiseSpeed'
>;

/** `HGVolumetricFogConfig`: its height-fog set plus the volumetric fog's own parameters */
export type VolumetricFogInput = HeightFogInput &
	Pick<
		HeightFogLayers,
		| 'volumetricFogScatteringDistribution'
		| 'volumetricFogAlbedo'
		| 'volumetricFogEmissive'
		| 'volumetricFogExtinctionScale'
		| 'volumetricFogDistance'
		| 'volumetricFogStartDistance'
		| 'volumetricFogNearFadeInDistance'
		| 'volumetricFogDirectLightingScatteringIntensity'
		| 'volumetricFogSkyLightingScatteringIntensity'
	>;

/**
 * the parts of the game's post volume the viewer reads (HDRP-style bloom, URP-style vignette, XeGTAO's
 * settings)
 */
export interface PostInput {
	bloom: Pick<
		BloomSettings,
		| 'resolutionHighQuality'
		| 'thresholdHighQuality'
		| 'intensityHighQuality'
		| 'scatterHighQuality'
		| 'tint'
		| 'blendMode'
	> | null;
	ambientOcclusion: Pick<
		AmbientOcclusionSettings,
		| 'enable'
		| 'custom'
		| 'radius'
		| 'radiusMultiplier'
		| 'falloffRange'
		| 'sampleDistributionPower'
		| 'thinOccluderCompensation'
		| 'finalValuePower'
	> | null;
	vignette: Pick<
		VignetteSettings,
		'color' | 'center' | 'intensity' | 'smoothness' | 'roundness' | 'rounded'
	> | null;
	screenSpaceReflection: Pick<
		ScreenSpaceReflectionSettings,
		'enable' | 'fadenessOnScreen' | 'fadenessOnMirrorMul' | 'fadenessOnMirrorAdd'
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
	| 'drawCloudAfterPlanet'
	| 'cloudTextureMode'
	| 'cloudOpacityR'
	| 'cloudOpacityG'
	| 'cloudFadeAlpha'
	| 'rotation'
	| 'enableCloudShadow'
	| 'cloudShadowConfig'
>;

/** the parts of the game's shadow config the viewer reads */
export type ShadowInput = Pick<
	ShadowConfig,
	| 'csmIntensity'
	| 'csmRampTexture'
	| 'csmShadowSoftness'
	| 'disableCsmBlendFactor'
	| 'csmSimulatedAttenuation'
>;

/** the parts of the game's light shaft config the viewer reads */
export type LightShaftInput = Pick<
	LightShaftConfig,
	| 'enable'
	| 'bloomScale'
	| 'bloomThreshold'
	| 'bloomMaxBrightness'
	| 'bloomTint'
	| 'blurIntensity'
	| 'occlusionDepthRange'
>;

/** what the viewer reads of an environment profile; extra fields are ignored */
export interface EnvironmentInput {
	name: string;
	light: LightInput;
	shadow: ShadowInput;
	sky: SkyInput;
	atmosphere: AtmosphereInput;
	fog: FogInput;
	heightFog: HeightFogInput;
	/** the volumetric fog, and its own height-fog set, which the game uses while volumetric fog is on */
	volumetricFog: VolumetricFogInput;
	cloud: CloudInput | null;
	colorGrading: ColorGradingInput;
	autoExposure: AutoExposureInput;
	lightShaft: LightShaftInput;
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
	/** drifting noise in how much fog surfaces get, or `null` when it's off */
	flowNoise: FlowNoise | null;
}

/**
 * the height fog's flow noise (`_HeightFogFlowNoiseParams0..1`): a scrolling 3D noise that scales how much of
 * the fog a surface gets, fading out with distance
 */
export interface FlowNoise {
	/** how far the noise scrolls per second, in texture repeats */
	velocity: Vec3;
	/** how strongly the noise sways the fog at the camera */
	intensity: number;
	/** texture repeats per metre */
	tiling: number;
	/** metres at which the noise has faded out */
	distance: number;
}

/**
 * the game's volumetric fog: the height fog's layers as a participating medium, lit by the sun (shadowed),
 * the ambient probe and its own emission, between `startDistance` and `distance` metres of view depth. the
 * analytic height fog covers only what lies beyond `distance`
 */
export interface VolumetricFog {
	/** view depth (m) where the froxels end and the analytic fog takes over */
	distance: number;
	/** view depth (m) nearer than which there is no fog at all */
	startDistance: number;
	/** metres over which the volumetric fog fades in from its first slice */
	nearFadeIn: number;
	/** Henyey-Greenstein anisotropy */
	anisotropy: number;
	albedo: Vec3;
	/** multiplies the height fog's density */
	extinctionScale: number;
	/** radiance added per metre, pre-exposed */
	emissive: Vec3;
	/** unit vector towards the sun that lights it */
	sunDirection: Vec3;
	/** pre-exposed sun radiance it scatters, times the direct lighting intensity */
	sun: Vec3;
	/** multiplies the ambient probe it scatters */
	skyIntensity: number;
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
	bloom: {
		/** linear */
		threshold: number;
		/** how far the composite moves towards the bloomed colour, `2^intensity − 1` */
		intensity: number;
		/** each upsample's blend towards the coarser level */
		scatter: number;
		/** linear, normalised to luminance 1 */
		tint: Vec3;
		/** 1 when the composite takes the thresholded part out of the scene (blend modes other than add) */
		subtract: number;
		/** `BloomResolution.Half`, which gives the chain one more level than quarter resolution */
		half: boolean;
	} | null;
	ao: { radius: number; falloff: number; distribution: number; thin: number; power: number } | null;
	vignette: {
		color: Vec3;
		center: Vec2;
		intensity: number;
		smoothness: number;
		roundness: number;
		rounded: boolean;
	} | null;
	/** the screen-space reflections' fades (`ScreenSpaceReflectionVolume`) */
	ssr: {
		/** the uv distance from the screen's edge over which hits fade in */
		onScreen: number;
		/** the head-on fade `1 − saturate(|N·V| · mirrorMul + mirrorAdd)` */
		mirrorMul: number;
		mirrorAdd: number;
	} | null;
}

/** everything the renderer needs of a level's look */
export interface Environment {
	/** the profile's name, or `null` for the defaults */
	name: string | null;
	/** unit vector towards the sun */
	sunDirection: Vec3;
	/** pre-exposed illuminance, linear rgb */
	sunIlluminance: Vec3;
	/**
	 * the pre-exposed illuminance with the colour raw rather than linear, as the game's atmosphere fog and
	 * water column take the sun
	 */
	sunRaw: Vec3;
	sunSpecular: number;
	/** the sun shadow's look */
	shadow: {
		/** how far shadow darkens the sun, 0–1 */
		strength: number;
		/** filter radius numerator (see `shadow-map.ts`) */
		softness: number;
		/** how far the shadow is replaced by `attenuation`: 1 where the game keeps the sun out of caves */
		override: number;
		attenuation: number;
		/** texture-table id of the penumbra tint ramp, or `null` for none (black) */
		ramp: number | null;
	};
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
	heightFog: HeightFog;
	/** the volumetric fog in front of the height fog, or `null` when off */
	volumetricFog: VolumetricFog | null;
	/** metres to the sky dome, for fogging the sky */
	skyDistance: number;
	post: PostLook;
	grading: Grading;
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
		/** the clouds cover the sky planets; otherwise the planets show in front of them */
		afterPlanets: boolean;
	} | null;
	/**
	 * a tiling texture projected along the sun onto the ground, darkening the sun's light where its red channel
	 * is low; `null` when off. the game's far-texture set isn't supported (no shipped phase enables it)
	 */
	cloudShadow: {
		texture: number;
		/** world position the projection is centred on */
		center: Vec3;
		/** texture repeats per metre */
		scale: number;
		/** texture offset per second */
		flow: Vec2;
		/** how far the texture darkens the sun, 0–1 */
		alpha: number;
		/**
		 * past `start` metres from the centre (horizontally), the texture switches to one sampled at `farScale`
		 * times the scale, over `width` metres
		 */
		start: number;
		width: number;
		farScale: number;
		/** skews a position offset along the sun by its height before sampling: `d + projection · d.y` */
		projection: Vec3;
	} | null;
	autoExposure: AutoExposureSettings;
	/** screen-space sun shafts, or `null` when off */
	lightShaft: LightShaftLook | null;
}

/** the game's screen-space sun shafts (`HGLightShaftConfig`) as the light shaft passes take them */
export interface LightShaftLook {
	/** unit vector towards the sun the shafts radiate from */
	sunDirection: Vec3;
	bloomScale: number;
	/** scene luminance (pre-exposed) above which pixels cast shafts */
	threshold: number;
	/** cap on the luminance above the threshold */
	maxBrightness: number;
	/** raw colour */
	tint: Vec3;
	/** how far each blur pass reaches towards the sun */
	blurIntensity: number;
	/** metres; only what lies beyond half of it casts shafts */
	occlusionDepthRange: number;
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

/**
 * @param q one of the light config's `rotation*` quaternions
 * @returns the unit vector towards a light whose rotation turns +Z into its direction of travel
 */
export const towardsRotatedLight = (q: Readonly<Quat>): Vec3 => {
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
	enableFlowNoise: false,
	flowNoiseIntensity: 0,
	flowNoiseDistance: 60,
	flowNoiseTilling: 0.01,
	flowNoiseDir: [0, 0, 1],
	flowNoiseSpeed: 0,
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
		cloudShadowPitchYawMode: 0,
		cloudShadowPitchYaw: [38, 35],
		rotationAtmosphere: IDENTITY,
		rotationCloudShadow: IDENTITY,
		rotationHeightFogDirectionalInscattering: IDENTITY,
		rotationLightShaft: IDENTITY,
	},
	shadow: {
		csmIntensity: 1,
		csmRampTexture: null,
		csmShadowSoftness: 0.01,
		disableCsmBlendFactor: 0,
		csmSimulatedAttenuation: 0,
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
	volumetricFog: {
		...DEFAULT_HEIGHT_FOG,
		enable: false,
		volumetricFogScatteringDistribution: 0.2,
		volumetricFogAlbedo: [1, 1, 1, 1],
		volumetricFogEmissive: [0, 0, 0, 1],
		volumetricFogExtinctionScale: 1,
		volumetricFogDistance: 100,
		volumetricFogStartDistance: 0,
		volumetricFogNearFadeInDistance: 0,
		volumetricFogDirectLightingScatteringIntensity: 1,
		volumetricFogSkyLightingScatteringIntensity: 1,
	},
	cloud: null,
	colorGrading: NEUTRAL_GRADING,
	lightShaft: {
		enable: false,
		bloomScale: 0,
		bloomThreshold: 1,
		bloomMaxBrightness: 1,
		bloomTint: [1, 1, 1, 1],
		blurIntensity: 0,
		occlusionDepthRange: 5000,
	},
	post: {
		bloom: {
			resolutionHighQuality: 2,
			thresholdHighQuality: 0.95,
			intensityHighQuality: 0.5,
			scatterHighQuality: 0.4,
			tint: [1, 1, 1, 1],
			blendMode: 2,
		},
		ambientOcclusion: {
			enable: true,
			custom: false,
			radius: 4,
			radiusMultiplier: 1,
			falloffRange: 1,
			sampleDistributionPower: 1,
			thinOccluderCompensation: 2,
			finalValuePower: 2.2,
		},
		vignette: {
			color: [0, 0, 0, 1],
			center: [0.5, 0.5],
			intensity: 0.3,
			smoothness: 0.2,
			roundness: 1,
			rounded: false,
		},
		// what every shipped profile sets
		screenSpaceReflection: {
			enable: true,
			fadenessOnScreen: 0.1,
			fadenessOnMirrorMul: 2,
			fadenessOnMirrorAdd: -1,
		},
	},
	// held at exposure 1
	autoExposure: {
		autoExposureMode: 1,
		autoExposureManualEvCompensationAuto: 0,
		autoExposureLerpUpSpeed: 1,
		autoExposureLerpDownSpeed: 1,
		autoExposureEv100Range: [-8, 4],
		autoExposureEv100HistogramRange: [-8, 4],
		autoExposureMeteringMode: 0,
		autoExposurePixelLuminanceRange: [0.05, 0.95],
		autoExposureEvClampRange: [0, 0],
		autoExposureManualEvCompensationManual: 0,
	},
};

const scaled = (c: Color, scale: number): Vec3 => [c[0] * scale, c[1] * scale, c[2] * scale];

/** @returns the vector of `f` over the three channels */
const map3 = (f: (i: number) => number): Vec3 => [f(0), f(1), f(2)];

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
	const luma = tint[0] * 0.2126729 + tint[1] * 0.7151522 + tint[2] * 0.072175;
	return {
		threshold: srgbToLinear(bloom.thresholdHighQuality),
		intensity: 2 ** bloom.intensityHighQuality - 1,
		scatter: 0.05 + 0.9 * Math.min(Math.max(bloom.scatterHighQuality, 0), 1),
		tint: luma > 0 ? [tint[0] / luma, tint[1] / luma, tint[2] / luma] : [1, 1, 1],
		subtract: bloom.blendMode !== 0 ? 1 : 0,
		half: bloom.resolutionHighQuality < 3,
	};
};

const postLook = (post: PostInput | null): PostLook => {
	const bloom = post?.bloom ?? null;
	const ao = post?.ambientOcclusion ?? null;
	const vignette = post?.vignette ?? null;
	const ssr = post?.screenSpaceReflection ?? null;
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
		afterPlanets: cloud.drawCloudAfterPlanet,
	};
};

/** HGSkyRenderer.SetupShaderVariablesGlobalCloudShadow, without the far-texture set */
const cloudShadowLook = (cloud: CloudInput | null, light: LightInput): Environment['cloudShadow'] => {
	if (cloud === null || !cloud.enable || !cloud.enableCloudShadow) {
		return null;
	}
	const config = cloud.cloudShadowConfig;
	if (config.cloudShadowTexture === null) {
		return null;
	}
	// the light's direction of travel over the cosine of its pitch in degrees / 360 taken as radians, as the game
	// computes it. that keeps the factor within 1% of 1 for any pitch; a true 1/sin(pitch) would blow up at the
	// 0° pitch some phases ship, striping the texture along the terrain's contours
	const pitch = light.cloudShadowPitchYawMode === 1 ? light.cloudShadowPitchYaw[0] : light.directPitchYaw[0];
	const factor = Math.min(Math.max(Math.abs(Math.cos(pitch / 360)), 0.001), 1);
	const [x, y, z] = rotate(light.rotationCloudShadow, [0, 0, 1]);
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

/** HGAtmosphereRenderer.SetupShaderVariablesGlobalHeightFog */
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

/** HGVolumetricFogRenderer's constants, minus the flow noise, local fog volumes and local lights */
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
		emissive: scaled(fog.volumetricFogEmissive, 0.001),
		sunDirection: towardsRotatedLight(light.rotationAtmosphere),
		// colours go in raw, as for the atmosphere fog
		sun: scaled(light.directColor, directional),
		skyIntensity: fog.volumetricFogSkyLightingScatteringIntensity,
	};
};

/** LightShaftPassConstructor.LightShaftPass: the shafts radiate from the light shaft rotation's light */
const lightShaftLook = (config: LightShaftInput, light: LightInput): LightShaftLook | null => {
	if (!config.enable) {
		return null;
	}
	return {
		sunDirection: towardsRotatedLight(light.rotationLightShaft),
		bloomScale: config.bloomScale,
		threshold: config.bloomThreshold,
		maxBrightness: config.bloomMaxBrightness,
		tint: [config.bloomTint[0], config.bloomTint[1], config.bloomTint[2]],
		blurIntensity: config.blurIntensity,
		occlusionDepthRange: config.occlusionDepthRange,
	};
};

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
	const color = linearRgb(light.directColor);
	const sunIlluminance: Vec3 = [color[0] * intensity, color[1] * intensity, color[2] * intensity];
	const sunDirection = towardsLight(light.directPitchYaw);
	const skySunDirection =
		light.atmospherePitchYawMode === 1 ? towardsLight(light.atmospherePitchYaw) : sunDirection;
	const skyScale = intensity * sky.skyDirectIntensity;
	return {
		name: profile === null ? null : source.name,
		sunDirection,
		sunIlluminance,
		sunRaw: scaled(light.directColor, intensity),
		sunSpecular: light.directSpecularIntensity,
		shadow: {
			strength: source.shadow.csmIntensity,
			softness: source.shadow.csmShadowSoftness,
			override: source.shadow.disableCsmBlendFactor,
			attenuation: source.shadow.csmSimulatedAttenuation,
			ramp: source.shadow.csmRampTexture,
		},
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
		heightFog: {
			...heightFogLook(volumetricFog.enable ? volumetricFog : heightFog, light),
			enabled: heightFog.enable,
		},
		volumetricFog: volumetricFog.enable ? volumetricFogLook(volumetricFog, light, intensity) : null,
		skyDistance: sky.skyDistance,
		post: postLook(source.post ?? DEFAULT_PROFILE.post),
		grading: gradingLook(source.colorGrading),
		cloud: cloudLook(source.cloud),
		cloudShadow: cloudShadowLook(source.cloud, light),
		autoExposure: autoExposureLook(source.autoExposure),
		lightShaft: lightShaftLook(source.lightShaft, light),
	};
};

// #endregion
