/**
 * how the viewer draws the game's scene effect meshes, `HGRP/Effect/VFXBaseV2` and `HGRP/Effect/VFXDecal`:
 * unlit, premultiplied layers built from a stack of scrolling textures, drawn in the transparent pass by
 * `effect.wgsl`. the decal projects its textures down its box onto whatever the main pass drew inside it. the
 * mist, `HGRP/FogSimple` cards and `HGRP/Effect/VFXFakeVolumeFog` boxes, has looks of its own
 * ({@link MistRow}), and so do the lit waterfall sheets of `HGRP/Effect/VFXWater` ({@link WaterSheetRow}).
 *
 * both shaders combine textures by role. a texture can distort the UVs of the textures sampled after it
 * (disturb), scale that distortion (weight), multiply the colour and alpha (mask), add a tinted layer (blend)
 * or eat the alpha away below a threshold (dissolve). VFXBaseV2 gives each `_SampleTexN` its role by its
 * `_SampleTexNUseWeightK` properties; VFXDecal has one fixed texture per role.
 *
 * VFXBaseV2's vertex offset moves vertices in `effect.wgsl`'s vertex stage. materials using features this
 * doesn't draw (offset masks, polar or screen UVs, lighting, flipbooks and the like) stay hidden, as do
 * additive ones, which the transparent pass's blending can't express.
 *
 * @module
 */

import type { ReadyMaterial, ShaderEntry } from '@endfield-noclip/package-format/materials';

import { linearRgb } from './color.ts';

/** a look's {@link EffectRow.slotBits} role value for a texture that isn't sampled */
export const ROLE_NONE = 7;

/** the roles a texture plays, as `effect.wgsl` numbers them */
export const EffectRole = {
	Disturb1: 0,
	Disturb2: 1,
	Weight: 2,
	Mask: 3,
	Blend: 4,
	Dissolve: 5,
	/** the base colour and alpha */
	Main: 6,
} as const;

/** float offsets of an effect look's parameters (`MaterialLook.params`); the shader reads them as vec4 rows */
export const EffectRow = {
	/** tint rgb (times its intensity), alpha */
	tint: 0,
	/** one UV transform per texture slot: scale, offset */
	uv: 4,
	/** per slot: UV scroll per second (xy), the UV rotation's cosine and sine */
	anim: 32,
	/** per slot: role, plus 8 when the slot's UVs take the distortion, plus 16 when its red channel is its alpha */
	slotBits: 60,
	/** the blend layer's tint rgb (HDR), w = how strongly it covers */
	blendTint: 68,
	/** distortion per unit of the first and second disturb texture: u1, v1, u2, v2 */
	disturb: 72,
	/**
	 * `_Bi_Disturb`, the weight texture's strength on the distortion, on the dissolve, 1 when the weight is
	 * used
	 */
	weight: 76,
	/** dissolve threshold, edge sharpness, glowing edge width, 1 when dissolving */
	dissolve: 80,
	/** the dissolve edge's colour (HDR), 1 when a mask is used */
	dissolveColor: 84,
	/** Fresnel power, bias, flip, how much it affects opacity (0 without `_USE_FRESNEL`) */
	fresnel: 88,
	/**
	 * soft blend distance (0 without `_USE_SOFTBLEND`), soft blend bias, `_IgnorePostExposure`, 1 to use vertex
	 * colours
	 */
	soft: 92,
	/** near camera fade: start, end, second start, second end (view depth, m) */
	near: 96,
	/** 1 with the near camera fade, brightening threshold, brightening intensity, 1 with distortion */
	misc: 100,
	/** decals: edge fade across x, across z, the fades' width, height fade */
	decalFade: 104,
	/** decals: height fade offset, angle falloff (0: no angle fade), 0, 0 */
	decal: 108,
	/**
	 * VFXBaseV2 vertex offset: `_OffsetDir` xyz, then how it's read: 0 in object space, 1 in world space, 2
	 * along the vertex normal (`_OffsetSwitchDir`)
	 */
	offsetDir: 112,
	/**
	 * VFXBaseV2 vertex offset: `_OffsetIntensity`, `_Bi_Offset`, how much the vertex alpha weighs the offset,
	 * the most it pulls vertices towards the camera (`_VertCameraOffset`, m)
	 */
	offset: 116,
	/** VFXBaseV2 vertex offset: 1 when on, 1 when the offset texture reads UV set 1, 0, 0 */
	offsetMode: 120,
	/**
	 * 1 when the layer goes unfogged (its material lacks `_USE_FOG`, and the game draws effects after the fog),
	 * 0, 0, 0
	 */
	unfogged: 124,
} as const;

/** slots of a VFXBaseV2 look: the main texture, then `_SampleTex0`… */
const BASE_SLOTS = ['_MainTex', '_SampleTex0', '_SampleTex1', '_SampleTex2', '_SampleTex3', '_SampleTex4'];

/**
 * the VFXBaseV2 slot of `_OffsetTex`, which the vertex stage samples; its UV and scroll rows hold the
 * texture's `_ST` and `_OffsetSpeed`
 */
export const OFFSET_SLOT = 6;

/** the material property of the vertex offset's texture */
const OFFSET_TEXTURE = '_OffsetTex';

