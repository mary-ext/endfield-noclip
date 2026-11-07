/**
 * steps of the shaders drawn as a texture stack (VFXBaseV2, VFXDitherAlpha's effect variants and VFXDecal),
 * whose tint and shared rows six-way smoke takes too
 */

import type {
	EffectStackSurface,
	EffectUvSource,
	EffectVertexOffset,
} from '@endfield-noclip/package-format/surfaces';
import type { Color } from '@endfield-noclip/package-format/values';

import { linearRgb, type MaterialReader, scaleRgb } from '../material-values.ts';

import {
	dissolveOf,
	disturbIntensityOf,
	type EffectSlot,
	effectTexture,
	nearFadeOf,
	ownSpeedOf,
	UNSET_WHITE,
} from './effect-steps.ts';

/** the rows the texture stack's effects share: blend layer, distortion, dissolve, near fade and post exposure */
export const stackSharedOf = (reader: MaterialReader, intensity: number) => ({
	blendTint: reader.colorOrVector('_BlendTint') ?? [1, 1, 1, 0],
	disturb: [...disturbIntensityOf(reader, 1), ...disturbIntensityOf(reader, 2)] satisfies [
		number,
		number,
		number,
		number,
	],
	dissolve: dissolveOf(reader, intensity),
	near: nearFadeOf(reader),
	ignorePostExposure: reader.float('_IgnorePostExposure', 1),
});

/** the tint of the stack shaders: the LDR `_TintColor` linearized, times its intensity, and its alpha */
export const stackTintOf = (reader: MaterialReader): { tint: Color; intensity: number } => {
	const { float, colorOrVector: color } = reader;
	const intensity = float('_TintColorIntensity', 1);
	const tint = color('_TintColor') ?? [1, 1, 1, 1];
	return {
		tint: [...scaleRgb(linearRgb(tint), intensity), tint[3] * float('_TintColorAlpha', 1)],
		intensity,
	};
};

const UV_SOURCES: readonly EffectUvSource[] = ['uv0', 'uv1', 'polar', 'screen'];

/**
 * which of UV0, UV1, polar and screen UVs a stack shader computes: polar and screen UVs only with their
 * keyword and switch, and are zero otherwise
 */
export const computedUvSources = ({ float, has }: MaterialReader): boolean[] => [
	true,
	true,
	has('_USE_POLARUV') && float('_UsePolarUV', 0) !== 0,
	has('_USE_SCREENUV') && float('_UseScreenUV', 0) !== 0,
];

/** a layer's UV source: the largest of its weights times UV0, UV1, polar and screen UVs, if computed */
export const sourceOf = (weights: readonly number[], computed: readonly boolean[]): EffectUvSource | null => {
	const largest = weights.indexOf(Math.max(...weights));
	return weights[largest] > 0 && computed[largest] ? UV_SOURCES[largest] : null;
};

/** how a stack shader's screen UVs are taken */
export const screenUvOf = ({ float }: MaterialReader): EffectStackSurface['screenUv'] => ({
	byDepth: float('_ScreenUVUseDepth', 1) !== 0,
	heightAsV: float('_UsePosYAsScreenV', 0) !== 0,
});

/** the material property of the vertex offset's texture */
const OFFSET_TEXTURE = '_OffsetTex';

/** @returns the vertex offset's texture: the bound slot, or white when unset and the shader defaults to it */
export const offsetSlotOf = (reader: MaterialReader): EffectSlot | null =>
	reader.slot(OFFSET_TEXTURE) ?? (reader.shader.textures[OFFSET_TEXTURE] === 'white' ? UNSET_WHITE : null);

/**
 * the vertex offset of VFXBaseV2 and VFXDitherAlpha: along `_OffsetDir` (or the normal) by `_OffsetIntensity`
 * times the offset texture's red, remapped by `_Bi_Offset`; the game scales it by `1 − _InParticle`
 */
export const vertexOffsetOf = (reader: MaterialReader): EffectVertexOffset | null => {
	const { float, colorOrVector: color, has } = reader;
	const slot = offsetSlotOf(reader);
	if (!has('_USE_VERTOFFSET') || float('_InParticle', 1) !== 0 || slot === null) {
		return null;
	}
	const dir = color('_OffsetDir') ?? [0, 0, 0, 0];
	// the shader tests for 1 and 2 exactly, and reads any other value as object space
	let space: EffectVertexOffset['space'] = 'object';
	switch (float('_OffsetSwitchDir', 0)) {
		case 1: {
			space = 'world';
			break;
		}
		case 2: {
			space = 'normal';
			break;
		}
		default: {
			break;
		}
	}
	return {
		// the vertex stage reads the scroll after the `_ST`, unscaled and unrotated
		// its speed's zw scroll by custom data only on particles, where the offset is off
		texture: effectTexture(slot, ownSpeedOf(reader, '_OffsetSpeed')),
		uv1: float('_OffsetUVSet', 0) !== 0,
		direction: [dir[0], dir[1], dir[2]],
		space,
		intensity: float('_OffsetIntensity', 0),
		bias: float('_Bi_Offset', 0),
		vertexAlphaWeight: 0,
		mask: null,
	};
};
