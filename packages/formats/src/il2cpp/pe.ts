import { FormatError } from '../binary/binary-reader.ts';

// a 64-bit Windows PE image, as far as reading its initialized data by virtual address needs

/** a section of the image */
export interface PeSection {
	name: string;
	/** relative virtual address */
	address: number;
	virtualSize: number;
	/** file offset of its raw data */
	rawOffset: number;
	rawSize: number;
}

/** a PE32+ image's sections, readable by virtual address */
export class PeImage {
	readonly bytes: Uint8Array;
	readonly imageBase: bigint;
	readonly sections: PeSection[];
	readonly #view: DataView;

	/**
	 * @param bytes the whole image file
	 * @throws {FormatError} if it isn't a PE32+ image
	 */
	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (bytes.length < 0x40 || this.#view.getUint16(0, true) !== 0x5a4d) {
			throw new FormatError('not a PE image');
		}
		const pe = this.#view.getUint32(0x3c, true);
		if (this.#view.getUint32(pe, true) !== 0x4550 || this.#view.getUint16(pe + 24, true) !== 0x20b) {
			throw new FormatError('not a PE32+ image');
		}
		const sectionCount = this.#view.getUint16(pe + 6, true);
		const optionalSize = this.#view.getUint16(pe + 20, true);
		this.imageBase = this.#view.getBigUint64(pe + 24 + 24, true);
		const decoder = new TextDecoder('latin1');
		this.sections = Array.from({ length: sectionCount }, (_, i) => {
			const at = pe + 24 + optionalSize + i * 40;
			return {
				name: decoder.decode(bytes.subarray(at, at + 8)).replace(/\0+$/, ''),
				virtualSize: this.#view.getUint32(at + 8, true),
				address: this.#view.getUint32(at + 12, true),
				rawSize: this.#view.getUint32(at + 16, true),
				rawOffset: this.#view.getUint32(at + 20, true),
			};
		});
	}

	/**
	 * @param va a virtual address
	 * @returns its file offset, or `undefined` if no section's raw data holds it
	 */
	offsetOf(va: bigint): number | undefined {
		const rva = va - this.imageBase;
		if (rva < 0n || rva > 0xffffffffn) {
			return undefined;
		}
		const address = Number(rva);
		const section = this.sections.find(
			(entry) =>
				address >= entry.address && address < entry.address + Math.min(entry.rawSize, entry.virtualSize),
		);
		return section && address - section.address + section.rawOffset;
	}

	/**
	 * @param va a virtual address
	 * @returns the file offset
	 * @throws {FormatError} if no section's raw data holds it
	 */
	at(va: bigint): number {
		const offset = this.offsetOf(va);
		if (offset === undefined) {
			throw new FormatError(`address 0x${va.toString(16)} is outside the image's data`);
		}
		return offset;
	}

	/** @returns the u64 at a virtual address */
	u64(va: bigint): bigint {
		return this.#view.getBigUint64(this.at(va), true);
	}

	/** @returns the i64 at a file offset */
	i64At(offset: number): bigint {
		return this.#view.getBigInt64(offset, true);
	}

	/** @returns the u64 at a file offset */
	u64At(offset: number): bigint {
		return this.#view.getBigUint64(offset, true);
	}

	/** @returns the u32 at a file offset */
	u32At(offset: number): number {
		return this.#view.getUint32(offset, true);
	}

	/** @returns the i32 at a file offset */
	i32At(offset: number): number {
		return this.#view.getInt32(offset, true);
	}

	/** @returns the u8 at a file offset */
	u8At(offset: number): number {
		return this.bytes[offset];
	}
}