/** the property whose `_ST` a VFXBaseV2 sample texture uses, by role */
const ROLE_TEXTURES = ['_DisturbTex1', '_DisturbTex2', '_WeightTex', '_MaskTex', '_BlendTex', '_DissolveTex'];

/**
 * slots of a VFXDecal look: each texture's role, the keyword that enables it, and the properties of its UV
 * scroll, rotation (degrees) and distortion switch, where it has them. the shader runs through the slots in
 * order, so the disturb textures come before the textures they distort
 */
const DECAL_SLOTS = [
	{
		name: '_MainTex',
		role: EffectRole.Main,
		keyword: null,
		speed: '_MainTexUVSpeed',
		rotate: '_MainTexUVRotate',
		disturbed: '_MainTexUseDisturb',
	},
	{
		name: '_DisturbTex1',
		role: EffectRole.Disturb1,
		keyword: '_USE_DISTURB',
		speed: '_DisturbUVSpeed1',
		rotate: null,
		disturbed: null,
	},
	{
		name: '_DisturbTex2',
		role: EffectRole.Disturb2,
		keyword: '_USE_DISTURB_TEX2',
		speed: '_DisturbUVSpeed2',
		rotate: null,
		disturbed: null,
	},
	{
		name: '_MaskTex',
		role: EffectRole.Mask,
		keyword: '_USE_MASK',
		speed: '_MaskTexUVSpeed',
		rotate: '_MaskTexUVRotate',
		disturbed: '_MaskTexUseDisturb',
	},
	{
		name: '_BlendTex',
		role: EffectRole.Blend,
		keyword: '_USE_BLEND',
		speed: '_BlendTexUVSpeed',
		rotate: '_BlendTexUVRotate',
		disturbed: '_BlendTexUseDisturb',
	},
	{
		name: '_DissolveTex',
		role: EffectRole.Dissolve,
		keyword: '_USE_DISSOLVE',
		speed: '_DissolveUVSpeed',
		rotate: '_DissolveUVRotate',
		disturbed: '_DissolveTexUseDisturb',
	},
] as const;

/** keywords each shader can have and still be drawn */
const BASE_KEYWORDS = new Set([
	'_SAMPLE_TEX0',
	'_SAMPLE_TEX1',
	'_SAMPLE_TEX2',
	'_SAMPLE_TEX3',
	'_SAMPLE_TEX4',
	'_USE_FOG',
	'_USE_SOFTBLEND',
	'_USE_FRESNEL',
]);
const DECAL_KEYWORDS = new Set([
	'_USE_MASK',
	'_USE_BLEND',
	'_USE_DISSOLVE',
	'_USE_DISTURB',
	'_USE_DISTURB_TEX2',
	'_USE_NORMALBLEND',
	'_USE_FOG',
]);

/** what an effect look puts in `MaterialLook` besides its parameters */
export interface EffectLook {
	/** texture id per slot, or -1 */
	textures: number[];
	/** largest UV scale per slot, for streaming */
	uvScales: number[];
	params: Float32Array;
}

/** the parameter readers both shaders share */
const readers = (entry: ReadyMaterial, shader: ShaderEntry) => ({
	float: (name: string, fallback: number): number => entry.floats[name] ?? shader.floats[name] ?? fallback,
	color: (name: string): [number, number, number, number] | undefined =>
		entry.colors[name] ?? shader.colors[name] ?? entry.vectors[name] ?? shader.vectors[name],
});

/** fills the slot rows shared by both shaders */
const setSlot = (
	look: EffectLook,
	i: number,
	slot: { texture: number; scale: number[]; offset: number[] },
	anim: { speed: number[]; cos: number; sin: number },
	bits: number,
): void => {
	look.textures[i] = slot.texture;
	look.uvScales[i] = Math.max(Math.abs(slot.scale[0]), Math.abs(slot.scale[1]), 1e-3);
	look.params.set([slot.scale[0], slot.scale[1], slot.offset[0], slot.offset[1]], EffectRow.uv + i * 4);
	look.params.set([anim.speed[0], anim.speed[1], anim.cos, anim.sin], EffectRow.anim + i * 4);
	look.params[EffectRow.slotBits + i] = bits;
};

/** an effect look with no textures */
const emptyEffect = (slots: number): EffectLook => {
	const params = new Float32Array(128);
	for (let i = 0; i < slots; i++) {
		params[EffectRow.slotBits + i] = ROLE_NONE;
		params.set([1, 1, 0, 0], EffectRow.uv + i * 4);
		params.set([0, 0, 1, 0], EffectRow.anim + i * 4);
	}
	return {
		textures: Array.from({ length: slots }, () => -1),
		uvScales: Array.from({ length: slots }, () => 1),
		params,
	};
};

