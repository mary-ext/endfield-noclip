import type {
	EffectTexture,
	UnsupportedSurface,
	WaterFoamSurface,
} from '@endfield-noclip/package-format/surfaces';

import { undrawnKeywords } from '../describe-steps.ts';
import { type MaterialReader, unsupported } from '../material-values.ts';

import { dissolveOf, disturbIntensityOf, effectTexture, speedOf, UNSET_WHITE } from './effect-steps.ts';

/** WaterDecal keywords that are drawn; `_BLEND_BASECOLOR` must be among them */
const WATER_FOAM_KEYWORDS = new Set([
	'_BLEND_BASECOLOR',
	'_USE_DISTURB',
	'_USE_MASK',
	'_USE_SOFTBLEND',
	'_USE_DISSOLVE',
]);

/**
 * `HGRP/WaterDecal`: foam projected onto the water surface inside a box, written into the water's foam colour
 * (`docs/game-data/water.md#waterdecal`)
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported` for the variants the viewer doesn't draw
 */
export const describeWaterFoam = (reader: MaterialReader): WaterFoamSurface | UnsupportedSurface => {
	// the pass fixes its premultiplied blend, so the material's blend properties don't say it
	const { float, colorOrVector: color, has } = reader;
	const keywords = undrawnKeywords(reader, WATER_FOAM_KEYWORDS);
	if (keywords !== null) {
		return keywords;
	}
	// without it the base colour map isn't blended in, and only `_BaseColor`'s constant would be written
	if (!has('_BLEND_BASECOLOR')) {
		return unsupported('no _BLEND_BASECOLOR');
	}
	const zTest = float('_ZTest', 4);
	if (zTest !== 4 && zTest !== 5) {
		return unsupported(`_ZTest ${zTest}`);
	}
	const textureOf = (name: string, speed: string): EffectTexture =>
		effectTexture(reader.slot(name) ?? UNSET_WHITE, speedOf(reader, speed));
	const edgeRange = color('_EdgeFadeRange') ?? [0, 0, 0, 0];
	let dissolve: WaterFoamSurface['dissolve'] = null;
	if (has('_USE_DISSOLVE')) {
		// the edge colour is used as stored
		dissolve = { texture: textureOf('_DissolveTex', '_DissolveUVSpeed'), ...dissolveOf(reader, 1) };
	}
	const base = color('_BaseColor') ?? [0, 0, 0, 0];
	const tint = color('_BaseColorTint') ?? [1, 1, 1, 1];
	return {
		kind: 'waterFoam',
		textures: {
			base: textureOf('_BaseColorMap', '_BaseColorSpeed'),
			disturb: has('_USE_DISTURB') ? textureOf('_DisturbTex1', '_DisturbUVSpeed1') : null,
			mask: has('_USE_MASK') ? textureOf('_MaskTex', '_MaskTexUVSpeed') : null,
		},
		sources: {
			base: float('_BaseColorSwitchUV', 0),
			disturb: float('_DisturbSwitchUV', 0),
			mask: float('_MaskUVSet', 0),
			dissolve: float('_DissolveSwitchUV', 0),
		},
		maskMatrix: color('_MaskTexUVRotateMatrix') ?? [1, 0, 0, 1],
		boxUv: color('_UVScaleOffset') ?? [1, 1, 0, 0],
		baseColor: [base[0], base[1], base[2]],
		tint: [tint[0], tint[1], tint[2]],
		baseAlpha: float('_UseAChannelAsAlpha', 0),
		maskAsAlpha: float('_UseMaskTexAsAlpha', 0),
		disturbBias: float('_Bi_Disturb', 0),
		disturb: disturbIntensityOf(reader, 1),
		disturbUse: [
			float('_MainTexUseDisturb', 0),
			float('_MaskTexUseDisturb', 0),
			float('_DissolveTexUseDisturb', 0),
		],
		edgeFade: float('_UseEdgeFade', 0) !== 0 ? [edgeRange[0], edgeRange[1]] : null,
		clipToBox: float('_MeshType', 0) !== 0,
		depthTest: zTest === 4 ? 'less-equal' : 'greater',
		blendMode: float('_BlendMode', 0),
		opacity: float('_OverallOpacity', 1),
		soft: has('_USE_SOFTBLEND')
			? { distance: Math.max(float('_SoftDistance', 1), 1e-6), bias: float('_SoftBias', 0) }
			: null,
		dissolve,
	};
};
