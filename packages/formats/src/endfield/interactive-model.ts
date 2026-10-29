import { BinaryReader, FormatError } from '../binary/binary-reader.ts';

/** an interactive template's authored base model */
export interface InteractiveModel {
	id: string;
	scale: number;
}

/**
 * reads the base-model prefix of a system-facility InteractiveTemplateData. later components remain opaque
 *
 * @param bytes pooled template bytes
 * @param string resolves pooled string ids
 * @returns the model referenced by the template, before upgrades
 * @throws {FormatError} for a different template/component layout
 */
export const readInteractiveModel = (
	bytes: Uint8Array,
	string: (id: number) => string | null,
): InteractiveModel => {
	const r = new BinaryReader(bytes, { littleEndian: true });
	const expect = (value: number, expected: number): void => {
		if (value !== expected) {
			throw new FormatError(`unsupported interactive model prefix at ${r.offset}`);
		}
	};
	expect(r.u8(), 26);
	string(r.i32());
	r.i32();
	string(r.i32());
	const tags = r.i32();
	if (tags < 0 || tags > 65536) {
		throw new FormatError('invalid interactive born tags');
	}
	r.skip(tags * 4);
	if (r.i32() < 2) {
		throw new FormatError('interactive model components are missing');
	}
	expect(r.u8(), 150);
	expect(r.u8(), 0);
	expect(r.u8(), 250);
	expect(r.u16(), 318);
	expect(r.u8(), 4);
	r.f32();
	if (r.u8() > 1) {
		throw new FormatError('invalid model fade boolean');
	}
	const id = string(r.i32()),
		scale = r.f32();
	if (!id || !Number.isFinite(scale) || scale <= 0) {
		throw new FormatError('invalid interactive base model');
	}
	return { id, scale };
};
