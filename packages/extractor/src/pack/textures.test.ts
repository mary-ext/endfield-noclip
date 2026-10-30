import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VkFormat } from '@endfield-noclip/formats/binary/ktx2';
import type { DecodedTexture } from '@endfield-noclip/formats/unity/texture';
import { TEXTURE_TAIL_BYTES } from '@endfield-noclip/package-format/format';

import { convertTexture, splitLevels } from './textures.ts';

/** a BC7 chain (1 byte per texel, 16-byte minimum per level) filled with its level number */
const bc7Levels = (size: number, layers = 1): Uint8Array[] => {
	const levels: Uint8Array[] = [];
	for (let level = 0; size >> level >= 1; level++) {
		const blocks = Math.ceil((size >> level) / 4) ** 2;
		levels.push(new Uint8Array(blocks * 16 * layers).fill(level));
	}
	return levels;
};

const texture = (overrides: Partial<DecodedTexture>): DecodedTexture => {
	const levels = overrides.levels ?? bc7Levels(2048);
	return {
		kind: '2d',
		name: 'test',
		width: 2048,
		height: 2048,
		depth: 1,
		layers: 1,
		faces: 1,
		mipCount: levels.length,
		format: { enum: 'TextureFormat', value: 25, name: 'BC7' },
		srgb: true,
		colorSpace: 1,
		sampler: { filterMode: 2, aniso: 4, mipBias: -0.5, wrapU: 0, wrapV: 1, wrapW: 3 },
		vkFormat: VkFormat.BC7_SRGB_BLOCK,
		levels,
		...overrides,
	};
};

describe('splitLevels', () => {
	it('puts BC7 levels up to 128² in the tail and every larger level alone', () => {
		const levels = bc7Levels(2048);
		const pieces = splitLevels(levels);
		assert.deepEqual(
			pieces.map(({ firstLevel, levelCount }) => [firstLevel, levelCount]),
			[
				[4, 8],
				[3, 1],
				[2, 1],
				[1, 1],
				[0, 1],
			],
		);
		// the tail is its levels concatenated, largest first
		const tail = pieces[0].data;
		assert.ok(tail.byteLength <= TEXTURE_TAIL_BYTES);
		assert.equal(
			tail.byteLength,
			levels.slice(4).reduce((sum, level) => sum + level.byteLength, 0),
		);
		assert.equal(tail[0], 4);
		assert.equal(tail.at(-1), 11);
		assert.equal(pieces[4].data, levels[0]);
	});

	it('keeps a small texture in one piece and a huge last level alone', () => {
		assert.deepEqual(
			splitLevels(bc7Levels(64)).map(({ firstLevel, levelCount }) => [firstLevel, levelCount]),
			[[0, 7]],
		);
		const big = [new Uint8Array(TEXTURE_TAIL_BYTES * 2), new Uint8Array(TEXTURE_TAIL_BYTES + 1)];
		assert.deepEqual(
			splitLevels(big).map(({ firstLevel, levelCount }) => [firstLevel, levelCount]),
			[
				[1, 1],
				[0, 1],
			],
		);
	});
});

describe('convertTexture', () => {
	it('maps format, shape and sampler to WebGPU terms', () => {
		const { entry, pieces } = convertTexture(texture({}));
		assert.deepEqual(entry, {
			kind: '2d',
			format: 'bc7-rgba-unorm-srgb',
			width: 2048,
			height: 2048,
			depthOrArrayLayers: 1,
			mipCount: 12,
			sampler: {
				addressModeU: 'repeat',
				addressModeV: 'clamp-to-edge',
				addressModeW: 'mirror-repeat',
				magFilter: 'linear',
				minFilter: 'linear',
				mipmapFilter: 'linear',
				maxAnisotropy: 4,
				mipBias: -0.5,
			},
		});
		assert.equal(pieces.length, 5);
	});

	it('counts array layers and cube faces, and keys content', () => {
		const levels = bc7Levels(256, 12);
		const cubeArray = texture({ kind: 'cube-array', width: 256, height: 256, layers: 2, faces: 6, levels });
		const a = convertTexture(cubeArray);
		assert.equal(a.entry.depthOrArrayLayers, 12);
		// equal content and sampler: equal key; a different sampler: a different key
		assert.equal(convertTexture({ ...cubeArray, name: 'other' }).contentKey, a.contentKey);
		const pointSampled = { ...cubeArray, sampler: { ...cubeArray.sampler, filterMode: 0 } };
		const point = convertTexture(pointSampled);
		assert.notEqual(point.contentKey, a.contentKey);
		assert.equal(point.entry.sampler.maxAnisotropy, 1);
	});

	it('rejects levels that don’t match the layout and formats WebGPU lacks', () => {
		const levels = bc7Levels(2048);
		levels[3] = levels[3].subarray(1);
		assert.throws(() => convertTexture(texture({ levels })), /level 3/);
		assert.throws(() => convertTexture(texture({ vkFormat: VkFormat.R8_SRGB })), /no WebGPU format/);
	});
});
