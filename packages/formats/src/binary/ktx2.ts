/**
 * KTX 2.0 container writer for pre-encoded GPU data (BC passthrough and plain uncompressed formats). follows
 * the Khronos KTX 2.0 specification; data format descriptors are built the way KTX-Software's `dfdutils` lays
 * them out for each supported `VkFormat`. supercompression is optional and supplied by the caller, so this
 * module stays free of platform codecs.
 */

import { FormatError } from './binary-reader.ts';

// #region formats

/** the `VkFormat` values this writer can describe */
export const VkFormat = {
	R8_UNORM: 9,
	R8_SRGB: 15,
	R8G8_UNORM: 16,
	R8G8_SRGB: 22,
	R8G8B8A8_UNORM: 37,
	R8G8B8A8_SRGB: 43,
	B8G8R8A8_UNORM: 44,
	B8G8R8A8_SRGB: 50,
	R16_UNORM: 70,
	R16_SFLOAT: 76,
	R16G16_UNORM: 77,
	R16G16_SFLOAT: 83,
	R16G16B16A16_UNORM: 91,
	R16G16B16A16_SFLOAT: 97,
	R32_SFLOAT: 100,
	R32G32_SFLOAT: 103,
	R32G32B32A32_SFLOAT: 109,
	BC1_RGBA_UNORM_BLOCK: 133,
	BC1_RGBA_SRGB_BLOCK: 134,
	BC2_UNORM_BLOCK: 135,
	BC2_SRGB_BLOCK: 136,
	BC3_UNORM_BLOCK: 137,
	BC3_SRGB_BLOCK: 138,
	BC4_UNORM_BLOCK: 139,
	BC4_SNORM_BLOCK: 140,
	BC5_UNORM_BLOCK: 141,
	BC5_SNORM_BLOCK: 142,
	BC6H_UFLOAT_BLOCK: 143,
	BC6H_SFLOAT_BLOCK: 144,
	BC7_UNORM_BLOCK: 145,
	BC7_SRGB_BLOCK: 146,
} as const;

/** a DFD sample: `[bitOffset, bitLength, channelType, qualifiers, sampleLower, sampleUpper]` */
type Sample = [number, number, number, number, number, number];

/** layout facts about a format, enough for the header, level sizes and the DFD */
export interface Ktx2FormatInfo {
	vkFormat: number;
	/** the matching WebGPU `GPUTextureFormat`, or `undefined` if WebGPU lacks the format */
	gpuFormat: string | undefined;
	/** texel block size; 1×1 for uncompressed formats */
	blockWidth: number;
	blockHeight: number;
	blockBytes: number;
	/** 1 for block-compressed and 8-bit formats, else the component size */
	typeSize: number;
	srgb: boolean;
	/** DFD colour model */
	model: number;
	samples: Sample[];
}

// DFD constants (KHR_DF_*)
const MODEL_RGBSDA = 1;
const MODEL_BC1A = 128;
const MODEL_BC2 = 129;
const MODEL_BC3 = 130;
const MODEL_BC4 = 131;
const MODEL_BC5 = 132;
const MODEL_BC6H = 133;
const MODEL_BC7 = 134;
const TRANSFER_LINEAR = 1;
const TRANSFER_SRGB = 2;
const PRIMARIES_BT709 = 1;
const CHANNEL_R = 0;
const CHANNEL_G = 1;
const CHANNEL_B = 2;
const CHANNEL_A = 15;
const QUALIFIER_LINEAR = 0x1;
const QUALIFIER_SIGNED = 0x4;
const QUALIFIER_FLOAT = 0x8;
const FLOAT_ONE = 0x3f800000;
const FLOAT_MINUS_ONE = 0xbf800000;
const FULL = 0xffffffff;

