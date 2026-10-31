import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MissionRuntime } from '@endfield-noclip/formats/endfield/mission-runtime';
import type { SceneControl } from '@endfield-noclip/package-format/states';

import { labelStory, stripMarkup } from './story.ts';
import type { WorldIndex } from './world-index.ts';

// invented text, standing in for the install's
const TEXT = new Map([
	['x1m8_name', 'Tower Test'],
	['objective_x1m8_3_001', 'Climb to the <@qu.key>top floor</>'],
	['x1m8_desc_002', 'The gate is open.'],
	['chapter1_num', 'Part A'],
	['chapter1_name', 'Sample Chapter'],
]);

const MISSION: MissionRuntime = {
	id: 'x1m8',
	nameKey: 'x1m8_name',
	type: 0,
	chapters: 1,
	levelId: 'map01_lv002',
	mainPath: ['x1m8_q#2', 'x1m8_q#3'],
	quests: [
		{ id: 'x1m8_q#2', objectiveKey: null, descriptionKey: 'x1m8_desc_002', hidden: false },
		{ id: 'x1m8_q#3', objectiveKey: 'objective_x1m8_3_001', descriptionKey: null, hidden: false },
		{ id: 'x1m8_q#Deco_fleet', objectiveKey: null, descriptionKey: null, hidden: true },
	],
};

const control = (kind: 'quest' | 'mission', id: string): SceneControl => ({
	kind,
	id: `${kind}:${id}`,
	name: id,
	rule: null,
	assumption: 'story finished',
	story: null,
	levelTags: [],
	values: [],
	default: 3,
	derived: null,
});

test('quests take their objective text, step and mission; unknown missions keep their ids', async () => {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only text and missions are read
	const world = {
		text: async () => (key: string) => TEXT.get(key),
		mission: async (id: string) => (id === 'x1m8' ? MISSION : undefined),
	} as unknown as WorldIndex;
	const controls = [
		control('quest', 'x1m8_q#3'),
		control('quest', 'x1m8_q#2'),
		control('quest', 'x1m8_q#Deco_fleet'),
		control('mission', 'x1m8'),
		control('quest', 'x9m1_q#1'),
		control('mission', 'x9m1'),
	];
	const missions = await labelStory(world, controls);
	assert.deepEqual(missions, [
		{
			id: 'x1m8',
			name: 'Tower Test',
			category: 'main',
			chapter: 'Part A · Sample Chapter',
			episode: null,
		},
	]);
	assert.deepEqual(
		controls.map(({ name, story }) => [name, story?.step ?? null]),
		[
			['Climb to the top floor', 2],
			['The gate is open.', 1],
			['hidden step Deco_fleet', null],
			['Tower Test', null],
			['x9m1_q#1', null],
			['x9m1', null],
		],
	);
	assert.equal(controls[4].story, null);
});

test('rich-text tags are stripped from labels', () => {
	assert.equal(stripMarkup(' Use the <@gd.key>blue lever</> now '), 'Use the blue lever now');
});
