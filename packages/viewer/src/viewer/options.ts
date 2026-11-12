import type { DebugView } from '../render/frame/debug-views.ts';
import type { PostSettings, Tonemapper } from '../render/post/settings.ts';

/** user-facing switches */
export interface ViewerOptions {
	terrain: boolean;
	/** draw the terrain's baked albedo and normal pages; off (or without BC textures) shows stand-in colours */
	terrainSurface: boolean;
	/** blend the terrain's close-up material layers near the camera (needs BC textures) */
	terrainSplat: boolean;
	instances: boolean;
	detail: boolean;
	global: boolean;
	/**
	 * show the stream areas the game shows at the camera, as its trigger zones decide; off shows every area of
	 * the level at once
	 */
	streamAreas: boolean;
	/** enabled HLOD tiers 0–2 */
	hlodTiers: [boolean, boolean, boolean];
	wireframe: boolean;
	/** draw stand-in boxes for instances with no resident mesh LOD, or every instance without geometry */
	boxes: boolean;
	/** draw meshes whose material the viewer lacks in the unsupported checker; off skips them */
	unsupportedMaterials: boolean;
	/**
	 * draw the package's stand-ins (`DrawRole.Unsupported`) for content the viewer doesn't draw at all, in the
	 * unsupported checker; off skips them
	 */
	missingContent: boolean;
	/**
	 * cull the rows of groups whose LODs are all resident on the GPU, which writes their visible list and
	 * indirect draws; off (or without `indirect-first-instance`) culls every row on the CPU
	 */
	gpuCulling: boolean;
	/**
	 * with `gpuCulling`, skip the main pass for rows in view hidden behind the depth the main pass left last
	 * frame; they still cast shadows
	 */
	occlusionCulling: boolean;
	/**
	 * stream opaque materials' textures down to the mip levels the main pass sampled, read back from the GPU;
	 * off (or where the main pass has no room for the feedback target) streams them by their instances' size on
	 * screen
	 */
	mipFeedback: boolean;
	/**
	 * detail and conditional scenery draw within this distance of the camera, m; past it, HLOD clusters in the
	 * game's rings. 160 is the game's at its high scene detail on PC (256 at very high, 96 at its lowest)
	 */
	detailDistance: number;
	/** terrain sample spacing target, px */
	terrainPixels: number;
	/** boxes smaller than this on screen are culled, px */
	minBoxPixels: number;
	/** boxes with a half extent above this draw as outlines only, m */
	outlineMetres: number;
	/** streamed content budget, MiB */
	budgetMiB: number;
	/** stream material textures this many mip levels coarser than the view needs (each quarters their memory) */
	textureBias: number;
	/** render every frame instead of only on change (for measuring) */
	continuous: boolean;
	/** temporal antialiasing; off shows each frame as rendered */
	antialiasing: boolean;
	/** the render size relative to the canvas, (0, 1]; temporal antialiasing upsamples to the canvas */
	renderScale: number;
	/** exposure compensation on top of the level's exposure, EV */
	exposure: number;
	/** adapt the exposure to the view as the game's auto exposure does */
	autoExposure: boolean;
	tonemapper: Tonemapper;
	sky: boolean;
	heightFog: boolean;
	atmosphereFog: boolean;
	shadows: boolean;
	/** darken the sun under the environment's projected cloud shadow texture */
	cloudShadows: boolean;
	/** sway how much fog surfaces get with the environment's drifting 3D noise, where it has one */
	flowNoise: boolean;
	/** play animation (effects, particles, water, clouds, flow noise) on rendered frames; disabling freezes it */
	animate: boolean;
	water: boolean;
	/**
	 * how many times faster than the game water volumes move to the level their `waterLevel` control picks;
	 * `Infinity` jumps
	 */
	waterLevelRate: number;
	ao: boolean;
	/** screen-space reflections, as on puddles, wet floors and metal */
	reflections: boolean;
	bloom: boolean;
	vignette: boolean;
	/** light ambient from the baked irradiance volume; off uses the environment's ambient probe alone */
	irradiance: boolean;
	/** light surfaces and the volumetric fog with the package's point and spot lights */
	localLights: boolean;
	/** blend the game's environment volumes at the camera; off shows the level's base environment */
	environmentVolumes: boolean;
	/** an environment phase to show over the base instead of the volumes, or `null` */
	environmentPin: number | null;
	/** a material channel instead of the lit image */
	debugView: DebugView;
}

/** defaults for {@link ViewerOptions} */
export const DEFAULT_OPTIONS: ViewerOptions = {
	terrain: true,
	terrainSurface: true,
	terrainSplat: true,
	instances: true,
	detail: true,
	global: true,
	streamAreas: true,
	hlodTiers: [true, true, true],
	wireframe: false,
	boxes: true,
	unsupportedMaterials: false,
	missingContent: false,
	gpuCulling: true,
	occlusionCulling: true,
	mipFeedback: true,
	detailDistance: 160,
	terrainPixels: 3,
	minBoxPixels: 1.5,
	outlineMetres: 60,
	// the densest views (Wuling City at street level) want up to about 700 MiB of content
	budgetMiB: 768,
	textureBias: 0,
	continuous: false,
	antialiasing: true,
	renderScale: 1,
	exposure: 0,
	autoExposure: true,
	tonemapper: 'game',
	sky: true,
	heightFog: true,
	atmosphereFog: true,
	shadows: true,
	cloudShadows: true,
	flowNoise: true,
	animate: true,
	water: true,
	waterLevelRate: 1,
	ao: true,
	reflections: true,
	bloom: true,
	vignette: true,
	irradiance: true,
	localLights: true,
	environmentVolumes: true,
	environmentPin: null,
	debugView: 'lit',
};

/**
 * @param options the viewer's options
 * @param scene whether a package is loaded; auto exposure needs one
 * @returns the post chain's settings
 */
export const postSettings = (options: ViewerOptions, scene: boolean): PostSettings => ({
	exposure: options.exposure,
	autoExposure: options.autoExposure && scene,
	tonemapper: options.tonemapper,
	sky: options.sky,
	heightFog: options.heightFog,
	atmosphereFog: options.atmosphereFog,
	flowNoise: options.flowNoise,
	ao: options.ao,
	reflections: options.reflections,
	bloom: options.bloom,
	vignette: options.vignette,
	debugView: options.debugView,
});
