import { viewOf, checkHeader, checkLength, writeHeader, type HeaderShape } from './binary.ts';
import { PackageFormatError } from './errors.ts';

/** scene terrain parameters, from the game's `HGTerrainSurfacesData` */
export interface TerrainInfo {
	/** world position of the terrain square's minimum corner; `y` is the height of a zero sample */
	position: [x: number, y: number, z: number];
	/** metres spanned by the 15-bit height range: `y = position.y + (h & 0x7fff) · heightScale / 32768` */
	heightScale: number;
	/** edge length of the terrain square; equals {@link TreeInfo.rootSize} */
	terrainSize: number;
	/** samples per page edge; pages share their edge samples with neighbours */
	pageSize: number;
	/** bit 15 of a sample marks a hole */
	holeBit: number;
	/** levels that have height pages, ascending (the game ships a pyramid, not just leaves) */
	levels: number[];
	/** texels per surface page edge, border included; see {@link BlobKind.TerrainSurface} */
	surfaceSize: number;
	/** texels of each surface page edge outside the tile; the rest map the tile edge to edge */
	surfaceBorder: number;
	/** the close-up layer blend's inputs, or `null` if they weren't packed */
	splat: TerrainSplatInfo | null;
}

/**
 * the close-up layer blend: each leaf's 8 m cells name 4 layers, blended by the leaf's splat control page,
 * then tinted. leaf tiles carry a {@link ContentKind.TerrainSplat} ref
 */
export interface TerrainSplatInfo {
	/** metres per index cell; a leaf has `leafSize / cellSize` cells per edge */
	cellSize: number;
	/** layers by ordinal, as the splat pages' index cells name them */
	layers: TerrainLayerInfo[];
	/** texels per layer texture edge at its first packed level */
	textureSize: number;
	/** mip levels per layer texture */
	textureLevels: number;
	/** {@link BlobKind.TerrainLayer} blobs by texture index: sRGB albedo with height in alpha */
	diffuse: number[];
	/** ... linear normal xy, roughness, occlusion */
	normal: number[];
}

/** one close-up material layer, from the game's `SplatLayerData` */
export interface TerrainLayerInfo {
	/** index into {@link TerrainSplatInfo.diffuse} and {@link TerrainSplatInfo.normal} */
	texture: number;
	/** texture repeats per metre of world position */
	tiling: number;
	/** uv offset */
	offset: [u: number, v: number];
	/** the layer's mean albedo, linear; the tint applies relative to it */
	meanColor: [r: number, g: number, b: number];
	/** scales the normal map's xy */
	normalScale: number;
	/** multiplies the diffuse texture's rgb */
	diffuseScale: [r: number, g: number, b: number];
	/** how far below the highest layer a layer still shows in the height blend */
	blendBorder: number;
	/** height = diffuse alpha · scale + offset */
	height: [scale: number, offset: number];
	/** occlusion = normal alpha · scale + offset */
	occlusion: [scale: number, offset: number];
	/** roughness = normal blue · scale + offset */
	roughness: [scale: number, offset: number];
}

/**
 * @param terrain scene terrain parameters
 * @param sample a raw height sample
 * @returns whether the sample is flagged as a hole; holes still carry a usable height
 */
export const isTerrainHole = (terrain: Pick<TerrainInfo, 'holeBit'>, sample: number): boolean => {
	return (sample & terrain.holeBit) !== 0;
};

/**
 * @param terrain scene terrain parameters
 * @param sample a raw height sample
 * @returns the sample's world y, ignoring the hole flag
 */
export const terrainHeight = (
	terrain: Pick<TerrainInfo, 'position' | 'heightScale' | 'holeBit'>,
	sample: number,
): number => {
	return terrain.position[1] + ((sample & (terrain.holeBit - 1)) * terrain.heightScale) / terrain.holeBit;
};

const HEIGHTS_HEADER_SIZE = 8;
const SURFACE_HEADER_SIZE = 8;
const SPLAT_HEADER_SIZE = 12;

/** 'EFHT' */
const HEIGHTS_HEADER: HeaderShape = {
	magic: 0x54_48_46_45,
	version: 1,
	size: HEIGHTS_HEADER_SIZE,
	label: 'height page',
};
/** 'EFTS' */
const SURFACE_HEADER: HeaderShape = {
	magic: 0x53_54_46_45,
	version: 1,
	size: SURFACE_HEADER_SIZE,
	label: 'surface page',
};
/** 'EFSL' */
const SPLAT_HEADER: HeaderShape = {
	magic: 0x4c_53_46_45,
	version: 1,
	size: SPLAT_HEADER_SIZE,
	label: 'splat page',
};

