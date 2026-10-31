/**
 * how the viewer's mesh shader draws each package material: whether at all, which textures fill its slots
 * ({@link SLOTS}), and the draw parameters `mesh.wgsl` reads.
 *
 * the HGRP Lit family has two texture layouts (`_BaseTextureMapCount`): with an MRO map (R metallic, G
 * roughness, B occlusion) the normal map is `RAG`; without one (`_TWO_BASEMAP`, most materials) the normal
 * map's B channel holds roughness and A occlusion, and metallic is the base colour's alpha
 * (`_BaseTextureMapCount` 1) or `_Metallic` (2). foliage normal maps hold roughness in B the same way.
 *
 * Lit's optional layers, by keyword: `_TRI_CHANNEL_MASK` blends the surface toward three authored colours by
 * the channels of `_MaskMap`, `_DETAIL_MAP` adds a tiling normal (and optionally colour and roughness) map
 * that fades with view depth, `_PARALLAX_MAP` glows with a pattern ray-marched below the surface, and
 * `_LAYERBLEND_TOP` or `_LAYERBLEND_MASK` covers upward-facing or masked surfaces with a second material
 * (moss, sand), which `_LAYERBLEND_MOSS` shades as fuzzy.
 *
 * @module
 */

import type {
	MaterialCull,
	MaterialTable,
	ReadyMaterial,
	ShaderEntry,
} from '@endfield-noclip/package-format/materials';
import type { Color } from '@endfield-noclip/package-format/values';

import { linearRgb } from './color.ts';
import {
	type EffectLook,
	fakeVolumeFogLook,
	fogSimpleLook,
	vfxBaseLook,
	vfxDecalLook,
} from './effect-looks.ts';

/** shader families that aren't drawn as opaque surfaces (fog volumes, light beams, effects) */
const SKIPPED_FAMILIES = new Set([
	'fogSimple',
	'volumetricBeam',
	'vfxFakeVolumeFog',
	'vfxBase',
	'vfxAdvance',
	'vfxRefract',
	'vfxDitherAlpha',
	'waterDecal',
]);

const FOLIAGE_FAMILIES = new Set(['leaf', 'grass', 'cardMesh']);

/** stand-in albedo for materials without a base colour texture, linear */
const DEFAULT_ALBEDO: [r: number, g: number, b: number] = [0.5, 0.5, 0.5];

/**
 * the texture slots the mesh shader samples, in binding order. the third holds `_MROMap` in the MRO layout
 * and the tri-channel `_MaskMap` otherwise ({@link LookFlags.TriChannelMask}): the frame group leaves seven
 * sampled textures of WebGPU's default sixteen, and a material using both is rare. the parallax slots hold
 * the layer's `_Layer1BaseMap` and `_Layer1BumpMap` in looks with {@link LookFlags.LayerBlend} (no map02
 * material has both keywords), and the emissive slot its `_LayerBlendMaskMap`
 */
export const SLOTS = [
	'_BaseColorMap',
	'_NormalMap',
	'_MROMap',
	'_EmissiveMap',
	'_DetailMap',
	'_ParallaxMap',
	'_ParallaxNoiseMap',
] as const;

/** the matte painting's only texture, drawn in the base colour slot */
const MATTE_PAINTING_TEXTURE = '_MainTex';

/** a slot samples UV set 1 when bit `UV1_SHIFT + slot` of {@link MaterialLook.flags} is set, else UV set 0 */
export const UV1_SHIFT = 18;

/** {@link MaterialLook.flags} bits, matching `mesh.wgsl` */
export const LookFlags = {
	/** the slots of {@link SLOTS} that have a texture ({@link SLOT_FLAGS}) */
	BaseMap: 1 << 0,
	NormalMap: 1 << 1,
	MaskMap: 1 << 2,
	EmissiveMap: 1 << 3,
	/** normal x is `r · a` (DXT5nm-style; BC5 has a = 1) */
	NormalRag: 1 << 4,
	/** the normal map's B channel is roughness */
	NormalRoughness: 1 << 5,
	/** thin foliage: transmission, two-sided lighting */
	Foliage: 1 << 6,
	/** metallic is the base colour's alpha instead of the surface row's constant */
	MetallicBaseAlpha: 1 << 7,
	/** the normal map's alpha is the material occlusion */
	NormalOcclusion: 1 << 8,
	// bits 9 and 10 are the geometry's flags (mesh-renderer.ts)
	/** emission is the emissive colour times a channel of the material's own maps (`_EMISSIVE_MASK`) */
	EmissiveMask: 1 << 11,
	/** unlit: the tinted base colour is the radiance (matte paintings; see `mattePaintingLook`) */
	Unlit: 1 << 12,
	/** the alpha test reads the normal map's alpha instead of the base colour's (`_AlphaMaskChannel` 1) */
	AlphaNormal: 1 << 13,
	/** the mask slot holds the tri-channel `_MaskMap` rather than an MRO map */
	TriChannelMask: 1 << 14,
	DetailMap: 1 << 15,
	ParallaxMap: 1 << 16,
	ParallaxNoiseMap: 1 << 17,
	// bits UV1_SHIFT… pick each slot's UV set
	/** `HGRP/Erosion`: slots and parameters as {@link erosionLook} lays them out */
	Erosion: 1 << 25,
	// bit 26 is the geometry's (mesh-renderer.ts)
	/** `HGRP/Foliage/Leaf`: the sun shadow, vertex-normal lighting and canopy ramp of {@link LookRow.foliage} */
	FoliageLeaf: 1 << 27,
	/** a scene effect (effect-looks.ts), drawn by `effect.wgsl` in the transparent pass */
	Effect: 1 << 28,
	/** with {@link Effect}: a VFXDecal box, projected onto the surfaces inside it */
	EffectDecal: 1 << 29,
	/**
	 * with {@link Effect}: mist (`MistRow` in effect-looks.ts), a FogSimple card, or with {@link EffectDecal} a
	 * VFXFakeVolumeFog box, drawn by its back faces like a decal's
	 */
	EffectMist: 1 << 30,
	/**
	 * `_LAYERBLEND_TOP` or `_LAYERBLEND_MASK`: the parallax slots and rows hold the layer
	 * ({@link layerBlendParams}). the sign bit, so the value is negative; `words` in mesh-renderer.ts store it
	 * unsigned
	 */
	LayerBlend: 1 << 31,
} as const;

/** the slot flags of {@link LookFlags} by slot, which are cleared while a slot's texture isn't resident */
export const SLOT_FLAGS = [
	LookFlags.BaseMap,
	LookFlags.NormalMap,
	LookFlags.MaskMap,
	LookFlags.EmissiveMap,
	LookFlags.DetailMap,
	LookFlags.ParallaxMap,
	LookFlags.ParallaxNoiseMap,
];

/**
 * floats of a material's draw parameters (`Draw` in mesh.wgsl after the dequantization); rows in
 * {@link LookRow}
 */
