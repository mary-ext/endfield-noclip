import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
	type DecodedMesh,
	decodeOctahedral,
	type MeshAttribute,
	MeshTopology,
	TEXCOORD_COUNT,
	unpackHgNormal,
	VertexAttributeFormat,
} from '@endfield-noclip/formats/unity/mesh';
import {
	decodeGeometryBlob,
	GEOMETRY_VERTEX_FORMATS,
	GeometryFlags,
	type GeometryStream,
	GeometryStreamFlags,
	GeometryVertexFormat,
	VertexAttribute,
} from '@endfield-noclip/package-format/geometry';

import { MeshoptDecoder } from 'meshoptimizer/decoder';

import { convertMesh, encodeOctahedral, geometryReady } from './geometry.ts';

// two quads in the XZ plane sharing the edge x = 1; the second mirrors U, so the shared vertices need two
// tangent frames
const POSITIONS = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 2, 0, 0, 2, 0, 1];
const UV0 = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1];

const attribute = (
	dimension: number,
	values: number[],
	format: number = VertexAttributeFormat.Float32,
): MeshAttribute => ({
	dimension,
	format,
	data: Float32Array.from(values),
});

const testMesh = (overrides: Partial<DecodedMesh> = {}): DecodedMesh => {
	const uvs: (MeshAttribute | null)[] = Array.from({ length: TEXCOORD_COUNT }, () => null);
	uvs[0] = attribute(2, UV0);
	// UV1 spans 40 units: too wide for unorm16, so it stays float32
	uvs[1] = attribute(2, [0, 0, 40, 0, 40, 1, 0, 1, 7, 7, 7, 8]);
	uvs[2] = attribute(
		4,
		Array.from({ length: 24 }, (_, i) => ((i % 5) - 2) / 127),
		VertexAttributeFormat.SNorm8,
	);
	const box = {
		center: [1, 0, 0.5] as [number, number, number],
		extents: [1, 0, 0.5] as [number, number, number],
	};
	return {
		name: 'test',
		vertexCount: 6,
		channels: [],
		positions: Float32Array.from(POSITIONS),
		normals: Float32Array.from(Array.from({ length: 6 }, () => [0, 1, 0]).flat()),
		packedNormals: null,
		tangents: null,
		colors: attribute(
			4,
			Array.from({ length: 24 }, (_, i) => (i % 4) / 3),
		),
		uvs,
		// submesh 0: both quads as triangles (winding toward +Y); submesh 1: the first quad again, as a quad
		indices: Uint16Array.from([0, 2, 1, 0, 3, 2, 1, 2, 4, 2, 5, 4, 0, 1, 2, 3]),
		submeshes: [
			{
				firstIndex: 0,
				indexCount: 12,
				topology: MeshTopology.Triangles,
				baseVertex: 0,
				firstVertex: 0,
				vertexCount: 6,
				bounds: box,
			},
			{
				firstIndex: 12,
				indexCount: 4,
				topology: MeshTopology.Quads,
				baseVertex: 0,
				firstVertex: 0,
				vertexCount: 4,
				bounds: box,
			},
		],
		bounds: box,
		skin: null,
		...overrides,
	};
};

