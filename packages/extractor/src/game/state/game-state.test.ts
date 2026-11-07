import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DynamicGate } from '@endfield-noclip/formats/endfield/dynamic-scene';
import { conditionVisible, ruleText } from '@endfield-noclip/package-format/conditions';

import { allOf, GameState, gateCondition, type GameCondition } from './game-state.ts';

const quest = (compare: 0 | 1, target: number): GameCondition => ({
	kind: 'quest',
	id: 'e1m8_q#3',
	compare,
	target,
});

test('conditions on one quest read one control, so they never both hold', () => {
	const game = new GameState();
	const done = game.requirements(quest(0, 3));
	const notDone = game.requirements(quest(1, 3));
	assert.deepEqual(done, [[{ control: 'quest:e1m8_q#3', mask: 1 << 3 }]]);
	assert.deepEqual(notDone, [[{ control: 'quest:e1m8_q#3', mask: 0b110101 }]]);
	for (const value of [0, 2, 3, 4, 5]) {
		const values = { 'quest:e1m8_q#3': value };
		assert.notEqual(
			conditionVisible({ alternatives: done }, values),
			conditionVisible({ alternatives: notDone }, values),
		);
	}
	assert.deepEqual(
		game.controls().map(({ id, default: value, values }) => [id, value, values.map(({ label }) => label)]),
		[['quest:e1m8_q#3', 3, ['none', 'processing', 'completed', 'failed', 'disabled']]],
	);
	assert.equal(game.evaluate(quest(0, 3)), true);
});

test('a reversed combination negates through its children', () => {
	const game = new GameState();
	// the landslide shows while its quest is completed and the dig isn't; reversed, it shows otherwise
	const landslide: DynamicGate = {
		kind: 'mission',
		all: true,
		loadWhen: false,
		conditions: [
			{ id: 'showLandslide', isQuest: true, state: 3, same: true },
			{ id: 'finishDigWork', isQuest: true, state: 3, same: false },
		],
	};
	const condition = gateCondition(landslide);
	const rule = game.describe(condition);
	assert.equal(ruleText(rule), 'not (quest showLandslide = completed and quest finishDigWork ≠ completed)');
	assert.deepEqual(rule[1], { control: 'quest:showLandslide', text: 'quest showLandslide' });
	assert.deepEqual(game.requirements(condition), [
		[{ control: 'quest:showLandslide', mask: 0b110101 }],
		[{ control: 'quest:finishDigWork', mask: 1 << 3 }],
	]);
	// both completed: the dig is done, so the reversed gate holds
	assert.equal(game.evaluate(condition), true);
});

test('a variable takes one value per range between the targets the scene compares it against', () => {
	const game = new GameState();
	const gate = (compare: number, value: number): GameCondition =>
		gateCondition({ kind: 'mapVar', key: 19, compare, value, mapId: 2 });
	const conditions = [gate(1, 2), gate(0, 0), gate(3, 5)];
	game.note(conditions);
	const [notCleansed] = conditions.map((condition) => game.requirements(condition));
	const [control] = game.controls();
	assert.deepEqual(
		control.values.map(({ label }) => label),
		['unset', '< 0', '= 0', '0 < … < 2', '= 2', '2 < … < 5', '= 5', '> 5'],
	);
	assert.equal(control.id, 'mapVar:2:#19');
	assert.equal(control.values[control.default].label, '= 5');
	// a load gate fails while the variable is unset, whatever it compares
	assert.deepEqual(notCleansed, [[{ control: 'mapVar:2:#19', mask: 0b11101110 }]]);
	assert.throws(() => game.note([gate(0, 7)]), /noted after its values were fixed/);
	assert.throws(
		() => game.requirements(gateCondition({ kind: 'globalVar', key: 1, compare: 0, value: 0, mapId: null })),
		/not noted/,
	);
});

test('a claimed variable takes no generic control, and only an unread variable can be claimed', () => {
	const game = new GameState();
	const gate = (key: number): Extract<GameCondition, { kind: 'mapVar' }> => ({
		kind: 'mapVar',
		mapId: '2',
		name: `#${key}`,
		compare: 1,
		target: 2,
	});
	game.note([gate(5)]);
	assert.equal(game.claimVariable(gate(5)), null);
	assert.equal(game.claimVariable(gate(6)), 'mapVar:2:#6');
	assert.equal(game.claimVariable(gate(6)), 'mapVar:2:#6');
	assert.throws(() => game.note([gate(6)]), /control of its own/);
	game.requirements(gate(5));
	assert.deepEqual(
		game.controls().map(({ id }) => id),
		['mapVar:2:#5'],
	);
});

