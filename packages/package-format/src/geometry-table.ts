/**
 * `tables/geometries.bin.zst`, the geometry table: one zstd frame of the layout below. its own module,
 * outside the asset modules the pack cache fingerprints, so a layout change leaves cached conversions valid
 *
 * @module
 */

import {
	checkHeader,
	checkLength,
	TABLE_HEADER_SIZE,
	viewOf,
	writeHeader,
	type HeaderShape,
} from './binary.ts';
import { EntryStatus, entryStatusCode, entryStatusName } from './entry-status.ts';
import { PackageFormatError } from './errors.ts';
import type { GeometryEntry } from './geometry.ts';

/** the decoded geometry table; a geometry's id is its index */
export interface GeometryTable {
	/** entries in the table; ids run `0…count - 1` */
	readonly count: number;
	/**
	 * @param id geometry id
	 * @returns the ready geometry's {@link BlobKind.Geometry} blob, or `null` when it isn't ready or isn't in
	 *   the table
	 */
	blob(id: number): number | null;
	/**
	 * @param id geometry id
	 * @returns the entry, decoded anew on each call
	 * @throws {RangeError} when `id` isn't in the table
	 */
	entry(id: number): GeometryEntry;
}

/** 'EFGE' */
const GEOMETRIES_HEADER: HeaderShape = {
	magic: 0x45_47_46_45,
	version: 1,
	size: TABLE_HEADER_SIZE,
	label: 'geometry table',
};

const GEOMETRY_RECORD_SIZE = 44;

const NO_TANGENT_UV = 0xff;

const NO_BLOB = 0xff_ff_ff_ff;

/**
 * the geometry table: 16-byte header (`'EFGE'`, u16 version, u16 0, u32 count, u32 0), then 44-byte records:
 * u8 status ({@link EntryStatus}), u8 tangentUv (`0xff` for none), u16 attributes, u32 blob, u32 vertexCount,
 * u32 indexCount, u16 submeshCount, u16 animationFrames (0 for none), f32×3 min, f32×3 max. an unconverted
 * entry's fields past its status are 0.
 *
 * @param entries entries in id order
 * @returns the encoded table
 * @throws {RangeError} if a field doesn't fit its record, or an animation has no frames
 */
export const encodeGeometryTable = (entries: readonly GeometryEntry[]): Uint8Array => {
	const out = new Uint8Array(TABLE_HEADER_SIZE + entries.length * GEOMETRY_RECORD_SIZE);
	const view = viewOf(out);
	writeHeader(view, GEOMETRIES_HEADER);
	view.setUint32(8, entries.length, true);
	for (const [id, entry] of entries.entries()) {
		const at = TABLE_HEADER_SIZE + id * GEOMETRY_RECORD_SIZE;
		view.setUint8(at, entryStatusCode(entry.status));
		if (entry.status !== 'ready') {
			continue;
		}
		const { tangentUv, animationFrames } = entry;
		if (
			(tangentUv !== null && (tangentUv < 0 || tangentUv >= NO_TANGENT_UV)) ||
			entry.attributes > 0xff_ff ||
			entry.submeshCount > 0xff_ff ||
			(animationFrames !== null && (animationFrames < 1 || animationFrames > 0xff_ff))
		) {
			throw new RangeError(`geometry ${id} has a field out of its record's range`);
		}
		view.setUint8(at + 1, tangentUv ?? NO_TANGENT_UV);
		view.setUint16(at + 2, entry.attributes, true);
		view.setUint32(at + 4, entry.blob, true);
		view.setUint32(at + 8, entry.vertexCount, true);
		view.setUint32(at + 12, entry.indexCount, true);
		view.setUint16(at + 16, entry.submeshCount, true);
		view.setUint16(at + 18, animationFrames ?? 0, true);
		for (let i = 0; i < 3; i++) {
			view.setFloat32(at + 20 + i * 4, entry.bounds.min[i], true);
			view.setFloat32(at + 32 + i * 4, entry.bounds.max[i], true);
		}
	}
	return out;
};

/**
 * checks every record's status once, so the table's accessors never throw on content
 *
 * @param data the geometry table, inflated
 * @returns the table, reading records in place
 * @throws {PackageFormatError} on a bad header, length or status
 */
export const decodeGeometryTable = (data: Uint8Array): GeometryTable => {
	const view = viewOf(data);
	checkHeader(view, GEOMETRIES_HEADER);
	const count = view.getUint32(8, true);
	checkLength(data, TABLE_HEADER_SIZE + count * GEOMETRY_RECORD_SIZE, 'geometry table');
	const blobs = new Uint32Array(count);
	for (let id = 0; id < count; id++) {
		const at = TABLE_HEADER_SIZE + id * GEOMETRY_RECORD_SIZE;
		const status = view.getUint8(at);
		if (status > EntryStatus.Failed) {
			throw new PackageFormatError(`geometry ${id} has unknown status ${status}`);
		}
		blobs[id] = status === EntryStatus.Ready ? view.getUint32(at + 4, true) : NO_BLOB;
	}
	return {
		count,
		blob(id) {
			const blob = blobs[id];
			return blob === undefined || blob === NO_BLOB ? null : blob;
		},
		entry(id) {
			if (!(id >= 0 && id < count)) {
				throw new RangeError(`geometry ${id} isn't in the table`);
			}
			const at = TABLE_HEADER_SIZE + id * GEOMETRY_RECORD_SIZE;
			const status = entryStatusName(view.getUint8(at), `geometry ${id}`);
			if (status !== 'ready') {
				return { status };
			}
			const f = (offset: number): number => view.getFloat32(at + offset, true);
			const tangentUv = view.getUint8(at + 1);
			const animationFrames = view.getUint16(at + 18, true);
			return {
				status,
				blob: view.getUint32(at + 4, true),
				bounds: { min: [f(20), f(24), f(28)], max: [f(32), f(36), f(40)] },
				vertexCount: view.getUint32(at + 8, true),
				indexCount: view.getUint32(at + 12, true),
				submeshCount: view.getUint16(at + 16, true),
				attributes: view.getUint16(at + 2, true),
				tangentUv: tangentUv === NO_TANGENT_UV ? null : tangentUv,
				animationFrames: animationFrames === 0 ? null : animationFrames,
			};
		},
	};
};
