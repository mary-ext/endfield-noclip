import type {
	EffectMain2,
	EffectStackSurface,
	StackLayer,
	UnsupportedSurface,
} from '@endfield-noclip/package-format/surfaces';
import type { Rgb } from '@endfield-noclip/package-format/values';

import { pastUvSets, undrawnKeywords } from '../describe-steps.ts';
import { isUnsupported, linearRgb, type MaterialReader, unsupported } from '../material-values.ts';
import { isLitDither, NO_LIGHTING_SHADER } from '../surfaces/dithered.ts';

import { effectTexture, matrixRotationOf, speedOf, UNSET_WHITE } from './effect-steps.ts';
import {
	APPEAR_KEYWORDS,
	appearOf,
	computedUvSources,
	screenUvOf,
	sourceOf,
	stackSharedOf,
	stackTintOf,
	vertexOffsetOf,
} from './texture-stack.ts';

/** keywords of VFXDitherAlpha's effect variants that are drawn */
const DITHER_EFFECT_KEYWORDS = new Set([
	'_USE_DISSOLVE',
	'_USE_DISTURB',
	'_USE_MASK',
	'_USE_POLARUV',
	'_USE_SCREENUV',
]);

/**
 * keywords VFXDitherAlpha's effect variants also draw, alongside one of {@link DITHER_EFFECT_KEYWORDS}.
 * `_INK_DISTORT` shifts the UVs by the runtime ink simulation, which leaves them alone where it hasn't run,
 * as VFXAdvance's does
 */
const DITHER_EFFECT_EXTRA_KEYWORDS = new Set(['_USE_VERTOFFSET', '_USE_MAIN2', '_INK_DISTORT']);

/**
 * keywords of VFXDitherAlphaNoLighting's effect variants that are drawn: those whose passes match
 * VFXDitherAlpha's. the others (a dissolve, polar or screen UVs, `_USE_MAIN2`, `_INK_COLOR_DISTORT`) are
 * unread
 */
const NO_LIGHTING_EFFECT_KEYWORDS = new Set(['_USE_DISTURB', '_USE_MASK', '_USE_VERTOFFSET']);

/** the stack slot of VFXDitherAlpha's `_USE_MAIN2` texture, past the fixed slots' 0–3 */
const MAIN2_SLOT = 4;

/**
 * whether an unlit `HGRP/Effect/VFXDitherAlpha` material has a `_USE_MAIN2` second texture that colours or
 * blends rather than simply tint-multiplying the base colour (which {@link describeDithered} folds into
 * `color`)
 */
const hasMain2Layer = (reader: MaterialReader): boolean =>
	reader.shader.name === 'HGRP/Effect/VFXDitherAlpha' &&
	reader.has('_USE_MAIN2') &&
	!isLitDither(reader) &&
	(reader.float('_UseMainTex2AsAlpha', 1) === 0 || reader.float('_MainTex2BlendMode', 0) !== 0);

/**
 * @param reader the material's properties
 * @returns whether a VFXDitherAlpha or VFXDitherAlphaNoLighting material is one of the effect variants (a
 *   distortion, dissolve, mask, polar or screen UVs, or an unlit `_USE_MAIN2` blend layer), drawn as a
 *   texture stack rather than a dithered surface. a lit material whose only such keyword is the mask stays a
 *   dithered surface, which keeps its lighting and tests the mask
 */
export const isDitherEffect = (reader: MaterialReader): boolean => {
	if (reader.shader.name !== 'HGRP/Effect/VFXDitherAlpha' && reader.shader.name !== NO_LIGHTING_SHADER) {
		return false;
	}
	const effects = reader.material.keywords.filter((keyword) => DITHER_EFFECT_KEYWORDS.has(keyword));
	if (effects.length === 1 && effects[0] === '_USE_MASK' && isLitDither(reader)) {
		return false;
	}
	return effects.length > 0 || hasMain2Layer(reader);
};

/**
 * an unlit `HGRP/Effect/VFXDitherAlpha` or `…NoLighting` effect variant, optionally with a vertex offset, as
 * a texture stack. the game draws such a surface where its alpha beats a per-pixel noise; the viewer blends
 * it over by that alpha instead, which its temporal antialiasing would average the dither to anyway
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported`
 */
