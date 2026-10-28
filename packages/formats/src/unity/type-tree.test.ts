import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import type { TypeTreeNode } from './serialized-file.ts';
import { compileTypeTree, readTypeTree, readTypeTreeField, type RefTypeResolver } from './type-tree.ts';

// #region builders

const ALIGN = 0x4000;

/** builds a flattened TypeTree from `[level, type, name, byteSize, metaFlag?]` rows */
const tree = (rows: [number, string, string, number, number?][]): TypeTreeNode[] => {
	return rows.map(([level, type, name, byteSize, metaFlag = 0]) => ({
		type,
		name,
		level,
		byteSize,
		typeFlags: type === 'Array' || type === 'TypelessData' ? 1 : 0,
		metaFlag,
		version: 1,
		index: 0,
		refTypeHash: 0n,
	}));
};

/** little-endian byte builder */
class Bytes {
	readonly #out: number[] = [];

	u8(...values: number[]): this {
		this.#out.push(...values);
		return this;
	}

	i32(value: number): this {
		const view = new DataView(new ArrayBuffer(4));
		view.setInt32(0, value, true);
		return this.u8(...new Uint8Array(view.buffer));
	}

	f32(value: number): this {
		const view = new DataView(new ArrayBuffer(4));
		view.setFloat32(0, value, true);
		return this.u8(...new Uint8Array(view.buffer));
	}

	i64(value: bigint): this {
		const view = new DataView(new ArrayBuffer(8));
		view.setBigInt64(0, value, true);
		return this.u8(...new Uint8Array(view.buffer));
	}

	string(value: string): this {
		const bytes = new TextEncoder().encode(value);
		return this.i32(bytes.length).u8(...bytes);
	}

	align(): this {
		while (this.#out.length % 4 !== 0) {
			this.#out.push(0);
		}
		return this;
	}

