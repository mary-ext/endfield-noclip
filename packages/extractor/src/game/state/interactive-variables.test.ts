import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WorldIndex } from '../world/world-index.ts';

import { loadInteractiveVariables, nameInteractiveVariable } from './interactive-variables.ts';
import { sceneControl } from './scene-control.ts';

test('an interactive-backed map variable is named and placed after its interactive', async () => {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only json is read
	const world = {
		json: async () => ({
			mapVarAutoNameList: {
				map02: ['__mapVar_interactive_23400133061_state', '__mapVar_interactive_7_hp_ratio'],
			},
			mapVarIntKeyList: { map02: [30, 31] },
			mapVarBelongEntityList: { map02: [23400133061, 7] },
			mapVarDefaultValueList: { map02: [1, 100] },
		}),
	} as unknown as WorldIndex;
	const variables = await loadInteractiveVariables(world, { map: 'map02', mapId: 85 });
	assert.deepEqual(
		[...variables],
		[
			['mapVar:85:#30', { interactive: '23400133061', property: 'state', initial: 1 }],
			['mapVar:85:#31', { interactive: '7', property: 'hp_ratio', initial: 100 }],
		],
	);
	const control = sceneControl({
		kind: 'mapVar',
		id: 'mapVar:85:#30',
		name: '#30 (map map02)',
		values: [],
		default: 0,
		assumption: 'assumed 0',
	});
	nameInteractiveVariable(control, variables.get('mapVar:85:#30')!, {
		template: 'int_Hyper_erosion_sludge_core',
		position: [1, 2, 3],
	});
	assert.equal(control.name, 'Hyper sludge core');
	assert.deepEqual(control.place?.position, [1, 2, 3]);
	assert.match(control.assumption, /interactive 23400133061’s state, which a fresh world starts at 1/);
});
