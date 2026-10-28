/**
 * Unity texture decoders (`Texture2D` 28, `Cubemap` 89, `Texture2DArray` 187, `CubemapArray` 188, `Texture3D` 117)
 * for Unity 2021.3: format, colour space, sampler state and the raw mip chain, regrouped into KTX2's
 * level-major order. pixel data isn't decoded; BC blocks pass through unchanged.
 *
 * Unity's serialized layouts: a Texture2D/Cubemap stores each image (face) with its whole mip chain, largest
 * first, images one after another; a Texture2DArray stores each slice the same way; a Texture3D stores each
 * mip as all of its depth slices. `Texture2D`-family classes name their format with `TextureFormat`, the
 * array and 3D classes with `GraphicsFormat`, which also encodes sRGB.
 */

import { FormatError } from '../binary/binary-reader.ts';
import { imageByteLength, ktx2FormatInfo, type Ktx2Texture, VkFormat } from '../binary/ktx2.ts';

import type { TypeTreeObject } from './type-tree.ts';
import {
	bytesField,
	numberField,
	objectField,
	optionalNumberField,
	streamingInfo,
	stringField,
} from './values.ts';

// #region formats

/** Unity class ids of texture classes */
export const TextureClass = {
	Texture2D: 28,
	Cubemap: 89,
	Texture3D: 117,
	Texture2DArray: 187,
	CubemapArray: 188,
} as const;

/** a source format and how it maps onto KTX2 */
interface SourceFormat {
	name: string;
	/** `VkFormat` for linear data */
	linear: number;
	/** `VkFormat` for sRGB data, if the format has an sRGB variant */
	srgb?: number;
	/** rewrites source texels into the `VkFormat`'s layout, for formats without a direct match */
	convert?: (data: Uint8Array) => Uint8Array;
	/** bytes per texel of the source layout when it differs from the `VkFormat`'s */
	sourceTexelBytes?: number;
}

const argbToRgba = (data: Uint8Array): Uint8Array => {
	const out = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i += 4) {
		out[i] = data[i + 1];
		out[i + 1] = data[i + 2];
		out[i + 2] = data[i + 3];
		out[i + 3] = data[i];
	}
	return out;
};

const rgbToRgba = (data: Uint8Array): Uint8Array => {
	const out = new Uint8Array((data.length / 3) * 4);
	for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
		out[o] = data[i];
		out[o + 1] = data[i + 1];
		out[o + 2] = data[i + 2];
		out[o + 3] = 255;
	}
	return out;
};

/** Unity `TextureFormat` values with a KTX2 mapping */
const TEXTURE_FORMATS: ReadonlyMap<number, SourceFormat> = new Map([
	[1, { name: 'Alpha8', linear: VkFormat.R8_UNORM }],
	[
		3,
		{
			name: 'RGB24',
			linear: VkFormat.R8G8B8A8_UNORM,
			srgb: VkFormat.R8G8B8A8_SRGB,
			convert: rgbToRgba,
			sourceTexelBytes: 3,
		},
	],
	[4, { name: 'RGBA32', linear: VkFormat.R8G8B8A8_UNORM, srgb: VkFormat.R8G8B8A8_SRGB }],
	[5, { name: 'ARGB32', linear: VkFormat.R8G8B8A8_UNORM, srgb: VkFormat.R8G8B8A8_SRGB, convert: argbToRgba }],
	[9, { name: 'R16', linear: VkFormat.R16_UNORM }],
	[10, { name: 'DXT1', linear: VkFormat.BC1_RGBA_UNORM_BLOCK, srgb: VkFormat.BC1_RGBA_SRGB_BLOCK }],
	[12, { name: 'DXT5', linear: VkFormat.BC3_UNORM_BLOCK, srgb: VkFormat.BC3_SRGB_BLOCK }],
	[14, { name: 'BGRA32', linear: VkFormat.B8G8R8A8_UNORM, srgb: VkFormat.B8G8R8A8_SRGB }],
	[15, { name: 'RHalf', linear: VkFormat.R16_SFLOAT }],
	[16, { name: 'RGHalf', linear: VkFormat.R16G16_SFLOAT }],
	[17, { name: 'RGBAHalf', linear: VkFormat.R16G16B16A16_SFLOAT }],
	[18, { name: 'RFloat', linear: VkFormat.R32_SFLOAT }],
	[19, { name: 'RGFloat', linear: VkFormat.R32G32_SFLOAT }],
	[20, { name: 'RGBAFloat', linear: VkFormat.R32G32B32A32_SFLOAT }],
	[24, { name: 'BC6H', linear: VkFormat.BC6H_UFLOAT_BLOCK }],
	[25, { name: 'BC7', linear: VkFormat.BC7_UNORM_BLOCK, srgb: VkFormat.BC7_SRGB_BLOCK }],
	[26, { name: 'BC4', linear: VkFormat.BC4_UNORM_BLOCK }],
	[27, { name: 'BC5', linear: VkFormat.BC5_UNORM_BLOCK }],
	[62, { name: 'RG16', linear: VkFormat.R8G8_UNORM, srgb: VkFormat.R8G8_SRGB }],
	[63, { name: 'R8', linear: VkFormat.R8_UNORM, srgb: VkFormat.R8_SRGB }],
	[72, { name: 'RG32', linear: VkFormat.R16G16_UNORM }],
	[74, { name: 'RGBA64', linear: VkFormat.R16G16B16A16_UNORM }],
]);