export const LOOK_FLOATS = 128;

/** one material as the mesh shader draws it */
export interface MaterialLook {
	/** `false` for materials not drawn at all (fog volumes, additive blending) */
	drawn: boolean;
	/**
	 * alpha-tested against the alpha of the base colour, or of the normal map with
	 * {@link LookFlags.AlphaNormal} (`fs_cutout_depth` in mesh.wgsl), once that texture is bound
	 * ({@link alphaTextureOf}); such draws need pipelines that can discard
	 */
	cutout: boolean;
	/**
	 * alpha-blended: drawn in the transparent pass with the opacity `fs_transparent` in mesh.wgsl computes, and
	 * never alpha-tested or shadow-casting
	 */
	transparent: boolean;
	/** the faces the game culls, for unmirrored instances */
	cull: MaterialCull;
	/** whether the material draws into shadow maps */
	castsShadows: boolean;
	/** texture id per {@link SLOTS} entry, or -1 */
	textures: number[];
	/** largest UV scale of each slot, for picking the mip level to stream */
	uvScales: number[];
	/** {@link LookFlags}, with every slot that has a texture set */
	flags: number;
	/** {@link LOOK_FLOATS} draw parameters */
	params: Float32Array;
}

/** float offsets of the rows of {@link MaterialLook.params} */
export const LookRow = {
	/** linear tint, alpha-test threshold */
	tint: 0,
	/** one UV transform per slot */
	uv: 4,
	/** roughness min, roughness max, metallic, normal scale; unlit looks: highlight threshold and intensity */
	surface: 32,
	/** occlusion strength, f0, transmission, base colour brighter scale */
	surface2: 36,
	/** emissive colour (linear), how much the tint covers the base colour */
	emissive: 40,
	/**
	 * `_AlbedoAffectEmissive` (1: emission ignores the albedo), `_EmissiveMaskChannel`, `_IgnorePostExposure`
	 * (1: emission keeps its brightness whatever the exposure), the opacity of transparent looks before their
	 * texture's alpha (`_BaseColor.a`)
	 */
	emissive2: 44,
	/** three rows, the tri-channel mask's R, G and B: linear colour, strength */
	maskAlbedo: 48,
	/** the roughness each mask channel blends toward */
	maskRoughness: 60,
	/** the metallic each mask channel blends toward */
	maskMetallic: 64,
	/** per channel, the mask's contrast (`_Mask*Scale`) */
	maskScale: 68,
	/** per channel, the mask's offset (`_Mask*Offset`) */
	maskOffset: 72,
	/** `_DetailMode` (0 colour overlay, 1 PBR), `_DetailMaskMode`, normal intensity, PBR intensity */
	detail: 76,
	/** view depths where the detail starts and finishes fading out, overlay brighter scale */
	detail2: 80,
	/** `_DetailOverlayColor`: linear colour, how much it covers */
	detailOverlay: 84,
	/** parallax depth (`_ParallaxStrength`), march steps, Fresnel power, minimum brightness */
	parallax: 88,
	/** pulse speed, pulse phase per metre of the object's position, ignore post exposure, intensity */
	parallax2: 92,
	/** `_ParallaxColor` (HDR, as stored), mask channel */
	parallaxColor: 96,
	/** `_ParallaxColorDark` */
	parallaxDark: 100,
	/** the glow's brightening near the player: outer and inner radius, strength (0 without `_ParallaxCharPos`) */
	parallaxBright: 104,
	/**
	 * leaves: `_OcclusionShadow` (how much the vertex AO shadows the sun), the fake directional shadow's
	 * strength and power, `_DiffuseUseVertexNormal`. Lit layers reuse this row and the next
	 * ({@link LayerBlendRow})
	 */
	foliage: 108,
	/** leaves: the vertex AO ranges that fade transmission and subsurface in: start, range, start, range */
	foliageAo: 112,
	/**
	 * leaves: `_SubsurfaceIntensity`, `_TransmissionDistanceFade`, the canopy ramp's intensity (0 without
	 * `_CANOPY_COLOR_RAMP`), 1 when the ramp starts at the top
	 */
	foliage2: 116,
	/** leaves: the canopy ramp's range, transition range, colour brighter scale, how much its colour covers */
	canopy: 120,
	/** leaves: `_CanopyRampColor`, linear */
	canopyColor: 124,
} as const;

/**
 * @param look a material look
 * @returns the texture id whose alpha an alpha-tested look tests, or -1 when it has none
 */
export const alphaTextureOf = (look: MaterialLook): number =>
	look.textures[(look.flags & LookFlags.AlphaNormal) !== 0 ? 1 : 0];

/** a look with no textures and identity UV transforms */
const emptyLook = ({ drawn }: { drawn: boolean }): MaterialLook => {
	const params = new Float32Array(LOOK_FLOATS);
	for (let i = 0; i < SLOTS.length; i++) {
		params.set([1, 1, 0, 0], LookRow.uv + i * 4);
	}
	return {
		drawn,
		cutout: false,
		transparent: false,
		cull: 'none',
		castsShadows: true,
		textures: SLOTS.map(() => -1),
		uvScales: SLOTS.map(() => 1),
		flags: 0,
		params,
	};
};

/** a material's value of a float property: its override, else the shader's default */
const floatOf = (entry: ReadyMaterial, shader: ShaderEntry, name: string, fallback: number): number =>
	entry.floats[name] ?? shader.floats[name] ?? fallback;

const colorOf = (entry: ReadyMaterial, shader: ShaderEntry, name: string): Color | undefined =>
	entry.colors[name] ?? shader.colors[name];

const vectorOf = (entry: ReadyMaterial, shader: ShaderEntry, name: string): number[] | undefined =>
	entry.vectors[name] ?? shader.vectors[name];

/**
 * @param materials the package's material table
 * @returns a look per material id
 */
export const materialLooks = (materials: MaterialTable): MaterialLook[] => {
	const looks: MaterialLook[] = [];
	for (const entry of materials.entries) {
		if (entry.status !== 'ready') {
			const look = emptyLook({ drawn: true });
			look.params.set([...DEFAULT_ALBEDO, -1], LookRow.tint);
			look.params.set([0.85, 0.85, 0, 1], LookRow.surface);
			look.params.set([1, 0.04, 0, 1], LookRow.surface2);
			look.params.set([0, 0, 0, 1], LookRow.emissive);
			looks[entry.id] = look;
			continue;
		}
		const shader = materials.shaders[entry.shader];
		const effect = effectLookOf(entry, shader);
		if (effect !== null) {
			looks[entry.id] = effect;
			continue;
		}
		const dither = shader.family === 'vfxDitherAlpha' ? ditherAlphaLook(entry, shader) : null;
		if (dither !== null) {
			looks[entry.id] = dither;
			continue;
		}
		// other effect meshes need their own opacity, distortion and animation passes. the opaque mesh fallback
		// turns their bounding surfaces into solid walls
		if (
			SKIPPED_FAMILIES.has(shader.family) ||
			shader.name.startsWith('HGRP/Effect/') ||
			entry.blend === 'additive'
		) {
			looks[entry.id] = emptyLook({ drawn: false });
			continue;
		}
		switch (shader.family) {
			case 'mattePainting': {
				looks[entry.id] = mattePaintingLook(entry, shader);
				break;
			}
			case 'erosion': {
				looks[entry.id] = erosionLook(entry, shader);
				break;
			}
			default: {
				looks[entry.id] = lookOf(entry, shader);
			}
		}
	}
	return looks;
};

