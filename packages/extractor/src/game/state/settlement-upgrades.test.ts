import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SceneProgression } from './scenery-variants.ts';
import { upgradeLinks } from './settlement-upgrades.ts';

const outpost = (key: string, levels: number[]): SceneProgression => ({
	kind: 'settlement',
	key,
	levelId: null,
	levelName: null,
	levels,
	defaultLevel: levels[0],
	entities: 2,
	groupsPerLevel: {},
});

test('links a level-up mission to its outpost when the scene authors a level above the one it raises', () => {
	const links = upgradeLinks(
		[
			{ missionId: 'f1m19d1', settlementId: 'stm_hongs_2', level: 1 },
			{ missionId: 'f1m19d3', settlementId: 'stm_hongs_2', level: 3 },
			{ missionId: 'f1m4d1', settlementId: 'stm_tundra_1', level: 1 },
			{ missionId: 'f1m18d3', settlementId: 'stm_hongs_1', level: 3 },
		],
		[outpost('stm_hongs_2', [0, 1, 2, 3, 4]), outpost('stm_hongs_1', [0, 1, 2, 3])],
	);
	assert.deepEqual(Object.fromEntries(links), {
		f1m19d1: { control: 'settlement:stm_hongs_2', levels: [0, 1, 2, 3, 4], completedFrom: 2 },
		f1m19d3: { control: 'settlement:stm_hongs_2', levels: [0, 1, 2, 3, 4], completedFrom: 4 },
	});
});
