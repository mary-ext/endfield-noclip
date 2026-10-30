import type { TextureRef } from './textures.ts';
import type { Color, Vec2, Vec3, Vec4, Quat } from './values.ts';

/**
 * one environment: an `HGEnvironmentPhase` (`EnvParse/Env_*.asset`) plus the post-processing profile of the
 * level's global `Volume`. each section is the game's `HG*Config` with the game's field names: colours as
 * {@link Color}, vectors as arrays, `SphericalHarmonicsL2` as 27 numbers in the game's order, flags as
 * booleans, nested structs as objects, textures as {@link TextureRef}s and materials as
 * {@link EnvironmentMaterial}s. colour curves, editor state and other object references are left out.
 *
 * the game blends environment volumes by priority, and a phase only sets the sections it marks active. a
 * section the level's phase leaves inactive is taken from the scene's global volume's phase (what the game
 * applies under it), so every section here is the one in effect
 */
export interface EnvironmentProfile {
	/** the level phase's asset name, e.g. `Env_map02_lv001_art_Global_01` */
	name: string;
	light: LightConfig;
	sky: SkyConfig;
	atmosphere: AtmosphereConfig;
	fog: FogConfig;
	heightFog: HeightFogConfig;
	volumetricFog: VolumetricFogConfig;
	cloud: CloudConfig;
	wind: WindConfig;
	lightShaft: LightShaftConfig;
	colorGrading: ColorGradingConfig;
	autoExposure: AutoExposureConfig;
	shadow: ShadowConfig;
	celestial: CelestialConfig;
	star: StarConfig;
	/** the level's global post-processing volume, or `null` if it has none */
	post: PostProfile | null;
}

/** the sections of an environment phase, as in {@link EnvironmentProfile} */
export type EnvironmentSections = Omit<EnvironmentProfile, 'name' | 'post'>;

/**
 * an `HGEnvironmentPhase` as the environment volumes apply it: its own sections, uncomposed. sections it
 * marks inactive leave what's under them unchanged
 */
export interface EnvironmentPhaseInfo {
	/** the asset name, e.g. `Env_map02_lv006_jian2_key` */
	name: string;
	/** the sections the phase sets */
	active: (keyof EnvironmentSections)[];
	sections: EnvironmentSections;
}

/** where an environment volume applies, in the Unity world frame */
export type EnvironmentVolumeShape =
	| { kind: 'global' }
	/** a unit cube under the transform */
	| { kind: 'box'; position: Vec3; rotation: Vec3; scale: Vec3 }
	/** a vertical prism over a closed polygon in world x, z, from `bottom` to `top` (world y) */
	| { kind: 'prism'; points: Vec2[]; bottom: number; top: number };

/**
 * an `HGEnvironmentVolume`. the game blends them at the camera each frame (`HGEnvironmentManager`): starting
 * from the default phase, volumes in ascending order of priority (then shape: global, box, prism) that
 * contain the camera apply their phase: blend mode 0 replaces, 1 lerps by `clamp(distance to the edge /
 * blendDistance)`, 2 fades over `fadeIn/OutDuration` seconds (instantly when the camera moves over 5 m in a
 * frame), 3 lerps by a scripted factor
 */
export interface EnvironmentVolumeInfo {
	/** the object's name */
	name: string;
	/**
	 * index into `StatesInfo.groups`: the owning level (tag 0 for scene-wide) and the scene states that load
	 * it. a volume applies wherever it holds the camera, whichever level is shown, once its condition holds
	 */
	group: number;
	shape: EnvironmentVolumeShape;
	blendMode: number;
	priority: number;
	blendDistance: number;
	fadeInDuration: number;
	fadeOutDuration: number;
	/** index into {@link PackageManifest.environmentPhases}, or `null` if the phase is unset or unreadable */
	phase: number | null;
	/** script activation has not been recovered; previewing this volume assumes it is enabled */
	activation: 'unknown';
}

/**
 * `HGLightConfig`: the sun. physical units: `directLux` is illuminance and `directEV100` the exposure, with
 * `preExposure = 1 / (1.2 · 2^directEV100)` and `directIntensity = directLux · preExposure` (both precomputed
 * by the game). every effect that draws the sun has its own direction: `<effect>PitchYawMode` 0 follows
 * `directPitchYaw`, 1 uses `<effect>PitchYaw`; the `rotation*` quaternions are the resolved results
 */
