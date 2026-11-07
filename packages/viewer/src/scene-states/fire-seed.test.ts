import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NO_REVEAL, revealRadii } from './fire-seed.ts';

describe('revealRadii', () => {
	const info = {
		control: 1,
		radii: [
			[9999, 50000],
			[4, 4.5],
		] as [number, number][],
	};

	it('takes the radii of the control’s current value', () => {
		assert.deepEqual(revealRadii(info, [3, 0]), [9999, 50000]);
		assert.deepEqual(revealRadii(info, [3, 1]), [4, 4.5]);
	});

	it('leaves the materials’ own radii without a fire seed', () => {
		assert.deepEqual(revealRadii(null, [1, 1]), NO_REVEAL);
	});
});
