import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DynamicGate } from '@endfield-noclip/formats/endfield/dynamic-scene';
import { conditionVisible } from '@endfield-noclip/package-format/conditions';

import { allOf, describeCondition, GameState, gateCondition, type GameCondition } from './game-state.ts';

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
	assert.equal(
		describeCondition(condition),
		'not (quest showLandslide = completed and quest finishDigWork ≠ completed)',
	);
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

test('a MapConfig variable test reads an unset variable as 0, so it has no unset value', () => {
	const game = new GameState();
	const day: GameCondition = {
		kind: 'mapVar',
		mapId: 'map02',
		name: 'State',
		compare: 0,
		target: 0,
		unsetFails: false,
	};
	game.note([day]);
	assert.deepEqual(game.requirements(day), [[{ control: 'mapVar:map02:State', mask: 0b10 }]]);
	assert.deepEqual(
		game.controls()[0].values.map(({ label }) => label),
		['< 0', '= 0', '> 0'],
	);
	assert.equal(game.evaluate(day), true);
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