export interface LightConfig {
	/** the colour in effect: `directCustomColor` or the temperature's, per `directColorMode` */
	directColor: Color;
	directColorMode: number;
	directCustomColor: Color;
	/** kelvin */
	directColorTemperature: number;
	directLux: number;
	directEV100: number;
	directSpecularIntensity: number;
	directSoftSourceRadius: number;
	directDirectionMode: number;
	/** degrees: elevation, then azimuth */
	directPitchYaw: Vec2;
	timeOfDayYawOffset: number;
	timeOfDayPitchMax: number;
	indirectDiffuseFactor: number;
	indirectSpecularFactor: number;
	indirectSpecularFactorType: number;
	atmospherePitchYawMode: number;
	atmospherePitchYaw: Vec2;
	lightShaftPitchYawMode: number;
	lightShaftPitchYaw: Vec2;
	sunDiscPitchYawMode: number;
	sunDiscPitchYaw: Vec2;
	lensFlarePitchYawMode: number;
	lensFlarePitchYaw: Vec2;
	cloudShadowPitchYawMode: number;
	cloudShadowPitchYaw: Vec2;
	heightFogDirectionalInscatteringPitchYawMode: number;
	heightFogDirectionalInscatteringPitchYaw: Vec2;
	preExposure: number;
	directIntensity: number;
	directIntensityDividePi: number;
	/** the direction the sunlight travels, Unity world frame */
	forwardDirect: Vec3;
	/** the light's frame, 16 numbers row-major (`e00 e01 e02 e03 e10 …`) */
	localToWorld: number[];
	rotationAtmosphere: Quat;
	rotationLightShaft: Quat;
	rotationSunDisc: Quat;
	rotationLensFlare: Quat;
	rotationCloudShadow: Quat;
	rotationHeightFogDirectionalInscattering: Quat;
	bakedIndirectMultiplier: number;
	giBakedIndirectMultiplier: number;
}

/** `HGSkyConfig`: sky luminance, ambient light and reflections */
export interface SkyConfig {
	skyDistance: number;
	useSkyDistanceForBakeFogLut: boolean;
	skyBakedIndirectIntensity: number;
	skyDirectIntensity: number;
	giSkyMultiplier: number;
	useCustomIVDefaultSH: boolean;
	/** ambient SH used outside irradiance-volume coverage when {@link useCustomIVDefaultSH} is set */
	customIVDefaultSH: number[];
	skyMaterialType: number;
	proceduralSkyLuxFactor: number;
	enableSunDisc: boolean;
	sunDiscRadius: number;
	sunDiscRampIntensity: number;
	sunDiscColor: Color;
	skyboxBrightness: number;
	skyboxTintColor: Color;
	/** degrees */
	skyboxRotation: number;
	visibleBox: Vec3;
	reflectionType: number;
	/** the sky reflection cubemap (BC6H) */
	reflectionMap: TextureRef;
	culloff: number;
	/**
	 * ambient light, Unity `SphericalHarmonicsL2` order: 9 coefficients of red, then green, then blue; scaled
	 * by {@link LightConfig.indirectDiffuseFactor}
	 */
	skyAmbientSH: number[];
	skyboxCubeMap: TextureRef;
}

/** `HGAtmosphereConfig`: physically based sky (Hillaire-style); distances in km */
export interface AtmosphereConfig {
	groundRadius: number;
	groundAlbedo: Color;
	outerSunIrradianceColor: Color;
	atmosphereHeight: number;
	multiScatteringFactor: number;
	rayleighScatteringScale: number;
	rayleighScattering: Color;
	rayleighExponentialDistribution: number;
	mieScatteringScale: number;
	mieScattering: Color;
	mieAbsorptionScale: number;
	mieAbsorption: Color;
	mieAnisotropy: number;
	mieExponentialDistribution: number;
	ozoneAbsorptionScale: number;
	ozoneAbsorption: Color;
	tentTipAltitude: number;
	tentTipValue: number;
	tentWidth: number;
}

/** `HGFogConfig`: distance fog (aerial perspective) */
export interface FogConfig {
	enable: boolean;
	startDistance: number;
	startHeight: number;
	fallOffHeight: number;
	fallOffDistance: number;
	mieScattering: Color;
	mieScatteringScale: number;
	mieAnisotropy: number;
	rayleighScattering: Color;
	rayleighScatteringScale: number;
	inscatterAmbientColor: Color;
}

