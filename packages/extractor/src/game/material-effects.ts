/**
 * surface describers for the effect shaders (`docs/game-data/effects.md`): what each draws, from its
 * properties and keywords, or `unsupported` with the keywords or combinations the viewer doesn't draw.
 */

import type { TextureSlot } from '@endfield-noclip/package-format/materials';
import type {
	EffectCompare,
	EffectNearFade,
	EffectRole,
	EffectSoftBody,
	EffectStackSurface,
	EffectStencil,
	EffectTexture,
	EffectUvSource,
	EffectVertexOffset,
	EffectVertexOffsetMask,
	FadeRange,
	LightBeamSurface,
	LitDecalSurface,
	MistCardSurface,
	MistVolumeSurface,
	RefractSurface,
	DisturbLayer,
	SixWaySmokeSurface,
	SixWayTexture,
	SixWayUvSource,
	StackLayer,
	StencilMaskSurface,
	UndrawnSurface,
	UnsupportedSurface,
	WaterFoamSurface,
	WaterSheetSurface,
} from '@endfield-noclip/package-format/surfaces';
import type { TextureRef } from '@endfield-noclip/package-format/textures';
import type { Color } from '@endfield-noclip/package-format/values';

import { BlendFactor } from './material-classify.ts';
import { linearRgb, type MaterialReader, scaleRgb, unsupported } from './material-values.ts';

/** @returns `unsupported` naming the material's keywords outside `drawn`, or `null` when it has none */
export const undrawnKeywords = (
	reader: MaterialReader,
	drawn: ReadonlySet<string>,
): UnsupportedSurface | null => {
	const undrawn = reader.material.keywords.filter((keyword) => !drawn.has(keyword));
	return undrawn.length === 0 ? null : unsupported(`keywords ${undrawn.join(', ')}`);
};

/** a fade between two view depths that also works with equal ends (then a step at the start) */
const fadeRange = (start: number, end: number): FadeRange =>
	Math.abs(end - start) < 1e-4 ? [start, start + 1e-4] : [start, end];

// #region mist

/**
 * card keywords that are drawn. `_USE_LIGHTING` lights by the mesh normal rather than the game's normal map,
 * and `_USE_FOG`'s own fog isn't drawn (premultiplied cards take the composite's fog, additive ones none)
 */
const MIST_CARD_KEYWORDS = new Set(['_USE_FOG', '_USE_SOFTBLEND', '_USE_LIGHTING']);

/**
 * `HGRP/FogSimple` (`docs/game-data/effects.md#mist`)
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported`
 */
export const describeMistCard = (reader: MaterialReader): MistCardSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has, material } = reader;
	if (material.blend !== 'premultiplied' && material.blend !== 'additive') {
		return unsupported(`${material.blend} blending`);
	}
	const keywords = undrawnKeywords(reader, MIST_CARD_KEYWORDS);
	if (keywords !== null) {
		return keywords;
	}
	const main = reader.slot('_MainTex');
	const noise = reader.slot('_NoiseTex');
	if (main === undefined || noise === undefined) {
		return unsupported('no main or noise texture');
	}
	if (main.uv > 1 || noise.uv > 1) {
		return unsupported('a texture on a UV set past 1');
	}
	const separate = float('_UseSeparateScale', 0) !== 0;
	const windScale = float('_WindScale', 1);
	// `_BaseColor` and `_IndirectColor` are [HDR]: authored linear, used as stored
	const indirect = color('_IndirectColor') ?? [0, 0, 0, 1];
	return {
		kind: 'mistCard',
		main,
		noise,
		color: color('_BaseColor') ?? [1, 1, 1, 1],
		baseAlphaIntensity: float('_BaseAlphaIntensity', 1),
		noiseIntensity: float('_FogNoiseIntensity', 0),
		useWind: float('_UseWind', 0),
		wind: {
			noiseIntensity: float('_WindNoiseIntensity', 0),
			noiseContrast: float('_WindNoiseContrast', 0),
			scale: [
				windScale * (separate ? float('_WindScaleX', 1) : 1),
				windScale * (separate ? float('_WindScaleY', 1) : 1),
			],
			speed: float('_WindSpeed', 0),
			direction: [float('_WindDirX', 1), float('_WindDirY', 0)],
		},
		lit: has('_USE_LIGHTING') && float('_UseLighting', 0) !== 0,
		lightFactor: float('_LightFactor', 0),
		indirectColor: [indirect[0], indirect[1], indirect[2]],
		additive: material.blend === 'additive',
		distanceFade: fadeRange(float('_DistanceFadeStart', 0), float('_DistanceFadeEnd', 0)),
		nearFade: fadeRange(float('_NearCameraFadeDistanceStart', 0), float('_NearCameraFadeDistanceEnd', 0)),
		topFade: { contrast: float('_TopFadeContract', 1), offset: float('_TopFadeOffset', 0) },
		softDistance: softBlendOf(reader)?.distance ?? 0,
	};
};

/**
 * `HGRP/Effect/VFXFakeVolumeFog` (`docs/game-data/effects.md#mist`), drawn only when additive
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported`
 */
export const describeMistVolume = (reader: MaterialReader): MistVolumeSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has, material } = reader;
	if (material.blend !== 'additive') {
		return unsupported(`${material.blend} blending`);
	}
	const fog = color('_FogColor') ?? [1, 1, 1, 1];
	const noiseSlot = reader.slot('_NoiseTex3D');
	let noise: MistVolumeSurface['noise'] = null;
	if (has('_USE_NOISE3D') && noiseSlot !== undefined) {
		const tiling = color('_NoiseTexTilling1') ?? [1, 1, 1, 1];
		const dir = color('_NoiseUVWDir1') ?? [0, 0, 0, 0];
		const speed = float('_NoiseUVWSpeed1', 0);
		noise = {
			texture: noiseSlot.texture,
			tiling: [tiling[0], tiling[1], tiling[2]],
			world: float('_NoiseTexUseWorldUVW', 1),
			flow: [dir[0] * speed, dir[1] * speed, dir[2] * speed],
			nearIntensity: float('_NoiseIntensity', 1),
			farIntensity: float('_NoiseFarIntensity', 1),
			farPerMetre: 0.1 / Math.max(float('_NoiseFar', 1), 1e-3),
		};
	}
	return {
		kind: 'mistVolume',
		color: [...linearRgb(fog), fog[3] * float('_TintColorAlpha', 1)],
		exponent: float('_FogExponent', 1),
		density: float('_FogDensity', 1),
		edgeFade: Math.max(float('_CubEdgeFade', 1), 1e-3),
		nearFade: float('_canWalkIn', 0) !== 0 ? 0 : Math.max(float('_NearFadeDistance', 1), 1e-3),
		height: {
			offset: float('_HeightOffset', 0),
			falloff: float('_HeightFalloff', 0),
			verticalFalloff: [float('_VerticalFalloffMin', 0), float('_VerticalFalloffMax', 0)],
		},
		intensityFadeDistance: Math.max(float('_FogIntensityFadeDistance', 1e5), 1e-3),
		intensityFadeFromCentre: float('_FogIntensityFadeUseCenter', 0),
		depth: [float('_FogDepthStart', 0), float('_FogDepthEnd', 0)],
		ignorePostExposure: float('_IgnorePostExposure', 1),
		noise,
	};
};

// #endregion

// #region the texture stack

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

/** a slot an effect samples: a bound one, or an unset one whose shader samples white ({@link UNSET_WHITE}) */
type EffectSlot = Omit<TextureSlot, 'texture'> & { texture: TextureRef };

/** an unset slot, where the shader's white default stands in */
const UNSET_WHITE: EffectSlot = { texture: null, uv: 0, scale: [1, 1], offset: [0, 0] };

