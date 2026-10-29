import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DynamicGate } from '@endfield-noclip/formats/endfield/dynamic-scene';

import { gateControl, gateToggles } from './dynamic-gates.ts';

test('mission gates default to a finished story', () => {
	// the landslide and its dug-out state
	const landslide: DynamicGate = {
		kind: 'mission',
		all: true,
		loadWhen: true,
		conditions: [
			{ id: 'showLandslide', isQuest: true, state: 3, same: true },
			{ id: 'finishDigWork', isQuest: true, state: 3, same: false },
		],
	};
	const dugOut: DynamicGate = {
		...landslide,
		conditions: [{ id: 'finishDigWork', isQuest: true, state: 3, same: true }],
	};
	const whileFalse: DynamicGate = { ...dugOut, loadWhen: false };
	const toggles = gateToggles([landslide, dugOut, whileFalse, landslide]);
	assert.equal(toggles.size, 3);
	assert.deepEqual(
		[landslide, dugOut, whileFalse].map((gate) => toggles.get(gateControl(gate))?.defaultEnabled),
		[false, true, false],
	);
	assert.equal(
		toggles.get(gateControl(landslide))?.condition,
		'loads while (quest showLandslide = completed and quest finishDigWork ≠ completed); default: story finished',
	);
});

test('a variable is assumed to hold the highest value the scene compares it against', () => {
	const variable = (compare: number, value: number): DynamicGate => ({
		kind: 'globalVar',
		key: 77,
		compare,
		value,
		mapId: null,
	});
	const erosion: DynamicGate = { kind: 'mapVar', key: 19, compare: 1, value: 2, mapId: 2 };
	const gates = [variable(0, 0), variable(0, 1), erosion];
	const toggles = gateToggles(gates);
	assert.deepEqual(
		gates.map((gate) => toggles.get(gateControl(gate))?.defaultEnabled),
		[false, true, false],
	);
	assert.equal(toggles.get(gateControl(erosion))?.kind, 'variable');
});
