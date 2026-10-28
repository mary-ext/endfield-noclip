import { FormatError } from './binary-reader.ts';

/**
 * bounds-checked little-endian reads at absolute offsets, for formats addressed by stored offsets rather than
 * read front to back (`BinaryReader` covers cursor-based reads). every read throws a {@link FormatError}
 * instead of a `RangeError` when it leaves the buffer.
 */
export class ByteView {
	readonly bytes: Uint8Array;
	readonly #view: DataView;
	readonly #label: string;

	/**
	 * @param bytes buffer to read; not copied
	 * @param label format name used in error messages
	 */
	constructor(bytes: Uint8Array, label: string) {
		this.bytes = bytes;
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.#label = label;
	}

	get length(): number {
		return this.bytes.byteLength;
	}

	u8(at: number): number {
		this.check(at, 1);
		return this.bytes[at];
	}

	u16(at: number): number {
		this.check(at, 2);
		return this.#view.getUint16(at, true);
	}

	u32(at: number): number {
		this.check(at, 4);
		return this.#view.getUint32(at, true);
	}

	i32(at: number): number {
		this.check(at, 4);
		return this.#view.getInt32(at, true);
	}

	u64(at: number): bigint {
		this.check(at, 8);
		return this.#view.getBigUint64(at, true);
	}

	i64(at: number): bigint {
		this.check(at, 8);
		return this.#view.getBigInt64(at, true);
	}

	f32(at: number): number {
		this.check(at, 4);
		return this.#view.getFloat32(at, true);
	}

	/** @returns a view (not a copy) of `size` bytes at `at` */
	subarray(at: number, size: number): Uint8Array {
		this.check(at, size);
		return this.bytes.subarray(at, at + size);
	}

	/** reads a NUL-terminated UTF-8 string; returns it and the offset after the terminator */
	cString(at: number): [value: string, end: number] {
		this.check(at, 0);
		const end = this.bytes.indexOf(0, at);
		if (end < 0) {
			throw new FormatError(`unterminated ${this.#label} string at ${at}`);
		}
		return [utf8.decode(this.bytes.subarray(at, end)), end + 1];
	}

	/** reads `u32 byteLength ‖ UTF-16LE ‖ u16 0` */
	lengthPrefixedUtf16(at: number): string {
		const byteLength = this.u32(at);
		if (byteLength % 2 !== 0) {
			throw new FormatError(`${this.#label} string at ${at} has an odd byte length ${byteLength}`);
		}
		this.check(at + 4, byteLength + 2);
		return utf16.decode(this.bytes.subarray(at + 4, at + 4 + byteLength));
	}

	/** @throws {FormatError} if `[at, at + size)` isn't inside the buffer */
	check(at: number, size: number): void {
		if (!(at >= 0 && size >= 0 && at + size <= this.bytes.byteLength)) {
			throw new FormatError(`${this.#label} read of ${size} bytes at 0x${at.toString(16)} is out of bounds`);
		}
	}
}

const utf8 = new TextDecoder('utf-8');
const utf16 = new TextDecoder('utf-16le');