/** the rows of the near camera fade, the dissolve and the blend layer, which both shaders read alike */
const setShared = (look: EffectLook, entry: ReadyMaterial, shader: ShaderEntry, intensity: number): void => {
	const { float, color } = readers(entry, shader);
	const params = look.params;
	params.set(color('_BlendTint') ?? [1, 1, 1, 0], EffectRow.blendTint);
	params.set(
		[
			float('_DisturbUIntensity1', 0),
			float('_DisturbVIntensity1', 0),
			float('_DisturbUIntensity2', 0),
			float('_DisturbVIntensity2', 0),
		],
		EffectRow.disturb,
	);
	// the dissolve threshold sweeps from below 0 to past 1 as the schedule goes from 0 to 1
	params.set(
		[
			float('_DissolveScheduleOffset', 0) * 2.02 - 1.01,
			float('_DissolveEdgeSharp', 1),
			float('_DissolveEmissiveEdge', 0),
		],
		EffectRow.dissolve,
	);
	const edge = color('_DissolveEmissiveColor') ?? [0, 0, 0, 0];
	params.set([edge[0] * intensity, edge[1] * intensity, edge[2] * intensity], EffectRow.dissolveColor);
	params.set(
		[
			float('_NearCameraFadeDistanceStart', 0),
			float('_NearCameraFadeDistanceEnd', 1),
			float('_NearCameraFadeDistanceStart2', 1e5),
			float('_NearCameraFadeDistanceEnd2', 2e5),
		],
		EffectRow.near,
	);
	params[EffectRow.misc] = float('_UseNearCameraFade', 0) !== 0 ? 1 : 0;
	params[EffectRow.soft + 2] = float('_IgnorePostExposure', 1);
};

/** whether a VFXBaseV2 keyword outside {@link BASE_KEYWORDS} is drawn, or changes nothing in the viewer */
const baseKeywordDrawn = (keyword: string, entry: ReadyMaterial, shader: ShaderEntry): boolean => {
	const { float, color } = readers(entry, shader);
	switch (keyword) {
		case '_USE_VERTOFFSET': {
			// the game scales the offset by `1 − _InParticle`, so meshes left in particle mode don't move
			const slot = entry.slots[OFFSET_TEXTURE];
			return float('_InParticle', 1) !== 0 || (slot !== undefined && slot.uv <= 1);
		}
		case '_USE_BRIGHT': {
			// the radial glow and distortion around the player (no `_BrightCenter`) reach `_OuterRadius` metres,
			// and the viewer has no player
			return float('_BrightType', 0) === 0 && (color('_BrightCenter')?.[3] ?? 0) === 0;
		}
		default: {
			return false;
		}
	}
};

/**
 * @param entry a material of `HGRP/Effect/VFXBaseV2`
 * @param shader its shader
 * @returns its effect look, or `null` when it uses features that aren't drawn
 */
