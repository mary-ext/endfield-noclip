import assert from 'node:assert/strict';
import { test } from 'node:test';

import { skinFrame } from './skin-frame.ts';

test('an animation loops over its frames, the last blending into the first', () => {
	// the balloon's idle: 420 frames at 30 per second
	assert.deepEqual(skinFrame(0, 420, 30), { a: 0, b: 1, blend: 0 });
	const late = skinFrame(13.99, 420, 30);
	assert.equal(late.a, 419);
	assert.equal(late.b, 0);
	assert.ok(Math.abs(late.blend - 0.7) < 1e-6);
	assert.deepEqual(skinFrame(14, 420, 30), { a: 0, b: 1, blend: 0 });
	assert.equal(skinFrame(14.5, 420, 30).a, 15);
});
