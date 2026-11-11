import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';
import { FlatBufferWriter as Writer } from '../binary/flatbuffer-writer.ts';

import { ValueCode } from './mono-objects.ts';
import { hlodLink, parseStreamingChunk } from './streaming-chunk-data.ts';

// ids as map02 stores them: an HLOD1 cluster, an HLOD0 cluster under it and a rock under that
const HLOD1 = 295847446;
const HLOD0 = 384662047;
const ROCK = (2 << 27) | 0x19b34e6;
const DECAL = (2 << 27) | 0x77;

/** a Streaming chunk of kind-2 rows, each with one property under `0xff000000` */
const buildStreaming = (
	rows: { id: number; link: [number, number, number, number] | null }[],
): Uint8Array => {
	const w = new Writer();
	const fields = w.chunkRoot();
	w.u32s(
		fields[3],
		rows.map((row) => row.id),
	);
	w.u8s(
		fields[4],
		rows.map(() => 2),
	);
	const slots = w.offsets(fields[5], rows.length);
	rows.forEach(({ link }, i) => {
		const row = w.table([4, 4, 4, 4, 16, 4]);
		w.link(slots[i], row.at);
		const table = w.table([0, 0, 0, 4, 4, 4]);
		w.link(row.fields[3], table.at);
		w.u32s(table.fields[3], [0xff000000]);
		w.u8s(table.fields[4], [link === null ? ValueCode.Asset : ValueCode.Int4]);
		const [slot] = w.offsets(table.fields[5], 1);
		const value = w.reserve(16, 4);
		if (link === null) {
			// the same key is a decal's cube mesh
			w.view.setBigUint64(value, 0x1234n, true);
		} else {
			link.forEach((word, k) => w.view.setInt32(value + k * 4, word | 0, true));
		}
		w.link(slot, value);
	});
	return w.finish();
};

test('hlodLink reads a cluster’s parent and child count, and a child’s index', () => {
	const { records } = parseStreamingChunk(
		buildStreaming([
			{ id: HLOD1, link: [HLOD1, 0, 2, -1] },
			{ id: HLOD0, link: [HLOD0, HLOD1, 1, 1] },
			{ id: ROCK, link: [ROCK, HLOD0, 0, 0] },
		]),
	);
	assert.deepEqual(records.map(hlodLink), [
		{ parent: null, childCount: 2, index: -1 },
		{ parent: HLOD1, childCount: 1, index: 1 },
		{ parent: HLOD0, childCount: 0, index: 0 },
	]);
});

test('hlodLink is null for a zeroed link and for another archetype’s value under the key', () => {
	const { records } = parseStreamingChunk(
		buildStreaming([
			{ id: HLOD0, link: [0, 0, 0, 0] },
			{ id: DECAL, link: null },
		]),
	);
	assert.deepEqual(records.map(hlodLink), [null, null]);
});

test('hlodLink rejects a link naming another entity', () => {
	const { records } = parseStreamingChunk(buildStreaming([{ id: HLOD0, link: [HLOD1, 0, 1, -1] }]));
	assert.throws(() => hlodLink(records[0]), FormatError);
});
