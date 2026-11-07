import type {
	EffectStackSurface,
	StackLayer,
	UnsupportedSurface,
} from '@endfield-noclip/package-format/surfaces';

import { pastUvSets, undrawnBlend, undrawnKeywords } from '../describe-steps.ts';
import { isUnsupported, type MaterialReader, unsupported } from '../material-values.ts';

import { effectTexture, matrixRotationOf, softBlendOf, speedOf, UNSET_WHITE } from './effect-steps.ts';
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

/**
 * keywords of VFXAdvance that are drawn. the ink keywords only add what the runtime ink simulation (the
 * player wading through ink) leaves around the player, which is nothing where it hasn't run, so they change
 * nothing in the viewer
 */
const ADVANCE_KEYWORDS = new Set([
	'_USE_DISTURB',
	'_USE_MASK',
	'_USE_BLEND',
	'_USE_DISSOLVE',
	'_USE_FRESNEL',
	'_USE_FOG',
	'_USE_SOFTBLEND',
	'_USE_VERTOFFSET',
	'_INK_DISTORT',
	'_INK_COLOR_DISTORT',
	...APPEAR_KEYWORDS,
]);

/**
 * keywords of CharacterNPR_VFX that are drawn: VFXAdvance's slots but the dissolve, which it lacks, with
 * VFXBaseV2's screen UVs
 */
const CHARACTER_KEYWORDS = new Set([
	'_USE_DISTURB',
	'_USE_MASK',
	'_USE_BLEND',
	'_USE_FRESNEL',
	'_USE_FOG',
	'_USE_SOFTBLEND',
	'_USE_VERTOFFSET',
	'_USE_SCREENUV',
]);

/** VFXAdvance's `_BlendMode` values the viewer draws */
const BLEND_MODES: readonly EffectStackSurface['blendMode'][] = ['over', 'add'];

/**
 * `HGRP/Effect/VFXAdvance` (`docs/game-data/effects.md#vfxadvance`) as a texture stack: its main texture, one
 * disturb texture, a mask, a blend layer and a dissolve, tinted, optionally faded by a Fresnel term and in
 * front of what lies behind, and revealed around the player
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported`
 */
export const describeVfxAdvance = (reader: MaterialReader): EffectStackSurface | UnsupportedSurface =>
	describeFixedSlots(reader, ADVANCE_KEYWORDS);

/**
 * `HGRP/CharacterNPR_VFX` (`docs/game-data/effects.md#characternpr_vfx`) as VFXAdvance's texture stack,
 * without its dissolve
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported`
 */
export const describeCharacterVfx = (reader: MaterialReader): EffectStackSurface | UnsupportedSurface => {
	const { float } = reader;
	// its pull towards the camera is the whole `_VertCameraOffset`, not VFXBaseV2's capped one; at 0 both are 1 mm
	if (float('_InParticle', 1) === 0 && float('_VertCameraOffset', 0) !== 0) {
		return unsupported('an uncapped pull towards the camera');
	}
	return describeFixedSlots(reader, CHARACTER_KEYWORDS);
};

/**
 * the texture stack of the shaders with fixed slots: a main texture, one disturb texture, a mask, a blend
 * layer and a dissolve, each with its keyword
 *
 * @param reader the material's properties
 * @param drawn the shader's keywords that are drawn
 * @returns its surface, or `unsupported`
 */
