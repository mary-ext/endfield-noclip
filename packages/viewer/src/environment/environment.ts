/**
 * a level's environment as the renderer uses it: the sun, the ambient probe, the atmosphere, fog and post
 * settings, in shader units. `derive.ts` derives it from the game's environment profile, or from defaults
 * when a package has none.
 *
 * shading happens in pre-exposed units: `preExposure = 1 / (1.2 · 2^EV100)`, the sun's illuminance is
 * `directLux · preExposure`, and the ambient probe is stored pre-exposed (docs/viewer/lighting.md#units).
 *
 * @module
 */

import type { Vec2, Vec3 } from '@endfield-noclip/package-format/values';

import type { Grading } from './color-grading.ts';
import type { AutoExposureSettings } from './exposure.ts';

/** the atmosphere in the units the sky shaders use (kilometres) */
interface Atmosphere {
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
interface FogLayer {
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
interface FlowNoise {
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
	/**
	 * what the sky-view LUT (radiance per unit sun illuminance) is multiplied by, as the game packs it: the
	 * outer sun colour × the exposed sun × the procedural sky lux factor
	 */
	skyIlluminance: Vec3;
	/** Unity shader form of the ambient probe (SHAr, SHAg, SHAb, SHBr, SHBg, SHBb, SHC), 28 floats */
	sh: Float32Array;
	/**
	 * `light.indirectDiffuseFactor`, the game's scale on all diffuse ambient (`_EnvironmentGlobalParams0.x`);
	 * {@link sh} already carries it, the irradiance volume doesn't
	 */
	indirectDiffuse: number;
	/** `light.indirectSpecularFactor`, the game's scale on the sky reflection (`_EnvironmentGlobalParams0.y`) */
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
	/** the main wind, which sways cloth ({@link windClockRate}) */
	wind: {
		/** `_WindGlobalParams0.x` */
		intensity: number;
		/** the XZ components of the unit direction it blows toward */
		direction: Vec2;
	};
}

/**
 * how fast the wind clock (`_WindGlobalParams0.y`) runs: the game advances it by the main intensity times
 * 0.08 per second (`docs/game-data/environment.md#wind`)
 *
 * @param wind the derived wind
 * @returns wind clock units per second
 */
export const windClockRate = (wind: Environment['wind']): number => wind.intensity * 0.08;

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
