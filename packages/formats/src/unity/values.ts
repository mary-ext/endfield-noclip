/**
 * narrowing accessors over {@link TypeTreeValue}s, for class decoders that expect a known field shape. each
 * accessor throws a {@link FormatError} naming the field when the shape doesn't match, so a decoder reads like
 * the class definition and still fails with a useful message on unexpected data.
 */

import { FormatError } from '../binary/binary-reader.ts';

import type { TypeTreeObject, TypeTreeValue } from './type-tree.ts';

/** a `PPtr<T>`: `m_FileID` 0 is the same file, n ≥ 1 is `externals[n - 1]`; path id 0 is null */
export interface PPtr {
	fileId: number;
	pathId: bigint;
}

/**
 * @param value any value, e.g. a TypeTree read or parsed JSON
 * @returns whether it's a plain object (not `null`, an array, a typed array or a primitive)
 */
export const isObject = (value: unknown): value is TypeTreeObject => {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && !ArrayBuffer.isView(value);
};

/**
 * @param parent class instance
 * @param name field name
 * @returns the field as a class instance
 * @throws {FormatError} if it's missing or not a class instance
 */
export const objectField = (parent: TypeTreeObject, name: string): TypeTreeObject => {
	const value = parent[name];
	if (!isObject(value)) {
		throw new FormatError(`field ${name} is not an object`);
	}
	return value;
};

/**
 * @param parent class instance
 * @param name field name
 * @returns the field as a number (64-bit integers are converted)
 * @throws {FormatError} if it's missing or not numeric
 */
export const numberField = (parent: TypeTreeObject, name: string): number => {
	const value = parent[name];
	if (typeof value === 'number') {
		return value;
	}
	if (typeof value === 'bigint') {
		return Number(value);
	}
	if (typeof value === 'boolean') {
		return value ? 1 : 0;
	}
	throw new FormatError(`field ${name} is not a number`);
};

/**
 * @param parent class instance
 * @param name field name
 * @returns the field as a number, or `undefined` if the class doesn't have it
 * @throws {FormatError} if it's present but not numeric
 */
export const optionalNumberField = (parent: TypeTreeObject, name: string): number | undefined => {
	return Object.hasOwn(parent, name) ? numberField(parent, name) : undefined;
};

/**
 * @param parent class instance
 * @param name field name
 * @returns the field as a string
 * @throws {FormatError} if it's missing or not a string
 */
export const stringField = (parent: TypeTreeObject, name: string): string => {
	const value = parent[name];
	if (typeof value !== 'string') {
		throw new FormatError(`field ${name} is not a string`);
	}
	return value;
};

/**
 * @param parent class instance
 * @param name field name
 * @returns the field as a boolean (numbers are compared against 0)
 * @throws {FormatError} if it's missing or not boolean-like
 */
export const booleanField = (parent: TypeTreeObject, name: string): boolean => {
	const value = parent[name];
	if (typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'number') {
		return value !== 0;
	}
	throw new FormatError(`field ${name} is not a boolean`);
};

/**
 * @param parent class instance
 * @param name field name
 * @returns the field as an array of values; numeric arrays are spread into plain arrays
 * @throws {FormatError} if it's missing or not an array
 */
export const arrayField = (parent: TypeTreeObject, name: string): TypeTreeValue[] => {
	const value = parent[name];
	if (Array.isArray(value)) {
		return value;
	}
	if (ArrayBuffer.isView(value)) {
		return Array.from(value as ArrayLike<number | bigint>);
	}
	throw new FormatError(`field ${name} is not an array`);
};

/**
 * @param parent class instance
 * @param name field name
 * @returns the field as bytes (`vector<UInt8>` or `TypelessData`); a view, not a copy
 * @throws {FormatError} if it's missing or not a byte array
 */
export const bytesField = (parent: TypeTreeObject, name: string): Uint8Array => {
	const value = parent[name];
	if (value instanceof Uint8Array) {
		return value;
	}
	if (Array.isArray(value) && value.length === 0) {
		return new Uint8Array(0);
	}
	throw new FormatError(`field ${name} is not a byte array`);
};

/**
 * @param value a decoded `PPtr<T>`
 * @returns it as a {@link PPtr}
 * @throws {FormatError} if it doesn't have that shape
 */
export const asPPtr = (value: TypeTreeValue | undefined): PPtr => {
	if (!isObject(value)) {
		throw new FormatError('PPtr is not an object');
	}
	const pathId = value.m_PathID;
	if (typeof pathId !== 'bigint' && typeof pathId !== 'number') {
		throw new FormatError('PPtr has no m_PathID');
	}
	return { fileId: numberField(value, 'm_FileID'), pathId: BigInt(pathId) };
};

/**
 * @param parent class instance
 * @param name field name
 * @returns the field as a {@link PPtr}
 * @throws {FormatError} if it's missing or not a PPtr
 */
export const pptrField = (parent: TypeTreeObject, name: string): PPtr => {
	try {
		return asPPtr(parent[name]);
	} catch (error) {
		throw new FormatError(`field ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
};

/**
 * @param value a decoded `map<K, V>` (an array of `{ first, second }`)
 * @returns its entries in serialized order
 * @throws {FormatError} if it doesn't have that shape
 */
export const mapEntries = (value: TypeTreeValue | undefined): [TypeTreeValue, TypeTreeValue][] => {
	if (!Array.isArray(value)) {
		throw new FormatError('map is not an array');
	}
	return value.map((entry) => {
		if (!isObject(entry) || !Object.hasOwn(entry, 'first') || !Object.hasOwn(entry, 'second')) {
			throw new FormatError('map entry is not a { first, second } pair');
		}
		return [entry.first, entry.second];
	});
};

/** a `StreamingInfo` (`m_StreamData`): where out-of-line data lives */
export interface StreamingInfo {
	offset: number;
	size: number;
	/** e.g. `archive:/CAB-<hex>/CAB-<hex>.resS`; empty when the data is inline */
	path: string;
}

/**
 * @param object a decoded object whose class may stream its data (e.g. `Mesh`, `Texture2D`)
 * @returns its `m_StreamData`, or `undefined` if the class has none or the data is inline (empty path)
 * @throws {FormatError} if the field has the wrong shape
 */
export const streamingInfo = (object: TypeTreeObject): StreamingInfo | undefined => {
	if (!Object.hasOwn(object, 'm_StreamData')) {
		return undefined;
	}
	const value = objectField(object, 'm_StreamData');
	const path = stringField(value, 'path');
	if (path === '') {
		return undefined;
	}
	return { offset: numberField(value, 'offset'), size: numberField(value, 'size'), path };
};

/**
 * @param parent class instance
 * @param name field name of a `Vector3f`
 * @returns `[x, y, z]`
 */
export const vector3Field = (parent: TypeTreeObject, name: string): [number, number, number] => {
	const value = objectField(parent, name);
	return [numberField(value, 'x'), numberField(value, 'y'), numberField(value, 'z')];
};

/** an axis-aligned box as Unity stores it: centre and half-extents */
export interface Aabb {
	center: [number, number, number];
	extents: [number, number, number];
}

/**
 * @param parent class instance
 * @param name field name of an `AABB`
 * @returns the box
 * @throws {FormatError} if it's missing or not an `AABB`
 */
export const aabbField = (parent: TypeTreeObject, name: string): Aabb => {
	const value = objectField(parent, name);
	return { center: vector3Field(value, 'm_Center'), extents: vector3Field(value, 'm_Extent') };
};
