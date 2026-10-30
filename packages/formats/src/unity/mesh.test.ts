import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { decodeMesh, streamLayout, unpackHgNormal, VertexAttributeFormat } from './mesh.ts';
import type { TypeTreeObject } from './type-tree.ts';
import { streamingInfo } from './values.ts';

// #region builders

/** the inverse of {@link unpackHgNormal}: octahedral 10:10 with bit 30 set, as the game stores it */
const packNormal = (x: number, y: number, z: number): number => {
	const sum = Math.abs(x) + Math.abs(y) + Math.abs(z);
	let px = x / sum;
	let py = y / sum;
	if (z < 0) {
		[px, py] = [(1 - Math.abs(py)) * (px >= 0 ? 1 : -1), (1 - Math.abs(px)) * (py >= 0 ? 1 : -1)];
	}
	const qx = Math.round(px * 511) & 0x3ff;
	const qy = Math.round(py * 511) & 0x3ff;
	return (qx | (qy << 10) | (1 << 30)) >>> 0;
};

const channel = (stream: number, offset: number, format: number, dimension: number): TypeTreeObject => {
	return { stream, offset, format, dimension };
};

const NONE = channel(0, 0, 0, 0);

const aabb = (center: number[], extent: number[]): TypeTreeObject => {
	const [cx, cy, cz] = center;
	const [ex, ey, ez] = extent;
	return { m_Center: { x: cx, y: cy, z: cz }, m_Extent: { x: ex, y: ey, z: ez } };
};

interface MeshOptions {
	vertexCount: number;
	channels: Record<number, TypeTreeObject>;
	data: Uint8Array;
	indices: Uint16Array | Uint32Array;
	submeshes: TypeTreeObject[];
	streamPath?: string;
	extra?: TypeTreeObject;
}

const mesh = (options: MeshOptions): TypeTreeObject => {
	const channels = Array.from({ length: 14 }, (_, i) => options.channels[i] ?? NONE);
	const streamed = options.streamPath !== undefined;
	return {
		m_Name: 'test',
		m_SubMeshes: options.submeshes,
		m_BindPose: [],
		m_BoneNameHashes: new Uint32Array(0),
		m_MeshCompression: 0,
		m_CollisionMeshBaked: false,
		m_IndexFormat: options.indices instanceof Uint32Array ? 1 : 0,
		m_IndexBuffer: new Uint8Array(options.indices.buffer.slice(0)),
		m_VertexData: {
			m_VertexCount: options.vertexCount,
			m_Channels: channels,
			m_DataSize: streamed ? new Uint8Array(0) : options.data,
		},
		m_CompressedMesh: { m_Vertices: { m_NumItems: 0 } },
		m_LocalAABB: aabb([0, 0, 0], [1, 1, 1]),
		m_StreamData: { offset: 0n, size: streamed ? options.data.length : 0, path: options.streamPath ?? '' },
		m_BonesPerVertex: 0,
		...options.extra,
	};
};

const submesh = (firstByte: number, indexCount: number, baseVertex = 0): TypeTreeObject => {
	return {
		firstByte,
		indexCount,
		topology: 0,
		baseVertex,
		firstVertex: 0,
		vertexCount: 3,
		localAABB: aabb([0, 0, 0], [1, 1, 1]),
	};
};

const floatToHalf = (value: number): number => {
	// exact for the small integers and halves used here
	if (value === 0) {
		return 0;
	}
	const sign = value < 0 ? 0x8000 : 0;
	const abs = Math.abs(value);
	const exponent = Math.floor(Math.log2(abs));
	return sign | ((exponent + 15) << 10) | Math.round((abs / 2 ** exponent - 1) * 1024);
};

// #endregion

