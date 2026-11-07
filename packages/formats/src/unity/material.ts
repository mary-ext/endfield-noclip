/**
 * Unity `Material` (class 21) records and `Shader` summaries: faithful copies of the serialized properties.
 * what they mean for drawing is the extractor's `game/materials/material-classify.ts`.
 */

import { FormatError } from '../binary/binary-reader.ts';

import type { TypeTreeObject } from './type-tree.ts';
import {
	arrayField,
	asPPtr,
	isObject,
	mapEntries,
	numberField,
	objectField,
	optionalNumberField,
	type PPtr,
	pptrField,
	stringField,
} from './values.ts';

// #region record

/** one `m_TexEnvs` entry */
export interface MaterialTextureSlot {
	/** `null` when the slot is empty (the shader default applies) */
	texture: PPtr | null;
	scale: [number, number];
	offset: [number, number];
	/** HGRP's per-slot UV channel (`m_UVSetIndex`), 0 when absent */
	uvSet: number;
}

/** a material's serialized state */
export interface MaterialRecord {
	name: string;
	shader: PPtr;
	/** enabled keywords (`m_ValidKeywords`, or the space-separated `m_ShaderKeywords` of older layouts) */
	keywords: string[];
	/** keywords the material lists but its shader doesn't declare */
	invalidKeywords: string[];
	/** `m_CustomRenderQueue`; -1 means the shader's own queue */
	customRenderQueue: number;
	/** `stringTagMap`, e.g. `RenderType` */
	tags: Record<string, string>;
	disabledPasses: string[];
	textures: Record<string, MaterialTextureSlot>;
	floats: Record<string, number>;
	colors: Record<string, [number, number, number, number]>;
	ints: Record<string, number>;
}

/**
 * @param material a decoded `Material` object
 * @returns its record
 * @throws {FormatError} if the object doesn't have the Material shape
 */
export const parseMaterial = (material: TypeTreeObject): MaterialRecord => {
	const name = stringField(material, 'm_Name');
	const properties = objectField(material, 'm_SavedProperties');

	let keywords: string[] = [];
	let invalidKeywords: string[] = [];
	if (Object.hasOwn(material, 'm_ValidKeywords')) {
		keywords = arrayField(material, 'm_ValidKeywords').map(String);
		invalidKeywords = Object.hasOwn(material, 'm_InvalidKeywords')
			? arrayField(material, 'm_InvalidKeywords').map(String)
			: [];
	} else if (typeof material.m_ShaderKeywords === 'string') {
		keywords = material.m_ShaderKeywords.split(' ').filter((keyword) => keyword !== '');
	}

	const textures: Record<string, MaterialTextureSlot> = {};
	for (const [slot, value] of mapEntries(properties.m_TexEnvs)) {
		if (typeof slot !== 'string' || !isObject(value)) {
			throw new FormatError(`material ${name} has a malformed m_TexEnvs entry`);
		}
		const texture = asPPtr(value.m_Texture);
		const scale = objectField(value, 'm_Scale');
		const offset = objectField(value, 'm_Offset');
		textures[slot] = {
			texture: texture.pathId === 0n ? null : texture,
			scale: [numberField(scale, 'x'), numberField(scale, 'y')],
			offset: [numberField(offset, 'x'), numberField(offset, 'y')],
			uvSet: optionalNumberField(value, 'm_UVSetIndex') ?? 0,
		};
	}

	const floats = numericMap(properties.m_Floats, name, 'm_Floats');
	const ints = Object.hasOwn(properties, 'm_Ints') ? numericMap(properties.m_Ints, name, 'm_Ints') : {};

	const colors: Record<string, [number, number, number, number]> = {};
	for (const [key, value] of mapEntries(properties.m_Colors)) {
		if (typeof key !== 'string' || !isObject(value)) {
			throw new FormatError(`material ${name} has a malformed m_Colors entry`);
		}
		colors[key] = [
			numberField(value, 'r'),
			numberField(value, 'g'),
			numberField(value, 'b'),
			numberField(value, 'a'),
		];
	}

	const tags: Record<string, string> = {};
	if (Object.hasOwn(material, 'stringTagMap')) {
		for (const [key, value] of mapEntries(material.stringTagMap)) {
			if (typeof key === 'string' && typeof value === 'string') {
				tags[key] = value;
			}
		}
	}

	return {
		name,
		shader: pptrField(material, 'm_Shader'),
		keywords,
		invalidKeywords,
		customRenderQueue: optionalNumberField(material, 'm_CustomRenderQueue') ?? -1,
		tags,
		disabledPasses: Object.hasOwn(material, 'disabledShaderPasses')
			? arrayField(material, 'disabledShaderPasses').map(String)
			: [],
		textures,
		floats,
		colors,
		ints,
	};
};

