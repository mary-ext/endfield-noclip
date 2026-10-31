import { FormatError } from '../binary/binary-reader.ts';
import type { AttributeReader, TypeDefinition } from '../il2cpp/metadata.ts';
import type { Il2CppRuntime, Il2CppTypeRef } from '../il2cpp/registration.ts';

// MemoryPack-serialized game data (level scripts, view-state controllers). the client deserializes through
// generated wrapper classes named `<Namespace_Type>ForMemoryPack`: an object is a member-count byte (255 for
// null) followed by its members in the order of the wrapper's `__name__` setter properties, base wrapper first;
// a polymorphic base is a union, a tag byte (250 then a u16 for large tags, 255 for null) choosing the subtype
// from the wrapper's `[MemoryPackUnion(tag, typeof(subtype))]` attributes. the schema is read from the user's
// install (its IL2CPP metadata and binary), never stored in this repo. collections are an int32 count (-1 for
// null, decoded as empty) and their elements; strings are ids into the JsonData string pool.
//
// rules beyond the generated wrappers, found by decoding every level script of the client to its exact length:
//
// - unmanaged structs of a few kinds (`*Ptr`, tags, poses) are copied raw at their in-memory size, padding
//   included, except as List elements, which go through their wrapper
// - a Dictionary of two unmanaged types is copied raw as KeyValuePair rows
// - `Nullable<T>` of an unmanaged T is raw: a has-value byte, then T at its alignment
// - `AnimationCurve`, `SerializeFieldDictionary`, `SendLuaEvent*` and `AudioBlackScreenBehaviour` have their own
//   formatters, decoded below

/** a decoded value: objects carry their wrapper's name as `$type`; 64-bit integers are decimal strings */
export type MemoryPackValue =
	| null
	| boolean
	| number
	| string
	| MemoryPackValue[]
	| { [key: string]: MemoryPackValue };

/** a generated wrapper class */
interface Wrapper {
	name: string;
	/** members in serialized order: base wrapper's first */
	fields: { name: string; type: Il2CppTypeRef }[];
	/** subtypes by union tag, or `null` for a plain object */
	union: Map<number, number> | null;
}

/** unmanaged layout */
interface Layout {
	size: number;
	align: number;
}

const PRIMITIVE_SIZES = new Map([
	['bool', 1],
	['byte', 1],
	['sbyte', 1],
	['short', 2],
	['ushort', 2],
	['char', 2],
	['int', 4],
	['uint', 4],
	['float', 4],
	['long', 8],
	['ulong', 8],
	['double', 8],
]);

/** Unity value types whose fields are all floats or ints */
const VECTORS = new Map<string, [string, number]>([
	['Vector2', ['float', 2]],
	['Vector3', ['float', 3]],
	['Vector4', ['float', 4]],
	['Quaternion', ['float', 4]],
	['Color', ['float', 4]],
	['Vector2Int', ['int', 2]],
	['Vector3Int', ['int', 3]],
]);

/** structs serialized raw rather than through their wrapper (besides `*Ptr`) */
const RAW_STRUCTS = new Set([
	'GameplayTag',
	'CameraControlStateInitialParam',
	'PosRot',
	'NpcBehaviorTag',
	'ConditionValue',
	'ValueUnion',
	'AudioId',
]);

/** the MemoryPack wrappers of a client build */
export class MemoryPackSchema {
	readonly runtime: Il2CppRuntime;
	readonly #wrappers = new Map<string, number>();
	readonly #byValue = new Map<string, number[]>();
	readonly #cache = new Map<number, Wrapper>();

	/** @param runtime the build's type information */
	constructor(runtime: Il2CppRuntime) {
		this.runtime = runtime;
		const { metadata } = runtime;
		for (let index = 0; index < metadata.typeDefinitionCount; index++) {
			const definition = metadata.typeDefinition(index);
			if (!definition.name.endsWith('ForMemoryPack') || definition.declaringTypeIndex !== -1) {
				continue;
			}
			this.#wrappers.set(definition.name, index);
			for (let m = 0; m < definition.methodCount; m++) {
				const method = metadata.method(definition.methodStart + m);
				if (method.name === 'GetValue' && method.parameterCount === 0) {
					const key = typeKey(runtime.type(method.returnType));
					this.#byValue.set(key, [...(this.#byValue.get(key) ?? []), index]);
				}
			}
		}
	}

