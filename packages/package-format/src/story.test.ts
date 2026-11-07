import assert from 'node:assert/strict';
import { it } from 'node:test';

import type { SceneControl } from './states.ts';
import { storyPointPicks, storyPoints } from './story.ts';

/** the fixture's missions, by index: e1m1 and e1m2 */
const E1M1 = 0;
const E1M2 = 1;

const control = (
	kind: 'quest' | 'mission',
	id: string,
	mission: number,
	step: number | null,
): SceneControl => ({
	id: `${kind}:${id}`,
	kind,
	name: id,
	category: 0,
	values: [],
	default: 3,
	assumption: '',
	source: { kind: 'user' },
	levels: [0],
	story: { role: kind, mission, step },
	drivers: [],
	place: null,
});

const CONTROLS = [
	control('mission', 'e1m1', E1M1, null),
	control('quest', 'e1m1_q#2', E1M1, 2),
	control('quest', 'e1m1_q#5', E1M1, 5),
	control('quest', 'e1m1_q#side', E1M1, 5.5),
	control('quest', 'e1m2_q#1', E1M2, 1),
	control('quest', 'e1m2_q#x', E1M2, null),
];
const MISSIONS = [E1M1, E1M2];

it('a story point completes what came before it and leaves what follows unstarted', () => {
	assert.deepEqual(
		storyPointPicks(CONTROLS, MISSIONS, { mission: 0, step: 5 }),
		new Map([
			[0, 2],
			[1, 3],
			[2, 2],
			[3, 0],
			[4, 0],
			[5, 0],
		]),
	);
	assert.deepEqual(
		storyPointPicks(CONTROLS, MISSIONS, { mission: 1, step: 0 }),
		new Map([
			[0, 3],
			[1, 3],
			[2, 3],
			[3, 3],
			[4, 0],
		]),
	);
	// the finished story is the default, so its picks are dropped
	assert.equal(
		storyPointPicks(CONTROLS, MISSIONS, null)
			.values()
			.every((value) => value === null),
		true,
	);
});

it('lists a point per mission start and per step quest controls sit at, once per step', () => {
	const controls = [...CONTROLS, control('quest', 'e1m1_q#side2', E1M1, 5.5)];
	assert.deepEqual(
		storyPoints(controls, MISSIONS).map(({ point, mission, quests }) => [
			point,
			mission,
			quests.map(({ id }) => id),
		]),
		[
			[{ mission: 0, step: 0 }, E1M1, []],
			[{ mission: 0, step: 2 }, E1M1, ['quest:e1m1_q#2']],
			[{ mission: 0, step: 5 }, E1M1, ['quest:e1m1_q#5']],
			[{ mission: 0, step: 5.5 }, E1M1, ['quest:e1m1_q#side', 'quest:e1m1_q#side2']],
			[{ mission: 1, step: 0 }, E1M2, []],
			[{ mission: 1, step: 1 }, E1M2, ['quest:e1m2_q#1']],
			[null, null, []],
		],
	);
});
