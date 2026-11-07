import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import { jumpPadArrow, verticalPadEffect } from './jump-pads.ts';
import { verticalRopeFloats } from './rest-looks.ts';
import { startState, stateOf } from './template-data.ts';
import { readTemplateTraits } from './template-traits.ts';

const property = (key: string, bits: string): MemoryPackValue => ({
	key,
	value: { type: 3, valueArray: [{ valueBit64: bits, valueString: null }] },
});

const commonPerform = { $type: 'Beyond_Gameplay_Core_InteractiveCommonPerformComponentDataForMemoryPack' };

// the jump pad (int_jumpmachine): saved `state` 1, so it starts on; its variants leave `state` alone
const jumpPad: MemoryPackValue = {
	componentList: [commonPerform],
	saveProperties: [property('is_locked', '0'), property('state', '1')],
	configProperties: [],
	tempProperties: [],
	templateVariant: [
		['int_jumpmachine_free', { diffProperties: [property('free_jump', '1')] }],
		['int_jumpmachine_off', { diffProperties: [property('state', '0')] }],
	],
};

test('a template starts in its saved state, and a variant in its own', () => {
	assert.deepEqual(startState(jumpPad), { state: 1, variants: new Map([['int_jumpmachine_off', 0]]) });
});

test('a template without a common-perform component passes no state on', () => {
	assert.equal(startState({ componentList: [], saveProperties: [property('state', '1')] }), null);
});

test('a template without a state property starts at 0', () => {
	assert.deepEqual(startState({ componentList: [commonPerform] }), { state: 0, variants: new Map() });
});

const row = (own: bigint | null, params: [number, string, bigint][]): LevelInteractive => ({
	id: 1n,
	template: 'int_jumpmachine',
	createState: 0,
	position: [0, 0, 0],
	rotation: [0, 0, 0],
	scale: [1, 1, 1],
	modelScale: 0,
	isLocked: false,
	properties: own === null ? [] : [{ key: 'state', type: 3, values: [{ bits: own, text: null }] }],
	componentProperties: new Map(
		params.map(([type, key, bits]) => [type, [{ key, type: 3, values: [{ bits, text: null }] }]]),
	),
});

test("a placement's own state property overrides, then a state parameter on any component", () => {
	assert.equal(stateOf(row(0n, [[173, 'state', 1n]])), 0);
	assert.equal(stateOf(row(null, [[173, 'state', 1n]])), 1);
	assert.equal(stateOf(row(null, [[50, 'guide_trigger_by_state', 1n]])), null);
	assert.equal(stateOf(row(null, [[169, 'state', 0xffffffffn]])), -1);
});

const text = (key: string, value: string): MemoryPackValue => ({
	key,
	value: { type: 7, valueArray: [{ valueBit64: '0', valueString: value }] },
});

// the jump pad: its component's arrow effect, and its entity's target position of (-8.3, 0.6, -0.07). the free
// variant sets `free_jump` on both, but only the component's counts
const padTemplate: MemoryPackValue = {
	componentList: [
		{
			$type: 'Beyond_Gameplay_Core_JumpMachineComponentDataForMemoryPack',
			propertyList: [text('effect', 'P_common_bouncingplatform_arrow_01'), property('free_jump', '0')],
		},
	],
	saveProperties: [property('is_locked', '0'), property('state', '1')],
	configProperties: [
		property('free_jump', '0'),
		{
			key: 'target_position',
			value: {
				type: 11,
				valueArray: ['-1056587121', '1057400816', '-1111993876'].map((valueBit64) => ({
					valueBit64,
					valueString: null,
				})),
			},
		},
	],
	templateVariant: [
		[
			'int_jumpmachine_free',
			{
				componentDiffProperties: [['Comp_JumpMachine', { value: [property('free_jump', '1')] }]],
				diffProperties: [property('free_jump', '1')],
			},
		],
	],
};