/** Unity `GraphicsFormat` values with a KTX2 mapping; the sRGB variants are their own values */
const GRAPHICS_FORMATS: ReadonlyMap<number, SourceFormat & { isSrgb: boolean }> = new Map([
	[1, { name: 'R8_SRGB', linear: VkFormat.R8_SRGB, isSrgb: true }],
	[2, { name: 'R8G8_SRGB', linear: VkFormat.R8G8_SRGB, isSrgb: true }],
	[4, { name: 'R8G8B8A8_SRGB', linear: VkFormat.R8G8B8A8_SRGB, isSrgb: true }],
	[5, { name: 'R8_UNorm', linear: VkFormat.R8_UNORM, isSrgb: false }],
	[6, { name: 'R8G8_UNorm', linear: VkFormat.R8G8_UNORM, isSrgb: false }],
	[8, { name: 'R8G8B8A8_UNorm', linear: VkFormat.R8G8B8A8_UNORM, isSrgb: false }],
	[21, { name: 'R16_UNorm', linear: VkFormat.R16_UNORM, isSrgb: false }],
	[22, { name: 'R16G16_UNorm', linear: VkFormat.R16G16_UNORM, isSrgb: false }],
	[24, { name: 'R16G16B16A16_UNorm', linear: VkFormat.R16G16B16A16_UNORM, isSrgb: false }],
	[45, { name: 'R16_SFloat', linear: VkFormat.R16_SFLOAT, isSrgb: false }],
	[46, { name: 'R16G16_SFloat', linear: VkFormat.R16G16_SFLOAT, isSrgb: false }],
	[48, { name: 'R16G16B16A16_SFloat', linear: VkFormat.R16G16B16A16_SFLOAT, isSrgb: false }],
	[49, { name: 'R32_SFloat', linear: VkFormat.R32_SFLOAT, isSrgb: false }],
	[50, { name: 'R32G32_SFloat', linear: VkFormat.R32G32_SFLOAT, isSrgb: false }],
	[52, { name: 'R32G32B32A32_SFloat', linear: VkFormat.R32G32B32A32_SFLOAT, isSrgb: false }],
	[57, { name: 'B8G8R8A8_SRGB', linear: VkFormat.B8G8R8A8_SRGB, isSrgb: true }],
	[59, { name: 'B8G8R8A8_UNorm', linear: VkFormat.B8G8R8A8_UNORM, isSrgb: false }],
	[96, { name: 'RGBA_DXT1_SRGB', linear: VkFormat.BC1_RGBA_SRGB_BLOCK, isSrgb: true }],
	[97, { name: 'RGBA_DXT1_UNorm', linear: VkFormat.BC1_RGBA_UNORM_BLOCK, isSrgb: false }],
	[98, { name: 'RGBA_DXT3_SRGB', linear: VkFormat.BC2_SRGB_BLOCK, isSrgb: true }],
	[99, { name: 'RGBA_DXT3_UNorm', linear: VkFormat.BC2_UNORM_BLOCK, isSrgb: false }],
	[100, { name: 'RGBA_DXT5_SRGB', linear: VkFormat.BC3_SRGB_BLOCK, isSrgb: true }],
	[101, { name: 'RGBA_DXT5_UNorm', linear: VkFormat.BC3_UNORM_BLOCK, isSrgb: false }],
	[102, { name: 'R_BC4_UNorm', linear: VkFormat.BC4_UNORM_BLOCK, isSrgb: false }],
	[103, { name: 'R_BC4_SNorm', linear: VkFormat.BC4_SNORM_BLOCK, isSrgb: false }],
	[104, { name: 'RG_BC5_UNorm', linear: VkFormat.BC5_UNORM_BLOCK, isSrgb: false }],
	[105, { name: 'RG_BC5_SNorm', linear: VkFormat.BC5_SNORM_BLOCK, isSrgb: false }],
	[106, { name: 'RGB_BC6H_UFloat', linear: VkFormat.BC6H_UFLOAT_BLOCK, isSrgb: false }],
	[107, { name: 'RGB_BC6H_SFloat', linear: VkFormat.BC6H_SFLOAT_BLOCK, isSrgb: false }],
	[108, { name: 'RGBA_BC7_SRGB', linear: VkFormat.BC7_SRGB_BLOCK, isSrgb: true }],
	[109, { name: 'RGBA_BC7_UNorm', linear: VkFormat.BC7_UNORM_BLOCK, isSrgb: false }],
]);

