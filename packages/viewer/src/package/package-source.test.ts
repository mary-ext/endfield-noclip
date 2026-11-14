import assert from 'node:assert/strict';
import { it } from 'node:test';

import { CORE_ARCHIVE } from '@endfield-noclip/package-format/manifest';

import { fileListSource, PackageChangedError, parseByteRanges } from './package-source.ts';

/** a file as a directory input lists it (Node's `File` has no `webkitRelativePath`) */
const picked = (bytes: Uint8Array<ArrayBuffer>, name: string): File =>
	Object.defineProperty(new File([bytes], name), 'webkitRelativePath', { value: `package/${name}` });

it('refuses range reads from an archive whose size no longer matches the manifest', async () => {
	const source = fileListSource([
		picked(new Uint8Array(4), CORE_ARCHIVE),
		picked(new Uint8Array([1, 2, 3, 4, 5, 6]), 'shard.czar'),
	]);
	assert.deepEqual(
		await source.readRange('shard.czar', { offset: 2, length: 3, fileSize: 6 }),
		new Uint8Array([3, 4, 5]),
	);
	await assert.rejects(
		source.readRange('shard.czar', { offset: 2, length: 3, fileSize: 8 }),
		PackageChangedError,
	);
});

it('reads several ranges of a local file, each into a buffer of its own', async () => {
	const source = fileListSource([
		picked(new Uint8Array(4), CORE_ARCHIVE),
		picked(new Uint8Array([1, 2, 3, 4, 5, 6]), 'shard.czar'),
	]);
	const [a, b] = await source.readRanges('shard.czar', [
		{ offset: 0, length: 2, fileSize: 6 },
		{ offset: 4, length: 2, fileSize: 6 },
	]);
	assert.deepEqual(a, new Uint8Array([1, 2]));
	assert.deepEqual(b, new Uint8Array([5, 6]));
	assert.notEqual(a.buffer, b.buffer);
});

it('splits a multipart/byteranges body by its parts’ content ranges', () => {
	const text = (value: string): number[] => [...new TextEncoder().encode(value)];
	// the first part's bytes hold a line break and the boundary itself, which only the lengths tell apart
	const first = text('\r\n--b\r\n');
	const body = new Uint8Array([
		...text('--b\r\nContent-Type: application/octet-stream\r\n'),
		...text(`Content-Range: bytes 10-${10 + first.length - 1}/100\r\n\r\n`),
		...first,
		...text('\r\n--b\r\ncontent-range: bytes 40-41/*\r\n\r\n'),
		7,
		8,
		...text('\r\n--b--\r\n'),
	]);
	const parts = parseByteRanges(body, 'b');
	assert.deepEqual(
		parts.map(({ offset, fileSize, bytes }) => ({ offset, fileSize, bytes: [...bytes] })),
		[
			{ offset: 10, fileSize: 100, bytes: first },
			{ offset: 40, fileSize: null, bytes: [7, 8] },
		],
	);
	assert.throws(() => parseByteRanges(body.subarray(0, body.length - 12).slice(), 'b'), /malformed/);
});