/**
 * a slot as an effect texture, with its scroll and rotation. a `*UVSpeed` vector's zw is its shift per unit
 * of a particle's custom data
 */
const effectTexture = (
	slot: Pick<EffectSlot, 'texture' | 'scale' | 'offset'>,
	scroll: readonly number[] = [0, 0],
	rotation: [cos: number, sin: number] = [1, 0],
): EffectTexture => ({
	texture: slot.texture,
	scale: [slot.scale[0], slot.scale[1]],
	offset: [slot.offset[0], slot.offset[1]],
	scroll: [scroll[0], scroll[1]],
	rotation,
	customScroll: [scroll[2] ?? 0, scroll[3] ?? 0],
});

const UV_SOURCES: readonly EffectUvSource[] = ['uv0', 'uv1', 'polar', 'screen'];

/** the shared rows of the texture stack: blend layer, distortion, dissolve, near fade and post exposure */
const sharedOf = (reader: MaterialReader, intensity: number) => {
	const { float, colorOrVector: color } = reader;
	const edge = color('_DissolveEmissiveColor') ?? [0, 0, 0, 0];
	return {
		blendTint: color('_BlendTint') ?? [1, 1, 1, 0],
		disturb: [
			float('_DisturbUIntensity1', 0),
			float('_DisturbVIntensity1', 0),
			float('_DisturbUIntensity2', 0),
			float('_DisturbVIntensity2', 0),
		] satisfies [number, number, number, number],
		dissolve: {
			on: false,
			// the threshold sweeps from below 0 to past 1 as the schedule goes from 0 to 1
			threshold: float('_DissolveScheduleOffset', 0) * 2.02 - 1.01,
			sharpness: float('_DissolveEdgeSharp', 1),
			edgeWidth: float('_DissolveEmissiveEdge', 0),
			edgeColor: scaleRgb(edge, intensity),
		},
		near: nearFadeOf(reader),
		ignorePostExposure: float('_IgnorePostExposure', 1),
	};
};

/** the near camera fade every effect shader shares */
const nearFadeOf = ({ float }: MaterialReader): EffectNearFade => ({
	on: float('_UseNearCameraFade', 0) !== 0,
	range: [
		float('_NearCameraFadeDistanceStart', 0),
		float('_NearCameraFadeDistanceEnd', 1),
		float('_NearCameraFadeDistanceStart2', 1e5),
		float('_NearCameraFadeDistanceEnd2', 2e5),
	],
});

/** `_USE_SOFTBLEND`'s fade in front of what lies behind: its distance and bias, `null` without it */
const softBlendOf = ({ float, has }: MaterialReader): { distance: number; bias: number } | null =>
	has('_USE_SOFTBLEND')
		? { distance: Math.max(float('_SoftDistance', 1), 1e-3), bias: float('_SoftBias', 0) }
		: null;

/** the tint of the stack shaders: the LDR `_TintColor` linearized, times its intensity, and its alpha */
const stackTintOf = (reader: MaterialReader): { tint: Color; intensity: number } => {
	const { float, colorOrVector: color } = reader;
	const intensity = float('_TintColorIntensity', 1);
	const tint = color('_TintColor') ?? [1, 1, 1, 1];
	return {
		tint: [...scaleRgb(linearRgb(tint), intensity), tint[3] * float('_TintColorAlpha', 1)],
		intensity,
	};
};

/** a layer's UV source: the largest of its weights times UV0, UV1, polar and screen UVs, if computed */
const sourceOf = (weights: readonly number[], computed: readonly boolean[]): EffectUvSource | null => {
	const largest = weights.indexOf(Math.max(...weights));
	return weights[largest] > 0 && computed[largest] ? UV_SOURCES[largest] : null;
};

/** the material property of the vertex offset's texture */
const OFFSET_TEXTURE = '_OffsetTex';

/** @returns the vertex offset's texture: the bound slot, or white when unset and the shader defaults to it */
const offsetSlotOf = (reader: MaterialReader): EffectSlot | null =>
	reader.slot(OFFSET_TEXTURE) ?? (reader.shader.textures[OFFSET_TEXTURE] === 'white' ? UNSET_WHITE : null);

/**
 * the vertex offset of VFXBaseV2 and VFXDitherAlpha: along `_OffsetDir` (or the normal) by `_OffsetIntensity`
 * times the offset texture's red, remapped by `_Bi_Offset`; the game scales it by `1 − _InParticle`
 */
const vertexOffsetOf = (reader: MaterialReader): EffectVertexOffset | null => {
	const { float, colorOrVector: color, has } = reader;
	const slot = offsetSlotOf(reader);
	if (!has('_USE_VERTOFFSET') || float('_InParticle', 1) !== 0 || slot === null) {
		return null;
	}
	const dir = color('_OffsetDir') ?? [0, 0, 0, 0];
	return {
		// the vertex stage reads the scroll after the `_ST`, unscaled and unrotated
		// its speed's zw scroll by custom data only on particles, where the offset is off
		texture: effectTexture(slot, (color('_OffsetSpeed') ?? [0, 0]).slice(0, 2)),
		uv1: float('_OffsetUVSet', 0) !== 0,
		direction: [dir[0], dir[1], dir[2]],
		space: float('_OffsetSwitchDir', 0),
		intensity: float('_OffsetIntensity', 0),
		bias: float('_Bi_Offset', 0),
		vertexAlphaWeight: 0,
		mask: null,
	};
};

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
	const { float, colorOrVector: color, has } = reader;
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
		texture: effectTexture(bound, (color('_OffsetMaskSpeed') ?? [0, 0]).slice(0, 2)),
		slot,
		strength: float('_OffsetMaskPower', 0) * 0.2,
	};
};

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
	'_USE_ANIM_BREATHING',
	'_USE_EDGECOLOR',
]);

/**
 * the factor a Houdini VAT bound encodes in its digits, as the shader computes it in f32: `1 + x − ceil(x)`
 * for `x = 10 · bound`, which is 1 for the bounds seen
 */
const vatPadding = (bound: number): number => {
	const x = Math.fround(Math.fround(bound) * 10);
	return Math.fround(Math.fround(1 - Math.ceil(x)) + x);
};

/**
 * `_VAT_SOFTBODY`'s animation: the position texture's offset at UV1's column and the frame's row. its
 * rotation texture only turns the normals, which the drawn variants without lighting or a Fresnel term don't
 * read
 *
 * @returns the animation, `null` without the keyword, or `unsupported`
 */
