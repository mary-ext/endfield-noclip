import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TERRAIN_HOLE_BIT, TERRAIN_PAGE_SAMPLES } from '@endfield-noclip/package-format/terrain';
import { ContentKind, type ContentRef } from '@endfield-noclip/package-format/tree';

import { type GroundSource, type TreeFrame, groundHeight, sceneryTop } from './ground.ts';
import { levelCellIds, overviewPose } from './level-pose.ts';
import type { TileNode } from './tile-tree.ts';

const tree: TreeFrame = { origin: [0, 0], rootSize: 256, cellLevel: 1 };

const heights = (blob: number): ContentRef => ({
	kind: ContentKind.TerrainHeights,
	tier: 0,
	group: 0,
	blob,
	first: 0,
	count: 1,
	reach: null,
});

const node = (level: number, patch: Partial<TileNode>): TileNode => ({
	index: 0,
	level,
	x: 0,
	z: 0,
	minX: 0,
	minZ: 0,
	size: tree.rootSize / 2 ** level,
	bounds: { min: [0, 0, 0], max: [128, 40, 128] },
	geometricError: 0,
	quadrants: [null, null, null, null],
	terrain: null,
	surface: null,
	terrainSplat: null,
	hlod: [],
	detail: [],
	conditional: [],
	cellId: null,
	...patch,
});

/** a root height page (blob 1) and a cell (blob 2) over tile (1, 0, 0), each holding one height */
const source = (resident: ReadonlySet<number>, cellHeight: number): GroundSource => {
	const page = (height: number): Uint16Array => new Uint16Array(TERRAIN_PAGE_SAMPLES ** 2).fill(height);
	const pages = new Map([
		[1, page(100)],
		[2, page(cellHeight)],
	]);
	return {
		manifest: {
			tree,
			terrain: { baseHeight: -10, heightScale: TERRAIN_HOLE_BIT, levels: [0, 1], splat: null },
		},
		tree: {
			byId: new Map([
				['0_0_0', node(0, { terrain: heights(1) })],
				['1_0_0', node(1, { terrain: heights(2) })],
			]),
			terrainLeafLevel: 1,
			terrainRootLevel: 0,
		},
		heights: (blob) => (resident.has(blob) ? (pages.get(blob) ?? null) : null),
	};
};

describe('groundHeight', () => {
	it('reads the finest resident page', () => {
		assert.equal(groundHeight(source(new Set([1, 2]), 50), 10, 10), 40);
		assert.equal(groundHeight(source(new Set([1]), 50), 10, 10), 90);
	});

	it('is undefined while no covering page is resident, and null off the terrain or over a hole', () => {
		assert.equal(groundHeight(source(new Set(), 50), 10, 10), undefined);
		assert.equal(groundHeight(source(new Set([1, 2]), 50), 1000, 1000), null);
		assert.equal(groundHeight(source(new Set([2]), TERRAIN_HOLE_BIT), 10, 10), null);
	});
});

describe('sceneryTop', () => {
	it('is the top of the cell over the point', () => {
		assert.equal(sceneryTop(source(new Set(), 0), 10, 10), 40);
		assert.equal(sceneryTop(source(new Set(), 0), 200, 10), -Infinity);
	});
});

describe('level poses', () => {
	it('looks over the region from the south', () => {
		const pose = overviewPose({ tree, terrain: null });
		assert.deepEqual(pose.position, [128, 256 * 0.45, 128 - 256 * 0.85]);
		assert.equal(pose.yaw, 0);
	});

	it('names the cells of a level at the cell level', () => {
		const ids = levelCellIds(
			{ tree },
			{
				cells: [
					[1, 0],
					[0, 1],
				],
			},
		);
		assert.deepEqual([...ids], ['1_1_0', '1_0_1']);
	});
});
