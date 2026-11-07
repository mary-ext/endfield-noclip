import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MapConfig } from '@endfield-noclip/formats/endfield/map-config';
import { conditionVisible } from '@endfield-noclip/package-format/conditions';

import { mapDefined } from '@mary-ext/array-fns';

import type { WorldIndex } from '../world/world-index.ts';

import { GameState } from './game-state.ts';
import { defaultSceneStates, loadSceneStates, sceneStateControls } from './scene-conditions.ts';
import type { Visibility } from './scene-control.ts';

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
	game.note(mapDefined(states, ({ condition }) => condition ?? undefined));
	assert.deepEqual([...defaultSceneStates(states, game)], [0]);
	const conditionalSets: Visibility[] = [];
	const controls = sceneStateControls(states, game, (formula) => conditionalSets.push(formula) - 1);
	assert.deepEqual(
		controls.map(({ id, name, default: value, source }) => [
			id,
			name,
			value,
			source.kind === 'derived' ? source.condition : null,
		]),
		[
			['sceneState:0', '001_normal', 1, 0],
			['sceneState:1', '001_damaged', 0, 1],
			['sceneState:2', 'liino', 0, null],
		],
	);
	assert.deepEqual(controls[1].source.kind === 'derived' && controls[1].source.rule, [
		{ control: 'quest:e1m8_q#3', text: 'quest e1m8_q#3' },
		' ≠ completed',
	]);
	// the quest in progress: the damaged state holds, the normal one doesn't
	const values = { 'quest:e1m8_q#3': 2 };
	assert.deepEqual(
		controls.map(({ source }) =>
			source.kind === 'derived' ? conditionVisible(conditionalSets[source.condition], values) : null,
		),
		[false, true, null],
	);
});