const softBodyOf = (reader: MaterialReader): EffectSoftBody | UnsupportedSurface | null => {
	const { float, has } = reader;
	if (!has('_VAT_SOFTBODY')) {
		return null;
	}
	if (has('_USE_LIGHTING') || has('_USE_FRESNEL')) {
		return unsupported('a soft-body animation whose rotated normals are lit or feed a Fresnel term');
	}
	if (has('_USE_VERTOFFSET') || has('_SAMPLE_TEX5')) {
		return unsupported('a soft-body animation with a vertex offset or a sixth sample texture');
	}
	if (float('_HoudiniVATInParticle', 0) !== 0) {
		return unsupported('a soft-body animation driven by particle data');
	}
	const position = reader.slot('_PositionTexture');
	if (position === undefined) {
		return unsupported('a soft-body animation without its position texture');
	}
	const frameCount = Math.max(Math.round(float('_frameCount', 0)), 1);
	const min: [number, number, number] = [
		float('_boundMinX', 0),
		float('_boundMinY', 0),
		float('_boundMinZ', 0),
	];
	const max = [float('_boundMaxX', 0), float('_boundMaxY', 0), float('_boundMaxZ', 0)];
	// HDR textures (`_TextureFormat` 1) store the offsets themselves; 8-bit ones a fraction of the bounds
	const hdr = float('_TextureFormat', 0) !== 0;
	// the shader takes the frame from `_displayFrame` (1-based) unless it plays back on its own
	let fixedFrame: number | null = null;
	if (float('_B_autoPlayback', 0) === 0) {
		const frame = Math.floor(float('_displayFrame', 0)) - 1;
		fixedFrame = ((frame % frameCount) + frameCount) % frameCount;
	}
	return {
		texture: position.texture,
		min: hdr ? [0, 0, 0] : min,
		range: hdr ? [1, 1, 1] : [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
		frameCount,
		cycleRate: (float('_houdiniFPS', 0) / (frameCount - 0.01)) * float('_playbackSpeed', 1),
		cycleStart: float('_gameTimeAtFirstFrame', 0),
		fixedFrame,
		uScale: vatPadding(min[2]),
		vScale: vatPadding(max[0]),
	};
};

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
		case '_USE_SCREENUV': {
			// screen UVs relative to the object's pivot aren't drawn
			return float('_LocalPivortSpace', 0) === 0;
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
			// drawn by `softBodyOf`, which rejects the variants it can't draw first
			return true;
		}
		default: {
			return false;
		}
	}
};

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
	if (stencil !== null && 'kind' in stencil) {
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
	// the shader writes its alpha times `1 − _BlendMode`: 1 adds the premultiplied colour over what's behind, and
	// 2 writes `lerp(1, colour, alpha)` for a blend state that multiplies what's behind by it
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
	const softBody = softBodyOf(reader);
	if (softBody !== null && 'kind' in softBody) {
		return softBody;
	}
	const undrawn = material.keywords.filter(
		(keyword) => !BASE_KEYWORDS.has(keyword) && !baseKeywordDrawn(keyword, reader),
	);
	if (undrawn.length > 0) {
		return unsupported(`keywords ${undrawn.join(', ')}`);
	}
	const { tint, intensity } = stackTintOf(reader);
	const animOf = (prefix: string) => {
		// the shaders' UV rotations are pure rotations: (a, b) of the matrix's first column is (cos, sin)
		const rotation = color(`${prefix}UVRotateMat`) ?? [1, 0, 0, 1];
		return {
			scroll: color(`${prefix}UVSpeed`) ?? [0, 0, 0, 0],
			rotation: [rotation[0], rotation[1]] as [number, number],
		};
	};
	// polar and screen UVs are computed only with their keyword and switch, and are zero otherwise
	const computed = [
		true,
		true,
		has('_USE_POLARUV') && float('_UsePolarUV', 0) !== 0,
		has('_USE_SCREENUV') && float('_UseScreenUV', 0) !== 0,
	];
	// a slot's UVs are its weights times UV0, UV1, polar and screen UVs; materials set one weight
	const source = (prefix: string) => sourceOf(color(`${prefix}UVWeights`) ?? [1, 0, 0, 0], computed);
	const layers: (StackLayer | null)[] = BASE_SLOTS.map(() => null);
	for (const [i, name] of BASE_SLOTS.entries()) {
		// the main texture is always sampled, a sample texture only with its keyword
		if (i > 0 && !has(`_SAMPLE_TEX${i - 1}`)) {
			continue;
		}
		let slot: EffectSlot | undefined = reader.slot(name);
		// a sample texture samples the shader's default when the material binds none; an unset slot binds white.
		// the white talosite's shards take their mask from such a slot
		if (slot === undefined && i > 0 && reader.shader.textures[name] === 'white') {
			slot = UNSET_WHITE;
		}
		if (slot === undefined) {
			continue;
		}
		// the geometry carries UV sets 0 and 1 only
		if (slot.uv > 1) {
			return unsupported(`${name} on UV set ${slot.uv}`);
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
	const shared = sharedOf(reader, intensity);
	const soft = softBlendOf(reader);
	// both read the main pass's depth, which an opaque layer draws into
	if (opaque && (soft !== null || has('_USE_EDGECOLOR'))) {
		return unsupported('opaque blending with a soft blend or edge colour');
	}
	const offset = vertexOffsetOf(reader);
	// the mask only scales the offset, so without one it changes nothing
	const mask = offset === null ? null : offsetMaskOf(reader, layers);
	if (mask !== null && 'kind' in mask) {
		return mask;
	}
	return {
		kind: 'effectStack',
		variant: 'base',
		layers,
		tint,
		blendTint: shared.blendTint,
		disturb: shared.disturb,
		disturbBias: float('_Bi_Disturb', 0),
		distorted: float('_UseDisturb', 0) !== 0,
		// the ink-wash path puts UV0's v where the custom data's w would be
		particleDisturb:
			float('_UseParticleDisturb', 0) !== 0 &&
			!(float('_SyncDisturbWithInkWash', 0) !== 0 && float('_RenderTransparentAfterDOF', 0) !== 0),
		weight: {
			disturb: float('_WeightTexIntensity', 1) * float('_DisturbUseWeight', 0),
			dissolve: float('_WeightTexIntensity', 1) * float('_DissolveUseWeight', 0),
			used: float('_UseWeightTex', 0) !== 0,
		},
		dissolve: { ...shared.dissolve, on: float('_UseDissolve', 0) !== 0 },
		// as in the game, a mask or weight switched on without a texture in that role leaves nothing
		masked: float('_UseMask', 0) !== 0,
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
		brighten: { threshold: float('_ExpThreshold', 1), intensity: float('_ExpIntensity', 0) },
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
		blendMode,
		opaque,
		screenUv: {
			byDepth: float('_ScreenUVUseDepth', 1) !== 0,
			heightAsV: float('_UsePosYAsScreenV', 0) !== 0,
		},
		stencil,
	};
};

/** keywords of VFXDitherAlpha's effect variants that are drawn */
const DITHER_EFFECT_KEYWORDS = new Set([
	'_USE_DISSOLVE',
	'_USE_DISTURB',
	'_USE_MASK',
	'_USE_POLARUV',
	'_USE_SCREENUV',
]);

/** keywords VFXDitherAlpha's effect variants also draw, alongside one of {@link DITHER_EFFECT_KEYWORDS} */
const DITHER_EFFECT_EXTRA_KEYWORDS = new Set(['_USE_VERTOFFSET']);

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
	const { float, colorOrVector: color, has, material } = reader;
	const undrawn = material.keywords.filter(
		(keyword) => !DITHER_EFFECT_KEYWORDS.has(keyword) && !DITHER_EFFECT_EXTRA_KEYWORDS.has(keyword),
	);
	if (undrawn.length > 0) {
		return unsupported(`keywords ${undrawn.join(', ')}`);
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
	// the mask feeds only the tested alpha; the stack's mask also tints, which matches only when it's the red
	if (has('_USE_MASK') && float('_UseMaskTexAsAlpha', 1) === 0) {
		return unsupported('a mask that isn’t its red');
	}
	const computed = [
		true,
		true,
		has('_USE_POLARUV') && float('_UsePolarUV', 0) !== 0,
		has('_USE_SCREENUV') && float('_UseScreenUV', 0) !== 0,
	];
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
			redAlpha: true,
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
		if (bound.uv > 1) {
			return unsupported(`${slot.name} on UV set ${bound.uv}`);
		}
		const rotation = color(slot.rotation) ?? [1, 0, 0, 1];
		layers[i] = {
			...effectTexture(bound, color(slot.speed) ?? [0, 0, 0, 0], [rotation[0], rotation[1]]),
			role: slot.role,
			redAlpha: slot.redAlpha,
			source: sourceOf(color(slot.weights) ?? [1, 0, 0, 0], computed),
			disturbShare: slot.disturbed === null ? 0 : float(slot.disturbed, 1),
		};
	}
	// the colour pass emits `tint · intensity · vertex colour · main`; the depth pass tests the tint's alpha times
	// `_TintColorAlpha`, the vertex alpha, the main texture's alpha (its red), the mask's red, the dissolve and the
	// near fade
	const { tint, intensity } = stackTintOf(reader);
	const shared = sharedOf(reader, intensity);
	return {
		kind: 'effectStack',
		variant: 'dither',
		layers,
		tint,
		blendTint: shared.blendTint,
		disturb: shared.disturb,
		disturbBias: float('_Bi_Disturb', 0),
		distorted: has('_USE_DISTURB'),
		particleDisturb: false,
		weight: { disturb: 0, dissolve: 0, used: false },
		dissolve: { ...shared.dissolve, on: has('_USE_DISSOLVE') },
		masked: has('_USE_MASK'),
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
		blendMode: 0,
		opaque: false,
		screenUv: {
			byDepth: float('_ScreenUVUseDepth', 1) !== 0,
			heightAsV: float('_UsePosYAsScreenV', 0) !== 0,
		},
		stencil: null,
	};
};

/**
 * slots of a VFXDecal: each texture's role, the keyword that enables it, and the properties of its UV scroll,
 * rotation (degrees), distortion switch, UV source switch (0 the box, 1 the screen, 2 polar) and the constant
 * its speed's zw shifts by (`*CustomData`, in place of a particle's custom data). the shader runs through the
 * slots in order, so the disturb textures come before the weight and the textures they distort
 */
const DECAL_SLOTS = [
	{
		name: '_MainTex',
		role: 'main',
		keyword: null,
		speed: '_MainTexUVSpeed',
		rotate: '_MainTexUVRotate',
		disturbed: '_MainTexUseDisturb',
		source: '_MainSwitchUV',
		custom: '_MainCustomData',
	},
	{
		name: '_DisturbTex1',
		role: 'disturb1',
		keyword: '_USE_DISTURB',
		speed: '_DisturbUVSpeed1',
		rotate: null,
		disturbed: null,
		source: '_DisturbSwitchUV',
		custom: '_DisturbCustomData',
	},
	{
		name: '_DisturbTex2',
		role: 'disturb2',
		keyword: '_USE_DISTURB_TEX2',
		speed: '_DisturbUVSpeed2',
		rotate: null,
		disturbed: null,
		source: '_DisturbSwitchUV',
		custom: '_DisturbCustomData',
	},
	{
		name: '_WeightTex',
		role: 'weight',
		keyword: '_USE_WEIGHT',
		speed: null,
		rotate: null,
		disturbed: null,
		source: '_WeightSwitchUV',
		custom: null,
	},
	{
		name: '_MaskTex',
		role: 'mask',
		keyword: '_USE_MASK',
		speed: '_MaskTexUVSpeed',
		rotate: '_MaskTexUVRotate',
		disturbed: '_MaskTexUseDisturb',
		source: '_MaskSwitchUV',
		custom: '_MaskCustomData',
	},
	{
		name: '_BlendTex',
		role: 'blend',
		keyword: '_USE_BLEND',
		speed: '_BlendTexUVSpeed',
		rotate: '_BlendTexUVRotate',
		disturbed: '_BlendTexUseDisturb',
		source: '_BlendSwitchUV',
		custom: '_BlendCustomData',
	},
	{
		name: '_DissolveTex',
		role: 'dissolve',
		keyword: '_USE_DISSOLVE',
		speed: '_DissolveUVSpeed',
		rotate: '_DissolveUVRotate',
		disturbed: '_DissolveTexUseDisturb',
		source: '_DissolveSwitchUV',
		custom: '_DissolveCustomData',
	},
] as const;

/** keywords VFXDecal can have and still be drawn */
const DECAL_KEYWORDS = new Set([
	'_USE_MASK',
	'_USE_BLEND',
	'_USE_DISSOLVE',
	'_USE_DISTURB',
	'_USE_DISTURB_TEX2',
	'_USE_WEIGHT',
	'_USE_NORMALBLEND',
	'_USE_FOG',
	'_USE_POLARUV',
	'_USE_SCREENUV',
]);

/**
 * `HGRP/Effect/VFXDecal`, a box projecting the texture stack onto the surfaces inside it
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported`
 */
export const describeVfxDecal = (reader: MaterialReader): EffectStackSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has, material } = reader;
	if (material.blend !== 'premultiplied') {
		return unsupported(`${material.blend} blending`);
	}
	const keywords = undrawnKeywords(reader, DECAL_KEYWORDS);
	if (keywords !== null) {
		return keywords;
	}
	const base = color('_DecalBaseColor') ?? [1, 1, 1, 1];
	// a texture's UV switch picks polar or screen UVs only where they're computed; the box's otherwise
	const sources = new Map<number, EffectUvSource>();
	if (has('_USE_SCREENUV') && float('_UseScreenUV', 0) !== 0) {
		sources.set(1, 'screen');
	}
	if (has('_USE_POLARUV') && float('_UsePolarUV', 0) !== 0) {
		sources.set(2, 'polar');
	}
	const layers: (StackLayer | null)[] = Array.from({ length: 7 }, () => null);
	for (const [
		i,
		{ name, role, keyword, speed, rotate, disturbed, source, custom },
	] of DECAL_SLOTS.entries()) {
		const slot = reader.slot(name);
		if (slot === undefined || (keyword !== null && !has(keyword))) {
			continue;
		}
		// the geometry carries UV sets 0 and 1 only
		if (slot.uv > 1) {
			return unsupported(`${name} on UV set ${slot.uv}`);
		}
		// a rotation in degrees about the texture's centre
		const angle = rotate === null ? 0 : (float(rotate, 0) * Math.PI) / 180;
		// the shader applies the blend texture's `_ST` twice
		const transform: Pick<TextureSlot, 'texture' | 'scale' | 'offset'> =
			role === 'blend'
				? {
						texture: slot.texture,
						scale: [slot.scale[0] * slot.scale[0], slot.scale[1] * slot.scale[1]],
						offset: [slot.offset[0] * (slot.scale[0] + 1), slot.offset[1] * (slot.scale[1] + 1)],
					}
				: slot;
		const texture = effectTexture(transform, (speed !== null && color(speed)) || [0, 0, 0, 0], [
			Math.cos(angle),
			-Math.sin(angle),
		]);
		// off particles the shader shifts the UVs by the speed's zw times a constant of the material instead of
		// custom data, before the rotation: the same as moving the offset by the turned, scaled shift
		const k = custom === null ? 0 : float(custom, 0);
		const [c, s] = texture.rotation;
		const [u, v] = [texture.customScroll[0] * k, texture.customScroll[1] * k];
		layers[i] = {
			...texture,
			offset: [
				texture.offset[0] + (c * u - s * v) * texture.scale[0],
				texture.offset[1] + (s * u + c * v) * texture.scale[1],
			],
			customScroll: [0, 0],
			role,
			redAlpha:
				(role === 'main' && float('_UseMainTexAsAlpha', 0) !== 0) ||
				(role === 'mask' && float('_UseMaskTexAsAlpha', 0) !== 0),
			source: sources.get(float(source, 0)) ?? 'uv0',
			disturbShare: disturbed === null ? 0 : float(disturbed, 0),
		};
	}
	if (layers[0] === null) {
		return unsupported('no main texture');
	}
	// the dissolve edge takes the base colour's red as its intensity, as the shader reads it
	const shared = sharedOf(reader, base[0]);
	const weighted = has('_USE_WEIGHT');
	const intensity = float('_WeightTexIntensity', 1);
	return {
		kind: 'effectStack',
		variant: 'decal',
		layers,
		tint: [base[0], base[1], base[2], base[3] * float('_TintColorAlpha', 1)],
		blendTint: shared.blendTint,
		disturb: shared.disturb,
		disturbBias: float('_Bi_Disturb', 0),
		distorted: has('_USE_DISTURB'),
		particleDisturb: false,
		// the distortion and dissolve then scale by `1 − intensity + red · intensity`
		weight: weighted
			? {
					disturb: intensity * float('_DisturbUseWeight', 1),
					dissolve: intensity * float('_DissolveUseWeight', 0),
					used: true,
				}
			: { disturb: 0, dissolve: 0, used: false },
		dissolve: { ...shared.dissolve, on: has('_USE_DISSOLVE') },
		masked: has('_USE_MASK'),
		fresnel: null,
		soft: null,
		ignorePostExposure: shared.ignorePostExposure,
		vertexColor: false,
		near: shared.near,
		brighten: { threshold: 0, intensity: 0 },
		breathing: null,
		edge: null,
		decalFade: {
			edge: [float('_EdgeFadeX', 0), float('_EdgeFadeZ', 0)],
			width: float('_EdgeFadeIntensity', 0),
			height: Math.max(float('_HeightFade', 0), 1e-3),
			heightOffset: float('_HeightFadeOffset', 0),
			angle: has('_USE_NORMALBLEND') ? float('_AngleBlendFallOff', 1) : 0,
		},
		alphaPower: 1,
		offset: null,
		softBody: null,
		cameraPull: null,
		waterBlendBelow: null,
		lighting: null,
		unfogged: !has('_USE_FOG'),
		blendMode: 0,
		opaque: false,
		screenUv: { byDepth: false, heightAsV: false },
		stencil: null,
	};
};

