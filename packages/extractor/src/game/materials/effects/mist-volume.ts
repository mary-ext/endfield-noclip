import type { MistVolumeSurface, UnsupportedSurface } from '@endfield-noclip/package-format/surfaces';

import { undrawnBlend } from '../describe-steps.ts';
import { linearRgb, type MaterialReader } from '../material-values.ts';

/**
 * `HGRP/Effect/VFXFakeVolumeFog` (`docs/game-data/effects.md#mist`), drawn only when additive
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported`
 */
export const describeMistVolume = (reader: MaterialReader): MistVolumeSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has } = reader;
	const undrawn = undrawnBlend(reader, ['additive']);
	if (undrawn !== null) {
		return undrawn;
	}
	const fog = color('_FogColor') ?? [1, 1, 1, 1];
	const noiseSlot = reader.slot('_NoiseTex3D');
	let noise: MistVolumeSurface['noise'] = null;
	if (has('_USE_NOISE3D') && noiseSlot !== undefined) {
		const tiling = color('_NoiseTexTilling1') ?? [1, 1, 1, 1];
		const dir = color('_NoiseUVWDir1') ?? [0, 0, 0, 0];
		const speed = float('_NoiseUVWSpeed1', 0);
		noise = {
			texture: noiseSlot.texture,
			tiling: [tiling[0], tiling[1], tiling[2]],
			world: float('_NoiseTexUseWorldUVW', 1) !== 0,
			flow: [dir[0] * speed, dir[1] * speed, dir[2] * speed],
			nearIntensity: float('_NoiseIntensity', 1),
			farIntensity: float('_NoiseFarIntensity', 1),
			farPerMetre: 0.1 / Math.max(float('_NoiseFar', 1), 1e-3),
		};
	}
	return {
		kind: 'mistVolume',
		color: [...linearRgb(fog), fog[3] * float('_TintColorAlpha', 1)],
		exponent: float('_FogExponent', 1),
		density: float('_FogDensity', 1),
		edgeFade: Math.max(float('_CubEdgeFade', 1), 1e-3),
		nearFade: float('_canWalkIn', 0) !== 0 ? 0 : Math.max(float('_NearFadeDistance', 1), 1e-3),
		height: {
			offset: float('_HeightOffset', 0),
			falloff: float('_HeightFalloff', 0),
			verticalFalloff: [float('_VerticalFalloffMin', 0), float('_VerticalFalloffMax', 0)],
		},
		intensityFadeDistance: Math.max(float('_FogIntensityFadeDistance', 1e5), 1e-3),
		intensityFadeFromCentre: float('_FogIntensityFadeUseCenter', 0),
		depth: [float('_FogDepthStart', 0), float('_FogDepthEnd', 0)],
		ignorePostExposure: float('_IgnorePostExposure', 1),
		noise,
	};
};