const block = (
	vkFormat: number,
	gpuFormat: string,
	model: number,
	blockBytes: number,
	srgb: boolean,
	samples: Sample[],
): Ktx2FormatInfo => {
	return {
		vkFormat,
		gpuFormat,
		blockWidth: 4,
		blockHeight: 4,
		blockBytes,
		typeSize: 1,
		srgb,
		model,
		samples,
	};
};

/** an 8-bit-per-channel unorm format with channels in the given bit order */
const unorm8 = (
	vkFormat: number,
	gpuFormat: string | undefined,
	channels: number[],
	srgb: boolean,
): Ktx2FormatInfo => {
	return {
		vkFormat,
		gpuFormat,
		blockWidth: 1,
		blockHeight: 1,
		blockBytes: channels.length,
		typeSize: 1,
		srgb,
		model: MODEL_RGBSDA,
		samples: channels.map((channel, i) => [
			i * 8,
			8,
			channel,
			srgb && channel === CHANNEL_A ? QUALIFIER_LINEAR : 0,
			0,
			255,
		]),
	};
};

const unorm16 = (vkFormat: number, gpuFormat: string, count: number): Ktx2FormatInfo => {
	return {
		vkFormat,
		gpuFormat,
		blockWidth: 1,
		blockHeight: 1,
		blockBytes: count * 2,
		typeSize: 2,
		srgb: false,
		model: MODEL_RGBSDA,
		samples: RGBA.slice(0, count).map((channel, i) => [i * 16, 16, channel, 0, 0, 65535]),
	};
};

const sfloat = (vkFormat: number, gpuFormat: string, count: number, size: 2 | 4): Ktx2FormatInfo => {
	return {
		vkFormat,
		gpuFormat,
		blockWidth: 1,
		blockHeight: 1,
		blockBytes: count * size,
		typeSize: size,
		srgb: false,
		model: MODEL_RGBSDA,
		samples: RGBA.slice(0, count).map((channel, i) => [
			i * size * 8,
			size * 8,
			channel,
			QUALIFIER_FLOAT | QUALIFIER_SIGNED,
			FLOAT_MINUS_ONE,
			FLOAT_ONE,
		]),
	};
};

const RGBA = [CHANNEL_R, CHANNEL_G, CHANNEL_B, CHANNEL_A];

