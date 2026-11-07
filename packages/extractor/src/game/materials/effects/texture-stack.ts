/**
 * steps of the shaders drawn as a texture stack (VFXBaseV2, VFXDitherAlpha's effect variants, VFXAdvance and
 * VFXDecal), whose tint and shared rows six-way smoke takes too
 */

import type {
	EffectAppear,
	EffectStackSurface,
	EffectUvSource,
	EffectVertexOffset,
	UnsupportedSurface,
} from '@endfield-noclip/package-format/surfaces';
import type { Color } from '@endfield-noclip/package-format/values';

import { linearRgb, type MaterialReader, scaleRgb, unsupported } from '../material-values.ts';

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
	localPivot: float('_LocalPivortSpace', 0) !== 0,
	byDepth: float('_ScreenUVUseDepth', 1) !== 0,
	heightAsV: float('_UsePosYAsScreenV', 0) !== 0,
});

/** keywords of the reveal around the player, which VFXAdvance and VFXDitherAlpha draw together */
export const APPEAR_KEYWORDS: ReadonlySet<string> = new Set(['_USE_BRIGHT', '_USE_GLOBAL_APPEAR']);

/**
 * the reveal around the player of VFXAdvance and VFXDitherAlpha: `_USE_BRIGHT`'s radial brightening and alpha
 * fade, with `_USE_GLOBAL_APPEAR` adding the global radii the fire seed sets to the material's
 *
 * @returns the reveal, `null` without `_USE_BRIGHT`, or `unsupported` for `_USE_GLOBAL_APPEAR` alone and for
 *   brightenings that aren't radial about the player
 */
export const appearOf = (reader: MaterialReader): EffectAppear | UnsupportedSurface | null => {
	const { float, colorOrVector: color, has } = reader;
	const bright = has('_USE_BRIGHT');
	const global = has('_USE_GLOBAL_APPEAR');
	if (!bright) {
		return global ? unsupported('_USE_GLOBAL_APPEAR without _USE_BRIGHT') : null;
	}
	if (float('_BrightType', 0) !== 0) {
		return unsupported(`_BrightType ${float('_BrightType', 0)}`);
	}
	if ((color('_BrightCenter')?.[3] ?? 0) !== 0) {
		return unsupported('a brightening about a fixed point');
	}
	const brightColor = color('_BrightColor') ?? [0, 0, 0, 0];
	return {
		global,
		inner: float('_InnerRadius', 0),
		outer: float('_OuterRadius', 0),
		alphaFar: float('_DistortAlpha', 1),
		edge: float('_DistortOnEdge', 0),
		noiseScale: float('_DistortScale', 1),
		noiseSpeed: float('_DistortSpeed', 0),
		// added to the tint, so linearized as the tint is
		brightColor: [...linearRgb(brightColor), brightColor[3]],
		brightVertexAlpha: float('_BrightUseVertColor', 0) !== 0,
		characterHeight: float('_CharacterHeight', 0),
	};
};

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