export const vfxBaseLook = (entry: ReadyMaterial, shader: ShaderEntry): EffectLook | null => {
	if (
		entry.blend !== 'premultiplied' ||
		entry.keywords.some((keyword) => !BASE_KEYWORDS.has(keyword) && !baseKeywordDrawn(keyword, entry, shader))
	) {
		return null;
	}
	const { float, color } = readers(entry, shader);
	const look = emptyEffect(7);
	const params = look.params;
	const intensity = float('_TintColorIntensity', 1);
	const tint = linearRgb(color('_TintColor') ?? [1, 1, 1, 1]);
	params.set(
		[
			tint[0] * intensity,
			tint[1] * intensity,
			tint[2] * intensity,
			(color('_TintColor')?.[3] ?? 1) * float('_TintColorAlpha', 1),
		],
		EffectRow.tint,
	);
	const animOf = (prefix: string) => {
		const speed = color(`${prefix}UVSpeed`) ?? [0, 0, 0, 0];
		// the shaders' UV rotations are pure rotations: (a, b) of the matrix's first column is (cos, sin)
		const rotation = color(`${prefix}UVRotateMat`) ?? [1, 0, 0, 1];
		return { speed: [speed[0], speed[1]], cos: rotation[0], sin: rotation[1] };
	};
	const uv1 = (prefix: string): number => {
		const weights = color(`${prefix}UVWeights`) ?? [1, 0, 0, 0];
		return weights[1] > weights[0] ? 32 : 0;
	};
	BASE_SLOTS.forEach((name, i) => {
		const slot = entry.slots[name];
		if (slot === undefined || slot.uv > 1) {
			return;
		}
		if (i === 0) {
			const bits =
				EffectRole.Main +
				(float('_MainTexUseDisturb', 0) !== 0 ? 8 : 0) +
				(float('_UseMainTexAsAlpha', 0) !== 0 ? 16 : 0) +
				uv1('_MainTex');
			setSlot(look, i, slot, animOf('_MainTex'), bits);
			return;
		}
		const n = i - 1;
		if (!entry.keywords.includes(`_SAMPLE_TEX${n}`)) {
			return;
		}
		const role = ROLE_TEXTURES.findIndex((_, k) => float(`_SampleTex${n}UseWeight${k}`, 0) !== 0);
		if (role < 0) {
			return;
		}
		// the shader transforms a sample texture's UVs by the `_ST` of its role's texture property
		const transform = entry.slots[ROLE_TEXTURES[role]] ?? slot;
		const bits =
			role +
			(float(`_SampleTex${n}UseDisturb`, 0) !== 0 ? 8 : 0) +
			(float(`_UseSampleTex${n}AsAlpha`, 0) !== 0 ? 16 : 0) +
			uv1(`_SampleTex${n}`);
		setSlot(look, i, { ...transform, texture: slot.texture }, animOf(`_SampleTex${n}`), bits);
	});
	// without a main texture the shader samples its default; slot 0 is always sampled, and an unset slot binds
	// white
	if (look.textures[0] < 0 && shader.textures['_MainTex'] !== 'white') {
		return null;
	}
	setShared(look, entry, shader, intensity);
	params[EffectRow.dissolve + 3] = float('_UseDissolve', 0) !== 0 ? 1 : 0;
	// as in the game, a mask or weight switched on without a texture in that role leaves nothing
	params[EffectRow.dissolveColor + 3] = float('_UseMask', 0) !== 0 ? 1 : 0;
	params.set(
		[
			float('_Bi_Disturb', 0),
			float('_WeightTexIntensity', 1) * float('_DisturbUseWeight', 0),
			float('_WeightTexIntensity', 1) * float('_DissolveUseWeight', 0),
			float('_UseWeightTex', 0) !== 0 ? 1 : 0,
		],
		EffectRow.weight,
	);
	if (entry.keywords.includes('_USE_FRESNEL')) {
		params.set(
			[
				float('_FresnelPower', 1),
				float('_FresnelBias', 0),
				float('_FresnelFlip', 0),
				float('_FresnelAffectOpacity', 0),
			],
			EffectRow.fresnel,
		);
	}
	if (entry.keywords.includes('_USE_SOFTBLEND')) {
		params[EffectRow.soft] = Math.max(float('_SoftDistance', 1), 1e-3);
		params[EffectRow.soft + 1] = float('_SoftBias', 0);
	}
	params[EffectRow.soft + 3] = float('_DisableVertColor', 0) !== 0 ? 0 : 1;
	params[EffectRow.unfogged] = entry.keywords.includes('_USE_FOG') ? 0 : 1;
	params[EffectRow.misc + 1] = float('_ExpThreshold', 1);
	params[EffectRow.misc + 2] = float('_ExpIntensity', 0);
	params[EffectRow.misc + 3] = float('_UseDisturb', 0) !== 0 ? 1 : 0;
	const offsetSlot = entry.slots[OFFSET_TEXTURE];
	if (
		entry.keywords.includes('_USE_VERTOFFSET') &&
		float('_InParticle', 1) === 0 &&
		offsetSlot !== undefined
	) {
		const speed = color('_OffsetSpeed') ?? [0, 0, 0, 0];
		// the vertex stage reads the scroll after the `_ST`, unscaled and unrotated
		setSlot(look, OFFSET_SLOT, offsetSlot, { speed: [speed[0], speed[1]], cos: 1, sin: 0 }, ROLE_NONE);
		const dir = color('_OffsetDir') ?? [0, 0, 0, 0];
		params.set([dir[0], dir[1], dir[2], float('_OffsetSwitchDir', 0)], EffectRow.offsetDir);
		params.set(
			[
				float('_OffsetIntensity', 0),
				float('_Bi_Offset', 0),
				float('_UseVertexColorAlphaAsVertOffsetWeight', 0),
				float('_VertCameraOffset', 0),
			],
			EffectRow.offset,
		);
		params.set([1, float('_OffsetUVSet', 0) !== 0 ? 1 : 0], EffectRow.offsetMode);
	}
	return look;
};

/**
 * @param entry a material of `HGRP/Effect/VFXDecal`
 * @param shader its shader
 * @returns its effect look, or `null` when it uses features that aren't drawn
 */
export const vfxDecalLook = (entry: ReadyMaterial, shader: ShaderEntry): EffectLook | null => {
	if (entry.blend !== 'premultiplied' || entry.keywords.some((keyword) => !DECAL_KEYWORDS.has(keyword))) {
		return null;
	}
	const { float, color } = readers(entry, shader);
	const look = emptyEffect(7);
	const params = look.params;
	const base = color('_DecalBaseColor') ?? [1, 1, 1, 1];
	params.set([base[0], base[1], base[2], base[3] * float('_TintColorAlpha', 1)], EffectRow.tint);
	DECAL_SLOTS.forEach(({ name, role, keyword, speed: speedName, rotate, disturbed }, i) => {
		const slot = entry.slots[name];
		if (slot === undefined || slot.uv > 1 || (keyword !== null && !entry.keywords.includes(keyword))) {
			return;
		}
		const speed = color(speedName) ?? [0, 0, 0, 0];
		// a rotation in degrees about the texture's centre
		const angle = rotate === null ? 0 : (float(rotate, 0) * Math.PI) / 180;
		const useDisturb = disturbed === null ? 0 : float(disturbed, 0);
		const asAlpha =
			(role === EffectRole.Main && float('_UseMainTexAsAlpha', 0) !== 0) ||
			(role === EffectRole.Mask && float('_UseMaskTexAsAlpha', 0) !== 0);
		// the shader applies the blend texture's `_ST` twice
		const transform =
			role === EffectRole.Blend
				? {
						...slot,
						scale: [slot.scale[0] * slot.scale[0], slot.scale[1] * slot.scale[1]],
						offset: [slot.offset[0] * (slot.scale[0] + 1), slot.offset[1] * (slot.scale[1] + 1)],
					}
				: slot;
		setSlot(
			look,
			i,
			transform,
			{ speed: [speed[0], speed[1]], cos: Math.cos(angle), sin: -Math.sin(angle) },
			role + (useDisturb !== 0 ? 8 : 0) + (asAlpha ? 16 : 0),
		);
	});
	if (look.textures[0] < 0) {
		return null;
	}
	setShared(look, entry, shader, base[0]);
	params[EffectRow.dissolve + 3] = entry.keywords.includes('_USE_DISSOLVE') ? 1 : 0;
	params[EffectRow.dissolveColor + 3] = entry.keywords.includes('_USE_MASK') ? 1 : 0;
	params[EffectRow.weight] = float('_Bi_Disturb', 0);
	params[EffectRow.misc + 3] = entry.keywords.includes('_USE_DISTURB') ? 1 : 0;
	params[EffectRow.unfogged] = entry.keywords.includes('_USE_FOG') ? 0 : 1;
	params.set(
		[
			float('_EdgeFadeX', 0),
			float('_EdgeFadeZ', 0),
			float('_EdgeFadeIntensity', 0),
			Math.max(float('_HeightFade', 0), 1e-3),
		],
		EffectRow.decalFade,
	);
	params.set(
		[
			float('_HeightFadeOffset', 0),
			entry.keywords.includes('_USE_NORMALBLEND') ? float('_AngleBlendFallOff', 1) : 0,
		],
		EffectRow.decal,
	);
	return look;
};