	/**
	 * @param name a wrapper class name, e.g. `Beyond_Gameplay_LevelScriptDataForMemoryPack`
	 * @returns its definition index
	 * @throws {FormatError} if the build has no such wrapper
	 */
	wrapperNamed(name: string): number {
		const index = this.#wrappers.get(name);
		if (index === undefined) {
			throw new FormatError(`no MemoryPack wrapper ${name}`);
		}
		return index;
	}

	/**
	 * @param type a serialized type
	 * @returns the definition index of the one wrapper that serializes it, if exactly one does
	 */
	wrapperFor(type: Il2CppTypeRef): number | undefined {
		const found = this.#byValue.get(typeKey(type));
		return found?.length === 1 ? found[0] : undefined;
	}

	/** @returns a wrapper's members and union subtypes */
	wrapper(index: number): Wrapper {
		let wrapper = this.#cache.get(index);
		if (wrapper === undefined) {
			const { metadata } = this.runtime;
			const definition = metadata.typeDefinition(index);
			const fields: Wrapper['fields'] = [];
			if (definition.parentIndex !== -1) {
				const parent = this.runtime.type(definition.parentIndex);
				if (
					parent.kind === 'definition' &&
					metadata.typeDefinition(parent.definition).name.endsWith('ForMemoryPack')
				) {
					fields.push(...this.wrapper(parent.definition).fields);
				}
			}
			for (let p = 0; p < definition.propertyCount; p++) {
				const property = metadata.property(definition.propertyStart + p);
				if (property.set < 0 || !/^_+\w+__$/.test(property.name)) {
					continue;
				}
				const setter = metadata.method(definition.methodStart + property.set);
				fields.push({
					name: property.name.replace(/^_+|_+$/g, ''),
					type: this.runtime.type(metadata.parameterType(setter.parameterStart)),
				});
			}
			wrapper = { name: definition.name, fields, union: this.#unions(definition) };
			this.#cache.set(index, wrapper);
		}
		return wrapper;
	}

	#unions(definition: TypeDefinition): Map<number, number> | null {
		const { metadata } = this.runtime;
		const reader = metadata.attributes(definition);
		if (reader === undefined) {
			return null;
		}
		const union = new Map<number, number>();
		for (const constructor of reader.constructors) {
			const attribute = metadata.typeDefinition(metadata.method(constructor).declaringType);
			const args = readAttributeArguments(reader, this.runtime);
			if (attribute.name !== 'MemoryPackUnionAttribute') {
				continue;
			}
			const [tag, type] = args;
			if (
				typeof tag !== 'number' ||
				typeof type !== 'object' ||
				type === null ||
				Array.isArray(type) ||
				type.kind !== 'definition'
			) {
				throw new FormatError(`${definition.name} has a malformed MemoryPackUnion attribute`);
			}
			union.set(tag, type.definition);
		}
		return union.size === 0 ? null : union;
	}
}

/** @returns the next `size` bytes as an unsigned little-endian number (exact up to 2^53) */
const littleEndian = (reader: AttributeReader, size: number): number => {
	let result = 0;
	for (let i = 0; i < size; i++) {
		result += reader.byte() * 2 ** (8 * i);
	}
	return result;
};

/** @returns an identity key for a resolved type */
const typeKey = (type: Il2CppTypeRef): string => JSON.stringify(type);

/**
 * reads one attribute's constructor arguments, skipping its named field and property arguments
 *
 * @returns the positional arguments: numbers, strings, booleans, `typeof` types, arrays
 */
