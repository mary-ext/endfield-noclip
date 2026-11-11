import {
	type MaterialRecord,
	ShaderPropertyFlags,
	ShaderPropertyType,
	type ShaderSummary,
} from '@endfield-noclip/formats/unity/material';
import type { TextureSlot } from '@endfield-noclip/package-format/materials';

import type { MaterialClassification } from '../../game/materials/material-classify.ts';
import {
	type MaterialValues,
	PER_DRAW_EMISSIVE_ALBEDO,
	type ShaderEntry,
	type ShaderFamily,
} from '../../game/materials/material-values.ts';

// converted materials, which the surface describers read: a shader table holding each shader's declared
// property defaults, and per material only what differs from them. Unity keeps stale properties from earlier
// shaders in a material; undeclared ones are dropped.

type Vec4 = [number, number, number, number];

/** a shader as interned in a {@link ShaderTable} */
export interface InternedShader {
	id: number;
	entry: ShaderEntry;
}

/** shaders deduplicated by name and declared properties */
export class ShaderTable {
	readonly shaders: ShaderEntry[] = [];
	readonly #ids = new Map<string, number>();

	/**
	 * @param summary the shader's summary
	 * @param family its family
	 * @returns its index and entry
	 */
	intern(summary: ShaderSummary, family: ShaderFamily): InternedShader {
		const entry: ShaderEntry = {
			name: summary.name,
			family,
			floats: {},
			colors: {},
			vectors: {},
			textures: {},
			normalMaps: [],
		};
		for (const property of summary.properties) {
			switch (property.type) {
				case ShaderPropertyType.Float:
				case ShaderPropertyType.Range:
				case ShaderPropertyType.Int: {
					entry.floats[property.name] = property.default[0];
					break;
				}
				case ShaderPropertyType.Color: {
					entry.colors[property.name] = property.default;
					break;
				}
				case ShaderPropertyType.Vector: {
					entry.vectors[property.name] = property.default;
					break;
				}
				case ShaderPropertyType.Texture: {
					entry.textures[property.name] = property.defaultTexture;
					if ((property.flags & ShaderPropertyFlags.Normal) !== 0) {
						entry.normalMaps.push(property.name);
					}
					break;
				}
			}
		}
		const id = this.#ids.getOrInsertComputed(JSON.stringify(entry), () => this.shaders.push(entry) - 1);
		return { id, entry: this.shaders[id] };
	}
}

/**
 * slot names treated as normal maps when the shader doesn't flag them `[Normal]`, a heuristic
 * (docs/package-format.md, geometry); a normal-mapped material's meshes get tangents
 */
const NORMAL_SLOT = /normal|bump/i;

/**
 * the floats `HGRP/Lit` picks each map's UV set with, in place of the slot's `m_UVSetIndex` (see
 * `docs/game-data/materials.md#lit-layers`). the shaders sharing Lit's surface ({@link LIT_UV_SET_FAMILIES})
 * declare the same floats; effect shaders declare a `_MaskUVSet` of their own, for other slots
 */
const LIT_UV_SET_PROPERTIES: Record<string, string> = {
	_BaseColorMap: '_BaseUVSet',
	_NormalMap: '_BasePbrMapUVSet',
	_MROMap: '_BasePbrMapUVSet',
	_DetailMap: '_DetailUVSet',
	_MaskMap: '_MaskUVSet',
	_EmissiveMap: '_EmissiveUVSet',
};

/** the families whose shaders pick UV sets by {@link LIT_UV_SET_PROPERTIES} */
const LIT_UV_SET_FAMILIES: ReadonlySet<ShaderFamily> = new Set([
	'lit',
	'litTransparent',
	'litEffect',
	'litForward',
	'trunk',
]);

/** a material converted for the table */
export interface ConvertedMaterial {
	material: MaterialValues;
	/** the lowest UV set a bound normal map samples, or `null` without one; meshes drawn with it get tangents */
	normalMapUv: number | null;
}

/**
 * @param record the material's serialized state
 * @param classification its render-state classification
 * @param shader its interned shader
 * @param textureOf the id to record for a bound slot's texture, or `undefined` if it couldn't be located; the
 *   caller may remap ids afterwards (`convertAssets` hands out per-object ids and remaps them to
 *   texture-table ids once textures are deduplicated)
 * @returns the table row, keeping only values that differ from the shader's defaults
 */
export const convertMaterial = (
	record: MaterialRecord,
	classification: MaterialClassification,
	shader: InternedShader,
	textureOf: (slot: string) => number | undefined,
): ConvertedMaterial => {
	const defaults = shader.entry;
	// a shader without property info (none seen) keeps every material value
	const declaresNothing =
		Object.keys(defaults.floats).length +
			Object.keys(defaults.colors).length +
			Object.keys(defaults.vectors).length +
			Object.keys(defaults.textures).length ===
		0;

	const floats: Record<string, number> = {};
	for (const values of [record.floats, record.ints]) {
		for (const [name, value] of Object.entries(values)) {
			const fallback = defaults.floats[name];
			if (declaresNothing || (fallback !== undefined && !Object.is(fallback, value))) {
				floats[name] = value;
			}
		}
	}
	const colors: Record<string, Vec4> = {};
	const vectors: Record<string, Vec4> = {};
	for (const [name, value] of Object.entries(record.colors)) {
		if (declaresNothing || name === PER_DRAW_EMISSIVE_ALBEDO) {
			colors[name] = value;
		} else if (Object.hasOwn(defaults.colors, name)) {
			if (!sameVector(defaults.colors[name], value)) {
				colors[name] = value;
			}
		} else if (Object.hasOwn(defaults.vectors, name) && !sameVector(defaults.vectors[name], value)) {
			vectors[name] = value;
		}
	}

	const slots: Record<string, TextureSlot> = {};
	let normalMapUv: number | null = null;
	for (const [name, slot] of Object.entries(record.textures).toSorted(([a], [b]) => (a < b ? -1 : 1))) {
		if (slot.texture === null || (!declaresNothing && !Object.hasOwn(defaults.textures, name))) {
			continue;
		}
		const texture = textureOf(name);
		if (texture === undefined) {
			continue;
		}
		let uv = slot.uvSet;
		{
			const property = LIT_UV_SET_FAMILIES.has(defaults.family) ? LIT_UV_SET_PROPERTIES[name] : undefined;
			const fallback = property === undefined ? undefined : defaults.floats[property];
			if (property !== undefined && fallback !== undefined) {
				uv = Math.round(record.floats[property] ?? record.ints[property] ?? fallback);
			}
		}
		slots[name] = { texture, uv, scale: slot.scale, offset: slot.offset };
		if (defaults.normalMaps.includes(name) || NORMAL_SLOT.test(name)) {
			normalMapUv = normalMapUv === null ? uv : Math.min(normalMapUv, uv);
		}
	}

	return {
		material: {
			shader: shader.id,
			keywords: record.keywords,
			renderQueue: classification.renderQueue,
			blend: classification.blend,
			blendFactors: classification.blendFactors,
			alphaClipThreshold: classification.alphaClipThreshold,
			cull: classification.cull,
			zWrite: classification.zWrite,
			baseTextureMapCount: classification.baseTextureMapCount,
			slots,
			floats,
			colors,
			vectors,
		},
		normalMapUv,
	};
};

const sameVector = (a: Vec4, b: Vec4): boolean => a.every((value, i) => Object.is(value, b[i]));
