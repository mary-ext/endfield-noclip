import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import {
	activationCondition,
	entityVisibilityTargets,
	linkScripts,
	toScript,
	type Script,
} from './script-drivers.ts';
import type { GameCondition } from './state/game-state.ts';

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
	const { drivers, rules } = await linkScripts([own, dungeon], {
		entities: new Set(['555']),
		ownLevels: new Set(['lv1']),
		placements: new Map(),
		missionsOf: new Map(),
		label: async (id) => ({ id, mission: 'Mission', name: 'Step two' }),
		levelNames: new Map([['dung', 'A Dungeon']]),
		actions: [],
	});
	assert.deepEqual(drivers.get('555'), [
		{ kind: 'quest', quests: [{ id: 'x1m1_q#2', mission: 'Mission', name: 'Step two' }], value: 1 },
		{ kind: 'script', position: [10, 0, 10], radius: 50, value: 1 },
		{ kind: 'switch', template: 'int_switch', position: [1, 2, 3], value: 0 },
		{ kind: 'level', levelId: 'dung', name: 'A Dungeon', value: 1 },
	]);
	// the activation path checks a quest state other than complete or in progress
	assert.equal(rules.size, 0);
});

test('derives what a group shows from the quest checks its scripts make when they run', async () => {
	const decoration = (ID: number, target: string, visible: boolean, nextID = -1) =>
		node('ShowSceneDecorationNew', {
			ID,
			nextID,
			targetDynamicEntity: constant(target),
			visible: constant(visible),
		});
	// getters wired to an input by `idRef`, as the game stores them
	const getterRef = (idRef: number): MemoryPackValue => ({
		constValue: true,
		idRef,
		paramSource: -1,
		path: null,
	});
	const complete = (ID: number, id: string, isQuest: boolean) =>
		node('CheckMissionOrQuestIsComplete', { ID, isQuest: constant(isQuest), missionId: constant(id) });
	const scripts = [
		// opens a gate on activation once a mission is complete: `validate` guards the header
		script('1', 'lv1', {
			headers: [node('ScriptEvent_OnScriptActive', { ID: 1, nextID: 2, validate: getterRef(9) })],
			actions: [decoration(2, 'open', true, 3), decoration(3, 'closed', false)],
			getters: [complete(9, 'm1', false)],
		}),
		// shows or hides props by a quest check
		script('2', 'lv1', {
			headers: [node('ScriptEvent_OnScriptActive', { ID: 1, nextID: 2, validate: constant(true) })],
			actions: [
				node('IfElseAction', { ID: 2, onTrueID: 3, onFalseID: 4, condition: getterRef(9) }),
				decoration(3, 'props', true),
				decoration(4, 'props', false),
			],
			getters: [complete(9, 'm2_q#1', true)],
		}),
		// shown or hidden past check nodes that stop the path unless their value is true or false
		script('4', 'lv1', {
			headers: [node('ScriptEvent_OnScriptActive', { ID: 1, nextID: 2 })],
			actions: [
				node('CheckBoolIfTrue', { ID: 2, nextID: 3, value: getterRef(9) }),
				decoration(3, 'checked', true, 4),
				node('CheckBoolIfFalse', { ID: 4, nextID: 5, value: getterRef(8) }),
				decoration(5, 'unchecked', false),
			],
			getters: [complete(9, 'm1', false), complete(8, 'm3', false)],
		}),
		// shown whenever the script runs, which the rule can't tell
		script('3', 'lv1', {
			headers: [node('ScriptEvent_OnScriptActive', { ID: 1, nextID: 2 })],
			actions: [decoration(2, 'event', true)],
		}),
	];
	const { drivers, rules } = await linkScripts(scripts, {
		entities: new Set(['open', 'closed', 'props', 'checked', 'unchecked', 'event']),
		ownLevels: new Set(['lv1']),
		placements: new Map(),
		missionsOf: new Map(),
		label: async (id) => ({ id, mission: null, name: null }),
		levelNames: new Map(),
		actions: [],
	});
	const m1 = { kind: 'mission', id: 'm1', compare: 0, target: 3 } as const;
	const q1 = { kind: 'quest', id: 'm2_q#1', compare: 0, target: 3 } as const;
	assert.deepEqual(Object.fromEntries(rules), {
		open: { show: [[m1]], hide: [] },
		closed: { show: [], hide: [[m1]] },
		props: { show: [[q1]], hide: [[{ ...q1, compare: 1 }]] },
		checked: { show: [[m1]], hide: [] },
		unchecked: { show: [], hide: [[m1, { kind: 'mission', id: 'm3', compare: 1, target: 3 }]] },
	});
	assert.deepEqual(drivers.get('props')?.[0], {
		kind: 'quest',
		quests: [{ id: 'm2_q#1', mission: null, name: null }],
		value: 1,
	});

	const any = (reverse: boolean, tests: GameCondition[]) => ({
		kind: 'any',
		reverse,
		conditions: [{ kind: 'all', reverse: false, conditions: tests }],
	});
	assert.deepEqual(activationCondition(rules.get('open')!, false), any(false, [m1]));
	assert.deepEqual(activationCondition(rules.get('closed')!, true), any(true, [m1]));
	assert.deepEqual(activationCondition(rules.get('props')!, false), any(false, [q1]));
	// nothing changes a flag no path moves away from
	assert.equal(activationCondition(rules.get('open')!, true), null);
	// a state that both shows and hides the group leaves it unsettled
	assert.equal(activationCondition({ show: [[m1]], hide: [[q1]] }, false), null);
});

