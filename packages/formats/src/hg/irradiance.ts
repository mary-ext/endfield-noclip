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

// the scene magics share one layout and differ in the volume's extent, which sets the key of world 0
// (docs/game-data/irradiance.md#indexbytes)
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

/** a stored scene-state combination; hash 0 with no members is the base bake */
export interface IrradianceStateGroup {
	hash: number;
	/** indices into {@link IrradianceIndex.sceneStates} */
	sceneStates: number[];
}

/** a parsed `index.bytes` */
export interface IrradianceIndex {
	/**
	 * names of the scene states baked separately, e.g. `Map02_lv002_sunny`; the game selects bakes by its
	 * active scene-state mask
	 */
	sceneStates: string[];
	/** payload file names, e.g. `iv_0_0.bytes` (state-group hash, part); records index this list */
	files: string[];
	/** scene-state combinations indexed by the hashes in payload filenames */
	stateGroups: IrradianceStateGroup[];
	/** per payload file, its index into {@link stateGroups} */
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
 * @returns the scene states, payload files and cell ranges
 * @throws {FormatError} on a magic other than the scene formats' or a layout that doesn't hold together
 */
export const parseIrradianceIndex = (data: Uint8Array): IrradianceIndex => {
	const r = new BinaryReader(data, { littleEndian: true });
	const magic = r.u32();
	const keyOrigin = SCENE_KEY_ORIGINS.get(magic);
	if (keyOrigin === undefined) {
		throw new FormatError(`irradiance index: magic 0x${magic.toString(16)}`);
	}
	// a whole number of the coarsest cells (4 key units), so the cells' contents stay valid
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
	const sceneStates = Array.from({ length: countOf(4) }, utf16);
	const stateGroups = Array.from({ length: countOf(8) }, () => {
		const hash = r.u32();
		const members = Array.from({ length: countOf(4) }, () => r.u32());
		if (members.some((member) => member >= sceneStates.length) || new Set(members).size !== members.length) {
			throw new FormatError('irradiance index: invalid scene-state group');
		}
		return { hash, sceneStates: members };
	});
	const groupByHash = new Map(stateGroups.map((group, i) => [group.hash, i]));
	if (
		groupByHash.size !== stateGroups.length ||
		stateGroups.some((group) => (group.hash === 0) !== (group.sceneStates.length === 0))
	) {
		throw new FormatError('irradiance index: invalid scene-state hashes');
	}
	const files = Array.from({ length: countOf(4) }, utf16);
	if (files.length === 0 || new Set(files).size !== files.length) {
		throw new FormatError('irradiance index: empty or duplicate payload filenames');
	}
	const fileGroups = files.map((name) => {
		const match = /^iv_(0|[1-9]\d*)_(0|[1-9]\d*)\.bytes$/.exec(name);
		const group = match === null ? undefined : groupByHash.get(Number(match[1]));
		if (group === undefined) {
			throw new FormatError(`irradiance index: payload ${name} has no scene-state group`);
		}
		return group;
	});

	// the scene's top-level spatial hash over cells (table size, offset-table size, offsets), then a table of
	// (value, state-group hash) pairs; neither is needed to read the cells
	r.u32();
	const offsetTableSize = r.u32();
	r.skip(offsetTableSize ** 3 * 4);
	r.skip(r.u32() * 8);

	const count = countOf(RECORD_WORDS * 4);
	const records: IrradianceRecord[] = [];
	const ends = Array.from({ length: files.length }, () => 0);
	for (let i = 0; i < count; i++) {
		const w = Array.from({ length: RECORD_WORDS }, () => r.u32());
		// word 7's high bits are unknown
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
	// a trailing table of five-word rows, meaning unknown
	r.skip(countOf(20) * 20);
	if (r.remaining !== 0) {
		throw new FormatError('irradiance index: trailing bytes');
	}
	return { sceneStates, stateGroups, files, fileGroups, records };
};

/**
 * @param stored a record's stored bytes
 * @param record the record
 * @returns the decompressed cell (a view of `stored` when it isn't compressed)
 * @throws {FormatError} if the LZ4 stream is malformed
 */
export const decodeIrradianceCell = (stored: Uint8Array, record: IrradianceRecord): Uint8Array =>
	record.storedLength === record.size ? stored : decodeInvertedLz4Block(stored, record.size);

// #region region bakes

/** world metres between a region bake's probes, the finest level's spacing */
export const IRRADIANCE_REGION_SPACING = 0.5;

/** the first word of a region bake */
const REGION_VERSION = 0x1000;

const REGION_HEADER_SIZE = 44;

/** @returns the index of the probe lattice point at or above a world coordinate */
const lattice = (value: number): number => Math.ceil(value / IRRADIANCE_REGION_SPACING);

/** a parsed `regionIv_<room>_<roomType>.bytes`: one room's bake as a dense probe grid */
export interface IrradianceRegion {
	/** the room's world box (m) */
	min: [number, number, number];
	max: [number, number, number];
	/**
	 * the first probe's index on the game's probe lattice (world `index · 0.5` m): the lattice point at or
	 * above {@link min} on each axis
	 */
	origin: [number, number, number];
	/** probes per axis: every lattice point inside the box */
	size: [number, number, number];
	/** 16-byte probes laid out like a cell's (see {@link IrradianceCell}), x fastest, then y, then z */
	probes: Uint8Array;
}

/**
 * parses a region bake: the probes of one Dijiang room with a cabin built in it, which the game streams in
 * over the scene's bake while that cabin stands (docs/game-data/irradiance.md#region-bakes)
 *
 * @param data the file
 * @returns the room's box and probes; `probes` is a view of `data`
 * @throws {FormatError} on an unknown version or header size, a grid that doesn't match the box, or a length
 *   that doesn't match the grid
 */
export const parseIrradianceRegion = (data: Uint8Array): IrradianceRegion => {
	const r = new BinaryReader(data, { littleEndian: true });
	const version = r.u32();
	const headerSize = r.u32();
	if (version !== REGION_VERSION || headerSize !== REGION_HEADER_SIZE) {
		throw new FormatError(`irradiance region: version 0x${version.toString(16)}, header ${headerSize}`);
	}
	const min: [number, number, number] = [r.f32(), r.f32(), r.f32()];
	const max: [number, number, number] = [r.f32(), r.f32(), r.f32()];
	const size: [number, number, number] = [r.u32(), r.u32(), r.u32()];
	const origin: [number, number, number] = [lattice(min[0]), lattice(min[1]), lattice(min[2])];
	for (let axis = 0; axis < 3; axis++) {
		const last = Math.floor(max[axis] / IRRADIANCE_REGION_SPACING);
		if (size[axis] === 0 || last - origin[axis] + 1 !== size[axis]) {
			throw new FormatError('irradiance region: grid size disagrees with its box');
		}
	}
	const probes = r.bytesView(r.remaining);
	if (probes.length !== size[0] * size[1] * size[2] * 16) {
		throw new FormatError('irradiance region: length disagrees with its grid');
	}
	return { min, max, origin, size, probes };
};

// #endregion

/**
 * a decompressed cell, as the GPU reads it: a perfect spatial hash over 4³-probe blocks, then 16-byte probes
 * (docs/game-data/irradiance.md#cells-and-probes)
 */
export type IrradianceCell = Uint8Array;
