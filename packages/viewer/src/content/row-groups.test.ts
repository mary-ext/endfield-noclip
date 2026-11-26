import assert from 'node:assert/strict';
import { it } from 'node:test';

import { CULL_FLOATS, ROW_WORDS } from './instance-rows.ts';
import {
	GROUP_FLOATS,
	GROUP_ROWS,
	GroupFloat,
	SEGMENT_FLOATS,
	SegmentFloat,
	buildRowBounds,
	chainReach,
	groupSegmentsOf,
	mirroredRows,
	setGroupReaches,
} from './row-groups.ts';

/** rows at the given bounds centres, each with a bounding radius and LODGroup size */
const rowsAt = (centers: [number, number, number][], radius: number, size: number) => {
	const rowsF32 = new Float32Array(centers.length * ROW_WORDS);
	const cull = new Float32Array(centers.length * CULL_FLOATS);
	centers.forEach(([x, y, z], i) => {
		rowsF32.set([x, y, z], i * ROW_WORDS + 12);
		cull[i * CULL_FLOATS] = radius;
		cull[i * CULL_FLOATS + 1] = size;
	});
	return { rowsF32, cull };
};

it('bounds each group of rows and its farthest LOD', () => {
	const centers = Array.from({ length: GROUP_ROWS + 2 }, (_, i): [number, number, number] => [i, 0, 0]);
	const { rowsF32, cull } = rowsAt(centers, 1, 2);
	// chain 0 covers the first group, chain 1 (never culled by size) the two rows of the second
	const runs = new Uint32Array([0, 0, GROUP_ROWS, 1, GROUP_ROWS, 2]);
	const bounds = buildRowBounds({ rowsF32, cull, runs, spins: null, rides: null });
	const groups = bounds.groups;
	// until the chains' slots are known, no group is out of reach
	assert.equal(groups[GroupFloat.reach], Infinity);
	setGroupReaches(bounds, runs, (chain) =>
		chain === 0 ? chainReach(0.01, false) : chainReach(-0.0001, false),
	);
	assert.equal(groups.length, 2 * GROUP_FLOATS);
	const half = (GROUP_ROWS - 1) / 2;
	assert.equal(groups[GroupFloat.center], half);
	assert.ok(Math.abs(groups[GroupFloat.centersRadius] - half) < 0.02);
	assert.ok(Math.abs(groups[GroupFloat.radius] - (half + 1)) < 0.02);
	assert.equal(groups[GroupFloat.rowRadius], 1);
	// 2 / √0.01 per metre of size, times the size 2
	assert.ok(Math.abs(groups[GroupFloat.reach] - 40) < 1e-4);
	assert.equal(groups[GROUP_FLOATS + GroupFloat.reach], Infinity);
});

it('sweeps spinning and riding rows into finite group and segment bounds', () => {
	const { rowsF32, cull } = rowsAt(
		[
			[0, 0, 0],
			[4, 0, 0],
		],
		1,
		1,
	);
	// row 0 spins about (0, 0, 0) with base centre (3, 0, 0) → sweep radius 3 around (0, 0, 0)
	const spinBase = new Float32Array(15);
	spinBase.set([3, 0, 0], 12);
	const spins = {
		rows: new Uint32Array([0]),
		values: new Float32Array([0, 0, 0, 0, 1, 0, 1]),
		base: spinBase,
		runs: new Uint32Array([0, 1]),
	};
	// row 1 rides along x ∈ [0, 6] from base centre (4, 0, 0) → sweep radius 3 around (7, 0, 0)
	const rides = {
		rows: new Uint32Array([1]),
		pathOf: new Uint32Array([0]),
		base: new Float32Array([4, 0, 0, 4, 0, 0]),
		runs: new Uint32Array([1, 2]),
		paths: [{ frameRate: 30, offsets: new Float32Array([0, 0, 0, 6, 0, 0]) }],
	};
	const bounds = buildRowBounds({ rowsF32, cull, runs: new Uint32Array([0, 0, 2]), spins, rides });
	const groups = bounds.groups;
	// swept x ranges: [-3, 3] and [4, 10] → group midpoint 3.5, centres radius 3.5 + 3 = 6.5, radius 7.5
	assert.ok(Number.isFinite(groups[GroupFloat.radius]));
	assert.ok(Math.abs(groups[GroupFloat.center] - 3.5) < 1e-4);
	assert.ok(Math.abs(groups[GroupFloat.centersRadius] - 6.5) < 0.02);
	assert.ok(Math.abs(groups[GroupFloat.radius] - 7.5) < 0.02);
});

it('gives chains without drawn slots no reach, and distance-measured chains every reach', () => {
	assert.equal(chainReach(null, false), 0);
	assert.equal(chainReach(0.01, true), Infinity);
});

it('marks the rows whose transform flips handedness', () => {
	const rowsF32 = new Float32Array(2 * ROW_WORDS);
	// identity, then a mirror across x
	rowsF32.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], 0);
	rowsF32.set([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], ROW_WORDS);
	assert.deepEqual([...mirroredRows(rowsF32, 2)], [0, 1]);
});

it('splits each group by chain run, keeping the sizes, handedness and bounds of each segment', () => {
	const centers = Array.from({ length: GROUP_ROWS + 4 }, (_, i): [number, number, number] => [i, 0, 0]);
	const { rowsF32, cull } = rowsAt(centers, 1, 2);
	cull[3 * CULL_FLOATS + 1] = 5;
	// chain 0 ends inside the first group; chain 1 crosses into the second
	const runs = new Uint32Array([0, 0, 4, 1, 4, GROUP_ROWS]);
	const mirrored = new Uint8Array(centers.length);
	mirrored[GROUP_ROWS + 1] = 1;
	const { segments, groupSegments } = groupSegmentsOf(rowsF32, runs, cull, mirrored);
	assert.deepEqual([...groupSegments], [0, 2, 3]);
	const segment = (s: number, field: number): number => segments[s * SEGMENT_FLOATS + field];
	assert.deepEqual(
		[segment(0, SegmentFloat.first), segment(0, SegmentFloat.end), segment(0, SegmentFloat.run)],
		[0, 4, 0],
	);
	assert.deepEqual([segment(0, SegmentFloat.minSize), segment(0, SegmentFloat.maxSize)], [2, 5]);
	assert.equal(segment(0, SegmentFloat.center), 1.5);
	assert.ok(Math.abs(segment(0, SegmentFloat.radius) - 2.5) < 0.02);
	assert.deepEqual([segment(1, SegmentFloat.first), segment(1, SegmentFloat.end)], [4, GROUP_ROWS]);
	assert.equal(segment(1, SegmentFloat.handedness), 1);
	// the second group: chain 1's last rows, one of them mirrored
	assert.deepEqual(
		[segment(2, SegmentFloat.first), segment(2, SegmentFloat.end), segment(2, SegmentFloat.run)],
		[GROUP_ROWS, GROUP_ROWS + 4, 1],
	);
	assert.equal(segment(2, SegmentFloat.handedness), 3);
});
