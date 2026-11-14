import type { FlowGlow, LitSurface, UnsupportedSurface } from '@endfield-noclip/package-format/surfaces';

import { pastUvSets } from '../describe-steps.ts';
import { isUnsupported, type MaterialReader, scaleRgb, unsupported } from '../material-values.ts';

import { describeLit } from './lit.ts';

/**
 * `HGRP/Foliage/Glow` (`docs/game-data/materials.md#glowing-foliage`): Lit's two-basemap surface without its
 * remaps, glowing by the base colour's alpha, with `_DISTORTION_FLOW`'s flowing glow on top
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported`
 */
export const describeFoliageGlow = (reader: MaterialReader): LitSurface | UnsupportedSurface => {
	const { float, color, has } = reader;
	const lit = describeLit(reader);
	if (isUnsupported(lit)) {
		return lit;
	}
	let overlay: FlowGlow | null = null;
	if (has('_DISTORTION_FLOW')) {
		const noise = reader.slot('_FoliageGlowNoise');
		if (noise === undefined) {
			return unsupported('_DISTORTION_FLOW without its noise');
		}
		const uv = float('_DistortionUVSet', 0) >= 0.5 ? 1 : 0;
		// a fractional UV set mixes the two, which no material sets
		if (uv !== float('_DistortionUVSet', 0)) {
			return unsupported(`_DistortionUVSet ${float('_DistortionUVSet', 0)}`);
		}
		const set = pastUvSets('_FoliageGlowNoise', noise);
		if (set !== null) {
			return set;
		}
		overlay = {
			kind: 'flowGlow',
			// the shader ignores the slot's `_ST`
			noise: { texture: noise.texture, uv, scale: [1, 1], offset: [0, 0] },
			color: scaleRgb(color('_DistortionColor') ?? [0, 0, 0, 1], 1),
			luminanceBase: float('_DistortionLuminanceBase', 0),
			scales: [float('_DistortionFlowScale1', 1), float('_DistortionFlowScale2', 1)],
			speeds: [float('_DistortionFlowSpeed1', 0), float('_DistortionFlowSpeed2', 0)],
			warp: float('_DistortionFlowWarp', 0),
			multiplier: float('_DistortionFlowMultiplier', 1),
			bias: float('_DistortionFlowBias', 0),
			vertexRed: float('_VertexColorRControlDistortion', 0),
		};
	}
	const emissive = color('_EmissiveColor');
	return {
		...lit,
		// roughness is the normal map's B and occlusion its A, as read; metallic is always 0
		layout: 'twoBasemap',
		metallicFromBaseAlpha: false,
		textures: { ...lit.textures, mro: null, emissive: null },
		brighterScale: 1,
		roughness: [0, 1],
		metallic: 0,
		occlusionStrength: 1,
		// always on, by the base colour's alpha
		emission:
			emissive === undefined
				? null
				: {
						color: scaleRgb(emissive, 1),
						source: 'mask',
						maskChannel: 1,
						channels: null,
						albedoAffect: float('_EmissiveIgnoreAlbedo', 0),
						ignorePostExposure: float('_IgnorePostExposure', 1),
						albedoTint: null,
						pulse: null,
					},
		overlay,
		sway: null,
		vertexOffset: null,
	};
};
