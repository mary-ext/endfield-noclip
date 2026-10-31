import assert from 'node:assert/strict';
import { it } from 'node:test';

import type { SceneControl } from './states.ts';
import { storyOrder, storyPointPicks, storyPoints } from './story.ts';

const control = (
	kind: 'quest' | 'mission',
	id: string,
	mission: string,
	step: number | null,
): SceneControl => ({
	kind,
	id: `${kind}:${id}`,
	name: id,
	rule: null,
	assumption: '',
	story: { mission, step },
	levelTags: [0],
	values: [],
	default: 3,
	derived: null,
});

const CONTROLS = [
	control('mission', 'e1m1', 'e1m1', null),
	control('quest', 'e1m1_q#2', 'e1m1', 2),
	control('quest', 'e1m1_q#5', 'e1m1', 5),
	control('quest', 'e1m1_q#side', 'e1m1', 5.5),
	control('quest', 'e1m2_q#1', 'e1m2', 1),
	control('quest', 'e1m2_q#x', 'e1m2', null),
];
const MISSIONS = ['e1m1', 'e1m2'];

it('a story point completes what came before it and leaves what follows unstarted', () => {
	assert.deepEqual(storyPointPicks(CONTROLS, MISSIONS, { mission: 0, step: 5 }), {
		'mission:e1m1': 2,
		'quest:e1m1_q#2': 3,
		'quest:e1m1_q#5': 2,
		'quest:e1m1_q#side': 0,
		'quest:e1m2_q#1': 0,
		'quest:e1m2_q#x': 0,
	});
	assert.deepEqual(storyPointPicks(CONTROLS, MISSIONS, { mission: 1, step: 0 }), {
		'mission:e1m1': 3,
		'quest:e1m1_q#2': 3,
		'quest:e1m1_q#5': 3,
		'quest:e1m1_q#side': 3,
		'quest:e1m2_q#1': 0,
	});
	// the finished story is the default, so its picks are dropped
	assert.deepEqual(
		Object.values(storyPointPicks(CONTROLS, MISSIONS, null)).every((value) => value === null),
		true,
	);
});

it('lists a point per mission start and per step a quest control sits at', () => {
	assert.deepEqual(
		storyPoints(CONTROLS, MISSIONS).map(({ point, quest }) => [point, quest?.id ?? null]),
		[
			[{ mission: 0, step: 0 }, null],
			[{ mission: 0, step: 2 }, 'quest:e1m1_q#2'],
			[{ mission: 0, step: 5 }, 'quest:e1m1_q#5'],
			[{ mission: 0, step: 5.5 }, 'quest:e1m1_q#side'],
			[{ mission: 1, step: 0 }, null],
			[{ mission: 1, step: 1 }, 'quest:e1m2_q#1'],
			[null, null],
		],
	);
});

it('orders main story missions by episode, mission and decimal', () => {
	const ids = ['e1m10', 'e1m9d5', 'e0m2', 'e1m9', 'c13m1'];
	assert.deepEqual(ids.map(storyOrder), [[1, 10], [1, 9.5], [0, 2], [1, 9], null]);
});
