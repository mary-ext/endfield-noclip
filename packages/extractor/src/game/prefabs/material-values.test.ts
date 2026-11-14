import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ClipMaterialValue, ClipMotion } from '@endfield-noclip/formats/unity/animation-clip';

import { playedFloats } from './material-values.ts';

/** a 1 s loop at 4 frames a second that sets, on renderer 9, a float climbing by the frame and a steady one */
const motion = (materials: ClipMotion['materials']): ClipMotion => ({
	duration: 1,
	sampleRate: 4,
	loops: true,
	paths: [],
	sample: () => new Map(),
	materials,
});
const climbing = (time: number): Map<number, ClipMaterialValue[]> =>
	new Map([
		[
			9,
			[
				{ nameHash: 0x82d_ec3a, component: null, value: 1 + time * 4 },
				{ nameHash: 0x89f_1888, component: null, value: 1 },
				// a colour's red, which holds its end value
				{ nameHash: 0x123, component: 0, value: time },
			],
		],
	]);

test('a looping clip gives a renderer the floats it changes, at each of its frames', () => {
	assert.deepEqual(playedFloats([{ motion: motion(climbing), binding: 9 }]), {
		duration: 1,
		floats: [{ nameHash: 0x82d_ec3a, values: [1, 2, 3, 4] }],
	});
});

test('nothing plays without a clip, on another renderer, or from curves the reader leaves undecoded', () => {
	assert.equal(playedFloats([]), null);
	assert.equal(playedFloats([{ motion: motion(climbing), binding: 5 }]), null);
	assert.equal(playedFloats([{ motion: motion(null), binding: 9 }]), null);
});