// #endregion

// #region water sheets

/**
 * VFXWater keywords that are drawn. `VFX_WATER_SIMPLE_LIGHT`, the game's cheaper lighting from a per-draw
 * ambient probe and the far shadow, is lit the full way
 */
const WATER_KEYWORDS = new Set([
	'_SUBSURFACE',
	'_USE_DISTURB',
	'_USE_MASK',
	'_USE_DISSOLVE',
	'_USE_SOFTBLEND',
	'_NORMAL_MAP',
	'_USE_SEQUENCE_FRAME',
	'_USE_SEQUENCE_FRAME_MV',
	'_USE_SEQUENCE_FRAME_NORMAL',
	'VFX_WATER_SIMPLE_LIGHT',
]);

/** a water sheet texture, once those on other UV sets (`'uv'`) have been rejected */
const texture = (value: EffectTexture | null | 'uv'): EffectTexture | null => (value === 'uv' ? null : value);

/**
 * `HGRP/Effect/VFXWater`, the sheets of falling water (`docs/game-data/effects.md#waterfalls`)
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported` for features the viewer doesn't draw (refraction, vertex animation)
 */
export const describeWaterSheet = (reader: MaterialReader): WaterSheetSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has, material } = reader;
	if (material.blend !== 'premultiplied') {
		return unsupported(`${material.blend} blending`);
	}
	const keywords = undrawnKeywords(reader, WATER_KEYWORDS);
	if (keywords !== null) {
		return keywords;
	}
	const sequence = has('_USE_SEQUENCE_FRAME');
	if (sequence && reader.slot('_SequenceBaseColorMap') === undefined) {
		return unsupported('a flipbook without its texture');
	}
	/** a used slot; the sheets are drawn from UV set 0 alone */
	const used = (name: string, on: boolean): TextureSlot | null | 'uv' => {
		const slot = on ? reader.slot(name) : undefined;
		if (slot === undefined) {
			return null;
		}
		return slot.uv > 0 ? 'uv' : slot;
	};
	const animated = (name: string, on: boolean, prefix: string, suffix = ''): EffectTexture | null | 'uv' => {
		const slot = used(name, on);
		if (slot === null || slot === 'uv') {
			return slot;
		}
		const rotation = color(`${prefix}UVRotateMat${suffix}`) ?? [1, 0, 0, 1];
		return effectTexture(slot, color(`${prefix}UVSpeed${suffix}`) ?? [0, 0, 0, 0], [
			rotation[0],
			rotation[1],
		]);
	};
	/** the flipbook samples its frames' UVs as they are */
	const frames = (name: string, on: boolean): EffectTexture | null | 'uv' => {
		const slot = used(name, on);
		return slot === null || slot === 'uv'
			? slot
			: effectTexture({ texture: slot.texture, scale: [1, 1], offset: [0, 0] });
	};
	const main = animated('_MainTex', true, '_MainTex');
	const disturb = animated('_DisturbTex1', has('_USE_DISTURB'), '_Disturb', '1');
	const mask = animated('_MaskTex', has('_USE_MASK'), '_MaskTex');
	const dissolveMap = animated('_DissolveTex', has('_USE_DISSOLVE'), '_Dissolve');
	const sequenceMap = frames('_SequenceBaseColorMap', sequence);
	const sequenceMotion = frames('_SequenceMotionVectorMap', sequence && has('_USE_SEQUENCE_FRAME_MV'));
	const textures = [main, disturb, mask, dissolveMap, sequenceMap, sequenceMotion];
	if (textures.includes('uv')) {
		return unsupported('a texture on a UV set other than 0');
	}
	if (main === null && reader.shader.textures['_MainTex'] !== 'white') {
		return unsupported('no main texture and a non-white default');
	}
	// the flipbook's normals, or a normal map
	let normals: WaterSheetSurface['textures']['normals'] = null;
	{
		const flipbook = sequence && has('_USE_SEQUENCE_FRAME_NORMAL');
		const name = flipbook ? '_SequenceNormalMap' : has('_NORMAL_MAP') ? '_NormalMap' : null;
		const slot = name === null ? undefined : reader.slot(name);
		if (slot !== undefined && slot.uv === 0) {
			const rotation = color('_NormalMapUVRotateMat') ?? [1, 0, 0, 1];
			normals = {
				texture: flipbook
					? effectTexture({ texture: slot.texture, scale: [1, 1], offset: [0, 0] })
					: // the normal map takes no custom data
						effectTexture(slot, (color('_NormalMapUVSpeed') ?? [0, 0]).slice(0, 2), [
							rotation[0],
							rotation[1],
						]),
				flipbook,
				scale: flipbook ? float('_FrameNormalScale', 1) : float('_NormalScale', 1),
			};
		}
	}
	const intensity = float('_TintColorIntensity', 1);
	// VFXWater's `_TintColor` and `_DissolveEmissiveColor` are [HDR]: authored linear, used as stored
	const tint = color('_TintColor') ?? [1, 1, 1, 1];
	const shared = sharedOf(reader, intensity);
	const frameSize = color('_SequenceFrameSize') ?? [1, 1, 0, 0];
	return {
		kind: 'waterSheet',
		tint: [...scaleRgb(tint, intensity), tint[3] * float('_TintColorAlpha', 1)],
		textures: {
			main: texture(main),
			disturb: texture(disturb),
			mask: texture(mask),
			dissolve: texture(dissolveMap),
			sequence: texture(sequenceMap),
			sequenceMotion: texture(sequenceMotion),
			normals,
		},
		disturbNormal: float('_DisturbTex1Normal', 0) !== 0,
		mainAsAlpha: float('_UseMainTexAsAlpha', 1) !== 0,
		maskAsAlpha: float('_UseMaskTexAsAlpha', 1) !== 0,
		vertexOpacity: float('_UseVertexColorAsOpacity', 0) !== 0,
		fresnelOpacity: float('_UseFresnelAsOpacity', 0) !== 0,
		vertexColor: float('_DisableVertColor', 0) === 0,
		blendMode: float('_BlendMode', 0),
		useLighting: float('_UseLighting', 1),
		randomUv: float('_WaterRandomUV', 0),
		disturbBias: float('_Bi_Disturb', 0),
		disturb: [float('_DisturbUIntensity1', 0), float('_DisturbVIntensity1', 0)],
		disturbUse: [
			float('_MainTexUseDisturb', 0),
			float('_MaskTexUseDisturb', 0),
			float('_NormalMapUseDisturb', 0),
			float('_DissolveTexUseDisturb', 0),
		],
		dissolve: shared.dissolve,
		sequence: {
			columns: Math.max(frameSize[0], 1),
			rows: Math.max(frameSize[1], 1),
			framesPerSecond: float('_PlaybackSpeed', 0),
			randomStartByPosition: float('_RandomStartByPos', 0),
			motionStrength: float('_MotionVectorDistortionStrength', 0),
			opacityScale: float('_SequenceOpacityScale', 1),
			opacityThreshold: float('_SequenceOpacitySdf', 0),
			colorThreshold: float('_SequenceBaseColorSdf', 0),
			tint: linearRgb(color('_SequenceBaseColorMapTint') ?? [1, 1, 1, 1]),
		},
		roughness: float('_Roughness', 1),
		specular: float('_Specular', 1),
		directSpecular: float('_DirSpecularStrength', 1),
		fresnel: float('_FresnelStrength', 0),
		subsurface: [
			float('_SubsurfaceHue', 1),
			float('_SubsurfaceSaturation', 1),
			has('_SUBSURFACE') ? float('_SubsurfaceValue', 1) : 0,
			float('_SubsurfaceIndirect', 1),
		],
		indirectSaturation: float('_IndirectSaturation', 1),
		soft: softBlendOf(reader),
		ignorePostExposure: shared.ignorePostExposure,
		near: shared.near,
	};
};