// #region water sheets

/** what `effect.wgsl`'s `fs_effect` draws a look as, in {@link EffectRow.unfogged}'s second float */
export const EffectKind = {
	/** VFXBaseV2 and VFXDecal's texture stack */
	Stack: 0,
	/** a VFXWater sheet ({@link WaterSheetRow}) */
	WaterSheet: 1,
} as const;

/**
 * float offsets of a VFXWater look's parameters, in place of {@link EffectRow}'s rows 17–22 and 26–30. the
 * tint, UV, scroll, soft blend, near fade and last rows are shared, and the vertex offset stays off (row 30's
 * x)
 */
export const WaterSheetRow = {
	/** {@link WaterSheetFlags}, `_BlendMode` (1: additive), `_UseLighting`, `_WaterRandomUV` */
	flags: 68,
	/** `_Bi_Disturb`, `_DisturbUIntensity1`, `_DisturbVIntensity1`, 0 */
	disturb: 72,
	/** how far the distortion moves the main, mask, normal map and dissolve UVs (`_…UseDisturb`) */
	disturbUse: 76,
	/** dissolve threshold, edge sharpness, glowing edge width, 0 */
	dissolve: 80,
	/** the dissolve edge's colour (linear, times the tint intensity), 0 */
	dissolveColor: 84,
	/** flipbook columns, rows, frames per second, `_RandomStartByPos` */
	sequence: 88,
	/** flipbook: motion vector strength, opacity scale, opacity threshold, colour threshold */
	sequenceShape: 104,
	/** flipbook colour tint (linear), normal scale (the flipbook's or the normal map's) */
	sequenceTint: 108,
	/** `_Roughness`, `_Specular`, `_DirSpecularStrength`, `_FresnelStrength` */
	surface: 112,
	/** subsurface hue, saturation, value (0 without `_SUBSURFACE`), indirect strength */
	subsurface: 116,
	/** 0 (the vertex offset's switch), `_IndirectSaturation`, 0, 0 */
	misc: 120,
} as const;

/** {@link WaterSheetRow.flags} bits, matching `effect.wgsl` */
export const WaterSheetFlags = {
	Disturb: 1 << 0,
	/** the disturb texture holds a normal: its (a·r, g) distort instead of its red */
	DisturbNormal: 1 << 1,
	Mask: 1 << 2,
	Dissolve: 1 << 3,
	Sequence: 1 << 4,
	SequenceMotion: 1 << 5,
	/** slot 6 holds the flipbook's normals */
	SequenceNormal: 1 << 6,
	/** slot 6 holds `_NormalMap` */
	NormalMap: 1 << 7,
	MainAsAlpha: 1 << 8,
	MaskAsAlpha: 1 << 9,
	VertexOpacity: 1 << 10,
	FresnelOpacity: 1 << 11,
	VertexColor: 1 << 12,
} as const;

/** the slots of a VFXWater look, in order; slot 6 holds whichever normals the material uses */
const WATER_SLOTS = [
	'_MainTex',
	'_DisturbTex1',
	'_MaskTex',
	'_DissolveTex',
	'_SequenceBaseColorMap',
	'_SequenceMotionVectorMap',
] as const;

/**
 * the prefix of each {@link WATER_SLOTS} texture's UV scroll and rotation properties, `null` for the
 * flipbook's
 */
const WATER_SLOT_ANIM = ['_MainTex', '_Disturb', '_MaskTex', '_Dissolve', null, null] as const;

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

/**
 * `HGRP/Effect/VFXWater`, the sheets of falling water: a tinted, masked main texture or an animated flipbook
 * blended frame to frame along its motion vectors, distorted by a scrolling texture, eaten by a dissolve, and
 * lit by the irradiance volume and the sun, with a subsurface glow when lit from behind.
 *
 * @param entry a material of `HGRP/Effect/VFXWater`
 * @param shader its shader
 * @returns its look, or `null` when it uses features that aren't drawn (refraction, vertex animation)
 */
