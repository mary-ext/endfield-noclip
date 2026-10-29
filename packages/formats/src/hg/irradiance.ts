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

// both magics share one layout and differ in the volume's extent: the game stores cell keys from the volume's
// minimum corner, and world 0 sits at half the key range. 0x03000003 (map01) spans 4096 m (keys 0–127, world 0 at
// 64), 0x03000004 (map02) 8192 m (world 0 at 128). keys are shifted to the larger range on read, so every scene's
// keys share one origin. the extent itself is set in native code; it's inferred here from where each index's
// keys land (map01's level-0 cells cover its levels only with world 0 at 64).
const SCENE_KEY_ORIGINS = new Map([
	[0x03000003, 64],
	[IRRADIANCE_INDEX_MAGIC, 128],
]);

/** a cell's byte range in its payload file */
export interface IrradianceRecord {
	/**
	 * `x | y << 8 | z << 16 | level << 24`, 8 bits per axis in 32 m units with {@link IRRADIANCE_KEY_ORIGIN} at
	 * world 0, whatever the index stores. a level-`n` cell spans `32 · 2^n` m and its coordinates are multiples
	 * of `2^n`
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

/** a stored scenario combination; hash 0 with no members is the base bake */
export interface IrradianceScenarioGroup {
	hash: number;
	/** indices into {@link IrradianceIndex.scenarios} */
	scenarios: number[];
}

/** a parsed `index.bytes` */
export interface IrradianceIndex {
	/** lighting scenario names, e.g. `Map02_lv002_sunny` */
	scenarios: string[];
	/** payload file names, e.g. `iv_0_0.bytes` (scenario hash, part); records index this list */
	files: string[];
	/** scenario combinations indexed by the hashes in payload filenames */
	scenarioGroups: IrradianceScenarioGroup[];
	/** per payload file, its index into {@link scenarioGroups} */
	fileGroups: number[];
	/** every cell of every payload, in stored order, with explicit indices into {@link files} */
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
 * @throws {FormatError} on a magic other than the scene formats' or a layout that doesn't hold together
 */
export const parseIrradianceIndex = (data: Uint8Array): IrradianceIndex => {
	const r = new BinaryReader(data, { littleEndian: true });
	const magic = r.u32();
	const keyOrigin = SCENE_KEY_ORIGINS.get(magic);
	if (keyOrigin === undefined) {
		throw new FormatError(`irradiance index: magic 0x${magic.toString(16)}`);
	}
	// a whole number of the coarsest cells (4 key units), so cell contents, which address probes within the cell,
	// stay valid
	const keyShift = IRRADIANCE_KEY_ORIGIN - keyOrigin;
	const rekey = (key: number): number => {
		const axis = (shift: number) => ((((key >>> shift) & 255) + keyShift) & 255) << shift;
		return (axis(0) | axis(8) | axis(16) | (key & 0xff000000)) >>> 0;
	};
	const countOf = (stride: number): number => {
		const count = r.u32();
		if (count > Math.floor(r.remaining / stride)) {
			throw new FormatError('irradiance index: count exceeds remaining bytes');
		}
		return count;
	};
	const utf16 = (): string => {
		const length = r.u32();
		if (length % 2 !== 0) {
			throw new FormatError('irradiance index: odd UTF-16 byte length');
		}
		return new TextDecoder('utf-16le', { fatal: true }).decode(r.bytesView(length));
	};
	const scenarios = Array.from({ length: countOf(4) }, utf16);
	// counted (hash, counted scenario-index list) entries precede the filenames.
	const scenarioGroups = Array.from({ length: countOf(8) }, () => {
		const hash = r.u32();
		const members = Array.from({ length: countOf(4) }, () => r.u32());
		if (members.some((member) => member >= scenarios.length) || new Set(members).size !== members.length) {
			throw new FormatError('irradiance index: invalid scenario group');
		}
		return { hash, scenarios: members };
	});
	const groupByHash = new Map(scenarioGroups.map((group, i) => [group.hash, i]));
	if (
		groupByHash.size !== scenarioGroups.length ||
		scenarioGroups.some((group) => (group.hash === 0) !== (group.scenarios.length === 0))
	) {
		throw new FormatError('irradiance index: invalid scenario hashes');
	}
	const files = Array.from({ length: countOf(4) }, utf16);
	if (files.length === 0 || new Set(files).size !== files.length) {
		throw new FormatError('irradiance index: empty or duplicate payload filenames');
	}
	const fileGroups = files.map((name) => {
		const match = /^iv_(0|[1-9]\d*)_(0|[1-9]\d*)\.bytes$/.exec(name);
		const group = match === null ? undefined : groupByHash.get(Number(match[1]));
		if (group === undefined) {
			throw new FormatError(`irradiance index: payload ${name} has no scenario group`);
		}
		return group;
	});

	// the scene's top-level spatial hash over cells (table size, offset-table size, offsets), then a table of
	// (value, scenario) pairs; neither is needed to read the cells
	r.u32();
	const offsetTableSize = r.u32();
	r.skip(offsetTableSize ** 3 * 4);
	r.skip(r.u32() * 8);

	const count = countOf(RECORD_WORDS * 4);
	const records: IrradianceRecord[] = [];
	const ends = Array.from({ length: files.length }, () => 0);
	for (let i = 0; i < count; i++) {
		const w = Array.from({ length: RECORD_WORDS }, () => r.u32());
		// word 7 packs the payload index in its low u16; its upper bits have a separate meaning.
		const file = w[7] & 0xffff;
		if (w[4] !== w[5] + w[6] || w[3] === 0 || w[3] > w[4] || file >= files.length || w[2] !== ends[file]) {
			throw new FormatError(`irradiance index: record ${i} doesn't hold together`);
		}
		ends[file] = w[2] + w[3];
		records.push({ key: rekey(w[0]), file, offset: w[2], storedLength: w[3], size: w[4] });
	}
	if (ends.some((end) => end === 0)) {
		throw new FormatError('irradiance index: payload without records');
	}
	// the final table has five words per entry; their renderer meaning is not yet established.
	r.skip(countOf(20) * 20);
	if (r.remaining !== 0) {
		throw new FormatError('irradiance index: trailing bytes');
	}
	return { scenarios, scenarioGroups, files, fileGroups, records };
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
