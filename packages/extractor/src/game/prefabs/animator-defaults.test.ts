import assert from 'node:assert/strict';
import { test } from 'node:test';

import { animatorParameterId, settledStateClips } from './animator-defaults.ts';

const node = (clip: number) => ({ data: { m_ClipID: clip, m_ChildIndices: [] } });

/** a transition to `destination` when every condition (`[mode, parameter name]`) holds */
const transition = (destination: number, conditions: [number, string][]) => ({
	data: {
		m_DestinationState: destination,
		m_ConditionConstantArray: conditions.map(([mode, name]) => ({
			data: { m_ConditionMode: mode, m_EventID: animatorParameterId(name), m_EventThreshold: 0 },
		})),
	},
});

const state = (
	nodes: ReturnType<typeof node>[],
	{ speed = 1, transitions = [] }: { speed?: number; transitions?: ReturnType<typeof transition>[] } = {},
) => ({
	data: {
		m_TransitionConstantArray: transitions,
		m_BlendTreeConstantIndexArray: [0],
		m_BlendTreeConstantArray: [{ data: { m_NodeArray: nodes } }],
		m_Speed: speed,
		m_Loop: true,
	},
});

const layer = (machine: number, weight: number, blending = 0) => ({
	data: {
		m_StateMachineIndex: machine,
		m_DefaultWeight: weight,
		'(int&)m_LayerBlendingMode': blending,
	},
});

const machine = (
	states: ReturnType<typeof state>[],
	{
		defaultState = 0,
		anyState = [],
	}: { defaultState?: number; anyState?: ReturnType<typeof transition>[] } = {},
) => ({
	data: {
		m_StateConstantArray: states,
		m_AnyStateTransitionConstantArray: anyState,
		m_DefaultState: defaultState,
	},
});

/** a controller's parameters: bools with their defaults, and triggers */
const parameters = (bools: [string, boolean][], triggers: string[] = []) => ({
	m_Values: {
		data: {
			m_ValueArray: [
				...bools.map(([name], i) => ({ m_ID: animatorParameterId(name), m_Type: 4, m_Index: i })),
				...triggers.map((name) => ({ m_ID: animatorParameterId(name), m_Type: 9, m_Index: 0 })),
			],
		},
	},
	m_DefaultValues: { data: { m_BoolValues: bools.map(([, value]) => value) } },
});

// Wuling City's spinning cube (AC_anm_map02_machine+1_002_01): one layer whose only state, idle_loop, plays
// clip 0. its base layer saves weight 0, which Unity ignores
const cube = {
	m_Controller: {
		...parameters([]),
		m_LayerArray: [layer(0, 0)],
		m_StateMachineArray: [machine([state([node(0)])])],
	},
};

test("a controller's base layer plays its default state's clip whatever its saved weight", () => {
	assert.deepEqual(settledStateClips(cube, new Map()), [{ layer: 0, clip: 0, speed: 1 }]);
});

test('only full-weight override layers and single-clip forward states show', () => {
	const controller = {
		m_Controller: {
			...parameters([]),
			m_LayerArray: [layer(0, 0), layer(1, 0), layer(1, 1, 1), layer(1, 0.5), layer(2, 1), layer(3, 1)],
			m_StateMachineArray: [
				machine([state([node(0)], { speed: 0 }), state([node(1)], { speed: 2 })], { defaultState: 1 }),
				machine([state([node(2)])]),
				// a blend tree of two clips
				machine([state([node(3), node(4)])]),
				// a state without a clip
				machine([state([node(0xffff_ffff)])]),
			],
		},
	};
	assert.deepEqual(settledStateClips(controller, new Map()), [{ layer: 0, clip: 1, speed: 2 }]);
});

// The Hub's comm terminal (int_001_comm_terminal_controller): the base layer starts on error_idle (clip 0)
// and moves to normal_idle (1) while `fixed` holds, or to the seamless pair (2, 3) while `seamless` does.
// layer 1 plays a one-shot transition only when `switchState` fires, which never holds at rest
const terminal = {
	m_Controller: {
		...parameters(
			[
				['fixed', false],
				['seamless', true],
			],
			['switchState'],
		),
		m_LayerArray: [layer(0, 0), layer(1, 1)],
		m_StateMachineArray: [
			machine([
				state([node(0)], {
					transitions: [transition(3, [[1, 'seamless']]), transition(1, [[1, 'fixed']])],
				}),
				state([node(1)], { transitions: [transition(0, [[2, 'fixed']])] }),
				state([node(2)], { transitions: [transition(3, [[2, 'fixed']])] }),
				state([node(3)], {
					transitions: [transition(0, [[2, 'seamless']]), transition(2, [[1, 'fixed']])],
				}),
			]),
			machine([
				state([node(0xffff_ffff)], {
					speed: 0,
					transitions: [
						transition(1, [
							[1, 'fixed'],
							[1, 'switchState'],
						]),
					],
				}),
				state([node(5)], { transitions: [transition(0, [])] }),
			]),
		],
	},
};

test('a layer follows the transitions its parameters satisfy, never on a trigger', () => {
	const seamless = animatorParameterId('seamless');
	const fixed = animatorParameterId('fixed');
	// the controller's own defaults: seamless, broken
	assert.deepEqual(settledStateClips(terminal, new Map()), [{ layer: 0, clip: 3, speed: 1 }]);
	// as the template sets it on load: not seamless, broken or fixed
	assert.deepEqual(settledStateClips(terminal, new Map([[seamless, false]])), [
		{ layer: 0, clip: 0, speed: 1 },
	]);
	assert.deepEqual(
		settledStateClips(
			terminal,
			new Map([
				[seamless, false],
				[fixed, true],
			]),
		),
		[{ layer: 0, clip: 1, speed: 1 }],
	);
});
