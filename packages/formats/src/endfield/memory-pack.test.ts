import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';
import { AttributeReader, type TypeDefinition } from '../il2cpp/metadata.ts';
import type { Il2CppRuntime, Il2CppTypeRef, ResolvedField } from '../il2cpp/registration.ts';

import { MemoryPackReader, MemoryPackSchema } from './memory-pack.ts';

// a tiny client: types are described by name, and the fake runtime answers only what the schema reads

interface FakeType {
	name: string;
	valueType?: boolean;
	enumOf?: string;
	/** wrapper members: name → type */
	members?: [string, Il2CppTypeRef][];
	/** the type a wrapper serializes */
	wraps?: Il2CppTypeRef;
	parent?: string;
	/** union subtypes: tag → wrapper name */
	union?: [number, string][];
	/** struct fields */
	fields?: [string, Il2CppTypeRef, number][];
}

const prim = (name: string): Il2CppTypeRef => ({ kind: 'primitive', name });

const fakeRuntime = (types: FakeType[]): Il2CppRuntime => {
	const index = (name: string) => types.findIndex((type) => type.name === name);
	// type table: one entry per definition, then extra entries the methods point at
	const table: Il2CppTypeRef[] = types.map((_, definition) => ({ kind: 'definition', definition }));
	const tableIndex = (ref: Il2CppTypeRef) => table.push(ref) - 1;
	const methods: {
		name: string;
		declaringType: number;
		returnType: number;
		parameterStart: number;
		parameterCount: number;
	}[] = [];
	const parameters: number[] = [];
	const properties: { name: string; get: number; set: number }[] = [];
	const definitions: TypeDefinition[] = types.map((type, i) => {
		const methodStart = methods.length;
		const propertyStart = properties.length;
		for (const [name, ref] of type.members ?? []) {
			properties.push({ name: `__${name}__`, get: -1, set: methods.length - methodStart });
			methods.push({
				name: `set_${name}`,
				declaringType: i,
				returnType: 0,
				parameterStart: parameters.length,
				parameterCount: 1,
			});
			parameters.push(tableIndex(ref));
		}
		if (type.wraps) {
			methods.push({
				name: 'GetValue',
				declaringType: i,
				returnType: tableIndex(type.wraps),
				parameterStart: 0,
				parameterCount: 0,
			});
		}
		return {
			index: i,
			name: type.name,
			namespace: '',
			byvalTypeIndex: i,
			declaringTypeIndex: -1,
			parentIndex: type.parent === undefined ? -1 : index(type.parent),
			elementTypeIndex: type.enumOf === undefined ? -1 : tableIndex(prim(type.enumOf)),
			genericContainerIndex: -1,
			fieldStart: 0,
			fieldCount: 0,
			methodStart,
			methodCount: methods.length - methodStart,
			propertyStart,
			propertyCount: properties.length - propertyStart,
			valueType: type.valueType === true || type.enumOf !== undefined,
			enumType: type.enumOf !== undefined,
			token: i,
		};
	});
	const unionAttribute = types.length;
	const metadata = {
		typeDefinitionCount: types.length,
		typeDefinition: (i: number) =>
			i === unionAttribute ? { name: 'MemoryPackUnionAttribute' } : definitions[i],
		method: (i: number) => (i === -1 ? { declaringType: unionAttribute } : methods[i]),
		property: (i: number) => properties[i],
		parameterType: (i: number) => parameters[i],
		attributes: (definition: TypeDefinition) => {
			const union = types[definition.index].union;
			if (union === undefined) {
				return undefined;
			}
			// count, constructor indices (-1: the union attribute), then per attribute: 2 arguments, no named ones;
			// a u16 tag (kind 0x07) and a type index (kind 0xff, zigzag compressed)
			const bytes = [union.length, ...union.flatMap(() => [0xff, 0xff, 0xff, 0xff])];
			for (const [tag, name] of union) {
				bytes.push(2, 0, 0, 0x07, tag & 0xff, tag >> 8, 0xff, index(name) * 2);
			}
			return new AttributeReader(new Uint8Array(bytes));
		},
	};
	return {
		metadata,
		type: (i: number) => table[i],
		typeName: (ref: Il2CppTypeRef) =>
			ref.kind === 'primitive' ? ref.name : ref.kind === 'definition' ? types[ref.definition].name : ref.kind,
		definitionName: (i: number) => types[i].name,
		fields: (definition: TypeDefinition): ResolvedField[] =>
			(types[definition.index].fields ?? []).map(([name, type, offset]) => ({
				name,
				type,
				offset,
				static: false,
			})),
	} as unknown as Il2CppRuntime;
};