describe('decodeMesh', () => {
	// stream 0: position f32×3 (stride 12, 3 vertices → 36 bytes, padded to 48)
	// stream 1: packed normal u32, uv0 f16×2, colour unorm8×4 (stride 12)
	const normals = [
		[0, 0, 1],
		[0, 0, -1],
		[1 / Math.sqrt(3), -1 / Math.sqrt(3), -1 / Math.sqrt(3)],
	];
	const build = (): { data: Uint8Array; channels: Record<number, TypeTreeObject> } => {
		const data = new Uint8Array(48 + 36);
		const view = new DataView(data.buffer);
		for (let v = 0; v < 3; v++) {
			view.setFloat32(v * 12, v, true);
			view.setFloat32(v * 12 + 4, v * 2, true);
			view.setFloat32(v * 12 + 8, -v, true);
			const at = 48 + v * 12;
			view.setUint32(at, packNormal(normals[v][0], normals[v][1], normals[v][2]), true);
			view.setUint16(at + 4, floatToHalf(v + 0.5), true);
			view.setUint16(at + 6, floatToHalf(-v), true);
			data.set([255, 0, 51, v * 85], at + 8);
		}
		return {
			data,
			channels: {
				0: channel(0, 0, VertexAttributeFormat.Float32, 3),
				// Endfield's packed normal: one 32-bit component, dimension byte 0x31
				1: channel(1, 0, VertexAttributeFormat.Float32, 0x31),
				3: channel(1, 8, VertexAttributeFormat.UNorm8, 4),
				4: channel(1, 4, VertexAttributeFormat.Float16, 2),
			},
		};
	};

	it('reads aligned streams, packed normals, half UVs and unorm colours', () => {
		const { data, channels } = build();
		const decoded = decodeMesh(
			mesh({
				vertexCount: 3,
				channels,
				data,
				indices: new Uint16Array([0, 1, 2]),
				submeshes: [submesh(0, 3)],
			}),
			undefined,
		);
		assert.equal(decoded.vertexCount, 3);
		assert.deepEqual([...decoded.positions], [0, 0, -0, 1, 2, -1, 2, 4, -2]);
		assert.ok(decoded.normals !== null && decoded.packedNormals !== null);
		for (let v = 0; v < 3; v++) {
			for (let k = 0; k < 3; k++) {
				assert.ok(Math.abs(decoded.normals[v * 3 + k] - normals[v][k]) < 0.005, `normal ${v}.${k}`);
			}
		}
		assert.equal(decoded.channels[1].dimension, 1);
		assert.equal(decoded.channels[1].packing, 3);
		assert.deepEqual([...(decoded.uvs[0]?.data ?? [])], [0.5, 0, 1.5, -1, 2.5, -2]);
		assert.equal(decoded.uvs[1], null);
		assert.deepEqual(
			[...(decoded.colors?.data.subarray(0, 4) ?? [])].map((c) => Math.round(c * 255)),
			[255, 0, 51, 0],
		);
		assert.equal(decoded.tangents, null);
		assert.equal(decoded.skin, null);
		assert.ok(decoded.indices instanceof Uint16Array);
	});

	it('reads streamed data, 32-bit indices and submesh ranges', () => {
		const { data, channels } = build();
		const object = mesh({
			vertexCount: 3,
			channels,
			data,
			indices: new Uint32Array([2, 1, 0, 0, 1, 2]),
			submeshes: [submesh(0, 3), submesh(12, 3, 0)],
			streamPath: 'archive:/CAB-x/CAB-x.resS',
		});
		assert.deepEqual(streamingInfo(object), {
			offset: 0,
			size: data.length,
			path: 'archive:/CAB-x/CAB-x.resS',
		});
		assert.throws(() => decodeMesh(object, undefined), FormatError);
		const decoded = decodeMesh(object, data);
		assert.ok(decoded.indices instanceof Uint32Array);
		assert.deepEqual(
			decoded.submeshes.map((s) => s.firstIndex),
			[0, 3],
		);
	});

	it('rejects truncated vertex data and out-of-range submeshes', () => {
		const { data, channels } = build();
		assert.throws(
			() =>
				decodeMesh(
					mesh({
						vertexCount: 3,
						channels,
						data: data.subarray(0, 60),
						indices: new Uint16Array(3),
						submeshes: [],
					}),
					undefined,
				),
			/needs 84 bytes/,
		);
		assert.throws(
			() =>
				decodeMesh(
					mesh({ vertexCount: 3, channels, data, indices: new Uint16Array(3), submeshes: [submesh(2, 3)] }),
					undefined,
				),
			/outside the index buffer/,
		);
	});

	it('decodes implicit unit weights only for explicitly single-influence skins', () => {
		const data = new Uint8Array(20);
		data[16] = 1;
		const base = {
			vertexCount: 1,
			channels: {
				0: channel(0, 0, VertexAttributeFormat.Float32, 3),
				13: channel(1, 0, VertexAttributeFormat.UInt8, 0x14),
			},
			data,
			indices: new Uint16Array(0),
			submeshes: [],
		};
		const decoded = decodeMesh(mesh({ ...base, extra: { m_BonesPerVertex: 1 } }), undefined);
		assert.deepEqual(Array.from(decoded.skin!.weights!.data), [1, 0, 0, 0]);
		assert.deepEqual(Array.from(decoded.skin!.indices!.data), [1, 0, 0, 0]);
		assert.equal(decoded.skin!.hasBlendWeights, false);
		const multiple = decodeMesh(mesh({ ...base, extra: { m_BonesPerVertex: 2 } }), undefined);
		assert.equal(multiple.skin!.weights, null);
	});

	it('rejects collision-only and compressed meshes, and reports skins', () => {
		const { data, channels } = build();
		const base = { vertexCount: 3, channels, data, indices: new Uint16Array(3), submeshes: [] };
		assert.throws(
			() => decodeMesh(mesh({ ...base, extra: { m_CollisionMeshBaked: true } }), undefined),
			/collision/,
		);
		assert.throws(
			() =>
				decodeMesh(
					mesh({ ...base, extra: { m_CompressedMesh: { m_Vertices: { m_NumItems: 9 } } } }),
					undefined,
				),
			/m_CompressedMesh/,
		);
		// the import setting alone doesn't matter
		assert.doesNotThrow(() => decodeMesh(mesh({ ...base, extra: { m_MeshCompression: 4 } }), undefined));
		const skinned = decodeMesh(
			mesh({ ...base, extra: { m_BindPose: [{}, {}], m_BonesPerVertex: 4 } }),
			undefined,
		);
		assert.deepEqual(skinned.skin, {
			bonesPerVertex: 4,
			bindPoseCount: 2,
			boneNameHashCount: 0,
			hasBlendWeights: false,
			hasBlendIndices: false,
			weights: null,
			indices: null,
		});
	});
});

describe('streamLayout', () => {
	it('aligns consecutive streams to 16 bytes', () => {
		const channels = [
			{ channel: 0, stream: 0, offset: 0, format: VertexAttributeFormat.Float32, dimension: 3, packing: 0 },
			{ channel: 4, stream: 1, offset: 0, format: VertexAttributeFormat.Float16, dimension: 2, packing: 0 },
			{ channel: 3, stream: 2, offset: 0, format: VertexAttributeFormat.UNorm8, dimension: 4, packing: 0 },
		];
		assert.deepEqual(streamLayout(channels, 5), [
			{ offset: 0, stride: 12 },
			{ offset: 64, stride: 4 },
			{ offset: 96, stride: 4 },
		]);
	});
});

describe('unpackHgNormal', () => {
	it('ignores the bits above the octahedral pair', () => {
		const out: [number, number, number] = [0, 0, 0];
		const word = packNormal(0, 1, 0);
		const a = [...unpackHgNormal(word, out)];
		const b = [...unpackHgNormal((word | 0x8000_0000 | (0x155 << 20)) >>> 0, out)];
		assert.deepEqual(a, b);
		assert.ok(Math.abs(a[1] - 1) < 1e-6);
	});
});
