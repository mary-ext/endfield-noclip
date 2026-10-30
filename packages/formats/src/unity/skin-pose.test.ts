import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { type DecodedMesh, VertexAttributeFormat } from './mesh.ts';
import { bakeSkinPose } from './skin-pose.ts';
import { trsMatrix } from './transform.ts';

const mesh = (): DecodedMesh => ({
	name: 'synthetic skinned part',
	vertexCount: 1,
	channels: [],
	positions: new Float32Array([1, 0, 0]),
	normals: new Float32Array([Math.SQRT1_2, Math.SQRT1_2, 0]),
	packedNormals: null,
	tangents: {
		dimension: 4,
		format: VertexAttributeFormat.Float32,
		data: new Float32Array([Math.SQRT1_2, -Math.SQRT1_2, 0, 1]),
	},
	colors: null,
	uvs: [],
	indices: new Uint16Array(),
	submeshes: [],
	bounds: { center: [1, 0, 0], extents: [0, 0, 0] },
	skin: {
		bonesPerVertex: 4,
		bindPoseCount: 2,
		boneNameHashCount: 2,
		hasBlendWeights: true,
		hasBlendIndices: true,
		weights: {
			dimension: 4,
			format: VertexAttributeFormat.Float32,
			data: new Float32Array([0.25, 0.75, 0, 0]),
		},
		indices: { dimension: 4, format: VertexAttributeFormat.UInt8, data: new Float32Array([0, 1, 0, 0]) },
	},
});
const near = (actual: ArrayLike<number>, expected: number[]): void => {
	assert.equal(actual.length, expected.length);
	for (let i = 0; i < actual.length; i++) {
		assert.ok(Math.abs(actual[i] - expected[i]) < 1e-5);
	}
};

test('bakes weighted bone transforms into immutable static geometry and updates bounds', () => {
	const original = mesh();
	const before = structuredClone(original);
	const result = bakeSkinPose(original, [
		trsMatrix([1, 0, 0], [0, 0, 0, 1], [1, 1, 1]),
		trsMatrix([5, 0, 0], [0, 0, 0, 1], [1, 1, 1]),
	]);
	near(result.positions, [5, 0, 0]);
	assert.deepEqual(result.bounds, { center: [5, 0, 0], extents: [0, 0, 0] });
	assert.equal(result.skin, null);
	assert.deepEqual(original, before);
});

test('nonuniform bone scale preserves the normal/tangent frame', () => {
	const pose = trsMatrix([0, 0, 0], [0, 0, 0, 1], [2, 1, 1]);
	const result = bakeSkinPose(mesh(), [pose, pose]);
	near(result.normals!, [1 / Math.sqrt(5), 2 / Math.sqrt(5), 0]);
	near(result.tangents!.data, [2 / Math.sqrt(5), -1 / Math.sqrt(5), 0, 1]);
});

test('missing referenced bones and unweighted vertices fail explicitly', () => {
	const source = mesh();
	assert.throws(() => bakeSkinPose(source, []), FormatError);
	source.skin!.weights!.data.fill(0);
	assert.throws(() => bakeSkinPose(source, []), /unweighted vertex/);
});