/** the two exponential height-fog layers and their froxel-fog parameters, shared by both height-fog sections */
export interface HeightFogLayers {
	enable: boolean;
	heightFogStartHeight: number;
	heightFogDensity: number;
	heightFogFalloff: number;
	heightFogStartHeightSecond: number;
	heightFogDensitySecond: number;
	heightFogFalloffSecond: number;
	heightFogInscatter: Color;
	heightFogMaxOpacity: number;
	heightFogStartDistance: number;
	heightFogStartTransition: number;
	heightFogCutoffDistance: number;
	heightFogCutoffTransition: number;
	heightFogDirectionalInscatteringExponent: number;
	heightFogDirectionalInscatteringStartDistance: number;
	heightFogDirectionalInscattering: Color;
	volumetricFogScatteringDistribution: number;
	volumetricFogAlbedo: Color;
	volumetricFogEmissive: Color;
	volumetricFogExtinctionScale: number;
	volumetricFogDistance: number;
	volumetricFogStartDistance: number;
	volumetricFogNearFadeInDistance: number;
	volumetricFogDirectLightingScatteringIntensity: number;
	volumetricFogSkyLightingScatteringIntensity: number;
	enableFlowNoise: boolean;
	flowNoiseIntensity: number;
	flowNoiseDistance: number;
	flowNoiseTilling: number;
	flowNoiseHorizontalDirAngle: number;
	flowNoiseVerticalDirAngle: number;
	flowNoiseDir: Vec3;
	flowNoiseSpeed: number;
}

/** `HGHeightFogConfig`: analytic height fog */
export interface HeightFogConfig extends HeightFogLayers {
	heightFogCullingFarClipPlane: number;
	heightFogDirectionalInscatteringExponentMobile: number;
	heightFogDirectionalInscatteringMobile: Color;
	enableVolumetricFog: boolean;
}

/** `HGVolumetricFogConfig`: froxel volumetric fog */
export interface VolumetricFogConfig extends HeightFogLayers {
	enableVLFlowNoise: boolean;
	flowVLNoise3DTexture: TextureRef;
	enableTwoParameter: boolean;
	flowVLNoiseIntensity: number;
	flowVLNoiseRemapRange: Vec2;
	flowVLNoiseDistance: number;
	flowVLNoiseTilling: number;
	flowVLNoiseTillingScale: Vec3;
	flowVLNoiseHorizontalDirAngle: number;
	flowVLNoiseVerticalDirAngle: number;
	flowVLNoiseDir: Vec3;
	flowVLNoiseSpeed: number;
	flowVLNoisePerturb3DTexture: TextureRef;
	flowVLNoisePerturbTilling: number;
	flowVLNoisePerturbIntensity: number;
	flowVLNoisePerturbSpeed: Vec3;
}

/** `HGCloudShadowConfig` */
export interface CloudShadowConfig {
	cloudShadowTexture: TextureRef;
	cloudShadowEnvCenter: Vec3;
	cloudShadowCoverage: number;
	cloudShadowFlowSpeed: number;
	cloudShadowFlowDirection: Vec2;
	cloudShadowAlpha: number;
	cloudShadowDistanceScale: number;
	cloudShadowScaleStartDistance: number;
	cloudShadowScaleEndDistance: number;
	enableFarCloudShadowTexture: boolean;
	cloudShadowFarEnvCenter: Vec3;
	cloudShadowFarCoverage: number;
	cloudShadowFarFlowSpeed: number;
	cloudShadowFarFlowDirection: Vec2;
}

/** `HGCloudConfig`: the panoramic cloud layer and cloud shadows */
export interface CloudConfig {
	enable: boolean;
	cloudTexture: TextureRef;
	cloudTint: Color;
	cloudContrast: number;
	lightAffectCloud: boolean;
	cloudBrightness: number;
	cloudAbsoluteBrightness: number;
	brightnessAffectCloudAlpha: boolean;
	drawCloudAfterPlanet: boolean;
	cloudTextureMode: number;
	cloudOpacityR: number;
	cloudOpacityG: number;
	cloudFlowType: number;
	/** degrees */
	rotation: number;
	cloudFlowMap: TextureRef;
	flowSpeed: number;
	flowDirectionX: number;
	flowDirectionY: number;
	enableLightShaftCloudMask: boolean;
	lightShaftCloudMaskTexture: TextureRef;
	enableCloudShadow: boolean;
	cloudShadowConfig: CloudShadowConfig;
	cloudFadeAlpha: number;
}