const readAttributeArguments = (
	reader: AttributeReader,
	runtime: Il2CppRuntime,
): (number | string | boolean | Il2CppTypeRef | null | unknown[])[] => {
	const argumentCount = reader.compressedU32();
	const fieldCount = reader.compressedU32();
	const propertyCount = reader.compressedU32();
	const value = (kind: number): number | string | boolean | Il2CppTypeRef | null | unknown[] => {
		switch (kind) {
			case 0x02: {
				return reader.byte() !== 0;
			}
			case 0x04:
			case 0x05: {
				return reader.byte();
			}
			case 0x03:
			case 0x06:
			case 0x07: {
				return littleEndian(reader, 2);
			}
			case 0x08: {
				return reader.compressedI32();
			}
			case 0x09: {
				return reader.compressedU32();
			}
			case 0x0c: {
				return littleEndian(reader, 4);
			}
			case 0x0a:
			case 0x0b:
			case 0x0d: {
				return littleEndian(reader, 8);
			}
			case 0x0e: {
				const length = reader.compressedI32();
				if (length === -1) {
					return null;
				}
				const chars: number[] = [];
				for (let i = 0; i < length; i++) {
					chars.push(reader.byte());
				}
				return new TextDecoder().decode(new Uint8Array(chars));
			}
			case 0x1d: {
				const length = reader.compressedI32();
				if (length === -1) {
					return null;
				}
				const elementKind = encodedKind();
				const mixed = reader.byte() === 1;
				return Array.from({ length }, () => value(mixed ? encodedKind() : elementKind));
			}
			case 0xff: {
				const index = reader.compressedI32();
				return index === -1 ? null : runtime.type(index);
			}
			default: {
				throw new FormatError(`unsupported attribute argument kind 0x${kind.toString(16)}`);
			}
		}
	};
	// an enum argument names its enum's type, then is encoded as the enum's underlying type
	const encodedKind = (): number => {
		const kind = reader.byte();
		if (kind !== 0x55) {
			return kind;
		}
		const type = runtime.type(reader.compressedI32());
		if (type.kind !== 'definition') {
			throw new FormatError('enum attribute argument of a non-definition type');
		}
		const underlying = runtime.type(runtime.metadata.typeDefinition(type.definition).elementTypeIndex);
		if (underlying.kind !== 'primitive') {
			throw new FormatError('enum with a non-primitive underlying type');
		}
		return PRIMITIVE_KINDS.get(underlying.name) ?? 0;
	};
	const args = Array.from({ length: argumentCount }, () => value(encodedKind()));
	for (let i = 0; i < fieldCount + propertyCount; i++) {
		value(encodedKind());
		if (reader.compressedI32() < 0) {
			reader.compressedU32();
		}
	}
	return args;
};

const PRIMITIVE_KINDS = new Map([
	['bool', 0x02],
	['char', 0x03],
	['sbyte', 0x04],
	['byte', 0x05],
	['short', 0x06],
	['ushort', 0x07],
	['int', 0x08],
	['uint', 0x09],
	['long', 0x0a],
	['ulong', 0x0b],
	['float', 0x0c],
	['double', 0x0d],
]);

/** decodes MemoryPack bytes with a client's schema */
export class MemoryPackReader {
	readonly schema: MemoryPackSchema;
	readonly #strings: (id: number) => string | null | undefined;
	readonly #layouts = new Map<string, Layout | null>();
	#bytes: Uint8Array = new Uint8Array();
	#view: DataView = new DataView(this.#bytes.buffer);
	#at = 0;

	/**
	 * @param schema the client's wrappers
	 * @param strings JsonData string pool lookup: the string, `null` for a null string, `undefined` for an id
	 *   the pool lacks (decoded as `#<id>`, or `null` when negative)
	 */
	constructor(schema: MemoryPackSchema, strings: (id: number) => string | null | undefined) {
		this.schema = schema;
		this.#strings = strings;
	}

	/**
	 * @param bytes a serialized object
	 * @param root the name of its wrapper class
	 * @returns the decoded object
	 * @throws {FormatError} if the bytes don't decode as the schema says or don't end where the object does
	 */
	decode(bytes: Uint8Array, root: string): MemoryPackValue {
		this.#bytes = bytes;
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.#at = 0;
		const value = this.#wrapper(this.schema.wrapperNamed(root));
		if (this.#at !== bytes.length) {
			throw new FormatError(`${root} ends at ${this.#at} of ${bytes.length} bytes`);
		}
		return value;
	}

