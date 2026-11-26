import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MemoCache } from '../ir/cache.ts';

import { memoizeValue, PipelineRunner } from './runner.ts';

const fakeCache = (): MemoCache & { reads: number; writes: number } => {
	const store = new Map<string, unknown>();
	const cache = {
		reads: 0,
		writes: 0,
		fingerprint: () => Promise.resolve('fp'),
		keyWith: (fp: string, parts: object) => `${fp}:${JSON.stringify(parts)}`,
		stepKey: (entry: URL, parts: object) => Promise.resolve(`${entry.href}:${JSON.stringify(parts)}`),
		recallValue<T>(key: string): Promise<T | undefined> {
			cache.reads++;
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test helper round-trip
			return Promise.resolve(store.get(key) as T | undefined);
		},
		rememberValue(key: string, value: unknown): Promise<void> {
			cache.writes++;
			store.set(key, value);
			return Promise.resolve();
		},
	};
	return cache;
};

describe('pipeline runner', () => {
	it('memoizeValue caches on miss and recalls on hit', async () => {
		const cache = fakeCache();
		let calls = 0;
		const entry = new URL(import.meta.url);
		const first = await memoizeValue(cache, {
			entry,
			parts: { id: 'a' },
			compute: () => {
				calls++;
				return Promise.resolve({ n: 42 });
			},
		});
		const second = await memoizeValue(cache, {
			entry,
			parts: { id: 'a' },
			compute: () => {
				calls++;
				return Promise.resolve({ n: 99 });
			},
		});
		assert.deepEqual(first, { n: 42 });
		assert.deepEqual(second, { n: 42 });
		assert.equal(calls, 1);
		assert.equal(cache.reads, 2);
		assert.equal(cache.writes, 1);
	});

	it('PipelineRunner times stages in order and adopts sub-timings', async () => {
		const logs: string[] = [];
		const runner = new PipelineRunner((line) => logs.push(line));
		const out = await runner.stage('setup', () => 123);
		assert.equal(out, 123);
		runner.adopt({ materials: 10, geometry: 20 });
		assert.ok('setup' in runner.timings);
		assert.equal(runner.timings.materials, 10);
		assert.equal(runner.timings.geometry, 20);
		assert.equal(logs.length, 1);
	});
});
