import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BlobCodec, BlobKind } from '@endfield-noclip/package-format/blobs';

import type { ConvertResult } from '../compile/convert-pool.ts';

import { BlobDir, type BlobMeta, storeCompressed, type StoredBlobLookup } from './blob-file.ts';
import { BlobStore } from './blob-store.ts';
import { openStoredBlobLookup, PackCache } from './pack-cache.ts';

const geometry = (hash: string): ConvertResult => ({
	kind: 'geometry',
	object: 'CAB-0:1',
	name: 'mesh',
	entry: {
		bounds: { min: [0, 0, 0], max: [1, 1, 1] },
		vertexCount: 3,
		indexCount: 3,
		submeshCount: 1,
		attributes: 1,
		tangentUv: null,
		animationFrames: null,
	},
	gpuBytes: 30,
	blob: { hash, codec: BlobCodec.None, length: 1, rawLength: 1, crc32: 0 },
	sources: [{ bundle: 'main/0.ab', md5: 'A' }],
});

const current = async (): Promise<boolean> => true;

/** a directory that looks like a package to the cache */
const fakePackage = async (dir: string): Promise<void> => {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'core.czar'), '');
};

describe('PackCache', () => {
	it('recalls conversions, keeps what live packages hold and sweeps the rest', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pack-cache-test-'));
		try {
			const root = join(dir, 'cache');
			const [a, b] = [join(dir, 'a'), join(dir, 'b')];
			await fakePackage(a);
			await fakePackage(b);

			let cache = await PackCache.open(root);
			const keyA = cache.key('geometry', { asset: 1n });
			assert.notEqual(keyA, cache.key('geometry', { asset: 2n }));
			assert.notEqual(keyA, cache.key('texture', { asset: 1n }));
			await cache.blobs.write('aa'.repeat(16), new Uint8Array([1]));
			// written but not held by the package, like a blob of a failed pack
			await cache.blobs.write('cc'.repeat(16), new Uint8Array([3]));
			await cache.remember(keyA, geometry('aa'.repeat(16)));
			let report = await cache.finish(a, ['aa'.repeat(16)]);
			assert.deepEqual(report.swept, { blobs: 1, memos: 0, bytes: 1 });
			await cache.close();

			cache = await PackCache.open(root);
			// a changed source bundle is a miss
			assert.equal(await cache.recall(keyA, async () => false), undefined);
			assert.deepEqual(await cache.recall(keyA, current), geometry('aa'.repeat(16)));
			assert.equal(cache.hits.geometries, 1);
			const keyB = cache.key('geometry', { asset: 2n });
			await cache.blobs.write('bb'.repeat(16), new Uint8Array([2]));
			await cache.remember(keyB, geometry('bb'.repeat(16)));
			// a's root still holds aa; b holds bb
			report = await cache.finish(b, ['bb'.repeat(16)]);
			assert.deepEqual(report.swept, { blobs: 0, memos: 0, bytes: 0 });
			await cache.close();

			// b's package is gone, so its blob and conversion go at the next pack
			await rm(b, { recursive: true });
			cache = await PackCache.open(root);
			assert.ok(await cache.recall(keyA, current));
			report = await cache.finish(a, ['aa'.repeat(16)]);
			assert.equal(report.swept.blobs, 1);
			assert.equal(report.swept.memos, 1);
			assert.equal(await cache.recall(keyB, current), undefined);
			await cache.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('remembers compressed blobs by their raw bytes, so a later pack skips compressing them', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pack-cache-test-'));
		try {
			const cache = await PackCache.open(join(dir, 'cache'));
			const store = () =>
				new BlobStore(cache.blobs, { zstdLevel: 3, archiveCap: 1 << 20, core: 'core.czar', memo: cache });
			const raw = new Uint8Array(4096).fill(9);
			const options = {
				kind: BlobKind.Instances,
				compress: true,
				stem: 'shards/x',
				locality: null,
			} as const;
			const first = await store().prepare(raw, options);
			const key = cache.storedKey(raw, 3);
			assert.deepEqual(await cache.recallStored(key), first.meta);
			// another level is another stored form
			assert.equal(await cache.recallStored(cache.storedKey(raw, 4)), undefined);
			assert.deepEqual((await store().prepare(raw, options)).meta, first.meta);
			// a memo whose blob is gone is a miss
			await rm(cache.blobs.path(first.meta.hash));
			assert.equal(await cache.recallStored(key), undefined);
			await cache.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('remembers failed conversions with their sources or manifest hash', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pack-cache-test-'));
		try {
			const cache = await PackCache.open(join(dir, 'cache'));
			const key = cache.key('geometry', { asset: 99n });
			const failed: ConvertResult = {
				kind: 'failed',
				jobKind: 'geometry',
				error: 'missing mesh',
				sources: [],
				manifestHash: 'hash-1',
			};
			await cache.remember(key, failed);
			assert.equal(await cache.recall(key, async (_sources, hash) => hash === 'hash-2'), undefined);
			assert.deepEqual(await cache.recall(key, async (_sources, hash) => hash === 'hash-1'), failed);
			assert.equal(cache.hits.geometries, 1);
			await cache.close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('storeCompressed skips recompressing identical raw blobs', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pack-cache-test-'));
		try {
			const blobs = new BlobDir(join(dir, 'blobs'));
			const map = new Map<string, BlobMeta>();
			const memos: StoredBlobLookup = {
				get: (key) => map.get(key),
				set: (key, meta) => {
					map.set(key, meta);
				},
			};
			const raw = new Uint8Array(4096).fill(7);
			let calls = 0;
			const compress = (data: Uint8Array): Uint8Array => {
				calls++;
				return data.slice(0, 64);
			};
			const first = await storeCompressed(blobs, memos, raw, 9, compress);
			const second = await storeCompressed(blobs, memos, raw, 9, compress);
			assert.equal(calls, 1);
			assert.deepEqual(second, first);

			// also exercise the SQLite-backed worker lookup
			const cache = await PackCache.open(join(dir, 'cache'));
			const workerLookup = openStoredBlobLookup(cache.dbPath);
			try {
				const a = await storeCompressed(cache.blobs, workerLookup, raw, 9, compress);
				const b = await storeCompressed(cache.blobs, workerLookup, raw, 9, compress);
				assert.equal(calls, 2);
				assert.deepEqual(b, a);
			} finally {
				workerLookup.close();
				await cache.close();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('refuses a cache another running process holds, and takes over a stale lock', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'pack-cache-test-'));
		try {
			const cache = await PackCache.open(dir);
			await assert.rejects(PackCache.open(dir), /in use by process/);
			await cache.close();
			// no process has pid 2^22 + 1 on macOS or Linux defaults
			await writeFile(join(dir, 'lock'), String(2 ** 22 + 1));
			await (await PackCache.open(dir)).close();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
