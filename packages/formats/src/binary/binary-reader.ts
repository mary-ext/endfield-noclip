/** thrown when a decoder meets data that doesn't match the expected layout */
export class FormatError extends Error {
	override name = 'FormatError';
}

/**
 * bounds-checked cursor over a byte buffer.
 *
 * endianness is switchable mid-stream because Unity's SerializedFile header is big-endian while its body
 * follows the file's declared endianness.
 */
export class BinaryReader {
	readonly bytes: Uint8Array;
	readonly view: DataView;
	offset: number;
	littleEndian: boolean;

	/**
	 * @param bytes buffer to read; not copied
	 * @param options.offset starting position
	 * @param options.littleEndian initial byte order
	 */
	constructor(bytes: Uint8Array, options: { offset?: number; littleEndian: boolean }) {
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.offset = options.offset ?? 0;
		this.littleEndian = options.littleEndian;
	}

	get length(): number {
		return this.bytes.byteLength;
	}

	get remaining(): number {
		return this.bytes.byteLength - this.offset;
	}

	#claim(size: number): number {
		const at = this.offset;
		if (size < 0 || at + size > this.bytes.byteLength) {
			throw new FormatError(
				`read of ${size} bytes at 0x${at.toString(16)} exceeds buffer of ${this.bytes.byteLength}`,
			);
		}
		this.offset = at + size;
		return at;
	}

	skip(size: number): void {
		this.#claim(size);
	}

	/** aligns the cursor to a multiple of `alignment`, relative to the buffer start */
	align(alignment: number): void {
		const misalignment = this.offset % alignment;
		if (misalignment !== 0) {
			this.#claim(alignment - misalignment);
		}
	}

	/** @returns a view (not a copy) of the next `size` bytes */
	bytesView(size: number): Uint8Array {
		const at = this.#claim(size);
		return this.bytes.subarray(at, at + size);
	}

	u8(): number {
		return this.view.getUint8(this.#claim(1));
	}

	i8(): number {
		return this.view.getInt8(this.#claim(1));
	}

	bool(): boolean {
		return this.u8() !== 0;
	}

	u16(): number {
		return this.view.getUint16(this.#claim(2), this.littleEndian);
	}

	i16(): number {
		return this.view.getInt16(this.#claim(2), this.littleEndian);
	}

	u32(): number {
		return this.view.getUint32(this.#claim(4), this.littleEndian);
	}

	i32(): number {
		return this.view.getInt32(this.#claim(4), this.littleEndian);
	}

	u64(): bigint {
		return this.view.getBigUint64(this.#claim(8), this.littleEndian);
	}

	i64(): bigint {
		return this.view.getBigInt64(this.#claim(8), this.littleEndian);
	}

	/**
	 * reads a signed 64-bit integer that must fit in a JS number (offsets, lengths)
	 *
	 * @throws {FormatError} if the value exceeds `Number.MAX_SAFE_INTEGER`
	 */
	i64Number(): number {
		const at = this.offset;
		const value = this.i64();
		if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
			throw new FormatError(`64-bit value ${value} at 0x${at.toString(16)} isn't a safe integer`);
		}
		return Number(value);
	}

	/** @see i64Number */
	u64Number(): number {
		const at = this.offset;
		const value = this.u64();
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new FormatError(`64-bit value ${value} at 0x${at.toString(16)} isn't a safe integer`);
		}
		return Number(value);
	}

	f32(): number {
		return this.view.getFloat32(this.#claim(4), this.littleEndian);
	}

	f64(): number {
		return this.view.getFloat64(this.#claim(8), this.littleEndian);
	}

	/** reads a NUL-terminated UTF-8 string, consuming the terminator */
	cString(maxLength = 4096): string {
		const start = this.offset;
		const end = this.bytes.indexOf(0, start);
		if (end < 0 || end - start > maxLength) {
			throw new FormatError(`unterminated string at 0x${start.toString(16)}`);
		}
		this.offset = end + 1;
		return utf8.decode(this.bytes.subarray(start, end));
	}

	/** reads `size` bytes as UTF-8 */
	utf8(size: number): string {
		return utf8.decode(this.bytesView(size));
	}
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** @returns uppercase hex of `bytes` */
export const toHex = (bytes: Uint8Array): string => {
	let out = '';
	for (const byte of bytes) {
		out += byte.toString(16).padStart(2, '0');
	}
	return out.toUpperCase();
};

/**
 * @param hex hex digits; whitespace is ignored
 * @throws {FormatError} on odd length or non-hex characters
 */
export const fromHex = (hex: string): Uint8Array => {
	const compact = hex.replaceAll(/\s+/g, '');
	if (compact.length % 2 !== 0 || /[^0-9a-f]/i.test(compact)) {
		throw new FormatError(`invalid hex string of length ${compact.length}`);
	}
	const out = new Uint8Array(compact.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
};
