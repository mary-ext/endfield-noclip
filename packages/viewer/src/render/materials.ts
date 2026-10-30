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
 * that fades with view depth, and `_PARALLAX_MAP` glows with a pattern ray-marched below the surface.
 *
 * @module
 */

import type {
	Color,
	MaterialCull,
	MaterialTable,
	ReadyMaterial,
	ShaderEntry,
} from '@endfield-noclip/package-format/format';

import { linearRgb } from './color.ts';

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
 * sampled textures of WebGPU's default sixteen, and a material using both is rare
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
export const LOOK_FLOATS = 104;

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
	 * (1: emission keeps its brightness whatever the exposure)
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
		// effect meshes need their own opacity, distortion and animation passes. the opaque mesh fallback
		// turns their bounding surfaces into solid walls, including VFXDecal shaders without a family yet.
		if (
			SKIPPED_FAMILIES.has(shader.family) ||
			shader.name.startsWith('HGRP/Effect/') ||
			entry.blend === 'additive'
		) {
			looks[entry.id] = emptyLook({ drawn: false });
			continue;
		}
		if (shader.family === 'mattePainting') {
			looks[entry.id] = mattePaintingLook(entry, shader);
		} else {
			looks[entry.id] = lookOf(entry, shader);
		}
	}
	return looks;
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
	const triChannel = lit && keywords.includes('_TRI_CHANNEL_MASK') && !entry.usesMro;
	// a separate parallax mask texture (`_UseParallaxMask`) has no slot; such materials stay dark
	const parallax =
		lit && keywords.includes('_PARALLAX_MAP') && floatOf(entry, shader, '_UseParallaxMask', 0) === 0;
	const names: (string | null)[] = [
		'_BaseColorMap',
		family === 'hlod' ? null : '_NormalMap',
		maskSlotOf(entry, triChannel),
		emissiveMap ? '_EmissiveMap' : null,
		lit && keywords.includes('_DETAIL_MAP') ? '_DetailMap' : null,
		parallax ? '_ParallaxMap' : null,
		parallax ? '_ParallaxNoiseMap' : null,
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

	if (entry.normalLayout === 'RAG') {
		look.flags |= LookFlags.NormalRag;
	} else if (entry.normalLayout === 'RG' || foliage) {
		look.flags |= LookFlags.NormalRoughness;
	}
	// the two-texture layout's occlusion and metallic sources (module comment)
	if (family === 'lit' && entry.normalLayout === 'RG') {
		look.flags |= LookFlags.NormalOcclusion;
		if (floatOf(entry, shader, '_BaseTextureMapCount', 1) < 1.5) {
			look.flags |= LookFlags.MetallicBaseAlpha;
		}
	}
	if (foliage) {
		look.flags |= LookFlags.Foliage;
	}

	// base colour: brightened, then covered by the tint
	{
		const tint = colorOf(entry, shader, '_BaseColor');
		const cover = floatOf(entry, shader, '_BaseColorTintCover', 0);
		const brighter = floatOf(entry, shader, '_BaseColorBrighterScale', 1);
		const color = tint === undefined ? [1, 1, 1] : linearRgb(tint);
		params.set([...color, entry.alphaClipThreshold ?? -1], LookRow.tint);
		// `_AlphaMaskChannel` picks the alpha the Lit family tests: 0 the base colour's, 1 the normal map's. in
		// the one-base-map layout the base colour's alpha is metallic, so testing it would cut holes in solid walls
		if (family === 'lit' && floatOf(entry, shader, '_AlphaMaskChannel', 0) === 1) {
			look.flags |= LookFlags.AlphaNormal;
		}
		look.cutout =
			entry.alphaClipThreshold !== null && entry.alphaClipThreshold >= 0 && alphaTextureOf(look) >= 0;
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
		parallaxParams(look, entry, shader);
	} else {
		look.textures[5] = look.textures[6] = -1;
		look.flags &= ~(LookFlags.ParallaxMap | LookFlags.ParallaxNoiseMap);
	}
	return look;
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
	if (entry.usesMro) {
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
 * the bright-near-character term (`_ParallaxCharPos`) and a global highlight aren't drawn
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