/**
 * @returns the look of a scene effect the viewer draws (effect-looks.ts), else `null`. effects are
 *   alpha-blended and cast no shadows; decal boxes draw their back faces, so they still show with the camera
 *   inside them
 */
const effectLookOf = (entry: ReadyMaterial, shader: ShaderEntry): MaterialLook | null => {
	let effect: EffectLook | null = null;
	let flags = LookFlags.Effect;
	switch (shader.name) {
		case 'HGRP/Effect/VFXBaseV2': {
			effect = vfxBaseLook(entry, shader);
			break;
		}
		case 'HGRP/Effect/VFXDecal': {
			effect = vfxDecalLook(entry, shader);
			flags |= LookFlags.EffectDecal;
			break;
		}
		case 'HGRP/FogSimple': {
			effect = fogSimpleLook(entry, shader);
			flags |= LookFlags.EffectMist;
			break;
		}
		case 'HGRP/Effect/VFXFakeVolumeFog': {
			effect = fakeVolumeFogLook(entry, shader);
			flags |= LookFlags.EffectMist | LookFlags.EffectDecal;
			break;
		}
		default: {
			return null;
		}
	}
	if (effect === null) {
		return null;
	}
	return {
		drawn: true,
		cutout: false,
		transparent: true,
		cull: (flags & LookFlags.EffectDecal) !== 0 ? 'front' : entry.cull,
		castsShadows: false,
		textures: effect.textures,
		uvScales: effect.uvScales,
		flags,
		params: effect.params,
	};
};

const lookOf = (entry: ReadyMaterial, shader: ShaderEntry): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = entry.cull;
	const family = shader.family;
	const foliage = FOLIAGE_FAMILIES.has(family);
	const params = look.params;

	// the slots: HLOD normal maps aren't tangent-space maps we understand yet, and the optional maps are only
	// sampled where the material's layout and keywords use them. the geometry carries UV sets 0 and 1
	const keywords = entry.keywords;
	const lit = family === 'lit';
	const emissiveMap = keywords.includes('_EMISSIVE_MAP');
	const mro = entry.baseTextureMapCount === 0;
	const triChannel = lit && keywords.includes('_TRI_CHANNEL_MASK') && !mro;
	// a separate parallax mask texture (`_UseParallaxMask`) has no slot; such materials stay dark
	const parallax =
		lit && keywords.includes('_PARALLAX_MAP') && floatOf(entry, shader, '_UseParallaxMask', 0) === 0;
	const layer = lit && !parallax ? layerSourceOf(entry, shader, emissiveMap) : null;
	const names: (string | null)[] = [
		'_BaseColorMap',
		family === 'hlod' ? null : '_NormalMap',
		maskSlotOf(entry, triChannel),
		// a layer's mask map takes this slot in `layerBlendParams`
		emissiveMap ? '_EmissiveMap' : null,
		lit && keywords.includes('_DETAIL_MAP') ? '_DetailMap' : null,
		parallax ? '_ParallaxMap' : layer !== null ? '_Layer1BaseMap' : null,
		parallax ? '_ParallaxNoiseMap' : layer !== null ? '_Layer1BumpMap' : null,
	];
	names.forEach((name, i) => {
		const slot = name === null ? undefined : entry.slots[name];
		if (slot === undefined || slot.uv > 1) {
			return;
		}
		look.textures[i] = slot.texture;
		look.uvScales[i] = Math.max(Math.abs(slot.scale[0]), Math.abs(slot.scale[1]), 1e-3);
		look.flags |= SLOT_FLAGS[i] | (slot.uv << (UV1_SHIFT + i));
		params.set([...slot.scale, ...slot.offset], LookRow.uv + i * 4);
	});

	if (mro) {
		look.flags |= LookFlags.NormalRag;
	} else if (entry.baseTextureMapCount !== null || foliage) {
		look.flags |= LookFlags.NormalRoughness;
	}
	// the two-basemap layout's occlusion and metallic sources (module comment)
	if (family === 'lit' && entry.baseTextureMapCount !== null && !mro) {
		look.flags |= LookFlags.NormalOcclusion;
		if (entry.baseTextureMapCount < 1.5) {
			look.flags |= LookFlags.MetallicBaseAlpha;
		}
	}
	if (foliage) {
		look.flags |= LookFlags.Foliage;
	}

	// base colour: tinted and brightened, then covered by the tint. the HLOD shader ignores the tint
	{
		const tint = colorOf(entry, shader, '_BaseColor');
		const cover = floatOf(entry, shader, '_BaseColorTintCover', 0);
		const brighter = floatOf(entry, shader, '_BaseColorBrighterScale', 1);
		const color = tint === undefined || family === 'hlod' ? [1, 1, 1] : linearRgb(tint);
		params.set([...color, entry.alphaClipThreshold ?? -1], LookRow.tint);
		// `_AlphaMaskChannel` picks the alpha the Lit family tests: 0 the base colour's, 1 the normal map's. in
		// the `_BaseTextureMapCount` 1 layout the base colour's alpha is metallic, so testing it would cut holes in solid walls
		if (
			(family === 'lit' || family === 'litTransparent') &&
			floatOf(entry, shader, '_AlphaMaskChannel', 0) === 1
		) {
			look.flags |= LookFlags.AlphaNormal;
		}
		// alpha-blended (`HGRP/LitTransparent` glass): the opacity is the alpha the alpha test would read, times
		// `_BaseColor.a`. glass casting a solid shadow would darken what lies behind it, so it casts none
		if (entry.blend === 'alphaBlend') {
			look.transparent = true;
			look.castsShadows = false;
			params[LookRow.emissive2 + 3] = tint?.[3] ?? 1;
		}
		look.cutout =
			!look.transparent &&
			entry.alphaClipThreshold !== null &&
			entry.alphaClipThreshold >= 0 &&
			alphaTextureOf(look) >= 0;
		params[LookRow.surface2 + 3] = brighter;
		// untextured: the tint alone
		params[LookRow.emissive + 3] = look.textures[0] < 0 ? 1 : cover;
	}

	// surface
	{
		const roughnessMin = floatOf(entry, shader, '_RoughnessMin', 0);
		const roughnessMax = floatOf(entry, shader, '_RoughnessMax', 1);
		const metallic = floatOf(entry, shader, '_Metallic', 0);
		const normalScale = floatOf(entry, shader, '_NormalScale', 1);
		params.set([roughnessMin, roughnessMax, metallic, normalScale], LookRow.surface);
		const occlusion = floatOf(entry, shader, '_OcclusionStrength', 1);
		const specular = floatOf(entry, shader, '_Specular', 0.5);
		const transmission = foliage ? floatOf(entry, shader, '_Transmission', 0.2) : 0;
		// the brighter scale in the row's last float is set above
		params.set([occlusion, 0.08 * specular, transmission], LookRow.surface2);
	}
	if (family === 'leaf') {
		leafParams(look, entry, shader);
	}

	// emission: `_EmissiveColor` (HDR, authored linear) times the emissive map's R channel
	// (`_EMISSIVE_MAP`), or times a channel of the base, normal or MRO map that `_EmissiveMaskChannel` picks
	// (`_EMISSIVE_MASK`, where 0 turns emission off; mesh.wgsl reads the channel). the animated variants are
	// drawn still, and `_EMISSIVE_NOMAP` only comes with the sweep animation, so it stays dark
	{
		const emissive = colorOf(entry, shader, '_EmissiveColor');
		const channel = floatOf(entry, shader, '_EmissiveMaskChannel', 0);
		let emits = false;
		if (emissiveMap) {
			emits = look.textures[3] >= 0;
		} else if (entry.keywords.includes('_EMISSIVE_MASK') && channel > 0) {
			look.flags |= LookFlags.EmissiveMask;
			emits = true;
		}
		if (emits && emissive !== undefined) {
			// an HDR colour: Unity's HDR picker authors it in linear space, so it goes to the shader as stored
			params.set([emissive[0], emissive[1], emissive[2]], LookRow.emissive);
			params.set(
				[
					floatOf(entry, shader, '_AlbedoAffectEmissive', 1),
					channel,
					floatOf(entry, shader, '_IgnorePostExposure', 1),
				],
				LookRow.emissive2,
			);
		}
	}

	// tri-channel mask: each channel, remapped by its contrast and offset and scaled by its colour's alpha,
	// blends albedo, roughness and metallic toward its own values, B first and R last
	if (triChannel && look.textures[2] >= 0) {
		look.flags |= LookFlags.TriChannelMask;
		// the switch-texture variants take G and B from textures of their own, which have no slot: only R blends
		const switched = keywords.some((keyword) => keyword.startsWith('_TRI_CHANNEL_MASK_SWITCH_TEXTURE'));
		MASK_CHANNELS.forEach((channel, i) => {
			const color = colorOf(entry, shader, channel.albedo) ?? [1, 1, 1, 0];
			params.set([...linearRgb(color), switched && i > 0 ? 0 : color[3]], LookRow.maskAlbedo + i * 4);
			params[LookRow.maskRoughness + i] = floatOf(entry, shader, channel.roughness, 1);
			params[LookRow.maskMetallic + i] = floatOf(entry, shader, channel.metallic, 0);
			params[LookRow.maskScale + i] = floatOf(entry, shader, channel.scale, 0);
			params[LookRow.maskOffset + i] = floatOf(entry, shader, channel.offset, 0);
		});
	}

	if (look.textures[4] >= 0) {
		params.set(
			[
				floatOf(entry, shader, '_DetailMode', 1),
				floatOf(entry, shader, '_DetailMaskMode', 0),
				floatOf(entry, shader, '_DetailNormalIntensity', 1),
				floatOf(entry, shader, '_DetailPBRIntensity', 0),
			],
			LookRow.detail,
		);
		params.set(
			[
				floatOf(entry, shader, '_DetailFalloffStart', 0),
				floatOf(entry, shader, '_DetailFalloffEnd', 0),
				floatOf(entry, shader, '_DetailBaseColorBrighterScale', 1),
			],
			LookRow.detail2,
		);
		const overlay = colorOf(entry, shader, '_DetailOverlayColor') ?? [0, 0, 0, 0];
		params.set([...linearRgb(overlay), overlay[3]], LookRow.detailOverlay);
	}

	if (look.textures[5] >= 0 && look.textures[6] >= 0) {
		if (layer !== null) {
			layerBlendParams(look, entry, shader, layer);
		} else {
			parallaxParams(look, entry, shader);
		}
	} else {
		look.textures[5] = look.textures[6] = -1;
		look.flags &= ~(LookFlags.ParallaxMap | LookFlags.ParallaxNoiseMap);
	}
	return look;
};

