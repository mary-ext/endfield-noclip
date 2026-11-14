import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { multiplyMatrices, trsMatrix } from '@endfield-noclip/formats/unity/transform';

import { emitterMotion, type PoseFrames } from './skin-pose.ts';

/** a quaternion turning `degrees` about z */
const aboutZ = (degrees: number): [number, number, number, number] => {
	const half = (degrees * Math.PI) / 360;
	return [0, 0, Math.sin(half), Math.cos(half)];
};

describe('emitterMotion', () => {
	// an emitter 10 m out along a hub's -x, the hub turning about z, as the waterwheels' pour emitters ride
	const arm = trsMatrix([-10, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
	const at = (degrees: number) => multiplyMatrices(trsMatrix([0, 0, 0], aboutZ(degrees), [1, 1, 1]), arm);
	const frames = (angles: number[]): PoseFrames => ({
		frameRate: 60,
		matrices: angles.map((degrees) => new Map([['emitter', at(degrees)]])),
	});
	const reach = {
		center: [0, 0, 0] as [number, number, number],
		extents: [1, 1, 1] as [number, number, number],
	};

	it('gives each frame relative to the emitter where the clip ends, and the bounds it reaches', () => {
		// the walk places it at the end pose, 0°; the emitter's own frame is turned and scaled from its Transform's
		const placed = at(0);
		const matrix = multiplyMatrices(placed, trsMatrix([0, 0, 0], aboutZ(90), [2, 2, 2]));
		const angles = Array.from({ length: 120 }, (_, frame) => (frame < 60 ? 90 : 0));
		const moving = emitterMotion(
			frames(angles),
			{ transform: 'emitter', placed, matrix, inWorld: true },
			reach,
		);
		assert.ok(moving !== null);
		const { motion, bounds } = moving;
		// 60 a second kept at 30
		assert.equal(motion.frameRate, 30);
		assert.equal(motion.frames.length, 60 * 12);
		assert.equal(motion.inWorld, true);
		// a frame at the end pose is the identity
		assert.deepEqual(motion.frames.slice(59 * 12), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
		// at 90° the emitter is 10 m below the hub instead of beside it, 10 m along +x and down from where it ends:
		// its own frame, turned 90° and sized 2, sees that as 5 back along its x (the world y) and 5 along its -y
		const first = motion.frames.slice(0, 12);
		assert.ok(Math.abs(first[3] + 5) < 1e-4);
		assert.ok(Math.abs(first[7] + 5) < 1e-4);
		assert.ok(bounds.extents[0] >= 3.5 && bounds.extents[1] >= 3.5);
	});

	it("is null when the clip doesn't move the emitter", () => {
		const placed = at(30);
		const still = emitterMotion(
			frames([30, 30, 30]),
			{ transform: 'emitter', placed, matrix: placed, inWorld: false },
			reach,
		);
		assert.equal(still, null);
	});

	it('is null when the clip ends the emitter scaled to nothing', () => {
		const placed = trsMatrix([-10, 0, 0], [0, 0, 0, 1], [0, 0, 0]);
		const shrunk = emitterMotion(
			frames([0, 90]),
			{ transform: 'emitter', placed, matrix: placed, inWorld: true },
			reach,
		);
		assert.equal(shrunk, null);
	});
});