/**
 * a material an environment section draws with (the celestial bodies'), flattened: its shader's name and its
 * properties under Unity's names
 */
export interface EnvironmentMaterial {
	/** e.g. `HGRP/SkydomeStar` */
	shader: string;
	/** enabled keywords, space-separated as in Unity's `m_ShaderKeywords` */
	keywords: string;
	floats: Record<string, number>;
	colors: Record<string, Color>;
	/** texture slots that resolved, by property name */
	textures: Record<string, TextureRef>;
	/** texture scale (xy) and offset (zw) per slot, as the material stores them */
	textureTransforms: Record<string, Vec4>;
}

/** `RingProperty`: a planet's ring, in the planet's radius units */
export interface RingProperty {
	outerRadius: number;
	width: number;
	ringColor: Color;
	planetRingMap: TextureRef;
}

/** `CelestialObjectProperty` */
export interface CelestialObjectProperty {
	radius: number;
	/** degrees */
	selfTiltX: number;
	selfTiltZ: number;
	selfRotationY: number;
}

/** `CelestialDrawer`: how a body is painted on the sky dome */
export interface CelestialDrawer {
	drawMode: number;
	drawMaterial: EnvironmentMaterial | null;
	/** degrees: where on the sky the body sits */
	pitchYaw: Vec2;
	/** degrees: where its light comes from */
	incidentLightingPitchYaw: Vec2;
}

/** `AtmosphereProperty`: a body's atmosphere rim */
export interface AtmosphereProperty {
	bakeFaceVisibility: boolean;
	atmosphereHeight: number;
	numInscatteredSamplePoints: number;
	numOpticalDepthSamplePoints: number;
	coff_R: number;
	heightScale_R: number;
	atmosphereBrightness: number;
	atmosphereHueshift: number;
}

/** `HGCelestialAtmosphereObjectConfig`: a planet painted on the sky dome */
export interface CelestialAtmosphereObjectConfig {
	drawPlanetInSkydome: boolean;
	drawPlanetBelowHorizon: boolean;
	objectProperty: CelestialObjectProperty;
	skydomeDrawer: CelestialDrawer;
	enableRing: boolean;
	ring: RingProperty;
	enableAtmosphere: boolean;
	atmosphere: AtmosphereProperty;
}

/** `HGCelestialObjectConfig`: the procedural moon */
export interface CelestialObjectConfig {
	radius: number;
	orbitRadius: number;
	enableRing: boolean;
	drawPlanetBelowHorizon: boolean;
	worldLongitude: number;
	worldLatitude: number;
	rotationAroundUp: number;
	ring: RingProperty;
}

/** `HGCelestialAdvancedObjectConfig`: a ray-traced planet with its own material */
export interface CelestialAdvancedObjectConfig {
	drawAdvancedPlanet: boolean;
	advancedPlanetMat: EnvironmentMaterial | null;
}

/** `HGCelestialConfig`: planets and moons in the sky */
export interface CelestialConfig {
	moonConfig: CelestialObjectConfig;
	/** the smaller planet */
	talosAlphaConfig: CelestialAtmosphereObjectConfig;
	/** Talos-II as seen from its surface */
	planetConfig: CelestialAtmosphereObjectConfig;
	advancedPlanetConfig: CelestialAdvancedObjectConfig;
}

/** `HGStarConfig`: the star field and nebula */
export interface StarConfig {
	enableStars: boolean;
	starsTilling: number;
	starsFlickerSpeed: number;
	minMaxRange: Vec2;
	starsTint: Color;
	starsTint1: Color;
	thresholdSoftness: number;
	starsDensity: number;
	starsExposure: number;
	brightnessRandomSeed: number;
	colorRandomSeed: number;
	distributionRandomSeed: number;
	skyBoxStarRangeMap: TextureRef;
	/** degrees */
	skyBoxStarDensityMapRotation: number;
	starRingStarCoverage: number;
	cloudRingStarCoverage: number;
	starDensityMapMaskThres: number;
	debugMode: number;
	enableNebula: boolean;
	nebulaMap: TextureRef;
	nebulaTint: Color;
	/** degrees */
	nebulaMapRotation: number;
	nebulaStarConverage: number;
	celestialNebulaConverage: number;
}