/**
 * `HGRP/Foliage/Leaf`'s GBuffer inputs to the game's two-sided foliage lighting: a sun shadow from the vertex
 * AO (vertex colour R) and a fake directional shadow on leaves facing away from the sun, the sun's N·L from
 * the vertex normal, transmission and subsurface faded in by the vertex AO, and the canopy ramp, which tints
 * the albedo toward a colour down the canopy (vertex colour A). the reflectance is quantized to 3 bits, as
 * the GBuffer stores it
 */
const leafParams = (look: MaterialLook, entry: ReadyMaterial, shader: ShaderEntry): void => {
	const params = look.params;
	look.flags |= LookFlags.FoliageLeaf;
	const reflectance = Math.round(Math.min(Math.max(floatOf(entry, shader, '_Reflectance', 0), 0), 1) * 7) / 7;
	params[LookRow.surface2 + 1] = 0.08 * (0.5 + 0.75 * reflectance);
	params.set(
		[
			floatOf(entry, shader, '_OcclusionShadow', 0),
			floatOf(entry, shader, '_FakeDirectionalShadowStrength', 0),
			floatOf(entry, shader, '_FakeDirectionalShadowPow', 1),
			floatOf(entry, shader, '_DiffuseUseVertexNormal', 0),
		],
		LookRow.foliage,
	);
	params.set(
		[
			floatOf(entry, shader, '_AoAffectTransmissionStart', 0),
			floatOf(entry, shader, '_AoAffectTransmissionRange', 0.01),
			floatOf(entry, shader, '_AoAffectSubsurfaceStart', 0),
			floatOf(entry, shader, '_AoAffectSubsurfaceRange', 0.01),
		],
		LookRow.foliageAo,
	);
	const canopy = entry.keywords.includes('_CANOPY_COLOR_RAMP');
	params.set(
		[
			floatOf(entry, shader, '_SubsurfaceIntensity', 0),
			floatOf(entry, shader, '_TransmissionDistanceFade', 0),
			canopy ? floatOf(entry, shader, '_CanopyRampIntensity', 0) : 0,
			floatOf(entry, shader, '_CanopyRampStartAtTop', 0) > 0 ? 1 : 0,
		],
		LookRow.foliage2,
	);
	params.set(
		[
			floatOf(entry, shader, '_CanopyRampRange', 0),
			floatOf(entry, shader, '_CanopyRampTransitionRange', 0),
			floatOf(entry, shader, '_CanopyRampColorBrighterScale', 1),
			floatOf(entry, shader, '_CanopyRampColorCover', 0),
		],
		LookRow.canopy,
	);
	params.set(linearRgb(colorOf(entry, shader, '_CanopyRampColor') ?? [1, 1, 1, 1]), LookRow.canopyColor);
};

