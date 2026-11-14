import type {
	EffectCompare,
	EffectRole,
	EffectSoftBody,
	EffectStackSurface,
	EffectStencil,
	EffectVertexOffsetMask,
	StackLayer,
	StencilMaskSurface,
	UnsupportedSurface,
} from '@endfield-noclip/package-format/surfaces';

import { pastUvSets, undrawnKeywords } from '../describe-steps.ts';
import { BlendFactor } from '../material-classify.ts';
import { isUnsupported, type MaterialReader, unsupported } from '../material-values.ts';

import {
	brightenOf,
	type EffectSlot,
	effectTexture,
	matrixRotationOf,
	ownSpeedOf,
	softBlendOf,
	speedOf,
	UNSET_WHITE,
} from './effect-steps.ts';
import { softBodyOf } from './soft-body.ts';
import {
	computedUvSources,
	offsetSlotOf,
	screenUvOf,
	sourceOf,
	stackSharedOf,
	stackTintOf,
	vertexOffsetOf,
} from './texture-stack.ts';

// #region stencil

/** Unity's `CompareFunction` values, `Disabled` (0) to `Always` (8), as WebGPU names them */
const COMPARE_FUNCTIONS: readonly EffectCompare[] = [
	'always',
	'never',
	'less',
	'equal',
	'less-equal',
	'greater',
	'not-equal',
	'greater-equal',
	'always',
];

/** Unity's `StencilOp` values the viewer draws */
const StencilOp = {
	Keep: 0,
	Replace: 2,
} as const;

/**
 * @returns the stencil state of a VFXBaseV2 material, whose one pass takes its stencil and depth test from
 *   these properties; `null` when it leaves the stencil alone, `unsupported` for stencil operations other
 *   than keep and replace
 */
const stencilOf = (reader: MaterialReader): EffectStencil | UnsupportedSurface | null => {
	const { float } = reader;
	const compare = COMPARE_FUNCTIONS[float('_StencilComp', 8)] ?? 'always';
	const op = float('_StencilOp', StencilOp.Keep);
	if (compare === 'always' && op === StencilOp.Keep) {
		return null;
	}
	if (op !== StencilOp.Keep && op !== StencilOp.Replace) {
		return unsupported(`stencil operation ${op}`);
	}
	return {
		compare,
		replace: op === StencilOp.Replace,
		reference: float('_StencilRef', 0) & 0xff,
		readMask: float('_StencilReadMask', 255) & 0xff,
		writeMask: float('_StencilWriteMask', 255) & 0xff,
		depthCompare: COMPARE_FUNCTIONS[float('_ZTest', 4)] ?? 'less-equal',
	};
};

// #endregion

// #region vertex offset mask

/** the stack slots a vertex offset's mask can take: the sample textures', but the sixth's (the offset's own) */
const MASK_SLOTS = [5, 4, 3, 2, 1];

/**
 * VFXBaseV2's mask on the vertex offset (`_USE_VERTOFFSETMASK`), drawn from a slot the stack leaves empty
 *
 * @param reader the material's properties
 * @param layers the stack's slots
 * @returns the mask, `null` without one or where it changes nothing (an unset white texture), or
 *   `unsupported`
 */
const offsetMaskOf = (
	reader: MaterialReader,
	layers: readonly (StackLayer | null)[],
): EffectVertexOffsetMask | UnsupportedSurface | null => {
	const { float, has } = reader;
	if (!has('_USE_VERTOFFSETMASK')) {
		return null;
	}
	const bound = reader.slot('_OffsetMaskTex');
	if (bound === undefined) {
		// a red of 1 leaves the offset whole
		return reader.shader.textures['_OffsetMaskTex'] === 'white'
			? null
			: unsupported('a vertex offset mask without its texture');
	}
	const slot = MASK_SLOTS.find((i) => layers[i] === null);
	if (slot === undefined) {
		return unsupported('a vertex offset mask with every sample slot taken');
	}
	return {
		// sampled at the offset texture's UVs, scrolled by its speed's xy (zw scroll by custom data, only on
		// particles, where the offset is off)
		texture: effectTexture(bound, ownSpeedOf(reader, '_OffsetMaskSpeed')),
		slot,
		strength: float('_OffsetMaskPower', 0) * 0.2,
	};
};

// #endregion

// #region slots and keywords

/** the slots of VFXBaseV2: the main texture, then `_SampleTex0`…; the sixth shares the vertex offset's slot */
const BASE_SLOTS = [
	'_MainTex',
	'_SampleTex0',
	'_SampleTex1',
	'_SampleTex2',
	'_SampleTex3',
	'_SampleTex4',
	'_SampleTex5',
];