// #endregion

// #region lit decals

/** lit decal keywords that are drawn; the others change the surface in ways the viewer doesn't */
const LIT_DECAL_KEYWORDS = new Set([
	'_COMPLETE_PBR',
	'_NORMAL_ANGLE_BLEND',
	'_BLEND_WATER_FLOW',
	'_BLEND_EMISSIVE',
]);

/** Unity's `ColorWriteMask` bits */
const WRITE_RED = 8;
const WRITE_GREEN = 4;
const WRITE_BLUE = 2;

/**
 * `HGRP/DecalLit`, the projected decals of the scenery (`docs/game-data/materials.md#decals`), written over
 * the surface through the colour masks the material sets (`_ColorMask1` metallic and occlusion, `_ColorMask2`
 * normal and roughness, `_ColorMask3` albedo)
 *
 * @param reader the material's properties; each placement's colour and UV transform are its instance row's
 * @returns its surface, `undrawn` when it changes nothing the viewer draws, or `unsupported`
 */
export const describeLitDecal = (
	reader: MaterialReader,
): LitDecalSurface | UndrawnSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has } = reader;
	const keywords = undrawnKeywords(reader, LIT_DECAL_KEYWORDS);
	if (keywords !== null) {
		return keywords;
	}
	const invisible: UndrawnSurface = { kind: 'undrawn', reason: 'writes nothing the viewer draws' };
	const waterFlow = has('_BLEND_WATER_FLOW');
	// the emission target's mask is fixed, so emissive decals always write it
	const emissive = !waterFlow && has('_BLEND_EMISSIVE');
	const relight = (float('_ColorMask3', 0) & WRITE_RED) === 0;
	const surfaceMask = float('_ColorMask2', 0);
	if (relight && !emissive && (surfaceMask & (WRITE_RED | WRITE_GREEN | WRITE_BLUE)) === 0) {
		return invisible;
	}
	const base = reader.slot('_BaseColorMap');
	if (base === undefined) {
		return unsupported('no base colour map');
	}
	const pbrBase = !waterFlow && float('_BaseTexChannel', 0) !== 0;
	let pbr: LitDecalSurface['pbr'] = null;
	if (waterFlow) {
		// the water's normal map projects at world positions; its `_ST` scale is per metre
		const water = reader.slot('_WaterNormalTex');
		if (water !== undefined) {
			pbr = { texture: water.texture, ownTransform: { scale: [...water.scale], offset: [0, 0] } };
		}
	} else {
		const map = pbrBase ? base : reader.slot('_SampleTex1');
		if (map !== undefined) {
			// its own `_ST` applies to the box's UVs only with `_SampleTex1UVSet`
			const own = !pbrBase && float('_SampleTex1UVSet', 0) !== 0;
			pbr = {
				texture: map.texture,
				ownTransform: own ? { scale: [...map.scale], offset: [...map.offset] } : null,
			};
		}
	}
	// a relit decal changes the surface only through the PBR map and its emission
	if (relight && pbr === null && !emissive) {
		return invisible;
	}
	const pbrMask = float('_ColorMask1', 0);
	const emission = color('_EmissiveColor') ?? [0, 0, 0, 1];
	return {
		kind: 'litDecal',
		base: base.texture,
		opacity: float('_DecalOpacity', 1),
		pbr,
		relight,
		roughness: [float('_RoughnessMin', 0), float('_RoughnessMax', 1)],
		normalScale: float('_NormalScale', 1),
		angleFade: has('_NORMAL_ANGLE_BLEND') ? Math.max(float('_AngleBlendFallOff', 1), 1e-3) : 0,
		writesNormal: pbr !== null && (surfaceMask & (WRITE_RED | WRITE_GREEN)) !== 0,
		writesRoughness: pbr !== null && (surfaceMask & WRITE_BLUE) !== 0,
		writesMetallic: (pbrMask & WRITE_RED) !== 0,
		writesOcclusion: (pbrMask & WRITE_GREEN) !== 0,
		blendSceneNormal: float('_BlendSceneNormal', 0),
		metallic: float('_Metallic', 0),
		occlusionStrength: float('_OcclusionStrength', 1),
		pbrBase,
		metallicChannel: float('_MetallicChannel', 0),
		occlusionChannel: float('_OcclusionChannel', 0),
		affectNormal: float('_AffectNormal', 0),
		waterFlow: waterFlow
			? {
					normalScale: float('_WaterNormalScale', 1),
					roughness: float('_WaterRoughness', 0),
					normalFactor: float('_NormalFactor', 0),
					movement: color('_UVMovement') ?? [0, 0, 1, 1],
					levelFade: Math.max(float('_AngleBlendFallOff2', 1), 1e-3),
				}
			: null,
		emission: emissive
			? {
					color: [emission[0], emission[1], emission[2]],
					channel: float('_EmissiveChannel', 0),
					albedoAffect: float('_AlbedoAffectEmissive', 1),
					ignorePostExposure: float('_IgnorePostExposure', 1),
				}
			: null,
	};
};

