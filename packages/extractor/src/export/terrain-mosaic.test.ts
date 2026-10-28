import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TERRAIN_HEIGHT_HOLE } from '@endfield-noclip/formats/hg/terrain';

import { buildHeightMosaic, coveredCells, type HeightTile } from './terrain-mosaic.ts';

const tile = (level: number, x: number, z: number, fill: (i: number, j: number) => number): HeightTile => {
	const samples = new Uint16Array(65 * 65);
	for (let j = 0; j < 65; j++) {
		for (let i = 0; i < 65; i++) {
			samples[j * 65 + i] = fill(i, j);
		}
	}
	return { level, x, z, samples };
};

describe('coveredCells', () => {
	it('expands coarse tiles to leaf cells', () => {
		assert.deepEqual(
			coveredCells(
				[
					{ level: 1, x: 1, z: 0 },
					{ level: 2, x: 0, z: 3 },
				],
				2,
			),
			{
				minX: 0,
				minZ: 0,
				maxX: 4,
				maxZ: 4,
			},
		);
		assert.equal(coveredCells([], 2), undefined);
	});
});

describe('buildHeightMosaic', () => {
	it('places leaf tiles by x along rows and z down columns', () => {
		const tiles = [tile(1, 0, 0, () => 1), tile(1, 1, 0, () => 2), tile(1, 0, 1, () => 3)];
		const mosaic = buildHeightMosaic(tiles, 1, { minX: 0, minZ: 0, maxX: 2, maxZ: 2 });
		assert.equal(mosaic.width, 129);
		assert.equal(mosaic.height, 129);
		assert.equal(mosaic.samples[10 * 129 + 10], 1);
		assert.equal(mosaic.samples[10 * 129 + 100], 2);
		assert.equal(mosaic.samples[100 * 129 + 10], 3);
		assert.equal(mosaic.samples[100 * 129 + 100], TERRAIN_HEIGHT_HOLE);
		assert.deepEqual([...mosaic.sourceLevels], [1, 1, 1, -1]);
	});

	it('upsamples the finest covering ancestor', () => {
		// a parent ramp along x: sample i = 100 i
		const parent = tile(0, 0, 0, (i) => 100 * i);
		const mosaic = buildHeightMosaic([parent, tile(1, 0, 0, () => 5)], 1, {
			minX: 0,
			minZ: 0,
			maxX: 2,
			maxZ: 1,
		});
		assert.deepEqual([...mosaic.sourceLevels], [1, 0]);
		// the right cell maps parent u ∈ [32, 64]; mosaic column 64 + k is parent u = 32 + k/2
		assert.equal(mosaic.samples[64 + 1], 3250);
		assert.equal(mosaic.samples[128], 6400);
		// the left cell came from the leaf
		assert.equal(mosaic.samples[1], 5);
	});

	it('takes the nearest sample next to holes', () => {
		const parent = tile(0, 0, 0, (i) => (i === 33 ? TERRAIN_HEIGHT_HOLE | 7 : 100));
		const mosaic = buildHeightMosaic([parent], 1, { minX: 1, minZ: 0, maxX: 2, maxZ: 1 });
		// u = 32.5 rounds to the hole at 33
		assert.equal(mosaic.samples[1], TERRAIN_HEIGHT_HOLE | 7);
		assert.equal(mosaic.samples[0], 100);
	});
});
