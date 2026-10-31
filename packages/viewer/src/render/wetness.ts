/**
 * the rain wetness at the camera: the blended profile's `HGRainConfig` wetness fields as `frame.wgsl`'s
 * `rain_wet_surface` reads them (`Frame.wetness`). the game darkens and smooths every surface its deferred
 * lighting shades by these, whether or not rain falls (docs/game-data/environment.md#wetness).
 *
 * @module
 */

import type { RainConfig } from '@endfield-noclip/package-format/environment';

/**
 * the game's rain occlusion map range (`rainOcclusionMapRange` of its rain presetting asset, m), which also
 * places the far fade. the asset wasn't found; this is a guess within the field's 1–200 range
 */
const OCCLUSION_RANGE = 100;

/** floats of `Frame.wetness` */
export const WETNESS_FLOATS = 12;

/**
 * @param rain the profile's rain section, or `undefined` when the profile has none
 * @returns `Frame.wetness`: (wetness, base porosity, porosity factor, occlusion range), (far distance factor,
 *   far wetness, sheltered wetness, vertical wetness), (standing water threshold, 0, 0, 0); all zero, and so
 *   dry, when wetness is off
 */
export const wetnessParams = (rain: RainConfig | undefined): Float32Array => {
	const params = new Float32Array(WETNESS_FLOATS);
	if (rain === undefined || !rain.enableWetness || rain.wetness <= 0) {
		return params;
	}
	params.set([rain.wetness, rain.wetnessBasePorosity, rain.wetnessPorosityFactor, OCCLUSION_RANGE], 0);
	params.set(
		[
			rain.farSceneWetnessDistanceFactor,
			rain.farSceneWetnessValue,
			rain.baseWetnessLevel,
			rain.verticalWetnessScalar,
		],
		4,
	);
	// the game's high-quality wetness ripple feature, which also lays the standing water, is off at 0 or below
	params[8] = Math.max(0, rain.rippleRoughnessMaskThreshold);
	return params;
};