const FORMATS: ReadonlyMap<number, Ktx2FormatInfo> = new Map(
	[
		// WebGPU has no sRGB variants of the one- and two-channel 8-bit formats
		unorm8(VkFormat.R8_UNORM, 'r8unorm', [CHANNEL_R], false),
		unorm8(VkFormat.R8_SRGB, undefined, [CHANNEL_R], true),
		unorm8(VkFormat.R8G8_UNORM, 'rg8unorm', [CHANNEL_R, CHANNEL_G], false),
		unorm8(VkFormat.R8G8_SRGB, undefined, [CHANNEL_R, CHANNEL_G], true),
		unorm8(VkFormat.R8G8B8A8_UNORM, 'rgba8unorm', RGBA, false),
		unorm8(VkFormat.R8G8B8A8_SRGB, 'rgba8unorm-srgb', RGBA, true),
		unorm8(VkFormat.B8G8R8A8_UNORM, 'bgra8unorm', [CHANNEL_B, CHANNEL_G, CHANNEL_R, CHANNEL_A], false),
		unorm8(VkFormat.B8G8R8A8_SRGB, 'bgra8unorm-srgb', [CHANNEL_B, CHANNEL_G, CHANNEL_R, CHANNEL_A], true),
		unorm16(VkFormat.R16_UNORM, 'r16unorm', 1),
		unorm16(VkFormat.R16G16_UNORM, 'rg16unorm', 2),
		unorm16(VkFormat.R16G16B16A16_UNORM, 'rgba16unorm', 4),
		sfloat(VkFormat.R16_SFLOAT, 'r16float', 1, 2),
		sfloat(VkFormat.R16G16_SFLOAT, 'rg16float', 2, 2),
		sfloat(VkFormat.R16G16B16A16_SFLOAT, 'rgba16float', 4, 2),
		sfloat(VkFormat.R32_SFLOAT, 'r32float', 1, 4),
		sfloat(VkFormat.R32G32_SFLOAT, 'rg32float', 2, 4),
		sfloat(VkFormat.R32G32B32A32_SFLOAT, 'rgba32float', 4, 4),
		// BC1 with punch-through alpha is the only BC1 WebGPU exposes; the alpha sample shares the colour bits
		block(VkFormat.BC1_RGBA_UNORM_BLOCK, 'bc1-rgba-unorm', MODEL_BC1A, 8, false, [
			[0, 64, 0, 0, 0, FULL],
			[0, 64, CHANNEL_A, 0, 0, FULL],
		]),
		block(VkFormat.BC1_RGBA_SRGB_BLOCK, 'bc1-rgba-unorm-srgb', MODEL_BC1A, 8, true, [
			[0, 64, 0, 0, 0, FULL],
			[0, 64, CHANNEL_A, QUALIFIER_LINEAR, 0, FULL],
		]),
		block(VkFormat.BC2_UNORM_BLOCK, 'bc2-rgba-unorm', MODEL_BC2, 16, false, [
			[0, 64, CHANNEL_A, 0, 0, FULL],
			[64, 64, 0, 0, 0, FULL],
		]),
		block(VkFormat.BC2_SRGB_BLOCK, 'bc2-rgba-unorm-srgb', MODEL_BC2, 16, true, [
			[0, 64, CHANNEL_A, QUALIFIER_LINEAR, 0, FULL],
			[64, 64, 0, 0, 0, FULL],
		]),
		block(VkFormat.BC3_UNORM_BLOCK, 'bc3-rgba-unorm', MODEL_BC3, 16, false, [
			[0, 64, CHANNEL_A, 0, 0, FULL],
			[64, 64, 0, 0, 0, FULL],
		]),
		block(VkFormat.BC3_SRGB_BLOCK, 'bc3-rgba-unorm-srgb', MODEL_BC3, 16, true, [
			[0, 64, CHANNEL_A, QUALIFIER_LINEAR, 0, FULL],
			[64, 64, 0, 0, 0, FULL],
		]),
		block(VkFormat.BC4_UNORM_BLOCK, 'bc4-r-unorm', MODEL_BC4, 8, false, [[0, 64, 0, 0, 0, FULL]]),
		block(VkFormat.BC4_SNORM_BLOCK, 'bc4-r-snorm', MODEL_BC4, 8, false, [
			[0, 64, 0, QUALIFIER_SIGNED, 0x80000000, 0x7fffffff],
		]),
		block(VkFormat.BC5_UNORM_BLOCK, 'bc5-rg-unorm', MODEL_BC5, 16, false, [
			[0, 64, CHANNEL_R, 0, 0, FULL],
			[64, 64, CHANNEL_G, 0, 0, FULL],
		]),
		block(VkFormat.BC5_SNORM_BLOCK, 'bc5-rg-snorm', MODEL_BC5, 16, false, [
			[0, 64, CHANNEL_R, QUALIFIER_SIGNED, 0x80000000, 0x7fffffff],
			[64, 64, CHANNEL_G, QUALIFIER_SIGNED, 0x80000000, 0x7fffffff],
		]),
		block(VkFormat.BC6H_UFLOAT_BLOCK, 'bc6h-rgb-ufloat', MODEL_BC6H, 16, false, [
			[0, 128, 0, QUALIFIER_FLOAT, 0, FLOAT_ONE],
		]),
		block(VkFormat.BC6H_SFLOAT_BLOCK, 'bc6h-rgb-float', MODEL_BC6H, 16, false, [
			[0, 128, 0, QUALIFIER_FLOAT | QUALIFIER_SIGNED, FLOAT_MINUS_ONE, FLOAT_ONE],
		]),
		block(VkFormat.BC7_UNORM_BLOCK, 'bc7-rgba-unorm', MODEL_BC7, 16, false, [[0, 128, 0, 0, 0, FULL]]),
		block(VkFormat.BC7_SRGB_BLOCK, 'bc7-rgba-unorm-srgb', MODEL_BC7, 16, true, [[0, 128, 0, 0, 0, FULL]]),
	].map((info) => [info.vkFormat, info]),
);