	build(): Uint8Array {
		return new Uint8Array(this.#out);
	}
}

/** `string <name>` with Unity's usual aligned char array */
const stringRows = (
	level: number,
	name: string,
	metaFlag = 0,
): [number, string, string, number, number?][] => [
	[level, 'string', name, -1, metaFlag],
	[level + 1, 'Array', 'Array', -1, ALIGN],
	[level + 2, 'int', 'size', 4],
	[level + 2, 'char', 'data', 1],
];

const LE = { littleEndian: true };

// #endregion

describe('readTypeTree', () => {
	it('aligns only after nodes flagged 0x4000', () => {
		const compiled = compileTypeTree(
			tree([
				[0, 'Thing', 'Base', -1],
				[1, 'bool', 'a', 1],
				[1, 'bool', 'b', 1, ALIGN],
				[1, 'int', 'c', 4],
				[1, 'UInt8', 'd', 1],
				[1, 'UInt8', 'e', 1],
			]),
		);
		const bytes = new Bytes().u8(1, 0).align().i32(-5).u8(7, 8).build();
		assert.deepEqual(readTypeTree(compiled, bytes, LE), { a: true, b: false, c: -5, d: 7, e: 8 });
	});

	it('aligns strings via their Array node', () => {
		const compiled = compileTypeTree(
			tree([[0, 'Named', 'Base', -1], ...stringRows(1, 'm_Name'), [1, 'float', 'value', 4]]),
		);
		const bytes = new Bytes().string('abcde').align().f32(1.5).build();
		assert.deepEqual(readTypeTree(compiled, bytes, LE), { m_Name: 'abcde', value: 1.5 });
	});

	it('collapses vectors and returns numeric arrays as typed arrays', () => {
		const compiled = compileTypeTree(
			tree([
				[0, 'Mesh', 'Base', -1],
				[1, 'vector', 'm_IndexBuffer', -1],
				[2, 'Array', 'Array', -1, ALIGN],
				[3, 'int', 'size', 4],
				[3, 'UInt8', 'data', 1],
				[1, 'vector', 'm_Floats', -1],
				[2, 'Array', 'Array', -1],
				[3, 'int', 'size', 4],
				[3, 'float', 'data', 4],
				[1, 'TypelessData', 'm_Blob', -1, ALIGN],
				[2, 'int', 'size', 4],
				[2, 'UInt8', 'data', 1],
			]),
		);
		const bytes = new Bytes().i32(3).u8(1, 2, 3).align().i32(2).f32(0.5).f32(-2).i32(1).u8(9).align().build();
		const value = readTypeTree(compiled, bytes, LE);
		assert.ok(value.m_IndexBuffer instanceof Uint8Array);
		assert.deepEqual([...value.m_IndexBuffer], [1, 2, 3]);
		// byte arrays are views, not copies
		assert.equal(value.m_IndexBuffer.buffer, bytes.buffer);
		assert.ok(value.m_Floats instanceof Float32Array);
		assert.deepEqual([...value.m_Floats], [0.5, -2]);
		assert.deepEqual(value.m_Blob, new Uint8Array([9]));
	});

	it('reads maps as arrays of pairs and keeps path ids as bigints', () => {
		const compiled = compileTypeTree(
			tree([
				[0, 'AssetBundle', 'Base', -1],
				[1, 'map', 'm_Container', -1],
				[2, 'Array', 'Array', -1],
				[3, 'int', 'size', 4],
				[3, 'pair', 'data', -1],
				...stringRows(4, 'first'),
				[4, 'PPtr<Object>', 'second', 12],
				[5, 'int', 'm_FileID', 4],
				[5, 'SInt64', 'm_PathID', 8],
			]),
		);
		const bytes = new Bytes()
			.i32(2)
			.string('a/b.prefab')
			.align()
			.i32(0)
			.i64(-9_000_000_000_000_000_000n)
			.string('c')
			.align()
			.i32(1)
			.i64(42n)
			.build();
		assert.deepEqual(readTypeTree(compiled, bytes, LE), {
			m_Container: [
				{ first: 'a/b.prefab', second: { m_FileID: 0, m_PathID: -9_000_000_000_000_000_000n } },
				{ first: 'c', second: { m_FileID: 1, m_PathID: 42n } },
			],
		});
	});

	it('aligns after each array element whose node asks for it', () => {
		const compiled = compileTypeTree(
			tree([
				[0, 'Shapes', 'Base', -1],
				[1, 'vector', 'shapes', -1],
				[2, 'Array', 'Array', -1, ALIGN],
				[3, 'int', 'size', 4],
				[3, 'MeshBlendShape', 'data', 10],
				[4, 'unsigned int', 'firstVertex', 4],
				[4, 'unsigned int', 'vertexCount', 4],
				[4, 'bool', 'hasNormals', 1],
				[4, 'bool', 'hasTangents', 1, ALIGN],
				[1, 'int', 'after', 4],
			]),
		);
		const bytes = new Bytes()
			.i32(2)
			.i32(1)
			.i32(2)
			.u8(1, 0)
			.align()
			.i32(3)
			.i32(4)
			.u8(0, 1)
			.align()
			.i32(99)
			.build();
		const value = readTypeTree(compiled, bytes, LE);
		assert.deepEqual(value.shapes, [
			{ firstVertex: 1, vertexCount: 2, hasNormals: true, hasTangents: false },
			{ firstVertex: 3, vertexCount: 4, hasNormals: false, hasTangents: true },
		]);
		assert.equal(value.after, 99);
	});

	it('throws when bytes are left over or missing', () => {
		const compiled = compileTypeTree(
			tree([
				[0, 'X', 'Base', -1],
				[1, 'int', 'a', 4],
			]),
		);
		assert.throws(() => readTypeTree(compiled, new Uint8Array(5), LE), FormatError);
		assert.throws(() => readTypeTree(compiled, new Uint8Array(3), LE), FormatError);
	});

	it('names the failing field path', () => {
		const compiled = compileTypeTree(
			tree([
				[0, 'X', 'Base', -1],
				[1, 'vector', 'items', -1],
				[2, 'Array', 'Array', -1],
				[3, 'int', 'size', 4],
				[3, 'Item', 'data', -1],
				...stringRows(4, 'name'),
			]),
		);
		const bytes = new Bytes().i32(2).string('ok').align().i32(1000).build();
		assert.throws(() => readTypeTree(compiled, bytes, LE), /at items\[1\]\.name: /);
	});

	it('omits fields that Endfield serializes conditionally', () => {
		const compiled = compileTypeTree(
			tree([
				[0, 'Mesh', 'Base', -1],
				[1, 'bool', 'm_CollisionMeshBaked', 1, ALIGN],
				[1, 'CompressedMesh', 'm_CompressedMesh', -1],
				[2, 'int', 'm_Vertices', 4],
				[1, 'int', 'm_Tail', 4],
			]),
		);
		const baked = new Bytes().u8(1).align().i32(7).build();
		assert.deepEqual(readTypeTree(compiled, baked, LE), { m_CollisionMeshBaked: true, m_Tail: 7 });
		const regular = new Bytes().u8(0).align().i32(5).i32(7).build();
		assert.deepEqual(readTypeTree(compiled, regular, LE), {
			m_CollisionMeshBaked: false,
			m_CompressedMesh: { m_Vertices: 5 },
			m_Tail: 7,
		});
	});

	it('reads managed references through the resolver', () => {
		const compiled = compileTypeTree(
			tree([
				[0, 'MonoBehaviour', 'Base', -1],
				[1, 'ManagedReferencesRegistry', 'references', -1],
				[2, 'int', 'version', 4],
				[2, 'vector', 'RefIds', -1],
				[3, 'Array', 'Array', -1, ALIGN],
				[4, 'int', 'size', 4],
				[4, 'ReferencedObject', 'data', -1],
				[5, 'SInt64', 'rid', 8],
				[5, 'ReferencedManagedType', 'type', -1],
				...stringRows(6, 'class'),
				...stringRows(6, 'ns'),
				...stringRows(6, 'asm'),
				[5, 'ReferencedObjectData', 'data', 0],
			]),
		);
		const payload = compileTypeTree(
			tree([
				[0, 'Payload', 'Base', -1],
				[1, 'float', 'speed', 4],
			]),
		);
		const resolveRefType: RefTypeResolver = (klass, ns, asm) =>
			klass === 'Payload' && ns === 'Game' && asm === 'Asm' ? payload : undefined;
		const bytes = new Bytes()
			.i32(2)
			.i32(2)
			.i64(1n)
			.string('Payload')
			.align()
			.string('Game')
			.align()
			.string('Asm')
			.align()
			.f32(3)
			.i64(2n)
			.string('')
			.string('')
			.string('')
			.build();
		const value = readTypeTree(compiled, bytes, { littleEndian: true, resolveRefType });
		assert.deepEqual(value.references, {
			version: 2,
			RefIds: [
				{ rid: 1n, type: { class: 'Payload', ns: 'Game', asm: 'Asm' }, data: { speed: 3 } },
				{ rid: 2n, type: { class: '', ns: '', asm: '' }, data: {} },
			],
		});
		assert.throws(() => readTypeTree(compiled, bytes, LE), /unknown managed reference type/);
	});
});

describe('readTypeTreeField', () => {
	it('skips earlier fields, including variable-size ones', () => {
		const compiled = compileTypeTree(
			tree([
				[0, 'GameObject', 'Base', -1],
				[1, 'vector', 'm_Component', -1],
				[2, 'Array', 'Array', -1],
				[3, 'int', 'size', 4],
				[3, 'ComponentPair', 'data', 12],
				[4, 'PPtr<Component>', 'component', 12],
				[5, 'int', 'm_FileID', 4],
				[5, 'SInt64', 'm_PathID', 8],
				[1, 'unsigned int', 'm_Layer', 4],
				...stringRows(1, 'm_Name'),
				[1, 'bool', 'm_IsActive', 1],
			]),
		);
		const bytes = new Bytes()
			.i32(2)
			.i32(0)
			.i64(5n)
			.i32(0)
			.i64(6n)
			.i32(8)
			.string('Cube')
			.align()
			.u8(1)
			.build();
		assert.equal(readTypeTreeField(compiled, bytes, LE, 'm_Name'), 'Cube');
		assert.equal(readTypeTreeField(compiled, bytes, LE, 'm_Layer'), 8);
		assert.equal(readTypeTreeField(compiled, bytes, LE, 'missing'), undefined);
	});
});