/**
 * @param value a Unity `GraphicsFormat` value
 * @returns its name and `VkFormat`, or `undefined` if it has no KTX2 mapping
 */
export const graphicsFormatInfo = (value: number): { name: string; vkFormat: number } | undefined => {
	const known = GRAPHICS_FORMATS.get(value);
	return known === undefined ? undefined : { name: known.name, vkFormat: known.linear };
};

// #endregion

// #region types

/** texture shape */
export type TextureKind = '2d' | 'cube' | '2d-array' | 'cube-array' | '3d';

/** `GLTextureSettings`: Unity's sampler state */
export interface UnitySamplerSettings {
	/** 0 point, 1 bilinear, 2 trilinear */
	filterMode: number;
	aniso: number;
	mipBias: number;
	/** 0 repeat, 1 clamp, 2 mirror, 3 mirror-once */
	wrapU: number;
	wrapV: number;
	wrapW: number;
}

/** a texture's metadata and raw levels */
export interface DecodedTexture {
	kind: TextureKind;
	name: string;
	width: number;
	height: number;
	/** slices of a 3D texture; 1 otherwise */
	depth: number;
	/** array layers (cubemap arrays count cubes); 1 for non-arrays */
	layers: number;
	/** 6 for cubemaps and cubemap arrays, else 1 */
	faces: number;
	mipCount: number;
	/** the class's own format enum: `TextureFormat` for Texture2D/Cubemap, `GraphicsFormat` otherwise */
	format: { enum: 'TextureFormat' | 'GraphicsFormat'; value: number; name: string };
	/** whether colour samples are sRGB-encoded; from `m_ColorSpace` or the GraphicsFormat itself */
	srgb: boolean;
	/** `m_ColorSpace` as stored: 1 gamma (sRGB), 0 linear */
	colorSpace: number;
	sampler: UnitySamplerSettings;
	vkFormat: number;
	/** mip levels, base first; each holds every layer, face and slice in KTX2 order */
	levels: Uint8Array[];
}

// #endregion

// #region decoding

/**
 * decodes a texture's metadata and splits its data into levels
 *
 * @param classId the object's class id (see {@link TextureClass})
 * @param texture a decoded texture object
 * @param streamData the `m_StreamData` bytes, required when `streamingInfo` (`values.ts`) returns a value
 * @returns the texture
 * @throws {FormatError} on unsupported classes or formats, or data whose size doesn't match the layout
 */
