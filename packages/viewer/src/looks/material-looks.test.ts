import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LookFlags, LookRow } from './look.ts';
import { materialLooks } from './material-looks.ts';
import { described } from './test-materials.ts';

test('undrawn surfaces are not drawn, and unsupported ones show an unlit, shadowless, two-sided magenta checker', () => {
	const [undrawn, unsupported] = materialLooks({
		entries: [
			described({ kind: 'undrawn', reason: 'a water proxy' }),
			described({ kind: 'unsupported', reason: 'additive' }),
		],
	});
	assert.deepEqual([undrawn.drawn, undrawn.unsupported], [false, false]);
	assert.deepEqual([unsupported.drawn, unsupported.unsupported], [true, true]);
	assert.equal(unsupported.flags, LookFlags.Unlit);
	assert.equal(unsupported.castsShadows, false);
	assert.equal(unsupported.cull, 'none');
	assert.deepEqual(Array.from(unsupported.params.subarray(LookRow.tint, LookRow.tint + 4)), [1, 0, 1, -1]);
	assert.equal(unsupported.params[LookRow.surface + 2], 0.5);
});

test('a material a looping clip plays moves its look to the step the clock is at', () => {
	// a matte painting whose colour's red steps 1, 2, 3, 4 over a 2 s loop
	const entry = described({
		kind: 'mattePainting',
		texture: null,
		color: [9, 0.5, 0.25],
		alphaClip: null,
		highlight: { threshold: 1, intensity: 0 },
		ignorePostExposure: 1,
	});
	const [look, still] = materialLooks({
		entries: [
			{ ...entry, motion: { duration: 2, tracks: [{ path: ['color', 0], values: [1, 2, 3, 4] }] } },
			entry,
		],
	});
	assert.equal(still.motion, null);
	const red = () => look.params[LookRow.tint];
	// it starts as the surface stands, at the clip's end
	assert.equal(red(), 9);
	assert.equal(look.motion?.advance(0.6), true);
	assert.deepEqual(Array.from(look.params.subarray(LookRow.tint, LookRow.tint + 3)), [2, 0.5, 0.25]);
	// within the same step nothing changes
	assert.equal(look.motion?.advance(0.9), false);
	// and the loop wraps
	assert.equal(look.motion?.advance(2.1), true);
	assert.equal(red(), 1);
});

test('unconverted materials show as unsupported', () => {
	const [failed] = materialLooks({ entries: [{ status: 'failed' }] });
	assert.equal(failed.unsupported, true);
});