/** decodes one stream into floats as a GPU would read it, dequantized */
const readStream = (stream: GeometryStream, vertexCount: number): number[][] => {
	const { size } = GEOMETRY_VERTEX_FORMATS[stream.format];
	const bytes = new Uint8Array(vertexCount * size);
	MeshoptDecoder.decodeVertexBuffer(bytes, vertexCount, size, stream.data);
	const view = new DataView(bytes.buffer);
	const out: number[][] = [];
	for (let v = 0; v < vertexCount; v++) {
		const at = v * size;
		let values: number[];
		switch (stream.format) {
			case GeometryVertexFormat.Unorm16x4: {
				values = [0, 1, 2, 3].map((k) => view.getUint16(at + k * 2, true) / 65535);
				break;
			}
			case GeometryVertexFormat.Unorm16x2: {
				values = [0, 1].map((k) => view.getUint16(at + k * 2, true) / 65535);
				break;
			}
			case GeometryVertexFormat.Snorm16x2: {
				values = [0, 1].map((k) => Math.max(-1, view.getInt16(at + k * 2, true) / 32767));
				break;
			}
			case GeometryVertexFormat.Snorm8x4: {
				values = [0, 1, 2, 3].map((k) => Math.max(-1, view.getInt8(at + k) / 127));
				break;
			}
			case GeometryVertexFormat.Unorm8x4: {
				values = [0, 1, 2, 3].map((k) => view.getUint8(at + k) / 255);
				break;
			}
			case GeometryVertexFormat.Float32x2: {
				values = [0, 1].map((k) => view.getFloat32(at + k * 4, true));
				break;
			}
			default: {
				throw new Error(`format ${stream.format} not handled by the test`);
			}
		}
		if ((stream.flags & GeometryStreamFlags.Dequantize) !== 0) {
			values = values.map((value, k) => (k < 3 ? stream.offset[k] + value * stream.scale[k] : value));
		}
		out.push(values);
	}
	return out;
};

const decodeAll = (blob: Uint8Array) => {
	const geometry = decodeGeometryBlob(blob);
	const wide = (geometry.flags & GeometryFlags.IndexU32) !== 0;
	const indexBytes = new Uint8Array(geometry.indexCount * (wide ? 4 : 2));
	MeshoptDecoder.decodeIndexBuffer(indexBytes, geometry.indexCount, wide ? 4 : 2, geometry.indices);
	const indices = wide ? new Uint32Array(indexBytes.buffer) : new Uint16Array(indexBytes.buffer);
	const streams = new Map(geometry.streams.map((stream) => [stream.attribute, stream]));
	const read = (which: number): number[][] => readStream(streams.get(which)!, geometry.vertexCount);
	return { geometry, indices, streams, read };
};

/** canonical triangle keys (rotation-invariant, winding-preserving) from per-corner positions */
const triangleKeys = (corners: number[][]): string[] => {
	const keys: string[] = [];
	for (let i = 0; i < corners.length; i += 3) {
		const tri = corners.slice(i, i + 3).map((p) =>
			p
				.slice(0, 3)
				.map((x) => x.toFixed(3))
				.join(','),
		);
		const rotations = [0, 1, 2].map((r) => [tri[r], tri[(r + 1) % 3], tri[(r + 2) % 3]].join(' '));
		keys.push(rotations.toSorted()[0]);
	}
	return keys.toSorted();
};

