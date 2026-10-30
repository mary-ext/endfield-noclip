import assert from 'node:assert/strict';
import { it } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import {
	readInteractiveModel,
	readInteractiveTable,
	readInteractiveVariantModels,
} from './interactive-model.ts';

const fixture = (): Uint8Array => {
	const bytes: number[] = [];
	const u8 = (value: number): void => {
		bytes.push(value);
	};
	const i32 = (value: number): void => {
		const data = new DataView(new ArrayBuffer(4));
		data.setInt32(0, value, true);
		bytes.push(...new Uint8Array(data.buffer));
	};
	const f32 = (value: number): void => {
		const data = new DataView(new ArrayBuffer(4));
		data.setFloat32(0, value, true);
		bytes.push(...new Uint8Array(data.buffer));
	};
	u8(26);
	i32(0);
	i32(0);
	i32(0);
	i32(0);
	i32(4);
	u8(150);
	u8(0);
	u8(250);
	u8(62);
	u8(1);
	u8(4);
	f32(1);
	u8(0);
	i32(1);
	f32(2);
	u8(56);
	u8(1);
	i32(1);
	u8(2);
	i32(0);
	u8(2);
	i32(7);
	i32(1);
	u8(2);
	i32(0);
	i32(0);
	i32(-2);
	u8(142);
	u8(2);
	i32(0);
	i32(3);
	i32(0);
	i32(1);
	i32(2);
	return Uint8Array.from(bytes);
};

it('reads authored visual forms in list order and preserves a nonzero initial model', () => {
	const data = fixture();
	const strings = ['closed', 'initial', 'expanded'];
	const string = (id: number): string | null => strings[id] ?? null;
	assert.deepEqual(readInteractiveModel(data, string), { id: 'initial', scale: 2, levels: strings });
	assert.throws(() => readInteractiveModel(data.subarray(0, data.length - 1), string));
	const unsupported = data.slice();
	unsupported[40] = 255;
	assert.throws(() => readInteractiveModel(unsupported, string));
});

const variantFixture = (): Uint8Array => {
	const bytes: number[] = [];
	const u8 = (value: number): void => {
		bytes.push(value);
	};
	const i32 = (value: number): void => {
		const data = new DataView(new ArrayBuffer(4));
		data.setInt32(0, value, true);
		bytes.push(...new Uint8Array(data.buffer));
	};
	// undecoded components and action graphs before the table, including a decoy header
	bytes.push(26, 1, 2, 0, 0, 0, 0, 0, 0, 0, 255, 7);
	u8(1);
	i32(2);
	for (const [key, model] of [
		[0, 2],
		[1, -1],
	]) {
		i32(key);
		u8(14);
		bytes.push(0, 0, 0, 0, 0, 0, 0, 0);
		u8(255);
		u8(255);
		bytes.push(...Array.from({ length: 16 }, () => 0));
		i32(0);
		bytes.push(...Array.from({ length: 16 }, () => 0));
		i32(-1);
		u8(0);
		u8(0);
		i32(0);
		u8(2);
		u8(model === -1 ? 0 : 1);
		i32(model);
		u8(2);
		u8(1);
		i32(0);
		u8(255);
	}
	i32(-1);
	u8(0);
	u8(0);
	return Uint8Array.from(bytes);
};

it('finds the variant table from the end of the template and reads model overrides', () => {
	const strings = ['int_variant_a', 'int_variant_b', 'model_a'];
	// like the install's pool, ids outside it throw
	const string = (id: number): string | null => {
		if (id === -1) {
			return null;
		}
		const value = strings[id];
		if (value === undefined) {
			throw new FormatError(`string id ${id} is not in the pool`);
		}
		return value;
	};
	const data = variantFixture();
	const variants = new Set(['int_variant_a', 'int_variant_b']);
	assert.deepEqual(
		readInteractiveVariantModels(data, string, variants),
		new Map([
			['int_variant_a', 'model_a'],
			['int_variant_b', null],
		]),
	);
	assert.deepEqual(readInteractiveVariantModels(data, string, new Set()), new Map());
	assert.throws(() => readInteractiveVariantModels(data, string, new Set(['int_variant_a'])));
	assert.throws(() => readInteractiveVariantModels(data.subarray(0, data.length - 1), string, variants));
});

it('reads the interactive table', () => {
	const strings = ['int_door', 'data_int_door.json', 'int_door_red'];
	const string = (id: number): string | null => strings[id] ?? null;
	const data = new Uint8Array([2, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0]);
	assert.deepEqual(readInteractiveTable(data, string), {
		templatePaths: new Map([['int_door', 'data_int_door.json']]),
		templates: new Map([['int_door_red', 'int_door']]),
	});
	assert.throws(() => readInteractiveTable(data.subarray(0, data.length - 1), string));
});
