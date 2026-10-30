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

/** the interactive table: which template file each placeable interactive id instantiates */
export interface InteractiveTable {
	/** template id → template data path */
	templatePaths: Map<string, string>;
	/** interactive id (a LevelData row's template key) → template id */
	templates: Map<string, string>;
}

/**
 * reads `Interactive/InteractiveTable.json`
 *
 * @param bytes pooled MemoryPack table
 * @param string resolves pooled string ids
 * @returns template paths and the template of every interactive id
 * @throws {FormatError} for a different layout
 */
export const readInteractiveTable = (
	bytes: Uint8Array,
	string: (id: number) => string | null,
): InteractiveTable => {
	const r = new BinaryReader(bytes, { littleEndian: true });
	const marker = (n: number): void => {
		if (r.u8() !== n) {
			throw new FormatError(`unsupported interactive table at ${r.offset - 1}`);
		}
	};
	const count = (): number => {
		const n = r.i32();
		if (n < 0 || n > 100_000) {
			throw new FormatError(`invalid interactive table count ${n}`);
		}
		return n;
	};
	const required = (): string => {
		const value = string(r.i32());
		if (!value) {
			throw new FormatError(`empty interactive table string at ${r.offset - 4}`);
		}
		return value;
	};
	marker(2);
	const templatePaths = new Map<string, string>();
	for (let i = count(); i > 0; i--) {
		templatePaths.set(required(), required());
	}
	const templates = new Map<string, string>();
	for (let i = count(); i > 0; i--) {
		const id = required();
		marker(1);
		templates.set(id, required());
	}
	if (r.remaining !== 0) {
		throw new FormatError('trailing interactive table bytes');
	}
	return { templatePaths, templates };
};

/**
 * reads the model overrides of a template's variants. the variant table sits at the end of the template,
 * after components and action graphs whose layouts aren't decoded, so it is located from the end: the table,
 * then the template's temporary properties and two flags must end exactly at the end of the file, and its
 * keys must be exactly `variants`. any other number of matching positions is an error
 *
 * @param bytes pooled template bytes
 * @param string resolves pooled string ids
 * @param variants the interactive ids that instantiate this template, without the template's own id
 * @returns each variant's model id, or `null` where the variant keeps the template's model
 * @throws {FormatError} when no single position frames the table
 */
export const readInteractiveVariantModels = (
	bytes: Uint8Array,
	string: (id: number) => string | null,
	variants: ReadonlySet<string>,
): Map<string, string | null> => {
	if (variants.size === 0) {
		return new Map();
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// most candidate positions hold no valid string id at all
	const lookup = (id: number): string | null => {
		try {
			return string(id);
		} catch (error) {
			if (error instanceof FormatError) {
				return null;
			}
			throw error;
		}
	};
	let found: Map<string, string | null> | null = null;
	// a table header is the dictionary wrapper's member count (1), the entry count and a known first key;
	// the table's nine-byte header and the six-byte remainder bound the last position
	for (let at = bytes.length - 15; at >= 0; at--) {
		if (
			bytes[at] !== 1 ||
			view.getInt32(at + 1, true) !== variants.size ||
			!variants.has(lookup(view.getInt32(at + 5, true)) ?? '')
		) {
			continue;
		}
		const models = readVariantTail(new BinaryReader(bytes, { offset: at, littleEndian: true }), string);
		if (
			models === null ||
			models.size !== variants.size ||
			![...models.keys()].every((id) => variants.has(id))
		) {
			continue;
		}
		if (found !== null) {
			throw new FormatError('ambiguous interactive variant table');
		}
		found = models;
	}
	if (found === null) {
		throw new FormatError('interactive variant table not found');
	}
	return found;
};

/** reads the variant table through the end of the template, or returns `null` where it doesn't frame */
const readVariantTail = (
	r: BinaryReader,
	string: (id: number) => string | null,
): Map<string, string | null> | null => {
	class Mismatch extends Error {}
	const fail = (): never => {
		throw new Mismatch();
	};
	const marker = (n: number): void => {
		if (r.u8() !== n) {
			fail();
		}
	};
	const count = (): number => {
		const n = r.i32();
		if (n < -1 || n > 100_000) {
			fail();
		}
		return Math.max(n, 0);
	};
	const list = (read: () => void): void => {
		for (let i = count(); i > 0; i--) {
			read();
		}
	};
	const bool = (): boolean => {
		const value = r.u8();
		if (value > 1) {
			fail();
		}
		return value === 1;
	};
	const str = (): string | null => string(r.i32());
	// a nullable object with `members` members
	const nullable = (members: number, read: () => void): void => {
		const n = r.u8();
		if (n === 255) {
			return;
		}
		if (n !== members) {
			fail();
		}
		read();
	};
	// a managed Optional<T>: an object of (enabled, value)
	const optional = <T>(read: () => T): T | null => {
		const n = r.u8();
		if (n === 255) {
			return null;
		}
		if (n !== 2) {
			fail();
		}
		const enabled = bool();
		const value = read();
		return enabled ? value : null;
	};
	// an unmanaged Optional<T> of a four-byte value: enabled, padding, value
	const optionalValue = (): void => {
		bool();
		r.skip(7);
	};
	const param = (): void => {
		marker(2);
		str();
		nullable(2, () => {
			r.i32();
			list(() => {
				marker(2);
				r.i64();
				str();
			});
		});
	};
	try {
		const models = new Map<string, string | null>();
		marker(1);
		for (let i = count(); i > 0; i--) {
			const id = str();
			if (id === null || models.has(id)) {
				return null;
			}
			// members in name order: aoiRadiusType, bornTag, componentDiffProperties, delayRecyclePerformTime,
			// delayToRecycleTime, diffProperties, facOccDis, factionIndex, globalVarDiff, hideInDialog,
			// mapVarDiff, modelId, mountPoints, relatedGuideTimestampGameVar
			marker(14);
			optionalValue();
			optional(() => r.skip(count() * 4));
			nullable(1, () =>
				list(() => {
					str();
					nullable(1, () => list(param));
				}),
			);
			optionalValue();
			optionalValue();
			list(param);
			optionalValue();
			optionalValue();
			list(param);
			bool();
			bool();
			list(param);
			const model = optional(str);
			optional(() =>
				list(() =>
					nullable(2, () => {
						r.i32();
						str();
					}),
				),
			);
			optional(() =>
				list(() => {
					str();
				}),
			);
			models.set(id, model || null);
		}
		list(param);
		bool();
		bool();
		return r.remaining === 0 ? models : null;
	} catch (error) {
		if (error instanceof Mismatch || error instanceof FormatError) {
			return null;
		}
		throw error;
	}
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