export const vfxWaterLook = (entry: ReadyMaterial, shader: ShaderEntry): EffectLook | null => {
	if (entry.blend !== 'premultiplied' || entry.keywords.some((keyword) => !WATER_KEYWORDS.has(keyword))) {
		return null;
	}
	const has = (keyword: string): boolean => entry.keywords.includes(keyword);
	const sequence = has('_USE_SEQUENCE_FRAME');
	if (sequence && entry.slots['_SequenceBaseColorMap'] === undefined) {
		return null;
	}
	const { float, color } = readers(entry, shader);
	const look = emptyEffect(7);
	const params = look.params;
	const intensity = float('_TintColorIntensity', 1);
	const tint = color('_TintColor') ?? [1, 1, 1, 1];
	const linear = linearRgb(tint);
	params.set(
		[
			linear[0] * intensity,
			linear[1] * intensity,
			linear[2] * intensity,
			tint[3] * float('_TintColorAlpha', 1),
		],
		EffectRow.tint,
	);
	// first, since the rows below reuse some of the stack's
	setShared(look, entry, shader, intensity);
	let flags = 0;
	const used = [
		true,
		has('_USE_DISTURB'),
		has('_USE_MASK'),
		has('_USE_DISSOLVE'),
		sequence,
		sequence && has('_USE_SEQUENCE_FRAME_MV'),
	];
	WATER_SLOTS.forEach((name, i) => {
		const slot = entry.slots[name];
		if (!used[i] || slot === undefined || slot.uv > 0) {
			return;
		}
		const prefix = WATER_SLOT_ANIM[i];
		let anim = { speed: [0, 0], cos: 1, sin: 0 };
		if (prefix !== null) {
			const speed = color(`${prefix}UVSpeed${i === 1 ? '1' : ''}`) ?? [0, 0, 0, 0];
			const rotation = color(`${prefix}UVRotateMat${i === 1 ? '1' : ''}`) ?? [1, 0, 0, 1];
			anim = { speed: [speed[0], speed[1]], cos: rotation[0], sin: rotation[1] };
		}
		// the flipbook samples its frames' UVs as they are
		const transform = prefix === null ? { ...slot, scale: [1, 1], offset: [0, 0] } : slot;
		setSlot(look, i, transform, anim, EffectRole.Main);
	});
	if (look.textures[0] < 0 && shader.textures['_MainTex'] !== 'white') {
		return null;
	}
	if (look.textures[1] >= 0) {
		flags |= WaterSheetFlags.Disturb;
		if (float('_DisturbTex1Normal', 0) !== 0) {
			flags |= WaterSheetFlags.DisturbNormal;
		}
	}
	if (look.textures[2] >= 0) {
		flags |= WaterSheetFlags.Mask;
	}
	if (look.textures[3] >= 0) {
		flags |= WaterSheetFlags.Dissolve;
	}
	if (sequence) {
		flags |= WaterSheetFlags.Sequence;
		if (look.textures[5] >= 0) {
			flags |= WaterSheetFlags.SequenceMotion;
		}
	}
	// slot 6: the flipbook's normals, or a normal map
	let normalScale = 1;
	{
		const flipbook = sequence && has('_USE_SEQUENCE_FRAME_NORMAL');
		const name = flipbook ? '_SequenceNormalMap' : has('_NORMAL_MAP') ? '_NormalMap' : null;
		const slot = name === null ? undefined : entry.slots[name];
		if (slot !== undefined && slot.uv === 0) {
			const speed = color('_NormalMapUVSpeed') ?? [0, 0, 0, 0];
			const rotation = color('_NormalMapUVRotateMat') ?? [1, 0, 0, 1];
			setSlot(
				look,
				6,
				flipbook ? { ...slot, scale: [1, 1], offset: [0, 0] } : slot,
				flipbook
					? { speed: [0, 0], cos: 1, sin: 0 }
					: { speed: [speed[0], speed[1]], cos: rotation[0], sin: rotation[1] },
				EffectRole.Main,
			);
			flags |= flipbook ? WaterSheetFlags.SequenceNormal : WaterSheetFlags.NormalMap;
			normalScale = flipbook ? float('_FrameNormalScale', 1) : float('_NormalScale', 1);
		}
	}
	if (float('_UseMainTexAsAlpha', 1) !== 0) {
		flags |= WaterSheetFlags.MainAsAlpha;
	}
	if (float('_UseMaskTexAsAlpha', 1) !== 0) {
		flags |= WaterSheetFlags.MaskAsAlpha;
	}
	if (float('_UseVertexColorAsOpacity', 0) !== 0) {
		flags |= WaterSheetFlags.VertexOpacity;
	}
	if (float('_UseFresnelAsOpacity', 0) !== 0) {
		flags |= WaterSheetFlags.FresnelOpacity;
	}
	if (float('_DisableVertColor', 0) === 0) {
		flags |= WaterSheetFlags.VertexColor;
	}
	params.set(
		[flags, float('_BlendMode', 0), float('_UseLighting', 1), float('_WaterRandomUV', 0)],
		WaterSheetRow.flags,
	);
	params.set(
		[float('_Bi_Disturb', 0), float('_DisturbUIntensity1', 0), float('_DisturbVIntensity1', 0), 0],
		WaterSheetRow.disturb,
	);
	params.set(
		[
			float('_MainTexUseDisturb', 0),
			float('_MaskTexUseDisturb', 0),
			float('_NormalMapUseDisturb', 0),
			float('_DissolveTexUseDisturb', 0),
		],
		WaterSheetRow.disturbUse,
	);
	// the dissolve threshold sweeps from below 0 to past 1 as the schedule goes from 0 to 1
	params.set(
		[
			float('_DissolveScheduleOffset', 0) * 2.02 - 1.01,
			float('_DissolveEdgeSharp', 1),
			float('_DissolveEmissiveEdge', 0),
			0,
		],
		WaterSheetRow.dissolve,
	);
	const edge = linearRgb(color('_DissolveEmissiveColor') ?? [0, 0, 0, 0]);
	params.set([edge[0] * intensity, edge[1] * intensity, edge[2] * intensity, 0], WaterSheetRow.dissolveColor);
	const frames = color('_SequenceFrameSize') ?? [1, 1, 0, 0];
	params.set(
		[
			Math.max(frames[0], 1),
			Math.max(frames[1], 1),
			float('_PlaybackSpeed', 0),
			float('_RandomStartByPos', 0),
		],
		WaterSheetRow.sequence,
	);
	params.set(
		[
			float('_MotionVectorDistortionStrength', 0),
			float('_SequenceOpacityScale', 1),
			float('_SequenceOpacitySdf', 0),
			float('_SequenceBaseColorSdf', 0),
		],
		WaterSheetRow.sequenceShape,
	);
	const sequenceTint = linearRgb(color('_SequenceBaseColorMapTint') ?? [1, 1, 1, 1]);
	params.set([...sequenceTint, normalScale], WaterSheetRow.sequenceTint);
	params.set(
		[
			float('_Roughness', 1),
			float('_Specular', 1),
			float('_DirSpecularStrength', 1),
			float('_FresnelStrength', 0),
		],
		WaterSheetRow.surface,
	);
	params.set(
		[
			float('_SubsurfaceHue', 1),
			float('_SubsurfaceSaturation', 1),
			has('_SUBSURFACE') ? float('_SubsurfaceValue', 1) : 0,
			float('_SubsurfaceIndirect', 1),
		],
		WaterSheetRow.subsurface,
	);
	params.set([0, float('_IndirectSaturation', 1), 0, 0], WaterSheetRow.misc);
	if (has('_USE_SOFTBLEND')) {
		params[EffectRow.soft] = Math.max(float('_SoftDistance', 1), 1e-3);
		params[EffectRow.soft + 1] = float('_SoftBias', 0);
	}
	params[EffectRow.soft + 3] = (flags & WaterSheetFlags.VertexColor) !== 0 ? 1 : 0;
	params.set([0, EffectKind.WaterSheet, 0, 0], EffectRow.unfogged);
	return look;
};

