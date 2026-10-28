import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { applyBundlePad } from './bundle-cipher.ts';
import {
	type BundleBlock,
	type BundleDirectory,
	bytesSource,
	decodeBundleBlockInPlace,
	findBlockSpan,
	isHgBundle,
	UnityBundle,
} from './bundle.ts';

/** an inverted-LZ4 block holding `literals` as one literal run */
const invertedLiteralBlock = (literals: Uint8Array): Uint8Array => {
	const length = literals.length;
	const extra: number[] = [];
	if (length >= 15) {
		let rest = length - 15;
		while (rest >= 255) {
			extra.push(255);
			rest -= 255;
		}
		extra.push(rest);
	}
	const lit = Math.min(length, 15);
	const token = (lit & 0b11) | ((lit & 0b1100) << 2);
	return new Uint8Array([token, ...extra, ...literals]);
};

const pad = Uint8Array.from({ length: 256 }, (_, i) => (i * 37 + 11) & 0xff);

/**
 * builds a bundle body whose stream is `0, 1, 2, …` split into blocks of the given sizes, alternating raw and
 * padded inverted-LZ4 blocks
 */
const syntheticBundle = (
	sizes: number[],
): { directory: BundleDirectory; body: Uint8Array; stream: Uint8Array } => {
	const total = sizes.reduce((sum, size) => sum + size, 0);
	const stream = Uint8Array.from({ length: total }, (_, i) => (i * 7) & 0xff);
	const dataOffset = 48;
	const parts: Uint8Array[] = [new Uint8Array(dataOffset)];
	const blocks: BundleBlock[] = [];
	let compressedOffset = dataOffset;
	let uncompressedOffset = 0;
	for (const [index, size] of sizes.entries()) {
		const plain = stream.subarray(uncompressedOffset, uncompressedOffset + size);
		let stored: Uint8Array;
		let flags: number;
		if (index % 2 === 0) {
			stored = plain.slice();
			flags = 0;
		} else {
			stored = invertedLiteralBlock(plain);
			applyBundlePad(stored, pad);
			flags = 5;
		}
		blocks.push({
			flags,
			compressedSize: stored.length,
			uncompressedSize: size,
			compressedOffset,
			uncompressedOffset,
		});
		parts.push(stored);
		compressedOffset += stored.length;
		uncompressedOffset += size;
	}
	const body = new Uint8Array(compressedOffset);
	let at = 0;
	for (const part of parts) {
		body.set(part, at);
		at += part.length;
	}
	const directory: BundleDirectory = {
		header: {
			size: body.length,
			flags: 0,
			encFlags: 8,
			compressedBlocksInfoSize: 0,
			uncompressedBlocksInfoSize: 0,
			blocksInfoOffset: dataOffset,
			dataOffset,
		},
		blocks,
		nodes: [
			{ path: 'CAB-a', offset: 0, size: 300, flags: 4 },
			{ path: 'CAB-a.resS', offset: 300, size: total - 300, flags: 0 },
		],
	};
	return { directory, body, stream };
};