test('finds groups one script sets only as the player crosses its trigger volumes', async () => {
	const decoration = (ID: number, target: string, visible: boolean, nextID = -1) =>
		node('ShowSceneDecorationNew', {
			ID,
			nextID,
			targetDynamicEntity: constant(target),
			visible: constant(visible),
		});
	const edge = (ID: number, enters: boolean, slot: number) =>
		node(`ScriptEvent_OnLeader${enters ? 'Enter' : 'Leave'}TriggerVolume`, {
			ID,
			nextID: ID + 1,
			validate: constant(true),
			triggerSlotIdFilter: constant(slot),
		});
	const sphere = (position: number[], radius: number) => ({
		position,
		radius,
		shapeType: 2,
		size: [3, 3, 3],
	});
	const volume = (shapes: MemoryPackValue[]) => ({ exitShapeStartIndex: -1, shapeList: shapes });
	const label = async (id: string) => ({ id, mission: null, name: null });
	const context = {
		ownLevels: new Set(['lv1']),
		placements: new Map(),
		missionsOf: new Map(),
		label,
		levelNames: new Map(),
		actions: [],
	};

	// as Jingyu Valley's tree cave: cover rocks hidden inside one volume, a group shown inside another
	const cave = script(
		'10100030016',
		'lv1',
		{
			headers: [edge(1, true, 80003), edge(3, false, 80003), edge(5, true, 80004), edge(7, false, 80004)],
			actions: [
				decoration(2, 'rocks', false),
				decoration(4, 'rocks', true),
				decoration(6, 'inner', true),
				decoration(8, 'inner', false),
			],
		},
		{
			triggerVolumes: [
				[80003, volume([sphere([-1072.7, 243, -1347.8], 92.4), sphere([-1082.6, 243, -1406.1], 77.8)])],
				[80004, volume([sphere([-923.6, 243, -1069.2], 120)])],
			],
		},
	);
	// a volume the script doesn't define isn't followed
	const once = script('2', 'lv1', {
		headers: [edge(1, true, 1)],
		actions: [decoration(2, 'once', true)],
	});
	const { volumes: caveVolumes } = await linkScripts([cave, once], {
		...context,
		entities: new Set(['rocks', 'inner', 'once']),
	});
	assert.deepEqual(Object.fromEntries(caveVolumes), {
		rocks: {
			script: '10100030016',
			triggers: [
				{
					shapes: [
						{ kind: 'sphere', center: [-1072.7, 243, -1347.8], radius: 92.4 },
						{ kind: 'sphere', center: [-1082.6, 243, -1406.1], radius: 77.8 },
					],
					enter: 0,
					leave: 1,
				},
			],
		},
		inner: {
			script: '10100030016',
			triggers: [
				{ shapes: [{ kind: 'sphere', center: [-923.6, 243, -1069.2], radius: 120 }], enter: 1, leave: 0 },
			],
		},
	});

	// as Snowy Forest's sky aurora: two polyline volumes, entering one shows the group and the other hides it
	const polyline = (position: number[], yaw: number, size: number[], points: number[][]) => ({
		position,
		rotation: [0, yaw, 0],
		shapeType: 3,
		size,
		polyLinePoints: points,
	});
	const square = [
		[-10, -10],
		[10, -10],
		[10, 10],
		[-10, 10],
	];
	const aurora = script(
		'36100010049',
		'lv1',
		{
			headers: [edge(1, true, 80001), edge(3, true, 80002)],
			actions: [decoration(2, 'aurora', true), decoration(4, 'aurora', false)],
		},
		{
			triggerVolumes: [
				[80001, volume([polyline([100, 50, 0], 90, [20, 40, 20], square)])],
				[80002, volume([polyline([0, 50, 0], 0, [20, 40, 20], square)])],
			],
		},
	);
	const { volumes: skyVolumes } = await linkScripts([aurora], { ...context, entities: new Set(['aurora']) });
	const rule = skyVolumes.get('aurora');
	assert.equal(rule?.script, '36100010049');
	assert.deepEqual(
		rule?.triggers.map(({ enter, leave }) => [enter, leave]),
		[
			[1, null],
			[0, null],
		],
	);
	const turned = rule?.triggers[0].shapes[0];
	assert.equal(turned?.kind, 'prism');
	if (turned?.kind === 'prism') {
		// Unity's yaw of 90° takes local +x to world −z and local +z to world +x
		assert.deepEqual(
			turned.points[1].map((v) => Math.round(v)),
			[90, -10],
		);
		assert.deepEqual(
			turned.points[2].map((v) => Math.round(v)),
			[110, -10],
		);
		assert.equal(turned.bottom, 30);
		assert.equal(turned.top, 70);
	}
});

