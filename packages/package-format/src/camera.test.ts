import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cameraValues } from './camera.ts';
import { conditionVisible, resolveSceneValues } from './conditions.ts';
import type { CameraTest, Reach, SceneControl } from './states.ts';

const control = (id: string, cameraTest: CameraTest): SceneControl => ({
	id,
	kind: 'proximity',
	name: id,
	category: 0,
	values: [
		{ value: 0, label: 'away' },
		{ value: 1, label: 'near' },
	],
	default: 0,
	assumption: '',
	source: { kind: 'camera', test: cameraTest },
	levels: [],
	story: null,
	drivers: [],
	place: null,
});

test('a near test holds within any reach, measured in 3D', () => {
	// the blue talosite in Suiming, whose look changes within 15 m
	const talosite = control('proximity:46300000058', {
		kind: 'near',
		reaches: [{ position: [-94.6, 120, -1.5], radius: 15 }],
	});
	const at = (eye: [number, number, number]) => cameraValues([talosite], eye, null).get(0);
	assert.equal(at([-97.2, 122.1, -4]), 1);
	assert.equal(at([-94.6, 120, 13.5]), 1);
	// straight above by more than the radius
	assert.equal(at([-94.6, 136, -1.5]), 0);

	// two of the spheres of the Jingyu Valley tree cave's trigger volume
	const reaches: Reach[] = [
		{ position: [-1072.7, 243, -1347.8], radius: 92.4 },
		{ position: [-1082.6, 243, -1406.1], radius: 77.8 },
	];
	const cave = control('proximity:volume:10100030016:80003', { kind: 'near', reaches });
	const inCave = (eye: [number, number, number]) => cameraValues([cave], eye, null).get(0);
	assert.equal(inCave([-1045.9, 229.2, -1399.8]), 1);
	assert.equal(inCave([-1072.7, 243, -1260]), 1);
	assert.equal(inCave([-900, 243, -1400]), 0);
});

test('an area test follows the areas shown, and a pick overrides it', () => {
	const area = control('area:8', { kind: 'area', area: 8 });
	const states = { controls: [area], conditionalSets: [] };
	const content = { alternatives: [[{ control: 0, mask: 2 }]] };
	const hidden = cameraValues([area], [0, 0, 0], new Set([0, 7]));
	assert.deepEqual(hidden, new Map([[0, 0]]));
	assert.equal(conditionVisible(content, resolveSceneValues(states, new Map(), hidden)), false);
	assert.equal(conditionVisible(content, resolveSceneValues(states, new Map([[0, 1]]), hidden)), true);
	// without stream areas every area shows
	assert.deepEqual(cameraValues([area], [0, 0, 0], null), new Map([[0, 1]]));
});
