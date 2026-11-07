import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { packRowColor, packRowCustom, rowSheet } from '../content/instance-rows.ts';

import { sheet } from './test-systems.ts';
import { sheetTile } from './texture-sheet.ts';

describe('sheetTile', () => {
	const r = () => 0.5;
	it('steps through the whole sheet over the lifetime, cycles times', () => {
		assert.equal(sheetTile(sheet(), 0, 0, 0, r, 0), 0);
		assert.equal(sheetTile(sheet(), 0.5, 0, 0, r, 0), 31);
		assert.equal(sheetTile(sheet(), 1, 0, 0, r, 0), 63);
		assert.equal(sheetTile(sheet({ cycles: 2 }), 0.75, 0, 0, r, 0), 31);
	});

	it('steps by frames per second, and along a single row', () => {
		// 30 fps through 64 frames: one second in, the 30th frame, wrapping after 64
		assert.equal(sheetTile(sheet({ frameOverTime: null }), 0, 1, 0, r, 0), 30);
		assert.equal(sheetTile(sheet({ frameOverTime: null }), 0, 3, 0, r, 0), 90 % 64);
		assert.equal(sheetTile(sheet({ rows: { kind: 'fixed', row: 2 } }), 0.5, 0, 0, r, 0), 2 * 8 + 3);
		assert.equal(sheetTile(sheet({ rows: { kind: 'mesh' } }), 0, 0, 0, r, 1), 8);
		assert.equal(sheetTile(sheet({ rows: { kind: 'random' } }), 0, 0, 0, r, 0), 4 * 8);
	});

	it('packs into the row sheet word, and colours and custom data into theirs', () => {
		const sheetWord = rowSheet([8, 4], 63, 1);
		assert.equal((sheetWord & 63) + 1, 8);
		assert.equal(((sheetWord >>> 6) & 63) + 1, 4);
		assert.equal((sheetWord >>> 12) & 0xfff, 63);
		assert.equal(sheetWord >>> 24, 1);
		assert.equal(rowSheet([1, 1], 0, 0), 0);
		assert.equal(packRowColor([1, 0, 0.5, 0.25]), (64 << 24) | (128 << 16) | 255);
		// f16 pairs, low half first: 1.0 is 0x3c00, 0.5 is 0x3800, 2.0 is 0x4000
		assert.deepEqual(packRowCustom([1, 0.5, 2, 0]), [0x3800_3c00, 0x4000]);
	});
});
