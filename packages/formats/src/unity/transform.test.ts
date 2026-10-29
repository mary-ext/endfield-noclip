import assert from 'node:assert/strict';
import { test } from 'node:test';

import { multiplyMatrices, transformBounds, trsMatrix, unityEulerQuaternion } from './transform.ts';

const near = (actual: ArrayLike<number>, expected: number[]): void => {
	assert.equal(actual.length, expected.length);
	for (let i = 0; i < actual.length; i++) {
		assert.ok(Math.abs(actual[i] - expected[i]) < 1e-5, `${actual[i]} != ${expected[i]}`);
	}
};

test('Unity Euler rotation applies Z, then X, then Y to a point', () => {
	const matrix = trsMatrix([10, 20, 30], unityEulerQuaternion([90, 90, 90]), [2, 3, 4]);
	// (1, 2, 3) scales to (2, 6, 12), then rotates to (2, -12, 6).
	near(transformBounds({ center: [1, 2, 3], extents: [0, 0, 0] }, matrix).center, [12, 8, 36]);
});

test('nested transforms preserve parent rotation and scale without mutating either matrix', () => {
	const parent = trsMatrix([10, 0, 0], unityEulerQuaternion([0, 90, 0]), [2, 2, 2]);
	const child = trsMatrix([1, 0, 0], [0, 0, 0, 1], [1, 2, 3]);
	const saved = [parent.slice(), child.slice()];
	const bounds = transformBounds({ center: [0, 0, 0], extents: [1, 1, 1] }, multiplyMatrices(parent, child));
	near(bounds.center, [10, 0, -2]);
	near(bounds.extents, [6, 4, 2]);
	assert.deepEqual([parent, child], saved);
});