/** the tri-channel mask's properties per channel, R, G, B */
const MASK_CHANNELS = [
	{
		albedo: '_MaskAlbedoR',
		roughness: '_MaskRoghnessR',
		metallic: '_MaskMetallicR',
		scale: '_MaskRScale',
		offset: '_MaskROffset',
	},
	{
		albedo: '_MaskAlbedoG',
		roughness: '_MaskRoghnessG',
		metallic: '_MaskMetallicG',
		scale: '_MaskGScale',
		offset: '_MaskGOffset',
	},
	{
		albedo: '_MaskAlbedoB',
		roughness: '_MaskRoghnessB',
		metallic: '_MaskMetallicB',
		scale: '_MaskBScale',
		offset: '_MaskBOffset',
	},
] as const;

/** @returns the texture in the mask slot: the MRO map in that layout, else the tri-channel mask if it's on */
const maskSlotOf = (entry: ReadyMaterial, triChannel: boolean): string | null => {
	if (entry.baseTextureMapCount === 0) {
		return '_MROMap';
	}
	if (triChannel) {
		return '_MaskMap';
	}
	return null;
};

/**
 * `_PARALLAX_MAP`: a few steps march the view ray through `_ParallaxNoiseMap` as a height field below the
 * surface; where it hits, `_ParallaxMap`'s G picks between the dark and bright colours. the glow is masked by
 * a channel of the material's own maps (squared), a Fresnel power, and a pulse over time whose phase follows
 * the object's position. both maps ignore their `_ST` and tile by their own scale.
 *
 * with `_ParallaxCharPos`, the glow brightens near the player. a global highlight isn't drawn
 */
const parallaxParams = (look: MaterialLook, entry: ReadyMaterial, shader: ShaderEntry): void => {
	const params = look.params;
	const tiling = floatOf(entry, shader, '_ParallaxTilling', 1);
	const noiseTiling = floatOf(entry, shader, '_ParallaxNoiseMapTilling', 1);
	params.set([tiling, tiling, 0, 0], LookRow.uv + 5 * 4);
	params.set([noiseTiling, noiseTiling, 0, 0], LookRow.uv + 6 * 4);
	look.uvScales[5] = Math.max(Math.abs(tiling), 1e-3);
	look.uvScales[6] = Math.max(Math.abs(noiseTiling), 1e-3);
	// the noise follows the pattern's UV set
	look.flags &= ~(1 << (UV1_SHIFT + 6));
	if ((look.flags & (1 << (UV1_SHIFT + 5))) !== 0) {
		look.flags |= 1 << (UV1_SHIFT + 6);
	}

	// the step count is an integer uniform: the float property truncates. the pulse runs between the minimum
	// brightness and 1
	const steps = Math.min(Math.max(Math.trunc(floatOf(entry, shader, '_ParallaxMarchNum', 3)), 1), 20);
	const minimum = floatOf(entry, shader, '_ParallaxMinBrightness', 0);
	params.set(
		[
			floatOf(entry, shader, '_ParallaxStrength', 0),
			steps,
			Math.floor(floatOf(entry, shader, '_ParallaxFresnelStrength', 1)),
			(1 - minimum) / 2,
		],
		LookRow.parallax,
	);
	// the pulse's phase advances 0.05 · speed per tick of a global clock, assumed to tick in seconds
	params.set(
		[
			0.05 * floatOf(entry, shader, '_ParallaxAnimSpeed', 0),
			floatOf(entry, shader, '_ParallaxAnimRandom', 0),
			floatOf(entry, shader, '_ParallaxIgnorePostExposure', 1),
			(1 + minimum) / 2,
		],
		LookRow.parallax2,
	);
	// HDR colours, as stored (see the emission above)
	const intensity = floatOf(entry, shader, '_ParallaxIntensity', 1);
	const bright = colorOf(entry, shader, '_ParallaxColor') ?? [0, 0, 0, 1];
	const dark = colorOf(entry, shader, '_ParallaxColorDark') ?? [0, 0, 0, 1];
	params.set(
		[
			bright[0] * intensity,
			bright[1] * intensity,
			bright[2] * intensity,
			floatOf(entry, shader, '_ParallaxMaskChannel', 0),
		],
		LookRow.parallaxColor,
	);
	params.set([dark[0] * intensity, dark[1] * intensity, dark[2] * intensity], LookRow.parallaxDark);
	// added to the pulse: up to `_ParallaxBrightStrength` more within the radii of the player, whom the
	// viewer places at the camera
	params.set(
		[
			floatOf(entry, shader, '_ParallaxBrightOuterRadius', 20),
			floatOf(entry, shader, '_ParallaxBrightInnerRadius', 10),
			floatOf(entry, shader, '_ParallaxCharPos', 0) !== 0
				? floatOf(entry, shader, '_ParallaxBrightStrength', 1)
				: 0,
		],
		LookRow.parallaxBright,
	);
};

/** what decides how much a layer covers ({@link LayerBlendRow.height}'s last float) */
export const LayerSource = {
	/** `_LAYERBLEND_TOP`: how far the surface faces up */
	Top: 0,
	/** `_LAYERBLEND_MASK` with `_LayerBlendMaskType` 0: `_LayerBlendMaskMap`'s R, in the emissive slot */
	MaskMap: 1,
	/** `_LayerBlendMaskType` 1: the layer bump map's alpha */
	LayerBumpAlpha: 2,
	/** `_LayerBlendMaskType` 2: the base colour's alpha */
	BaseAlpha: 3,
	/** `_LayerBlendMaskType` 3: the normal map's alpha */
	NormalAlpha: 4,
	/** `_LayerBlendMaskType` 4: everywhere */
	Full: 5,
} as const;

type LayerSource = (typeof LayerSource)[keyof typeof LayerSource];

const LAYER_MASK_MAP = '_LayerBlendMaskMap';

/**
 * @returns the layer's coverage source, or `null` for a material without a layer the viewer draws: the mask's
 *   noise and parallax variants aren't ported, and a mask map can't share the slot with an emissive map
 */