test('a variable a MapConfig condition names and one a gate numbers share a control', () => {
	const game = new GameState({
		variables: { map: 'map02', mapId: 85, ids: { stateflower: 125 }, names: { 125: 'stateflower' } },
	});
	const named: GameCondition = {
		kind: 'mapVar',
		mapId: 'map02',
		name: 'stateflower',
		compare: 0,
		target: 1,
	};
	const gated = gateCondition({ kind: 'mapVar', key: 125, compare: 0, value: 1, mapId: 85 });
	game.note([named, gated]);
	// the MapConfig test reads unset as 0, the gate fails while unset
	assert.deepEqual(game.requirements(named), [[{ control: 'mapVar:85:#125', mask: 0b0100 }]]);
	assert.deepEqual(game.requirements(gated), [[{ control: 'mapVar:85:#125', mask: 0b0100 }]]);
	const controls = game.controls();
	assert.deepEqual(
		controls.map(({ id, name }) => [id, name]),
		[['mapVar:85:#125', 'stateflower (map map02, #125)']],
	);
	assert.deepEqual(
		controls[0].values.map(({ label }) => label),
		['unset', '< 1', '= 1', '> 1'],
	);
});

test('a MapConfig variable test fails while the variable is unset, even one that 0 passes', () => {
	const game = new GameState();
	// map02_lv009's day: State = 0
	const day: GameCondition = {
		kind: 'mapVar',
		mapId: 'map02',
		name: 'State',
		compare: 0,
		target: 0,
	};
	const notNight: GameCondition = { ...day, compare: 1, target: 1 };
	game.note([day, notNight]);
	assert.deepEqual(game.requirements(day), [[{ control: 'mapVar:map02:State', mask: 0b100 }]]);
	assert.deepEqual(
		game.controls()[0].values.map(({ label }) => label),
		['unset', '< 0', '= 0', '= 1', '> 1'],
	);
	// ≠ 1 holds for every set value but 1, and not while unset
	assert.deepEqual(game.requirements(notNight), [[{ control: 'mapVar:map02:State', mask: 0b10110 }]]);
	assert.equal(game.evaluate(day), false);
});

test('conjunctions merge requirements on the same control and drop impossible ones', () => {
	assert.deepEqual(
		allOf(
			[[{ control: 'a', mask: 0b011 }], [{ control: 'b', mask: 1 }]],
			[[{ control: 'a', mask: 0b110 }], [{ control: 'a', mask: 0b100 }]],
		),
		[
			[{ control: 'a', mask: 0b010 }],
			[
				{ control: 'b', mask: 1 },
				{ control: 'a', mask: 0b110 },
			],
			[
				{ control: 'b', mask: 1 },
				{ control: 'a', mask: 0b100 },
			],
		],
	);
	assert.deepEqual(allOf([[]], [[{ control: 'a', mask: 1 }]]), [[{ control: 'a', mask: 1 }]]);
	assert.deepEqual(allOf([[{ control: 'a', mask: 1 }]], [[{ control: 'a', mask: 2 }]]), []);
});

test('a test of an outpost level-up mission completing reads the outpost level instead', () => {
	// Cardiac Remediation Station: f1m19d3 raises it from level 3, so it's complete at level 4
	const game = new GameState({
		links: new Map([
			['f1m19d3', { control: 'settlement:stm_hongs_2', levels: [0, 1, 2, 3, 4], completedFrom: 4 }],
		]),
	});
	const mission = (compare: 0 | 1, target: number): GameCondition => ({
		kind: 'mission',
		id: 'f1m19d3',
		compare,
		target,
	});
	assert.deepEqual(game.requirements(mission(0, 3)), [[{ control: 'settlement:stm_hongs_2', mask: 1 << 4 }]]);
	assert.deepEqual(game.requirements(mission(1, 3)), [
		[{ control: 'settlement:stm_hongs_2', mask: 0b01111 }],
	]);
	assert.deepEqual(game.controls(), []);
	// telling unfinished states apart still needs the mission's own state
	assert.deepEqual(game.requirements(mission(0, 2)), [[{ control: 'mission:f1m19d3', mask: 1 << 2 }]]);
});
