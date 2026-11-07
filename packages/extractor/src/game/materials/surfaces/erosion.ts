import type { TextureSlot } from '@endfield-noclip/package-format/materials';
import type { ErosionSurface } from '@endfield-noclip/package-format/surfaces';
import type { Rgb } from '@endfield-noclip/package-format/values';

import { tiledSlot } from '../describe-steps.ts';
import { linearRgb, type MaterialReader } from '../material-values.ts';

/**
 * `HGRP/Erosion` (`docs/game-data/materials.md#erosion`). every map samples UV set 0 and tiles by its own
 * property rather than its `_ST`; the metal, noise and flow colours are HDR and used as stored
 *
 * @param reader the material's properties
 * @returns its surface
 */
export const describeErosion = (reader: MaterialReader): ErosionSurface => {
	const { float, color } = reader;
	const tiled = (name: string, tiling: string | null): TextureSlot | null => {
		const slot = reader.slot(name);
		return slot === undefined ? null : tiledSlot(slot, tiling === null ? 1 : float(tiling, 1), 0);
	};
	const hdr = (name: string): Rgb => {
		const value = color(name) ?? [1, 1, 1, 1];
		return [value[0], value[1], value[2]];
	};
	return {
		kind: 'erosion',
		textures: {
			baseNormal: tiled('_BaseNormalMap', '_BaseNormalTilling'),
			metalMix: tiled('_MetalMixMap', null),
			flowRamp: tiled('_FlowRampMap', null),
			detailNormal: tiled('_DetailNormalMap', '_DetailNormalTilling'),
			noisePattern: tiled('_NoisePatternMap', '_NoisePatternMapTilling'),
		},
		baseColor: linearRgb(color('_BaseColor') ?? [1, 1, 1, 1]),
		roughness: float('_Roughness', 0),
		detailRoughnessCover: float('_DetailRoughnessCover', 0),
		metallic: float('_Metallic', 0),
		metallicOffset: float('_MetallicOffset', 0),
		metallicColor: hdr('_MetallicColor'),
		normalScale: float('_NormalScale', 1),
		detailNormalScale: float('_DetailNormalScale', 1),
		occlusionStrength: float('_OcclusionStrength', 1),
		f0: 0.08 * float('_Specular', 0.5),
		noise: {
			depth: float('_NoiseStrength', 0),
			tint: hdr('_NoisePatternTintColor'),
			alphaTint: hdr('_NoisePatternAlphaTintColor'),
			min: float('_NoiseMin', 0),
			emissiveStrength: float('_NoiseEmissiveStrength', 0),
			fadeDistance: float('_DistanceBlend', 1),
		},
		flow: {
			tiling: float('_FlowNormalTilling', 0),
			noiseStrength: float('_FlowNoiseStrength', 0),
			// 0.05 · speed per second (docs/game-data/materials.md#clock)
			scroll: 0.05 * float('_FlowNormalSpeed', 0),
			speedOffset: float('_FlowSpeedOffset', 0),
			colorOffset: float('_FlowColorOffset', 0),
			top: hdr('_FlowTopColor'),
			bottom: hdr('_FlowBottomColor'),
			colorStrength: float('_FlowColorStrength', 0),
			emissiveStrength: float('_FlowColorEmissiveStrength', 0),
			roughness: float('_FlowRoughness', 0),
		},
	};
};
