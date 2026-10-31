import { FormatError } from '../binary/binary-reader.ts';
import { FlatBuffer } from '../binary/flatbuffer.ts';

import { ChunkObjectKind, INIT_CHUNK_VERSIONS } from './init-chunk-data.ts';

// the tag-1 members of the InitChunkData / StreamingChunkData root union vector (slots 3–5, see
// `init-chunk-data.ts`): GameObjects the client rebuilds as MonoBehaviours (environment volumes, post volumes,
// reflection probes, lights, wind motors, water, terrain root). an Init row and the Streaming row at the same
// index describe the same object: Init carries the name and the inline values, Streaming carries the asset
// references (and some nested blobs), so the two are merged per component.
//
//   row         0 name (Init; empty in Streaming)   1 u32 ?   3 u64 StreamingComponentType mask
//               4 [component]
//   component   0 u32 component type (one mask bit)  3 [u32 field key]  4 [u8 value type]  5 [uoffset → value]
//
// a field key is `bit << 24 | field << 16 | element`: the component's mask bit index (14 for 0x4000; 0 for
// Transform), the field's index in its class and, for fixed arrays (matrix rows, curve keys), the element. a value
// is addressed by a uoffset in slot 5 and laid out by its type code, see {@link MonoValue}. layout found here,
// checked against `Env_*` volumes (whose envPhase hashes resolve to `EnvParse/Env_*.asset`) and Global Volumes.

// #region types

/** `StreamingComponentType` bits (IL2CPP metadata enum) of the components decoded here */
export const MonoComponentType = {
	Transform: 0x1,
	BoxCollider: 0x10,
	HGEnvironmentVolume: 0x4000,
	Volume: 0x8000,
} as const;

/** a decoded component value */
export type MonoValue =
	| { type: 'bool'; value: boolean }
	| { type: 'int'; value: number }
	| { type: 'uint'; value: number }
	| { type: 'float'; value: number }
	| { type: 'uint64'; value: bigint }
	| { type: 'vector3'; value: [x: number, y: number, z: number] }
	| { type: 'vector4'; value: [x: number, y: number, z: number, w: number] }
	| { type: 'bounds'; center: [x: number, y: number, z: number]; extents: [x: number, y: number, z: number] }
	/** a StringPathHash key of an asset, plus a code for its kind (6 for ScriptableObjects, 1, 3, 4, 7, 8 seen) */
	| { type: 'asset'; hash: bigint; kind: number }
	| { type: 'string'; value: string }
	/** a serialized struct the client parses itself (polyline shapes, probe data); a view into the file */
	| { type: 'blob'; value: Uint8Array }
	| { type: 'unknown'; code: number };

/** one component of a {@link MonoObject} */
export interface MonoComponent {
	/** a {@link MonoComponentType} bit */
	type: number;
	/** values by field key (`bit << 24 | field << 16 | element`) */
	fields: Map<number, MonoValue>;
}

/** a tag-1 root object */
export interface MonoObject {
	id: number;
	/** the GameObject name with its `#<tag>_<hex id>` suffix */
	name: string;
	components: MonoComponent[];
}

/** a row of the root union vector (slots 3–5) */
export interface ChunkRow {
	id: number;
	/** union tag, see `ChunkObjectKind` */
	tag: number;
	/** position of the row's table */
	table: number;
}

// #endregion

/** value type codes of {@link MonoValue}s */
export const ValueCode = {
	Bool: 1,
	Int: 2,
	Uint: 3,
	Float: 4,
	Uint64: 6,
	Vector3: 9,
	Vector4: 10,
	Bounds: 14,
	Asset: 15,
	String: 16,
	Blob: 17,
} as const;

/**
 * reads the tag-1 objects of a chunk, merging each Init row with the Streaming row at the same index
 *
 * @param init an InitChunkData FlatBuffer (after `unpackHgPayload`)
 * @param streaming the paired StreamingChunkData FlatBuffer, or `null` without one (asset references are then
 *   missing)
 * @returns the objects in row order
 * @throws {FormatError} if the files disagree on the object list or a value doesn't frame
 */
