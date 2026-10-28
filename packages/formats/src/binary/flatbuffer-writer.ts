/**
 * a forward-only FlatBuffer writer for synthetic test data: everything a table references is written after
 * it, so uoffsets stay positive. positions are absolute byte offsets into {@link bytes}
 */
export class FlatBufferWriter {
	readonly bytes: Uint8Array;
	readonly view: DataView;
	pos = 0;

	/** @param capacity buffer size in bytes; writes past it throw */
	constructor(capacity = 1 << 16) {
		this.bytes = new Uint8Array(capacity);
		this.view = new DataView(this.bytes.buffer);
	}

	/** @returns the position of `size` new bytes, aligned to `align` */
	reserve(size: number, align = 4): number {
		this.pos = Math.ceil(this.pos / align) * align;
		const at = this.pos;
		this.pos += size;
		return at;
	}

	/**
	 * writes a vtable + table with inline fields of the given sizes (0 = absent)
	 *
	 * @returns the table position and each field's position (`-1` if absent)
	 */
	table(sizes: number[]): { at: number; fields: number[] } {
		const vtable = this.reserve(4 + sizes.length * 2, 2);
		const offsets: number[] = [];
		let cursor = 4;
		for (const size of sizes) {
			if (size === 0) {
				offsets.push(0);
				continue;
			}
			cursor = Math.ceil(cursor / Math.min(size, 4)) * Math.min(size, 4);
			offsets.push(cursor);
			cursor += size;
		}
		const at = this.reserve(cursor, 4);
		this.view.setUint16(vtable, 4 + sizes.length * 2, true);
		this.view.setUint16(vtable + 2, cursor, true);
		offsets.forEach((offset, i) => this.view.setUint16(vtable + 4 + i * 2, offset, true));
		this.view.setInt32(at, at - vtable, true);
		return { at, fields: offsets.map((offset) => (offset === 0 ? -1 : at + offset)) };
	}

	/**
	 * writes `u32 length` + room for the elements
	 *
	 * @returns the vector position and its element start
	 */
	vector(elementSize: number, length: number): { at: number; start: number } {
		const at = this.reserve(4 + elementSize * length, 4);
		this.view.setUint32(at, length, true);
		return { at, start: at + 4 };
	}

	/** stores at `at` the uoffset to `target` */
	link(at: number, target: number): void {
		this.view.setUint32(at, target - at, true);
	}

	/**
	 * writes a vector of `count` uoffsets linked from `field`
	 *
	 * @returns the element positions, to link from
	 */
	offsets(field: number, count: number): number[] {
		const { at, start } = this.vector(4, count);
		this.link(field, at);
		return Array.from({ length: count }, (_, i) => start + i * 4);
	}

	/** writes a `[u32]` vector linked from `field` */
	u32s(field: number, values: readonly number[]): void {
		const { at, start } = this.vector(4, values.length);
		values.forEach((value, i) => this.view.setUint32(start + i * 4, value, true));
		this.link(field, at);
	}

	/** writes a `[u8]` vector linked from `field` */
	u8s(field: number, values: ArrayLike<number>): void {
		const { at, start } = this.vector(1, values.length);
		this.bytes.set(values, start);
		this.link(field, at);
	}

	/**
	 * writes the 8-slot root InitChunkData and StreamingChunkData share, with version 49 and the Global chunk's
	 * origin
	 *
	 * @returns the root's field positions
	 */
	chunkRoot(): number[] {
		const root = this.reserve(4);
		const table = this.table([4, 8, 0, 4, 4, 4, 4, 4]);
		this.link(root, table.at);
		this.view.setUint32(table.fields[0], 49, true);
		this.view.setInt32(table.fields[1], 0x7fffffff, true);
		this.view.setInt32(table.fields[1] + 4, -0x80000000, true);
		return table.fields;
	}

	/** @returns a copy of what was written */
	finish(): Uint8Array {
		return this.bytes.slice(0, this.pos);
	}
}
