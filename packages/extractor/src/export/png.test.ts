import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crc32, inflateSync } from 'node:zlib';

import { encodePng } from './png.ts';

const readChunks = (png: Uint8Array): Map<string, Uint8Array> => {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const chunks = new Map<string, Uint8Array>();
	let offset = 8;
	while (offset < png.length) {
		const length = view.getUint32(offset);
		const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
		assert.equal(view.getUint32(offset + 8 + length), crc32(png.subarray(offset + 4, offset + 8 + length)));
		chunks.set(type, png.subarray(offset + 8, offset + 8 + length));
		offset += length + 12;
	}
	return chunks;
};

describe('encodePng', () => {
	it('writes big-endian 16-bit gray rows behind filter bytes', () => {
		const png = encodePng({
			width: 2,
			height: 1,
			color: 'gray',
			bitDepth: 16,
			data: Uint16Array.of(0x1234, 0xabcd),
		});
		assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const chunks = readChunks(png);
		assert.deepEqual([...chunks.get('IHDR')!], [0, 0, 0, 2, 0, 0, 0, 1, 16, 0, 0, 0, 0]);
		assert.deepEqual([...inflateSync(chunks.get('IDAT')!)], [0, 0x12, 0x34, 0xab, 0xcd]);
		assert.ok(chunks.has('IEND'));
	});

	it('writes 8-bit rgb', () => {
		const data = Uint8Array.of(1, 2, 3, 4, 5, 6);
		const chunks = readChunks(encodePng({ width: 1, height: 2, color: 'rgb', bitDepth: 8, data }));
		assert.equal(chunks.get('IHDR')![9], 2);
		assert.deepEqual([...inflateSync(chunks.get('IDAT')!)], [0, 1, 2, 3, 0, 4, 5, 6]);
	});

	it('rejects mismatched data', () => {
		assert.throws(
			() => encodePng({ width: 2, height: 2, color: 'gray', bitDepth: 16, data: new Uint8Array(4) }),
			RangeError,
		);
	});
});