/**
 * height page: 8-byte header (`'EFHT'`, u16 version, u16 side), then the raw samples as two byte planes (all
 * low bytes, then all high bytes) of zigzag-encoded deltas. interior samples are predicted by the gradient
 * `left + above - aboveLeft`, the first row by the left neighbour, the first column by the sample above, the
 * first sample by 0. arithmetic wraps at 16 bits, so the hole bit survives. on map02's leaves with zstd-19
 * this is 2.15 KB per 65² page, against 2.36 KB for left-only prediction and 3.6 KB for raw samples.
 *
 * @param samples `side²` raw samples, rows along +Z
 * @param side samples per edge
 * @returns the encoded page
 * @throws {RangeError} if `samples` isn't `side²` long
 */
export const encodeHeightPage = (samples: Uint16Array, side: number): Uint8Array => {
	const count = side * side;
	if (samples.length !== count) {
		throw new RangeError(`height page needs ${count} samples, got ${samples.length}`);
	}
	const out = new Uint8Array(HEIGHTS_HEADER_SIZE + count * 2);
	const view = viewOf(out);
	writeHeader(view, HEIGHTS_HEADER);
	view.setUint16(6, side, true);
	for (let i = 0; i < count; i++) {
		const delta = (samples[i] - predictHeight(samples, i, side)) & 0xff_ff;
		// zigzag over the 16-bit two's complement delta
		const signed = delta >= 0x80_00 ? delta - 0x1_00_00 : delta;
		const zigzag = signed >= 0 ? signed * 2 : -signed * 2 - 1;
		out[HEIGHTS_HEADER_SIZE + i] = zigzag & 0xff;
		out[HEIGHTS_HEADER_SIZE + count + i] = zigzag >> 8;
	}
	return out;
};

const predictHeight = (samples: Uint16Array, i: number, side: number): number => {
	const first = i % side === 0;
	if (i < side) {
		return first ? 0 : samples[i - 1];
	}
	if (first) {
		return samples[i - side];
	}
	return (samples[i - 1] + samples[i - side] - samples[i - side - 1]) & 0xff_ff;
};

/**
 * @param data an encoded height page
 * @returns its side and raw samples
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeHeightPage = (data: Uint8Array): { side: number; samples: Uint16Array } => {
	const view = viewOf(data);
	checkHeader(view, HEIGHTS_HEADER);
	const side = view.getUint16(6, true);
	const count = side * side;
	checkLength(data, HEIGHTS_HEADER_SIZE + count * 2, 'height page');
	const samples = new Uint16Array(count);
	for (let i = 0; i < count; i++) {
		const zigzag = data[HEIGHTS_HEADER_SIZE + i] | (data[HEIGHTS_HEADER_SIZE + count + i] << 8);
		const signed = zigzag & 1 ? -((zigzag + 1) >> 1) : zigzag >> 1;
		samples[i] = (predictHeight(samples, i, side) + signed) & 0xff_ff;
	}
	return { side, samples };
};

/** bytes of one BC3 image of `side`² texels */
export const bc3ImageBytes = (side: number): number => (side / 4) ** 2 * 16;

/** a terrain tile's baked surface: two BC3 (DXT5) images of `side`² texels, rows along +Z */
export interface SurfacePage {
	side: number;
	/** rgb linear albedo, a unused */
	albedo: Uint8Array;
	/** rg world normal x and z (`· 2 − 1`; y is reconstructed), b perceptual roughness, a occlusion */
	normal: Uint8Array;
}

/**
 * surface page: 8-byte header (`'EFTS'`, u16 version, u16 side), then the albedo's BC3 blocks, then the
 * normal's, each in row-major block order as `writeTexture` takes them.
 *
 * @param page the images
 * @returns the encoded page
 * @throws {RangeError} if `side` isn't a multiple of 4 or an image isn't one BC3 image of that size
 */