// #endregion

// #region refraction

/** keywords of `HGRP/Effect/VFXRefract` that are drawn */
const REFRACT_KEYWORDS = new Set([
	'_USE_BLEND',
	'_USE_DISSOLVE',
	'_USE_MASK',
	'_USE_POLARUV',
	'_USE_RBOFFSET',
	'_USE_RGBOFFSET',
	'_USE_SOFTBLEND',
	'_USE_SPREAD',
]);

/**
 * `HGRP/Effect/VFXRefract`: the scene behind, seen at an offset that a texture sets, masked
 * (`docs/game-data/effects.md#refraction`)
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported`
 */
export const describeRefract = (reader: MaterialReader): RefractSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has, material } = reader;
	if (material.blend !== 'alphaBlend') {
		return unsupported(`${material.blend} blending`);
	}
	const keywords = undrawnKeywords(reader, REFRACT_KEYWORDS);
	if (keywords !== null) {
		return keywords;
	}
	const polar = has('_USE_POLARUV');
	/** the shader reads UV0, or polar UVs about its centre with either switch value */
	const textureOf = (
		name: string,
		rotate: string,
		speed: string,
		switchName: string,
	): { texture: EffectTexture; polar: boolean } | UnsupportedSurface => {
		const switched = float(switchName, 0) !== 0;
		if (switched && !polar) {
			return unsupported(`${switchName} without polar UVs`);
		}
		const bound = reader.slot(name) ?? UNSET_WHITE;
		if (bound.uv !== 0) {
			return unsupported(`${name} on UV set ${bound.uv}`);
		}
		// the rotation in degrees, as the matrix with columns (cos, −sin) and (sin, cos)
		const angle = (float(rotate, 0) * Math.PI) / 180;
		return {
			texture: effectTexture(bound, color(speed) ?? [0, 0, 0, 0], [Math.cos(angle), -Math.sin(angle)]),
			polar: switched,
		};
	};
	const refraction = textureOf('_RefractTex', '_RefractTexUVRotate', '_RefractUVSpeed', '_RefractSwitchUV');
	if ('kind' in refraction) {
		return refraction;
	}
	let mask: RefractSurface['mask'] = null;
	if (has('_USE_MASK')) {
		const masked = textureOf('_MaskTex', '_MaskTexUVRotate', '_MaskTexUVSpeed', '_MaskSwitchUV');
		if ('kind' in masked) {
			return masked;
		}
		mask = { ...masked, redAlpha: float('_UseMaskTexAsAlpha', 1) !== 0 };
	}
	let dissolve: RefractSurface['dissolve'] = null;
	if (has('_USE_DISSOLVE')) {
		// the dissolve texture always reads UV0, without a polar switch
		const bound = reader.slot('_DissolveTex') ?? UNSET_WHITE;
		if (bound.uv !== 0) {
			return unsupported(`_DissolveTex on UV set ${bound.uv}`);
		}
		const angle = (float('_DissolveUVRotate', 0) * Math.PI) / 180;
		dissolve = {
			// VFXRefract's dissolve UVs take no custom data
			texture: effectTexture(bound, (color('_DissolveUVSpeed') ?? [0, 0]).slice(0, 2), [
				Math.cos(angle),
				-Math.sin(angle),
			]),
			threshold: float('_DissolveScheduleOffset', 0) * 2.02 - 1.01,
			sharpness: float('_DissolveEdgeSharp', 1),
			affectsAlpha: float('_DissolveAffectBlend', 0),
		};
	}
	let blend: RefractSurface['blend'] = null;
	if (has('_USE_BLEND')) {
		const blended = textureOf('_BlendTex', '_BlendTexUVRotate', '_BlendTexUVSpeed', '_BlendSwitchUV');
		if ('kind' in blended) {
			return blended;
		}
		const tint = color('_BlendColor') ?? [1, 1, 1, 1];
		blend = {
			...blended,
			redAlpha: float('_UseBlendTexAsAlpha', 0) !== 0,
			// [HDR]: used as stored
			color: [tint[0], tint[1], tint[2], tint[3]],
			usesRefraction: float('_BlendTexUseRefract', 0),
		};
	}
	let spread: RefractSurface['spread'] = null;
	if (has('_USE_SPREAD')) {
		// no variant pairs the spread with polar UVs, and its UVs take no custom data
		const bound = reader.slot('_SpreadTex') ?? UNSET_WHITE;
		if (bound.uv !== 0) {
			return unsupported(`_SpreadTex on UV set ${bound.uv}`);
		}
		const angle = (float('_SpreadUVRotate', 0) * Math.PI) / 180;
		spread = {
			texture: effectTexture(bound, (color('_SpreadUVSpeed') ?? [0, 0]).slice(0, 2), [
				Math.cos(angle),
				-Math.sin(angle),
			]),
			schedule: float('_SpreadScheduleOffset', 0),
			range: Math.max(float('_SpreadRange', 1), 1e-6),
			flip: float('_SpreadFlip', 0),
			alphaScale: float('_SpreadAlphaCurve', 1),
		};
	}
	const dir = color('_RefractDir') ?? [1, 1, 0, 0];
	let colorOffsets: RefractSurface['colorOffsets'] = null;
	// `_USE_RGBOFFSET` only adds a second further sample to `_USE_RBOFFSET`'s, with a mask per sample
	if (has('_USE_RBOFFSET')) {
		const offset = color('_RBOffset') ?? [0, 0, 0, 0];
		const scale = 0.01 * float('_Intensity', 1);
		const second = has('_USE_RGBOFFSET');
		colorOffsets = {
			offset: [offset[0] * scale, offset[1] * scale],
			secondShare: float('_GOffset', -1),
			intensity: float('_RBIntensity', 1),
			main: linearRgb(color('_RBMainColorMask') ?? [1, 0, 0, 1]),
			first: linearRgb(color(second ? '_RBOffset1ColorMask' : '_RBOffsetColorMask') ?? [0, 1, 1, 1]),
			mainAsMask: float('_UseMainTexAsMask', 0),
			second: second ? linearRgb(color('_RBOffset2ColorMask') ?? [0, 0, 1, 1]) : null,
		};
	}
	return {
		kind: 'refract',
		refraction: refraction.texture,
		refractionPolar: refraction.polar,
		mask,
		direction: [dir[0], dir[1]],
		strength: float('_Intensity', 1) * float('_TintColorAlpha', 1),
		bias: float('_Bi_Refract', 0),
		isNormal: float('_RefractIsNormal', 1) !== 0,
		maskUsesRefraction: float('_MaskTexUseRefract', 0),
		colorOffsets,
		dissolve,
		blend,
		spread,
		// soft blend: the cover fades out over `_SoftDistance` in front of what lies behind
		softDistance: softBlendOf(reader)?.distance ?? 0,
		near: nearFadeOf(reader),
	};
};

