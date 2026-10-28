import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DecodedMesh } from '@endfield-noclip/formats/unity/mesh';

import { writeGlb } from './glb.ts';

const triangle: DecodedMesh = {
	name: 'tri',
	vertexCount: 3,
	channels: [],
	positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
	normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
	packedNormals: null,
	tangents: null,
	colors: null,
	uvs: [{ dimension: 2, format: 0, data: new Float32Array([0, 0, 1, 0, 0, 0.25]) }],
	indices: new Uint16Array([0, 1, 2]),
	submeshes: [
		{
			firstIndex: 0,
			indexCount: 3,
			topology: 0,
			baseVertex: 0,
			firstVertex: 0,
			vertexCount: 3,
			bounds: { center: [0.5, 0.5, 0], extents: [0.5, 0.5, 0] },
		},
	],
	bounds: { center: [0.5, 0.5, 0], extents: [0.5, 0.5, 0] },
	skin: null,
};

describe('writeGlb', () => {
	it('mirrors X, flips V, reverses winding and offsets by the origin', () => {
		const bytes = writeGlb(
			{
				meshes: new Map([['m', triangle]]),
				materials: new Map([['white', { name: 'white', baseColor: [1, 1, 1, 1], doubleSided: false }]]),
				draws: [
					{
						mesh: 'm',
						submesh: 0,
						material: 'white',
						matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1],
						name: 'draw',
					},
				],
			},
			[10, 0, 0],
		);
		const view = new DataView(bytes.buffer);
		assert.equal(view.getUint32(0, true), 0x46546c67);
		assert.equal(view.getUint32(8, true), bytes.length);
		const jsonLength = view.getUint32(12, true);
		const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
		const bin = bytes.subarray(28 + jsonLength);
		const read = (accessor: number, type: 'f32' | 'u32') => {
			const { bufferView, count } = json.accessors[accessor];
			const { byteOffset, byteLength } = json.bufferViews[bufferView];
			const copy = bin.slice(byteOffset, byteOffset + byteLength).buffer;
			return [...(type === 'f32' ? new Float32Array(copy) : new Uint32Array(copy))].slice(0, count * 3);
		};
		const primitive = json.meshes[0].primitives[0];
		assert.deepEqual(read(primitive.attributes.POSITION, 'f32'), [-0, 0, 0, -1, 0, 0, -0, 1, 0]);
		assert.deepEqual(json.accessors[primitive.attributes.POSITION].min, [-1, 0, 0]);
		assert.deepEqual(read(primitive.indices, 'u32').slice(0, 3), [0, 2, 1]);
		assert.deepEqual(read(primitive.attributes.TEXCOORD_0, 'f32').slice(0, 6), [0, 1, 1, 1, 0, 0.75]);
		assert.deepEqual(json.nodes[0].matrix.slice(12, 15), [0, 20, 30]);
	});
});
