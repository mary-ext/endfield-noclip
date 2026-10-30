import type { UnconvertedEntry } from './entries.ts';

/**
 * a texture's smallest mip levels are stored together in one blob, the longest run of levels (smallest first)
 * whose combined size stays within this many bytes; every larger level is a blob of its own. for BC7 that's
 * levels up to 128² (21.8 KB) in the tail and 256² (64 KB) as the smallest single-level piece, so no streamed
 * piece is much smaller than this and a texture is drawable after one small read
 */
export const TEXTURE_TAIL_BYTES = 64 * 1024;

/** a texture-table id, or `null` when unset or not converted */
export type TextureRef = number | null;

/** `tables/textures.json`; entry `i` has id `i` */
export interface TextureTable {
	entries: TextureEntry[];
}

/** one texture. textures with identical content and sampler share one entry */
export type TextureEntry = UnconvertedEntry | ReadyTexture;

/** a converted texture: the game's texel data unchanged (no transcoding), split into mip pieces */
export interface ReadyTexture {
	id: number;
	status: 'ready';
	kind: '2d' | 'cube' | '2d-array' | 'cube-array' | '3d';
	/** a WebGPU texture format, a key of {@link TEXTURE_FORMATS} */
	format: string;
	width: number;
	height: number;
	/** WebGPU's: array layers × faces (6 per cube), or depth for `3d`, else 1 */
	depthOrArrayLayers: number;
	mipCount: number;
	sampler: TextureSampler;
	/**
	 * the blobs holding the levels, coarse to fine: the first holds the mip tail (see
	 * {@link TEXTURE_TAIL_BYTES}), each further one a single larger level. together they cover levels
	 * `0…mipCount - 1` exactly once
	 */
	pieces: TexturePiece[];
}

/** a {@link BlobKind.Texture} blob and the levels it holds */
export interface TexturePiece {
	blob: number;
	/** the largest level in the blob */
	firstLevel: number;
	levelCount: number;
}

/** Unity's sampler state in WebGPU terms (`GPUSamplerDescriptor` fields), plus the mip bias */
export interface TextureSampler {
	addressModeU: 'repeat' | 'clamp-to-edge' | 'mirror-repeat';
	addressModeV: 'repeat' | 'clamp-to-edge' | 'mirror-repeat';
	addressModeW: 'repeat' | 'clamp-to-edge' | 'mirror-repeat';
	magFilter: 'nearest' | 'linear';
	minFilter: 'nearest' | 'linear';
	mipmapFilter: 'nearest' | 'linear';
	/** 1 unless every filter is linear, as WebGPU requires */
	maxAnisotropy: number;
	/** Unity's mip bias; WebGPU samplers have none, so a shader applies it if it wants */
	mipBias: number;
}

/** block layout of a texture format: a 4×4 block for BC formats, a single texel otherwise */
export interface TextureFormatInfo {
	blockWidth: number;
	blockHeight: number;
	blockBytes: number;
}

const bc = (blockBytes: number): TextureFormatInfo => ({ blockWidth: 4, blockHeight: 4, blockBytes });

const texel = (blockBytes: number): TextureFormatInfo => ({ blockWidth: 1, blockHeight: 1, blockBytes });

/**
 * the WebGPU formats a {@link ReadyTexture} can have. this is the package contract's own copy of the block
 * sizes: the extractor derives formats from formats' `binary/ktx2.ts` table, which package-format can't
 * import
 */
export const TEXTURE_FORMATS: Readonly<Record<string, TextureFormatInfo>> = {
	'bc1-rgba-unorm': bc(8),
	'bc1-rgba-unorm-srgb': bc(8),
	'bc2-rgba-unorm': bc(16),
	'bc2-rgba-unorm-srgb': bc(16),
	'bc3-rgba-unorm': bc(16),
	'bc3-rgba-unorm-srgb': bc(16),
	'bc4-r-unorm': bc(8),
	'bc4-r-snorm': bc(8),
	'bc5-rg-unorm': bc(16),
	'bc5-rg-snorm': bc(16),
	'bc6h-rgb-ufloat': bc(16),
	'bc6h-rgb-float': bc(16),
	'bc7-rgba-unorm': bc(16),
	'bc7-rgba-unorm-srgb': bc(16),
	r8unorm: texel(1),
	rg8unorm: texel(2),
	rgba8unorm: texel(4),
	'rgba8unorm-srgb': texel(4),
	bgra8unorm: texel(4),
	'bgra8unorm-srgb': texel(4),
	r16unorm: texel(2),
	rg16unorm: texel(4),
	rgba16unorm: texel(8),
	r16float: texel(2),
	rg16float: texel(4),
	rgba16float: texel(8),
	r32float: texel(4),
	rg32float: texel(8),
	rgba32float: texel(16),
};

/** how one mip level of a texture is laid out in its piece, in `GPUQueue.writeTexture` terms */
export interface TextureLevelLayout {
	width: number;
	height: number;
	/** array layers × faces, or depth slices for `3d` */
	depthOrArrayLayers: number;
	/** bytes per row of blocks */
	bytesPerRow: number;
	/** block rows per image */
	rowsPerImage: number;
	/** bytes of the whole level */
	byteLength: number;
}

/**
 * @param texture the texture's shape (an entry of the texture table)
 * @param level mip level, 0 = largest
 * @returns the level's size and data layout
 * @throws {RangeError} on an unknown format
 */
export const textureLevelLayout = (
	texture: Pick<ReadyTexture, 'kind' | 'format' | 'width' | 'height' | 'depthOrArrayLayers'>,
	level: number,
): TextureLevelLayout => {
	const info = TEXTURE_FORMATS[texture.format];
	if (info === undefined) {
		throw new RangeError(`unknown texture format ${texture.format}`);
	}
	const width = Math.max(1, texture.width >> level);
	const height = Math.max(1, texture.height >> level);
	const depthOrArrayLayers =
		texture.kind === '3d' ? Math.max(1, texture.depthOrArrayLayers >> level) : texture.depthOrArrayLayers;
	const bytesPerRow = Math.ceil(width / info.blockWidth) * info.blockBytes;
	const rowsPerImage = Math.ceil(height / info.blockHeight);
	return {
		width,
		height,
		depthOrArrayLayers,
		bytesPerRow,
		rowsPerImage,
		byteLength: bytesPerRow * rowsPerImage * depthOrArrayLayers,
	};
};

/**
 * @param texture the texture's shape
 * @param level mip level
 * @returns the level's byte length
 */
export const textureLevelByteLength = (
	texture: Pick<ReadyTexture, 'kind' | 'format' | 'width' | 'height' | 'depthOrArrayLayers'>,
	level: number,
): number => textureLevelLayout(texture, level).byteLength;