export const readMonoObjects = (init: Uint8Array, streaming: Uint8Array | null): MonoObject[] => {
	const initRows = readChunkRows(init);
	const streamRows = streaming === null ? null : readChunkRows(streaming);
	if (streamRows !== null && streamRows.rows.length !== initRows.rows.length) {
		throw new FormatError('init and streaming chunks list different object counts');
	}

	const objects: MonoObject[] = [];
	for (const [i, row] of initRows.rows.entries()) {
		if (row.tag !== ChunkObjectKind.Mono) {
			continue;
		}
		const pair = streamRows?.rows[i];
		if (pair !== undefined && (pair.id !== row.id || pair.tag !== row.tag)) {
			throw new FormatError(`object ${i}: init id ${row.id} pairs with streaming id ${pair.id}`);
		}
		const { fb } = initRows;
		const nameAt = fb.field(row.table, 0);
		const name = nameAt === undefined ? '' : textDecoder.decode(fb.byteVector(row.table, 0));
		const components = readComponents(fb, row.table);
		if (pair !== undefined && streamRows !== null) {
			for (const extra of readComponents(streamRows.fb, pair.table)) {
				const target = components.find((component) => component.type === extra.type);
				if (target === undefined) {
					components.push(extra);
				} else {
					for (const [key, value] of extra.fields) {
						target.fields.set(key, value);
					}
				}
			}
		}
		objects.push({ id: row.id, name, components });
	}
	return objects;
};

/**
 * @param init an InitChunkData FlatBuffer (after `unpackHgPayload`)
 * @param mask `StreamingComponentType` bits ({@link MonoComponentType} values or'd together)
 * @returns whether a tag-1 object has one of the components, by the rows' component masks; cheaper than
 *   {@link readMonoObjects}
 * @throws {FormatError} if the root doesn't frame
 */
export const hasMonoComponents = (init: Uint8Array, mask: bigint): boolean => {
	const { fb, rows } = readChunkRows(init);
	return rows.some((row) => {
		if (row.tag !== ChunkObjectKind.Mono) {
			return false;
		}
		const at = fb.field(row.table, 3);
		return at !== undefined && (fb.u64(at) & mask) !== 0n;
	});
};

/**
 * @param object a decoded object
 * @param type a {@link MonoComponentType} bit
 * @returns its component of that type, if any
 */
export const monoComponent = (object: MonoObject, type: number): MonoComponent | undefined =>
	object.components.find((component) => component.type === type);

/**
 * @param component a component whose type is a single mask bit below 2³²
 * @param field the field's index in the component's class
 * @returns the field's value (its first element, for fixed arrays), if present
 */
export const monoField = (component: MonoComponent, field: number): MonoValue | undefined => {
	const bit = 31 - Math.clz32(component.type);
	return component.fields.get(((bit << 24) | (field << 16)) >>> 0);
};

/**
 * reads the root of an InitChunkData or StreamingChunkData FlatBuffer (the two share it)
 *
 * @param data the file after `unpackHgPayload`
 * @returns the reader, root version and the union rows
 * @throws {FormatError} if the root isn't the 8-slot chunk root of a known version
 */
export const readChunkRows = (data: Uint8Array): { fb: FlatBuffer; version: number; rows: ChunkRow[] } => {
	const fb = new FlatBuffer(data);
	const root = fb.root();
	if (fb.fieldCount(root) !== 8) {
		throw new FormatError(`chunk root has ${fb.fieldCount(root)} fields, expected 8`);
	}
	const versionAt = fb.field(root, 0);
	const version = versionAt === undefined ? 0 : fb.u32(versionAt);
	if (!INIT_CHUNK_VERSIONS.includes(version)) {
		throw new FormatError(`unsupported chunk version ${version}`);
	}
	const ids = fb.vector(root, 3);
	const tags = fb.vector(root, 4);
	const tables = fb.vector(root, 5);
	if (ids.length !== tags.length || ids.length !== tables.length) {
		throw new FormatError('chunk object vectors differ in length');
	}
	const rows = Array.from({ length: ids.length }, (_, i) => ({
		id: fb.u32(ids.start + i * 4),
		tag: fb.u8(tags.start + i),
		table: fb.tableAt(tables.start, i),
	}));
	return { fb, version, rows };
};

