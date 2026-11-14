import type { MaterialCull, TextureSlot } from '@endfield-noclip/package-format/materials';
import type { EffectTexture } from '@endfield-noclip/package-format/surfaces';
import type { TextureRef } from '@endfield-noclip/package-format/textures';

/**
 * the texture slots the mesh shader samples, in binding order. the frame group leaves seven sampled textures
 * of WebGPU's default sixteen, so slots are shared where materials rarely use both: the third holds `_MROMap`
 * in the MRO layout and the tri-channel `_MaskMap` otherwise ({@link LookFlags.TriChannelMask}), which under
 * an MRO map moves to the emissive slot (`TRI_CHANNEL_IN_EMISSIVE_SLOT` in lit-look.ts), and looks with
 * {@link LookFlags.LayerBlend} put the layer's `_Layer1BaseMap` and `_Layer1BumpMap` in the parallax slots
 * (no map02 material has both keywords) and its `_LayerBlendMaskMap` in the emissive slot. looks with
 * {@link LookFlags.VertexOffset} put `_OffsetTex` and `_OffsetMaskTex` in the parallax slots
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

/** each {@link SLOTS} entry's index, its binding in the mesh families' material group */
export const Slot = {
	Base: 0,
	Normal: 1,
	/** `_MROMap`, or the tri-channel `_MaskMap` */
	Mask: 2,
	Emissive: 3,
	Detail: 4,
	Parallax: 5,
	ParallaxNoise: 6,
} as const;

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
	// bits 9 and 10 are the geometry's ({@link GeometryFlags})
	/** emission is the emissive colour times a channel of the material's own maps (`_EMISSIVE_MASK`) */
	EmissiveMask: 1 << 11,
	/** unlit: the tinted base colour is the radiance (matte paintings; see `mattePaintingLook`) */
	Unlit: 1 << 12,
	/** the alpha test reads the normal map's alpha instead of the base colour's (`_AlphaMaskChannel` 1) */
	AlphaNormal: 1 << 13,
	/** the tri-channel `_MaskMap` is bound: in the mask slot, or under an MRO map in the emissive slot */
	TriChannelMask: 1 << 14,
	DetailMap: 1 << 15,
	ParallaxMap: 1 << 16,
	ParallaxNoiseMap: 1 << 17,
	// bits UV1_SHIFT… pick each slot's UV set
	/** `HGRP/Erosion`: slots and parameters as `erosionLook` lays them out */
	Erosion: 1 << 25,
	// bit 26 is the geometry's ({@link GeometryFlags})
	/** `HGRP/Foliage/Leaf`: the sun shadow, vertex-normal lighting and canopy ramp of {@link LookRow.foliage} */
	FoliageLeaf: 1 << 27,
	/** a scene effect (`effects/`), drawn by `effect.wgsl` in one of the effect queues ({@link LookQueue}) */
	Effect: 1 << 28,
	/**
	 * `_USE_VERTOFFSET`: the parallax slots hold the vertex offset's texture and its mask rather than a glow,
	 * and the vertex stage samples them (`vertexOffsetParams` in lit-look.ts)
	 */
	VertexOffset: 1 << 29,
	/** `HGRP/Foliage/Trunk`'s `_FOLIAGE_TRUNK`: the canopy rows hold its vertex AO and ramp (`TrunkRow`) */
	Trunk: 1 << 30,
	/**
	 * `_LAYERBLEND_TOP` or `_LAYERBLEND_MASK`: the parallax slots and rows hold the layer (`layerBlendParams`).
	 * the sign bit, so the value is negative; `words` in mesh-renderer.ts store it unsigned
	 */
	LayerBlend: 1 << 31,
} as const;

/**
 * draw flags of the geometry, next to the material's {@link LookFlags} (`HAS_*` in mesh.wgsl). the shader
 * can't tell a missing stream from its values: the zero buffer bound in its place reads as an octahedral (0,
 * 0), which is +z
 */
