import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ExtraSceneSlot } from '@endfield-noclip/formats/endfield/dynamic-scene';

import { cabinDoors } from './cabins.ts';

const slot = (id: string, x: number, z: number): { id: string; slot: ExtraSceneSlot } => ({
	id,
	slot: { min: [x - 3, 0, z - 3], max: [x + 3, 6, z + 3], position: [x, 4.9, z], direction: 0 },
});

test('a door opens into the nearest slot within reach, and a far door into none', () => {
	// Dijiang's layout: two small slots side by side and a medium one across the corridor
	const slots = [slot('small', -12.8, 130.2), slot('spare', 12, 130), slot('medium', -16.3, 92.7)];
	const linked = cabinDoors(slots, [
		{ id: 'door:a', position: [-12.7, 1.1, 121.2] },
		{ id: 'door:b', position: [-6.1, 1.1, 92.7] },
		{ id: 'door:guest', position: [-47.7, 1.1, -7.4] },
	]);
	assert.deepEqual(
		[...linked],
		[
			['door:a', 'cabin:small'],
			['door:b', 'cabin:medium'],
		],
	);
});
