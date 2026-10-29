/**
 * `HGIrradianceVolume` v3 (`Data/IrradianceVolume/PC/<scene>/v3/`): baked L1 probes, stored per cell. an
 * `index.bytes` names the payload files and gives every cell's byte range in them; a cell, once decompressed,
 * is the GPU structure the game's `IrradianceVolumeUpdateV3CS` reads (see {@link IrradianceCell}).
 *
 * @module
 */

import { BinaryReader, FormatError } from '../binary/binary-reader.ts';
import { decodeInvertedLz4Block } from '../binary/lz4.ts';

/** `index.bytes` magic of the current scene format */
export const IRRADIANCE_INDEX_MAGIC = 0x03000004;

/** a cell's byte range in its payload file */
export interface IrradianceRecord {
	/**
	 * `x | y << 8 | z << 16 | level << 24`, 8 bits per axis in 32 m units with 128 at world 0. a level-`n` cell
	 * spans `32 · 2^n` m and its coordinates are multiples of `2^n`
	 */
	key: number;
	/** index into {@link IrradianceIndex.files} */
	file: number;
	offset: number;
	/** stored bytes; equal to {@link size} when the cell is stored uncompressed */
	storedLength: number;
	/** decompressed bytes */
	size: number;
}

/** a parsed `index.bytes` */
export interface IrradianceIndex {
	/** lighting scenario names, e.g. `Map02_lv002_sunny` */
	scenarios: string[];
	/** payload file names, e.g. `iv_0_0.bytes` (scenario hash, part); records index this list */
	files: string[];
	/** every cell of every payload, grouped by file in {@link files} order */
	records: IrradianceRecord[];
}

/** world metres per cell-key unit */
export const IRRADIANCE_CELL_SIZE = 32;
/** the key value of world 0 on each axis */
export const IRRADIANCE_KEY_ORIGIN = 128;

/**
 * @param key a cell key
 * @returns its level and the world position (m) of its minimum corner
 */
export const irradianceCellOrigin = (key: number): { level: number; origin: [number, number, number] } => {
	const axis = (shift: number) => (((key >>> shift) & 255) - IRRADIANCE_KEY_ORIGIN) * IRRADIANCE_CELL_SIZE;
	return { level: key >>> 24, origin: [axis(0), axis(8), axis(16)] };
};

/** directory records are nine u32 */
const RECORD_WORDS = 9;

/**
 * @param data `index.bytes`
 * @returns the scenarios, payload files and cell ranges
 * @throws {FormatError} on another magic or a layout that doesn't hold together
 */
export const parseIrradianceIndex = (data: Uint8Array): IrradianceIndex => {
	const r = new BinaryReader(data, { littleEndian: true });
	const magic = r.u32();
	if (magic !== IRRADIANCE_INDEX_MAGIC) {
		throw new FormatError(`irradiance index: magic 0x${magic.toString(16)}`);
	}
	const utf16 = () => new TextDecoder('utf-16le').decode(r.bytesView(r.u32()));
	const scenarios = Array.from({ length: r.u32() }, utf16);
	// a scenario table follows whose layout isn't known; the filename table after it is found by its shape
	r.offset = findFileTable(data, r.offset);
	const files = Array.from({ length: r.u32() }, utf16);

	// the scene's top-level spatial hash over cells (table size, offset-table size, offsets), then a table of
	// (value, scenario) pairs; neither is needed to read the cells
	r.u32();
	const offsetTableSize = r.u32();
	r.skip(offsetTableSize ** 3 * 4);
	r.skip(r.u32() * 8);

	const count = r.u32();
	const records: IrradianceRecord[] = [];
	let file = 0;
	for (let i = 0; i < count; i++) {
		const w = Array.from({ length: RECORD_WORDS }, () => r.u32());
		// each file's records tile it from offset 0
		if (i > 0 && w[2] === 0) {
			file++;
		}
		if (w[4] !== w[5] + w[6] || w[3] > w[4] || file >= files.length) {
			throw new FormatError(`irradiance index: record ${i} doesn't hold together`);
		}
		records.push({ key: w[0], file, offset: w[2], storedLength: w[3], size: w[4] });
	}
	if (file !== files.length - 1) {
		throw new FormatError(`irradiance index: records cover ${file + 1} of ${files.length} files`);
	}
	return { scenarios, files, records };
};

/** @returns the offset of the filename table: a count followed by length-prefixed UTF-16 `iv…` names */
const findFileTable = (data: Uint8Array, from: number): number => {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	for (let at = from; at + 14 <= data.length && at < from + 4096; at += 4) {
		const count = view.getUint32(at, true);
		const length = view.getUint32(at + 4, true);
		if (count > 0 && count < 4096 && length > 4 && length < 512 && view.getUint16(at + 8, true) === 0x69) {
			if (view.getUint16(at + 10, true) === 0x76) {
				return at;
			}
		}
	}
	throw new FormatError('irradiance index: no filename table');
};

/**
 * @param stored a record's stored bytes
 * @param record the record
 * @returns the decompressed cell (a view of `stored` when it isn't compressed)
 * @throws {FormatError} if the LZ4 stream is malformed
 */
export const decodeIrradianceCell = (stored: Uint8Array, record: IrradianceRecord): Uint8Array =>
	record.storedLength === record.size ? stored : decodeInvertedLz4Block(stored, record.size);

/**
 * a decompressed cell, as the GPU reads it (all u32, little-endian): a perfect spatial hash over 4³-probe
 * blocks, `u32 T, u32 O`, `O³` offset words (byte triples), `T³` entries of `(key, probe offset, mask lo,
 * mask hi)`, then 16-byte probes. a block key is `bx | by << 8 | bz << 16` with blocks of `4 · 2^level` probe
 * units (0.5 m); an entry's probes are at `probe offset + popcount(mask below the probe's bit) · 16`
 * (relative to the cell). a probe is L0 rgb as R11G11B10F, then three rgba8 words: the L1 direction of red,
 * green and blue (`· 4 − 2`, relative to that channel's L0) with a validity weight in alpha
 */
export type IrradianceCell = Uint8Array;