/** the property whose `_ST` a VFXBaseV2 sample texture uses, by role */
const ROLE_TEXTURES = ['_DisturbTex1', '_DisturbTex2', '_WeightTex', '_MaskTex', '_BlendTex', '_DissolveTex'];
const SAMPLE_ROLES: readonly EffectRole[] = ['disturb1', 'disturb2', 'weight', 'mask', 'blend', 'dissolve'];

/** keywords VFXBaseV2 can have and still be drawn */
const BASE_KEYWORDS = new Set([
	'_USE_LIGHTING',
	'_SAMPLE_TEX0',
	'_SAMPLE_TEX1',
	'_SAMPLE_TEX2',
	'_SAMPLE_TEX3',
	'_SAMPLE_TEX4',
	'_USE_FOG',
	'_USE_SOFTBLEND',
	'_USE_FRESNEL',
	'_USE_POLARUV',
	'_USE_SCREENUV',
	'_USE_ANIM_BREATHING',
	'_USE_EDGECOLOR',
	// a material toggle no compiled variant reads, so the game draws the variant without it
	'_USE_FORCE_DYNAMIC_LIGHTING',
]);

// #endregion

// #region soft-body animation

/**
 * VFXBaseV2's `_VAT_SOFTBODY` animation. its rotation texture only turns the normals, which the drawn
 * variants without lighting or a Fresnel term don't read
 *
 * @returns the animation, `null` without the keyword, or `unsupported`
 */
const baseSoftBodyOf = (reader: MaterialReader): EffectSoftBody | UnsupportedSurface | null => {
	const { has } = reader;
	if (!has('_VAT_SOFTBODY')) {
		return null;
	}
	if (has('_USE_LIGHTING') || has('_USE_FRESNEL')) {
		return unsupported('a soft-body animation whose rotated normals are lit or feed a Fresnel term');
	}
	if (has('_USE_VERTOFFSET') || has('_SAMPLE_TEX5')) {
		return unsupported('a soft-body animation with a vertex offset or a sixth sample texture');
	}
	return softBodyOf(reader);
};

// #endregion

// #region keywords outside the list

/** a `_WaterHeight` at or below this lies under every level, so water blending leaves the effect unchanged */
const WATER_BLEND_UNSET = -1000;

/**
 * @returns the height below which `_USE_WATER_BLEND` absorbs and scatters, `null` without it or under every
 *   level. the game sets the height from a water surface the effect meets (`VFXWaterBlendConfig`), which
 *   isn't followed, so this is the authored one
 */
const waterBlendOf = ({ float, has }: MaterialReader): number | null => {
	const height = float('_WaterHeight', 0);
	return has('_USE_WATER_BLEND') && height > WATER_BLEND_UNSET ? height : null;
};

/** whether a VFXBaseV2 keyword outside {@link BASE_KEYWORDS} is drawn, or changes nothing in the viewer */
const baseKeywordDrawn = (keyword: string, reader: MaterialReader): boolean => {
	const { float, colorOrVector: color } = reader;
	switch (keyword) {
		case '_USE_VERTOFFSET': {
			// the game scales the offset by `1 − _InParticle`, so meshes left in particle mode don't move
			const slot = offsetSlotOf(reader);
			return float('_InParticle', 1) !== 0 || (slot !== null && slot.uv <= 1);
		}
		case '_USE_BRIGHT': {
			// the radial glow and distortion around the player (no `_BrightCenter`) reach `_OuterRadius` metres,
			// and the viewer has no player
			return float('_BrightType', 0) === 0 && (color('_BrightCenter')?.[3] ?? 0) === 0;
		}
		case '_SAMPLE_TEX5': {
			// the sixth sample texture takes the vertex offset's slot
			return vertexOffsetOf(reader) === null;
		}
		case '_USE_VERTOFFSETMASK': {
			// drawn by `offsetMaskOf`, which rejects the materials it can't draw
			return true;
		}
		case '_USE_WATER_BLEND': {
			// the blend changes only what lies below `_WaterHeight`, which the viewer marks unsupported per fragment
			// (`waterBlendOf`)
			return true;
		}
		case '_VAT_SOFTBODY': {
			// drawn by `baseSoftBodyOf`, which rejects the variants it can't draw first
			return true;
		}
		default: {
			return false;
		}
	}
};

// #endregion

// #region the stack

/** VFXBaseV2's `_BlendMode` values the viewer draws */
const STACK_BLEND_MODES: readonly EffectStackSurface['blendMode'][] = ['over', 'add', 'multiply'];

