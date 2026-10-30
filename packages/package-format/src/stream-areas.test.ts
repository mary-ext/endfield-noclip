import assert from 'node:assert/strict';
import { it } from 'node:test';

import { conditionVisible } from './conditions.ts';
import {
	areasShownIn,
	streamAreaControl,
	streamAreaValues,
	type StreamAreasInfo,
	triggerContains,
	zonesAround,
	zonesAt,
} from './stream-areas.ts';

const info: StreamAreasInfo = {
	areas: [7, 8],
	rootVisible: [0, 8],
	shownInside: [{ zone: 9, areas: [0, 7] }],
	triggers: [
		{
			zone: 9,
			min: [0, 0],
			max: [10, 10],
			minHeight: 0,
			maxHeight: 5,
			// an L shape, so the box alone would accept (8, 8)
			polygon: [
				[0, 0],
				[10, 0],
				[10, 5],
				[5, 5],
				[5, 10],
				[0, 10],
			],
		},
	],
};

it('switches from the root set to the zone list inside a trigger', () => {
	assert.deepEqual([...areasShownIn(info, zonesAt(info, [2, 1, 2]))], [0, 7]);
	assert.deepEqual([...areasShownIn(info, zonesAt(info, [20, 1, 2]))], [0, 8]);
	// inside the box but outside the ring, and above the height range
	assert.equal(triggerContains(info.triggers[0], [8, 1, 8]), false);
	assert.equal(triggerContains(info.triggers[0], [2, 6, 2]), false);
	// above the trigger only its footprint holds the point
	assert.deepEqual([...zonesAt(info, [2, 6, 2])], []);
	assert.deepEqual([...zonesAround(info, [2, 6, 2])], [9]);
	assert.deepEqual([...zonesAround(info, [8, 6, 8])], []);
});

it('gives every required area a value that gates its content', () => {
	const inside = streamAreaValues(info, areasShownIn(info, zonesAt(info, [2, 1, 2])));
	assert.deepEqual(inside, { 'area:7': 1, 'area:8': 0 });
	const content = { alternatives: [[{ control: streamAreaControl(8), mask: 2 }]] };
	assert.equal(conditionVisible(content, inside), false);
	assert.equal(conditionVisible(content, streamAreaValues(info, null)), true);
});