const layerSourceOf = (
	entry: ReadyMaterial,
	shader: ShaderEntry,
	emissiveMap: boolean,
): LayerSource | null => {
	const keywords = entry.keywords;
	if (keywords.includes('_LAYERBLEND_TOP')) {
		return LayerSource.Top;
	}
	if (
		!keywords.includes('_LAYERBLEND_MASK') ||
		keywords.includes('_LAYERBLEND_NOISEBLEND') ||
		keywords.includes('_LAYERBLEND_MASK_PARALLAX_PBR')
	) {
		return null;
	}
	// the game rounds the type to the nearest of 1 to 4; anything under 0.5 samples the mask map
	const type = floatOf(entry, shader, '_LayerBlendMaskType', 0);
	if (type < 0.5) {
		if (entry.slots[LAYER_MASK_MAP] === undefined) {
			// without a texture the shader's default stands in
			return shader.textures[LAYER_MASK_MAP] === 'white' ? LayerSource.Full : null;
		}
		return emissiveMap ? null : LayerSource.MaskMap;
	}
	const sources = [
		LayerSource.LayerBumpAlpha,
		LayerSource.BaseAlpha,
		LayerSource.NormalAlpha,
		LayerSource.Full,
	];
	return sources[Math.min(Math.max(Math.round(type), 1), 4) - 1];
};

/** float offsets of a layer's parameters ({@link layerBlendParams}), which reuse the parallax and leaf rows */
export const LayerBlendRow = {
	/**
	 * how much the bumped normal decides top coverage (`_TopBlendWithBumpMap`), `_TopBlendThreshold`,
	 * `_TopBlendSmoothness`, the layer's coordinates (`_LayerBlendUVType`: 0 UV set 0, 1 world XZ, 2 UV set 2)
	 */
	coverage: LookRow.parallax,
	/**
	 * 1 for the height blend (`_LayerBlendHeight`), `_LayerBlendHeightTransition`, the base's height, the
	 * coverage source ({@link LayerSource})
	 */
	height: LookRow.parallax2,
	/** linear `_Layer1TintColor` times `_Layer1ColorBrighterScale`, how much colour the layer keeps */
	color: LookRow.parallaxColor,
	/**
	 * `_Layer1BaseColorBlendMode` (0 replace, 1 add), its additive intensity, `_LayerMetallicType`,
	 * `_Layer1Metallic`
	 */
	blend: LookRow.parallaxDark,
	/** `_Layer1BumpScale`, `_Layer1BaseNormalIntensity`, `_Layer1AOStrength`, `_LayerAOType` */
	normal: LookRow.parallaxBright,
	/**
	 * `_LAYERBLEND_MOSS`: `_Layer1FuzzyCoreDarkness`, `…EdgeBrightness`, `…EdgeShadowRange`,
	 * `…EdgeShadowOffset`; neutral without the keyword
	 */
	fuzzy: LookRow.foliage,
	/** `_Layer1FuzzyEdgeShadowIntensity`, `…DarkPower`, `…BrightPower`, `…NormalStrength` */
	fuzzy2: LookRow.foliageAo,
} as const;

/**
 * `_LAYERBLEND_TOP` and `_LAYERBLEND_MASK`: a second material covers the base where the surface faces up, or
 * by a mask. top coverage is `saturate((up − _TopBlendThreshold) / _TopBlendSmoothness)`, with `up` the world
 * Y of the geometric normal, blended toward the bumped one by `_TopBlendWithBumpMap`; mask coverage is
 * `_LayerBlendMaskMap`'s R (UV set 0, or 1 when `_LayerBlendMaskUVType` is 0, ignoring its `_ST`) or a map
 * channel by `_LayerBlendMaskType`. with `_LayerBlendHeight`, coverage then sharpens by comparing the base's
 * height with the layer's (`_Layer1BaseMap`'s alpha). the layer's colour (desaturated, tinted, brightened)
 * replaces or adds to the albedo; roughness (`_Layer1BumpMap`'s B), occlusion (its A), metallic and the
 * normal (reoriented onto the base's by `_Layer1BaseNormalIntensity`) blend toward the layer's. both maps
 * sample one coordinate, tiled by `_Layer1Tilling` and offset by `_Layer1Offset`, ignoring their `_ST`.
 *
 * `_LAYERBLEND_MOSS` shades the layer as fuzzy: darker where it faces the viewer, brighter towards its
 * silhouette, shadowed along the coverage edge, whose normal also tips down.
 *
 * the viewer doesn't load UV set 2 and samples set 0 instead: no map02 mesh drawn with a UV-set-2 layer has
 * the set, and the game reads a missing set as set 0. `_BaseHeightMap` has no slot and reads as the shader's
 * grey default
 */
const layerBlendParams = (
	look: MaterialLook,
	entry: ReadyMaterial,
	shader: ShaderEntry,
	source: LayerSource,
): void => {
	const params = look.params;
	const float = (name: string, fallback: number): number => floatOf(entry, shader, name, fallback);
	look.flags |= LookFlags.LayerBlend;
	const mask = entry.slots[LAYER_MASK_MAP];
	if (source === LayerSource.MaskMap && mask !== undefined) {
		const uv1 = float('_LayerBlendMaskUVType', 0) === 0;
		look.textures[3] = mask.texture;
		look.uvScales[3] = 1;
		look.flags |= LookFlags.EmissiveMap;
		look.flags = uv1 ? look.flags | (1 << (UV1_SHIFT + 3)) : look.flags & ~(1 << (UV1_SHIFT + 3));
		params.set([1, 1, 0, 0], LookRow.uv + 3 * 4);
	}
	const tiling = float('_Layer1Tilling', 1);
	const offset = vectorOf(entry, shader, '_Layer1Offset') ?? [0, 0, 0, 0];
	for (const slot of [5, 6]) {
		params.set([tiling, tiling, offset[0], offset[1]], LookRow.uv + slot * 4);
		look.uvScales[slot] = Math.max(Math.abs(tiling), 1e-3);
		look.flags &= ~(1 << (UV1_SHIFT + slot));
	}
	params.set(
		[
			float('_TopBlendWithBumpMap', 0),
			float('_TopBlendThreshold', 0.5),
			Math.max(float('_TopBlendSmoothness', 0.5), 1.175_494e-38),
			float('_LayerBlendUVType', 0),
		],
		LayerBlendRow.coverage,
	);
	params.set(
		[float('_LayerBlendHeight', 0) !== 0 ? 1 : 0, float('_LayerBlendHeightTransition', 1), 0.5, source],
		LayerBlendRow.height,
	);
	const tint = linearRgb(colorOf(entry, shader, '_Layer1TintColor') ?? [1, 1, 1, 1]);
	const brighter = float('_Layer1ColorBrighterScale', 1);
	params.set(
		[...tint.map((c) => c * brighter), Math.min(Math.max(float('_Layer1Saturation', 0) + 1, 0), 1)],
		LayerBlendRow.color,
	);
	params.set(
		[
			float('_Layer1BaseColorBlendMode', 0),
			float('_Layer1BaseColorAdditiveIntensity', 1),
			float('_LayerMetallicType', 0),
			float('_Layer1Metallic', 0),
		],
		LayerBlendRow.blend,
	);
	params.set(
		[
			float('_Layer1BumpScale', 1),
			float('_Layer1BaseNormalIntensity', 0),
			float('_Layer1AOStrength', 1),
			float('_LayerAOType', 0),
		],
		LayerBlendRow.normal,
	);
	// neutral fuzz: no darkening, brightening or edge shadow, a unit range so the edge term stays finite
	let fuzzy = [0, 0, 1, 0];
	let fuzzy2 = [0, 1, 1, 0];
	if (entry.keywords.includes('_LAYERBLEND_MOSS')) {
		fuzzy = [
			float('_Layer1FuzzyCoreDarkness', 0),
			float('_Layer1FuzzyEdgeBrightness', 0),
			float('_Layer1FuzzyEdgeShadowRange', 1),
			float('_Layer1FuzzyEdgeShadowOffset', 0),
		];
		// the game floors both powers at 0.1
		fuzzy2 = [
			float('_Layer1FuzzyEdgeShadowIntensity', 0),
			Math.max(float('_Layer1FuzzyDarkPower', 1), 0.1),
			Math.max(float('_Layer1FuzzyBrightPower', 1), 0.1),
			float('_Layer1FuzzyNormalStrength', 0),
		];
	}
	params.set(fuzzy, LayerBlendRow.fuzzy);
	params.set(fuzzy2, LayerBlendRow.fuzzy2);
};

