/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import {
	parseTerrainPath,
	parseTerrainTexture,
	readTerrainBc3Page,
	readTerrainHeightSamples,
	readTerrainSurfacesData,
	readTerrainTexture,
	TERRAIN_HEIGHT_HOLE,
	terrainHeightsToWorld,
	terrainLeafLevel,
	terrainNodeIndex,
	terrainTileFootprint,
	TerrainFormat,
	type TerrainSurfacesData,
} from './terrain.ts';

const tret = (
	width: number,
	height: number,
	mips: number,
	format: number,
	payload: Uint8Array,
): Uint8Array => {
	const out = new Uint8Array(20 + payload.length);
	const view = new DataView(out.buffer);
	out.set([0x54, 0x52, 0x45, 0x54]);
	view.setUint32(4, 1, true);
	view.setUint16(8, width, true);
	view.setUint16(10, height, true);
	view.setUint16(12, mips, true);
	view.setUint16(14, format, true);
	view.setUint32(16, payload.length, true);
	out.set(payload, 20);
	return out;
};

/** wraps bytes in the VFS envelope as one literal-only inverted-LZ4 sequence */
const envelope = (clear: Uint8Array): Uint8Array => {
	const length: number[] = [];
	let rest = clear.length - 15;
	while (rest >= 255) {
		length.push(255);
		rest -= 255;
	}
	length.push(rest);
	// literal length 15 sets token bits 0, 1, 4 and 5
	const head = [0, 0, 0, 0, 0x33, ...length];
	const out = new Uint8Array(head.length + clear.length);
	out.set(head);
	new DataView(out.buffer).setUint32(0, clear.length, true);
	out.set(clear, head.length);
	return out;
};

const heightPage = (fill: (i: number) => number): Uint8Array => {
	const payload = new Uint8Array(65 * 65 * 2);
	for (let i = 0; i < 65 * 65; i++) {
		payload[i * 2] = fill(i) & 0xff;
		payload[i * 2 + 1] = fill(i) >> 8;
	}
	return tret(65, 65, 1, TerrainFormat.R8G8_UNorm, payload);
};

const surface: TerrainSurfacesData = {
	position: { x: -2048, y: 10, z: -1024 },
	heightScale: 730,
	terrainSize: 4096,
};

describe('readTerrainTexture', () => {
	it('unpacks the envelope and reads a height page', () => {
		const texture = readTerrainTexture(envelope(heightPage((i) => i)));
		assert.equal(texture.format, TerrainFormat.R8G8_UNorm);
		assert.equal(texture.mips.length, 1);
		const samples = readTerrainHeightSamples(texture);
		assert.equal(samples[0], 0);
		assert.equal(samples[4224], 4224);
	});

	it('accepts files stored without the envelope', () => {
		const texture = readTerrainTexture(heightPage(() => 7));
		assert.equal(readTerrainHeightSamples(texture)[100], 7);
	});

	it('splits a block-compressed mip chain', () => {
		// 8×8 BC7: 4 blocks, then 1 block for each of 4×4, 2×2 and 1×1
		const payload = new Uint8Array(64 + 16 * 3).map((_, i) => i);
		const texture = parseTerrainTexture(tret(8, 8, 4, TerrainFormat.RGBA_BC7_SRGB, payload));
		assert.deepEqual(
			texture.mips.map((mip) => [mip.width, mip.height, mip.data.length, mip.data[0]]),
			[
				[8, 8, 64, 0],
				[4, 4, 16, 64],
				[2, 2, 16, 80],
				[1, 1, 16, 96],
			],
		);
	});

	it('rejects payloads that are not exactly the mip chain', () => {
		assert.throws(
			() => parseTerrainTexture(tret(8, 8, 1, TerrainFormat.RGBA_DXT5_UNorm, new Uint8Array(80))),
			FormatError,
		);
		assert.throws(
			() => parseTerrainTexture(tret(4, 4, 1, TerrainFormat.R8_UNorm, new Uint8Array(15))),
			FormatError,
		);
	});

	it('rejects unknown formats, versions and magics', () => {
		assert.throws(() => parseTerrainTexture(tret(4, 4, 1, 42, new Uint8Array(16))), /GraphicsFormat 42/);
		const badVersion = tret(4, 4, 1, TerrainFormat.R8_UNorm, new Uint8Array(16));
		badVersion[4] = 2;
		assert.throws(() => parseTerrainTexture(badVersion), /version 2/);
		assert.throws(() => parseTerrainTexture(new Uint8Array(24)), /not a TRET/);
	});

	it('rejects non-height pages as heights', () => {
		const texture = parseTerrainTexture(tret(4, 4, 1, TerrainFormat.R8G8_UNorm, new Uint8Array(32)));
		assert.throws(() => readTerrainHeightSamples(texture), FormatError);
	});
});

