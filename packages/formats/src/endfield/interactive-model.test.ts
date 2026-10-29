import assert from 'node:assert/strict';
import { it } from 'node:test';

import { readInteractiveModel } from './interactive-model.ts';

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
