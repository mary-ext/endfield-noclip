import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';
import { parseStringPoolBlock, StringId, StringPool } from '../hg/string-pool.ts';

import { parseLevelConfig } from './level-config.ts';

const POOL = ['map02/map02_streaming.asset', 'default', 'map02_lv001_art', 'map02_lv001', 'map02'];

/** encodes a LevelConfig whose strings are ids into {@link POOL} */
const encodeLevelConfig = (options: { trailing?: boolean } = {}): Uint8Array => {
	const bytes: number[] = [];
	const view = new DataView(new ArrayBuffer(8));
	const i32 = (value: number): void => {
		view.setInt32(0, value, true);
		bytes.push(...new Uint8Array(view.buffer, 0, 4));
	};
	const f32 = (value: number): void => {
		view.setFloat32(0, value, true);
		bytes.push(...new Uint8Array(view.buffer, 0, 4));
	};
	bytes.push(18, 3);
	i32(0);
	i32(1);
	i32(2);
	i32(StringId.Null);
	bytes.push(0);
	i32(3);
	i32(101);
	bytes.push(0, 1);
	i32(1);
	view.setBigUint64(0, 0xdead_beef_0000_0001n, true);
	bytes.push(...new Uint8Array(view.buffer, 0, 8));
	i32(2);
	i32(-10);
	i32(-16);
	i32(-9);
	i32(-16);
	i32(4);
	[-1203, 231, -1961, 0, 90, 0, -1280, -2048, -512, -896].forEach(f32);
	i32(1);
	[1, 2, 3].forEach(f32);
	i32(StringId.Empty);
	i32(StringId.Null);
	if (options.trailing) {
		bytes.push(0);
	}
	return new Uint8Array(bytes);
};

test('parseLevelConfig decodes every member with pooled strings', () => {
	const pool = new StringPool([POOL]);
	const config = parseLevelConfig(encodeLevelConfig(), (id) => pool.get(id));
	assert.equal(config.id, 'map02_lv001');
	assert.equal(config.idNum, 101);
	assert.equal(config.mapId, 'map02');
	assert.deepEqual(config.defaultState, {
		exportedSceneConfigPath: 'map02/map02_streaming.asset',
		name: 'default',
		sourceSceneName: 'map02_lv001_art',
	});
	assert.equal(config.dimensionSourceLevelId, null);
	assert.equal(config.isSeamless, true);
	assert.deepEqual(config.levelDataPathHashes, [0xdead_beef_0000_0001n]);
	assert.deepEqual(config.levelGrids, [
		{ x: -10, z: -16 },
		{ x: -9, z: -16 },
	]);
	assert.deepEqual(config.playerInitPos, [-1203, 231, -1961]);
	assert.deepEqual(config.rectRightTop, [-512, -896]);
	assert.equal(config.waterStartAudio, '');
	assert.equal(config.waterStopAudio, null);
});

test('parseLevelConfig requires exact consumption', () => {
	const pool = new StringPool([POOL]);
	assert.throws(
		() => parseLevelConfig(encodeLevelConfig({ trailing: true }), (id) => pool.get(id)),
		FormatError,
	);
});

test('parseStringPoolBlock reads stored and first blocks', () => {
	const strings = ['a', 'héllo', ''];
	const encoded = strings.map((s) => new TextEncoder().encode(s));
	const raw = new Uint8Array(4 + strings.length * 4 + encoded.reduce((sum, e) => sum + 4 + e.length, 0));
	const rawView = new DataView(raw.buffer);
	rawView.setUint32(0, strings.length, true);
	let cursor = 4 + strings.length * 4;
	encoded.forEach((e, i) => {
		rawView.setUint32(4 + i * 4, cursor - (4 + strings.length * 4), true);
		rawView.setUint32(cursor, e.length, true);
		raw.set(e, cursor + 4);
		cursor += 4 + e.length;
	});

	const block = (first: boolean): Uint8Array => {
		const prefix = first ? 4 : 0;
		const out = new Uint8Array(prefix + 24 + raw.length);
		const view = new DataView(out.buffer);
		[0x43505355, 1, 0, strings.length, raw.length, raw.length].forEach((value, i) =>
			view.setUint32(prefix + i * 4, value, true),
		);
		out.set(raw, prefix + 24);
		return out;
	};
	assert.deepEqual(parseStringPoolBlock(block(false), { first: false }), strings);
	assert.deepEqual(parseStringPoolBlock(block(true), { first: true }), strings);
	assert.throws(() => parseStringPoolBlock(block(true), { first: false }), FormatError);

	const pool = new StringPool([strings, ['x']]);
	assert.equal(pool.get(3), 'x');
	assert.throws(() => pool.get(4), FormatError);
});