export const describeDitherEffect = (reader: MaterialReader): EffectStackSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has } = reader;
	let hasKeyword: (keyword: string) => boolean;
	if (reader.shader.name === NO_LIGHTING_SHADER) {
		hasKeyword = (keyword) => NO_LIGHTING_EFFECT_KEYWORDS.has(keyword);
	} else {
		hasKeyword = (keyword) =>
			DITHER_EFFECT_KEYWORDS.has(keyword) ||
			DITHER_EFFECT_EXTRA_KEYWORDS.has(keyword) ||
			APPEAR_KEYWORDS.has(keyword);
	}
	const keywords = undrawnKeywords(reader, { has: hasKeyword });
	if (keywords !== null) {
		return keywords;
	}
	// the depth pass tests the alpha after the reveal, as the stack blends by it
	const appear = appearOf(reader);
	if (isUnsupported(appear)) {
		return appear;
	}
	if (isLitDither(reader)) {
		return unsupported('a lit effect variant');
	}
	if (float('_DitherAlphaMode', 0) !== 0) {
		return unsupported(`_DitherAlphaMode ${float('_DitherAlphaMode', 0)}`);
	}
	if (has('_USE_SCREENUV') && float('_LocalPivortSpace', 0) !== 0) {
		return unsupported('screen UVs relative to the object');
	}
	const computed = computedUvSources(reader);
	// `_USE_MAIN2` combines a second colour texture with the main colour (`mix(main · main2, main + main2,
	// _MainTex2BlendMode)`); the depth pass has no `_USE_MAIN2` variant, so the tested alpha is unchanged.
	// when `_UseMainTex2AsAlpha` is set and `_MainTex2BlendMode` is 0, the shader only multiplies by
	// `_MainTex2Color`, which folds straight into `tint`
	let second: Rgb = [1, 1, 1];
	let main2: EffectMain2 | null = null;
	if (has('_USE_MAIN2')) {
		const redAlpha = float('_UseMainTex2AsAlpha', 1) !== 0;
		const blendMode = float('_MainTex2BlendMode', 0);
		const main2Color = linearRgb(color('_MainTex2Color') ?? [1, 1, 1, 1]);
		if (redAlpha && blendMode === 0) {
			second = main2Color;
		} else {
			const bound = redAlpha ? UNSET_WHITE : (reader.slot('_MainTex2') ?? UNSET_WHITE);
			const uvSet = pastUvSets('_MainTex2', bound);
			if (uvSet !== null) {
				return uvSet;
			}
			main2 = {
				slot: MAIN2_SLOT,
				texture: effectTexture(
					bound,
					speedOf(reader, '_MainTex2UVSpeed'),
					matrixRotationOf(reader, '_MainTex2UVRotateMat'),
				),
				source: sourceOf(color('_MainTex2UVWeights') ?? [1, 0, 0, 0], computed),
				disturbShare: float('_MainTex2UseDisturb', 1),
				redAlpha,
				color: main2Color,
				blendMode,
			};
		}
	}
	// the shader's slots and their properties; the distortion comes first, so it can shift the others
	const slots = [
		{
			name: '_MainTex',
			keyword: null,
			role: 'main',
			redAlpha: float('_UseMainTexAsAlpha', 1) !== 0,
			disturbed: '_MainTexUseDisturb',
			speed: '_MainTexUVSpeed',
			rotation: '_MainTexUVRotateMat',
			weights: '_MainTexUVWeights',
		},
		{
			name: '_DisturbTex1',
			keyword: '_USE_DISTURB',
			role: 'disturb1',
			redAlpha: false,
			disturbed: null,
			speed: '_DisturbUVSpeed1',
			rotation: '_DisturbUVRotateMat1',
			weights: '_DisturbUVWeights1',
		},
		{
			name: '_DissolveTex',
			keyword: '_USE_DISSOLVE',
			role: 'dissolve',
			redAlpha: false,
			disturbed: '_DissolveTexUseDisturb',
			speed: '_DissolveUVSpeed',
			rotation: '_DissolveUVRotateMat',
			weights: '_DissolveUVWeights',
		},
		{
			name: '_MaskTex',
			keyword: '_USE_MASK',
			role: 'mask',
			redAlpha: float('_UseMaskTexAsAlpha', 1) !== 0,
			disturbed: '_MaskTexUseDisturb',
			speed: '_MaskTexUVSpeed',
			rotation: '_MaskTexUVRotateMat',
			weights: '_MaskTexUVWeights',
		},
	] as const;
	const layers: (StackLayer | null)[] = Array.from({ length: 7 }, () => null);
	for (const [i, slot] of slots.entries()) {
		if (slot.keyword !== null && !has(slot.keyword)) {
			continue;
		}
		// an unset slot binds white, the shader's default for each of these
		const bound = reader.slot(slot.name) ?? UNSET_WHITE;
		const uvSet = pastUvSets(slot.name, bound);
		if (uvSet !== null) {
			return uvSet;
		}
		layers[i] = {
			...effectTexture(bound, speedOf(reader, slot.speed), matrixRotationOf(reader, slot.rotation)),
			role: slot.role,
			redAlpha: slot.redAlpha,
			source: sourceOf(color(slot.weights) ?? [1, 0, 0, 0], computed),
			disturbShare: slot.disturbed === null ? 0 : float(slot.disturbed, 1),
		};
	}
	// the tint's colour is the colour pass's and its alpha the depth pass's tested alpha
	// (docs/game-data/effects.md#solid-effects)
	const { tint: ownTint, intensity } = stackTintOf(reader);
	const tint: typeof ownTint = [
		ownTint[0] * second[0],
		ownTint[1] * second[1],
		ownTint[2] * second[2],
		ownTint[3],
	];
	const shared = stackSharedOf(reader, intensity);
	// VFXDitherAlpha draws in the G-buffer + DepthOnly pass; when nothing can lower the tested alpha below 1,
	// it is fully opaque and belongs in the main pass (`effectOpaque`, writing depth before transparent layers
	// such as the water switch's foreground icon, which may have a lower `m_SortingOrder`)
	const opaque =
		reader.slot('_MainTex') === undefined &&
		tint[3] >= 1 &&
		!has('_USE_DISSOLVE') &&
		!has('_USE_MASK') &&
		appear === null &&
		shared.near === null;
	return {
		kind: 'effectStack',
		variant: 'dither',
		layers,
		tint,
		blendTint: shared.blendTint,
		blendVertexColor: false,
		disturb: shared.disturb,
		disturbBias: float('_Bi_Disturb', 0),
		distorted: has('_USE_DISTURB'),
		disturbNormal: float('_DisturbTex1Normal', 0) !== 0,
		particleDisturb: false,
		weight: { disturb: 0, dissolve: 0, used: false },
		dissolve: has('_USE_DISSOLVE') ? shared.dissolve : null,
		masked: has('_USE_MASK'),
		// only the depth pass samples the mask, for the tested alpha; the colour pass doesn't
		maskAlphaOnly: true,
		fresnel: null,
		soft: null,
		ignorePostExposure: shared.ignorePostExposure,
		vertexColor: float('_DisableVertColor', 0) === 0,
		near: shared.near,
		brighten: { threshold: 1, intensity: 0 },
		breathing: null,
		edge: null,
		decalFade: null,
		// the depth pass tests the saturated alpha raised to this power, which sets the share of pixels that survive
		alphaPower: float('_DitherAlphaExp', 1),
		colorTimesAlpha: reader.shader.name === NO_LIGHTING_SHADER,
		offset: vertexOffsetOf(reader),
		softBody: null,
		cameraPull: null,
		waterBlendBelow: null,
		lighting: null,
		// a G-buffer surface, so the deferred fog covers it
		unfogged: false,
		blendMode: 'over',
		opaque,
		screenUv: screenUvOf(reader),
		stencil: null,
		appear,
		parallax: null,
		normalMap: null,
		emission: null,
		...(main2 !== null ? { main2 } : {}),
	};
};