test('an unlocked jump pad turns its arrow towards its target position', () => {
	const pad = { ...row(null, []), position: [-8.3, 0, 10] as [number, number, number] };
	const arrow = jumpPadArrow(padTemplate, pad);
	assert.equal(arrow?.effect, 'P_common_bouncingplatform_arrow_01');
	// about straight down -z
	assert.ok(arrow !== null && Math.abs(Math.abs(arrow.yaw) - 180) < 2, `yaw ${arrow?.yaw}`);
});

test('a free jump pad, or one whose state is off, places no arrow', () => {
	assert.equal(jumpPadArrow(padTemplate, { ...row(null, []), template: 'int_jumpmachine_free' }), null);
	assert.equal(jumpPadArrow(padTemplate, row(0n, [])), null);
});

test('the is_locked property alone leaves a jump pad that is on with its arrow', () => {
	const pad = row(null, []);
	pad.properties = [{ key: 'is_locked', type: 1, values: [{ bits: 1n, text: null }] }];
	assert.notEqual(jumpPadArrow(padTemplate, pad), null);
});

test("a free pad placement that turns its component's free jump off places an arrow", () => {
	const pad = { ...row(null, [[169, 'free_jump', 0n]]), template: 'int_jumpmachine_free' };
	assert.equal(jumpPadArrow(padTemplate, pad)?.effect, 'P_common_bouncingplatform_arrow_01');
});

const port = (id: bigint, y: number, target: bigint | null): LevelInteractive => ({
	...row(null, []),
	id,
	template: 'int_rope_port_top_right',
	position: [88.2, y, 101.7],
	properties: target === null ? [] : [{ key: 'target', type: 13, values: [{ bits: target, text: null }] }],
});

test("a vertical rope's length is the height to the port its target names", () => {
	// indie_race001's lift near 88, 116–123, 102
	const top = port(12800020498n, 122.7, 12800020500n);
	const bottom = port(12800020500n, 115.7, null);
	const rows = new Map([top, bottom].map((entry) => [entry.id, entry]));
	const [[key, height]] = verticalRopeFloats(top, rows);
	assert.equal(key, 'RopeLength');
	assert.ok(Math.abs(height - 7) < 1e-9);
	assert.deepEqual(verticalRopeFloats(bottom, rows), new Map());
	assert.deepEqual(verticalRopeFloats(port(1n, 0, 1n), rows), new Map());
});

// the vertical jump pad (int_jumpmachine_vertical): saved `state` 0; map01_lv006's pads set 1
const verticalPad: MemoryPackValue = {
	componentList: [
		commonPerform,
		{ $type: 'Beyond_Gameplay_Core_JumpMachineVerticalComponentDataForMemoryPack' },
	],
	saveProperties: [property('state', '0')],
	configProperties: [],
	tempProperties: [],
	templateVariant: [],
};

test('a vertical jump pad plays its vent effect only while its state is on', () => {
	const pad = { ...row(1n, []), template: 'int_jumpmachine_vertical' };
	assert.equal(verticalPadEffect(verticalPad, pad), 'P_interactive_cavewell+1_001_01_loop');
	assert.equal(verticalPadEffect(verticalPad, { ...pad, properties: [] }), null);
});

const telescopicLogic = {
	$type: 'Beyond_Gameplay_Core_InteractiveLogicControllerComponentDataForMemoryPack',
	logicType: 8,
};

test('a door component wins over a telescopic bridge logic, which needs a piece count', () => {
	const door = { $type: 'Beyond_Gameplay_Core_InteractiveDoorCommonComponentDataForMemoryPack' };
	assert.deepEqual(readTemplateTraits({ componentList: [telescopicLogic, door] }, 'bridge'), {
		kind: 'door',
	});
	assert.deepEqual(
		readTemplateTraits(
			{ componentList: [telescopicLogic], configProperties: [property('pieces', '4')] },
			'bridge',
		),
		{ kind: 'telescopic', pieces: 4 },
	);
	assert.deepEqual(readTemplateTraits({ componentList: [telescopicLogic], configProperties: [] }, 'bridge'), {
		failure: 'bridge is a telescopic bridge without a valid pieces count',
	});
});