// #endregion

// #region mist

/**
 * float offsets of a mist look's parameters (`fogSimpleLook`, `fakeVolumeFogLook`), in place of
 * {@link EffectRow} for the mist entry points of `effect.wgsl`. the UV rows are shared
 */
export const MistRow = {
	/** colour rgb (linear, HDR), alpha */
	color: 0,
	/** one UV transform per texture slot, as {@link EffectRow.uv} */
	uv: 4,
	/** cards: `_BaseAlphaIntensity`, `_FogNoiseIntensity`, `_UseWind`, `_WindNoiseIntensity` */
	card: 32,
	/** cards: `_WindNoiseContrast`, the wind noise's UV scale in u and v, `_WindSpeed` */
	wind: 36,
	/** cards: `_WindDirX`, `_WindDirY`, 1 when lit, `_LightFactor` */
	light: 40,
	/** cards: `_IndirectColor` (linear), 1 when the blending is additive */
	indirect: 44,
	/** distance fade start and end, near camera fade start and end (view depth, m) */
	fade: 48,
	/** cards: top fade contrast and offset, soft blend distance (0 without `_USE_SOFTBLEND`), 0 */
	top: 52,
	/** volumes: `_FogExponent`, `_FogDensity`, `_CubEdgeFade`, `_NearFadeDistance` (0 when walk-in) */
	volume: 56,
	/** volumes: `_HeightOffset`, `_HeightFalloff`, vertical falloff min, max (equal: none) */
	volumeHeight: 60,
	/** volumes: `_FogIntensityFadeDistance`, 1 to measure it from the centre, `_FogDepthStart`, `_FogDepthEnd` */
	volumeFade: 64,
	/** `_IgnorePostExposure`, 0, 0, 0 */
	misc: 68,
} as const;

/** the slot index of a card's noise texture; its main texture is slot 0 */
export const MIST_NOISE_SLOT = 1;

/** card keywords that are drawn; lighting from a normal map and the fog keyword's own fogging are approximated */
const FOG_SIMPLE_KEYWORDS = new Set(['_USE_FOG', '_USE_SOFTBLEND', '_USE_LIGHTING']);

