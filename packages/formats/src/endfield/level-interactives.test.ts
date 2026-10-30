import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { readLevelInteractives, UnsupportedLevelData } from './level-interactives.ts';

const fixture = (options: { gated: boolean; unsupported: boolean; areas: boolean }): Uint8Array => {
	const bytes = new Uint8Array(1024);
	const view = new DataView(bytes.buffer);
	let at = 0;
	const u8 = (v: number): void => {
		view.setUint8(at++, v);
	};
	const i32 = (v: number): void => {
		view.setInt32(at, v, true);
		at += 4;
	};
	const u64 = (v: bigint): void => {
		view.setBigUint64(at, v, true);
		at += 8;
	};
	const f32 = (v: number): void => {
		view.setFloat32(at, v, true);
		at += 4;
	};
	u8(43);
	i32(0);
	i32(0);
	i32(0);
	u8(255);
	u8(255);
	i32(options.unsupported ? 1 : 0);
	i32(0);
	i32(0);
	i32(0);
	for (let i = 0; i < 5; i++) {
		i32(0);
	}
	u8(1);
	i32(0);
	i32(0);
	u8(4);
	for (let i = 0; i < 3; i++) {
		i32(0);
	}
	if (options.areas) {
		// a scene toast (union tag 14) with two titles and a null one, then an AI bark block (tag 2)
		i32(2);
		u8(14);
		u8(6);
		i32(-1);
		u8(255);
		u8(1);
		i32(8);
		i32(0);
		i32(232);
		u8(1);
		i32(8);
		u8(2);
		u8(1);
		u8(1);
	} else {
		i32(0);
	}
	i32(0);
	i32(0);
	i32(2);
	for (let n = 0; n < 2; n++) {
		u8(25);
		i32(0);
		u64(0n);
		i32(n);
		u64(0n);
		i32(7);
		i32(32);
		u8(0);
		u8(0);
		u64(100n + BigInt(n));
		u8(0);
		for (const f of [1, 2, 3, 0, 90, 0, 1, 1, 1]) {
			f32(f);
		}
		u8(0);
		i32(0);
		i32(-1);
		i32(0);
		u8(0);
		u8(0);
		u8(1);
		i32(-1);
		i32(0);
		f32(0);
		if (options.gated && n === 0) {
			u8(18);
			u8(3);
			i32(0);
			i32(3);
			i32(8);
		} else {
			u8(255);
		}
		i32(0);
	}
	return bytes.slice(0, at);
};

const string = (id: number): string => {
	assert.ok(id === 7 || id === 8);
	return id === 7 ? 'test_facility' : 'test_quest';
};

test('reads the complete interactive list through nullable properties and quest locks', () => {
	const rows = readLevelInteractives(fixture({ gated: true, unsupported: false, areas: false }), string);
	assert.equal(rows.length, 2);
	assert.deepEqual(
		rows.map((r) => [r.id, r.createState]),
		[
			[100n, 0],
			[101n, 1],
		],
	);
	assert.deepEqual(rows[0].position, [1, 2, 3]);
	assert.deepEqual(rows[0].rotation, [0, 90, 0]);
	assert.equal(rows[0].template, 'test_facility');
});

test('an unsupported prefix cannot be bypassed to find a plausible placement later in the file', () => {
	assert.throws(
		() => readLevelInteractives(fixture({ gated: false, unsupported: true, areas: false }), string),
		UnsupportedLevelData,
	);
});

test('a truncated second placement rejects the whole list', () => {
	const bytes = fixture({ gated: false, unsupported: false, areas: false });
	assert.throws(() => readLevelInteractives(bytes.subarray(0, bytes.length - 2), string), FormatError);
});

test('reads past scene toast and AI bark function areas', () => {
	const rows = readLevelInteractives(fixture({ gated: false, unsupported: false, areas: true }), string);
	assert.equal(rows.length, 2);
});
