import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MapConfig } from '@endfield-noclip/formats/endfield/map-config';
import { resolveSceneValues } from '@endfield-noclip/package-format/conditions';
import type { ConditionalSetInfo } from '@endfield-noclip/package-format/states';

import { GameState } from './game-state.ts';
import { defaultSceneStates, loadSceneStates, sceneStateControls } from './scene-conditions.ts';
import type { WorldIndex } from './world-index.ts';

test('scene states follow the quests their conditions read; states without a condition start off', async () => {
	const map: Pick<MapConfig, 'sceneStates' | 'sceneStateConditions'> = {
		sceneStates: { liino: 2, '001_damaged': 1, '001_normal': 0 },
		sceneStateConditions: [
			{ state: '001_normal', condition: { kind: 'quest', questId: 'e1m8_q#3', compare: 0, target: 3 } },
			{ state: '001_damaged', condition: { kind: 'quest', questId: 'e1m8_q#3', compare: 1, target: 3 } },
		],
	};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only mapConfig is read
	const world = { mapConfig: async () => map } as unknown as WorldIndex;
	const states = await loadSceneStates(world, 'map01');
	const game = new GameState();
	game.note(states.flatMap(({ condition }) => (condition === null ? [] : [condition])));
	assert.deepEqual([...defaultSceneStates(states, game)], [0]);
	const conditionalSets: ConditionalSetInfo[] = [];
	const controls = sceneStateControls(states, game, (formula) => conditionalSets.push(formula) - 1);
	assert.deepEqual(
		controls.map(({ id, name, default: value, derived }) => [id, name, value, derived]),
		[
			['sceneState:0', '001_normal', 1, 0],
			['sceneState:1', '001_damaged', 0, 1],
			['sceneState:2', 'liino', 0, null],
		],
	);
	assert.equal(controls[1].rule, 'quest e1m8_q#3 ≠ completed');
	const info = {
		controls: [...game.controls(), ...controls],
		conditionalSets,
		groups: [],
		streamAreas: null,
	};
	assert.deepEqual(resolveSceneValues(info, { 'quest:e1m8_q#3': 2 }), {
		'quest:e1m8_q#3': 2,
		'sceneState:0': 0,
		'sceneState:1': 1,
		'sceneState:2': 0,
	});
});