const def = (types: FakeType[], name: string): Il2CppTypeRef => ({
	kind: 'definition',
	definition: types.findIndex((type) => type.name === name),
});

const TYPES: FakeType[] = [];
TYPES.push(
	{ name: 'Mode', enumOf: 'byte' },
	{
		name: 'ScriptPtr',
		valueType: true,
		fields: [
			['id', prim('ulong'), 0],
			['level', prim('int'), 8],
		],
	},
	{ name: 'Node' },
	{ name: 'Show' },
	{ name: 'Root' },
	{ name: 'NodeForMemoryPack', union: [[1, 'ShowForMemoryPack']] },
	{ name: 'BaseForMemoryPack', members: [['ID', prim('int')]] },
);
TYPES.push(
	{
		name: 'ShowForMemoryPack',
		parent: 'BaseForMemoryPack',
		members: [
			['target', prim('ulong')],
			['mode', def(TYPES, 'Mode')],
		],
		wraps: def(TYPES, 'Show'),
	},
	{
		name: 'RootForMemoryPack',
		members: [
			['name', prim('string')],
			['script', def(TYPES, 'ScriptPtr')],
			['nodes', { kind: 'generic', definition: TYPES.length + 2, args: [def(TYPES, 'Node')] }],
			['ids', { kind: 'generic', definition: TYPES.length + 3, args: [prim('uint'), prim('float')] }],
		],
		wraps: def(TYPES, 'Root'),
	},
	{ name: 'List' },
	{ name: 'Dictionary' },
);
// the union wrapper serializes the base type
TYPES[TYPES.findIndex((type) => type.name === 'NodeForMemoryPack')].wraps = def(TYPES, 'Node');

/** little-endian bytes of the given widths */
const bytes = (...parts: [number | bigint, 1 | 2 | 4 | 8][]): Uint8Array => {
	const out: number[] = [];
	for (const [value, size] of parts) {
		const big = BigInt(value);
		for (let i = 0; i < size; i++) {
			out.push(Number((big >> BigInt(8 * i)) & 0xffn));
		}
	}
	return new Uint8Array(out);
};

test('decodes wrappers, unions, enums, raw pointers and raw dictionaries', () => {
	const schema = new MemoryPackSchema(fakeRuntime(TYPES));
	const reader = new MemoryPackReader(schema, (id) => (id === 7 ? 'hello' : undefined));
	const encoded = bytes(
		[4, 1], // Root: 4 members
		[7, 4], // name: string id 7
		[123n, 8], // script: raw ScriptPtr { id, level }, 16 bytes with padding
		[5, 4],
		[0, 4],
		[2, 4], // nodes: 2 items
		[1, 1], // union tag 1 → Show
		[3, 1], // Show: 3 members, base first
		[9, 4], // ID
		[10100520002n, 8], // target
		[2, 1], // mode (byte enum)
		[255, 1], // null node
		[1, 4], // ids: one raw (uint, float) pair
		[42, 4],
		[0x3f800000, 4],
	);
	assert.deepEqual(reader.decode(encoded, 'RootForMemoryPack'), {
		$type: 'RootForMemoryPack',
		name: 'hello',
		script: { $type: 'ScriptPtr', id: '123', level: 5 },
		nodes: [{ $type: 'ShowForMemoryPack', ID: 9, target: '10100520002', mode: 2 }, null],
		ids: [[42, 1]],
	});
	assert.throws(() => reader.decode(bytes([3, 1]), 'RootForMemoryPack'), /3 members, expected 4/);
	assert.throws(() => reader.decode(new Uint8Array([...encoded, 0]), 'RootForMemoryPack'), FormatError);
});

test('reads compressed integers as IL2CPP metadata writes them', () => {
	const reader = new AttributeReader(
		new Uint8Array([0, 0x7f, 0x81, 0x02, 0xc0, 0x01, 0x02, 0x03, 0x05, 0xff]),
	);
	assert.deepEqual(reader.constructors, []);
	assert.equal(reader.compressedU32(), 0x7f);
	assert.equal(reader.compressedU32(), 0x102);
	assert.equal(reader.compressedU32(), 0x010203);
	// zigzag: 5 → -3
	assert.equal(reader.compressedI32(), -3);
	assert.equal(reader.compressedI32(), -0x80000000);
	assert.throws(() => reader.byte(), FormatError);
});
