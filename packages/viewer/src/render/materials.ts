/**
 * how the viewer's mesh shader draws each package material: whether at all, which textures fill its four
 * slots (base colour, normal, mask, emission), and the draw parameters `mesh.wgsl` reads.
 *
 * the HGRP Lit family has two texture layouts (`_BaseTextureMapCount`): with an MRO map (R metallic, G
 * roughness, B occlusion) the normal map is `RAG`; without one (`_TWO_BASEMAP`, most materials) the normal
 * map's B channel holds roughness. foliage normal maps hold roughness in B the same way.
 *
 * @module
 */

import type {
	Color,
	MaterialTable,
	ReadyMaterial,
	ShaderEntry,
} from '@endfield-noclip/package-format/format';

import { linearRgb } from './environment.ts';

/** shader families that aren't drawn as opaque surfaces (fog volumes, light beams, effects) */
const SKIPPED_FAMILIES = new Set(['fogSimple', 'volumetricBeam', 'vfxFakeVolumeFog']);

const FOLIAGE_FAMILIES = new Set(['leaf', 'grass', 'cardMesh']);

/** stand-in albedo for materials without a base colour texture, linear */
const DEFAULT_ALBEDO: [r: number, g: number, b: number] = [0.5, 0.5, 0.5];

/** the texture slots the mesh shader samples, in binding order */
export const SLOTS = ['_BaseColorMap', '_NormalMap', '_MROMap', '_EmissiveMap'] as const;

/** {@link MaterialLook.flags} bits, matching `mesh.wgsl` */
export const LookFlags = {
	/** slot `i` of {@link SLOTS} has a texture: bit `i` */
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
} as const;

/** the slot flags of {@link LookFlags}, which are cleared while a slot's texture isn't resident */
export const SLOT_FLAGS = [LookFlags.BaseMap, LookFlags.NormalMap, LookFlags.MaskMap, LookFlags.EmissiveMap];

/**
 * floats of a material's draw parameters, eight vec4s (`Draw` in mesh.wgsl after the dequantization): tint
 * (rgb, alpha-test threshold), the four slots' UV transforms, surface (roughness min, max, metallic, normal
 * scale), surface 2 (occlusion strength, f0, transmission, brighter scale), emission (rgb, tint cover)
 */
export const LOOK_FLOATS = 32;

/** one material as the mesh shader draws it */
export interface MaterialLook {
	/** `false` for materials not drawn at all (fog volumes, additive blending) */
	drawn: boolean;
	/** texture id per {@link SLOTS} entry, or -1 */
	textures: [number, number, number, number];
	/** largest UV scale of each slot, for picking the mip level to stream */
	uvScales: [number, number, number, number];
	/** {@link LookFlags}, with every slot that has a texture set */
	flags: number;
	/** {@link LOOK_FLOATS} draw parameters */
	params: Float32Array;
}

/** float offsets of the rows of {@link MaterialLook.params} */
const LookRow = {
	/** linear tint, alpha-test threshold */
	tint: 0,
	/** one UV transform per slot */
	uv: 4,
	/** roughness min, roughness max, metallic, normal scale */
	surface: 20,
	/** occlusion strength, f0, transmission, base colour brighter scale */
	surface2: 24,
	/** emissive colour (linear), how much the tint covers the base colour */
	emissive: 28,
} as const;

/** a look with no textures and identity UV transforms */
const emptyLook = ({ drawn }: { drawn: boolean }): MaterialLook => {
	const params = new Float32Array(LOOK_FLOATS);
	for (let i = 0; i < SLOTS.length; i++) {
		params.set([1, 1, 0, 0], LookRow.uv + i * 4);
	}
	return { drawn, textures: [-1, -1, -1, -1], uvScales: [1, 1, 1, 1], flags: 0, params };
};

/** a material's value of a float property: its override, else the shader's default */
const floatOf = (entry: ReadyMaterial, shader: ShaderEntry, name: string, fallback: number): number =>
	entry.floats[name] ?? shader.floats[name] ?? fallback;

const colourOf = (entry: ReadyMaterial, shader: ShaderEntry, name: string): Color | undefined =>
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
		if (SKIPPED_FAMILIES.has(shader.family) || entry.blend === 'additive') {
			looks[entry.id] = emptyLook({ drawn: false });
			continue;
		}
		looks[entry.id] = lookOf(entry, shader);
	}
	return looks;
};

const lookOf = (entry: ReadyMaterial, shader: ShaderEntry): MaterialLook => {
	const look = emptyLook({ drawn: true });
	const family = shader.family;
	const foliage = FOLIAGE_FAMILIES.has(family);
	const params = look.params;

	// the slots: HLOD normal maps aren't tangent-space maps we understand yet, and the MRO map is only
	// sampled where the material's layout uses it
	const used = [
		true,
		family !== 'hlod',
		entry.usesMro,
		entry.keywords.some((k) => k.startsWith('_EMISSIVE')),
	];
	SLOTS.forEach((name, i) => {
		const slot = entry.slots[name];
		if (slot === undefined || !used[i] || slot.uv !== 0) {
			return;
		}
		look.textures[i] = slot.texture;
		look.uvScales[i] = Math.max(Math.abs(slot.scale[0]), Math.abs(slot.scale[1]), 1e-3);
		look.flags |= SLOT_FLAGS[i];
		params.set([...slot.scale, ...slot.offset], LookRow.uv + i * 4);
	});

	if (entry.normalLayout === 'RAG') {
		look.flags |= LookFlags.NormalRag;
	} else if (entry.normalLayout === 'RG' || foliage) {
		look.flags |= LookFlags.NormalRoughness;
	}
	if (foliage) {
		look.flags |= LookFlags.Foliage;
	}

	// base colour: brightened, then covered by the tint
	{
		const tint = colourOf(entry, shader, '_BaseColor');
		const cover = floatOf(entry, shader, '_BaseColorTintCover', 0);
		const brighter = floatOf(entry, shader, '_BaseColorBrighterScale', 1);
		const colour = tint === undefined ? [1, 1, 1] : linearRgb(tint);
		params.set([...colour, entry.alphaClip ?? -1], LookRow.tint);
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

	// emission: the map times `_EmissiveColor` (HDR, authored gamma-encoded)
	{
		const emissive = colourOf(entry, shader, '_EmissiveColor');
		if (look.textures[3] >= 0 && emissive !== undefined) {
			params.set(linearRgb(emissive), LookRow.emissive);
		}
	}
	return look;
};