/**
 * float offsets of an {@link erosionLook}'s parameters, which reuse the rows of {@link LookRow} that the Lit
 * layers use
 */
export const ErosionRow = {
	/** linear `_BaseColor`, no alpha test */
	base: LookRow.tint,
	/** `_Roughness`, `_DetailRoughnessCover`, `_Metallic`, `_NormalScale` */
	surface: LookRow.surface,
	/** `_OcclusionStrength`, f0, `_MetallicOffset`, `_DetailNormalScale` */
	surface2: LookRow.surface2,
	/** `_NoiseEmissiveStrength`, `_FlowColorStrength`, `_FlowColorEmissiveStrength`, `_DistanceBlend` */
	strengths: LookRow.emissive,
	/** `_MetallicColor`, `_NoiseStrength` (the noise layer's depth) */
	metal: LookRow.maskAlbedo,
	/** `_NoisePatternTintColor`, `_NoiseMin` */
	noise: LookRow.maskAlbedo + 4,
	/** `_NoisePatternAlphaTintColor`, `_FlowColorOffset` */
	noiseAlpha: LookRow.maskAlbedo + 8,
	/** `_FlowTopColor`, `_FlowRoughness` */
	flowTop: LookRow.maskRoughness,
	/** `_FlowBottomColor` */
	flowBottom: LookRow.maskMetallic,
	/** `_FlowNormalTilling`, `_FlowNoiseStrength`, ramp scroll per second, `_FlowSpeedOffset` */
	flow: LookRow.maskScale,
} as const;

/** an {@link erosionLook}'s textures by slot of {@link SLOTS}, with the property that tiles each */
const EROSION_SLOTS: (readonly [name: string, tiling: string | null] | null)[] = [
	null,
	['_BaseNormalMap', '_BaseNormalTilling'],
	['_MetalMixMap', null],
	// sampled at a coordinate of its own, not by UV
	['_FlowRampMap', null],
	['_DetailNormalMap', '_DetailNormalTilling'],
	// the noise layer: the parallax march samples it untiled, the colour lookup tiled
	['_NoisePatternMap', '_NoisePatternMapTilling'],
	['_NoisePatternMap', null],
];

/**
 * `HGRP/Erosion`: the blight-covered rock. a base colour and an HDR metal colour are mixed by `_MetalMixMap`
 * (R: 0 where metal; G: occlusion and flow noise; B: where the flow band shows; A: roughness). a noise
 * pattern, offset by a one-step parallax and tinted, is added to the colour and faintly to emission. a flow
 * band reads `_FlowRampMap` along the object's height and blends from `_FlowBottomColor` below
 * `_FlowColorOffset` to `_FlowTopColor` above it. the base and detail normal maps are summed. every texture
 * samples UV set 0 and ignores its `_ST`, tiling by its own property instead. HDR colours are used as stored,
 * like `_EmissiveColor`.
 *
 * the blend with whatever lies behind (`_ObjectBlend*`, which needs the scene's depth) and
 * `_FakeTranslucency` aren't drawn
 */
const erosionLook = (entry: ReadyMaterial, shader: ShaderEntry): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = entry.cull;
	look.flags |= LookFlags.Erosion;
	const params = look.params;
	EROSION_SLOTS.forEach((use, i) => {
		const slot = use === null ? undefined : entry.slots[use[0]];
		if (use === null || slot === undefined) {
			return;
		}
		const tiling = use[1] === null ? 1 : floatOf(entry, shader, use[1], 1);
		look.textures[i] = slot.texture;
		// the ramp is sampled at its finest level whatever its size on screen
		look.uvScales[i] = i === 3 ? 0 : Math.max(Math.abs(tiling), 1e-3);
		look.flags |= SLOT_FLAGS[i];
		params.set([tiling, tiling, 0, 0], LookRow.uv + i * 4);
	});
	const hdr = (name: string): number[] => (colorOf(entry, shader, name) ?? [1, 1, 1, 1]).slice(0, 3);
	const float = (name: string, fallback: number): number => floatOf(entry, shader, name, fallback);
	params.set([...linearRgb(colorOf(entry, shader, '_BaseColor') ?? [1, 1, 1, 1]), -1], ErosionRow.base);
	params.set(
		[
			float('_Roughness', 0),
			float('_DetailRoughnessCover', 0),
			float('_Metallic', 0),
			float('_NormalScale', 1),
		],
		ErosionRow.surface,
	);
	params.set(
		[
			float('_OcclusionStrength', 1),
			0.08 * float('_Specular', 0.5),
			float('_MetallicOffset', 0),
			float('_DetailNormalScale', 1),
		],
		ErosionRow.surface2,
	);
	params.set(
		[
			float('_NoiseEmissiveStrength', 0),
			float('_FlowColorStrength', 0),
			float('_FlowColorEmissiveStrength', 0),
			float('_DistanceBlend', 1),
		],
		ErosionRow.strengths,
	);
	params.set([...hdr('_MetallicColor'), float('_NoiseStrength', 0)], ErosionRow.metal);
	params.set([...hdr('_NoisePatternTintColor'), float('_NoiseMin', 0)], ErosionRow.noise);
	params.set([...hdr('_NoisePatternAlphaTintColor'), float('_FlowColorOffset', 0)], ErosionRow.noiseAlpha);
	params.set([...hdr('_FlowTopColor'), float('_FlowRoughness', 0)], ErosionRow.flowTop);
	params.set(hdr('_FlowBottomColor'), ErosionRow.flowBottom);
	// the scroll advances 0.05 · speed per tick of a global clock, assumed to tick in seconds (as the parallax
	// pulse's)
	params.set(
		[
			float('_FlowNormalTilling', 0),
			float('_FlowNoiseStrength', 0),
			0.05 * float('_FlowNormalSpeed', 0),
			float('_FlowSpeedOffset', 0),
		],
		ErosionRow.flow,
	);
	return look;
};

