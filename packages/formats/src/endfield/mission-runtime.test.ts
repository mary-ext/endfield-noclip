import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { parseMissionRuntime } from './mission-runtime.ts';

const quest = (fields: Record<string, unknown>) => ({
	questType: 0,
	showMode: 1,
	objectiveList: [{ description: { key: 'objective_x1m1_1_001' } }],
	overrideMissionDesc: false,
	descriptionOverride: {},
	prevQuestIdList: [],
	...fields,
});

test('reads a mission name, its main flow and per-quest text keys', () => {
	const mission = parseMissionRuntime(
		`﻿${JSON.stringify({
			missionId: 'x1m1',
			missionName: { key: 'x1m1_name' },
			missionType: 0,
			missionChapterBitmask: 1,
			levelId: 'map01_lv002',
			questDic: {
				'x1m1_q#1': quest({}),
				'x1m1_q#2': quest({
					overrideMissionDesc: true,
					descriptionOverride: { key: 'x1m1_desc_002' },
					prevQuestIdList: ['x1m1_q#1'],
				}),
				'x1m1_q#Deco': quest({ showMode: 1000, objectiveList: [], prevQuestIdList: ['x1m1_q#1'] }),
			},
			mainPathQuests: ['x1m1_q#1', 'x1m1_q#2'],
		})}`,
	);
	assert.deepEqual(mission, {
		id: 'x1m1',
		nameKey: 'x1m1_name',
		type: 0,
		chapters: 1,
		levelId: 'map01_lv002',
		mainPath: ['x1m1_q#1', 'x1m1_q#2'],
		quests: [
			{
				id: 'x1m1_q#1',
				objectiveKey: 'objective_x1m1_1_001',
				descriptionKey: null,
				hidden: false,
				previous: [],
			},
			{
				id: 'x1m1_q#2',
				objectiveKey: 'objective_x1m1_1_001',
				descriptionKey: 'x1m1_desc_002',
				hidden: false,
				previous: ['x1m1_q#1'],
			},
			{ id: 'x1m1_q#Deco', objectiveKey: null, descriptionKey: null, hidden: true, previous: ['x1m1_q#1'] },
		],
	});
});

test('internal missions have no name; malformed ones throw', () => {
	const base = {
		missionId: 'hidden1',
		missionName: {},
		missionType: 4,
		missionChapterBitmask: 0,
		questDic: {},
	};
	assert.equal(parseMissionRuntime(JSON.stringify({ ...base, mainPathQuests: [] })).nameKey, null);
	assert.throws(() => parseMissionRuntime(JSON.stringify(base)), FormatError);
	assert.throws(
		() => parseMissionRuntime(JSON.stringify({ ...base, missionType: '0', mainPathQuests: [] })),
		FormatError,
	);
});
