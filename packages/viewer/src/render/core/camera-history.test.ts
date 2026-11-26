import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Camera } from '../../scene/camera.ts';

import { CAMERA_HISTORY_FLOATS, CameraHistory } from './camera-history.ts';

describe('CameraHistory', () => {
	it('reports invalid before the first advance and exposes the previous camera without mutating state', () => {
		const history = new CameraHistory();
		const out = new Float32Array(CAMERA_HISTORY_FLOATS);
		assert.equal(history.valid, false);
		history.readPrevious(out, [1, 2, 3]);
		assert.equal(out[19], 1);

		const camera = new Camera();
		camera.position = [10, 20, 30];
		history.write(out, camera, 16 / 9);
		assert.equal(out[19], 1);
		history.advance();
		assert.equal(history.valid, true);
		assert.equal(history.index, 1);

		const read = new Float32Array(CAMERA_HISTORY_FLOATS);
		history.readPrevious(read, [12, 25, 29]);
		assert.deepEqual([...read.subarray(16, 20)], [2, 5, -1, 0]);
		// reading does not advance or swap the history index
		assert.equal(history.index, 1);
		assert.equal(history.valid, true);
	});
});
