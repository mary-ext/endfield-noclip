import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MissionRuntime } from '@endfield-noclip/formats/endfield/mission-runtime';
import type { MissionInfo } from '@endfield-noclip/package-format/states';

import type { WorldIndex } from '../world/world-index.ts';

import { sceneControl, type DraftControl } from './scene-control.ts';
import { labelStory, mainStoryOrder, stripMarkup } from './story.ts';

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
	levels: ['map01_lv002'],
	charId: null,
	mainPath: ['x1m8_q#2', 'x1m8_q#3'],
	quests: [
		{
			id: 'x1m8_q#2',
			objectiveKey: null,
			descriptionKey: 'x1m8_desc_002',
			hidden: false,
			previous: [],
			fluidChecks: [],
		},
		{
			id: 'x1m8_q#3',
			objectiveKey: 'objective_x1m8_3_001',
			descriptionKey: null,
			hidden: false,
			previous: ['x1m8_q#2'],
			fluidChecks: [],
		},
		// a branch off the main flow, after step 1
		{
			id: 'x1m8_q#Deco_fleet',
			objectiveKey: null,
			descriptionKey: null,
			hidden: true,
			previous: ['x1m8_q#2'],
			fluidChecks: [],
		},
	],
};

const control = (kind: 'quest' | 'mission', id: string): DraftControl =>
	sceneControl({ kind, id: `${kind}:${id}`, name: id, values: [], default: 3, assumption: 'story finished' });

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
			levelId: 'map01_lv002',
		},
	]);
	assert.deepEqual(
		controls.map((entry) => [entry.name, entry.story?.step ?? null]),
		[
			['Climb to the top floor', 2],
			['The gate is open.', 1],
			['hidden step Deco_fleet', 1.5],
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

test('orders main story missions by episode, mission and decimal, leaving out ids outside the scheme', () => {
	const mission = (id: string, category: MissionInfo['category'] = 'main'): MissionInfo => ({
		id,
		name: null,
		category,
		chapter: null,
		episode: null,
		levelId: null,
	});
	const missions = ['e1m10', 'e1m9d10', 'e1m9d5', 'e0m2', 'e1m9', 'c13m1'].map((id) => mission(id));
	assert.deepEqual(mainStoryOrder([...missions, mission('e2m1', 'side')]), [
		'e0m2',
		'e1m9',
		'e1m9d5',
		'e1m9d10',
		'e1m10',
	]);
});