test('follows entity show and hide actions on interactives, counting targets computed at runtime', async () => {
	const pointer = (logicId: string): MemoryPackValue => ({ logicId, slotId: 0, useSlotId: false });
	const own = script('300', 'lv1', {
		headers: [node('LevelEvent_OnQuestStateChanged', { ID: 1, nextID: 2, questId: constant('q1') })],
		actions: [
			node('EntityHide', { ID: 2, nextID: 3, entityPtr: constant(pointer('777')) }),
			node('EntityShowList', { ID: 3, nextID: 4, entityListPtr: constant([pointer('778')]) }),
			node('SetEntitiesVisibility', {
				ID: 4,
				nextID: 5,
				isVisible: constant(false),
				targetEntities: constant([pointer('779'), { logicId: '0', slotId: 3, useSlotId: true }]),
			}),
			node('EntityShow', { ID: 5, nextID: 6, entityPtr: { idRef: 9, paramSource: 3, path: null } }),
			node('WaterVolumeInfiniteSetHeight', { ID: 6, nextID: -1 }),
		],
	});
	assert.deepEqual([...entityVisibilityTargets([own], new Set(['lv1']))], ['777', '778', '779']);
	const { drivers, untraced } = await linkScripts([own], {
		entities: new Set(['777', '778', '779']),
		ownLevels: new Set(['lv1']),
		placements: new Map(),
		missionsOf: new Map(),
		label: async (id) => ({ id, mission: null, name: null }),
		levelNames: new Map(),
		actions: [{ script: '300', node: 6, target: 'water' }],
	});
	const quest = (value: number | null) => [
		{ kind: 'quest', quests: [{ id: 'q1', mission: null, name: null }], value },
	];
	assert.deepEqual(drivers.get('777'), quest(0));
	assert.deepEqual(drivers.get('778'), quest(1));
	assert.deepEqual(drivers.get('779'), quest(0));
	// another action's drivers, whose value the caller sets
	assert.deepEqual(drivers.get('water'), quest(null));
	// the slot pointer and the getter
	assert.equal(untraced, 2);
});