/** keywords a `HGRP/Effect/VFXDitherAlpha` material can have and still be drawn by {@link ditherAlphaLook} */
const DITHER_ALPHA_KEYWORDS = new Set(['_NORMAL_MAP', '_USE_MAIN2']);

/**
 * `HGRP/Effect/VFXDitherAlpha`: an effect shader that writes the G-buffer like an opaque surface, used for
 * solid effect meshes such as the rocks floating over Origin Lodespring's crater. the colour is `_TintColor ·
 * _TintColorIntensity` times `_MainTex` (or the tint alone with `_UseMainTexAsAlpha`), times `_MainTex2Color`
 * when `_USE_MAIN2` takes only its alpha from `_MainTex2` (`_UseMainTex2AsAlpha`) and multiplies
 * (`_MainTex2BlendMode` 0). it is the albedo with `_UseLighting` (saturated, as the G-buffer stores it), else
 * the emitted radiance. `_NORMAL_MAP` adds a tangent-space normal map (`_NormalScale`, read like Unity's
 * `UnpackNormal`), roughness and metallic are `_Roughness` and `_Metallic`. the shader has no shadow caster
 * pass. its depth pass discards by the alpha against a screen-space dither; no drawn material fades, so the
 * dither isn't drawn
 *
 * @returns the look, or `null` with keywords or texture combinations the viewer doesn't draw
 */
const ditherAlphaLook = (entry: ReadyMaterial, shader: ShaderEntry): MaterialLook | null => {
	const keywords = entry.keywords;
	if (keywords.some((keyword) => !DITHER_ALPHA_KEYWORDS.has(keyword))) {
		return null;
	}
	const float = (name: string, fallback: number): number => floatOf(entry, shader, name, fallback);
	let second: [number, number, number] = [1, 1, 1];
	if (keywords.includes('_USE_MAIN2')) {
		if (float('_UseMainTex2AsAlpha', 0) === 0 || float('_MainTex2BlendMode', 0) !== 0) {
			return null;
		}
		second = linearRgb(colorOf(entry, shader, '_MainTex2Color') ?? [1, 1, 1, 1]);
	}
	const look = emptyLook({ drawn: true });
	look.cull = entry.cull;
	look.castsShadows = false;
	const params = look.params;
	const slots: [string | null, number][] = [
		[float('_UseMainTexAsAlpha', 0) === 0 ? '_MainTex' : null, 0],
		[keywords.includes('_NORMAL_MAP') ? '_NormalMap' : null, 1],
	];
	for (const [name, i] of slots) {
		const slot = name === null ? undefined : entry.slots[name];
		if (slot === undefined || slot.uv !== 0) {
			continue;
		}
		look.textures[i] = slot.texture;
		look.uvScales[i] = Math.max(Math.abs(slot.scale[0]), Math.abs(slot.scale[1]), 1e-3);
		look.flags |= SLOT_FLAGS[i];
		params.set([...slot.scale, ...slot.offset], LookRow.uv + i * 4);
	}
	const intensity = float('_TintColorIntensity', 1);
	const tint = linearRgb(colorOf(entry, shader, '_TintColor') ?? [1, 1, 1, 1]);
	const color = tint.map((c, i) => c * intensity * second[i]);
	if (float('_UseLighting', 1) === 0) {
		// unlit: the radiance, as the matte painting's path draws it, with no highlight (zero intensity)
		look.flags |= LookFlags.Unlit;
		params.set([...color, -1], LookRow.tint);
		params[LookRow.emissive2 + 2] = float('_IgnorePostExposure', 1);
		return look;
	}
	look.flags |= LookFlags.NormalRag;
	// untextured, the tint is the albedo, which the G-buffer saturates
	const untextured = look.textures[0] < 0;
	params.set([...(untextured ? color.map((c) => Math.min(c, 1)) : color), -1], LookRow.tint);
	const roughness = float('_Roughness', 1);
	params.set([roughness, roughness, float('_Metallic', 0), float('_NormalScale', 1)], LookRow.surface);
	params.set([1, 0.04, 0, 1], LookRow.surface2);
	params[LookRow.emissive + 3] = untextured ? 1 : 0;
	return look;
};

/**
 * `HGRP/MattePainting`: painted backdrops on distant cards, unlit. the colour is `_MainTex` times `_TintColor
 * · _TintColorIntensity`, brightened by `_ExpIntensity` above `_ExpThreshold`; alpha is the texture's times
 * `_TintColor.a · _TintColorAlpha`, clamped to 1 and tested against `_AlphaClipThreshold`. the shader has no
 * shadow caster pass. `_UseMainTexAsAlpha` (alpha from the texture's R, colour from the tint alone) isn't
 * read: no packed material sets it
 */
const mattePaintingLook = (entry: ReadyMaterial, shader: ShaderEntry): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = entry.cull;
	look.castsShadows = false;
	look.flags |= LookFlags.Unlit;
	const params = look.params;
	const slot = entry.slots[MATTE_PAINTING_TEXTURE];
	if (slot !== undefined && slot.uv === 0) {
		look.textures[0] = slot.texture;
		look.uvScales[0] = Math.max(Math.abs(slot.scale[0]), Math.abs(slot.scale[1]), 1e-3);
		look.flags |= LookFlags.BaseMap;
		params.set([...slot.scale, ...slot.offset], LookRow.uv);
	}
	const tint = colorOf(entry, shader, '_TintColor') ?? [1, 1, 1, 1];
	const intensity = floatOf(entry, shader, '_TintColorIntensity', 1);
	const color = linearRgb(tint).map((c) => c * intensity);
	// the alpha test on the texture's alpha alone: saturate(a · scale) < clip ⇔ a < clip / scale while
	// clip ≤ 1; past 1 everything is discarded
	let threshold = -1;
	if (entry.alphaClipThreshold !== null && entry.alphaClipThreshold > 0) {
		const scale = tint[3] * floatOf(entry, shader, '_TintColorAlpha', 1);
		threshold = entry.alphaClipThreshold > 1 || scale <= 0 ? 2 : entry.alphaClipThreshold / scale;
	}
	params.set([...color, threshold], LookRow.tint);
	look.cutout = threshold >= 0 && look.textures[0] >= 0;
	params[LookRow.surface] = floatOf(entry, shader, '_ExpThreshold', 1);
	params[LookRow.surface + 1] = floatOf(entry, shader, '_ExpIntensity', 0);
	params[LookRow.emissive2 + 2] = floatOf(entry, shader, '_IgnorePostExposure', 1);
	return look;
};
