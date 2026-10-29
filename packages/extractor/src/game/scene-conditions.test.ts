import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MapConfig, SceneCondition } from '@endfield-noclip/formats/endfield/map-config';

import { defaultSceneStates, describe, evaluate, loadSceneStateControls } from './scene-conditions.ts';
import type { WorldIndex } from './world-index.ts';

test('defaults are those of a finished story, with variables at 0', () => {
	assert.equal(evaluate({ kind: 'quest', questId: 'q', compare: 0, target: 3 }), true);
	assert.equal(evaluate({ kind: 'mission', missionId: 'm', compare: 1, target: 3 }), false);
	// a mission still processing: false once the story is done
	assert.equal(evaluate({ kind: 'mission', missionId: 'm', compare: 0, target: 2 }), false);
	assert.equal(evaluate({ kind: 'mapVar', mapId: 'map02', name: 'State', compare: 0, target: 0 }), true);
	assert.equal(evaluate({ kind: 'globalVar', name: 'g', compare: 3, target: 1 }), false);
	const either: Extract<SceneCondition, { reverse: boolean }> = {
		kind: 'any',
		reverse: false,
		conditions: [
			{ kind: 'quest', questId: 'q', compare: 1, target: 3 },
			{ kind: 'mission', missionId: 'm', compare: 0, target: 2 },
		],
	};
	assert.equal(evaluate(either), false);
	assert.equal(evaluate({ ...either, reverse: true }), true);
	assert.equal(describe(either), '(quest q ≠ completed or mission m = processing)');
});

test('one control per MapConfig state; states without a condition start off', async () => {
	const map: Pick<MapConfig, 'sceneStates' | 'sceneStateConditions'> = {
		sceneStates: { liino: 2, '001_damaged': 1, '001_normal': 0 },
		sceneStateConditions: [
			{ state: '001_normal', condition: { kind: 'quest', questId: 'e1m8_q#3', compare: 0, target: 3 } },
			{ state: '001_damaged', condition: { kind: 'quest', questId: 'e1m8_q#3', compare: 1, target: 3 } },
		],
	};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only mapConfig is read
	const world = { mapConfig: async () => map } as unknown as WorldIndex;
	const controls = await loadSceneStateControls(world, 'map01');
	assert.deepEqual(
		controls.map(({ id, name, defaultEnabled }) => [id, name, defaultEnabled]),
		[
			['sceneState:0', '001_normal', true],
			['sceneState:1', '001_damaged', false],
			['sceneState:2', 'liino', false],
		],
	);
	assert.deepEqual([...defaultSceneStates(controls)], [0]);
});