/** a fade between two view depths that also works with equal ends (then a step at the start) */
const fadeRange = (start: number, end: number): [number, number] =>
	Math.abs(end - start) < 1e-4 ? [start, start + 1e-4] : [start, end];

/**
 * `HGRP/FogSimple`, the game's mist cards: a texture's red channel, broken up by a noise texture and a
 * second, scrolling sample of it (wind), in a flat or sun-lit colour, faded by view depth, towards the card's
 * top, and where it nears what lies behind it.
 *
 * @param entry a material of `HGRP/FogSimple`
 * @param shader its shader
 * @returns its mist look, or `null` when it uses features that aren't drawn
 */
export const fogSimpleLook = (entry: ReadyMaterial, shader: ShaderEntry): EffectLook | null => {
	if (
		(entry.blend !== 'premultiplied' && entry.blend !== 'additive') ||
		entry.keywords.some((keyword) => !FOG_SIMPLE_KEYWORDS.has(keyword))
	) {
		return null;
	}
	const { float, color } = readers(entry, shader);
	const look = emptyEffect(7);
	const params = look.params;
	for (const [i, name] of ['_MainTex', '_NoiseTex'].entries()) {
		const slot = entry.slots[name];
		if (slot === undefined || slot.uv > 1) {
			return null;
		}
		setSlot(look, i, slot, { speed: [0, 0], cos: 1, sin: 0 }, ROLE_NONE);
	}
	const base = color('_BaseColor') ?? [1, 1, 1, 1];
	params.set([...linearRgb(base), base[3]], MistRow.color);
	params.set(
		[
			float('_BaseAlphaIntensity', 1),
			float('_FogNoiseIntensity', 0),
			float('_UseWind', 0),
			float('_WindNoiseIntensity', 0),
		],
		MistRow.card,
	);
	const separate = float('_UseSeparateScale', 0) !== 0;
	const windScale = float('_WindScale', 1);
	params.set(
		[
			float('_WindNoiseContrast', 0),
			windScale * (separate ? float('_WindScaleX', 1) : 1),
			windScale * (separate ? float('_WindScaleY', 1) : 1),
			float('_WindSpeed', 0),
		],
		MistRow.wind,
	);
	const lit = entry.keywords.includes('_USE_LIGHTING') && float('_UseLighting', 0) !== 0;
	params.set(
		[float('_WindDirX', 1), float('_WindDirY', 0), lit ? 1 : 0, float('_LightFactor', 0)],
		MistRow.light,
	);
	const indirect = color('_IndirectColor') ?? [0, 0, 0, 1];
	params.set([...linearRgb(indirect), entry.blend === 'additive' ? 1 : 0], MistRow.indirect);
	params.set(
		[
			...fadeRange(float('_DistanceFadeStart', 0), float('_DistanceFadeEnd', 0)),
			...fadeRange(float('_NearCameraFadeDistanceStart', 0), float('_NearCameraFadeDistanceEnd', 0)),
		],
		MistRow.fade,
	);
	params.set(
		[
			float('_TopFadeContract', 1),
			float('_TopFadeOffset', 0),
			entry.keywords.includes('_USE_SOFTBLEND') ? Math.max(float('_SoftDistance', 1), 1e-3) : 0,
		],
		MistRow.top,
	);
	return look;
};

/**
 * `HGRP/Effect/VFXFakeVolumeFog`, fog boxes: the fog's thickness along the view ray through the unit cube, up
 * to the surface behind or the camera inside, turned into opacity and faded towards the box's edges and top
 * and with distance. always additive; the 3D noise isn't drawn.
 *
 * @param entry a material of `HGRP/Effect/VFXFakeVolumeFog`
 * @param shader its shader
 * @returns its mist look, or `null` when it can't be drawn
 */
export const fakeVolumeFogLook = (entry: ReadyMaterial, shader: ShaderEntry): EffectLook | null => {
	if (entry.blend !== 'additive') {
		return null;
	}
	const { float, color } = readers(entry, shader);
	const look = emptyEffect(7);
	const params = look.params;
	const fog = color('_FogColor') ?? [1, 1, 1, 1];
	params.set([...linearRgb(fog), fog[3] * float('_TintColorAlpha', 1)], MistRow.color);
	const walkIn = float('_canWalkIn', 0) !== 0;
	params.set(
		[
			float('_FogExponent', 1),
			float('_FogDensity', 1),
			Math.max(float('_CubEdgeFade', 1), 1e-3),
			walkIn ? 0 : Math.max(float('_NearFadeDistance', 1), 1e-3),
		],
		MistRow.volume,
	);
	params.set(
		[
			float('_HeightOffset', 0),
			float('_HeightFalloff', 0),
			float('_VerticalFalloffMin', 0),
			float('_VerticalFalloffMax', 0),
		],
		MistRow.volumeHeight,
	);
	params.set(
		[
			Math.max(float('_FogIntensityFadeDistance', 1e5), 1e-3),
			float('_FogIntensityFadeUseCenter', 0),
			float('_FogDepthStart', 0),
			float('_FogDepthEnd', 0),
		],
		MistRow.volumeFade,
	);
	params[MistRow.misc] = float('_IgnorePostExposure', 1);
	return look;
};

// #endregion
