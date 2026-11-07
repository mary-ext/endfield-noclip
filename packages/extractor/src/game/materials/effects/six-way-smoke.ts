import type {
	DisturbLayer,
	SixWaySmokeSurface,
	SixWayTexture,
	SixWayUvSource,
	UnsupportedSurface,
} from '@endfield-noclip/package-format/surfaces';

import { undrawnBlend, undrawnKeywords } from '../describe-steps.ts';
import { type MaterialReader, unsupported } from '../material-values.ts';

import {
	brightenOf,
	degreesRotation,
	disturbIntensityOf,
	type EffectSlot,
	effectTexture,
	softBlendOf,
	speedOf,
	UNSET_WHITE,
} from './effect-steps.ts';
import { stackSharedOf, stackTintOf } from './texture-stack.ts';

/** six-way smoke keywords that are drawn; it's drawn only with its lightmaps (`_USE_SIXWAY_LIGHTMAP`) */
const SIX_WAY_KEYWORDS = new Set([
	'_USE_SIXWAY_LIGHTMAP',
	'_USE_DISTURB',
	'_USE_DISTURB_TEX2',
	'_USE_MASK',
	'_USE_BLEND',
	'_USE_DISSOLVE',
	'_USE_SOFTBLEND',
	'_USE_FOG',
	'_USE_POLARUV',
	'_USE_SCREENUV',
]);

/**
 * `HGRP/Effect/VFXSmoke_SixWay` (`docs/game-data/effects.md#six-way-smoke`)
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported` for keywords, blending or UV sources the viewer doesn't draw
 */
