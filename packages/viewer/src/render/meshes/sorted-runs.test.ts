import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeFarToNear } from './sorted-runs.ts';

/** the merge's runs as `[source, first, count]` tuples */
const merged = (sources: { distances: number[]; count?: number }[]): number[][] => {
	const runs: number[] = [];
	mergeFarToNear(
		sources.map(({ distances, count }) => ({ distances, count: count ?? distances.length })),
		runs,
	);
	const out: number[][] = [];
	for (let i = 0; i < runs.length; i += 3) {
		out.push(runs.slice(i, i + 3));
	}
	return out;
};

test('interleaves draws far to near, keeping neighbouring instances of one draw together', () => {
	// the deck case: a plume 2 km out, glass 10 m away, a hologram 5 m away
	assert.deepEqual(merged([{ distances: [10] }, { distances: [2100, 2000] }, { distances: [5] }]), [
		[1, 0, 2],
		[0, 0, 1],
		[2, 0, 1],
	]);
	assert.deepEqual(merged([{ distances: [50, 30, 10] }, { distances: [40, 20] }]), [
		[0, 0, 1],
		[1, 0, 1],
		[0, 1, 1],
		[1, 1, 1],
		[0, 2, 1],
	]);
});

test('ties go to the earlier draw, and only the listed count draws', () => {
	assert.deepEqual(merged([{ distances: [10, 10] }, { distances: [10] }]), [
		[0, 0, 2],
		[1, 0, 1],
	]);
	assert.deepEqual(merged([{ distances: [30, 20, 10], count: 2 }, { distances: [] }, { distances: [25] }]), [
		[0, 0, 1],
		[2, 0, 1],
		[0, 1, 1],
	]);
});