/**
 * @param vkFormat a `VkFormat` value
 * @returns its layout facts, or `undefined` if this writer doesn't support it
 */
export const ktx2FormatInfo = (vkFormat: number): Ktx2FormatInfo | undefined => {
	return FORMATS.get(vkFormat);
};

/**
 * @param info format facts
 * @param width level width in texels
 * @param height level height in texels
 * @returns the byte size of one 2D image (one layer, face and slice) of that level
 */
export const imageByteLength = (info: Ktx2FormatInfo, width: number, height: number): number => {
	return (
		Math.ceil(Math.max(1, width) / info.blockWidth) *
		Math.ceil(Math.max(1, height) / info.blockHeight) *
		info.blockBytes
	);
};

// #endregion

// #region writer

/** a texture in KTX2's level-major order */
export interface Ktx2Texture {
	vkFormat: number;
	width: number;
	height: number;
	/** 0 for 2D textures */
	depth: number;
	/** 0 for non-array textures */
	layerCount: number;
	/** 6 for cubemaps, else 1 */
	faceCount: number;
	/**
	 * mip levels, base level first. each level holds every layer, then within a layer every face, then every
	 * depth slice, tightly packed
	 */
	levels: Uint8Array[];
	/** extra key/value metadata, written after `KTXwriter` and `KTXorientation` in key order */
	metadata?: Record<string, string>;
	/** `KTXorientation`; Unity data starts at the bottom row, i.e. `ru` (the default) */
	orientation?: string;
}

/** options for {@link writeKtx2} */
export interface WriteKtx2Options {
	/** writer name for `KTXwriter` */
	writer: string;
	/** Zstandard compressor; when given, every level is supercompressed (scheme 2) */
	zstd?: (data: Uint8Array) => Uint8Array;
}

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
const HEADER_SIZE = 80;
const SUPERCOMPRESSION_ZSTD = 2;

/**
 * serializes a texture as KTX 2.0
 *
 * @param texture levels and layout
 * @param options writer name and optional supercompression
 * @returns the file bytes
 * @throws {FormatError} if the format is unsupported or a level has the wrong size
 */