describe('convertMesh', () => {
	before(async () => {
		await geometryReady;
		await MeshoptDecoder.ready;
	});

	it('keeps every triangle, per submesh, with local u16 indices', () => {
		const { blob, entry } = convertMesh(testMesh(), 0);
		const { geometry, indices, read } = decodeAll(blob);
		assert.equal(geometry.flags & GeometryFlags.IndexU32, 0);
		assert.equal(geometry.submeshes.length, 2);
		assert.equal(entry.submeshCount, 2);
		assert.deepEqual(entry.bounds, { min: [0, 0, 0], max: [2, 0, 1] });

		const positions = read(VertexAttribute.Position);
		const source = testMesh();
		for (const [s, submesh] of geometry.submeshes.entries()) {
			const got = Array.from(
				indices.subarray(submesh.firstIndex, submesh.firstIndex + submesh.indexCount),
				(index) => {
					assert.ok(index < submesh.vertexCount);
					return positions[submesh.baseVertex + index];
				},
			);
			// the source's corners for this submesh, quads split
			const { firstIndex, indexCount, topology } = source.submeshes[s];
			const raw = [...source.indices.subarray(firstIndex, firstIndex + indexCount)];
			const corners =
				topology === MeshTopology.Quads ? [raw[0], raw[1], raw[2], raw[0], raw[2], raw[3]] : raw;
			const expected = corners.map((v) => POSITIONS.slice(v * 3, v * 3 + 3));
			assert.deepEqual(triangleKeys(got), triangleKeys(expected));
		}
		// submeshes own disjoint, consecutive vertex ranges
		assert.equal(geometry.submeshes[1].baseVertex, geometry.submeshes[0].vertexCount);
		assert.equal(geometry.vertexCount, geometry.submeshes[0].vertexCount + geometry.submeshes[1].vertexCount);
	});

	it('splits vertices on a mirrored UV seam and generates MikkTSpace tangents', () => {
		const { blob, entry } = convertMesh(testMesh(), 0);
		const { geometry, indices, read } = decodeAll(blob);
		assert.notEqual(geometry.flags & GeometryFlags.GeneratedTangents, 0);
		assert.equal(entry.tangentUv, 0);
		// six source vertices, the two on the seam doubled
		assert.equal(geometry.submeshes[0].vertexCount, 8);

		const positions = read(VertexAttribute.Position);
		const tangents = read(VertexAttribute.Tangent);
		const normals = read(VertexAttribute.Normal);
		const submesh = geometry.submeshes[0];
		for (let i = 0; i < submesh.indexCount; i += 3) {
			const vertices = [0, 1, 2].map((k) => submesh.baseVertex + indices[submesh.firstIndex + i + k]);
			const centroidX = vertices.reduce((sum, v) => sum + positions[v][0], 0) / 3;
			for (const v of vertices) {
				const t = decodeOctahedral(tangents[v][0], tangents[v][1], [0, 0, 0]);
				// U runs along +X on the first quad and along -X on the mirrored one
				assert.ok(centroidX < 1 ? t[0] > 0.999 : t[0] < -0.999, `tangent ${t.join()} at x̄ ${centroidX}`);
				assert.equal(Math.abs(tangents[v][2]), 1);
				const n = decodeOctahedral(normals[v][0], normals[v][1], [0, 0, 0]);
				assert.ok(n[1] > 0.9999);
			}
		}
	});

	it('quantizes attributes into the documented formats', () => {
		const { blob, entry } = convertMesh(testMesh(), null);
		const { geometry, streams, read } = decodeAll(blob);
		assert.equal(geometry.flags & GeometryFlags.GeneratedTangents, 0);
		assert.equal(streams.has(VertexAttribute.Tangent), false);
		assert.equal(entry.tangentUv, null);
		assert.equal(streams.get(VertexAttribute.TexCoord0)!.format, GeometryVertexFormat.Unorm16x2);
		assert.equal(streams.get(VertexAttribute.TexCoord0 + 1)!.format, GeometryVertexFormat.Float32x2);
		assert.equal(streams.get(VertexAttribute.TexCoord0 + 2)!.format, GeometryVertexFormat.Snorm8x4);
		assert.equal(streams.get(VertexAttribute.Color)!.format, GeometryVertexFormat.Unorm8x4);
		assert.equal(
			entry.attributes,
			[0, 1, 3, 4, 5, 6].reduce((mask, a) => mask | (1 << a), 0),
		);

		// without a split every output vertex maps to a source vertex with the same position
		const source = testMesh();
		const positions = read(VertexAttribute.Position);
		const uv0 = read(VertexAttribute.TexCoord0);
		const uv1 = read(VertexAttribute.TexCoord0 + 1);
		const uv2 = read(VertexAttribute.TexCoord0 + 2);
		const colors = read(VertexAttribute.Color);
		for (let v = 0; v < geometry.vertexCount; v++) {
			const match = [...Array(6).keys()].find((s) =>
				[0, 1, 2].every((k) => Math.abs(POSITIONS[s * 3 + k] - positions[v][k]) < 1e-4),
			)!;
			assert.ok(match !== undefined);
			assert.ok(
				Math.abs(uv0[v][0] - UV0[match * 2]) < 1e-4 && Math.abs(uv0[v][1] - UV0[match * 2 + 1]) < 1e-4,
			);
			assert.deepEqual(uv1[v], [...source.uvs[1]!.data.subarray(match * 2, match * 2 + 2)]);
			for (let k = 0; k < 4; k++) {
				assert.ok(Math.abs(uv2[v][k] - source.uvs[2]!.data[match * 4 + k]) < 1e-6);
				assert.ok(Math.abs(colors[v][k] - source.colors!.data[match * 4 + k]) <= 0.5 / 255);
			}
		}
	});

	it('stores the game’s packed normals exactly', () => {
		const words = Uint32Array.from([
			0,
			0x3ff_00,
			0x1ff | (0x1ff << 10),
			0x200,
			0x2_00_00 | 5,
			0x80_00_00_00 | 0x00_04_01,
		]);
		const normals = new Float32Array(18);
		const unit: [number, number, number] = [0, 0, 0];
		for (const [v, word] of words.entries()) {
			normals.set(unpackHgNormal(word, unit), v * 3);
		}
		const { blob } = convertMesh(testMesh({ normals, packedNormals: words }), null);
		const { geometry, streams, read } = decodeAll(blob);
		const stream = streams.get(VertexAttribute.Normal)!;
		assert.equal(stream.flags, GeometryStreamFlags.Dequantize);
		const positions = read(VertexAttribute.Position);
		const decoded = read(VertexAttribute.Normal);
		for (let v = 0; v < geometry.vertexCount; v++) {
			const s = [...Array(6).keys()].find((i) =>
				[0, 1, 2].every((k) => Math.abs(POSITIONS[i * 3 + k] - positions[v][k]) < 1e-4),
			)!;
			const n = decodeOctahedral(decoded[v][0], decoded[v][1], [0, 0, 0]);
			for (let k = 0; k < 3; k++) {
				assert.ok(Math.abs(n[k] - normals[s * 3 + k]) < 1e-5, `vertex ${v}: ${n.join()} vs source ${s}`);
			}
		}
	});

	it('rejects line topology', () => {
		const mesh = testMesh();
		mesh.submeshes[1] = { ...mesh.submeshes[1], topology: MeshTopology.Lines };
		assert.throws(() => convertMesh(mesh, null), /unsupported topology/);
	});
});

