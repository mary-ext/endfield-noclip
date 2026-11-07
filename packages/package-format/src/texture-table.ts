/**
 * `tables/textures.bin.zst`, the texture table: one zstd frame of the layout below. its own module, outside
 * the asset modules the pack cache fingerprints, so a layout change leaves cached conversions valid
 *
 * @module
 */

import { checkHeader, checkLength, viewOf, writeHeader, type HeaderShape } from './binary.ts';
import { EntryStatus, entryStatusCode, entryStatusName } from './entry-status.ts';
import { PackageFormatError } from './errors.ts';
import type { ReadyTexture, TextureEntry, TexturePiece, TextureSampler } from './textures.ts';

/** the decoded texture table; a texture's id is its index */
export interface TextureTable {
	/** entries in the table; ids run `0…count - 1` */
	readonly count: number;
	/** the distinct samplers entries use; {@link ReadyTexture.sampler} indexes this list */
	readonly samplers: readonly TextureSampler[];
	/**
	 * @param id texture id
	 * @returns the entry, decoded on first use and the same object afterwards, or `undefined` when `id` isn't
	 *   in the table
	 */
	entry(id: number): TextureEntry | undefined;
	/**
	 * @param id texture id
	 * @returns how many pieces the texture has: 0 when it isn't ready or isn't in the table
	 */
	pieceCount(id: number): number;
	/**
	 * reads {@link ReadyTexture.pieces} without decoding the entry
	 *
	 * @param id texture id
	 * @param index piece index, below {@link pieceCount}
	 * @returns the piece's blob
	 */
	pieceBlob(id: number, index: number): number;
}

/** {@link ReadyTexture.kind} by its code in the table */
export const TEXTURE_KIND_CODES: readonly ReadyTexture['kind'][] = [
	'2d',
	'cube',
	'2d-array',
	'cube-array',
	'3d',
];

/**
 * {@link ReadyTexture.format} (a key of `TEXTURE_FORMATS`) by its code in the table. a format added to
 * `TEXTURE_FORMATS` needs a code here; renumbering needs a new table version
 */
export const TEXTURE_FORMAT_CODES: readonly string[] = [
	'bc1-rgba-unorm',
	'bc1-rgba-unorm-srgb',
	'bc2-rgba-unorm',
	'bc2-rgba-unorm-srgb',
	'bc3-rgba-unorm',
	'bc3-rgba-unorm-srgb',
	'bc4-r-unorm',
	'bc4-r-snorm',
	'bc5-rg-unorm',
	'bc5-rg-snorm',
	'bc6h-rgb-ufloat',
	'bc6h-rgb-float',
	'bc7-rgba-unorm',
	'bc7-rgba-unorm-srgb',
	'r8unorm',
	'rg8unorm',
	'rgba8unorm',
	'rgba8unorm-srgb',
	'bgra8unorm',
	'bgra8unorm-srgb',
	'r16unorm',
	'rg16unorm',
	'rgba16unorm',
	'r16float',
	'rg16float',
	'rgba16float',
	'r32float',
	'rg32float',
	'rgba32float',
];

const ADDRESS_MODES: readonly TextureSampler['addressModeU'][] = ['repeat', 'clamp-to-edge', 'mirror-repeat'];

const FILTERS: readonly TextureSampler['magFilter'][] = ['nearest', 'linear'];

/** 'EFTX' */
const TEXTURES_HEADER: HeaderShape = {
	magic: 0x58_54_46_45,
	version: 1,
	size: 20,
	label: 'texture table',
};

const SAMPLER_SIZE = 12;

const TEXTURE_RECORD_SIZE = 16;

const PIECE_SIZE = 8;

/** @returns each value's index in `values` */
const codes = <T>(values: readonly T[]): ReadonlyMap<T, number> =>
	new Map(values.map((value, code) => [value, code]));

const kindCodes = codes(TEXTURE_KIND_CODES);

const formatCodes = codes(TEXTURE_FORMAT_CODES);

const addressCodes = codes(ADDRESS_MODES);

const filterCodes = codes(FILTERS);

/** @throws {RangeError} unless `value` has a code */
const codeOf = <T>(map: ReadonlyMap<T, number>, value: T, label: string): number => {
	const code = map.get(value);
	if (code === undefined) {
		throw new RangeError(`${label} ${String(value)} has no code in the texture table`);
	}
	return code;
};

/** @throws {PackageFormatError} unless `code` names a value */
const valueOf = <T>(values: readonly T[], code: number, label: string): T => {
	const value = values[code];
	if (value === undefined) {
		throw new PackageFormatError(`unknown ${label} ${code}`);
	}
	return value;
};

