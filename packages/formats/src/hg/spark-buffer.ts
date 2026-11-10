import { FormatError } from '../binary/binary-reader.ts';
import { ByteView } from '../binary/byte-view.ts';

// SparkBuffer config tables (`Data/TableCfg/*.bytes`, Table group):
//
//   u32 typesOffset, u32 rootOffset, u32 dataOffset
//   types: u32 count, count × { u8 kind (6 = enum, 8 = bean), pad4, u32 hash, cstring name, pad4, then
//          bean: u32 fieldCount, fieldCount × { cstring name, type ref }
//          enum: u32 valueCount, valueCount × { cstring name, pad4, i32 value } }
//   type ref: u8 type, then [pad4, u32 typeHash] for beans and enums, the element's type ref for arrays, or
//             the key's and the value's type refs for maps
//   root:  u8 0x0a (map), cstring name, key type ref, value type ref
//   data:  u32 slotCount, slotCount × (u32 entriesOffset, u32 entryCount); entries are `key ‖ value` packed
//          with natural alignment. bools and bytes are u8, enums i32, floats f32, doubles f64. strings, beans,
//          arrays and maps are stored as u32 absolute offsets (0xFFFFFFFF = null); a bean's fields follow the
//          same packing, an array is `u32 count ‖ elements`, and a map field has the root's data layout.

/** value type codes (the game's `SparkType`) */
export const SparkType = {
	Bool: 0,
	Byte: 1,
	Int: 2,
	Long: 3,
	Float: 4,
	Double: 5,
	Enum: 6,
	String: 7,
	Bean: 8,
	Array: 9,
	Map: 10,
} as const;

/**
 * a decoded SparkBuffer value; enums decode to their numeric value, maps to objects keyed by their keys as
 * strings
 */
export type SparkValue =
	| boolean
	| number
	| bigint
	| string
	| null
	| SparkValue[]
	| { [field: string]: SparkValue };

/**
 * @param value a decoded value
 * @returns whether it's a bean or a map (an object), not null, a scalar or an array
 */
export const isSparkBean = (value: SparkValue | undefined): value is { [field: string]: SparkValue } =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

/** a field's or element's type */
interface TypeRef {
	type: number;
	/** the bean's type hash, for beans */
	typeHash: number;
	/** the key type, for maps */
	key: TypeRef | null;
	/** the element type, for arrays; the value type, for maps */
	element: TypeRef | null;
}

interface BeanType {
	name: string;
	fields: { name: string; ref: TypeRef }[];
}

/** a decoded map table */
export interface SparkTable {
	name: string;
	/** entries in storage order */
	entries: [key: number | bigint | string, value: SparkValue][];
}

/**
 * decodes a SparkBuffer map table
 *
 * @param bytes the table file
 * @returns the table's entries as plain values
 * @throws {FormatError} on unsupported types or framing errors
 */