export const describeSixWaySmoke = (reader: MaterialReader): SixWaySmokeSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has } = reader;
	const undrawn = undrawnBlend(reader, ['alphaBlend']) ?? undrawnKeywords(reader, SIX_WAY_KEYWORDS);
	if (undrawn !== null) {
		return undrawn;
	}
	if (!has('_USE_SIXWAY_LIGHTMAP')) {
		return unsupported('no six-way lightmaps');
	}
	if (float('_BlendMode', 0) !== 0) {
		return unsupported(`_BlendMode ${float('_BlendMode', 0)}`);
	}
	// these pick UV set 1: on particles the UV2 stream, the particle's own UVs without a texture sheet (the next
	// frame's with one), which the viewer takes as UV0; on meshes their UV1, which this look doesn't read
	if ((float('_MaskUVSet', 0) !== 0 || float('_DissolveUVSet', 0) !== 0) && float('_InParticle', 0) === 0) {
		return unsupported('a mask or dissolve on UV set 1');
	}
	// the shader has these keywords only together; with them each texture's `*SwitchUV` picks its UVs
	const switched = has('_USE_POLARUV') && has('_USE_SCREENUV');
	if (!switched && (has('_USE_POLARUV') || has('_USE_SCREENUV'))) {
		return unsupported('_USE_POLARUV without _USE_SCREENUV, or the reverse');
	}
	/** where a texture's UVs start: 1 the screen, 2 polar UVs; the shader reads UV0 for any other value */
	const switchedSource = (prefix: string): SixWayUvSource => {
		const screenByDepth = float(`${prefix}ScreenDepthUV`, 0) !== 0;
		switch (switched ? float(`${prefix}SwitchUV`, 0) : 0) {
			case 1: {
				return { source: 'screen', screenByDepth };
			}
			case 2: {
				return { source: 'polar', screenByDepth };
			}
			default: {
				return { source: 'uv0', screenByDepth };
			}
		}
	};
	/** a used slot; the shader samples every texture on UV set 0, or the default when none is bound */
	const used = (name: string): EffectSlot | null | 'uv' => {
		const slot = reader.slot(name);
		if (slot === undefined) {
			return reader.shader.textures[name] === 'white' ? UNSET_WHITE : null;
		}
		return slot.uv === 0 ? slot : 'uv';
	};
	/** the shader turns UVs after the scroll and before the `_ST` */
	const turned = (prefix: string): [cos: number, sin: number] =>
		degreesRotation(float(`${prefix}UVRotate`, 0));
	const positive = used('_PositiveAxesLightmap');
	const negative = used('_NegativeAxesLightmap');
	const mask = has('_USE_MASK') ? used('_MaskTex') : null;
	const blend = has('_USE_BLEND') ? used('_BlendTex') : null;
	const dissolve = has('_USE_DISSOLVE') ? used('_DissolveTex') : null;
	const disturb1 = has('_USE_DISTURB') ? used('_DisturbTex1') : null;
	const disturb2 = has('_USE_DISTURB') && has('_USE_DISTURB_TEX2') ? used('_DisturbTex2') : null;
	if (
		positive === 'uv' ||
		negative === 'uv' ||
		mask === 'uv' ||
		blend === 'uv' ||
		dissolve === 'uv' ||
		disturb1 === 'uv' ||
		disturb2 === 'uv'
	) {
		return unsupported('a texture on a UV set other than 0');
	}
	if (positive === null || negative === null) {
		return unsupported('no lightmaps');
	}
	// the lightmaps take `_LightMapControls` in place of their `_ST`
	const controls = color('_LightMapControls') ?? [1, 1, 0, 0];
	const lightmap: SixWayTexture = {
		...effectTexture(
			{ texture: positive.texture, scale: [controls[0], controls[1]], offset: [controls[2], controls[3]] },
			speedOf(reader, '_LightMapUVSpeed'),
			turned('_LightMap'),
		),
		...switchedSource('_LightMap'),
		disturbShare: float('_LightMapUseDisturb', 0),
	};
	const layer = (slot: EffectSlot, prefix: string, share: string, source: SixWayUvSource): SixWayTexture => ({
		...effectTexture(slot, speedOf(reader, `${prefix}UVSpeed`), turned(prefix)),
		...source,
		disturbShare: float(share, 0),
	});
	// UV set 1 replaces the dissolve's switched UVs; on particles it holds UV0's (above)
	const dissolveSource: SixWayUvSource =
		float('_DissolveUVSet', 0) !== 0 ? { source: 'uv0', screenByDepth: false } : switchedSource('_Dissolve');
	const disturbLayer = (slot: EffectSlot | null, n: 1 | 2): DisturbLayer | null =>
		slot === null
			? null
			: {
					texture: effectTexture(slot, speedOf(reader, `_DisturbUVSpeed${n}`)),
					intensity: disturbIntensityOf(reader, n),
					normal: float(`_DisturbTex${n}Normal`, 0) !== 0,
				};
	const { tint, intensity } = stackTintOf(reader);
	const shared = stackSharedOf(reader, intensity);
	return {
		kind: 'sixWaySmoke',
		positive: lightmap,
		negative: negative.texture,
		disturb: [disturbLayer(disturb1, 1), disturbLayer(disturb2, 2)],
		disturbSource: switchedSource('_Disturb'),
		disturbBias: float('_Bi_Disturb', 0),
		screenHeightAsV: float('_UsePosYAsScreenV', 0) !== 0,
		mask:
			mask === null
				? null
				: {
						texture: layer(mask, '_MaskTex', '_MaskTexUseDisturb', switchedSource('_Mask')),
						redAlpha: float('_UseMaskTexAsAlpha', 1) !== 0,
					},
		// the black default adds nothing
		blend: blend === null ? null : layer(blend, '_BlendTex', '_BlendTexUseDisturb', switchedSource('_Blend')),
		blendTint: shared.blendTint,
		dissolve:
			dissolve === null
				? null
				: {
						...shared.dissolve,
						texture: layer(dissolve, '_Dissolve', '_DissolveTexUseDisturb', dissolveSource),
					},
		tint,
		vertexColor: float('_DisableVertColor', 0) === 0,
		brighten: brightenOf(reader),
		// as the shader derives it
		absorptionRange: (float('_AbsorptionRange', 1) + 1 / Math.PI) / (1 - 1 / Math.PI),
		envSaturation: float('_EnvLightSaturation', 1),
		soft: softBlendOf(reader),
		near: shared.near,
		unfogged: !has('_USE_FOG'),
	};
};