// #endregion

// #region water foam

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
	const textureOf = (name: string, speed: string | null): EffectTexture =>
		effectTexture(reader.slot(name) ?? UNSET_WHITE, (speed !== null && color(speed)) || [0, 0, 0, 0]);
	const edgeRange = color('_EdgeFadeRange') ?? [0, 0, 0, 0];
	let dissolve: WaterFoamSurface['dissolve'] = null;
	if (has('_USE_DISSOLVE')) {
		const edge = color('_DissolveEmissiveColor') ?? [0, 0, 0, 0];
		dissolve = {
			threshold: float('_DissolveScheduleOffset', 0) * 2.02 - 1.01,
			sharpness: float('_DissolveEdgeSharp', 1),
			edgeWidth: float('_DissolveEmissiveEdge', 0),
			edgeColor: [edge[0], edge[1], edge[2]],
		};
	}
	const base = color('_BaseColor') ?? [0, 0, 0, 0];
	const tint = color('_BaseColorTint') ?? [1, 1, 1, 1];
	return {
		kind: 'waterFoam',
		textures: {
			base: textureOf('_BaseColorMap', '_BaseColorSpeed'),
			disturb: has('_USE_DISTURB') ? textureOf('_DisturbTex1', '_DisturbUVSpeed1') : null,
			mask: has('_USE_MASK') ? textureOf('_MaskTex', '_MaskTexUVSpeed') : null,
			dissolve: dissolve === null ? null : textureOf('_DissolveTex', '_DissolveUVSpeed'),
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
		disturb: [float('_DisturbUIntensity1', 0), float('_DisturbVIntensity1', 0)],
		disturbUse: [
			float('_MainTexUseDisturb', 0),
			float('_MaskTexUseDisturb', 0),
			float('_DissolveTexUseDisturb', 0),
		],
		edgeFade: float('_UseEdgeFade', 0) !== 0 ? [edgeRange[0], edgeRange[1]] : null,
		clipToBox: float('_MeshType', 0) !== 0,
		depthTest: zTest === 4 ? 'lessEqual' : 'greater',
		blendMode: float('_BlendMode', 0),
		opacity: float('_OverallOpacity', 1),
		soft: has('_USE_SOFTBLEND')
			? { bias: float('_SoftBias', 0), distance: Math.max(float('_SoftDistance', 1), 1e-6) }
			: null,
		dissolve,
	};
};

