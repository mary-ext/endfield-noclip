import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { parseMapConfig } from './map-config.ts';

const config = (conditions: unknown[]) =>
	JSON.stringify({
		mapIdStr: 'map01',
		sideGridNum: 2,
		levelIds: [0, 0, 0, 0],
		sceneStates: { '001_normal': 0, '001_damaged': 1, liino: 2 },
		sceneStateConditions: conditions,
	});

const quest = (compareOperator: number) => ({
	$type: 'Beyond.Gameplay.SimpleConditionCheckQuestState, Gameplay.Beyond',
	questId: 'e1m8_q#3',
	compareOperator,
	compareTarget: 3,
});

test('scene state conditions keep their states, leaves and combinations', () => {
	const parsed = parseMapConfig(
		`﻿${config([
			{ stateName: '001_normal', condition: quest(0) },
			{
				stateName: '001_damaged',
				condition: {
					$type: 'Beyond.Gameplay.CombinedConditionRuntime, Gameplay.Beyond',
					conditionOperator: 1,
					reverse: true,
					subConditions: [
						quest(1),
						{
							$type: 'Beyond.Gameplay.SimpleConditionCheckMapVar, Gameplay.Beyond',
							belongMapId: 'map01',
							mapVarName: 'State',
							compareOperator: 0,
							compareTarget: 1,
						},
					],
				},
			},
		])}`,
	);
	assert.deepEqual(parsed.sceneStates, { '001_normal': 0, '001_damaged': 1, liino: 2 });
	assert.deepEqual(parsed.sceneStateConditions, [
		{ state: '001_normal', condition: { kind: 'quest', questId: 'e1m8_q#3', compare: 0, target: 3 } },
		{
			state: '001_damaged',
			condition: {
				kind: 'any',
				reverse: true,
				conditions: [
					{ kind: 'quest', questId: 'e1m8_q#3', compare: 1, target: 3 },
					{ kind: 'mapVar', mapId: 'map01', name: 'State', compare: 0, target: 1 },
				],
			},
		},
	]);
});

test('unknown condition classes and invalid comparisons are rejected, not guessed', () => {
	assert.throws(
		() =>
			parseMapConfig(
				config([
					{ stateName: 'liino', condition: { $type: 'Beyond.Gameplay.SomethingElse, Gameplay.Beyond' } },
				]),
			),
		FormatError,
	);
	assert.throws(() => parseMapConfig(config([{ stateName: 'liino', condition: quest(6) }])), FormatError);
});
