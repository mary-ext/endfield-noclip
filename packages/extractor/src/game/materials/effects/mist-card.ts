import type { MistCardSurface, UnsupportedSurface } from '@endfield-noclip/package-format/surfaces';

import { undrawnBlend, undrawnKeywords } from '../describe-steps.ts';
import { type MaterialReader, unsupported } from '../material-values.ts';

import { fadeRange, softBlendOf } from './effect-steps.ts';

/**
 * card keywords that are drawn. `_USE_LIGHTING` lights by the mesh normal rather than the game's normal map,
 * and `_USE_FOG`'s own fog isn't drawn (premultiplied cards take the composite's fog, additive ones none)
 */
const MIST_CARD_KEYWORDS = new Set(['_USE_FOG', '_USE_SOFTBLEND', '_USE_LIGHTING']);

/**
 * `HGRP/FogSimple` (`docs/game-data/effects.md#mist`)
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported`
 */
export const describeMistCard = (reader: MaterialReader): MistCardSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has, material } = reader;
	const undrawn =
		undrawnBlend(reader, ['premultiplied', 'additive']) ?? undrawnKeywords(reader, MIST_CARD_KEYWORDS);
	if (undrawn !== null) {
		return undrawn;
	}
	const main = reader.slot('_MainTex');
	const noise = reader.slot('_NoiseTex');
	if (main === undefined || noise === undefined) {
		return unsupported('no main or noise texture');
	}
	if (main.uv > 1 || noise.uv > 1) {
		return unsupported('a texture on a UV set past 1');
	}
	const separate = float('_UseSeparateScale', 0) !== 0;
	const windScale = float('_WindScale', 1);
	// `_BaseColor` and `_IndirectColor` are [HDR]: authored linear, used as stored
	const indirect = color('_IndirectColor') ?? [0, 0, 0, 1];
	return {
		kind: 'mistCard',
		main,
		noise,
		color: color('_BaseColor') ?? [1, 1, 1, 1],
		baseAlphaIntensity: float('_BaseAlphaIntensity', 1),
		noiseIntensity: float('_FogNoiseIntensity', 0),
		useWind: float('_UseWind', 0),
		wind: {
			noiseIntensity: float('_WindNoiseIntensity', 0),
			noiseContrast: float('_WindNoiseContrast', 0),
			scale: [
				windScale * (separate ? float('_WindScaleX', 1) : 1),
				windScale * (separate ? float('_WindScaleY', 1) : 1),
			],
			speed: float('_WindSpeed', 0),
			direction: [float('_WindDirX', 1), float('_WindDirY', 0)],
		},
		lit: has('_USE_LIGHTING') && float('_UseLighting', 0) !== 0,
		lightFactor: float('_LightFactor', 0),
		indirectColor: [indirect[0], indirect[1], indirect[2]],
		additive: material.blend === 'additive',
		distanceFade: fadeRange(float('_DistanceFadeStart', 0), float('_DistanceFadeEnd', 0)),
		nearFade: fadeRange(float('_NearCameraFadeDistanceStart', 0), float('_NearCameraFadeDistanceEnd', 0)),
		topFade: { contrast: float('_TopFadeContract', 1), offset: float('_TopFadeOffset', 0) },
		softDistance: softBlendOf(reader)?.distance ?? 0,
	};
};
