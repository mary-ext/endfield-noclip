import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	restingEffects,
	restingLengths,
	settledPath,
	testedValues,
	type ViewStateRecord,
} from './view-state-poses.ts';

const effect = (
	effectId: string,
	flags: { persistent?: boolean; active?: boolean; fireAndForget?: boolean; node?: string } = {},
): ViewStateRecord => ({
	$type: 'Beyond_Gameplay_Core_ModelViewStateController_MVSCEffectBehaviorDataForMemoryPack',
	effectId,
	effectNodeName: flags.node ?? '',
	isPersistence: flags.persistent ?? false,
	active: flags.active ?? false,
	fireAndForget: flags.fireAndForget ?? false,
	followRot: true,
	dontFollowTrans: false,
});

const state = (stateName: string, behaviors: ViewStateRecord[], to: string | null): ViewStateRecord => ({
	stateName,
	behaviors,
	transitions: to === null ? [] : [{ targetStateName: to, conditionGroup: { conditions: [], logic: 0 } }],
});

test("the jump pad's effect layer rests in On, which keeps its glow playing", () => {
	// int_jumpmachine's EffectLayer: Off → On while `state` is 1
	const layer = {
		layerName: 'EffectLayer',
		stateDatas: [
			{
				...state('Off', [], null),
				isStartingNode: true,
				transitions: [
					{
						targetStateName: 'On',
						conditionGroup: {
							conditions: [
								{
									key: 'state',
									comparison: 0,
									isInvert: false,
									conditionValue: { type: 2, conditionValue: { intValue: 1 } },
								},
							],
						},
					},
				],
			},
			state('On', [effect('P_common_bouncingplatform_01')], null),
		],
	};
	const path = settledPath(layer, new Map([['state', 1]]));
	assert.deepEqual(
		path.map((entry) => entry.stateName),
		['Off', 'On'],
	);
	assert.deepEqual(restingEffects('P_interactive_zmdspring+1_001', path), [
		{
			effect: 'P_common_bouncingplatform_01',
			node: null,
			fallback: 'P_interactive_zmdspring+1_001',
			followRotation: true,
		},
	]);
	assert.deepEqual(restingEffects(null, settledPath(layer, new Map())), []);
});

test('a persistent effect stays on until a later state switches it off; others end with their state', () => {
	const path = [
		state('a', [effect('burst'), effect('kept', { persistent: true, active: true })], 'b'),
		state('b', [effect('glow', { persistent: true, active: true, node: 'Point' })], 'c'),
		state(
			'c',
			[
				effect('glow', { persistent: true, active: false, node: 'Point' }),
				effect('spark', { fireAndForget: true }),
			],
			null,
		),
	];
	assert.deepEqual(
		restingEffects(null, path).map((rest) => rest.effect),
		['kept'],
	);
});

const length = (
	nodeName: string,
	fields: { key?: string; val?: number; deviation: number },
): ViewStateRecord => ({
	$type: 'Beyond_Gameplay_Core_ModelViewStateController_MVSCEffectLengthBehaviorDataForMemoryPack',
	nodeName,
	dependBlackBoard: fields.key !== undefined,
	dependFloatKey: fields.key ?? '',
	val: fields.val ?? 0,
	deviation: fields.deviation,
});

test("the rope lift's length outlasts set_rope, from RopeLength plus its deviation", () => {
	// int_rope_port_topright_postmodel: start → set_rope → on_idle while `state` > 0
	const rope = 'P_iprop_com_rope+1_001_02';
	const path = [
		state('start', [], 'set_rope'),
		state('set_rope', [length(rope, { key: 'RopeLength', deviation: 1.4 })], 'on_idle'),
		state('on_idle', [], null),
	];
	assert.deepEqual([...restingLengths(path, new Map([['RopeLength', 7]]))], [[rope, 8.4]]);
	// without the float, nothing is set
	assert.deepEqual([...restingLengths(path, new Map())], []);
	// a constant length is its value plus the deviation
	assert.deepEqual(
		[...restingLengths([state('s', [length(rope, { val: 2, deviation: 0.5 })], null)], new Map())],
		[[rope, 2.5]],
	);
});

test('the values a state machine tests on an int key are listed once, ascending', () => {
	const condition = (key: string, type: number, value: number): ViewStateRecord => ({
		key,
		comparison: 0,
		conditionValue: { type, conditionValue: { intValue: value, floatValue: value } },
	});
	const go = (...conditions: ViewStateRecord[]): ViewStateRecord => ({
		targetStateName: 'x',
		conditionGroup: { conditions },
	});
	// a Wuling bridge's off and on, a float on another key, and an extra test of 1
	const states = {
		model: 'int_bridge_wuling_12m_postmodel',
		path: 'test',
		data: {
			modelAnimatorDatas: [
				{
					layerFsmDatas: [
						{
							stateDatas: [
								{ stateName: 'off', transitions: [go(condition('state', 2, 1))] },
								{
									stateName: 'on',
									transitions: [go(condition('state', 2, 0)), go(condition('speed', 1, 3))],
								},
								{ stateName: 'again', transitions: [go(condition('state', 2, 1))] },
							],
						},
					],
				},
			],
		},
	};
	assert.deepEqual(testedValues(states, 'state'), [0, 1]);
	assert.deepEqual(testedValues(states, 'speed'), []);
});
