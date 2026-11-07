import assert from 'node:assert/strict';
import { it } from 'node:test';

import { conditionResults, conditionVisible, groupsShown, resolveSceneValues } from './conditions.ts';
import type { ConditionalSetInfo, SceneControl, StatesInfo } from './states.ts';

const control = (
	fields: Pick<SceneControl, 'kind' | 'id' | 'default'> & Partial<SceneControl> & { derived?: number },
): SceneControl => {
	const { derived, ...rest } = fields;
	return {
		name: fields.id,
		category: 0,
		assumption: '',
		levels: [0],
		values: [
			{ value: 0, label: 'off' },
			{ value: 1, label: 'on' },
		],
		source: derived === undefined ? { kind: 'user' } : { kind: 'derived', condition: derived, rule: [] },
		story: null,
		drivers: [],
		place: null,
		...rest,
	};
};

it('selects mutually exclusive upgrades while preserving shared and script-gated resources', () => {
	const FACILITY = 0;
	const COURSE = 1;
	const states: StatesInfo = {
		controls: [
			control({
				kind: 'poi',
				id: 'poi:facility',
				default: 0,
				values: [0, 2, 31].map((value) => ({ value, label: `Level ${value}` })),
			}),
			control({ kind: 'script', id: 'script:course', default: 0 }),
		],
		conditionalSets: [],
		groups: [],
		streamAreas: null,
		categories: [],
		missions: [],
		mainStory: [],
	};
	const initial = resolveSceneValues(states, new Map());
	const before = { alternatives: [[{ control: FACILITY, mask: 1 }]] };
	const after = { alternatives: [[{ control: FACILITY, mask: 4 }]] };
	const gated: ConditionalSetInfo = {
		alternatives: [
			[
				{ control: FACILITY, mask: 4 },
				{ control: COURSE, mask: 2 },
			],
		],
	};
	assert.equal(conditionVisible(before, initial), true);
	assert.equal(conditionVisible(after, initial), false);
	const upgraded = resolveSceneValues(states, new Map([[FACILITY, 2]]));
	assert.equal(conditionVisible(before, upgraded), false);
	assert.equal(conditionVisible(after, upgraded), true);
	assert.equal(conditionVisible(gated, upgraded), false);
	assert.equal(conditionVisible(gated, upgraded.with(COURSE, 1)), true);
	assert.equal(
		conditionVisible({ alternatives: [...before.alternatives, ...after.alternatives] }, upgraded),
		true,
	);
	assert.equal(conditionVisible<number>({ alternatives: [[]] }, []), true);
	assert.equal(conditionVisible<number>({ alternatives: [] }, initial), false);
	assert.equal(conditionVisible(before, []), false);
	assert.equal(conditionVisible(before, [32]), false);
	assert.equal(conditionVisible({ alternatives: [[{ control: FACILITY, mask: 0x80000000 }]] }, [31]), true);
	assert.deepEqual(initial, [0, 0]);
});

it('derives scene states from the quests they follow, unless the user overrides them', () => {
	const QUEST = 0;
	const STATE_0 = 1;
	// quest states: 2 processing, 3 completed
	const quest = control({
		kind: 'quest',
		id: 'quest:q',
		default: 3,
		values: [0, 1, 2, 3, 4, 5].map((value) => ({ value, label: String(value) })),
	});
	const states: StatesInfo = {
		controls: [
			quest,
			control({ kind: 'sceneState', id: 'sceneState:0', default: 1, derived: 0 }),
			control({ kind: 'sceneState', id: 'sceneState:1', default: 0, derived: 1 }),
			// derived from another derived control listed before it
			control({ kind: 'sceneState', id: 'sceneState:2', default: 0, derived: 2 }),
		],
		conditionalSets: [
			{ alternatives: [[{ control: QUEST, mask: 1 << 3 }]] },
			{ alternatives: [[{ control: QUEST, mask: 0b110111 }]] },
			{ alternatives: [[{ control: 2, mask: 2 }]] },
		],
		groups: [],
		streamAreas: null,
		categories: [],
		missions: [],
		mainStory: [],
	};
	assert.deepEqual(resolveSceneValues(states, new Map()), [3, 1, 0, 0]);
	// the two states never hold together while they follow the quest
	assert.deepEqual(resolveSceneValues(states, new Map([[QUEST, 2]])), [2, 0, 1, 1]);
	assert.equal(resolveSceneValues(states, new Map([[STATE_0, 0]]))[STATE_0], 0);
});

it('shows a group of any level when its condition holds', () => {
	const states: StatesInfo = {
		controls: [],
		conditionalSets: [
			{ alternatives: [[{ control: 0, mask: 2 }]] },
			{ alternatives: [[{ control: 1, mask: 2 }]] },
		],
		groups: [
			{ level: null, condition: null },
			{ level: 0, condition: null },
			{ level: 1, condition: null },
			{ level: 0, condition: 0 },
			{ level: null, condition: 1 },
		],
		streamAreas: null,
		categories: [],
		missions: [],
		mainStory: [],
	};
	const conditions = conditionResults(states, [1, 0]);
	assert.deepEqual(conditions, [true, false]);
	assert.deepEqual(groupsShown(states, conditions), [true, true, true, true, false]);
});
