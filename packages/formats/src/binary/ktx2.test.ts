import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { read } from 'ktx-parse';

import { FormatError } from './binary-reader.ts';
import { imageByteLength, ktx2FormatInfo, VkFormat, writeKtx2 } from './ktx2.ts';

const filled = (length: number, seed: number): Uint8Array => {
	return Uint8Array.from({ length }, (_, i) => (i * 7 + seed) & 0xff);
};

describe('writeKtx2', () => {
	it('writes a BC7 sRGB mip chain that ktx-parse reads back', () => {
		const levels = [filled(64, 1), filled(16, 2), filled(16, 3), filled(16, 4)];
		const bytes = writeKtx2(
			{
				vkFormat: VkFormat.BC7_SRGB_BLOCK,
				width: 8,
				height: 8,
				depth: 0,
				layerCount: 0,
				faceCount: 1,
				levels,
			},
			{ writer: 'test' },
		);
		const container = read(bytes);
		assert.equal(container.vkFormat, VkFormat.BC7_SRGB_BLOCK);
		assert.equal(container.typeSize, 1);
		assert.equal(container.pixelWidth, 8);
		assert.equal(container.pixelHeight, 8);
		assert.equal(container.layerCount, 0);
		assert.equal(container.faceCount, 1);
		assert.equal(container.supercompressionScheme, 0);
		assert.deepEqual(
			container.levels.map((level) => Array.from(level.levelData)),
			levels.map((level) => Array.from(level)),
		);
		const [dfd] = container.dataFormatDescriptor;
		assert.equal(dfd.colorModel, 134);
		assert.equal(dfd.transferFunction, 2);
		assert.deepEqual(dfd.texelBlockDimension, [3, 3, 0, 0]);
		assert.equal(dfd.bytesPlane[0], 16);
		assert.equal(dfd.samples.length, 1);
		assert.equal(dfd.samples[0].bitLength, 127);
		assert.deepEqual(container.keyValue, { KTXorientation: 'ru', KTXwriter: 'test' });

		// level data is aligned to the 16-byte block and stored smallest level first
		const view = new DataView(bytes.buffer);
		const offsets = [0, 1, 2, 3].map((level) => Number(view.getBigUint64(80 + level * 24, true)));
		assert.ok(offsets.every((offset) => offset % 16 === 0));
		assert.ok(offsets[3] < offsets[2] && offsets[2] < offsets[1] && offsets[1] < offsets[0]);
	});

	it('supercompresses each level and records uncompressed lengths', () => {
		// a stand-in compressor: the container just stores what it returns
		const fake = (data: Uint8Array): Uint8Array => data.subarray(0, 3);
		const face = 4 * 4 * 8;
		const levels = [filled(face * 6, 5), filled(2 * 2 * 8 * 6, 6), filled(8 * 6, 7)];
		const container = read(
			writeKtx2(
				{
					vkFormat: VkFormat.R16G16B16A16_SFLOAT,
					width: 4,
					height: 4,
					depth: 0,
					layerCount: 0,
					faceCount: 6,
					levels,
					metadata: { custom: 'x' },
				},
				{ writer: 'test', zstd: fake },
			),
		);
		assert.equal(container.supercompressionScheme, 2);
		assert.equal(container.typeSize, 2);
		assert.equal(container.faceCount, 6);
		assert.deepEqual(
			container.levels.map((level) => [level.levelData.length, level.uncompressedByteLength]),
			levels.map((level) => [3, level.length]),
		);
		const [dfd] = container.dataFormatDescriptor;
		assert.equal(dfd.colorModel, 1);
		assert.equal(dfd.bytesPlane[0], 8);
		assert.deepEqual(
			dfd.samples.map((sample) => [sample.bitOffset, sample.bitLength, sample.channelType]),
			[
				[0, 15, 0xc0],
				[16, 15, 0xc1],
				[32, 15, 0xc2],
				[48, 15, 0xcf],
			],
		);
		// ktx-parse only decodes the standard keys; others come back as raw bytes including the NUL
		assert.deepEqual([...(container.keyValue.custom as Uint8Array)], [0x78, 0]);
	});

	it('rejects unsupported formats and mis-sized levels', () => {
		const texture = { vkFormat: 1, width: 4, height: 4, depth: 0, layerCount: 0, faceCount: 1, levels: [] };
		assert.throws(() => writeKtx2(texture, { writer: 'test' }), FormatError);
		assert.throws(
			() =>
				writeKtx2(
					{ ...texture, vkFormat: VkFormat.BC5_UNORM_BLOCK, levels: [new Uint8Array(15)] },
					{ writer: 'test' },
				),
			/expected 16/,
		);
	});
});

describe('imageByteLength', () => {
	it('rounds partial blocks up and clamps to one texel', () => {
		const bc1 = ktx2FormatInfo(VkFormat.BC1_RGBA_UNORM_BLOCK);
		const rgba = ktx2FormatInfo(VkFormat.R8G8B8A8_UNORM);
		assert.ok(bc1 !== undefined && rgba !== undefined);
		assert.equal(imageByteLength(bc1, 6, 2), 2 * 1 * 8);
		assert.equal(imageByteLength(bc1, 0, 0), 8);
		assert.equal(imageByteLength(rgba, 3, 0), 12);
	});
});