/**
 * the texture table: 20-byte header (`'EFTX'`, u16 version, u16 0, u32 textureCount, u32 pieceCount, u32
 * samplerCount), then 12-byte samplers (u8 addressModeU, V and W, u8 magFilter, minFilter and mipmapFilter,
 * u16 maxAnisotropy, f32 mipBias), 16-byte textures (u8 status, u8 kind, u8 format, u8 mipCount, u16 width,
 * u16 height, u16 depthOrArrayLayers, u16 sampler, u32 firstPiece) and 8-byte pieces (u32 blob, u8
 * firstLevel, u8 levelCount, u16 0). a texture's pieces are `[firstPiece, next texture's firstPiece)` of the
 * piece list (the list's end for the last), coarse to fine; an unconverted entry has none and its other
 * fields are 0. kinds, formats, address modes and filters are indices into {@link TEXTURE_KIND_CODES},
 * {@link TEXTURE_FORMAT_CODES} and the orders `repeat, clamp-to-edge, mirror-repeat` and `nearest, linear`.
 *
 * @param samplers the sampler palette
 * @param entries entries in id order
 * @returns the encoded table
 * @throws {RangeError} on a value without a code or a field that doesn't fit its record
 */
export const encodeTextureTable = (
	samplers: readonly TextureSampler[],
	entries: readonly TextureEntry[],
): Uint8Array => {
	const pieceCount = entries.reduce(
		(sum, entry) => sum + (entry.status === 'ready' ? entry.pieces.length : 0),
		0,
	);
	const texturesAt = TEXTURES_HEADER.size + samplers.length * SAMPLER_SIZE;
	const piecesAt = texturesAt + entries.length * TEXTURE_RECORD_SIZE;
	const out = new Uint8Array(piecesAt + pieceCount * PIECE_SIZE);
	const view = viewOf(out);
	writeHeader(view, TEXTURES_HEADER);
	view.setUint32(8, entries.length, true);
	view.setUint32(12, pieceCount, true);
	view.setUint32(16, samplers.length, true);

	for (const [index, sampler] of samplers.entries()) {
		const at = TEXTURES_HEADER.size + index * SAMPLER_SIZE;
		view.setUint8(at, codeOf(addressCodes, sampler.addressModeU, 'address mode'));
		view.setUint8(at + 1, codeOf(addressCodes, sampler.addressModeV, 'address mode'));
		view.setUint8(at + 2, codeOf(addressCodes, sampler.addressModeW, 'address mode'));
		view.setUint8(at + 3, codeOf(filterCodes, sampler.magFilter, 'filter'));
		view.setUint8(at + 4, codeOf(filterCodes, sampler.minFilter, 'filter'));
		view.setUint8(at + 5, codeOf(filterCodes, sampler.mipmapFilter, 'filter'));
		if (sampler.maxAnisotropy > 0xff_ff) {
			throw new RangeError(`sampler ${index}'s anisotropy ${sampler.maxAnisotropy} doesn't fit 16 bits`);
		}
		view.setUint16(at + 6, sampler.maxAnisotropy, true);
		view.setFloat32(at + 8, sampler.mipBias, true);
	}

	let piece = 0;
	for (const [id, entry] of entries.entries()) {
		const at = texturesAt + id * TEXTURE_RECORD_SIZE;
		view.setUint8(at, entryStatusCode(entry.status));
		view.setUint32(at + 12, piece, true);
		if (entry.status !== 'ready') {
			continue;
		}
		if (
			entry.mipCount > 0xff ||
			entry.width > 0xff_ff ||
			entry.height > 0xff_ff ||
			entry.depthOrArrayLayers > 0xff_ff ||
			entry.sampler >= samplers.length
		) {
			throw new RangeError(`texture ${id} has a field out of its record's range`);
		}
		view.setUint8(at + 1, codeOf(kindCodes, entry.kind, 'texture kind'));
		view.setUint8(at + 2, codeOf(formatCodes, entry.format, 'texture format'));
		view.setUint8(at + 3, entry.mipCount);
		view.setUint16(at + 4, entry.width, true);
		view.setUint16(at + 6, entry.height, true);
		view.setUint16(at + 8, entry.depthOrArrayLayers, true);
		view.setUint16(at + 10, entry.sampler, true);
		for (const { blob, firstLevel, levelCount } of entry.pieces) {
			const pieceAt = piecesAt + piece * PIECE_SIZE;
			view.setUint32(pieceAt, blob, true);
			view.setUint8(pieceAt + 4, firstLevel);
			view.setUint8(pieceAt + 5, levelCount);
			piece++;
		}
	}
	return out;
};

/**
 * checks every record once, so the table's accessors never throw on content
 *
 * @param data the texture table, inflated
 * @returns the table, decoding entries on first use
 * @throws {PackageFormatError} on a bad header or length, an unknown code, a sampler index past the palette
 *   or piece ranges that don't follow each other
 */