// #endregion

// #region light beams

/**
 * beam keywords that are drawn. `VLB_NOISE_3D`'s noise is left out; under `VLB_USE_FOG`, alpha-blended beams
 * take the composite's fog and additive ones stay unfogged
 */
const BEAM_KEYWORDS = new Set(['VLB_DEPTH_BLEND', 'VLB_NOISE_3D', 'VLB_USE_FOG']);

/**
 * `Hidden/VLB_*` (`docs/game-data/lighting.md#light-beams`)
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported` for keywords or blending the viewer doesn't draw
 */
export const describeLightBeam = (reader: MaterialReader): LightBeamSurface | UnsupportedSurface => {
	const { float, colorOrVector, has } = reader;
	const keywords = undrawnKeywords(reader, BEAM_KEYWORDS);
	if (keywords !== null) {
		return keywords;
	}
	const blendMode = float('_BlendMode', 0);
	const src = float('_BlendSrcFactor', BlendFactor.One);
	const dst = float('_BlendDstFactor', BlendFactor.One);
	const additive = blendMode === 1 && src === BlendFactor.One && dst === BlendFactor.One;
	const blended = blendMode === 0 && src === BlendFactor.SrcAlpha && dst === BlendFactor.OneMinusSrcAlpha;
	if (!additive && !blended) {
		return unsupported(`blend mode ${blendMode} with factors ${src}, ${dst}`);
	}
	const flat = colorOrVector('_ColorFlat') ?? [1, 1, 1, 1];
	return {
		kind: 'lightBeam',
		color: [...linearRgb(flat), flat[3]],
		cone: colorOrVector('_ConeParams0') ?? [1, 1, 1, 0],
		direction: colorOrVector('_ConeParams1') ?? [0, 0, 1, 0],
		falloff: colorOrVector('_DistanceFallOff') ?? [0, 1, 1, 0],
		alphaInside: float('_AlphaInside', 1),
		alphaOutside: float('_AlphaOutside', 1),
		attenuationLerp: float('_AttenuationLerpLinearQuad', 0.5),
		fresnelPower: float('_FresnelPow', 1),
		glareFrontal: float('_GlareFrontal', 0.5),
		glareBehind: float('_GlareBehind', 0.5),
		apexOffset: float('_ConeGeomProps', 0),
		additive,
		distanceFade: fadeRange(float('_DistanceFadeStart', 0), float('_DistanceFadeEnd', 1)),
		distanceFadeSecond: fadeRange(float('_DistanceFadeStartSecond', 0), float('_DistanceFadeEndSecond', 0)),
		cameraClipping: float('_DistanceCamClipping', 0.5),
		depthBlend: has('VLB_DEPTH_BLEND') ? float('_DepthBlendDistance', 2) : 0,
		depthBlendCapOff: float('_DepthBlendCapOff', 0),
		useClippingPlane: float('_UseClippingPlane', 0),
		clippingPlane: colorOrVector('_AdditionalClippingPlaneWS') ?? [0, 1, 0, 0],
		tilt: [float('_TiltVectorX', 0), float('_TiltVectorY', 0)],
		clippingPlaneTransition: Math.max(float('_ClippingPlaneTransition', 1), 1e-4),
		unfogged: !has('VLB_USE_FOG'),
	};
};

// #endregion

// #region six-way smoke

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
	const { float, colorOrVector: color, has, material } = reader;
	if (material.blend !== 'alphaBlend') {
		return unsupported(`${material.blend} blending`);
	}
	const keywords = undrawnKeywords(reader, SIX_WAY_KEYWORDS);
	if (keywords !== null) {
		return keywords;
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
		const screenDepth = float(`${prefix}ScreenDepthUV`, 0) !== 0;
		switch (switched ? float(`${prefix}SwitchUV`, 0) : 0) {
			case 1: {
				return { source: 'screen', screenDepth };
			}
			case 2: {
				return { source: 'polar', screenDepth };
			}
			default: {
				return { source: 'uv0', screenDepth };
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
	/** the shader turns UVs by `-rotate` degrees about their centre, after the scroll and before the `_ST` */
	const turned = (prefix: string): [cos: number, sin: number] => {
		const radians = (float(`${prefix}UVRotate`, 0) * Math.PI) / 180;
		return [Math.cos(radians), -Math.sin(radians)];
	};
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
			color('_LightMapUVSpeed') ?? [0, 0, 0, 0],
			turned('_LightMap'),
		),
		...switchedSource('_LightMap'),
		disturbShare: float('_LightMapUseDisturb', 0),
	};
	const layer = (slot: EffectSlot, prefix: string, share: string, source: SixWayUvSource): SixWayTexture => ({
		...effectTexture(slot, color(`${prefix}UVSpeed`) ?? [0, 0, 0, 0], turned(prefix)),
		...source,
		disturbShare: float(share, 0),
	});
	// UV set 1 replaces the dissolve's switched UVs; on particles it holds UV0's (above)
	const dissolveSource: SixWayUvSource =
		float('_DissolveUVSet', 0) !== 0 ? { source: 'uv0', screenDepth: false } : switchedSource('_Dissolve');
	const disturbLayer = (slot: EffectSlot | null, n: 1 | 2): DisturbLayer | null =>
		slot === null
			? null
			: {
					texture: effectTexture(slot, color(`_DisturbUVSpeed${n}`) ?? [0, 0, 0, 0]),
					intensity: [float(`_DisturbUIntensity${n}`, 0), float(`_DisturbVIntensity${n}`, 0)],
					normal: float(`_DisturbTex${n}Normal`, 0) !== 0,
				};
	const { tint, intensity } = stackTintOf(reader);
	const shared = sharedOf(reader, intensity);
	return {
		kind: 'sixWaySmoke',
		positive: lightmap,
		negative: negative.texture,
		disturb: [disturbLayer(disturb1, 1), disturbLayer(disturb2, 2)],
		disturbSource: switchedSource('_Disturb'),
		disturbBias: float('_Bi_Disturb', 0),
		screenVFromHeight: float('_UsePosYAsScreenV', 0) !== 0,
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
						texture: layer(dissolve, '_Dissolve', '_DissolveTexUseDisturb', dissolveSource),
						dissolve: { ...shared.dissolve, on: true },
					},
		tint,
		vertexColor: float('_DisableVertColor', 0) === 0,
		brighten: { threshold: float('_ExpThreshold', 1), intensity: float('_ExpIntensity', 0) },
		// as the shader derives it
		absorptionRange: (float('_AbsorptionRange', 1) + 1 / Math.PI) / (1 - 1 / Math.PI),
		envSaturation: float('_EnvLightSaturation', 1),
		soft: softBlendOf(reader),
		near: shared.near,
		unfogged: !has('_USE_FOG'),
	};
};

// #endregion
