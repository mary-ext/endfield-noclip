import { deflateSync } from 'node:zlib';

import { writeDds } from '@endfield-noclip/formats/binary/dds';
import { VkFormat, writeKtx2 } from '@endfield-noclip/formats/binary/ktx2';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { type DecodedTexture, toKtx2Texture } from '@endfield-noclip/formats/unity/texture';

import { loadTexture } from '../../../game/assets/asset-decode.ts';
import { objectKey } from '../../../game/assets/assets.ts';
import { withContext } from '../../../install/context.ts';
import { zstdSync } from '../../../util/zstd.ts';
import { collectTargets, save as saveFile } from '../../helpers.ts';

import type { InspectSubArgs } from './parser.ts';
import { resolveObjectArg } from './shared.ts';

/**
 * runs `endfield-extract inspect texture`
 *
 * @param args parsed CLI arguments
 */
export const runInspectTexture = async (args: InspectSubArgs<'texture'>): Promise<void> => {
	const targets = await collectTargets(args.targets, args.stdin);
	if (targets.length === 0) {
		throw new Error('inspect texture needs at least one target or --stdin');
	}
	if (args.output !== undefined && targets.length > 1) {
		throw new Error('-o cannot be used with multiple texture targets');
	}
	await withContext(args.config, async (context) => {
		const resolver = await context.resolver();
		const results = [];
		for (const raw of targets) {
			// oxlint-disable-next-line no-await-in-loop -- preserves target order
			const ref = await resolveObjectArg(context, resolver, raw, UnityClass.Texture2D, {
				pathId: args.pathId,
				nameFilter: args.name,
			});
			// oxlint-disable-next-line no-await-in-loop -- preserves target order
			const texture = await loadTexture(resolver, ref);
			results.push({ object: objectKey(ref), ...textureSummary(texture) });
			if (args.output !== undefined) {
				const lower = args.output.toLowerCase();
				let bytes: Uint8Array;
				if (lower.endsWith('.dds')) {
					bytes = writeDds(texture, { layer: args.layer, mip: args.mip });
				} else if (lower.endsWith('.ktx2')) {
					if (args.layer !== undefined || args.mip !== undefined) {
						throw new Error('--layer and --mip are only supported with .dds or .png output');
					}
					bytes = encodeKtx2(texture, args.zstd);
				} else if (lower.endsWith('.png')) {
					bytes = encodePng(texture, args.layer ?? 0, args.mip ?? 0);
				} else {
					throw new Error(
						`unsupported output extension for ${args.output}; use .ktx2, .dds, or .png (uncompressed 8-bit formats only)`,
					);
				}
				// oxlint-disable-next-line no-await-in-loop -- single target when -o is set
				await saveFile(args.output, bytes);
				console.error(`wrote ${bytes.length} bytes to ${args.output}`);
			}
		}
		console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, '\t'));
	});
};

const textureSummary = (texture: DecodedTexture) => ({
	name: texture.name,
	kind: texture.kind,
	size: [texture.width, texture.height, texture.depth],
	layers: texture.layers,
	faces: texture.faces,
	mipCount: texture.mipCount,
	format: texture.format,
	vkFormat: texture.vkFormat,
	srgb: texture.srgb,
	colorSpace: texture.colorSpace,
	sampler: texture.sampler,
	levelBytes: texture.levels.map((level) => level.length),
});

const encodeKtx2 = (texture: DecodedTexture, level: number | undefined): Uint8Array =>
	writeKtx2(toKtx2Texture(texture), {
		writer: 'endfield-noclip extractor',
		zstd: level === undefined ? undefined : (data) => zstdSync(data, level),
	});

// #region minimal PNG encoder for uncompressed 8-bit textures

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

const crc32 = (bytes: Uint8Array): number => {
	let c = 0xffffffff;
	for (const b of bytes) {
		c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
	const out = new Uint8Array(12 + data.length);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, data.length, false);
	for (let i = 0; i < 4; i++) {
		out[4 + i] = type.charCodeAt(i);
	}
	out.set(data, 8);
	dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
	return out;
};

const encodePng = (texture: DecodedTexture, layer: number, mip: number): Uint8Array => {
	if (mip < 0 || mip >= texture.levels.length) {
		throw new Error(`mip ${mip} is out of range (0..${texture.levels.length - 1})`);
	}
	const slices = Math.max(1, texture.layers) * Math.max(1, texture.faces) * Math.max(1, texture.depth >> mip);
	if (layer < 0 || layer >= slices) {
		throw new Error(`layer ${layer} is out of range (0..${slices - 1})`);
	}
	const width = Math.max(1, texture.width >> mip);
	const height = Math.max(1, texture.height >> mip);
	const levelBytes = texture.levels[mip];
	const sliceSize = levelBytes.length / slices;
	const src = levelBytes.subarray(layer * sliceSize, (layer + 1) * sliceSize);

	const rgba = new Uint8Array(width * height * 4);
	switch (texture.vkFormat) {
		case VkFormat.R8G8B8A8_UNORM:
		case VkFormat.R8G8B8A8_SRGB: {
			rgba.set(src.subarray(0, rgba.length));
			break;
		}
		case VkFormat.B8G8R8A8_UNORM:
		case VkFormat.B8G8R8A8_SRGB: {
			for (let i = 0; i < rgba.length; i += 4) {
				rgba[i] = src[i + 2];
				rgba[i + 1] = src[i + 1];
				rgba[i + 2] = src[i];
				rgba[i + 3] = src[i + 3];
			}
			break;
		}
		case VkFormat.R8G8_UNORM:
		case VkFormat.R8G8_SRGB: {
			for (let p = 0; p < width * height; p++) {
				rgba[p * 4] = src[p * 2];
				rgba[p * 4 + 1] = src[p * 2 + 1];
				rgba[p * 4 + 2] = 0;
				rgba[p * 4 + 3] = 255;
			}
			break;
		}
		case VkFormat.R8_UNORM:
		case VkFormat.R8_SRGB: {
			for (let p = 0; p < width * height; p++) {
				const v = src[p];
				rgba[p * 4] = v;
				rgba[p * 4 + 1] = v;
				rgba[p * 4 + 2] = v;
				rgba[p * 4 + 3] = 255;
			}
			break;
		}
		default: {
			throw new Error(
				`.png export only supports uncompressed 8-bit formats (got ${texture.format.name}, VkFormat ${texture.vkFormat}); export as .dds or .ktx2 instead`,
			);
		}
	}

	const stride = width * 4;
	const raw = new Uint8Array(height * (1 + stride));
	for (let y = 0; y < height; y++) {
		const dstRow = y * (1 + stride);
		raw[dstRow] = 0;
		raw.set(rgba.subarray(y * stride, (y + 1) * stride), dstRow + 1);
	}
	const ihdr = new Uint8Array(13);
	const ihdrDv = new DataView(ihdr.buffer);
	ihdrDv.setUint32(0, width, false);
	ihdrDv.setUint32(4, height, false);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const chunks = [
		PNG_SIG,
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', deflateSync(raw)),
		pngChunk('IEND', new Uint8Array(0)),
	];
	const total = chunks.reduce((sum, c) => sum + c.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
};

// #endregion