describe('readTerrainBc3Page', () => {
	const bytes = 33 * 33 * 16;

	it('returns the blocks of a 132² DXT5 page', () => {
		const payload = new Uint8Array(bytes).map((_, i) => i);
		const blocks = readTerrainBc3Page(
			parseTerrainTexture(tret(132, 132, 1, TerrainFormat.RGBA_DXT5_UNorm, payload)),
		);
		assert.equal(blocks.length, bytes);
		assert.equal(blocks[17], 17);
	});

	it('rejects other formats and sizes', () => {
		const tint = tret(132, 132, 1, TerrainFormat.RGBA_DXT5_SRGB, new Uint8Array(bytes));
		assert.throws(() => readTerrainBc3Page(parseTerrainTexture(tint)), FormatError);
		const small = tret(128, 128, 1, TerrainFormat.RGBA_DXT5_UNorm, new Uint8Array(32 * 32 * 16));
		assert.throws(() => readTerrainBc3Page(parseTerrainTexture(small)), FormatError);
	});
});

describe('terrainHeightsToWorld', () => {
	it('scales the 15-bit range and maps holes to NaN', () => {
		const world = terrainHeightsToWorld(
			Uint16Array.of(0, 16_384, 32_767, TERRAIN_HEIGHT_HOLE | 100),
			surface,
		);
		assert.equal(world[0], 10);
		assert.equal(world[1], 10 + 365);
		assert.ok(Math.abs(world[2] - (10 + (32_767 * 730) / 32_768)) < 1e-3);
		assert.ok(Number.isNaN(world[3]));
	});
});

describe('paths', () => {
	it('parses tiles and layers', () => {
		assert.deepEqual(parseTerrainPath('Data/Terrain/PC/map02/Terrain_6_10_3_H.bytes'), {
			kind: 'tile',
			scene: 'map02',
			level: 6,
			x: 10,
			z: 3,
			channel: 'H',
		});
		assert.deepEqual(parseTerrainPath('Data/Terrain/PC/map02/Layers/LAYER_C_12.bytes'), {
			kind: 'layer',
			scene: 'map02',
			role: 'C',
			index: 12,
		});
		assert.equal(parseTerrainPath('Data/Terrain/PC/map02/Terrain_6_10_3_X.bytes'), undefined);
	});
});

describe('placement', () => {
	it('places tiles by level', () => {
		assert.deepEqual(terrainTileFootprint(surface, { level: 6, x: 10, z: 0 }), {
			minX: -2048 + 640,
			minZ: -1024,
			size: 64,
		});
		assert.deepEqual(terrainTileFootprint(surface, { level: 2, x: 3, z: 1 }), {
			minX: 1024,
			minZ: 0,
			size: 1024,
		});
		assert.throws(() => terrainTileFootprint(surface, { level: 1, x: 2, z: 0 }), RangeError);
	});

	it('derives the leaf level from the terrain size', () => {
		assert.equal(terrainLeafLevel(4096), 6);
		assert.equal(terrainLeafLevel(2048), 5);
		assert.throws(() => terrainLeafLevel(3000), RangeError);
	});

	it('indexes nodes breadth-first, row-major within a level', () => {
		assert.equal(terrainNodeIndex({ level: 0, x: 0, z: 0 }), 0);
		assert.equal(terrainNodeIndex({ level: 1, x: 1, z: 1 }), 4);
		assert.equal(terrainNodeIndex({ level: 2, x: 1, z: 0 }), 6);
		assert.equal(terrainNodeIndex({ level: 2, x: 0, z: 1 }), 9);
		assert.equal(terrainNodeIndex({ level: 6, x: 63, z: 63 }), 5460);
	});
});

describe('readTerrainSurfacesData', () => {
	const node = {
		allHole: 0,
		nodeLevel: 2,
		parent: 1,
		localMinHeight: 0,
		localMaxHeight: 409,
		maxHeightError: 292,
	};

	it('reads position, scale, size and nodes', () => {
		const result = readTerrainSurfacesData({
			terrainPosition: { x: -2048, y: 0, z: -2048 },
			heightScale: 730,
			terrainSize: 4096,
			nodeData: { Array: [node] },
		});
		assert.deepEqual(result.position, { x: -2048, y: 0, z: -2048 });
		assert.equal(result.heightScale, 730);
		assert.equal(result.nodes?.[0].allHole, false);
		assert.equal(result.nodes?.[0].localMaxHeight, 409);
	});

	it('accepts unwrapped arrays and bigint integers', () => {
		const result = readTerrainSurfacesData({
			terrainPosition: { x: 0, y: 0, z: 0 },
			heightScale: 512,
			terrainSize: 2048n,
			nodeData: [node],
		});
		assert.equal(result.terrainSize, 2048);
		assert.equal(result.nodes?.length, 1);
	});

	it('rejects missing fields', () => {
		assert.throws(() => readTerrainSurfacesData({ heightScale: 1, terrainSize: 64 }), FormatError);
		assert.throws(
			() =>
				readTerrainSurfacesData({ terrainPosition: { x: 0, y: 0, z: 0 }, heightScale: '1', terrainSize: 64 }),
			FormatError,
		);
	});
});
