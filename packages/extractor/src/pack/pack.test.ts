import assert from 'node:assert/strict';
import { open, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { zstdDecompressSync } from 'node:zlib';

import { decodeInstanceBlock, encodeInstanceBlock } from '@endfield-noclip/package-format/codec';
import {
	BlobCodec,
	BlobKind,
	blobPath,
	type ChainDraw,
	ChainFlags,
	ContentKind,
	DrawRole,
} from '@endfield-noclip/package-format/format';

import { openArchive } from '@mary-ext/czar';
import { fromFileHandle } from '@mary-ext/czar/node';

import { BlobStore } from './blob-store.ts';
import { ChainTable } from './chains.ts';
import { InstanceBlockBuilder } from './instances.ts';
import { TileTreeBuilder } from './tile-tree.ts';

const draw = (overrides: Partial<ChainDraw>): ChainDraw => ({
	geometry: 0,
	material: 0,
	submesh: 0,
	lod: 0,
	role: DrawRole.Lit,
	minSquared: -1,
	maxSquared: 3.4028234663852886e38,
	sourceFlags: 0,
	...overrides,
});

describe('ChainTable', () => {
	it('shares templates between identical ordered draw lists', () => {
		const table = new ChainTable();
		const a = [draw({ geometry: 1, maxSquared: 1e30 }), draw({ geometry: 2, lod: 1, minSquared: 0.1 })];
		const first = table.intern(2, a);
		assert.equal(
			table.intern(
				2,
				a.map((d) => ({ ...d })),
			),
			first,
		);
		// order, LOD count and threshold bits all distinguish templates
		assert.notEqual(table.intern(2, a.toReversed()), first);
		assert.notEqual(table.intern(3, a), first);
		assert.notEqual(table.intern(2, [a[0], { ...a[1], minSquared: Math.fround(0.1) + 1e-8 }]), first);
		assert.equal(table.chains.length, 4);
	});

	it('flags shadow proxies, cards and HLOD', () => {
		const table = new ChainTable();
		const id = table.intern(1, [draw({ role: DrawRole.ShadowOnly }), draw({ role: DrawRole.Card })]);
		assert.equal(table.chains[id].flags, ChainFlags.HasShadowOnly | ChainFlags.HasCard);
		assert.equal(table.chains[table.intern(1, [draw({ role: DrawRole.Hlod })])].flags, ChainFlags.Hlod);
	});
});

describe('TileTreeBuilder', () => {
	const grid = { origin: [-2048, -2048] as [number, number], rootSize: 4096 };

	it('creates ancestors, child masks and merged bounds', () => {
		const builder = new TileTreeBuilder(grid);
		const ref = { kind: ContentKind.Detail, tier: 0, level: 0, blob: 0, first: 0, count: 1, param: 0 };
		builder.addRef({ level: 2, x: 1, z: 0 }, ref, 4);
		builder.extend({ level: 2, x: 1, z: 0 }, { min: [-1000, 10, -2000], max: [-900, 20, -1900] });
		builder.addRef({ level: 2, x: 0, z: 1 }, { ...ref, blob: 1 }, 4);
		builder.extend({ level: 2, x: 0, z: 1 }, { min: [-2000, -5, -1000], max: [-1900, 5, -900] });
		const tree = builder.build((key) => 100 / 2 ** key.level);

		assert.deepEqual(
			tree.nodes.map((node) => [node.level, node.x, node.z, node.childMask]),
			[
				[0, 0, 0, 0b0001],
				[1, 0, 0, 0b0110],
				[2, 1, 0, 0],
				[2, 0, 1, 0],
			],
		);
		assert.deepEqual(tree.nodes[0].bounds, { min: [-2000, -5, -2000], max: [-900, 20, -900] });
		assert.deepEqual(
			tree.nodes.map((node) => [node.refFirst, node.refCount]),
			[
				[0, 0],
				[0, 0],
				[0, 1],
				[1, 1],
			],
		);
		assert.equal(tree.refs[1].blob, 1);
		assert.equal(tree.nodes[2].geometricError, 25);
	});

	it('handles tiles west and south of the root square', () => {
		const builder = new TileTreeBuilder(grid);
		builder.extend({ level: 6, x: -1, z: -1 }, { min: [-2100, 0, -2100], max: [-2090, 1, -2090] });
		const tree = builder.build(() => 0);
		assert.deepEqual(
			tree.nodes.map((node) => [node.level, node.x, node.z]),
			Array.from({ length: 7 }, (_, level) => [level, -1, -1]),
		);
		assert.ok(tree.nodes.slice(0, 6).every((node) => node.childMask === 0b1000));
	});
});

describe('InstanceBlockBuilder', () => {
	const matrix = (tx: number, ty: number, tz: number): Float32Array => {
		const m = new Float32Array(16);
		m.set([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, tx, ty, tz, 1]);
		return m;
	};

	it('sorts by group then chain and makes positions relative', () => {
		const rows = new InstanceBlockBuilder();
		const add = (chain: number, group: number, entityId: number) =>
			rows.add(
				{
					chain,
					entityId,
					layer: 1,
					matrix: matrix(100 + entityId, 50, -200),
					bounds: { center: [100, 50, -200], extents: [1, 2, 3] },
				},
				group,
			);
		add(5, 1, 0);
		add(2, 1, 1);
		add(9, 0, 2);
		add(2, 1, 3);
		const { block, order } = rows.toBlock([64, 0, -256]);
		assert.deepEqual([...order], [2, 1, 3, 0]);
		assert.deepEqual([...block.chains], [9, 2, 2, 5]);
		assert.deepEqual(rows.groupsInOrder(order), [0, 1, 1, 1]);
		// first output row is entity 2: rows-major 3×4 with the translation in the last column
		assert.deepEqual([...block.transforms.subarray(0, 12)], [1, 0, 0, 38, 0, 2, 0, 50, 0, 0, 3, 56]);
		assert.deepEqual([...block.bounds.subarray(0, 6)], [36, 50, 56, 1, 2, 3]);
	});
});

describe('BlobStore', () => {
	it('dedupes, places blobs in archives and reports readable offsets', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pack-test-'));
		try {
			const store = new BlobStore(join(dir, '.spool'), { zstdLevel: 3 });
			const compressible = new Uint8Array(4096).fill(7);
			const random = Uint8Array.from({ length: 333 }, (_, i) => (i * 2654435761) >>> 24);
			const [a, b, c] = await store.putMany([
				{
					raw: compressible,
					options: { kind: BlobKind.Instances, compress: true, archive: () => 'shards/x.czar' },
				},
				{ raw: random, options: { kind: BlobKind.Other, compress: false, archive: () => 'core.czar' } },
				{
					raw: compressible,
					options: { kind: BlobKind.Instances, compress: true, archive: () => 'other.czar' },
				},
			]);
			assert.equal(c, a);
			assert.equal(store.size, 2);

			const archives = ['core.czar', ...store.archiveNames().filter((name) => name !== 'core.czar')];
			const records = store.records(archives);
			assert.equal(records[a].codec, BlobCodec.Zstd);
			assert.equal(records[b].codec, BlobCodec.None);
			assert.equal(archives[records[a].archive], 'shards/x.czar');

			const shards = await store.writeShards(dir, 'core.czar');
			await store.writeCore(dir, 'core.czar', [{ path: 'manifest.json', data: new Uint8Array([123, 125]) }]);

			// a shard blob, read by range from the table alone
			{
				const shard = shards.get('shards/x.czar')!;
				const record = records[a];
				await using handle = await open(join(dir, 'shards/x.czar'));
				const stored = new Uint8Array(record.length);
				await handle.read(stored, 0, record.length, shard.dataOffset + record.offset);
				assert.deepEqual(new Uint8Array(zstdDecompressSync(stored)), compressible);
			}
			// a core blob, through czar, at the recorded offset
			{
				await using handle = await open(join(dir, 'core.czar'));
				const archive = await openArchive(await fromFileHandle(handle));
				const file = archive.get(blobPath(records[b].hash, BlobKind.Other))!;
				assert.deepEqual(await file.bytes(), random);
				const prelude = new Uint8Array(16);
				await handle.read(prelude, 0, 16, 0);
				const dataOffset =
					Math.ceil((16 + Number(new DataView(prelude.buffer).getBigUint64(8, true))) / 16) * 16;
				const direct = new Uint8Array(random.length);
				await handle.read(direct, 0, random.length, dataOffset + records[b].offset);
				assert.deepEqual(direct, random);
				assert.ok(archive.get('manifest.json'));
			}
			await store.dispose();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('round-trips an instance block through compression', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pack-test-'));
		try {
			const store = new BlobStore(join(dir, '.spool'), { zstdLevel: 3 });
			const rows = new InstanceBlockBuilder();
			rows.add(
				{
					chain: 1,
					entityId: 42,
					layer: 0,
					matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]),
					bounds: { center: [5, 6, 7], extents: [1, 1, 1] },
				},
				0,
			);
			const { block } = rows.toBlock([0, 0, 0]);
			const index = await store.put(encodeInstanceBlock(block), {
				kind: BlobKind.Instances,
				compress: true,
				archive: () => 'core.czar',
			});
			await store.writeCore(dir, 'core.czar', []);
			await using handle = await open(join(dir, 'core.czar'));
			const archive = await openArchive(await fromFileHandle(handle));
			const record = store.records(['core.czar'])[index];
			let bytes = await archive.get(blobPath(record.hash, record.kind))!.bytes();
			if (record.codec === BlobCodec.Zstd) {
				bytes = new Uint8Array(zstdDecompressSync(bytes));
			}
			assert.deepEqual(decodeInstanceBlock(bytes), block);
			await store.dispose();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('assigns indices in commit order and skips zstd that barely helps', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pack-test-'));
		try {
			const store = new BlobStore(join(dir, '.spool'), { zstdLevel: 3 });
			const archives: [string, number][] = [];
			const options = {
				kind: BlobKind.Texture,
				compress: true,
				zstdLevel: 1,
				archive: (hash: string, length: number) => {
					archives.push([hash, length]);
					return 'assets/common.czar';
				},
			};
			// pseudo-random bytes: zstd can't save 1/32 of them
			let seed = 1;
			const noise = Uint8Array.from({ length: 4096 }, () => {
				seed = (seed * 1103515245 + 12345) >>> 0;
				return seed >>> 24;
			});
			const [late, early] = await Promise.all([
				store.prepare(new Uint8Array(4096).fill(3), options),
				store.prepare(noise, options),
			]);
			assert.equal(store.size, 0);
			assert.equal(store.commit(early), 0);
			assert.equal(store.commit(late), 1);
			assert.equal(store.commit(await store.prepare(noise, options)), 0);
			assert.equal(early.codec, BlobCodec.None);
			assert.equal(late.codec, BlobCodec.Zstd);
			// the placement callback runs once per new blob, with the stored length
			assert.deepEqual(archives, [
				[early.hash, 4096],
				[late.hash, late.stored.byteLength],
			]);
			await store.dispose();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
