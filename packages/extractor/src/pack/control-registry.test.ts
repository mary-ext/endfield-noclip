import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	type DraftControl,
	derivedSource,
	sceneControl,
	SWITCH_VALUES,
} from '../game/state/scene-control.ts';

import { ControlRegistry } from './control-registry.ts';

const toggle = (id: string, value = 0): DraftControl =>
	sceneControl({ kind: 'script', id, name: id, values: SWITCH_VALUES, default: value, assumption: '' });

/** a toggle on while every input is on */
const derive = (registry: ControlRegistry, id: string, inputs: string[]): DraftControl => ({
	...toggle(id),
	source: derivedSource(
		registry.condition({ alternatives: [inputs.map((control) => ({ control, mask: 2 }))] }),
		[],
	),
});

/** @returns the visibility group of content shown while the control is on */
const shows = (registry: ControlRegistry, levelTag: number, control: string): number =>
	registry.group(levelTag, registry.condition({ alternatives: [[{ control, mask: 2 }]] }));

/** no content bounds and no levels */
const NOWHERE = { groupBounds: new Map(), locate: () => null };

test('a control is placed at its own spot, else around what it gates through the controls it drives', () => {
	const registry = new ControlRegistry();
	registry.add(
		toggle('slot'),
		derive(registry, 'door', ['slot']),
		{ ...toggle('anchored'), place: { position: [5, 0, 5], bounds: null, label: null } },
		toggle('spread'),
	);
	const boxes = new Map([
		[shows(registry, 1, 'door'), { min: [0, 0, 0], max: [10, 2, 4] } as const],
		[shows(registry, 1, 'anchored'), { min: [100, 0, 100], max: [110, 2, 110] } as const],
		[shows(registry, 1, 'spread'), { min: [-2000, 0, 0], max: [2000, 2, 10] } as const],
	]);
	const { controls } = registry.finish({
		groupBounds: new Map(
			[...boxes].map(([group, { min, max }]) => [group, { min: [...min], max: [...max] }]),
		),
		locate: ([x]) => (x < 50 ? 'Test Level · Gate' : 'Test Level'),
	});
	const places = Object.fromEntries(controls.map(({ id, place }) => [id, place]));
	// the slot reaches the door's content through the door it drives
	assert.deepEqual(places.slot, {
		position: [5, 1, 2],
		bounds: { min: [0, 0, 0], max: [10, 2, 4] },
		label: 'Test Level · Gate',
	});
	assert.deepEqual(places.anchored?.position, [5, 0, 5]);
	assert.equal(places.anchored?.label, 'Test Level · Gate');
	// content across the scene says nothing about where the control is
	assert.equal(places.spread, null);
});

test('derived controls follow their inputs whatever order they are registered in', () => {
	const registry = new ControlRegistry();
	// a diamond: top reads left and right, both of which read base
	registry.add(
		derive(registry, 'top', ['left', 'right']),
		derive(registry, 'left', ['base']),
		derive(registry, 'right', ['base']),
		toggle('base', 1),
	);
	shows(registry, 7, 'top');
	const { controls } = registry.finish(NOWHERE);
	assert.deepEqual(
		controls.map(({ id }) => id),
		['base', 'left', 'right', 'top'],
	);
	// level tags reach the inputs through the derived controls, and derived defaults follow the inputs
	for (const control of controls) {
		assert.deepEqual(control.levelTags, [7]);
		assert.equal(control.default, 1);
	}
});

test('controls nothing consumes are dropped, kept ones stay with their levels', () => {
	const registry = new ControlRegistry();
	registry.add(toggle('unused'), toggle('water'), toggle('gated'));
	registry.keep('water', [3]);
	shows(registry, 2, 'gated');
	const { controls, categories } = registry.finish(NOWHERE);
	assert.deepEqual(
		controls.map(({ id, levelTags }) => [id, levelTags]),
		[
			['water', [3]],
			['gated', [2]],
		],
	);
	// only the categories of kept controls are listed
	assert.deepEqual(
		categories.map(({ id }) => id),
		['scripts'],
	);
});

test('cycles, duplicates and unknown inputs throw', () => {
	{
		const registry = new ControlRegistry();
		registry.add(derive(registry, 'a', ['b']), derive(registry, 'b', ['a']));
		shows(registry, 0, 'a');
		assert.throws(() => registry.finish(NOWHERE), /cycle/);
	}
	{
		const registry = new ControlRegistry();
		registry.add(derive(registry, 'a', ['missing']));
		shows(registry, 0, 'a');
		assert.throws(() => registry.finish(NOWHERE), /unknown control missing/);
	}
	{
		const registry = new ControlRegistry();
		registry.add(toggle('a'));
		assert.throws(() => registry.add(toggle('a')), /duplicate/);
	}
});

test('defaults resolve registered and extra controls before finishing', () => {
	const registry = new ControlRegistry();
	registry.add(derive(registry, 'door', ['cabin']));
	assert.deepEqual(registry.defaults([toggle('cabin', 1)]), { cabin: 1, door: 1 });
	// an input not known yet fails its requirement
	assert.deepEqual(registry.defaults(), { door: 0 });
});

test('indexing names controls, levels and categories by index and drops what reads dropped controls', () => {
	const registry = new ControlRegistry();
	registry.add(toggle('unused'), toggle('water'), toggle('gated'), derive(registry, 'orphan', ['unused']));
	registry.keep('water', [3]);
	shows(registry, 2, 'gated');
	// the package's levels own tags 1 and 2; tag 3 has no level, so it stands for every level
	const { states, controlIndex } = registry.index(registry.finish(NOWHERE), {
		levelTags: [1, 2],
		missions: [],
		mainStory: [],
	});
	assert.deepEqual(
		states.controls.map(({ id, category, levels }) => [id, category, levels]),
		[
			['water', 0, [0, 1]],
			['gated', 0, [1]],
		],
	);
	assert.deepEqual(states.conditionalSets, [
		// the dropped `orphan` read the dropped `unused`, so its set can't hold
		{ alternatives: [] },
		{ alternatives: [[{ control: 1, mask: 2 }]] },
	]);
	assert.deepEqual(states.groups, [
		{ level: null, condition: null },
		{ level: 1, condition: 1 },
	]);
	assert.deepEqual(
		[...controlIndex],
		[
			['water', 0],
			['gated', 1],
		],
	);
});

test('equivalent conditions share a set, and equal owners and conditions a group', () => {
	const registry = new ControlRegistry();
	const a = registry.condition({
		alternatives: [
			[
				{ control: 'x', mask: 2 },
				{ control: 'y', mask: 2 },
			],
			[{ control: 'z', mask: 1 }],
		],
	});
	const b = registry.condition({
		alternatives: [
			[{ control: 'z', mask: 1 }],
			[
				{ control: 'y', mask: 2 },
				{ control: 'x', mask: 2 },
			],
		],
	});
	assert.equal(a, b);
	assert.equal(registry.group(1, a), registry.group(1, b));
	assert.equal(registry.group(0, null), 0);
});
