import type { LitSway } from '@endfield-noclip/package-format/surfaces';

import type { MaterialReader } from '../material-values.ts';

/**
 * `_SIMPLE_VERTEXANIM_CLOTH`'s sway (`docs/game-data/materials.md#swaying-cloth`). `_GPU_CLOTH` materials are
 * left still: their cloth simulation isn't decoded
 *
 * @param reader an `HGRP/Lit` material's properties
 * @returns its sway, or `null` when it keeps still
 */
export const swayOf = (reader: MaterialReader): LitSway | null => {
	const { float, has } = reader;
	const intensity = float('_SimpleVertexAnimationWindIntensity', 0);
	// the shader skips the sway when this sum is zero; the noise offset itself moves nothing in this variant
	const enabled = intensity + float('_NoiseOffsetIntensity', 0) !== 0;
	if (!has('_SIMPLE_VERTEXANIM') || !has('_SIMPLE_VERTEXANIM_CLOTH') || has('_GPU_CLOTH') || !enabled) {
		return null;
	}
	let direction: LitSway['direction'] = null;
	if (float('_Use_Custom_WindDir', 0) !== 0) {
		// the shader approximates cos and sin by their Taylor series; at authored angles they agree to 1e-3
		const angle = (float('_MainDirectionAngle', 0) * Math.PI) / 180;
		direction = [Math.cos(angle), Math.sin(angle)];
	}
	return {
		intensity,
		frequency: float('_SimpleVertexAnimationWindFreq', 1),
		softness: float('_SimpleVertexAnimationWindSoftFactor', 0),
		kite: float('_Kite', 0),
		tendency: float('_DirectionTendency', 0),
		direction,
	};
};
