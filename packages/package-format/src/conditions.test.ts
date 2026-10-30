import assert from 'node:assert/strict';
import { it } from 'node:test';

import { conditionResults, conditionVisible, defaultSceneValues, groupsShown } from './conditions.ts';
import type { ConditionalSetInfo, StatesInfo } from './states.ts';

it('selects mutually exclusive upgrades while preserving shared and script-gated resources', () => {
	const states: StatesInfo = {
		progressions: [
			{
				id: 'poi:facility',
				kind: 'poi',
				key: 'facility',
				levelId: null,
				levels: [0, 2, 31],
				defaultLevel: 0,
			},
		],
		toggles: [
			{
				id: 'script:course',
				name: 'course',
				kind: 'script',
				levelTags: [1],
				defaultEnabled: false,
				condition: null,
			},
		],
		conditionalSets: [],
		groups: [],
	};
	const initial = defaultSceneValues(states);
	const before = { alternatives: [[{ control: 'poi:facility', mask: 1 }]] };
	const after = { alternatives: [[{ control: 'poi:facility', mask: 4 }]] };
	const gated: ConditionalSetInfo = {
		alternatives: [
			[
				{ control: 'poi:facility', mask: 4 },
				{ control: 'script:course', mask: 2 },
			],
		],
	};
	assert.equal(conditionVisible(before, initial), true);
	assert.equal(conditionVisible(after, initial), false);
	const upgraded = { ...initial, 'poi:facility': 2 };
	assert.equal(conditionVisible(before, upgraded), false);
	assert.equal(conditionVisible(after, upgraded), true);
	assert.equal(conditionVisible(gated, upgraded), false);
	assert.equal(conditionVisible(gated, { ...upgraded, 'script:course': 1 }), true);
	assert.equal(
		conditionVisible({ alternatives: [...before.alternatives, ...after.alternatives] }, upgraded),
		true,
	);
	assert.equal(conditionVisible({ alternatives: [[]] }, {}), true);
	assert.equal(conditionVisible({ alternatives: [] }, initial), false);
	assert.equal(conditionVisible(before, {}), false);
	assert.equal(conditionVisible(before, { 'poi:facility': 32 }), false);
	assert.equal(
		conditionVisible(
			{ alternatives: [[{ control: 'poi:facility', mask: 0x80000000 }]] },
			{ 'poi:facility': 31 },
		),
		true,
	);
	assert.deepEqual(initial, { 'poi:facility': 0, 'script:course': 0 });
});

it('shows a group when the level owns it or every level does, and its condition holds', () => {
	const states: StatesInfo = {
		progressions: [],
		toggles: [],
		conditionalSets: [
			{ alternatives: [[{ control: 'sceneState:0', mask: 2 }]] },
			{ alternatives: [[{ control: 'sceneState:1', mask: 2 }]] },
		],
		groups: [
			{ levelTag: 0, condition: null },
			{ levelTag: 1, condition: null },
			{ levelTag: 2, condition: null },
			{ levelTag: 1, condition: 0 },
			{ levelTag: 0, condition: 1 },
		],
	};
	const conditions = conditionResults(states, { 'sceneState:0': 1, 'sceneState:1': 0 });
	assert.deepEqual(conditions, [true, false]);
	assert.deepEqual(groupsShown(states, 1, conditions), [true, true, false, true, false]);
	assert.deepEqual(groupsShown(states, 2, conditions), [true, false, true, false, false]);
	assert.deepEqual(groupsShown(states, null, conditions), [true, true, true, true, false]);
});
