import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BlobCodec } from '@endfield-noclip/package-format/format';

import type { ConvertResult } from './convert-pool.ts';
import { PackCache } from './pack-cache.ts';

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
	},
	gpuBytes: 30,
	blob: { hash, codec: BlobCodec.None, length: 1, rawLength: 1, crc32: 0 },
	sources: [0],
});

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
			const keyA = cache.key({ asset: 1n });
			assert.notEqual(keyA, cache.key({ asset: 2n }));
			await cache.blobs.write('aa'.repeat(16), new Uint8Array([1]));
			// written but not held by the package, like a blob of a failed pack
			await cache.blobs.write('cc'.repeat(16), new Uint8Array([3]));
			await cache.remember(keyA, geometry('aa'.repeat(16)));
			let report = await cache.finish(a, ['aa'.repeat(16)]);
			assert.deepEqual(report.swept, { blobs: 1, memos: 0, bytes: 1 });
			await cache.close();

			cache = await PackCache.open(root);
			assert.deepEqual(await cache.recall(keyA), geometry('aa'.repeat(16)));
			assert.equal(cache.hits.geometries, 1);
			const keyB = cache.key({ asset: 2n });
			await cache.blobs.write('bb'.repeat(16), new Uint8Array([2]));
			await cache.remember(keyB, geometry('bb'.repeat(16)));
			// a's root still holds aa; b holds bb
			report = await cache.finish(b, ['bb'.repeat(16)]);
			assert.deepEqual(report.swept, { blobs: 0, memos: 0, bytes: 0 });
			await cache.close();

			// b's package is gone, so its blob and conversion go at the next pack
			await rm(b, { recursive: true });
			cache = await PackCache.open(root);
			assert.ok(await cache.recall(keyA));
			report = await cache.finish(a, ['aa'.repeat(16)]);
			assert.equal(report.swept.blobs, 1);
			assert.equal(report.swept.memos, 1);
			assert.equal(await cache.recall(keyB), undefined);
			assert.equal((await readdir(join(root, 'roots'))).length, 1);
			await cache.close();
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
