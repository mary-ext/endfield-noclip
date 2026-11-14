import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emitterFrameInto, multiplyRowsInto } from './emitter-motion.ts';
import { PARTICLE_FLOATS, ParticleSimulation } from './simulation.ts';
import { constant, DOWN, same, system } from './test-systems.ts';

/** rows3x4 of a move along x */
const along = (x: number): number[] => [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0];

describe('emitterFrameInto', () => {
	it('holds each frame until the next and loops after the last, before 0 too', () => {
		const motion = { inWorld: true, frameRate: 2, frames: [...along(0), ...along(1), ...along(2)] };
		const out = new Float64Array(12);
		assert.equal(emitterFrameInto(motion, 0.4, out)[3], 0);
		assert.equal(emitterFrameInto(motion, 0.5, out)[3], 1);
		assert.equal(emitterFrameInto(motion, 1.4, out)[3], 2);
		assert.equal(emitterFrameInto(motion, 1.5, out)[3], 0);
		assert.equal(emitterFrameInto(motion, -0.1, out)[3], 2);
	});
});

describe('multiplyRowsInto', () => {
	it('applies the inner transform first', () => {
		// a quarter turn about z, then a move along x
		const turn = new Float64Array([0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]);
		const move = new Float64Array(along(3));
		const out = multiplyRowsInto(new Float64Array(12), move, turn);
		assert.deepEqual(Array.from(out), [0, -1, 0, 3, 1, 0, 0, 0, 0, 0, 1, 0]);
		const other = multiplyRowsInto(new Float64Array(12), turn, move);
		assert.deepEqual(Array.from(other), [0, -1, 0, 0, 1, 0, 0, 3, 0, 0, 1, 0]);
	});
});

describe('ParticleSimulation with a moving emitter', () => {
	it('starts each particle where the emitter was when it was emitted, and leaves it there', () => {
		// still particles, one a second, living 10 s; the emitter is 10 m along x per second of emission
		const info = system({
			shape: null,
			startLifetime: constant(10),
			gravityModifier: constant(0),
			maxParticles: 100,
		});
		const out = new Float32Array(64 * PARTICLE_FLOATS);
		const frame = new Float64Array(12);
		const count = new ParticleSimulation(info, 7).evaluate(100, DOWN, same, out, (born) => {
			frame.set(along(born * 10));
			return frame;
		});
		assert.ok(count >= 9);
		for (let i = 0; i < count; i++) {
			const x = out[i * PARTICLE_FLOATS];
			// born within the last 10 s, at the place it was emitted from
			assert.ok(x > 900 - 1e-3 && x <= 1000 + 1e-3);
			assert.ok(Math.abs(x / 10 - Math.round(x / 10)) < 1e-3);
		}
	});
});
