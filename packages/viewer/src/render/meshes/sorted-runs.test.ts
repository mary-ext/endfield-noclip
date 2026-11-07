import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeFarToNear, sortBand } from './sorted-runs.ts';

/** the merge's runs as `[source, first, count]` tuples */
const merged = (sources: { distances: number[]; bands?: number[]; count?: number }[]): number[][] => {
	const runs: number[] = [];
	mergeFarToNear(
		sources.map(({ distances, bands, count }) => ({
			bands: bands ?? distances.map(() => 0),
			distances,
			count: count ?? distances.length,
		})),
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

test('lower sorting bands draw first, whatever their distance', () => {
	// the blue talosite's parts share a centre: its dark backing card (order −4) goes behind the shards (0)
	const backing = sortBand(0, -4);
	assert.deepEqual(
		merged([
			{ distances: [17.01], bands: [0] },
			{ distances: [17], bands: [backing] },
			{ distances: [500, 16], bands: [backing, 0] },
		]),
		[
			[2, 0, 1],
			[1, 0, 1],
			[0, 0, 1],
			[2, 1, 1],
		],
	);
	assert.ok(sortBand(-1, 100) < sortBand(0, -100));
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
