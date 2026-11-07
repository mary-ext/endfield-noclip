import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import { type Script, toScript } from '../script-drivers.ts';

import { decorationAnimatorStarts } from './decoration-animators.ts';

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
const saved = (property: string): MemoryPackValue => ({
	constValue: true,
	idRef: -1,
	paramSource: 300,
	path: property,
});

const script = (id: string, actions: MemoryPackValue[], headers: MemoryPackValue[]): Script => {
	const result = toScript(id, 'lv1', {
		$type: 'Beyond_Gameplay_LevelScriptDataForMemoryPack',
		actionMap: { dataMap: { actionList: actions, headerList: headers, getterList: [] } },
	});
	assert.ok(result);
	return result;
};

const setInt = (ID: number, target: bigint, value: number): MemoryPackValue =>
	node('SetDecorationAnimatorInt', {
		ID,
		nextID: -1,
		animatorParamName: constant('state'),
		targetDynamicEntity: constant(target),
		targetValue: constant(value),
	});

test('reads the Animator values a script sets on its groups as it starts, split on saved properties', () => {
	// the shape of map01_lv006's crane script: on start, a split into one if/else per crane on a saved property
	const cranes = script(
		'3500030021',
		[
			node('Split', { ID: 68, nextID: -1, idList: [84, 90] }),
			node('IfElseAction', { ID: 84, nextID: 87, condition: saved('state_1'), onTrueID: 85, onFalseID: 86 }),
			setInt(85, 3500030000n, 3),
			setInt(86, 3500030000n, 1),
			node('IfElseAction', { ID: 87, nextID: -1, condition: saved('state_2'), onTrueID: 88, onFalseID: 89 }),
			setInt(88, 3500030001n, 4),
			setInt(89, 3500030001n, 2),
			setInt(90, 3500030002n, 5),
			// a quest event plays the open animation; it isn't a start value
			setInt(11, 3500030003n, 7),
		],
		[
			node('ScriptEvent_OnScriptActive', { ID: 67, nextID: 68, validate: constant(true) }),
			node('ScriptEvent_OnCustomEvent', { ID: 10, nextID: 11 }),
		],
	);
	const { starts, untraced } = decorationAnimatorStarts({
		scripts: [cranes],
		ownLevels: new Set(['lv1']),
		undecoded: 0,
	});
	assert.equal(untraced, 0);
	assert.deepEqual(starts.get('3500030000'), {
		script: '3500030021',
		fixed: new Map(),
		saved: { property: 'state_1', unset: new Map([['state', 1]]), set: new Map([['state', 3]]) },
	});
	assert.deepEqual(starts.get('3500030001')?.saved?.property, 'state_2');
	assert.deepEqual(starts.get('3500030002'), {
		script: '3500030021',
		fixed: new Map([['state', 5]]),
		saved: null,
	});
	assert.equal(starts.has('3500030003'), false);
});

test('leaves a group as saved when its start path branches some other way', () => {
	const other = script(
		'1',
		[
			node('IfElseAction', {
				ID: 2,
				nextID: -1,
				condition: { constValue: false, idRef: -1, paramSource: 3, path: '$50@_result' },
				onTrueID: 3,
				onFalseID: -1,
			}),
			setInt(3, 9n, 1),
		],
		[node('ScriptEvent_OnScriptActive', { ID: 1, nextID: 2 })],
	);
	const { starts, untraced } = decorationAnimatorStarts({
		scripts: [other],
		ownLevels: new Set(['lv1']),
		undecoded: 0,
	});
	assert.equal(starts.size, 0);
	assert.equal(untraced, 1);
});
