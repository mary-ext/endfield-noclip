import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { StringPathHashTable } from './string-path-hash.ts';

/** builds a StringPathHash table the way the game lays it out: slot = hash mod count */
const build = (pairs: [bigint, string][]): Uint8Array => {
	const count = pairs.length;
	const stringsOffset = 8 + 24 * count;
	const strings = pairs.map(([, path]) => {
		const bytes = new Uint8Array(4 + path.length * 2 + 2);
		const view = new DataView(bytes.buffer);
		view.setUint32(0, path.length * 2, true);
		for (let i = 0; i < path.length; i++) {
			view.setUint16(4 + i * 2, path.charCodeAt(i), true);
		}
		return bytes;
	});
	const out = new Uint8Array(stringsOffset + strings.reduce((sum, s) => sum + s.length, 0));
	const view = new DataView(out.buffer);
	view.setUint32(0, stringsOffset, true);
	view.setUint32(4, count, true);

	const relative: number[] = [];
	let cursor = 0;
	for (const s of strings) {
		out.set(s, stringsOffset + cursor);
		relative.push(cursor);
		cursor += s.length;
	}

	// group buckets by slot, then lay them out contiguously after the slot table
	const bySlot = new Map<number, number[]>();
	pairs.forEach(([hash], i) => {
		const slot = Number(hash % BigInt(count));
		bySlot.set(slot, [...(bySlot.get(slot) ?? []), i]);
	});
	let bucket = 8 + 8 * count;
	for (const [slot, members] of bySlot) {
		view.setUint32(8 + slot * 8, bucket, true);
		view.setUint32(8 + slot * 8 + 4, members.length, true);
		for (const i of members) {
			view.setBigUint64(bucket + 4, pairs[i][0], true);
			view.setUint32(bucket + 12, relative[i], true);
			bucket += 16;
		}
	}
	return out;
};

test('lookup finds paths through their slot', () => {
	const table = new StringPathHashTable(
		build([
			[0x10n, 'Data/a.bytes'],
			[0x13n, 'assets/b.mat'],
			[0xffff_ffff_ffff_fff0n, 'assets/c.fbx##c'],
		]),
	);
	assert.equal(table.count, 3);
	assert.equal(table.lookup(0x10n), 'Data/a.bytes');
	assert.equal(table.lookup(0x13n), 'assets/b.mat');
	assert.equal(table.lookup(0xffff_ffff_ffff_fff0n), 'assets/c.fbx##c');
	assert.equal(table.lookup(0x11n), undefined);
	assert.equal([...table.entries()].length, 3);
});

test('lookup reports collisions as ambiguous', () => {
	const table = new StringPathHashTable(
		build([
			[7n, 'x'],
			[7n, 'y'],
		]),
	);
	assert.deepEqual(table.lookupAll(7n), ['x', 'y']);
	assert.equal(table.lookup(7n), undefined);
});

test('entriesWithByteLength yields only paths of that length', () => {
	const table = new StringPathHashTable(
		build([
			[1n, 'ab'],
			[2n, 'abcd'],
			[3n, 'cd'],
		]),
	);
	assert.deepEqual(
		[...table.entriesWithByteLength(4)].toSorted(([a], [b]) => Number(a - b)),
		[
			[1n, 'ab'],
			[3n, 'cd'],
		],
	);
	assert.deepEqual([...table.entriesWithByteLength(6)], []);
});

test('reports buckets outside the file as format errors', () => {
	const bytes = build([[1n, 'x']]);
	new DataView(bytes.buffer).setUint32(8, 0xffff, true);
	assert.throws(() => new StringPathHashTable(bytes).lookup(1n), FormatError);
});

test('rejects an inconsistent header', () => {
	const bytes = build([[1n, 'x']]);
	new DataView(bytes.buffer).setUint32(0, 9, true);
	assert.throws(() => new StringPathHashTable(bytes), FormatError);
});
