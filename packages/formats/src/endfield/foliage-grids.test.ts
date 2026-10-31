import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';
import { FlatBufferWriter as Writer } from '../binary/flatbuffer-writer.ts';

import { FoliageGridType, hasFoliageGrids, readFoliageGrids } from './foliage-grids.ts';

const encoder = new TextEncoder();
const GRID_ID = (4 << 27) | 0x7dda;
const AUDIO_ID = (4 << 27) | 0x7ddb;
const FLT_MAX = 3.4028234663852886e38;

type Value =
	| { code: 2; int: number }
	| { code: 3; uint: number }
	| { code: 14; floats: number[] }
	| { code: 15; hash: bigint; kind: number }
	| { code: 17; bytes: Uint8Array };

/** writes a row's keyed property table and links it from `field` */
const properties = (w: Writer, field: number, entries: [key: number, value: Value][]): void => {
	const table = w.table([0, 0, 0, 4, 4, 4]);
	w.link(field, table.at);
	w.u32s(
		table.fields[3],
		entries.map(([key]) => key),
	);
	w.u8s(
		table.fields[4],
		entries.map(([, value]) => value.code),
	);
	const links = w.offsets(table.fields[5], entries.length);
	entries.forEach(([, value], i) => {
		switch (value.code) {
			case 2:
			case 3: {
				const at = w.reserve(4);
				w.view.setUint32(at, value.code === 2 ? value.int : value.uint, true);
				w.link(links[i], at);
				break;
			}
			case 14: {
				const at = w.reserve(24);
				value.floats.forEach((v, k) => w.view.setFloat32(at + k * 4, v, true));
				w.link(links[i], at);
				break;
			}
			case 15: {
				const at = w.reserve(12);
				w.view.setBigUint64(at, value.hash, true);
				w.view.setUint32(at + 8, value.kind, true);
				w.link(links[i], at);
				break;
			}
			case 17: {
				const outer = w.table([4]);
				w.link(links[i], outer.at);
				const inner = w.table([4]);
				w.link(outer.fields[0], inner.at);
				const vector = w.vector(1, value.bytes.length);
				w.bytes.set(value.bytes, vector.start);
				w.link(inner.fields[0], vector.at);
				break;
			}
		}
	});
};

/** writes the root's object vectors: a grass grid (or the given proxy type) and an audio emitter */
const chunk = (gridType: number, gridProperties: [number, Value][]): Uint8Array => {
	const w = new Writer();
	const fields = w.chunkRoot();
	w.u32s(fields[3], [GRID_ID, AUDIO_ID]);
	w.u8s(fields[4], [3, 3]);
	const rowLinks = w.offsets(fields[5], 2);
	[
		{ name: 'GrassGrid_-1344_-1280#4_7DDA', type: gridType, props: gridProperties },
		{ name: 'AudioEmitter_01#4_7DDB', type: 2, props: [] },
	].forEach((object, i) => {
		const row = w.table([4, 0, 1, 4]);
		w.link(rowLinks[i], row.at);
		const name = encoder.encode(object.name);
		const vector = w.vector(1, name.length);
		w.bytes.set(name, vector.start);
		w.link(row.fields[0], vector.at);
		w.view.setUint8(row.fields[2], object.type);
		properties(w, row.fields[3], object.props);
	});
	return w.finish();
};

/**
 * one archetype of one grass cluster: bounds, two draws (a lit LOD 0 by batch key 0xbeef, a LOD 1 by key
 * 0xcafe) and two instances in a K4 cluster column
 */