describe('encodeOctahedral', () => {
	it('round-trips unit vectors within the precision of its bits', () => {
		const out: [number, number] = [0, 0];
		const back: [number, number, number] = [0, 0, 0];
		let worst16 = 1;
		let worst8 = 1;
		for (let i = 0; i < 2000; i++) {
			// a deterministic spread over the sphere, poles and octant edges included
			const z = 1 - (2 * i) / 1999;
			const r = Math.sqrt(Math.max(0, 1 - z * z));
			const phi = i * 2.399963;
			const v: [number, number, number] = [r * Math.cos(phi), r * Math.sin(phi), z];
			encodeOctahedral(v[0], v[1], v[2], 16, out);
			decodeOctahedral(out[0] / 32767, out[1] / 32767, back);
			worst16 = Math.min(worst16, back[0] * v[0] + back[1] * v[1] + back[2] * v[2]);
			encodeOctahedral(v[0], v[1], v[2], 8, out);
			decodeOctahedral(out[0] / 127, out[1] / 127, back);
			worst8 = Math.min(worst8, back[0] * v[0] + back[1] * v[1] + back[2] * v[2]);
		}
		// 16 bits: under 0.01°; 8 bits: under 1°
		assert.ok(Math.acos(Math.min(1, worst16)) < (0.01 * Math.PI) / 180, `16-bit worst dot ${worst16}`);
		assert.ok(Math.acos(Math.min(1, worst8)) < Math.PI / 180, `8-bit worst dot ${worst8}`);
	});
});
