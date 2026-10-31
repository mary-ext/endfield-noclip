import assert from 'node:assert/strict';
import { it } from 'node:test';

import { Camera, boxInFrustum, sweepPlanes } from './camera.ts';

it('sweeps the frustum towards the sun, so a caster behind the camera reaches the view', () => {
	// looking along +z with the sun behind and above: light travels along +z and down
	const camera = new Camera();
	const planes = camera.frustumPlanes(1);
	const light: [number, number, number] = [0, -Math.SQRT1_2, Math.SQRT1_2];
	const swept = sweepPlanes(planes, light, 100);
	const inside = (p: readonly number[], set: typeof planes): boolean =>
		boxInFrustum(set, [p[0] - 1, p[1] - 1, p[2] - 1], [p[0] + 1, p[1] + 1, p[2] + 1], [0, 0, 0]);

	// a tower top 20 m behind and 20 m above shades the ground 20 m ahead
	assert.equal(inside([0, 20, -20], planes), false);
	assert.equal(inside([0, 20, -20], swept), true);
	// what lies away from the sun can't shade the view
	assert.equal(inside([0, 0, -50], swept), false);
	assert.equal(inside([0, -60, 10], swept), false);
	// the view itself stays inside
	assert.equal(inside([0, 0, 30], swept), true);
});
