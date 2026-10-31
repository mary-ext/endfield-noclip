import { FormatError } from '../binary/binary-reader.ts';

// IL2CPP `global-metadata.dat`, version 29: names and shapes of the managed types (type, field, property, method
// and parameter definitions, custom attribute data). the types those definitions name are indices into the
// binary's type table (see registration.ts). layouts follow Perfare/Il2CppDumper (MIT), `MetadataClass.cs`.
// Endfield's type definitions carry one extra int32 after `interfaceOffsetsStart`; the row size tells which.

const SANITY = 0xfab11baf;

/** header tables, by their (offset, size) pair's position in the v29 header */
const Table = {
	String: 2,
	Properties: 4,
	Methods: 5,
	Parameters: 10,
	Fields: 11,
	TypeDefinitions: 19,
	Images: 20,
	AttributeData: 24,
	AttributeDataRanges: 25,
} as const;

/** a managed type definition */
export interface TypeDefinition {
	index: number;
	name: string;
	namespace: string;
	/** index into the binary's type table of the type itself */
	byvalTypeIndex: number;
	/** type table index of the enclosing type, or -1 */
	declaringTypeIndex: number;
	/** type table index of the base type, or -1 */
	parentIndex: number;
	/** for an enum, type table index of its underlying type */
	elementTypeIndex: number;
	/** index into the generic containers, or -1 for a non-generic type */
	genericContainerIndex: number;
	fieldStart: number;
	fieldCount: number;
	methodStart: number;
	methodCount: number;
	propertyStart: number;
	propertyCount: number;
	valueType: boolean;
	enumType: boolean;
	token: number;
}

/** a field definition */
export interface FieldDefinition {
	name: string;
	typeIndex: number;
	token: number;
}

/**
 * a property definition; accessors are method indices relative to the declaring type's `methodStart`, -1 for
 * none
 */
export interface PropertyDefinition {
	name: string;
	get: number;
	set: number;
}

/** a method definition */
export interface MethodDefinition {
	name: string;
	declaringType: number;
	returnType: number;
	parameterStart: number;
	parameterCount: number;
}

/** a parsed `global-metadata.dat` */
export class Il2CppMetadata {
	readonly version: number;
	readonly typeDefinitionCount: number;
	readonly #bytes: Uint8Array;
	readonly #view: DataView;
	readonly #tables: { offset: number; size: number }[];
	readonly #typeRow: number;
	readonly #extra: number;
	readonly #decoder = new TextDecoder();
	readonly #strings = new Map<number, string>();
	#attributeRanges: Map<string, { start: number; end: number }> | undefined;

