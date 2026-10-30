import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IRRADIANCE_INDEX_MAGIC } from '@endfield-noclip/formats/hg/irradiance';

import { Vfs, type VfsFile } from '../hg/vfs.ts';

import type { BlobStore } from './blob-store.ts';
import { packIrradiance } from './irradiance.ts';

const indexBytes = (): Uint8Array => {
	const pieces: Uint8Array[] = [];
	const words = (...values: number[]) => {
		const bytes = new Uint8Array(values.length * 4);
		const view = new DataView(bytes.buffer);
		values.forEach((value, i) => view.setUint32(i * 4, value, true));
		pieces.push(bytes);
	};
	const string = (value: string) => {
		const bytes = Buffer.from(value, 'utf16le');
		words(bytes.length);
		pieces.push(bytes);
	};
	words(IRRADIANCE_INDEX_MAGIC, 1);
	string('scenario');
	words(2, 0, 0, 123, 1, 0, 2);
	string('iv_0_0.bytes');
	string('iv_123_0.bytes');
	words(1, 1, 0, 0, 2);
	words(1, 0, 0, 16, 16, 8, 8, 0, 0);
	words(1, 0, 0, 16, 16, 8, 8, 1, 0);
	words(0);
	return Buffer.concat(pieces);
};

const vfsWithLengths = (lengths: Map<string, number>) => {
	const vfs = new Vfs('', new Uint8Array(32));
	vfs.find = async (_group, path) => {
		const name = path.slice(path.lastIndexOf('/') + 1);
		const length = name === 'index.bytes' ? indexBytes().length : lengths.get(name);
		// only the length is consumed; any unexpected payload read below fails the test.
		return length === undefined ? undefined : ({ entry: { length } } as VfsFile);
	};
	vfs.readVerified = async () => indexBytes();
	return vfs;
};

const packOutsideRegion = (lengths: Map<string, number>) =>
	packIrradiance(vfsWithLengths(lengths), {} as BlobStore, { scene: 'synthetic', includes: () => false });

test('irradiance validates scene-state payloads even when packing no cells', async () => {
	await assert.rejects(packOutsideRegion(new Map([['iv_0_0.bytes', 16]])), /iv_123_0.bytes/);
	for (const length of [15, 17]) {
		await assert.rejects(
			packOutsideRegion(
				new Map([
					['iv_0_0.bytes', 16],
					['iv_123_0.bytes', length],
				]),
			),
			/length disagrees/,
		);
	}
});

test('irradiance accepts exact payload lengths with an empty region', async () => {
	const result = await packOutsideRegion(
		new Map([
			['iv_0_0.bytes', 16],
			['iv_123_0.bytes', 16],
		]),
	);
	assert.equal(result?.report.cells, 0);
	assert.equal(result?.table.keys.length, 0);
});