const describeFixedSlots = (
	reader: MaterialReader,
	drawn: ReadonlySet<string>,
): EffectStackSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has } = reader;
	const keywords = undrawnKeywords(reader, drawn);
	if (keywords !== null) {
		return keywords;
	}
	const blend = undrawnBlend(reader, ['premultiplied']);
	if (blend !== null) {
		return blend;
	}
	const blendMode = BLEND_MODES[float('_BlendMode', 0)];
	if (blendMode === undefined) {
		return unsupported(`_BlendMode ${float('_BlendMode', 0)}`);
	}
	if (float('_UseInterior', 0) !== 0) {
		return unsupported('an interior');
	}
	// the Fresnel colour covers the colour by its w; only the opacity term is drawn
	if (has('_USE_FRESNEL') && (color('_FresnelColor')?.[3] ?? 0) !== 0) {
		return unsupported('a Fresnel colour');
	}
	const appear = appearOf(reader);
	if (isUnsupported(appear)) {
		return appear;
	}
	const computed = computedUvSources(reader);
	// the stack's slots, in the order the distortion runs through them: it shifts the main texture, the mask, the
	// blend layer and the dissolve
	const slots = [
		{
			name: '_MainTex',
			keyword: null,
			role: 'main',
			redAlpha: float('_UseMainTexAsAlpha', 0) !== 0,
			disturbed: '_MainTexUseDisturb',
			prefix: '_MainTex',
		},
		{
			name: '_DisturbTex1',
			keyword: '_USE_DISTURB',
			role: 'disturb1',
			redAlpha: false,
			disturbed: null,
			prefix: '_DisturbTex1',
		},
		{
			name: '_MaskTex',
			keyword: '_USE_MASK',
			role: 'mask',
			redAlpha: float('_UseMaskTexAsAlpha', 0) !== 0,
			disturbed: '_MaskTexUseDisturb',
			prefix: '_MaskTex',
		},
		{
			name: '_BlendTex',
			keyword: '_USE_BLEND',
			role: 'blend',
			redAlpha: false,
			disturbed: '_BlendTexUseDisturb',
			prefix: '_BlendTex',
		},
		{
			name: '_DissolveTex',
			keyword: '_USE_DISSOLVE',
			role: 'dissolve',
			redAlpha: false,
			disturbed: '_DissolveTexUseDisturb',
			prefix: '_Dissolve',
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
		// the disturb texture's animation properties drop the `Tex` and take its number
		const anim = slot.role === 'disturb1' ? '_Disturb' : slot.prefix;
		const suffix = slot.role === 'disturb1' ? '1' : '';
		layers[i] = {
			...effectTexture(
				bound,
				speedOf(reader, `${anim}UVSpeed${suffix}`),
				matrixRotationOf(reader, `${anim}UVRotateMat${suffix}`),
			),
			role: slot.role,
			redAlpha: slot.redAlpha,
			source: sourceOf(color(`${anim}UVWeights${suffix}`) ?? [1, 0, 0, 0], computed),
			disturbShare: slot.disturbed === null ? 0 : float(slot.disturbed, 0),
		};
	}
	const { tint, intensity } = stackTintOf(reader);
	const shared = stackSharedOf(reader, intensity);
	return {
		kind: 'effectStack',
		variant: 'advance',
		layers,
		tint,
		blendTint: shared.blendTint,
		blendVertexColor: has('_USE_BLEND') && float('_BlendDisableVertColor', 0) === 0,
		disturb: shared.disturb,
		disturbBias: float('_Bi_Disturb', 0),
		distorted: has('_USE_DISTURB'),
		disturbNormal: float('_DisturbTex1Normal', 0) !== 0,
		particleDisturb: false,
		weight: { disturb: 0, dissolve: 0, used: false },
		dissolve: has('_USE_DISSOLVE') ? shared.dissolve : null,
		masked: has('_USE_MASK'),
		fresnel: has('_USE_FRESNEL')
			? {
					power: float('_FresnelPower', 1),
					bias: float('_FresnelBias', 0),
					flip: float('_FresnelFlip', 0),
					opacity: float('_FresnelAffectOpacity', 0),
				}
			: null,
		soft: softBlendOf(reader),
		ignorePostExposure: shared.ignorePostExposure,
		vertexColor: float('_DisableVertColor', 0) === 0,
		near: shared.near,
		brighten: { threshold: 1, intensity: 0 },
		breathing: null,
		edge: null,
		decalFade: null,
		alphaPower: 1,
		offset: vertexOffsetOf(reader),
		softBody: null,
		// as VFXBaseV2's, by `1 − _InParticle`
		cameraPull: float('_InParticle', 1) === 0 ? float('_VertCameraOffset', 0) : null,
		waterBlendBelow: null,
		lighting: null,
		unfogged: !has('_USE_FOG'),
		blendMode,
		opaque: false,
		screenUv: screenUvOf(reader),
		stencil: null,
		appear,
		parallax: null,
	};
};
