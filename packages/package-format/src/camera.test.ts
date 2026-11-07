import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cameraValues, NO_TRIGGER_MEMORY } from './camera.ts';
import { conditionVisible, resolveSceneValues } from './conditions.ts';
import type { CameraTest, Reach, SceneControl, TriggerShape } from './states.ts';

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
	const at = (eye: [number, number, number]) =>
		cameraValues([talosite], eye, null, NO_TRIGGER_MEMORY).values.get(0);
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
	const inCave = (eye: [number, number, number]) =>
		cameraValues([cave], eye, null, NO_TRIGGER_MEMORY).values.get(0);
	assert.equal(inCave([-1045.9, 229.2, -1399.8]), 1);
	assert.equal(inCave([-1072.7, 243, -1260]), 1);
	assert.equal(inCave([-900, 243, -1400]), 0);
});

test('an area test follows the areas shown, and a pick overrides it', () => {
	const area = control('area:8', { kind: 'area', area: 8 });
	const states = { controls: [area], conditionalSets: [] };
	const content = { alternatives: [[{ control: 0, mask: 2 }]] };
	const hidden = cameraValues([area], [0, 0, 0], new Set([0, 7]), NO_TRIGGER_MEMORY).values;
	assert.deepEqual(hidden, new Map([[0, 0]]));
	assert.equal(conditionVisible(content, resolveSceneValues(states, new Map(), hidden)), false);
	assert.equal(conditionVisible(content, resolveSceneValues(states, new Map([[0, 1]]), hidden)), true);
	// without stream areas every area shows
	assert.deepEqual(cameraValues([area], [0, 0, 0], null, NO_TRIGGER_MEMORY).values, new Map([[0, 1]]));
});

test('a triggers test keeps the value the last crossing set', () => {
	// Snowy Forest's sky aurora (map02_lv009, group 36100010036): its level script shows it on entering the
	// western cliffs' volume and hides it on entering the valley's, with no leave events
	const cliffs: TriggerShape = {
		kind: 'prism',
		points: [
			[-136.7, 424.2],
			[-131.3, 407.1],
			[-182.8, 408.8],
			[-231, 435.5],
			[-240.1, 485.6],
			[-295.2, 491],
			[-292, 525.9],
			[-227.4, 526.2],
			[-213, 494.2],
			[-207.9, 474.6],
			[-197.5, 452.1],
			[-188.4, 443],
			[-165.2, 429.5],
		],
		bottom: 140.2,
		top: 266.2,
	};
	const valley: TriggerShape = {
		kind: 'prism',
		points: [
			[-128.8, 408.9],
			[-127.4, 388.6],
			[-153.5, 348.1],
			[-152.7, 256.2],
			[-77.8, 191],
			[26.1, 197.6],
			[155.4, 224.2],
			[274.8, 253.3],
			[343.8, 374.7],
			[331, 531.7],
			[293.2, 608.8],
			[223.9, 620.7],
			[195.3, 596],
			[178.5, 531.9],
			[122.4, 528.8],
			[53, 521.5],
			[7.6, 561.6],
			[0.3, 581.3],
			[26, 612.7],
			[-96.2, 699.5],
			[-204.3, 564.9],
			[-213.1, 496.1],
			[-197, 454.1],
			[-175, 438.9],
			[-155.4, 431.5],
			[-133.7, 425.9],
		],
		bottom: 79.4,
		top: 234.4,
	};
	const aurora = control('script:36100010036', {
		kind: 'triggers',
		triggers: [
			{ shapes: [cliffs], enter: 1, leave: null },
			{ shapes: [valley], enter: 0, leave: null },
		],
	});
	let memory = NO_TRIGGER_MEMORY;
	const walk = (eye: [number, number, number]) => {
		const step = cameraValues([aurora], eye, null, memory);
		memory = step.memory;
		return step.values.get(0);
	};
	// above both volumes nothing has set it yet
	assert.equal(walk([-260, 300, 505]), 0);
	assert.equal(walk([-260, 200, 505]), 1);
	// leaving sets nothing, so it stays shown
	assert.equal(walk([-260, 300, 505]), 1);
	assert.equal(walk([-100, 150, 500]), 0);
	assert.equal(walk([-100, 300, 500]), 0);
	assert.equal(walk([-260, 200, 505]), 1);
	// a fresh camera starting inside enters
	assert.equal(cameraValues([aurora], [-100, 150, 500], null, NO_TRIGGER_MEMORY).values.get(0), 0);
});

test('a sphere trigger holds within its radius, and leaving sets its leave value', () => {
	const shapes: TriggerShape[] = [{ kind: 'sphere', center: [0, 0, 0], radius: 10 }];
	const swap = control('script:1', { kind: 'triggers', triggers: [{ shapes, enter: 0, leave: 1 }] });
	const inside = cameraValues([swap], [0, 9, 0], null, NO_TRIGGER_MEMORY);
	assert.equal(inside.values.get(0), 0);
	assert.equal(cameraValues([swap], [0, 11, 0], null, inside.memory).values.get(0), 1);
});