describe('UnityBundle', () => {
	it('reads node ranges spanning raw and compressed blocks', async () => {
		const { directory, body, stream } = syntheticBundle([100, 200, 50, 400, 10]);
		const bundle = new UnityBundle(directory, bytesSource(body), pad);
		const [cab, resS] = bundle.nodes;
		assert.deepEqual(await bundle.readNode(cab), stream.subarray(0, 300));
		assert.deepEqual(await bundle.readNode(resS), stream.subarray(300));
		// repeated and overlapping reads go through the block cache
		assert.deepEqual(await bundle.readNodeRange(resS, 40, 450), stream.subarray(340, 750));
		assert.deepEqual(await bundle.readNodeRange(cab, 99, 101), stream.subarray(99, 101));
		assert.deepEqual(await bundle.readNodeRange(resS, 459, 460), stream.subarray(759, 760));
		assert.deepEqual(await bundle.readNodeRange(cab, 5, 5), new Uint8Array(0));
		assert.throws(() => bundle.readNodeRange(cab, 0, 301), RangeError);
	});

	it('only fetches the blocks overlapping a read', async () => {
		const { directory, body } = syntheticBundle([100, 100, 100, 100]);
		const reads: [number, number][] = [];
		const source = bytesSource(body);
		const bundle = new UnityBundle(
			directory,
			{
				size: source.size,
				read: (start, end) => {
					reads.push([start, end]);
					return source.read(start, end);
				},
			},
			pad,
		);
		await bundle.readStream(150, 250);
		const [first, , third] = directory.blocks;
		assert.deepEqual(reads, [
			[directory.blocks[1].compressedOffset, third.compressedOffset + third.compressedSize],
		]);
		assert.ok(first.compressedOffset < reads[0][0]);
	});

	it('shares in-flight decodes and reads only the missing runs', async () => {
		const { directory, body, stream } = syntheticBundle([100, 100, 100, 100]);
		const reads: [number, number][] = [];
		const source = bytesSource(body);
		const bundle = new UnityBundle(
			directory,
			{
				size: source.size,
				read: (start, end) => {
					reads.push([start, end]);
					return source.read(start, end);
				},
			},
			pad,
		);
		const blocks = directory.blocks;
		const [a, b] = await Promise.all([bundle.readStream(150, 250), bundle.readStream(100, 300)]);
		assert.deepEqual(a, stream.subarray(150, 250));
		assert.deepEqual(b, stream.subarray(100, 300));
		assert.deepEqual(reads, [
			[blocks[1].compressedOffset, blocks[2].compressedOffset + blocks[2].compressedSize],
		]);

		// blocks 1 and 2 are now cached: a read over 0…3 fetches blocks 0 and 3 separately
		reads.length = 0;
		assert.deepEqual(await bundle.readStream(50, 350), stream.subarray(50, 350));
		assert.deepEqual(reads, [
			[blocks[0].compressedOffset, blocks[0].compressedOffset + blocks[0].compressedSize],
			[blocks[3].compressedOffset, blocks[3].compressedOffset + blocks[3].compressedSize],
		]);
	});
});

describe('findBlockSpan', () => {
	const blocks = syntheticBundle([10, 10, 10]).directory.blocks;

	it('finds the first and last overlapping blocks', () => {
		assert.deepEqual(findBlockSpan(blocks, 0, 10), [0, 0]);
		assert.deepEqual(findBlockSpan(blocks, 9, 11), [0, 1]);
		assert.deepEqual(findBlockSpan(blocks, 10, 30), [1, 2]);
		assert.equal(findBlockSpan(blocks, 5, 5), undefined);
	});

	it('rejects ranges past the stream', () => {
		assert.throws(() => findBlockSpan(blocks, 25, 31), FormatError);
	});
});

describe('decodeBundleBlockInPlace', () => {
	it('rejects unknown compression types', () => {
		const block: BundleBlock = {
			flags: 3,
			compressedSize: 4,
			uncompressedSize: 8,
			compressedOffset: 0,
			uncompressedOffset: 0,
		};
		assert.throws(
			() => decodeBundleBlockInPlace(block, new Uint8Array(4), pad),
			/unsupported bundle block type 0x3/,
		);
	});

	it('decrypts the stored bytes in place', () => {
		const clear = invertedLiteralBlock(new Uint8Array([1, 2, 3]));
		const stored = clear.slice();
		applyBundlePad(stored, pad);
		const block: BundleBlock = {
			flags: 5,
			compressedSize: stored.length,
			uncompressedSize: 3,
			compressedOffset: 0,
			uncompressedOffset: 0,
		};
		assert.deepEqual(decodeBundleBlockInPlace(block, stored, pad), new Uint8Array([1, 2, 3]));
		assert.deepEqual(stored, clear);
	});
});

it('rejects plain UnityFS files', () => {
	assert.equal(isHgBundle(new TextEncoder().encode('UnityFS\0\0\0\0\x08')), false);
});
