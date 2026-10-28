import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';
import { VkFormat } from '../binary/ktx2.ts';

import { decodeTexture, TextureClass, toKtx2Texture } from './texture.ts';
import type { TypeTreeObject } from './type-tree.ts';
import { streamingInfo } from './values.ts';

const SETTINGS: TypeTreeObject = {
	m_FilterMode: 2,
	m_Aniso: 4,
	m_MipBias: 0,
	m_WrapU: 1,
	m_WrapV: 0,
	m_WrapW: 0,
};

const texture2d = (fields: TypeTreeObject): TypeTreeObject => {
	return {
		m_Name: 'tex',
		m_Width: 8,
		m_Height: 8,
		m_MipsStripped: 0,
		m_TextureFormat: 25,
		m_MipCount: 3,
		m_ImageCount: 1,
		m_TextureDimension: 2,
		m_TextureSettings: SETTINGS,
		m_ColorSpace: 1,
		'image data': new Uint8Array(0),
		m_StreamData: { offset: 0n, size: 0, path: '' },
		...fields,
	};
};

/** `images` chains of per-level sizes, each level filled with `image * 16 + level` */
const chains = (images: number, sizes: number[]): Uint8Array => {
	const chain = sizes.reduce((sum, size) => sum + size, 0);
	const out = new Uint8Array(images * chain);
	for (let image = 0; image < images; image++) {
		let at = image * chain;
		for (const [level, size] of sizes.entries()) {
			out.fill(image * 16 + level, at, at + size);
			at += size;
		}
	}
	return out;
};

describe('decodeTexture', () => {
	it('splits a BC7 Texture2D into levels and honours m_ColorSpace', () => {
		const data = chains(1, [64, 16, 16]);
		const srgb = decodeTexture(TextureClass.Texture2D, texture2d({ 'image data': data }), undefined);
		assert.equal(srgb.kind, '2d');
		assert.equal(srgb.vkFormat, VkFormat.BC7_SRGB_BLOCK);
		assert.equal(srgb.srgb, true);
		assert.deepEqual(srgb.format, { enum: 'TextureFormat', value: 25, name: 'BC7' });
		assert.deepEqual(
			srgb.levels.map((level) => [level.length, level[0]]),
			[
				[64, 0],
				[16, 1],
				[16, 2],
			],
		);
		assert.deepEqual(srgb.sampler, {
			filterMode: 2,
			aniso: 4,
			mipBias: 0,
			wrapU: 1,
			wrapV: 0,
			wrapW: 0,
		});

		const linear = decodeTexture(
			TextureClass.Texture2D,
			texture2d({ 'image data': data, m_ColorSpace: 0 }),
			undefined,
		);
		assert.equal(linear.vkFormat, VkFormat.BC7_UNORM_BLOCK);
		// BC5 has no sRGB variant whatever the colour space says
		const bc5 = decodeTexture(
			TextureClass.Texture2D,
			texture2d({ 'image data': data, m_TextureFormat: 27 }),
			undefined,
		);
		assert.equal(bc5.vkFormat, VkFormat.BC5_UNORM_BLOCK);
		assert.equal(bc5.srgb, false);
	});

	it('regroups cubemap faces into level-major order', () => {
		const data = chains(6, [16, 16]);
		const streamed = texture2d({
			m_Width: 4,
			m_Height: 4,
			m_TextureFormat: 24,
			m_MipCount: 2,
			m_ImageCount: 6,
			m_StreamData: { offset: 0n, size: data.length, path: 'archive:/CAB-x/CAB-x.resS' },
		});
		assert.ok(streamingInfo(streamed) !== undefined);
		assert.throws(() => decodeTexture(TextureClass.Cubemap, streamed, undefined), /no stream data/);
		const decoded = decodeTexture(TextureClass.Cubemap, streamed, data);
		assert.equal(decoded.kind, 'cube');
		assert.equal(decoded.faces, 6);
		assert.equal(decoded.vkFormat, VkFormat.BC6H_UFLOAT_BLOCK);
		assert.deepEqual(
			decoded.levels.map((level) => Array.from({ length: 6 }, (_, face) => level[face * 16])),
			[
				[0, 16, 32, 48, 64, 80],
				[1, 17, 33, 49, 65, 81],
			],
		);
		const ktx = toKtx2Texture(decoded);
		assert.equal(ktx.faceCount, 6);
		assert.equal(ktx.layerCount, 0);
	});

	it('reads Texture2DArray GraphicsFormats, which carry sRGB themselves', () => {
		const array = decodeTexture(
			TextureClass.Texture2DArray,
			{
				m_Name: 'array',
				m_ColorSpace: 1,
				m_Format: 109,
				m_Width: 4,
				m_Height: 4,
				m_Depth: 3,
				m_MipCount: 2,
				m_DataSize: 96,
				m_TextureSettings: SETTINGS,
				'image data': chains(3, [16, 16]),
				m_StreamData: { offset: 0n, size: 0, path: '' },
			},
			undefined,
		);
		assert.equal(array.kind, '2d-array');
		assert.equal(array.layers, 3);
		assert.equal(array.srgb, false);
		assert.equal(array.vkFormat, VkFormat.BC7_UNORM_BLOCK);
		assert.deepEqual(
			[...array.levels[1]].filter((_, i) => i % 16 === 0),
			[1, 17, 33],
		);
		assert.equal(toKtx2Texture(array).layerCount, 3);
	});

	it('converts ARGB32 to RGBA8', () => {
		const argb = decodeTexture(
			TextureClass.Texture2D,
			texture2d({
				m_Width: 1,
				m_Height: 1,
				m_MipCount: 1,
				m_TextureFormat: 5,
				m_ColorSpace: 0,
				'image data': new Uint8Array([4, 1, 2, 3]),
			}),
			undefined,
		);
		assert.equal(argb.vkFormat, VkFormat.R8G8B8A8_UNORM);
		assert.deepEqual([...argb.levels[0]], [1, 2, 3, 4]);
	});

	it('rejects unknown formats and mis-sized data', () => {
		assert.throws(
			() => decodeTexture(TextureClass.Texture2D, texture2d({ m_TextureFormat: 999 }), undefined),
			FormatError,
		);
		assert.throws(
			() => decodeTexture(TextureClass.Texture2D, texture2d({ 'image data': new Uint8Array(95) }), undefined),
			/needs 96/,
		);
		assert.throws(() => decodeTexture(43, texture2d({}), undefined), /isn't a supported texture class/);
	});
});
