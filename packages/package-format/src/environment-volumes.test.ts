import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	compareVolumes,
	distanceInsideVolume,
	volumeFootprintContains,
	volumeReaches,
} from './environment-volumes.ts';
import type { EnvironmentVolumeShape } from './environment.ts';

const square: EnvironmentVolumeShape = {
	kind: 'prism',
	points: [
		[0, 0],
		[100, 0],
		[100, 100],
		[0, 100],
	],
	bottom: 0,
	top: 50,
};

/** a 20 × 10 × 40 box at (100, 10, 0), turned 90° about y so its long side runs along x */
const box: EnvironmentVolumeShape = {
	kind: 'box',
	center: [100, 10, 0],
	toBox: [0, 0, -1, 0, 1, 0, 1, 0, 0],
	halfExtents: [10, 5, 20],
};

describe('distanceInsideVolume', () => {
	it('measures a prism to its nearest edge, top or bottom', () => {
		assert.equal(distanceInsideVolume(square, [5, 25, 50]), 5);
		assert.equal(distanceInsideVolume(square, [50, 48, 50]), 2);
		assert.ok(distanceInsideVolume(square, [50, 60, 50]) <= 0);
		assert.ok(distanceInsideVolume(square, [150, 25, 50]) <= 0);
	});

	it('measures a box in its own turned frame', () => {
		assert.ok(Math.abs(distanceInsideVolume(box, [115, 10, 0]) - 5) < 1e-9);
		assert.ok(distanceInsideVolume(box, [100, 10, 15]) <= 0);
	});

	it('holds every point in a global volume', () => {
		assert.equal(distanceInsideVolume({ kind: 'global' }, [1e6, 0, -1e6]), Infinity);
	});
});

describe('volumeFootprintContains', () => {
	it('ignores height', () => {
		assert.ok(volumeFootprintContains(square, 50, 50));
		assert.ok(!volumeFootprintContains(square, 150, 50));
		assert.ok(volumeFootprintContains(box, 115, 0));
		assert.ok(!volumeFootprintContains(box, 100, 15));
	});
});

describe('volumeReaches', () => {
	it('bounds a level rectangle by the footprint', () => {
		const rect = { minX: 50, minZ: 50, maxX: 200, maxZ: 200 };
		assert.equal(volumeReaches(square, rect), true);
		assert.equal(volumeReaches(square, { ...rect, minX: 150 }), false);
		assert.equal(volumeReaches({ kind: 'global' }, rect), true);
		const far: EnvironmentVolumeShape = {
			kind: 'box',
			center: [300, 0, 100],
			toBox: [1, 0, 0, 0, 1, 0, 0, 0, 1],
			halfExtents: [5, 5, 5],
		};
		assert.equal(volumeReaches(far, rect), false);
	});
});

describe('compareVolumes', () => {
	it('stacks by priority, then global under box under prism', () => {
		const at = (priority: number, shape: EnvironmentVolumeShape) => ({ priority, shape });
		assert.ok(compareVolumes(at(100, square), at(200, { kind: 'global' })) < 0);
		assert.ok(compareVolumes(at(100, { kind: 'global' }), at(100, box)) < 0);
		assert.ok(compareVolumes(at(100, box), at(100, square)) < 0);
		assert.equal(compareVolumes(at(100, square), at(100, square)), 0);
	});
});
