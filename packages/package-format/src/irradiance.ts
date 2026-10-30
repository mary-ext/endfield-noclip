import {
	viewOf,
	checkHeader,
	checkLength,
	TABLE_HEADER_SIZE,
	writeHeader,
	type HeaderShape,
} from './binary.ts';

/** world metres covered by one irradiance archive along x and z */
export const IRRADIANCE_ARCHIVE_SIZE = 512;

/**
 * @param x world x (m) of a point in the archive's square
 * @param z world z (m)
 * @returns the stem (see `archiveName`) of the irradiance archive holding the cells over that point
 */
export const irradianceStem = (x: number, z: number): string =>
	`irradiance/${Math.floor(x / IRRADIANCE_ARCHIVE_SIZE)}_${Math.floor(z / IRRADIANCE_ARCHIVE_SIZE)}`;

/**
 * `tables/irradiance.bin`: the baked irradiance volume's cells (the base bake only, without scene-state
 * bakes), each a {@link BlobKind.Irradiance} blob. cell keys are the game's layout: `x | y << 8 | z << 16 |
 * level << 24`, 8 bits per axis in 32 m units with 128 at world 0 for every scene (smaller volumes' keys are
 * shifted to it); a level-`n` cell spans `32 · 2^n` m (probes every `0.5 · 4^n` m) and its coordinates are
 * multiples of `2^n`
 */
export interface IrradianceTable {
	/** cell keys, ascending */
	keys: Uint32Array;
	/** blob index of each cell */
	blobs: Uint32Array;
}

/** 'EFIV' */
const IRRADIANCE_HEADER: HeaderShape = {
	magic: 0x56_49_46_45,
	version: 1,
	size: TABLE_HEADER_SIZE,
	label: 'irradiance table',
};

/**
 * tables/irradiance.bin: 16-byte header (`'EFIV'`, u16 version, u16 0, u32 cellCount, u32 0), then the cell
 * keys (u32 each, ascending), then their blob indices (u32 each).
 *
 * @param table the cells
 * @returns the encoded table
 * @throws {RangeError} if the two lists differ in length or the keys aren't ascending
 */
export const encodeIrradianceTable = (table: IrradianceTable): Uint8Array => {
	const count = table.keys.length;
	if (table.blobs.length !== count) {
		throw new RangeError('irradiance table: keys and blobs differ in length');
	}
	for (let i = 1; i < count; i++) {
		if (table.keys[i] <= table.keys[i - 1]) {
			throw new RangeError('irradiance table: keys must be ascending');
		}
	}
	const out = new Uint8Array(TABLE_HEADER_SIZE + count * 8);
	const view = viewOf(out);
	writeHeader(view, IRRADIANCE_HEADER);
	view.setUint32(8, count, true);
	for (let i = 0; i < count; i++) {
		view.setUint32(TABLE_HEADER_SIZE + i * 4, table.keys[i], true);
		view.setUint32(TABLE_HEADER_SIZE + (count + i) * 4, table.blobs[i], true);
	}
	return out;
};

/**
 * @param data tables/irradiance.bin
 * @returns the cells
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeIrradianceTable = (data: Uint8Array): IrradianceTable => {
	const view = viewOf(data);
	checkHeader(view, IRRADIANCE_HEADER);
	const count = view.getUint32(8, true);
	checkLength(data, TABLE_HEADER_SIZE + count * 8, 'irradiance table');
	const keys = new Uint32Array(count);
	const blobs = new Uint32Array(count);
	for (let i = 0; i < count; i++) {
		keys[i] = view.getUint32(TABLE_HEADER_SIZE + i * 4, true);
		blobs[i] = view.getUint32(TABLE_HEADER_SIZE + (count + i) * 4, true);
	}
	return { keys, blobs };
};