/**
 * reads a keyed property table: `3 [u32 key] 4 [u8 value type] 5 [uoffset → value]`
 *
 * @param fb the chunk's reader
 * @param table position of the table
 * @returns the keys and values in stored order (keys can repeat)
 * @throws {FormatError} if the three vectors differ in length
 */
export const readPropertyTable = (fb: FlatBuffer, table: number): [key: number, value: MonoValue][] => {
	const keys = fb.vector(table, 3);
	const codes = fb.vector(table, 4);
	const values = fb.vector(table, 5);
	if (keys.length !== codes.length || keys.length !== values.length) {
		throw new FormatError(
			`property table has ${keys.length} keys, ${codes.length} types, ${values.length} values`,
		);
	}
	return Array.from({ length: keys.length }, (_, v) => [
		fb.u32(keys.start + v * 4),
		readValue(fb, fb.u8(codes.start + v), fb.deref(values.start + v * 4)),
	]);
};

const readComponents = (fb: FlatBuffer, row: number): MonoComponent[] => {
	const list = fb.vector(row, 4);
	const components: MonoComponent[] = [];
	for (let c = 0; c < list.length; c++) {
		const table = fb.tableAt(list.start, c);
		const typeAt = fb.field(table, 0);
		components.push({
			type: typeAt === undefined ? 0 : fb.u32(typeAt),
			fields: new Map(readPropertyTable(fb, table)),
		});
	}
	return components;
};

const readValue = (fb: FlatBuffer, code: number, at: number): MonoValue => {
	const floats = (count: number): number[] => Array.from({ length: count }, (_, i) => fb.f32(at + i * 4));
	switch (code) {
		case ValueCode.Bool: {
			return { type: 'bool', value: fb.u8(at) !== 0 };
		}
		case ValueCode.Int: {
			return { type: 'int', value: fb.i32(at) };
		}
		case ValueCode.Uint: {
			return { type: 'uint', value: fb.u32(at) };
		}
		case ValueCode.Float: {
			return { type: 'float', value: fb.f32(at) };
		}
		case ValueCode.Uint64: {
			return { type: 'uint64', value: fb.u64(at) };
		}
		case ValueCode.Vector3: {
			const [x, y, z] = floats(3);
			return { type: 'vector3', value: [x, y, z] };
		}
		case ValueCode.Vector4: {
			const [x, y, z, w] = floats(4);
			return { type: 'vector4', value: [x, y, z, w] };
		}
		case ValueCode.Bounds: {
			const v = floats(6);
			return { type: 'bounds', center: [v[0], v[1], v[2]], extents: [v[3], v[4], v[5]] };
		}
		case ValueCode.Asset: {
			return { type: 'asset', hash: fb.u64(at), kind: fb.u32(at + 8) };
		}
		case ValueCode.String: {
			return {
				type: 'string',
				value: fb.field(at, 0) === undefined ? '' : textDecoder.decode(fb.byteVector(at, 0)),
			};
		}
		case ValueCode.Blob: {
			// a table holding a table holding the bytes; empty structs leave the inner fields out
			const innerAt = fb.field(at, 0);
			if (innerAt === undefined) {
				return { type: 'blob', value: new Uint8Array(0) };
			}
			const inner = fb.deref(innerAt);
			return {
				type: 'blob',
				value: fb.field(inner, 0) === undefined ? new Uint8Array(0) : fb.byteVector(inner, 0),
			};
		}
		default: {
			return { type: 'unknown', code };
		}
	}
};

const textDecoder = new TextDecoder('utf-8');
