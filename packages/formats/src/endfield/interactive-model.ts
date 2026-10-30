import { BinaryReader, FormatError } from '../binary/binary-reader.ts';

/** an interactive template's authored base model */
export interface InteractiveModel {
	id: string;
	scale: number;
	/** model ids in authored visual-form order */
	levels: string[];
}

/** an interactive template's base model, before its other components */
export interface InteractiveBaseModel {
	id: string;
	scale: number;
}

/**
 * reads an interactive template's base model from its leading model component. the other components remain
 * opaque
 *
 * @param bytes pooled template bytes
 * @param string resolves pooled string ids
 * @returns the base model, or `null` for a template that names none
 * @throws {FormatError} for a different template/component layout
 */
export const readInteractiveBaseModel = (
	bytes: Uint8Array,
	string: (id: number) => string | null,
): InteractiveBaseModel | null =>
	readBaseModel(new BinaryReader(bytes, { littleEndian: true }), string).model;

/**
 * reads a system-facility template through its model-upgrade component. later components remain opaque
 *
 * @param bytes pooled template bytes
 * @param string resolves pooled string ids
 * @returns the model referenced by the template, and its visual forms
 * @throws {FormatError} for a different template/component layout
 */
export const readInteractiveModel = (
	bytes: Uint8Array,
	string: (id: number) => string | null,
): InteractiveModel => {
	const r = new BinaryReader(bytes, { littleEndian: true });
	const { model, components } = readBaseModel(r, string);
	if (model === null) {
		throw new FormatError('invalid interactive base model');
	}
	const { id, scale } = model;
	const expect = (value: number, expected: number): void => {
		if (value !== expected) {
			throw new FormatError(`unsupported interactive model prefix at ${r.offset}`);
		}
	};
	const count = (): number => {
		const n = r.i32();
		if (n < -1 || n > 100_000) {
			throw new FormatError('invalid facility component list');
		}
		return Math.max(0, n);
	};
	const list = (read: () => void): void => {
		const n = count();
		for (let i = 0; i < n; i++) {
			read();
		}
	};
	const str = (): string | null => string(r.i32());
	const bool = (): void => {
		if (r.u8() > 1) {
			throw new FormatError('invalid facility boolean');
		}
	};
	const empty = (): void => {
		expect(count(), 0);
	};
	const properties = (): void =>
		list(() => {
			expect(r.u8(), 2);
			str();
			expect(r.u8(), 2);
			r.i32();
			list(() => {
				expect(r.u8(), 2);
				r.i64();
				str();
			});
		});
	for (let i = 2; i < components; i++) {
		const first = r.u8();
		const tag = first === 250 ? r.u16() : first;
		switch (tag) {
			case 29:
			case 235: {
				expect(r.u8(), 0);
				break;
			}
			case 55:
			case 56:
			case 190:
			case 214:
			case 224: {
				expect(r.u8(), 1);
				properties();
				break;
			}
			case 265: {
				expect(r.u8(), 3);
				properties();
				r.i32();
				r.i32();
				break;
			}
			case 232: {
				expect(r.u8(), 5);
				properties();
				r.skip(12);
				r.f32();
				r.u8();
				r.skip(12);
				break;
			}
			case 119: {
				expect(r.u8(), 3);
				properties();
				list(() => {
					expect(r.u8(), 3);
					bool();
					str();
					r.i32();
				});
				bool();
				break;
			}
			case 109: {
				expect(r.u8(), 2);
				properties();
				expect(r.u8(), 13);
				list(() => {
					r.i32();
					list(() => {
						str();
					});
				});
				empty();
				for (let b = 0; b < 11; b++) {
					bool();
				}
				break;
			}
			case 231:
			case 267: {
				expect(r.u8(), 3);
				properties();
				list(() => {
					expect(r.u8(), 20);
					r.i32();
					bool();
					str();
					empty();
					str();
					r.i32();
					for (let b = 0; b < 5; b++) {
						bool();
					}
					r.f32();
					str();
					expect(r.u8(), 1);
					str();
					r.i32();
					bool();
					r.f32();
					bool();
					r.i32();
					r.i32();
				});
				expect(r.u8(), 255);
				break;
			}
			case 142: {
				expect(r.u8(), 2);
				properties();
				const levels: string[] = [];
				list(() => {
					const level = str();
					if (!level) {
						throw new FormatError('empty facility upgrade model');
					}
					levels.push(level);
				});
				if (levels.length === 0 || levels.length > 32 || !levels.includes(id)) {
					throw new FormatError('invalid facility visual forms');
				}
				return { id, scale, levels };
			}
			default: {
				throw new FormatError(`unsupported facility component ${tag} at ${r.offset}`);
			}
		}
	}
	throw new FormatError('facility has no model upgrade list');
};

/** reads the template header and its leading model component, leaving `r` at the next component */
const readBaseModel = (
	r: BinaryReader,
	string: (id: number) => string | null,
): { model: InteractiveBaseModel | null; components: number } => {
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
	const components = r.i32();
	if (components < 2 || components > 1024) {
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
	if (!Number.isFinite(scale) || scale <= 0) {
		throw new FormatError('invalid interactive model scale');
	}
	return { model: id ? { id, scale } : null, components };
};
