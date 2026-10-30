import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	classifyHgrpMaterial,
	type MaterialRecord,
	ShaderPropertyFlags,
	ShaderPropertyType,
	type ShaderProperty,
	type ShaderSummary,
} from '@endfield-noclip/formats/unity/material';

import { convertMaterial, ShaderTable } from './materials.ts';

const property = (name: string, type: number, value: number[] | string, flags = 0): ShaderProperty => ({
	name,
	type,
	flags,
	default: typeof value === 'string' ? [0, 0, 0, 0] : [value[0], value[1] ?? 0, value[2] ?? 0, value[3] ?? 0],
	defaultTexture: typeof value === 'string' ? value : '',
});

const shader: ShaderSummary = {
	name: 'HGRP/Lit',
	renderQueue: undefined,
	tags: {},
	properties: [
		property('_CullMode', ShaderPropertyType.Float, [2]),
		property('_Metallic', ShaderPropertyType.Range, [0]),
		property('_Steps', ShaderPropertyType.Int, [3]),
		property('_BaseColor', ShaderPropertyType.Color, [1, 1, 1, 1]),
		property('_WindDir', ShaderPropertyType.Vector, [0, 0, 1, 0]),
		property('_BaseColorMap', ShaderPropertyType.Texture, 'white'),
		property('_NormalMap', ShaderPropertyType.Texture, 'bump', ShaderPropertyFlags.Normal),
		property('_MROMap', ShaderPropertyType.Texture, 'white'),
	],
};

const pptr = { fileId: 0, pathId: 1n };
const record: MaterialRecord = {
	name: 'M_test',
	shader: pptr,
	keywords: ['_NORMALMAP'],
	invalidKeywords: [],
	customRenderQueue: -1,
	tags: {},
	disabledPasses: [],
	textures: {
		_BaseColorMap: { texture: pptr, scale: [2, 2], offset: [0, 0.5], uvSet: 0 },
		_NormalMap: { texture: pptr, scale: [1, 1], offset: [0, 0], uvSet: 1 },
		_MROMap: { texture: null, scale: [1, 1], offset: [0, 0], uvSet: 0 },
		// a stale slot from an earlier shader
		_OldMap: { texture: pptr, scale: [1, 1], offset: [0, 0], uvSet: 0 },
	},
	floats: { _CullMode: 2, _Metallic: 0.25, _Stale: 9 },
	colors: { _BaseColor: [1, 1, 1, 1], _WindDir: [1, 0, 0, 0] },
	ints: { _Steps: 5 },
};

describe('ShaderTable', () => {
	it('dedupes equal shaders and records defaults by property type', () => {
		const table = new ShaderTable();
		const a = table.intern(shader, 'lit');
		assert.equal(table.intern({ ...shader }, 'lit').id, a.id);
		assert.notEqual(table.intern({ ...shader, properties: shader.properties.slice(1) }, 'lit').id, a.id);
		assert.deepEqual(a.entry, {
			name: 'HGRP/Lit',
			family: 'lit',
			floats: { _CullMode: 2, _Metallic: 0, _Steps: 3 },
			colors: { _BaseColor: [1, 1, 1, 1] },
			vectors: { _WindDir: [0, 0, 1, 0] },
			textures: { _BaseColorMap: 'white', _NormalMap: 'bump', _MROMap: 'white' },
			normalMaps: ['_NormalMap'],
		});
	});
});

describe('convertMaterial', () => {
	it('keeps declared overrides and bound slots only', () => {
		const table = new ShaderTable();
		const interned = table.intern(shader, 'lit');
		const ids: Record<string, number> = { _BaseColorMap: 7, _NormalMap: 8, _OldMap: 9 };
		const { material, normalMapUv } = convertMaterial(
			record,
			classifyHgrpMaterial(record, shader),
			interned,
			(slot) => ids[slot],
		);
		assert.equal(material.shader, interned.id);
		assert.deepEqual(material.floats, { _Metallic: 0.25, _Steps: 5 });
		assert.deepEqual(material.colors, {});
		assert.deepEqual(material.vectors, { _WindDir: [1, 0, 0, 0] });
		assert.deepEqual(material.slots, {
			_BaseColorMap: { texture: 7, uv: 0, scale: [2, 2], offset: [0, 0.5] },
			_NormalMap: { texture: 8, uv: 1, scale: [1, 1], offset: [0, 0] },
		});
		assert.equal(normalMapUv, 1);
		assert.equal(material.cull, 'back');
		assert.equal(material.blend, 'opaque');
	});

	it('takes a Lit map’s UV set from its UV-set property over the slot’s index', () => {
		const withUvSets: ShaderSummary = {
			...shader,
			properties: [
				...shader.properties,
				property('_BaseUVSet', ShaderPropertyType.Float, [0]),
				property('_BasePbrMapUVSet', ShaderPropertyType.Float, [0]),
			],
		};
		const interned = new ShaderTable().intern(withUvSets, 'lit');
		const { material, normalMapUv } = convertMaterial(
			{ ...record, floats: { ...record.floats, _BaseUVSet: 1 } },
			classifyHgrpMaterial(record, withUvSets),
			interned,
			() => 7,
		);
		// the property's default wins over the slot's index too
		assert.deepEqual(
			Object.fromEntries(Object.entries(material.slots).map(([name, slot]) => [name, slot.uv])),
			{ _BaseColorMap: 1, _NormalMap: 0 },
		);
		assert.equal(normalMapUv, 0);
	});

	it('drops slots whose texture couldn’t be located', () => {
		const interned = new ShaderTable().intern(shader, 'lit');
		const { material, normalMapUv } = convertMaterial(
			record,
			classifyHgrpMaterial(record, shader),
			interned,
			() => undefined,
		);
		assert.deepEqual(material.slots, {});
		assert.equal(normalMapUv, null);
	});
});