const grassArchetype = (options: { drawKey?: number }): { descriptors: Uint8Array; blob: Uint8Array } => {
	const columns: [number, number][] = [
		[0, 4],
		[1, 4],
		[2, 4],
		[3, 4],
		[4, 4],
		[5, 4],
		[9, 68],
		[37, 388],
	];
	const descriptors = new Uint8Array(columns.length * 8);
	const dd = new DataView(descriptors.buffer);
	columns.forEach(([id, stride], i) => {
		dd.setUint16(i * 8, id, true);
		dd.setUint16(i * 8 + 2, stride, true);
	});
	const blob = new Uint8Array(columns.reduce((sum, [, stride]) => sum + stride, 0));
	const view = new DataView(blob.buffer);
	[10, 20, 30, 1, 2, 3].forEach((v, i) => view.setFloat32(i * 4, v, true));
	// draw infos at 24: count, two GrassRendererInfos, then two (max², min²) pairs
	view.setUint32(24, 2, true);
	view.setUint32(28 + 4, options.drawKey ?? 0xbeef, true);
	view.setFloat32(28 + 8, 2, true);
	view.setUint32(28 + 12, 0x3f80000, true);
	view.setUint32(52 + 4, 0xcafe, true);
	view.setUint32(52 + 12, 0x3f80400, true);
	[FLT_MAX, 0.2, 0.2, -0.0002].forEach((v, i) => view.setFloat32(76 + i * 4, v, true));
	// the cluster at 92: count, then column-major matrices translated to (11, 20, 30) and (12, 20, 30)
	view.setUint32(92, 2, true);
	[11, 12].forEach((x, k) => {
		const at = 96 + k * 96;
		[0, 5, 10, 15].forEach((d) => view.setFloat32(at + d * 4, 1, true));
		view.setFloat32(at + 48, x, true);
		view.setFloat32(at + 52, 20, true);
		view.setFloat32(at + 56, 30, true);
	});
	return { descriptors, blob };
};

const grassProperties = (options: { drawKey?: number } = {}): [number, Value][] => {
	const { descriptors, blob } = grassArchetype(options);
	return [
		[0xff000000, { code: 2, int: 1 }],
		[0xff010000, { code: 14, floats: [10, 20, 30, 1, 2, 3] }],
		[0xff020000, { code: 2, int: 1 }],
		[0xff030000, { code: 17, bytes: descriptors }],
		[0xff040000, { code: 17, bytes: blob }],
	];
};

const batchTable: [number, Value][] = [
	[0xff050000, { code: 2, int: 2 }],
	[0xff060000, { code: 3, uint: 0xcafe }],
	[0xff060001, { code: 3, uint: 0xbeef }],
	[0xff070000, { code: 15, hash: 0x111n, kind: 1 }],
	[0xff070001, { code: 15, hash: 0x222n, kind: 1 }],
	[0xff080000, { code: 15, hash: 0x333n, kind: 2 }],
	[0xff080001, { code: 15, hash: 0x444n, kind: 2 }],
	[0xff090000, { code: 2, int: 0 }],
	[0xff090001, { code: 2, int: 1 }],
];

test('readFoliageGrids decodes a grass grid through its batch table', () => {
	const init = chunk(FoliageGridType.Grass, grassProperties());
	const streaming = chunk(FoliageGridType.Grass, batchTable);
	assert.equal(hasFoliageGrids(init), true);
	const grids = readFoliageGrids(init, streaming);
	assert.equal(grids.length, 1);
	const [grid] = grids;
	assert.equal(grid.type, FoliageGridType.Grass);
	assert.equal(grid.levelTag, 4);
	assert.equal(grid.name, 'GrassGrid_-1344_-1280#4_7DDA');
	assert.equal(grid.clusters.length, 1);
	const [cluster] = grid.clusters;
	assert.deepEqual(cluster.bounds, { center: [10, 20, 30], extents: [1, 2, 3] });
	assert.deepEqual(
		cluster.instances.map((m) => [m[12], m[13], m[14]]),
		[
			[11, 20, 30],
			[12, 20, 30],
		],
	);
	assert.equal(cluster.renderer.lodCount, 2);
	assert.deepEqual(
		cluster.renderer.draws.map(({ meshHash, materialHash, submesh, flags, lod }) => ({
			meshHash,
			materialHash,
			submesh,
			flags,
			lod,
		})),
		[
			{ meshHash: 0x444n, materialHash: 0x222n, submesh: 1, flags: 0x3f80000, lod: 0 },
			{ meshHash: 0x333n, materialHash: 0x111n, submesh: 0, flags: 0x3f80400, lod: 1 },
		],
	);
});

test('readFoliageGrids skips other proxies and rejects draws outside the batch table', () => {
	const audioOnly = chunk(2, []);
	assert.equal(hasFoliageGrids(audioOnly), false);
	assert.deepEqual(readFoliageGrids(audioOnly, chunk(2, [])), []);

	const init = chunk(FoliageGridType.Grass, grassProperties({ drawKey: 0xdead }));
	assert.throws(() => readFoliageGrids(init, chunk(FoliageGridType.Grass, batchTable)), FormatError);
});
