import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import { linkScripts, toScript, type Script } from './script-drivers.ts';

const node = (type: string, fields: Record<string, MemoryPackValue>): MemoryPackValue => ({
	$type: `Beyond_Gameplay_Actions_${type}ForMemoryPack`,
	...fields,
});
const constant = (value: MemoryPackValue): MemoryPackValue => ({
	constValue: value,
	idRef: -1,
	paramSource: 0,
	path: null,
});

const script = (
	id: string,
	level: string,
	lists: { actions: MemoryPackValue[]; headers: MemoryPackValue[]; getters?: MemoryPackValue[] },
	data: Record<string, MemoryPackValue> = {},
): Script => {
	const decoded = {
		$type: 'Beyond_Gameplay_LevelScriptDataForMemoryPack',
		...data,
		actionMap: {
			dataMap: { actionList: lists.actions, headerList: lists.headers, getterList: lists.getters ?? [] },
		},
	};
	const result = toScript(id, level, decoded);
	assert.ok(result);
	return result;
};

test('follows show and hide actions back to quests, switches, the script area and other levels', async () => {
	const show = (ID: number, visible: boolean) =>
		node('ShowSceneDecorationNew', {
			ID,
			nextID: -1,
			targetDynamicEntity: constant('555'),
			visible: constant(visible),
		});
	const own = script(
		'100',
		'lv1',
		{
			headers: [
				node('ScriptEvent_OnScriptActive', { ID: 1, nextID: 2 }),
				node('EntityEvent_OnInteractiveStateChanged', {
					ID: 10,
					nextID: 11,
					targetEntity: constant({ useSlotId: true, logicId: '0', slotId: 40001 }),
				}),
			],
			actions: [
				// shown on activation only while a quest check passes
				node('IfElseAction', {
					ID: 2,
					onTrueID: 3,
					onFalseID: -1,
					condition: { constValue: false, idRef: -1, paramSource: 3, path: '$50@_result' },
				}),
				show(3, true),
				show(11, false),
			],
			getters: [node('CheckQuestState', { ID: 50, questId: constant('x1m1_q#2') })],
		},
		{
			interactives: [[40001, { entityDataIdKey: 'int_switch', position: [1, 2, 3] }]],
			startShapeList: [{ offset: [10, 0, 10], radius: 50 }],
		},
	);
	const dungeon = script('200', 'dung', {
		headers: [node('ScriptEvent_OnScriptActive', { ID: 1, nextID: 2 })],
		actions: [show(2, true)],
	});
	const drivers = await linkScripts([own, dungeon], {
		entities: new Set(['555']),
		ownLevels: new Set(['lv1']),
		placements: new Map(),
		missionsOf: new Map(),
		label: async (id) => ({ id, mission: 'Mission', name: 'Step two' }),
		levelNames: new Map([['dung', 'A Dungeon']]),
	});
	assert.deepEqual(drivers.get('555'), [
		{ kind: 'quest', quests: [{ id: 'x1m1_q#2', mission: 'Mission', name: 'Step two' }], shows: true },
		{ kind: 'script', position: [10, 0, 10], radius: 50, shows: true },
		{ kind: 'switch', template: 'int_switch', position: [1, 2, 3], shows: false },
		{ kind: 'level', levelId: 'dung', name: 'A Dungeon', shows: true },
	]);
});
