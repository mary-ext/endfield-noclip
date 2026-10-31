import { FormatError } from '../binary/binary-reader.ts';
import { ByteView } from '../binary/byte-view.ts';

// SparkBuffer config tables (`Data/TableCfg/*.bytes`, Table group). layout recovered from MapIdTable,
// LevelDescTable and I18nTextTable_*; only the value types those use are supported, and anything else fails
// loudly rather than guessing.
//
//   u32 typesOffset, u32 rootOffset, u32 dataOffset
//   types: u32 count, count × { u8 kind (8 = bean), pad4, u32 hash, cstring name, pad4, u32 fieldCount,
//          fieldCount × { cstring name, u8 type, [pad4, u32 typeHash if type = bean] } }
//   root:  u8 0x0a (map), cstring name, u8 keyType, u8 valueType, [pad4, u32 typeHash]
//   data:  u32 slotCount, slotCount × (u32 entriesOffset, u32 entryCount); entries are `key ‖ value` packed
//          with natural alignment. strings and beans are stored as u32 absolute offsets (0xFFFFFFFF = null);
//          beans' fields follow the same packing.

/** value type codes (the game's `SparkType`) */
export const SparkType = {
	Long: 3,
	String: 7,
	Bean: 8,
	Map: 10,
} as const;

/** a decoded SparkBuffer value */
export type SparkValue = bigint | string | null | { [field: string]: SparkValue };

interface BeanType {
	name: string;
	fields: { name: string; type: number; typeHash: number }[];
}

/** a decoded map table */
export interface SparkTable {
	name: string;
	/** entries in storage order */
	entries: [key: bigint | string, value: SparkValue][];
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

	const types = new Map<number, BeanType>();
	{
		let at = u32(0);
		const count = u32(at);
		at += 4;
		for (let t = 0; t < count; t++) {
			const kind = u8(at);
			if (kind !== SparkType.Bean) {
				throw new FormatError(`unsupported spark type definition kind ${kind}`);
			}
			at = align(at + 1, 4);
			const hash = u32(at);
			const [name, afterName] = cString(at + 4);
			at = align(afterName, 4);
			const fieldCount = u32(at);
			at += 4;
			const fields: BeanType['fields'] = [];
			for (let f = 0; f < fieldCount; f++) {
				const [fieldName, afterField] = cString(at);
				const type = u8(afterField);
				at = afterField + 1;
				let typeHash = 0;
				if (type === SparkType.Bean) {
					at = align(at, 4);
					typeHash = u32(at);
					at += 4;
				} else if (type !== SparkType.Long && type !== SparkType.String) {
					throw new FormatError(`unsupported spark field type ${type} in ${name}.${fieldName}`);
				}
				fields.push({ name: fieldName, type, typeHash });
			}
			types.set(hash, { name, fields });
		}
	}

	let at = u32(4);
	const rootKind = u8(at);
	if (rootKind !== SparkType.Map) {
		throw new FormatError(`unsupported spark root kind ${rootKind}`);
	}
	const [name, afterName] = cString(at + 1);
	const keyType = u8(afterName);
	const valueType = u8(afterName + 1);
	let valueBean = 0;
	if (valueType === SparkType.Bean) {
		valueBean = u32(align(afterName + 2, 4));
	}

	/** reads a value of `type` packed at or after `pos`; returns it and the position after it */
	const read = (type: number, typeHash: number, pos: number): [SparkValue, number] => {
		switch (type) {
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
				return [offset === 0xffffffff ? null : readBean(typeHash, offset), p + 4];
			}
			default: {
				throw new FormatError(`unsupported spark value type ${type}`);
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
			const [value, next] = read(field.type, field.typeHash, p);
			out[field.name] = value;
			p = next;
		}
		return out;
	};

	if (keyType !== SparkType.Long && keyType !== SparkType.String) {
		throw new FormatError(`unsupported spark key type ${keyType}`);
	}
	const entries: SparkTable['entries'] = [];
	const data = u32(8);
	const slots = u32(data);
	for (let s = 0; s < slots; s++) {
		const offset = u32(data + 4 + s * 8);
		const count = u32(data + 8 + s * 8);
		let p = offset;
		for (let i = 0; i < count; i++) {
			const [key, afterKey] = read(keyType, 0, p);
			const [value, afterValue] = read(valueType, valueBean, afterKey);
			if (key === null || typeof key === 'object') {
				throw new FormatError(`null spark key in ${name}`);
			}
			entries.push([key, value]);
			p = afterValue;
		}
	}
	return { name, entries };
};

const align = (at: number, to: number): number => Math.ceil(at / to) * to;
