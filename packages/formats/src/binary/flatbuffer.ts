import { ByteView } from './byte-view.ts';

/**
 * minimal schema-less FlatBuffers accessor. Endfield ships no `.fbs` schemas for its world data, so readers
 * address fields by vtable slot index and validate everything they dereference.
 */
export class FlatBuffer extends ByteView {
	/** @param bytes the whole FlatBuffer; not copied */
	constructor(bytes: Uint8Array) {
		super(bytes, 'flatbuffer');
	}

	/** @returns position of the root table */
	root(): number {
		return this.u32(0);
	}

	/** @returns the number of vtable slots a table declares */
	fieldCount(table: number): number {
		const vtable = table - this.i32(table);
		return (this.u16(vtable) - 4) >> 1;
	}

	/**
	 * @param table table position
	 * @param slot vtable slot index
	 * @returns absolute position of the field, or `undefined` if absent (default-valued)
	 */
	field(table: number, slot: number): number | undefined {
		const vtable = table - this.i32(table);
		const vtableSize = this.u16(vtable);
		if (4 + slot * 2 >= vtableSize) {
			return undefined;
		}
		const relative = this.u16(vtable + 4 + slot * 2);
		return relative === 0 ? undefined : table + relative;
	}

	/** follows the uoffset stored at `at` */
	deref(at: number): number {
		return at + this.u32(at);
	}

	/**
	 * @param table table position
	 * @param slot vtable slot holding a vector uoffset
	 * @returns the vector's element start and length; an absent field reads as empty
	 */
	vector(table: number, slot: number): { start: number; length: number } {
		const at = this.field(table, slot);
		if (at === undefined) {
			return { start: 0, length: 0 };
		}
		const vector = this.deref(at);
		const length = this.u32(vector);
		return { start: vector + 4, length };
	}

	/** @returns the table referenced by element `index` of a vector of tables */
	tableAt(vectorStart: number, index: number): number {
		return this.deref(vectorStart + index * 4);
	}

	/** @returns a view (not a copy) of a byte vector stored in slot `slot` */
	byteVector(table: number, slot: number): Uint8Array {
		const { start, length } = this.vector(table, slot);
		return this.subarray(start, length);
	}
}