	#wrapper(index: number): MemoryPackValue {
		const wrapper = this.schema.wrapper(index);
		if (wrapper.union !== null) {
			let tag = this.#u8();
			if (tag === 255) {
				return null;
			}
			if (tag === 250) {
				tag = this.#u16();
			}
			const subtype = wrapper.union.get(tag);
			if (subtype === undefined) {
				throw new FormatError(`${wrapper.name} has no union tag ${tag}`);
			}
			return this.#wrapper(subtype);
		}
		const at = this.#at;
		const members = this.#u8();
		if (members === 255) {
			return null;
		}
		if (members !== wrapper.fields.length) {
			throw new FormatError(
				`${wrapper.name} at ${at} has ${members} members, expected ${wrapper.fields.length}`,
			);
		}
		const result: { [key: string]: MemoryPackValue } = { $type: wrapper.name };
		for (const { name, type } of wrapper.fields) {
			try {
				result[name] = this.#value(type, false);
			} catch (error) {
				if (error instanceof FormatError) {
					throw new FormatError(`${wrapper.name}.${name}: ${error.message}`);
				}
				throw error;
			}
		}
		return result;
	}

	#value(type: Il2CppTypeRef, listElement: boolean): MemoryPackValue {
		const { runtime } = this.schema;
		const name = runtime.typeName(type);
		if (type.kind === 'primitive') {
			if (type.name === 'string') {
				const id = this.#i32();
				const text = this.#strings(id);
				return text === undefined ? (id < 0 ? null : `#${id}`) : text;
			}
			return this.#raw(type);
		}
		if (type.kind === 'array') {
			if (type.rank !== 1) {
				throw new FormatError(`unsupported array ${name}`);
			}
			return this.#list(() => this.#value(type.element, false));
		}
		if (type.kind !== 'definition' && type.kind !== 'generic') {
			throw new FormatError(`unsupported type ${name}`);
		}
		const base = runtime.definitionName(type.definition);
		const special = this.#special(base);
		if (special !== undefined) {
			return special;
		}
		const layout = this.#layout(type);
		if (layout !== null && (VECTORS.has(base) || base === 'Nullable')) {
			return this.#rawAdvance(type, layout);
		}
		// these structs are raw copies, except as List elements, which are wrapper-serialized
		if (
			layout !== null &&
			(base.endsWith('Ptr') || RAW_STRUCTS.has(base)) &&
			!(listElement && this.schema.wrapperFor(type) !== undefined)
		) {
			return this.#rawAdvance(type, layout);
		}
		if (type.kind === 'generic') {
			const [first, second] = type.args;
			switch (base) {
				case 'List': {
					return this.#list(() => this.#value(first, true));
				}
				case 'SerializeFieldDictionary': {
					const header = this.#u8();
					if (header === 255) {
						return null;
					}
					if (header !== 2) {
						throw new FormatError(`SerializeFieldDictionary header ${header}`);
					}
					const keys = this.#list(() => this.#value(first, false));
					const values = this.#list(() => this.#value(second, false));
					return keys.map((key, i) => [key, values[i] ?? null]);
				}
				case 'Dictionary': {
					const key = this.#layout(first);
					const value = this.#layout(second);
					if (key !== null && value !== null && this.#plain(first) && this.#plain(second)) {
						// a pair of unmanaged types is copied raw as KeyValuePair<K, V>, padding included
						const align = Math.max(key.align, value.align);
						const valueAt = Math.ceil(key.size / value.align) * value.align;
						const size = Math.ceil((valueAt + value.size) / align) * align;
						return this.#list(() => {
							const at = this.#advance(size);
							return [this.#rawAt(first, at), this.#rawAt(second, at + valueAt)];
						});
					}
					return this.#list(() => [this.#value(first, false), this.#value(second, false)]);
				}
				default: {
					break;
				}
			}
		}
		const definition = runtime.metadata.typeDefinition(type.definition);
		if (definition.enumType) {
			return this.#raw(runtime.type(definition.elementTypeIndex));
		}
		const wrapper = this.schema.wrapperFor(type);
		if (wrapper === undefined) {
			throw new FormatError(`no wrapper serializes ${name}`);
		}
		return this.#wrapper(wrapper);
	}

	/** @returns a value of a type with its own formatter, or `undefined` for other types */
	#special(base: string): MemoryPackValue | undefined {
		switch (base) {
			case 'AnimationCurve': {
				// member count 3, preWrapMode, postWrapMode, raw Keyframe[] (28 bytes each)
				const members = this.#u8();
				if (members === 255) {
					return null;
				}
				if (members !== 3) {
					throw new FormatError(`AnimationCurve with ${members} members`);
				}
				const preWrapMode = this.#i32();
				const postWrapMode = this.#i32();
				const keys = this.#list(() => {
					const at = this.#advance(28);
					return Array.from({ length: 7 }, (_, i) => this.#view.getFloat32(at + i * 4, true));
				});
				return { $type: 'AnimationCurve', preWrapMode, postWrapMode, keys };
			}
			case 'SendLuaEvent':
			case 'SendLuaEvent1':
			case 'SendLuaEvent2': {
				// member count, ID, inline UTF-8 uid, bool, nextID, bool, Param<string> event name, then one inline UTF-8
				// JSON string per parameter
				const members = this.#u8();
				if (members === 255) {
					return null;
				}
				const id = this.#i32();
				const uid = this.#utf8();
				const first = this.#u8() !== 0;
				const nextId = this.#i32();
				const second = this.#u8() !== 0;
				const eventName = this.#wrapper(
					this.schema.wrapperNamed('Beyond_Gameplay_Actions_Param_string_ForMemoryPack'),
				);
				return {
					$type: base,
					ID: id,
					uid,
					flag0: first,
					nextID: nextId,
					flag1: second,
					eventName,
					params: Array.from({ length: members - 6 }, () => this.#utf8()),
				};
			}
			case 'AudioBlackScreenBehaviour': {
				const preset = this.#u8();
				const flags = this.#u8();
				const fadeIn = this.#u8() !== 0;
				this.#advance(1);
				const inTime = this.#f32();
				const fadeOut = this.#u8() !== 0;
				this.#advance(3);
				return { $type: base, preset, flags, fadeIn, inTime, fadeOut, outTime: this.#f32() };
			}
			default: {
				return undefined;
			}
		}
	}

	/** @returns whether a type is a primitive, vector or enum, the kinds a raw dictionary holds */
	#plain(type: Il2CppTypeRef): boolean {
		if (type.kind === 'primitive') {
			return true;
		}
		if (type.kind !== 'definition') {
			return false;
		}
		const definition = this.schema.runtime.metadata.typeDefinition(type.definition);
		return definition.enumType || VECTORS.has(definition.name);
	}

	/** @returns the unmanaged layout of a type, or `null` if it holds references or is unknown */
	#layout(type: Il2CppTypeRef): Layout | null {
		const key = typeKey(type);
		if (this.#layouts.has(key)) {
			return this.#layouts.get(key) ?? null;
		}
		this.#layouts.set(key, null);
		const result = this.#computeLayout(type);
		this.#layouts.set(key, result);
		return result;
	}

	#computeLayout(type: Il2CppTypeRef): Layout | null {
		const { runtime } = this.schema;
		if (type.kind === 'primitive') {
			const size = PRIMITIVE_SIZES.get(type.name);
			return size === undefined ? null : { size, align: size };
		}
		if (type.kind === 'generic' && runtime.definitionName(type.definition) === 'Nullable') {
			const inner = this.#layout(type.args[0]);
			return (
				inner && {
					size: Math.ceil((inner.align + inner.size) / inner.align) * inner.align,
					align: inner.align,
				}
			);
		}
		if (type.kind !== 'definition') {
			return null;
		}
		const definition = runtime.metadata.typeDefinition(type.definition);
		const vector = VECTORS.get(definition.name);
		if (vector !== undefined) {
			const size = PRIMITIVE_SIZES.get(vector[0])!;
			return { size: size * vector[1], align: size };
		}
		if (definition.enumType) {
			return this.#layout(runtime.type(definition.elementTypeIndex));
		}
		if (!definition.valueType) {
			return null;
		}
		const fields = runtime.fields(definition).filter((field) => !field.static);
		if (fields.length === 0) {
			return null;
		}
		let size = 0;
		let align = 1;
		for (const field of fields) {
			const layout = this.#layout(field.type);
			if (layout === null) {
				return null;
			}
			size = Math.max(size, field.offset + layout.size);
			align = Math.max(align, layout.align);
		}
		return { size: Math.ceil(size / align) * align, align };
	}

	#rawAdvance(type: Il2CppTypeRef, layout: Layout): MemoryPackValue {
		return this.#rawAt(type, this.#advance(layout.size));
	}

	#raw(type: Il2CppTypeRef): MemoryPackValue {
		const layout = this.#layout(type);
		if (layout === null) {
			throw new FormatError(`no unmanaged layout for ${this.schema.runtime.typeName(type)}`);
		}
		if (type.kind === 'primitive' && type.name === 'bool') {
			const value = this.#u8();
			if (value > 1) {
				throw new FormatError(`bool ${value}`);
			}
			return value === 1;
		}
		return this.#rawAdvance(type, layout);
	}

	/** @returns an unmanaged value at an offset */
	#rawAt(type: Il2CppTypeRef, at: number): MemoryPackValue {
		const { runtime } = this.schema;
		const view = this.#view;
		if (type.kind === 'primitive') {
			switch (type.name) {
				case 'bool': {
					return view.getUint8(at) !== 0;
				}
				case 'byte': {
					return view.getUint8(at);
				}
				case 'sbyte': {
					return view.getInt8(at);
				}
				case 'short': {
					return view.getInt16(at, true);
				}
				case 'ushort':
				case 'char': {
					return view.getUint16(at, true);
				}
				case 'int': {
					return view.getInt32(at, true);
				}
				case 'uint': {
					return view.getUint32(at, true);
				}
				case 'float': {
					return view.getFloat32(at, true);
				}
				case 'double': {
					return view.getFloat64(at, true);
				}
				case 'long': {
					return view.getBigInt64(at, true).toString();
				}
				case 'ulong': {
					return view.getBigUint64(at, true).toString();
				}
				default: {
					throw new FormatError(`no raw form for ${type.name}`);
				}
			}
		}
		if (type.kind === 'generic' && runtime.definitionName(type.definition) === 'Nullable') {
			const inner = this.#layout(type.args[0])!;
			return view.getUint8(at) === 0 ? null : this.#rawAt(type.args[0], at + inner.align);
		}
		if (type.kind !== 'definition') {
			throw new FormatError(`no raw form for ${runtime.typeName(type)}`);
		}
		const definition = runtime.metadata.typeDefinition(type.definition);
		const vector = VECTORS.get(definition.name);
		if (vector !== undefined) {
			const element: Il2CppTypeRef = { kind: 'primitive', name: vector[0] };
			const size = PRIMITIVE_SIZES.get(vector[0])!;
			return Array.from({ length: vector[1] }, (_, i) => this.#rawAt(element, at + i * size));
		}
		if (definition.enumType) {
			return this.#rawAt(runtime.type(definition.elementTypeIndex), at);
		}
		const result: { [key: string]: MemoryPackValue } = { $type: definition.name };
		for (const field of runtime.fields(definition)) {
			if (!field.static) {
				result[field.name.replace(/^<(\w+)>k__BackingField$/, '$1')] = this.#rawAt(
					field.type,
					at + field.offset,
				);
			}
		}
		return result;
	}

	/** @returns a collection's items; a null collection (count -1) reads as empty */
	#list<T>(item: () => T): T[] {
		const count = this.#i32();
		if (count === -1) {
			return [];
		}
		if (count < 0 || count > this.#bytes.length - this.#at) {
			throw new FormatError(`collection of ${count} at ${this.#at - 4}`);
		}
		return Array.from({ length: count }, item);
	}

	#utf8(): string | null {
		const length = this.#i32();
		if (length === -1) {
			return null;
		}
		const at = this.#advance(length);
		return new TextDecoder().decode(this.#bytes.subarray(at, at + length));
	}

	#advance(size: number): number {
		const at = this.#at;
		if (size < 0 || at + size > this.#bytes.length) {
			throw new FormatError(`read of ${size} bytes at ${at} passes the end`);
		}
		this.#at += size;
		return at;
	}

	#u8(): number {
		return this.#view.getUint8(this.#advance(1));
	}

	#u16(): number {
		return this.#view.getUint16(this.#advance(2), true);
	}

	#i32(): number {
		return this.#view.getInt32(this.#advance(4), true);
	}

	#f32(): number {
		return this.#view.getFloat32(this.#advance(4), true);
	}
}