export const encodeSurfacePage = (page: SurfacePage): Uint8Array => {
	const { side } = page;
	const bytes = bc3ImageBytes(side);
	if (side % 4 !== 0 || page.albedo.length !== bytes || page.normal.length !== bytes) {
		throw new RangeError(`surface page images must be ${bytes}-byte BC3 images of ${side}² texels`);
	}
	const out = new Uint8Array(SURFACE_HEADER_SIZE + bytes * 2);
	const view = viewOf(out);
	writeHeader(view, SURFACE_HEADER);
	view.setUint16(6, side, true);
	out.set(page.albedo, SURFACE_HEADER_SIZE);
	out.set(page.normal, SURFACE_HEADER_SIZE + bytes);
	return out;
};

/**
 * @param data an encoded surface page
 * @returns the page; its images are views into `data`
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeSurfacePage = (data: Uint8Array): SurfacePage => {
	const view = viewOf(data);
	checkHeader(view, SURFACE_HEADER);
	const side = view.getUint16(6, true);
	if (side % 4 !== 0) {
		throw new PackageFormatError(`surface page side ${side} isn't a multiple of 4`);
	}
	const bytes = bc3ImageBytes(side);
	checkLength(data, SURFACE_HEADER_SIZE + bytes * 2, 'surface page');
	return {
		side,
		albedo: data.subarray(SURFACE_HEADER_SIZE, SURFACE_HEADER_SIZE + bytes),
		normal: data.subarray(SURFACE_HEADER_SIZE + bytes, SURFACE_HEADER_SIZE + bytes * 2),
	};
};

/** a leaf terrain tile's close-up blend inputs; images have `side`² texels with rows along +Z */
export interface SplatPage {
	side: number;
	/** index cells per edge */
	cells: number;
	/** RGBA8 splat control: rgb weight index slots 0–2, slot 3 gets the remainder */
	control: Uint8Array;
	/** BC3 sRGB tint, applied with weight a⁴ */
	tint: Uint8Array;
	/** 4 layer ordinals per cell, row-major from the minimum corner */
	index: Uint8Array;
}

/**
 * splat page: 12-byte header (`'EFSL'`, u16 version, u16 side, u16 cells, u16 0), then the control texels,
 * the tint's BC3 blocks and the index cells.
 *
 * @param page the inputs
 * @returns the encoded page
 * @throws {RangeError} if `side` isn't a multiple of 4 or a section has the wrong size
 */
export const encodeSplatPage = (page: SplatPage): Uint8Array => {
	const { side, cells } = page;
	const tintBytes = bc3ImageBytes(side);
	if (
		side % 4 !== 0 ||
		page.control.length !== side * side * 4 ||
		page.tint.length !== tintBytes ||
		page.index.length !== cells * cells * 4
	) {
		throw new RangeError(`splat page sections don't fit a ${side}² page with ${cells}² cells`);
	}
	const out = new Uint8Array(SPLAT_HEADER_SIZE + page.control.length + tintBytes + page.index.length);
	const view = viewOf(out);
	writeHeader(view, SPLAT_HEADER);
	view.setUint16(6, side, true);
	view.setUint16(8, cells, true);
	out.set(page.control, SPLAT_HEADER_SIZE);
	out.set(page.tint, SPLAT_HEADER_SIZE + page.control.length);
	out.set(page.index, SPLAT_HEADER_SIZE + page.control.length + tintBytes);
	return out;
};

/**
 * @param data an encoded splat page
 * @returns the page; its sections are views into `data`
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeSplatPage = (data: Uint8Array): SplatPage => {
	const view = viewOf(data);
	checkHeader(view, SPLAT_HEADER);
	const side = view.getUint16(6, true);
	const cells = view.getUint16(8, true);
	if (side % 4 !== 0) {
		throw new PackageFormatError(`splat page side ${side} isn't a multiple of 4`);
	}
	const controlBytes = side * side * 4;
	const tintBytes = bc3ImageBytes(side);
	const indexBytes = cells * cells * 4;
	checkLength(data, SPLAT_HEADER_SIZE + controlBytes + tintBytes + indexBytes, 'splat page');
	const tintAt = SPLAT_HEADER_SIZE + controlBytes;
	return {
		side,
		cells,
		control: data.subarray(SPLAT_HEADER_SIZE, tintAt),
		tint: data.subarray(tintAt, tintAt + tintBytes),
		index: data.subarray(tintAt + tintBytes, tintAt + tintBytes + indexBytes),
	};
};
