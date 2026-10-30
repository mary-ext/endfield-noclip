import {
	type MaterialClassification,
	type MaterialRecord,
	ShaderPropertyFlags,
	ShaderPropertyType,
	type ShaderSummary,
} from '@endfield-noclip/formats/unity/material';
import type {
	ReadyMaterial,
	ShaderEntry,
	ShaderFamily,
	TextureSlot,
} from '@endfield-noclip/package-format/format';

// material table rows: a shader table holding each shader's declared property defaults, and per material only
// what differs from them. Unity keeps stale properties from earlier shaders in a material; undeclared ones are
// dropped.

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
		const key = JSON.stringify(entry);
		let id = this.#ids.get(key);
		if (id === undefined) {
			id = this.shaders.length;
			this.shaders.push(entry);
			this.#ids.set(key, id);
		}
		return { id, entry: this.shaders[id] };
	}
}

/** slot names treated as normal maps when the shader doesn't flag them `[Normal]` */
const NORMAL_SLOT = /normal|bump/i;

/** a material converted for the table */
export interface ConvertedMaterial {
	material: Omit<ReadyMaterial, 'id' | 'status'>;
	/** the lowest UV set a bound normal map samples, or `null` without one; meshes drawn with it get tangents */
	normalMapUv: number | null;
}

/**
 * @param record the material's serialized state
 * @param classification its render-state classification
 * @param shader its interned shader
 * @param textureOf texture-table id of a bound slot, or `undefined` if the slot's texture couldn't be located
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
		if (declaresNothing) {
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
		slots[name] = { texture, uv: slot.uvSet, scale: slot.scale, offset: slot.offset };
		if (defaults.normalMaps.includes(name) || NORMAL_SLOT.test(name)) {
			normalMapUv = normalMapUv === null ? slot.uvSet : Math.min(normalMapUv, slot.uvSet);
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
			normalLayout: classification.normalLayout,
			usesMro: classification.usesMro,
			slots,
			floats,
			colors,
			vectors,
		},
		normalMapUv,
	};
};

const sameVector = (a: Vec4, b: Vec4): boolean => a.every((value, i) => Object.is(value, b[i]));
