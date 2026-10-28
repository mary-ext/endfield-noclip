import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	decodeBlobTable,
	decodeChains,
	decodeGeometryBlob,
	decodeHeightPage,
	decodeInstanceBlock,
	decodeTree,
	encodeBlobTable,
	encodeChains,
	encodeGeometryBlob,
	encodeHeightPage,
	encodeInstanceBlock,
	encodeTree,
} from './codec.ts';
import { PackageFormatError } from './errors.ts';
import {
	BlobCodec,
	BlobKind,
	blobPath,
	type Chain,
	ContentKind,
	DrawRole,
	type GeometryBlob,
	GeometryFlags,
	GeometryStreamFlags,
	GeometryVertexFormat,
	type InstanceBlock,
	textureLevelLayout,
	tileAncestor,
	tileAt,
	type Tree,
	VertexAttribute,
} from './format.ts';

describe('tree', () => {
	it('round-trips nodes and refs', () => {
		const tree: Tree = {
			nodes: [
				{
					level: 0,
					x: -1,
					z: 0,
					childMask: 0b1001,
					flags: 3,
					bounds: { min: [-4096, -10.5, 0], max: [0, 400.25, 4096] },
					geometricError: 256,
					refFirst: 0,
					refCount: 2,
				},
				{
					level: 1,
					x: -2,
					z: 1,
					childMask: 0,
					flags: 4,
					bounds: { min: [-4096, 0, 2048], max: [-2048, 1, 4096] },
					geometricError: 128,
					refFirst: 2,
					refCount: 0,
				},
			],
			refs: [
				{ kind: ContentKind.TerrainHeights, tier: 0, area: 0, blob: 7, first: 0, count: 1, param: 1.5 },
				{ kind: ContentKind.Hlod, tier: 2, area: 1664795649, blob: 3, first: 10, count: 4, param: 0 },
			],
		};
		assert.deepEqual(decodeTree(encodeTree(tree)), tree);
	});

	it('rejects truncated input', () => {
		const data = encodeTree({ nodes: [], refs: [] });
		assert.throws(() => decodeTree(data.subarray(0, 8)), PackageFormatError);
	});

	it('rejects ref slices past the table', () => {
		assert.throws(
			() =>
				encodeTree({
					nodes: [
						{
							level: 0,
							x: 0,
							z: 0,
							childMask: 0,
							flags: 0,
							bounds: { min: [0, 0, 0], max: [1, 1, 1] },
							geometricError: 0,
							refFirst: 0,
							refCount: 1,
						},
					],
					refs: [],
				}),
			RangeError,
		);
	});
});

describe('chains', () => {
	it('round-trips draws in order', () => {
		const chains: Chain[] = [
			{
				lodCount: 2,
				flags: 1,
				draws: [
					{
						geometry: 4,
						material: 9,
						submesh: 1,
						lod: 0,
						role: DrawRole.Lit,
						minSquared: 0.25,
						maxSquared: 3.4028234663852886e38,
						sourceFlags: 0x0bf80000,
					},
					{
						geometry: 5,
						material: 9,
						submesh: 0,
						lod: 1,
						role: DrawRole.ShadowOnly,
						minSquared: -0.5,
						maxSquared: 0.25,
						sourceFlags: 1 << 10,
					},
				],
			},
			{ lodCount: 1, flags: 2, draws: [] },
		];
		assert.deepEqual(decodeChains(encodeChains(chains)), chains);
	});
});

describe('blob table', () => {
	it('round-trips records', () => {
		const blobs = [
			{
				hash: '0123456789abcdef0123456789abcdef',
				archive: 3,
				codec: BlobCodec.Zstd,
				kind: BlobKind.Instances,
				offset: 4_000_000_000,
				length: 12,
				rawLength: 40,
			},
		];
		assert.deepEqual(decodeBlobTable(encodeBlobTable(blobs)), blobs);
		assert.equal(blobPath(blobs[0].hash, blobs[0].kind), 'blobs/0123456789abcdef0123456789abcdef.inst');
	});

	it('rejects malformed hashes and 64-bit offsets', () => {
		const record = {
			hash: 'xyz',
			archive: 0,
			codec: BlobCodec.None,
			kind: BlobKind.Other,
			offset: 0,
			length: 0,
			rawLength: 0,
		};
		assert.throws(() => encodeBlobTable([record]), PackageFormatError);
		assert.throws(() => encodeBlobTable([{ ...record, hash: '0'.repeat(32), offset: 2 ** 32 }]), RangeError);
	});

	it('rejects unknown codecs and kinds', () => {
		const table = encodeBlobTable([
			{
				hash: '0'.repeat(32),
				archive: 0,
				codec: BlobCodec.None,
				kind: BlobKind.Other,
				offset: 0,
				length: 0,
				rawLength: 0,
			},
		]);
		const badCodec = table.slice();
		badCodec[16 + 18] = 0xee;
		assert.throws(() => decodeBlobTable(badCodec), /unknown blob codec 238/);
		const badKind = table.slice();
		badKind[16 + 19] = 0xee;
		assert.throws(() => decodeBlobTable(badKind), /unknown blob kind 238/);
	});
});

