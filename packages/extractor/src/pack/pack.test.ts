import assert from 'node:assert/strict';
import { open, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { zstdDecompressSync } from 'node:zlib';

import type { Aabb } from '@endfield-noclip/formats/unity/values';
import { BlobCodec, BlobKind, blobPath } from '@endfield-noclip/package-format/blobs';
import {
	decodeInstanceBlock,
	encodeInstanceBlock,
	type ChainDraw,
	ChainFlags,
	DrawRole,
} from '@endfield-noclip/package-format/instances';
import { ContentKind } from '@endfield-noclip/package-format/tree';

import { openArchive } from '@mary-ext/czar';
import { fromFileHandle } from '@mary-ext/czar/node';

import { BlobDir } from './blob-file.ts';
import { BlobStore } from './blob-store.ts';
import { ChainTable } from './chains.ts';
import { resolveClampedHlodCell } from './hlod-cells.ts';
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
	particles: null,
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
		// so do the particle systems a draw emits
		assert.notEqual(table.intern(2, [a[0], { ...a[1], particles: 0 }]), first);
		assert.equal(table.chains.length, 5);
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
		const ref = { kind: ContentKind.Detail, tier: 0, group: 0, blob: 0, first: 0, count: 1, param: 0 };
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

describe('resolveClampedHlodCell', () => {
	// 64 m leaves at level 5, origin at -1024
	const tree = { origin: [-1024, -1024] as [number, number], rootSize: 2048 };
	const box = (minX: number, maxX: number, z: number): Aabb => ({
		center: [(minX + maxX) / 2, 10, z],
		extents: [(maxX - minX) / 2, 5, 10],
	});
	const resolve = (bounds: Aabb, details: Map<string, Aabb[]>, named = { level: 5, x: 0, z: 6 }) =>
		resolveClampedHlodCell({
			tree,
			leafLevel: 5,
			named,
			bounds,
			detailAt: (leaf) => details.get(`${leaf.x},${leaf.z}`) ?? [],
		});
	// z = -620 lies in leaf row 6
	const z = -620;

	it('picks the cell whose detail the cluster contains, not the bounds centre', () => {
		// a large member overhangs far west; the cluster's own members sit in cell -16
		const details = new Map([
			['-16,6', [box(-2040, -1990, z)]],
			['-19,6', [box(-2500, -2100, z)]],
		]);
		assert.deepEqual(resolve(box(-2400, -1980, z), details), { level: 5, x: -16, z: 6 });
	});

	it('falls back to the centre cell without contained detail', () => {
		assert.deepEqual(resolve(box(-2000, -1940, z), new Map()), { level: 5, x: -15, z: 6 });
	});

	it('never moves a cell east of 0 or along an axis named other than 0', () => {
		assert.deepEqual(resolve(box(-990, -970, z), new Map()), { level: 5, x: 0, z: 6 });
		const details = new Map([['-16,7', [box(-2040, -1990, -560)]]]);
		assert.deepEqual(resolve(box(-2400, -1980, -560), details, { level: 5, x: 0, z: 6 }).z, 6);
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
			const store = new BlobStore(new BlobDir(join(dir, '.spool')), {
				zstdLevel: 3,
				archiveCap: 1 << 20,
				core: 'core.czar',
			});
			const compressible = new Uint8Array(4096).fill(7);
			const random = Uint8Array.from({ length: 333 }, (_, i) => (i * 2654435761) >>> 24);
			const [a, b, c] = await store.putMany([
				{ raw: compressible, options: { kind: BlobKind.Instances, compress: true, stem: 'shards/x' } },
				{ raw: random, options: { kind: BlobKind.Other, compress: false, stem: 'core.czar' } },
				{ raw: compressible, options: { kind: BlobKind.Instances, compress: true, stem: 'other' } },
			]);
			assert.equal(c, a);
			assert.equal(store.size, 2);

			const [shardName] = store.archives().map(({ name }) => name);
			assert.match(shardName, /^shards\/x-[0-9a-f]{16}\.czar$/);
			const archives = ['core.czar', shardName];
			const records = store.records(archives);
			assert.equal(records[a].codec, BlobCodec.Zstd);
			assert.equal(records[b].codec, BlobCodec.None);
			assert.equal(archives[records[a].archive], shardName);

			const shards = await store.writeArchives(dir, null);
			const core = await store.writeCore(dir, [{ path: 'manifest.json', data: new Uint8Array([123, 125]) }]);

			// a shard blob, read by range from the table alone
			{
				const shard = shards.get(shardName)!;
				assert.equal(shard.reused, false);
				const record = records[a];
				await using handle = await open(join(dir, shardName));
				const stored = new Uint8Array(record.length);
				await handle.read(stored, 0, record.length, shard.dataOffset + record.offset);
				assert.deepEqual(new Uint8Array(zstdDecompressSync(stored)), compressible);
				const archive = await openArchive(await fromFileHandle(handle));
				assert.equal(
					archive.get(blobPath(record.hash, record.kind))!.position,
					shard.dataOffset + record.offset,
				);
			}
			// a core blob, through czar, at the recorded offset
			{
				await using handle = await open(join(dir, 'core.czar'));
				const archive = await openArchive(await fromFileHandle(handle));
				const file = archive.get(blobPath(records[b].hash, BlobKind.Other))!;
				assert.deepEqual(await file.bytes(), random);
				assert.equal(core.dataOffset + records[b].offset, file.position);
				assert.ok(archive.get('manifest.json'));
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('round-trips an instance block through compression', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pack-test-'));
		try {
			const store = new BlobStore(new BlobDir(join(dir, '.spool')), {
				zstdLevel: 3,
				archiveCap: 1 << 20,
				core: 'core.czar',
			});
			const rows = new InstanceBlockBuilder();
			rows.add(
				{
					chain: 1,
					entityId: 42,
					matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]),
					bounds: { center: [5, 6, 7], extents: [1, 1, 1] },
				},
				0,
			);
			const { block } = rows.toBlock([0, 0, 0]);
			const index = await store.put(encodeInstanceBlock(block), {
				kind: BlobKind.Instances,
				compress: true,
				stem: 'core.czar',
			});
			await store.writeCore(dir, []);
			await using handle = await open(join(dir, 'core.czar'));
			const archive = await openArchive(await fromFileHandle(handle));
			const record = store.records(['core.czar'])[index];
			let bytes = await archive.get(blobPath(record.hash, record.kind))!.bytes();
			if (record.codec === BlobCodec.Zstd) {
				bytes = new Uint8Array(zstdDecompressSync(bytes));
			}
			assert.deepEqual(decodeInstanceBlock(bytes), block);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('assigns indices in commit order and skips zstd that barely helps', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pack-test-'));
		try {
			const store = new BlobStore(new BlobDir(join(dir, '.spool')), {
				zstdLevel: 3,
				archiveCap: 1 << 20,
				core: 'core.czar',
			});
			const options = { kind: BlobKind.Texture, compress: true, zstdLevel: 1, stem: 'assets/common' };
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
			assert.equal(early.meta.codec, BlobCodec.None);
			assert.equal(late.meta.codec, BlobCodec.Zstd);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('splits large groups by blob hash and clones unchanged archives from the previous package', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pack-test-'));
		try {
			const blobs = new BlobDir(join(dir, '.spool'));
			const fill = async (count: number) => {
				const store = new BlobStore(blobs, { zstdLevel: 3, archiveCap: 4096, core: 'core.czar' });
				await store.putMany(
					Array.from({ length: count }, (_, i) => ({
						raw: Uint8Array.from({ length: 1024 }, (_, j) => (i * 31 + j * 7) & 0xff),
						options: { kind: BlobKind.Texture, compress: false, stem: 'assets/common' },
					})),
				);
				return store;
			};
			// 12 KiB over a 4 KiB cap: four parts named by bucket, each holding blobs whose hashes start alike
			const first = await fill(12);
			const parts = first.archives();
			assert.ok(parts.length > 1 && parts.length <= 4);
			for (const { name, stem } of parts) {
				assert.equal(stem, 'assets/common');
				assert.match(name, /^assets\/common\.[0-3]-[0-9a-f]{16}\.czar$/);
			}
			const previous = join(dir, 'previous');
			await first.writeArchives(previous, null);

			// the same blobs again: every archive is reused, byte for byte
			const again = await fill(12);
			const reused = await again.writeArchives(join(dir, 'next'), previous);
			assert.ok([...reused.values()].every((archive) => archive.reused));
			for (const { name } of parts) {
				assert.deepEqual(await readFile(join(dir, 'next', name)), await readFile(join(previous, name)));
			}

			// one more blob changes only the part it hashes into
			const grown = await fill(13);
			const written = await grown.writeArchives(join(dir, 'grown'), previous);
			assert.equal([...written.values()].filter((archive) => !archive.reused).length, 1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