export const parseSparkTable = (bytes: Uint8Array): SparkTable => {
	const view = new ByteView(bytes, 'spark');
	const u32 = (at: number): number => view.u32(at);
	const u8 = (at: number): number => view.u8(at);
	const cString = (at: number): [string, number] => view.cString(at);

	/** reads a type ref at `at`; returns it and the position after it */
	const readRef = (at: number, where: string): [TypeRef, number] => {
		const type = u8(at);
		switch (type) {
			case SparkType.Bool:
			case SparkType.Byte:
			case SparkType.Int:
			case SparkType.Long:
			case SparkType.Float:
			case SparkType.Double:
			case SparkType.String: {
				return [{ type, typeHash: 0, key: null, element: null }, at + 1];
			}
			case SparkType.Enum:
			case SparkType.Bean: {
				const p = align(at + 1, 4);
				return [{ type, typeHash: u32(p), key: null, element: null }, p + 4];
			}
			case SparkType.Array: {
				const [element, after] = readRef(at + 1, where);
				return [{ type, typeHash: 0, key: null, element }, after];
			}
			case SparkType.Map: {
				const [key, afterKey] = readRef(at + 1, `${where} key`);
				const [element, after] = readRef(afterKey, `${where} value`);
				return [{ type, typeHash: 0, key, element }, after];
			}
			default: {
				throw new FormatError(`unsupported spark type ${type} in ${where}`);
			}
		}
	};

	const types = new Map<number, BeanType>();
	{
		let at = u32(0);
		const count = u32(at);
		at += 4;
		for (let t = 0; t < count; t++) {
			const kind = u8(at);
			if (kind !== SparkType.Bean && kind !== SparkType.Enum) {
				throw new FormatError(`unsupported spark type definition kind ${kind}`);
			}
			at = align(at + 1, 4);
			const hash = u32(at);
			const [name, afterName] = cString(at + 4);
			at = align(afterName, 4);
			const memberCount = u32(at);
			at += 4;
			if (kind === SparkType.Enum) {
				// values are read as numbers, so the names aren't kept
				for (let v = 0; v < memberCount; v++) {
					at = align(cString(at)[1], 4) + 4;
				}
				continue;
			}
			const fields: BeanType['fields'] = [];
			for (let f = 0; f < memberCount; f++) {
				const [fieldName, afterField] = cString(at);
				const [ref, afterRef] = readRef(afterField, `${name}.${fieldName}`);
				at = afterRef;
				fields.push({ name: fieldName, ref });
			}
			types.set(hash, { name, fields });
		}
	}

	const rootAt = u32(4);
	const rootKind = u8(rootAt);
	if (rootKind !== SparkType.Map) {
		throw new FormatError(`unsupported spark root kind ${rootKind}`);
	}
	const [name, afterName] = cString(rootAt + 1);
	const [keyRef, afterKeyRef] = readRef(afterName, `${name} key`);
	const [valueRef] = readRef(afterKeyRef, `${name} value`);

	/** reads a value of type `ref` packed at or after `pos`; returns it and the position after it */
	const read = (ref: TypeRef, pos: number): [SparkValue, number] => {
		switch (ref.type) {
			case SparkType.Bool: {
				return [u8(pos) !== 0, pos + 1];
			}
			case SparkType.Byte: {
				return [u8(pos), pos + 1];
			}
			case SparkType.Float: {
				const p = align(pos, 4);
				return [view.f32(p), p + 4];
			}
			case SparkType.Double: {
				const p = align(pos, 8);
				return [view.f64(p), p + 8];
			}
			case SparkType.Int:
			case SparkType.Enum: {
				const p = align(pos, 4);
				return [view.i32(p), p + 4];
			}
			case SparkType.Long: {
				const p = align(pos, 8);
				return [view.i64(p), p + 8];
			}
			case SparkType.String: {
				const p = align(pos, 4);
				const offset = u32(p);
				return [offset === 0xffffffff ? null : cString(offset)[0], p + 4];
			}
			case SparkType.Bean: {
				const p = align(pos, 4);
				const offset = u32(p);
				return [offset === 0xffffffff ? null : readBean(ref.typeHash, offset), p + 4];
			}
			case SparkType.Array: {
				const p = align(pos, 4);
				const offset = u32(p);
				if (offset === 0xffffffff) {
					return [null, p + 4];
				}
				const items: SparkValue[] = [];
				let q = offset + 4;
				for (let i = 0, count = u32(offset); i < count; i++) {
					const [item, next] = read(ref.element!, q);
					items.push(item);
					q = next;
				}
				return [items, p + 4];
			}
			case SparkType.Map: {
				const p = align(pos, 4);
				const offset = u32(p);
				if (offset === 0xffffffff) {
					return [null, p + 4];
				}
				const out: { [key: string]: SparkValue } = {};
				for (const [key, value] of readMap(ref.key!, ref.element!, offset, 'nested map')) {
					out[String(key)] = value;
				}
				return [out, p + 4];
			}
			default: {
				throw new FormatError(`unsupported spark value type ${ref.type}`);
			}
		}
	};
	const readBean = (hash: number, pos: number): { [field: string]: SparkValue } => {
		const type = types.get(hash);
		if (type === undefined) {
			throw new FormatError(`unknown spark bean hash ${hash.toString(16)}`);
		}
		const out: { [field: string]: SparkValue } = {};
		let p = pos;
		for (const field of type.fields) {
			const [value, next] = read(field.ref, p);
			out[field.name] = value;
			p = next;
		}
		return out;
	};

	/** reads a hash map stored at `data` (the root's and nested maps' layout) */
	const readMap = (
		keyType: TypeRef,
		valueType: TypeRef,
		data: number,
		where: string,
	): SparkTable['entries'] => {
		if (
			keyType.type !== SparkType.Int &&
			keyType.type !== SparkType.Long &&
			keyType.type !== SparkType.String
		) {
			throw new FormatError(`unsupported spark key type ${keyType.type} in ${where}`);
		}
		const entries: SparkTable['entries'] = [];
		const slots = u32(data);
		for (let s = 0; s < slots; s++) {
			const offset = u32(data + 4 + s * 8);
			const count = u32(data + 8 + s * 8);
			let p = offset;
			for (let i = 0; i < count; i++) {
				const [key, afterKey] = read(keyType, p);
				const [value, afterValue] = read(valueType, afterKey);
				// the key type was checked above; this narrows the value for TypeScript
				if (key === null || typeof key === 'object' || typeof key === 'boolean') {
					throw new FormatError(`null spark key in ${where}`);
				}
				entries.push([key, value]);
				p = afterValue;
			}
		}
		return entries;
	};

	return { name, entries: readMap(keyRef, valueRef, u32(8), name) };
};

const align = (at: number, to: number): number => Math.ceil(at / to) * to;