export const decodeTexture = (
	classId: number,
	texture: TypeTreeObject,
	streamData: Uint8Array | undefined,
): DecodedTexture => {
	const name = stringField(texture, 'm_Name');
	let data: Uint8Array;
	if (streamingInfo(texture) === undefined) {
		data = bytesField(texture, 'image data');
	} else if (streamData === undefined) {
		throw new FormatError(`texture ${name} streams its data, but no stream data was given`);
	} else {
		data = streamData;
	}

	const settings = objectField(texture, 'm_TextureSettings');
	const sampler: UnitySamplerSettings = {
		filterMode: numberField(settings, 'm_FilterMode'),
		aniso: numberField(settings, 'm_Aniso'),
		mipBias: numberField(settings, 'm_MipBias'),
		wrapU: numberField(settings, 'm_WrapU'),
		wrapV: numberField(settings, 'm_WrapV'),
		wrapW: numberField(settings, 'm_WrapW'),
	};
	const colorSpace = optionalNumberField(texture, 'm_ColorSpace') ?? 1;
	const width = numberField(texture, 'm_Width');
	const height = numberField(texture, 'm_Height');
	const mipCount = Math.max(1, numberField(texture, 'm_MipCount'));

	let kind: TextureKind;
	let layers = 1;
	let faces = 1;
	let depth = 1;
	let source: SourceFormat;
	let format: DecodedTexture['format'];
	let srgb: boolean;
	switch (classId) {
		case TextureClass.Texture2D:
		case TextureClass.Cubemap: {
			const value = numberField(texture, 'm_TextureFormat');
			const known = TEXTURE_FORMATS.get(value);
			if (known === undefined) {
				throw new FormatError(`texture ${name} has unsupported TextureFormat ${value}`);
			}
			source = known;
			format = { enum: 'TextureFormat', value, name: known.name };
			srgb = colorSpace === 1 && known.srgb !== undefined;
			const imageCount = optionalNumberField(texture, 'm_ImageCount') ?? 1;
			if (classId === TextureClass.Cubemap || numberField(texture, 'm_TextureDimension') === 4) {
				if (imageCount !== 6) {
					throw new FormatError(`cubemap ${name} has ${imageCount} images`);
				}
				kind = 'cube';
				faces = 6;
			} else {
				kind = imageCount > 1 ? '2d-array' : '2d';
				layers = imageCount;
			}
			if ((optionalNumberField(texture, 'm_MipsStripped') ?? 0) > 0) {
				throw new FormatError(`texture ${name} has stripped mips`);
			}
			break;
		}
		case TextureClass.Texture2DArray:
		case TextureClass.CubemapArray:
		case TextureClass.Texture3D: {
			const value = numberField(texture, 'm_Format');
			const known = GRAPHICS_FORMATS.get(value);
			if (known === undefined) {
				throw new FormatError(`texture ${name} has unsupported GraphicsFormat ${value}`);
			}
			source = known;
			format = { enum: 'GraphicsFormat', value, name: known.name };
			srgb = known.isSrgb;
			if (classId === TextureClass.Texture2DArray) {
				kind = '2d-array';
				layers = numberField(texture, 'm_Depth');
			} else if (classId === TextureClass.CubemapArray) {
				kind = 'cube-array';
				layers = numberField(texture, 'm_CubemapCount');
				faces = 6;
			} else {
				kind = '3d';
				depth = numberField(texture, 'm_Depth');
			}
			break;
		}
		default: {
			throw new FormatError(`class ${classId} isn't a supported texture class`);
		}
	}

	const vkFormat = srgb && source.srgb !== undefined ? source.srgb : source.linear;
	const info = ktx2FormatInfo(vkFormat);
	if (info === undefined) {
		throw new FormatError(`texture ${name}: VkFormat ${vkFormat} has no layout`);
	}
	// sizes in the source layout, which differs from the KTX2 one only for converted formats
	const sourceScale = source.sourceTexelBytes === undefined ? 1 : source.sourceTexelBytes / info.blockBytes;
	const levelImageBytes = Array.from(
		{ length: mipCount },
		(_, level) => imageByteLength(info, width >> level, height >> level) * sourceScale,
	);

	let levels: Uint8Array[];
	if (kind === '3d') {
		levels = [];
		let at = 0;
		for (let level = 0; level < mipCount; level++) {
			const size = levelImageBytes[level] * Math.max(1, depth >> level);
			levels.push(data.subarray(at, at + size));
			at += size;
		}
		checkSize(name, at, data.length);
	} else {
		// image-major (each image a full mip chain) → level-major
		const images = layers * faces;
		const chain = levelImageBytes.reduce((sum, size) => sum + size, 0);
		checkSize(name, chain * images, data.length);
		levels = levelImageBytes.map((size, level) => {
			const out = new Uint8Array(size * images);
			const within = levelImageBytes.slice(0, level).reduce((sum, previous) => sum + previous, 0);
			for (let image = 0; image < images; image++) {
				const from = image * chain + within;
				out.set(data.subarray(from, from + size), image * size);
			}
			return out;
		});
	}
	if (source.convert !== undefined) {
		levels = levels.map(source.convert);
	}

	return {
		kind,
		name,
		width,
		height,
		depth,
		layers,
		faces,
		mipCount,
		format,
		srgb,
		colorSpace,
		sampler,
		vkFormat,
		levels,
	};
};

const checkSize = (name: string, expected: number, actual: number): void => {
	if (expected !== actual) {
		throw new FormatError(`texture ${name} data is ${actual} bytes, its layout needs ${expected}`);
	}
};

/**
 * @param texture a decoded texture
 * @returns the KTX2 description of it
 */
export const toKtx2Texture = (texture: DecodedTexture): Ktx2Texture => {
	const isArray = texture.kind === '2d-array' || texture.kind === 'cube-array';
	return {
		vkFormat: texture.vkFormat,
		width: texture.width,
		height: texture.height,
		depth: texture.kind === '3d' ? texture.depth : 0,
		layerCount: isArray ? texture.layers : 0,
		faceCount: texture.faces,
		levels: texture.levels,
	};
};

// #endregion
