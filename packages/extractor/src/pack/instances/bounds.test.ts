import assert from 'node:assert/strict';
import { it } from 'node:test';

import { sweptBounds } from './bounds.ts';

it('holds a box turning about an axis at every angle', () => {
	// a 2 × 2 × 2 box 4 m along +x from a pivot, turning about +z: its far corners are √(5² + 1²) from the axis
	const swept = sweptBounds({ center: [4, 0, 0], extents: [1, 1, 1] }, { axis: [0, 0, 1], pivot: [0, 0, 0] });
	const radius = Math.hypot(5, 1);
	assert.deepEqual(swept.center, [0, 0, 0]);
	assert.ok(Math.abs(swept.extents[0] - radius) < 1e-9);
	assert.ok(Math.abs(swept.extents[1] - radius) < 1e-9);
	assert.ok(Math.abs(swept.extents[2] - 1) < 1e-9);
});