export const decodeTextureTable = (data: Uint8Array): TextureTable => {
	const view = viewOf(data);
	checkHeader(view, TEXTURES_HEADER);
	const count = view.getUint32(8, true);
	const pieceTotal = view.getUint32(12, true);
	const samplerCount = view.getUint32(16, true);
	const texturesAt = TEXTURES_HEADER.size + samplerCount * SAMPLER_SIZE;
	const piecesAt = texturesAt + count * TEXTURE_RECORD_SIZE;
	checkLength(data, piecesAt + pieceTotal * PIECE_SIZE, 'texture table');

	const samplers: TextureSampler[] = [];
	for (let index = 0; index < samplerCount; index++) {
		const at = TEXTURES_HEADER.size + index * SAMPLER_SIZE;
		samplers.push({
			addressModeU: valueOf(ADDRESS_MODES, view.getUint8(at), 'address mode'),
			addressModeV: valueOf(ADDRESS_MODES, view.getUint8(at + 1), 'address mode'),
			addressModeW: valueOf(ADDRESS_MODES, view.getUint8(at + 2), 'address mode'),
			magFilter: valueOf(FILTERS, view.getUint8(at + 3), 'filter'),
			minFilter: valueOf(FILTERS, view.getUint8(at + 4), 'filter'),
			mipmapFilter: valueOf(FILTERS, view.getUint8(at + 5), 'filter'),
			maxAnisotropy: view.getUint16(at + 6, true),
			mipBias: view.getFloat32(at + 8, true),
		});
	}

	// piece ranges as offsets, the last one closing the list
	const firstPieces = new Uint32Array(count + 1);
	firstPieces[count] = pieceTotal;
	for (let id = 0; id < count; id++) {
		const at = texturesAt + id * TEXTURE_RECORD_SIZE;
		firstPieces[id] = view.getUint32(at + 12, true);
	}
	if (firstPieces[0] !== 0) {
		throw new PackageFormatError('texture table pieces start past the list');
	}
	for (let id = 0; id < count; id++) {
		const at = texturesAt + id * TEXTURE_RECORD_SIZE;
		const status = view.getUint8(at);
		if (status > EntryStatus.Failed) {
			throw new PackageFormatError(`texture ${id} has unknown status ${status}`);
		}
		const pieces = firstPieces[id + 1] - firstPieces[id];
		if (pieces < 0 || (status !== EntryStatus.Ready && pieces !== 0)) {
			throw new PackageFormatError(`texture ${id}'s pieces don't follow the previous texture's`);
		}
		if (status === EntryStatus.Ready) {
			valueOf(TEXTURE_KIND_CODES, view.getUint8(at + 1), 'texture kind');
			valueOf(TEXTURE_FORMAT_CODES, view.getUint8(at + 2), 'texture format');
			if (view.getUint16(at + 10, true) >= samplerCount) {
				throw new PackageFormatError(`texture ${id}'s sampler is past the palette`);
			}
		}
	}
	const pieceCount = (id: number): number => {
		const first = firstPieces[id];
		const end = firstPieces[id + 1];
		return first === undefined || end === undefined ? 0 : end - first;
	};

	const decoded: (TextureEntry | undefined)[] = [];
	const decode = (id: number): TextureEntry => {
		const at = texturesAt + id * TEXTURE_RECORD_SIZE;
		const status = entryStatusName(view.getUint8(at), `texture ${id}`);
		if (status !== 'ready') {
			return { status };
		}
		const pieces: TexturePiece[] = [];
		for (let piece = firstPieces[id]; piece < firstPieces[id + 1]; piece++) {
			const pieceAt = piecesAt + piece * PIECE_SIZE;
			pieces.push({
				blob: view.getUint32(pieceAt, true),
				firstLevel: view.getUint8(pieceAt + 4),
				levelCount: view.getUint8(pieceAt + 5),
			});
		}
		return {
			status,
			kind: valueOf(TEXTURE_KIND_CODES, view.getUint8(at + 1), 'texture kind'),
			format: valueOf(TEXTURE_FORMAT_CODES, view.getUint8(at + 2), 'texture format'),
			width: view.getUint16(at + 4, true),
			height: view.getUint16(at + 6, true),
			depthOrArrayLayers: view.getUint16(at + 8, true),
			mipCount: view.getUint8(at + 3),
			sampler: view.getUint16(at + 10, true),
			pieces,
		};
	};

	return {
		count,
		samplers,
		entry(id) {
			if (!(id >= 0 && id < count)) {
				return undefined;
			}
			let entry = decoded[id];
			if (entry === undefined) {
				entry = decode(id);
				decoded[id] = entry;
			}
			return entry;
		},
		pieceCount,
		pieceBlob(id, index) {
			return view.getUint32(piecesAt + (firstPieces[id] + index) * PIECE_SIZE, true);
		},
	};
};