export const writeKtx2 = (texture: Ktx2Texture, options: WriteKtx2Options): Uint8Array => {
	const info = ktx2FormatInfo(texture.vkFormat);
	if (info === undefined) {
		throw new FormatError(`VkFormat ${texture.vkFormat} isn't supported by the KTX2 writer`);
	}
	const images = Math.max(1, texture.layerCount) * texture.faceCount * Math.max(1, texture.depth);
	for (const [level, data] of texture.levels.entries()) {
		const expected =
			imageByteLength(info, texture.width >> level, texture.height >> level) *
			(images / Math.max(1, texture.depth)) *
			Math.max(1, texture.depth >> level);
		if (data.length !== expected) {
			throw new FormatError(`KTX2 level ${level} has ${data.length} bytes, expected ${expected}`);
		}
	}

	const dfd = dataFormatDescriptor(info);
	const entries: [string, string][] = [
		['KTXorientation', texture.orientation ?? (texture.height > 1 ? 'ru' : 'r')],
		['KTXwriter', options.writer],
		...Object.entries(texture.metadata ?? {}),
	];
	const metadata = entries.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const kvd = keyValueData(metadata);
	const stored = texture.levels.map((data) => (options.zstd === undefined ? data : options.zstd(data)));

	const levelCount = texture.levels.length;
	const levelIndexSize = levelCount * 24;
	const dfdOffset = HEADER_SIZE + levelIndexSize;
	const kvdOffset = dfdOffset + dfd.length;
	// level data alignment: lcm(texel block size, 4) uncompressed, none when supercompressed
	const alignment = options.zstd === undefined ? lcm(info.blockBytes, 4) : 1;
	let offset = kvdOffset + kvd.length;
	const offsets: number[] = Array.from({ length: levelCount });
	// smallest level first in the file
	for (let level = levelCount - 1; level >= 0; level--) {
		offset = Math.ceil(offset / alignment) * alignment;
		offsets[level] = offset;
		offset += stored[level].length;
	}

	const out = new Uint8Array(offset);
	const view = new DataView(out.buffer);
	out.set(IDENTIFIER, 0);
	const header = [
		texture.vkFormat,
		info.typeSize,
		texture.width,
		texture.height,
		texture.depth,
		texture.layerCount,
		texture.faceCount,
		levelCount,
		options.zstd === undefined ? 0 : SUPERCOMPRESSION_ZSTD,
		dfdOffset,
		dfd.length,
		kvdOffset,
		kvd.length,
	];
	for (const [i, value] of header.entries()) {
		view.setUint32(12 + i * 4, value, true);
	}
	// sgdByteOffset/Length stay 0 (no supercompression global data for zstd)
	for (let level = 0; level < levelCount; level++) {
		const at = HEADER_SIZE + level * 24;
		view.setBigUint64(at, BigInt(offsets[level]), true);
		view.setBigUint64(at + 8, BigInt(stored[level].length), true);
		view.setBigUint64(at + 16, BigInt(texture.levels[level].length), true);
	}
	out.set(dfd, dfdOffset);
	out.set(kvd, kvdOffset);
	for (let level = 0; level < levelCount; level++) {
		out.set(stored[level], offsets[level]);
	}
	return out;
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;

/** a basic DFD block for the format, prefixed with the total-size word */
const dataFormatDescriptor = (info: Ktx2FormatInfo): Uint8Array => {
	const blockSize = 24 + 16 * info.samples.length;
	const out = new Uint8Array(4 + blockSize);
	const view = new DataView(out.buffer);
	view.setUint32(0, out.length, true);
	// vendorId 0 (Khronos), descriptorType 0 (basic)
	view.setUint32(4, 0, true);
	// versionNumber 2 (KDF 1.3), descriptorBlockSize
	view.setUint32(8, 2 | (blockSize << 16), true);
	out[12] = info.model;
	out[13] = PRIMARIES_BT709;
	out[14] = info.srgb ? TRANSFER_SRGB : TRANSFER_LINEAR;
	// flags: straight alpha
	out[15] = 0;
	out[16] = info.blockWidth - 1;
	out[17] = info.blockHeight - 1;
	// bytesPlane0; uncompressed formats describe one texel
	out[20] = info.blockBytes;
	for (const [i, [bitOffset, bitLength, channel, qualifiers, lower, upper]] of info.samples.entries()) {
		const at = 28 + i * 16;
		view.setUint16(at, bitOffset, true);
		out[at + 2] = bitLength - 1;
		out[at + 3] = (channel & 0xf) | (qualifiers << 4);
		// sample positions stay 0 (the block origin)
		view.setUint32(at + 8, lower, true);
		view.setUint32(at + 12, upper, true);
	}
	return out;
};

const utf8 = new TextEncoder();

/** key/value pairs, each `u32 length ‖ key NUL value NUL`, padded to 4 */
const keyValueData = (entries: readonly [string, string][]): Uint8Array => {
	const parts = entries.map(([key, value]) => utf8.encode(`${key}\0${value}\0`));
	const size = parts.reduce((sum, part) => sum + 4 + Math.ceil(part.length / 4) * 4, 0);
	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);
	let at = 0;
	for (const part of parts) {
		view.setUint32(at, part.length, true);
		out.set(part, at + 4);
		at += 4 + Math.ceil(part.length / 4) * 4;
	}
	return out;
};

// #endregion
