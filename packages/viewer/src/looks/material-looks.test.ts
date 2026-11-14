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

test('unconverted materials show as unsupported', () => {
	const [failed] = materialLooks({ entries: [{ status: 'failed' }] });
	assert.equal(failed.unsupported, true);
});