/** @returns whether a material's blend state multiplies what lies behind by its colour (`Blend DstColor Zero`) */
const multipliesBehind = (reader: MaterialReader): boolean =>
	reader.material.blend === 'custom' &&
	reader.material.blendFactors?.[0] === BlendFactor.DstColor &&
	reader.material.blendFactors[1] === BlendFactor.Zero;

/**
 * `HGRP/Effect/VFXBaseV2` (`docs/game-data/effects.md`): its texture stack, or with an opaque blend state
 * that only writes the stencil, a portal's mask
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported`
 */
export const describeVfxBase = (
	reader: MaterialReader,
): EffectStackSurface | StencilMaskSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has, material } = reader;
	const stencil = stencilOf(reader);
	if (isUnsupported(stencil)) {
		return stencil;
	}
	// an opaque blend state writes the premultiplied colour over what's behind, drawn in the main pass
	const opaque = material.blend === 'opaque';
	if (opaque) {
		if (stencil?.replace === true) {
			return { kind: 'stencilMask', stencil };
		}
		if (stencil !== null) {
			return unsupported('opaque blending with a stencil');
		}
		if (!material.zWrite) {
			return unsupported('opaque blending without depth writes');
		}
	}
	// mode 0 covers what's behind, 1 adds to it, and 2 writes a colour for a blend state that multiplies it
	// (docs/game-data/effects.md#vfxbasev2, blend modes)
	const blendMode = float('_BlendMode', 0);
	if (blendMode !== 0 && blendMode !== 1 && blendMode !== 2) {
		return unsupported(`_BlendMode ${blendMode}`);
	}
	let blendable = material.blend === 'premultiplied';
	if (opaque) {
		// under an opaque blend state, modes 0 and 1 write the same colour
		blendable = blendMode !== 2;
	} else if (blendMode === 2) {
		blendable = multipliesBehind(reader);
	}
	if (!blendable) {
		return unsupported(`_BlendMode ${blendMode} with ${material.blend} blending`);
	}
	// drawn over the composited scene, which has no stencil
	if (blendMode === 2 && stencil !== null) {
		return unsupported('a multiplying blend with a stencil');
	}
	const softBody = baseSoftBodyOf(reader);
	if (isUnsupported(softBody)) {
		return softBody;
	}
	const keywords = undrawnKeywords(reader, {
		has: (keyword) => BASE_KEYWORDS.has(keyword) || baseKeywordDrawn(keyword, reader),
	});
	if (keywords !== null) {
		return keywords;
	}
	const { tint, intensity } = stackTintOf(reader);
	const animOf = (prefix: string) => ({
		scroll: speedOf(reader, `${prefix}UVSpeed`),
		rotation: matrixRotationOf(reader, `${prefix}UVRotateMat`),
	});
	const computed = computedUvSources(reader);
	// a slot's UVs are its weights times UV0, UV1, polar and screen UVs; materials set one weight
	const source = (prefix: string) => sourceOf(color(`${prefix}UVWeights`) ?? [1, 0, 0, 0], computed);
	const layers: (StackLayer | null)[] = BASE_SLOTS.map(() => null);
	for (const [i, name] of BASE_SLOTS.entries()) {
		// the main texture is always sampled, a sample texture only with its keyword
		if (i > 0 && !has(`_SAMPLE_TEX${i - 1}`)) {
			continue;
		}
		let slot: EffectSlot | undefined = reader.slot(name);
		// a sample texture samples the shader's default when the material binds none; an unset slot binds white
		if (slot === undefined && i > 0 && reader.shader.textures[name] === 'white') {
			slot = UNSET_WHITE;
		}
		if (slot === undefined) {
			continue;
		}
		const uvSet = pastUvSets(name, slot);
		if (uvSet !== null) {
			return uvSet;
		}
		if (i === 0) {
			const anim = animOf('_MainTex');
			layers[0] = {
				...effectTexture(slot, anim.scroll, anim.rotation),
				role: 'main',
				redAlpha: float('_UseMainTexAsAlpha', 0) !== 0,
				source: source('_MainTex'),
				disturbShare: float('_MainTexUseDisturb', 0),
			};
			continue;
		}
		const n = i - 1;
		const role = ROLE_TEXTURES.findIndex((_, k) => float(`_SampleTex${n}UseWeight${k}`, 0) !== 0);
		if (role < 0) {
			continue;
		}
		// the shader transforms a sample texture's UVs by the `_ST` of its role's texture property
		const transform = reader.slot(ROLE_TEXTURES[role]) ?? slot;
		const anim = animOf(`_SampleTex${n}`);
		let layerSource = source(`_SampleTex${n}`);
		if (n === 5) {
			// the shader computes the sixth's UVs in its vertex stage, from the mesh's UV sets alone, and scrolls them
			// by the first's speed
			const weights = color('_SampleTex5UVWeights') ?? [1, 0, 0, 0];
			layerSource = weights[1] > weights[0] ? 'uv1' : 'uv0';
			anim.scroll = animOf('_SampleTex0').scroll;
		}
		layers[i] = {
			...effectTexture({ ...transform, texture: slot.texture }, anim.scroll, anim.rotation),
			role: SAMPLE_ROLES[role],
			redAlpha: float(`_UseSampleTex${n}AsAlpha`, 0) !== 0,
			source: layerSource,
			disturbShare: float(`_SampleTex${n}UseDisturb`, 0),
		};
	}
	// without a main texture the shader samples its default; slot 0 is always sampled, and an unset slot binds
	// white
	if (layers[0] === null && reader.shader.textures['_MainTex'] !== 'white') {
		return unsupported('no main texture and a non-white default');
	}
	const shared = stackSharedOf(reader, intensity);
	const soft = softBlendOf(reader);
	// both read the main pass's depth, which an opaque layer draws into
	if (opaque && (soft !== null || has('_USE_EDGECOLOR'))) {
		return unsupported('opaque blending with a soft blend or edge colour');
	}
	const offset = vertexOffsetOf(reader);
	// the mask only scales the offset, so without one it changes nothing
	const mask = offset === null ? null : offsetMaskOf(reader, layers);
	if (isUnsupported(mask)) {
		return mask;
	}
	return {
		kind: 'effectStack',
		variant: 'base',
		layers,
		tint,
		blendTint: shared.blendTint,
		blendVertexColor: false,
		disturb: shared.disturb,
		disturbBias: float('_Bi_Disturb', 0),
		distorted: float('_UseDisturb', 0) !== 0,
		disturbNormal: false,
		// the ink-wash path puts UV0's v where the custom data's w would be
		particleDisturb:
			float('_UseParticleDisturb', 0) !== 0 &&
			!(float('_SyncDisturbWithInkWash', 0) !== 0 && float('_RenderTransparentAfterDOF', 0) !== 0),
		weight: {
			disturb: float('_WeightTexIntensity', 1) * float('_DisturbUseWeight', 0),
			dissolve: float('_WeightTexIntensity', 1) * float('_DissolveUseWeight', 0),
			used: float('_UseWeightTex', 0) !== 0,
		},
		dissolve: float('_UseDissolve', 0) !== 0 ? shared.dissolve : null,
		// as in the game, a mask or weight switched on without a texture in that role leaves nothing
		masked: float('_UseMask', 0) !== 0,
		maskAlphaOnly: false,
		fresnel: has('_USE_FRESNEL')
			? {
					power: float('_FresnelPower', 1),
					bias: float('_FresnelBias', 0),
					flip: float('_FresnelFlip', 0),
					opacity: float('_FresnelAffectOpacity', 0),
				}
			: null,
		soft,
		ignorePostExposure: shared.ignorePostExposure,
		vertexColor: float('_DisableVertColor', 0) === 0,
		near: shared.near,
		brighten: brightenOf(reader),
		breathing: has('_USE_ANIM_BREATHING')
			? {
					minAlpha: float('_BreathingMinAlpha', 0),
					speed: float('_BreathingSpeed', 1),
					power: float('_BreathingPower', 1),
				}
			: null,
		edge: has('_USE_EDGECOLOR')
			? {
					color: color('_EdgeColor') ?? [1, 1, 1, 1],
					alpha: float('_TintColorAlpha', 1),
					mode: float('_EdgeColorMode', 0),
					distance: float('_EdgeDistance', 0),
					offset: float('_EdgeDistanceOffset', 0),
				}
			: null,
		decalFade: null,
		alphaPower: 1,
		offset:
			offset === null
				? null
				: {
						...offset,
						vertexAlphaWeight: float('_UseVertexColorAlphaAsVertOffsetWeight', 0),
						mask,
					},
		softBody,
		// every variant pulls by `1 − _InParticle`, with or without a vertex offset
		cameraPull: float('_InParticle', 1) === 0 ? float('_VertCameraOffset', 0) : null,
		waterBlendBelow: waterBlendOf(reader),
		lighting: has('_USE_LIGHTING') ? { worldUp: float('_RotateNormalToWorldUp', 0) !== 0 } : null,
		unfogged: !has('_USE_FOG'),
		blendMode: STACK_BLEND_MODES[blendMode],
		opaque,
		screenUv: screenUvOf(reader),
		stencil,
		appear: null,
		parallax: null,
	};
};

// #endregion
