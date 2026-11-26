/**
 * what the viewer shows instead of the lit image, in the order of their `Frame.flags.y` codes: material
 * channels; `clouds`, the raw cloud panorama in place of the sky; and `gaps`, grey surfaces with amber
 * stripes on the meshes whose material is drawn without something the game draws (`MaterialLook.gaps`)
 */
export const DEBUG_VIEWS = ['lit', 'albedo', 'normals', 'roughness', 'ambient', 'clouds', 'gaps'] as const;

export type DebugView = (typeof DEBUG_VIEWS)[number];

/**
 * the tonemapping curves the final pass offers, in the order of their `Post.grade.w` codes: the game's
 * modified ACES (its `TonemappingMode.ACES_modified`), Khronos PBR Neutral (not the game's own `Neutral`
 * mode), or a clamp. the game's colour grading applies under the first two
 */
export const TONEMAPPERS = ['game', 'pbr neutral', 'none'] as const;

export type Tonemapper = (typeof TONEMAPPERS)[number];

/** what the post chain shows; mirrors the viewer's look options */
export interface PostSettings {
	/** exposure compensation, EV */
	exposure: number;
	/** follow the game's auto exposure on top of the compensation */
	autoExposure: boolean;
	tonemapper: Tonemapper;
	sky: boolean;
	heightFog: boolean;
	atmosphereFog: boolean;
	/** sway the fog with the environment's flow noise */
	flowNoise: boolean;
	ao: boolean;
	/** screen-space reflections */
	reflections: boolean;
	bloom: boolean;
	vignette: boolean;
	/** TAA contrast-adaptive sharpening strength (0 when AA is off or in debug views; 0.3 matching the game) */
	sharpen: number;
	/** anything but `lit` shows the main pass as it is: no exposure, tonemapping, effects or water */
	debugView: DebugView;
}

/**
 * @param settings the settings asked for
 * @returns the settings in effect: debug views turn the look off
 */
export const effectiveSettings = (settings: PostSettings): PostSettings => {
	if (settings.debugView === 'lit') {
		return settings;
	}
	return {
		...settings,
		exposure: 0,
		autoExposure: false,
		tonemapper: 'none',
		heightFog: false,
		atmosphereFog: false,
		flowNoise: false,
		ao: false,
		reflections: false,
		bloom: false,
		vignette: false,
		sharpen: 0,
	};
};

/**
 * @param settings the post settings
 * @param autoExposure the auto exposure's state
 * @returns the linear exposure the tonemap pass multiplies the scene by
 */
export const postExposure = (settings: PostSettings, autoExposure: { readonly exposure: number }): number =>
	2 ** settings.exposure * (settings.autoExposure ? autoExposure.exposure : 1);
