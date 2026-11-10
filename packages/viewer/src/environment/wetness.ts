import type { RainConfig } from '@endfield-noclip/package-format/environment';

/**
 * the range (m) the wetness is full within, which also places the far fade: the game's rain occlusion map
 * covers 100 m, and that the coverage uses the same range is inferred
 * (docs/game-data/environment.md#wetness)
 */
const OCCLUSION_RANGE = 100;

/** floats of `Frame.wetness` */
const WETNESS_FLOATS = 12;

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
