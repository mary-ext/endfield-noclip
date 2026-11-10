import type {
	EffectStackSurface,
	StackLayer,
	UnsupportedSurface,
} from '@endfield-noclip/package-format/surfaces';
import type { Rgb } from '@endfield-noclip/package-format/values';

import { pastUvSets, undrawnKeywords } from '../describe-steps.ts';
import { isUnsupported, linearRgb, type MaterialReader, unsupported } from '../material-values.ts';

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
 * @returns whether a VFXDitherAlpha material is one of its effect variants (a distortion, dissolve, mask or
 *   polar or screen UVs), drawn as a texture stack rather than a dithered surface
 */
export const isDitherEffect = (reader: MaterialReader): boolean =>
	reader.shader.name === 'HGRP/Effect/VFXDitherAlpha' &&
	reader.material.keywords.some((keyword) => DITHER_EFFECT_KEYWORDS.has(keyword));

/**
 * an unlit `HGRP/Effect/VFXDitherAlpha` effect variant, optionally with a vertex offset, as a texture stack.
 * the game writes such a surface to the G-buffer where its alpha beats a per-pixel noise; the viewer blends
 * it over by that alpha instead, which its temporal antialiasing would average the dither to anyway
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported`
 */
export const describeDitherEffect = (reader: MaterialReader): EffectStackSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has } = reader;
	const keywords = undrawnKeywords(reader, {
		has: (keyword) =>
			DITHER_EFFECT_KEYWORDS.has(keyword) ||
			DITHER_EFFECT_EXTRA_KEYWORDS.has(keyword) ||
			APPEAR_KEYWORDS.has(keyword),
	});
	if (keywords !== null) {
		return keywords;
	}
	// the depth pass tests the alpha after the reveal, as the stack blends by it
	const appear = appearOf(reader);
	if (isUnsupported(appear)) {
		return appear;
	}
	if (float('_UseLighting', 0) !== 0) {
		return unsupported('a lit effect variant');
	}
	if (float('_DitherAlphaMode', 0) !== 0) {
		return unsupported(`_DitherAlphaMode ${float('_DitherAlphaMode', 0)}`);
	}
	if (has('_USE_SCREENUV') && float('_LocalPivortSpace', 0) !== 0) {
		return unsupported('screen UVs relative to the object');
	}
	// with `_UseMainTex2AsAlpha` the colour pass doesn't sample the second texture and only multiplies by its
	// colour; the depth pass has no `_USE_MAIN2` variant, so the tested alpha is unchanged
	let second: Rgb = [1, 1, 1];
	if (has('_USE_MAIN2')) {
		if (float('_UseMainTex2AsAlpha', 0) === 0 || float('_MainTex2BlendMode', 0) !== 0) {
			return unsupported('a second texture that colours or blends rather than masks');
		}
		second = linearRgb(color('_MainTex2Color') ?? [1, 1, 1, 1]);
	}
	const computed = computedUvSources(reader);
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
		disturbNormal: false,
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
		offset: vertexOffsetOf(reader),
		softBody: null,
		cameraPull: null,
		waterBlendBelow: null,
		lighting: null,
		// a G-buffer surface, so the deferred fog covers it
		unfogged: false,
		blendMode: 'over',
		opaque: false,
		screenUv: screenUvOf(reader),
		stencil: null,
		appear,
		parallax: null,
	};
};