/** `HGShadowConfig`: the sun shadow's look and the cached and contact shadows' settings */
export interface ShadowConfig {
	csmDepthBiasV2: number;
	csmNormalBiasV2: number;
	/** how far shadows darken the sun, 0–1 */
	csmIntensity: number;
	/** penumbra tint, sampled at the shadow value; black when `null` */
	csmRampTexture: TextureRef;
	/** filter radius numerator: over each cascade's split distance, in the game's shadow atlas uv */
	csmShadowSoftness: number;
	asmCasterMinY: number;
	asmCasterMaxY: number;
	contactShadowIntensity: number;
	contactShadowSurfaceThickness: number;
	contactShadowBilinearThreshold: number;
	contactShadowContract: number;
	contactShadowIgnoreEdgePixels: boolean;
	overrideCsmFarDistanceEnabled: boolean;
	overrideCsmFarDistance: number;
	manualOverrideCsmRendering: boolean;
	overrideCsmSpherePosition: Vec3;
	overrideCsmSphereRadius: number;
	disableCsm: boolean;
	/** how far the shadow is replaced by `csmSimulatedAttenuation` (1 in caves that keep the sun out) */
	disableCsmBlendFactor: number;
	csmSimulatedAttenuation: number;
	disableAsm: boolean;
	rhodesModeEnabled: boolean;
	rhodesShipCenter: Vec3;
	rhodesShipRadius: number;
}

/** `HGWindConfig`: foliage and cloth wind */
export interface WindConfig {
	/** m/s */
	speed: number;
	/** degrees */
	horizontalDirectionAngle: number;
	verticalDirectionAngle: number;
	/** unit vector the wind blows toward, Unity world frame */
	direction: Vec3;
}

/** `HGLightShaftConfig`: screen-space sun shafts */
export interface LightShaftConfig {
	enable: boolean;
	bloomScale: number;
	bloomThreshold: number;
	bloomMaxBrightness: number;
	bloomTint: Color;
	blurIntensity: number;
	occlusionDepthRange: number;
	enableOcclusion: boolean;
	occlusionMaskDarkness: number;
}

/** `HGShadowsMidtonesHighlights` */
export interface ShadowsMidtonesHighlights {
	shadows: Vec4;
	midtones: Vec4;
	highlights: Vec4;
	shadowsStart: number;
	shadowsEnd: number;
	highlightsStart: number;
	highlightsEnd: number;
	shadowsOverriding: boolean;
	midtonesOverriding: boolean;
	highlightsOverriding: boolean;
	shadowsStartOverriding: boolean;
	shadowsEndOverriding: boolean;
	highlightsStartOverriding: boolean;
	highlightsEndOverriding: boolean;
}

/** `HGLiftGammaGain` */
export interface LiftGammaGain {
	lift: Vec4;
	gamma: Vec4;
	gain: Vec4;
	liftOverriding: boolean;
	gammaOverriding: boolean;
	gainOverriding: boolean;
}

/**
 * `HGColorGradingConfig`: tonemapping and URP-style grading (the colour curves aren't included).
 * `tonemappingMode` is the game's `TonemappingMode`: 0 `None`, 1 `Neutral`, 2 `ACES`, 3 `Custom`, 4
 * `External`, 5 `ACES_modified` (5 everywhere seen; 1–4 are hidden from the game's inspector)
 */
export interface ColorGradingConfig {
	tonemappingMode: number;
	colorLookupEnabled: boolean;
	colorLookupTexture: TextureRef;
	colorLookupContribution: number;
	whiteBalanceEnabled: boolean;
	whiteBalanceTemperature: number;
	whiteBalanceTint: number;
	colorAdjustmentsEnabled: boolean;
	colorAdjustmentsPostExposure: number;
	colorAdjustmentsContrast: number;
	colorAdjustmentsColorFilter: Color;
	colorAdjustmentsHueShift: number;
	colorAdjustmentsSaturation: number;
	channelMixerEnabled: boolean;
	channelMixerRedOutRedIn: number;
	channelMixerRedOutGreenIn: number;
	channelMixerRedOutBlueIn: number;
	channelMixerGreenOutRedIn: number;
	channelMixerGreenOutGreenIn: number;
	channelMixerGreenOutBlueIn: number;
	channelMixerBlueOutRedIn: number;
	channelMixerBlueOutGreenIn: number;
	channelMixerBlueOutBlueIn: number;
	shadowsMidtonesHighlightsEnabled: boolean;
	shadowsMidtonesHighlights: ShadowsMidtonesHighlights;
	liftGammaGainEnabled: boolean;
	liftGammaGain: LiftGammaGain;
	splitToningEnabled: boolean;
	splitToningShadows: Color;
	splitToningHighlights: Color;
	splitToningBalance: number;
	colorCurvesEnabled: boolean;
}