const numericMap = (value: TypeTreeObject[string] | undefined, name: string, field: string) => {
	const out: Record<string, number> = {};
	for (const [key, number] of mapEntries(value)) {
		if (typeof key !== 'string' || typeof number !== 'number') {
			throw new FormatError(`material ${name} has a malformed ${field} entry`);
		}
		out[key] = number;
	}
	return out;
};

// #endregion

// #region shader

/** what a material needs to know about its shader */
export interface ShaderSummary {
	/** e.g. `HGRP/Lit` */
	name: string;
	/** the first subshader's `Queue` tag resolved to a number, or `undefined` without one */
	renderQueue: number | undefined;
	/** the first subshader's tags */
	tags: Record<string, string>;
	/** declared properties (`m_PropInfo`), in declaration order */
	properties: ShaderProperty[];
}

/** Unity `SerializedPropertyType` */
export const ShaderPropertyType = {
	Color: 0,
	Vector: 1,
	Float: 2,
	Range: 3,
	Texture: 4,
	Int: 5,
} as const;

/** Unity `SerializedPropertyFlags` bits used here */
export const ShaderPropertyFlags = {
	/** `[Normal]`: the texture is a tangent-space normal map */
	Normal: 1 << 3,
	/** `[HDR]` */
	Hdr: 1 << 4,
	/** `[Gamma]`: a float or vector Unity converts from gamma to linear in linear-space projects */
	Gamma: 1 << 5,
} as const;

/** a declared shader property */
export interface ShaderProperty {
	name: string;
	/** {@link ShaderPropertyType} */
	type: number;
	/** `SerializedPropertyFlags` */
	flags: number;
	/** default value; floats use the first component */
	default: [number, number, number, number];
	/** for textures: the built-in default (`white`, `black`, `gray`, `bump`, …), else empty */
	defaultTexture: string;
}

const QUEUE_NAMES: Record<string, number> = {
	Background: 1000,
	Geometry: 2000,
	AlphaTest: 2450,
	GeometryLast: 2500,
	Transparent: 3000,
	Overlay: 4000,
};

/**
 * @param queue a ShaderLab `Queue` tag, e.g. `Transparent+1`
 * @returns the numeric queue, or `undefined` if unparseable
 */
export const parseQueueTag = (queue: string): number | undefined => {
	const match = /^\s*([A-Za-z]+)?\s*([+-]\s*\d+)?\s*$/.exec(queue);
	if (match === null) {
		return Number.isFinite(Number(queue)) ? Number(queue) : undefined;
	}
	const [, base, delta] = match;
	if (base === undefined) {
		return delta === undefined ? undefined : Number(delta.replaceAll(' ', ''));
	}
	const value = QUEUE_NAMES[base];
	return value === undefined
		? undefined
		: value + (delta === undefined ? 0 : Number(delta.replaceAll(' ', '')));
};

/**
 * @param parsedForm a Shader's `m_ParsedForm` (`SerializedShader`)
 * @returns its name, first-subshader tags and declared properties
 */
export const summarizeShader = (parsedForm: TypeTreeObject): ShaderSummary => {
	const tags: Record<string, string> = {};
	const [subShader] = arrayField(parsedForm, 'm_SubShaders');
	if (isObject(subShader) && isObject(subShader.m_Tags)) {
		for (const [key, value] of mapEntries(subShader.m_Tags.tags)) {
			if (typeof key === 'string' && typeof value === 'string') {
				tags[key] = value;
			}
		}
	}
	const properties: ShaderProperty[] = [];
	const propInfo = parsedForm.m_PropInfo;
	if (isObject(propInfo) && Object.hasOwn(propInfo, 'm_Props')) {
		for (const value of arrayField(propInfo, 'm_Props')) {
			if (!isObject(value)) {
				continue;
			}
			const texture = value.m_DefTexture;
			properties.push({
				name: stringField(value, 'm_Name'),
				type: numberField(value, 'm_Type'),
				flags: numberField(value, 'm_Flags'),
				default: [
					numberField(value, 'm_DefValue[0]'),
					numberField(value, 'm_DefValue[1]'),
					numberField(value, 'm_DefValue[2]'),
					numberField(value, 'm_DefValue[3]'),
				],
				defaultTexture: isObject(texture) ? stringField(texture, 'm_DefaultName') : '',
			});
		}
	}
	return {
		name: stringField(parsedForm, 'm_Name'),
		renderQueue: tags.Queue === undefined ? undefined : parseQueueTag(tags.Queue),
		tags,
		properties,
	};
};

// #endregion
