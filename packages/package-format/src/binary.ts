/**
 * helpers shared by the package's binary encodings: headers, alignment, typed sections, enum checks
 *
 * @module
 */

import { PackageFormatError } from './errors.ts';

/** bytes of the header the binary tables share: `u32 magic, u16 version, u16 0, u32 count, u32 count-or-0` */
export const TABLE_HEADER_SIZE = 16;

export const align4 = (n: number): number => (n + 3) & ~3;

export const viewOf = (data: Uint8Array): DataView =>
	new DataView(data.buffer, data.byteOffset, data.byteLength);

/**
 * what every encoding's header starts with: `u32 magic ‖ u16 version`. each encoding has its own version, so
 * changing one leaves the others' blobs (and cached conversions) valid
 */
export interface HeaderShape {
	magic: number;
	version: number;
	/** the header's full size, which the data must at least have */
	size: number;
	/** for error messages */
	label: string;
}

/** writes a header's magic and version */
export const writeHeader = (view: DataView, header: HeaderShape): void => {
	view.setUint32(0, header.magic, true);
	view.setUint16(4, header.version, true);
};

/** checks a header's size, magic and version */
export const checkHeader = (view: DataView, header: HeaderShape): void => {
	if (view.byteLength < header.size || view.getUint32(0, true) !== header.magic) {
		throw new PackageFormatError(`not a ${header.label}`);
	}
	const version = view.getUint16(4, true);
	if (version !== header.version) {
		throw new PackageFormatError(`${header.label} version ${version} isn't ${header.version}`);
	}
};

/** @returns a type guard for the values of a `const` enum object */
export const enumGuard = <T extends number>(
	values: Readonly<Record<string, T>>,
): ((value: number) => value is T) => {
	const known: ReadonlySet<number> = new Set(Object.values(values));
	return (value): value is T => known.has(value);
};

/** @throws {PackageFormatError} unless `value` passes `guard` */
export const checkedEnum = <T extends number>(
	guard: (value: number) => value is T,
	value: number,
	label: string,
): T => {
	if (!guard(value)) {
		throw new PackageFormatError(`unknown ${label} ${value}`);
	}
	return value;
};

export const checkLength = (data: Uint8Array, expected: number, label: string): void => {
	if (data.byteLength !== expected) {
		throw new PackageFormatError(`${label} is ${data.byteLength} bytes, expected ${expected}`);
	}
};

/** copies `count` elements of a section into a fresh, aligned typed array */
export const f32Section = (data: Uint8Array, at: number, count: number): Float32Array => {
	return new Float32Array(data.slice(at, at + count * 4).buffer);
};

export const u32Section = (data: Uint8Array, at: number, count: number): Uint32Array => {
	return new Uint32Array(data.slice(at, at + count * 4).buffer);
};

export const hexOf = (bytes: Uint8Array): string => {
	let out = '';
	for (const byte of bytes) {
		out += byte.toString(16).padStart(2, '0');
	}
	return out;
};

export const bytesOfHex = (hex: string): Uint8Array => {
	if (!/^[0-9a-f]{32}$/.test(hex)) {
		throw new PackageFormatError(`blob hash ${hex} isn't 32 lowercase hex digits`);
	}
	const out = new Uint8Array(16);
	for (let i = 0; i < 16; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
};