/**
 * `HGAutoExposureConfig`: the post exposure on top of {@link LightConfig.directEV100}'s. mode 0 meters the
 * scene, 1 holds `2^autoExposureManualEvCompensationManual`; metering mode 0 averages, 1 weights the centre
 */
export interface AutoExposureConfig {
	autoExposureMode: number;
	autoExposureManualEvCompensationAuto: number;
	autoExposureLerpUpSpeed: number;
	autoExposureLerpDownSpeed: number;
	autoExposureEv100Range: Vec2;
	autoExposureEv100HistogramRange: Vec2;
	autoExposureMeteringMode: number;
	autoExposurePixelLuminanceRange: Vec2;
	autoExposureEvClampRange: Vec2;
	autoExposureManualEvCompensationManual: number;
}

/**
 * a post-processing `VolumeProfile` (`gvp_*.asset`): its components under the game's field names, each `null`
 * when the profile doesn't have it or has it switched off. values are the profile's, overridden or not (with
 * a single global volume, the non-overridden ones are the defaults in effect). tonemapping isn't a volume
 * component here; see {@link ColorGradingConfig.tonemappingMode}
 */
export interface PostProfile {
	/** the profile's asset name, e.g. `gvp_map02_lv000_art_01` */
	name: string;
	bloom: BloomSettings | null;
	ambientOcclusion: AmbientOcclusionSettings | null;
	vignette: VignetteSettings | null;
	screenSpaceReflection: ScreenSpaceReflectionSettings | null;
}

/**
 * the game's `Bloom`, with settings per quality tier (the PC client's high tier is the reference look) and a
 * second, additive pass
 */
export interface BloomSettings {
	quality: number;
	resolutionHighQuality: number;
	resolutionMedQuality: number;
	resolutionLowQuality: number;
	thresholdHighQuality: number;
	thresholdMedQuality: number;
	thresholdLowQuality: number;
	intensityHighQuality: number;
	intensityMedQuality: number;
	intensityLowQuality: number;
	scatterHighQuality: number;
	scatterMedQuality: number;
	scatterLowQuality: number;
	tint: Color;
	blendMode: number;
	bloomUpsampleAdditive: boolean;
	thresholdAdditiveHighQuality: number;
	intensityAdditiveHighQuality: number;
	scatterAdditiveHighQuality: number;
	characterBloomControl: boolean;
	characterThreshold: number;
	characterSoftness: number;
	characterIntensity: number;
	dirtIntensity: number;
	anamorphic: boolean;
}

/** the game's `GTAmbientOcclusion` (ground-truth AO) */
export interface AmbientOcclusionSettings {
	enable: boolean;
	custom: boolean;
	enableFP32Depths: boolean;
	generateNormalsInplace: boolean;
	qualityLevel: number;
	denoisePasses: number;
	/** metres */
	radius: number;
	radiusMultiplier: number;
	falloffRange: number;
	sampleDistributionPower: number;
	thinOccluderCompensation: number;
	/** exponent applied to the AO term */
	finalValuePower: number;
	depthMIPSamplingOffset: number;
	mvFactor: number;
	depthFactor: number;
}

/** URP's `Vignette`, plus the game's mode and blink */
export interface VignetteSettings {
	mode: number;
	color: Color;
	/** screen UV */
	center: Vec2;
	intensity: number;
	smoothness: number;
	roundness: number;
	rounded: boolean;
	blink: boolean;
	opacity: number;
}

/** the game's `ScreenSpaceReflectionVolume` */
export interface ScreenSpaceReflectionSettings {
	enable: boolean;
	fadenessOnScreen: number;
	fadenessOnDepth: number;
	fadenessOnDepthFactor: number;
	fadenessOnMirrorMul: number;
	fadenessOnMirrorAdd: number;
	mipThreshold: number;
}