export const GeometryFlags = {
	HasNormals: 1 << 9,
	HasTangents: 1 << 10,
	HasColors: 1 << 26,
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
 * floats of a material's draw parameters (`Look` in mesh.wgsl, one per look table slot), 48 rows: mesh looks
 * use the first 36 ({@link LookRow}), effect looks all of them for their own (`EffectRow` in
 * effects/effect-look.ts)
 */
export const LOOK_FLOATS = 192;

/** one material as the mesh shader draws it */
export interface MaterialLook {
	/** `false` for materials the game draws nothing visible with (water proxies, lit decals that change nothing) */
	drawn: boolean;
	/** a material the viewer can't draw, shown as a magenta checker (`unsupportedLook`) */
	unsupported: boolean;
	/** the draws the look's meshes join, which decide their pass and pipelines */
	queue: LookQueue;
	/** the faces the game culls, for unmirrored instances */
	cull: MaterialCull;
	/** whether the material draws into shadow maps */
	castsShadows: boolean;
	/** texture per {@link SLOTS} entry; `null` slots bind white */
	textures: TextureRef[];
	/** largest UV scale of each slot, for picking the mip level to stream */
	uvScales: number[];
	/** a 3D texture an effect samples besides its slots (the mist boxes' noise), or `null` */
	volumeTexture: TextureRef;
	/** {@link LookFlags}, with every slot that has a texture set */
	flags: number;
	/** {@link LOOK_FLOATS} draw parameters */
	params: Float32Array;
	/** the stencil test and write of effects that mask each other, or `null` for the rest */
	stencil: LookStencil | null;
	/**
	 * what the game draws of the material that this look leaves out, for the gaps view: the package's
	 * (`ReadyMaterial.gaps`: keywords and properties the extractor reads past), then what the look's builder
	 * dropped for want of a slot or a row. empty when nothing is known to be missing
	 */
	gaps: string[];
	/** how a looping clip keeps changing {@link params}; `null` for a look that holds still */
	motion: LookMotion | null;
}

/** a look's parameters over a looping clip (`MaterialMotion` in the package) */
export interface LookMotion {
	/**
	 * moves the look's {@link MaterialLook.params} to a time
	 *
	 * @param time seconds of the viewer's clock
	 * @returns whether they changed, so the look table needs them again
	 */
	advance(time: number): boolean;
}

/**
 * the float of a mesh look's parameters that is 1 when it has {@link MaterialLook.gaps}, which the gaps view
 * stripes (`shade` in mesh.wgsl): the first past the rows mesh looks use. effect looks use it for their own
 */
export const GAPS_FLOAT = 144;

/**
 * the draws a look's meshes join ({@link MaterialLook.queue}):
 *
 * - `opaque`: shaded in the main pass, after a depth prepass
 * - `cutout`: alpha-tested against the alpha of the base colour, or of the normal map with
 *   {@link LookFlags.AlphaNormal} (`fs_cutout_depth` in mesh.wgsl), once that texture is bound
 *   ({@link alphaTextureOf}); until then drawn as `opaque`
 * - `stencilMask`: writes only the stencil where its surface passes the depth test, at the end of the main pass
 *   (a portal's mask, with a {@link MaterialLook.stencil})
 * - `transparent`: alpha-blended in the transparent pass with the opacity `fs_transparent` in mesh.wgsl
 *   computes; never shadow-casting
 *
 * and scene effects ({@link LookFlags.Effect}), drawn by effect.wgsl once all their textures are bound:
 *
 * - `effect`: in the transparent pass
 * - `effectOpaque`: an opaque VFXBaseV2 layer, shaded in the main pass after the meshes, writing depth
 * - `effectDecal`: a VFXDecal box in the transparent pass, projected onto the surfaces inside it
 * - `mist`: a FogSimple card (`MistRow` in effects/mist.ts) in the transparent pass
 * - `mistVolume`: a VFXFakeVolumeFog box in the transparent pass, drawn by its back faces like a decal's
 * - `litDecal`: a lit decal laid over the surface beneath, drawn over the composited scene before the water,
 *   which it lies under as part of that surface
 * - `decalRelight`: a lit decal that changes only the normal, roughness or occlusion of the surface beneath,
 *   drawn by the decal relight pass into the main pass's radiance
 * - `screenMultiply`, `refract`: drawn over the composited scene, because they multiply what lies behind or
 *   sample it
 * - `waterFoam`, `waterFoamBehind`, `waterFoamThrough`: WaterDecal boxes drawn into the water's foam before the
 *   water draws, depth-tested in front of the scene, behind it, or not at all
 */
export type LookQueue =
	| 'opaque'
	| 'cutout'
	| 'stencilMask'
	| 'transparent'
	| 'effect'
	| 'effectOpaque'
	| 'effectDecal'
	| 'mist'
	| 'mistVolume'
	| 'litDecal'
	| 'decalRelight'
	| 'screenMultiply'
	| 'refract'
	| 'waterFoam'
	| 'waterFoamBehind'
	| 'waterFoamThrough';

/**
 * a draw's stencil state and the depth test that goes with it, from its material's `_Stencil*` and `_ZTest`
 * properties, for VFXBaseV2 portals (`docs/viewer/effects.md#portals`)
 */
export interface LookStencil {
	compare: GPUCompareFunction;
	/** whether passing fragments write the reference (Unity's Replace); the rest keep the stencil */
	replace: boolean;
	reference: number;
	readMask: number;
	writeMask: number;
	/** the depth test, mapped to reversed-Z */
	depthCompare: GPUCompareFunction;
}

/** float offsets of the rows of {@link MaterialLook.params} */
export const LookRow = {
	/** linear tint, alpha-test threshold */
	tint: 0,
	/** one UV transform per slot */
	uv: 4,
	/**
	 * roughness min, roughness max, metallic, normal scale; unlit looks: highlight threshold and intensity, the
	 * side of the checker cells in metres (0 for none; `unsupportedLook`)
	 */
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
	/** per channel, the mask's offset (`_Mask*Offset`); then 1 when the mask sits in the emissive slot */
	maskOffset: 72,
	/** `_DetailMode` (0 colour overlay, 1 PBR), `_DetailMaskMode`, normal intensity, PBR intensity */
	detail: 76,
	/**
	 * view depths where the detail starts and finishes fading out, overlay brighter scale (transparent looks,
	 * which have no detail map: 1 for premultiplied blending), 1 when the surface keeps lit decals off
	 * (`keepsLitDecalsOff`)
	 */
	detail2: 80,
	/** `_DetailOverlayColor`: linear colour, how much it covers */
	detailOverlay: 84,
	/**
	 * parallax depth (`_ParallaxStrength`), march steps, Fresnel power, pulse amplitude. `_EMISSIVE_ANIM` looks
	 * reuse this row and the next (`EmissivePulseRow`)
	 */
	parallax: 88,
	/** pulse phase per second, pulse phase per metre of the object's position, ignore post exposure, pulse mean */
	parallax2: 92,
	/**
	 * `_ParallaxColor` (HDR, as stored) times `_ParallaxIntensity`, mask channel. looks with a vertex offset
	 * reuse this row and the next two (`VertexOffsetRow`)
	 */
	parallaxColor: 96,
	/** `_ParallaxColorDark` times `_ParallaxIntensity` */
	parallaxDark: 100,
	/** the glow's brightening near the player: outer and inner radius, strength (0 without `_ParallaxCharPos`) */
	parallaxBright: 104,
	/**
	 * leaves: `_OcclusionShadow` (how much the vertex AO shadows the sun), the fake directional shadow's
	 * strength and power, `_DiffuseUseVertexNormal`. grass: `_BendNormalUpward`, the camera lean's intensity,
	 * `_MaskOnDiffuse`, `_MaskOnTransmission`. Lit layers reuse this row and the next (`LayerBlendRow`)
	 */
	foliage: 108,
	/**
	 * leaves: the vertex AO ranges that fade transmission and subsurface in: start, range, start, range. grass:
	 * the occlusion ramp's start height, its rate, its strength (1 − `_AoParams.z`), 1 for `_TwoSidedNormal`
	 */
	foliageAo: 112,
	/**
	 * leaves: `_SubsurfaceIntensity`, `_TransmissionDistanceFade`, the canopy ramp's intensity (0 without
	 * `_CANOPY_COLOR_RAMP`), 1 when the ramp starts at the top. grass: `_SubsurfaceIntensity`, then the sun
	 * mask ramp's start height, rate and strength (`_DirParams`)
	 */
	foliage2: 116,
	/**
	 * leaves: the canopy ramp's range, transition range, colour brighter scale, how much its colour covers.
	 * trunks reuse this row and the next (`TrunkRow` in lit-look.ts)
	 */
	canopy: 120,
	/** leaves: `_CanopyRampColor`, linear, then 1 for `_TwoSidedNormal` */
	canopyColor: 124,
	/**
	 * three rows, the HDR colours the emissive map's G, B and A add (`LitEmission.channels`); effect looks use
	 * these rows for their own (`EffectRow` in effects/effect-look.ts)
	 */
	emissiveChannels: 128,
	/**
	 * the per-draw albedo tint where the emission's strength is at least 0.1 (`LitEmission.albedoTint`): linear
	 * colour, weight
	 */
	emissiveAlbedo: 140,
} as const;

/**
 * @param look a material look
 * @returns the texture whose alpha an alpha-tested look tests, or `null` when it has none
 */
export const alphaTextureOf = (look: MaterialLook): TextureRef =>
	look.textures[(look.flags & LookFlags.AlphaNormal) !== 0 ? Slot.Normal : Slot.Base];

/** the part of a look that holds its textures and draw parameters, all an effect's own builder fills */
export type LookSlots = Pick<MaterialLook, 'textures' | 'uvScales' | 'volumeTexture' | 'params'>;

/**
 * @returns new slots, one per {@link SLOTS} entry, with no textures and identity UV transforms, and
 *   parameters zeroed otherwise
 */
export const emptySlots = (): LookSlots => {
	const params = new Float32Array(LOOK_FLOATS);
	for (let i = 0; i < SLOTS.length; i++) {
		params.set([1, 1, 0, 0], LookRow.uv + i * 4);
	}
	return {
		textures: SLOTS.map(() => null),
		uvScales: SLOTS.map(() => 1),
		volumeTexture: null,
		params,
	};
};

/**
 * @param options.drawn {@link MaterialLook.drawn}
 * @returns a new opaque, shadow-casting look that culls no faces, with no textures and identity UV
 *   transforms, for a look builder to fill
 */
export const emptyLook = ({ drawn }: { drawn: boolean }): MaterialLook => ({
	drawn,
	unsupported: false,
	queue: 'opaque',
	cull: 'none',
	castsShadows: true,
	...emptySlots(),
	flags: 0,
	stencil: null,
	gaps: [],
	motion: null,
});

/**
 * binds a texture to slot `i` with its UV transform (the slot's row of {@link LookRow.uv}, which effect looks
 * share), streamed for the larger of its scales
 *
 * @param look the look to change
 * @param i the slot
 * @param texture the texture and its UV scale and offset
 */
export const placeTexture = (
	look: LookSlots,
	i: number,
	texture: Pick<EffectTexture, 'texture' | 'scale' | 'offset'>,
): void => {
	look.textures[i] = texture.texture;
	look.uvScales[i] = Math.max(Math.abs(texture.scale[0]), Math.abs(texture.scale[1]), 1e-3);
	look.params.set([...texture.scale, ...texture.offset], LookRow.uv + i * 4);
};

/**
 * binds a texture to a slot of {@link SLOTS} with its UV set and `_ST` transform, setting the slot's flag
 *
 * @param look the look to change
 * @param i the slot
 * @param slot the texture and its UV set and transform
 */
export const setTexture = (look: MaterialLook, i: number, slot: TextureSlot): void => {
	placeTexture(look, i, slot);
	look.flags |= SLOT_FLAGS[i] | (slot.uv << (UV1_SHIFT + i));
};