describe('instance blocks', () => {
	const block = (count: number): InstanceBlock => ({
		flags: 1,
		origin: [-1024, 0, 512],
		chains: Uint32Array.from({ length: count }, (_, i) => i * 3),
		transforms: Float32Array.from({ length: count * 12 }, (_, i) => i / 4),
		bounds: Float32Array.from({ length: count * 6 }, (_, i) => -i),
		entityIds: Uint32Array.from({ length: count }, (_, i) => 0xf000_0000 + i),
		layers: Uint8Array.from({ length: count }, (_, i) => i % 12),
	});

	it('round-trips counts that need layer padding', () => {
		for (const count of [0, 1, 3, 4, 5]) {
			assert.deepEqual(decodeInstanceBlock(encodeInstanceBlock(block(count))), block(count));
		}
	});

	it('keeps sections 4-byte aligned', () => {
		const data = encodeInstanceBlock(block(3));
		assert.equal(data.length % 4, 0);
	});

	it('rejects mismatched sections', () => {
		assert.throws(() => encodeInstanceBlock({ ...block(2), layers: new Uint8Array(1) }), RangeError);
	});
});

describe('height pages', () => {
	it('round-trips heights, holes and wrapping deltas exactly', () => {
		const side = 65;
		const samples = new Uint16Array(side * side);
		let seed = 12345;
		for (let i = 0; i < samples.length; i++) {
			seed = (seed * 1103515245 + 12345) & 0x7fff_ffff;
			const x = i % side;
			const z = Math.floor(i / side);
			// smooth terrain with a hole patch and a few extreme values
			let h = 8000 + x * 37 + z * 11 + (seed % 7);
			if (x > 40 && z < 10) {
				h |= 0x8000;
			}
			if (i % 997 === 0) {
				h = i % 2 === 0 ? 0 : 0xffff;
			}
			samples[i] = h;
		}
		const decoded = decodeHeightPage(encodeHeightPage(samples, side));
		assert.equal(decoded.side, side);
		assert.deepEqual(decoded.samples, samples);
	});

	it('rejects the wrong sample count', () => {
		assert.throws(() => encodeHeightPage(new Uint16Array(10), 65), RangeError);
	});
});

describe('geometry blobs', () => {
	it('round-trips the container with unaligned payloads', () => {
		const blob: GeometryBlob = {
			flags: GeometryFlags.GeneratedTangents,
			vertexCount: 5,
			indexCount: 9,
			streams: [
				{
					attribute: VertexAttribute.Position,
					format: GeometryVertexFormat.Unorm16x4,
					flags: GeometryStreamFlags.Dequantize,
					offset: [-1, 0, 2.5],
					scale: [2, 0, 0.5],
					data: Uint8Array.from([1, 2, 3, 4, 5]),
				},
				{
					attribute: VertexAttribute.TexCoord0 + 1,
					format: GeometryVertexFormat.Float32x2,
					flags: 0,
					offset: [0, 0, 0],
					scale: [1, 1, 1],
					data: Uint8Array.from([9, 8, 7]),
				},
			],
			submeshes: [
				{
					firstIndex: 0,
					indexCount: 6,
					baseVertex: 0,
					vertexCount: 4,
					bounds: { min: [-1, 0, 2.5], max: [1, 0, 3] },
				},
				{
					firstIndex: 6,
					indexCount: 3,
					baseVertex: 4,
					vertexCount: 1,
					bounds: { min: [0, 0, 0], max: [0, 0, 0] },
				},
			],
			indices: Uint8Array.from([42, 43, 44, 45, 46, 47, 48]),
		};
		const encoded = encodeGeometryBlob(blob);
		assert.equal(encoded.byteLength % 4, 0);
		assert.deepEqual(decodeGeometryBlob(encoded), blob);
		assert.throws(() => decodeGeometryBlob(encoded.subarray(0, encoded.byteLength - 4)), PackageFormatError);
		const badFormat = encoded.slice();
		badFormat[32 + 1] = 200;
		assert.throws(() => decodeGeometryBlob(badFormat), /unknown vertex format/);
	});
});

describe('texture levels', () => {
	it('lays out block-compressed, array and 3D levels', () => {
		const bc7 = {
			kind: '2d-array',
			format: 'bc7-rgba-unorm',
			width: 100,
			height: 60,
			depthOrArrayLayers: 3,
		} as const;
		// 100×60 → 25×15 blocks of 16 bytes, three layers
		assert.deepEqual(textureLevelLayout(bc7, 0), {
			width: 100,
			height: 60,
			depthOrArrayLayers: 3,
			bytesPerRow: 400,
			rowsPerImage: 15,
			byteLength: 18_000,
		});
		// 1×1 still takes a whole block
		assert.equal(textureLevelLayout(bc7, 7).byteLength, 48);
		const volume = { kind: '3d', format: 'rgba16float', width: 8, height: 8, depthOrArrayLayers: 8 } as const;
		assert.equal(textureLevelLayout(volume, 1).byteLength, 4 * 4 * 4 * 8);
		assert.throws(() => textureLevelLayout({ ...volume, format: 'astc-4x4-unorm' }, 0), RangeError);
	});
});

describe('tile addressing', () => {
	const tree = { origin: [-2048, -2048] as [number, number], rootSize: 4096 };

	it('finds tiles off the root square', () => {
		assert.deepEqual(tileAt(tree, 6, -2048, -2048), { level: 6, x: 0, z: 0 });
		assert.deepEqual(tileAt(tree, 6, -2049, 2048), { level: 6, x: -1, z: 64 });
	});

	it('floors negative coordinates towards their ancestor', () => {
		assert.deepEqual(tileAncestor({ level: 6, x: -1, z: 65 }, 3), { level: 3, x: -1, z: 8 });
		assert.throws(() => tileAncestor({ level: 2, x: 0, z: 0 }, 3), RangeError);
	});
});