	/**
	 * @param bytes the whole file
	 * @throws {FormatError} if it isn't version 29 metadata or its type table has an unknown row size
	 */
	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (bytes.length < 272 || this.#view.getUint32(0, true) !== SANITY) {
			throw new FormatError('not IL2CPP metadata');
		}
		this.version = this.#view.getInt32(4, true);
		if (this.version !== 29) {
			throw new FormatError(`IL2CPP metadata version ${this.version}; only 29 is read`);
		}
		this.#tables = Array.from({ length: 32 }, (_, i) => ({
			offset: this.#view.getUint32(8 + i * 8, true),
			size: this.#view.getInt32(12 + i * 8, true),
		}));
		const typeBytes = this.#tables[Table.TypeDefinitions].size;
		// 88 bytes is the standard row; 92 has one extra int32
		const fits = [88, 92].filter((row) => typeBytes % row === 0);
		if (fits.length !== 1) {
			throw new FormatError(`type definition table of ${typeBytes} bytes has no single known row size`);
		}
		this.#typeRow = fits[0];
		this.#extra = this.#typeRow - 88;
		this.typeDefinitionCount = typeBytes / this.#typeRow;
	}

	/**
	 * @param index an index into the string table
	 * @returns the null-terminated string there
	 */
	string(index: number): string {
		let value = this.#strings.get(index);
		if (value === undefined) {
			const start = this.#tables[Table.String].offset + index;
			let end = start;
			while (this.#bytes[end] !== 0) {
				end++;
			}
			value = this.#decoder.decode(this.#bytes.subarray(start, end));
			this.#strings.set(index, value);
		}
		return value;
	}

	/**
	 * @param index a type definition index
	 * @returns the definition
	 * @throws {FormatError} if the index is out of range
	 */
	typeDefinition(index: number): TypeDefinition {
		const at = this.#row(Table.TypeDefinitions, this.#typeRow, index);
		const i32 = (offset: number) => this.#view.getInt32(at + offset, true);
		const u16 = (offset: number) => this.#view.getUint16(at + 64 + this.#extra + offset, true);
		const bitfield = this.#view.getUint32(at + 80 + this.#extra, true);
		return {
			index,
			name: this.string(i32(0)),
			namespace: this.string(i32(4)),
			byvalTypeIndex: i32(8),
			declaringTypeIndex: i32(12),
			parentIndex: i32(16),
			elementTypeIndex: i32(20),
			genericContainerIndex: i32(24),
			fieldStart: i32(32),
			methodStart: i32(36),
			propertyStart: i32(44),
			methodCount: u16(0),
			propertyCount: u16(2),
			fieldCount: u16(4),
			valueType: (bitfield & 1) !== 0,
			enumType: (bitfield & 2) !== 0,
			token: this.#view.getUint32(at + 84 + this.#extra, true),
		};
	}

	/** @returns a field definition by index */
	field(index: number): FieldDefinition {
		const at = this.#row(Table.Fields, 12, index);
		return {
			name: this.string(this.#view.getUint32(at, true)),
			typeIndex: this.#view.getInt32(at + 4, true),
			token: this.#view.getUint32(at + 8, true),
		};
	}

	/** @returns a property definition by index */
	property(index: number): PropertyDefinition {
		const at = this.#row(Table.Properties, 20, index);
		return {
			name: this.string(this.#view.getUint32(at, true)),
			get: this.#view.getInt32(at + 4, true),
			set: this.#view.getInt32(at + 8, true),
		};
	}

	/** @returns a method definition by index */
	method(index: number): MethodDefinition {
		const at = this.#row(Table.Methods, 32, index);
		return {
			name: this.string(this.#view.getUint32(at, true)),
			declaringType: this.#view.getInt32(at + 4, true),
			returnType: this.#view.getInt32(at + 8, true),
			parameterStart: this.#view.getInt32(at + 12, true),
			parameterCount: this.#view.getUint16(at + 30, true),
		};
	}

	/** @returns a parameter's type table index */
	parameterType(index: number): number {
		return this.#view.getInt32(this.#row(Table.Parameters, 12, index) + 8, true);
	}

	/**
	 * custom attribute data of a type: a compressed count, that many constructor method indices (int32), then
	 * per attribute its compressed argument, field and property counts and encoded values (see
	 * {@link AttributeReader})
	 *
	 * @param definition a type definition
	 * @returns a reader over its attribute data, or `undefined` without attributes
	 */
	attributes(definition: TypeDefinition): AttributeReader | undefined {
		this.#attributeRanges ??= this.#readAttributeRanges();
		const range = this.#attributeRanges.get(`${this.#imageOf(definition.index)}:${definition.token}`);
		if (range === undefined) {
			return undefined;
		}
		const base = this.#tables[Table.AttributeData].offset;
		return new AttributeReader(this.#bytes.subarray(base + range.start, base + range.end));
	}

	#images:
		| { typeStart: number; typeCount: number; attributeStart: number; attributeCount: number }[]
		| undefined;

	#imageList() {
		this.#images ??= Array.from({ length: this.#tables[Table.Images].size / 40 }, (_, i) => {
			const at = this.#tables[Table.Images].offset + i * 40;
			return {
				typeStart: this.#view.getInt32(at + 8, true),
				typeCount: this.#view.getUint32(at + 12, true),
				attributeStart: this.#view.getInt32(at + 32, true),
				attributeCount: this.#view.getUint32(at + 36, true),
			};
		});
		return this.#images;
	}

	#imageOf(typeIndex: number): number {
		return this.#imageList().findIndex(
			(image) => typeIndex >= image.typeStart && typeIndex < image.typeStart + image.typeCount,
		);
	}

	#readAttributeRanges(): Map<string, { start: number; end: number }> {
		const { offset, size } = this.#tables[Table.AttributeDataRanges];
		const count = size / 8;
		const dataSize = this.#tables[Table.AttributeData].size;
		const ranges = new Map<string, { start: number; end: number }>();
		for (const [image, { attributeStart, attributeCount }] of this.#imageList().entries()) {
			for (let i = attributeStart; i < attributeStart + attributeCount; i++) {
				const at = offset + i * 8;
				const end = i + 1 < count ? this.#view.getUint32(at + 12, true) : dataSize;
				ranges.set(`${image}:${this.#view.getUint32(at, true)}`, {
					start: this.#view.getUint32(at + 4, true),
					end,
				});
			}
		}
		return ranges;
	}

	#row(table: number, size: number, index: number): number {
		const { offset, size: total } = this.#tables[table];
		if (!Number.isInteger(index) || index < 0 || (index + 1) * size > total) {
			throw new FormatError(`metadata row ${index} outside table ${table}`);
		}
		return offset + index * size;
	}
}

/** reads one type's custom attribute blob */
export class AttributeReader {
	readonly #bytes: Uint8Array;
	#at = 0;
	/** constructor method indices, one per attribute */
	readonly constructors: number[];

	/** @param bytes the type's attribute data */
	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
		const count = this.compressedU32();
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.constructors = Array.from({ length: count }, (_, i) => view.getInt32(this.#at + i * 4, true));
		this.#at += count * 4;
	}

	/** @returns the next compressed unsigned int32 */
	compressedU32(): number {
		const first = this.#byte();
		if ((first & 0x80) === 0) {
			return first;
		}
		if ((first & 0xc0) === 0x80) {
			return ((first & 0x3f) << 8) | this.#byte();
		}
		if ((first & 0xe0) === 0xc0) {
			return (((first & 0x1f) << 24) | (this.#byte() << 16) | (this.#byte() << 8) | this.#byte()) >>> 0;
		}
		switch (first) {
			case 0xf0: {
				return (this.#byte() | (this.#byte() << 8) | (this.#byte() << 16) | (this.#byte() << 24)) >>> 0;
			}
			case 0xfe: {
				return 0xfffffffe;
			}
			case 0xff: {
				return 0xffffffff;
			}
			default: {
				throw new FormatError(`invalid compressed integer 0x${first.toString(16)}`);
			}
		}
	}

	/** @returns the next compressed signed int32 (zigzag over {@link compressedU32}) */
	compressedI32(): number {
		const encoded = this.compressedU32();
		if (encoded === 0xffffffff) {
			return -0x80000000;
		}
		const magnitude = Math.floor(encoded / 2);
		return encoded % 2 === 1 ? -(magnitude + 1) : magnitude;
	}

	/** @returns the next byte */
	byte(): number {
		return this.#byte();
	}

	/** @param size bytes to skip */
	skip(size: number): void {
		this.#at += size;
		if (this.#at > this.#bytes.length) {
			throw new FormatError('attribute data ends early');
		}
	}

	#byte(): number {
		if (this.#at >= this.#bytes.length) {
			throw new FormatError('attribute data ends early');
		}
		return this.#bytes[this.#at++];
	}
}
