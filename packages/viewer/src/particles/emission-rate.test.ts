import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CurveMode, type MinMaxCurveInfo } from '@endfield-noclip/package-format/particles';

import { emissionStream } from './emission-rate.ts';
import { between, constant, run, system } from './test-systems.ts';

/**
 * the water a Qingbo waterwheel's scoops pour (`bigwater_01` in `p_igroup_map02_sfwaterwheel+2_004_01`): 32
 * particles a second from 12% to 77% of each 3.125 s loop, none in its last 15%
 */
const pour: MinMaxCurveInfo = {
	mode: CurveMode.Curve,
	scalar: 32,
	curve: {
		keys: [
			[0, 0, 0, 8.249],
			[0.121, 1, 8.249, 0],
			[0.773, 1, 0, -14.079],
			[0.845, 0, -14.079, 0],
			[1, 0, 0, 0],
		].map(([time, value, inSlope, outSlope]) => ({
			time,
			value,
			inSlope,
			outSlope,
			weightedMode: 0,
			inWeight: 0,
			outWeight: 0,
		})),
		preWrapMode: 2,
		postWrapMode: 2,
	},
};
const DURATION = 3.125;

describe('emissionStream', () => {
	it('spaces a constant rate evenly, a random one by its mean, and emits nothing at 0', () => {
		const steady = emissionStream(constant(4), 5);
		assert.ok(steady !== null);
		assert.equal(steady.timeOf(6), 1.5);
		assert.equal(steady.emitted(1.5), 6);
		assert.equal(emissionStream(between(2, 6), 5)?.mean, 4);
		assert.equal(emissionStream(constant(0), 5), null);
	});

	it('emits a curve by its integral over the loop, the same every loop', () => {
		const stream = emissionStream(pour, DURATION);
		assert.ok(stream !== null);
		assert.equal(stream.peak, 32);
		// the plateau alone holds 32 · 0.652 · 3.125 particles
		const perLoop = stream.emitted(DURATION);
		assert.ok(perLoop > 65 && perLoop < 80);
		assert.ok(Math.abs(stream.mean - perLoop / DURATION) < 1e-9);
		assert.ok(Math.abs(stream.emitted(7 * DURATION + 1) - (7 * perLoop + stream.emitted(1))) < 1e-9);
		let before = -Infinity;
		for (let k = 1; k < 3 * perLoop; k++) {
			const at = stream.timeOf(k);
			assert.ok(at > before);
			before = at;
			assert.ok(Math.abs(stream.emitted(at) - k) < 1e-6);
			// nothing leaves in the loop's dry end
			const u = (at / DURATION) % 1;
			assert.ok(u <= 0.846);
		}
		// on the plateau particles are 1/32 s apart
		const mid = Math.ceil(stream.emitted(0.4 * DURATION));
		assert.ok(Math.abs(stream.timeOf(mid + 1) - stream.timeOf(mid) - 1 / 32) < 1e-6);
	});

	it('emits nothing for a curve that never rises above 0', () => {
		assert.equal(emissionStream({ ...pour, scalar: -1 }, DURATION), null);
	});
});

describe('a system with a rate curve', () => {
	const wheel = system({
		duration: DURATION,
		rate: pour,
		startLifetime: constant(0.25),
		emissionBound: 8,
	});

	it('has particles only while and just after its curve emits', () => {
		const loop = 40 * DURATION;
		// mid-pour, a quarter second of 32 a second
		assert.equal(run(wheel, loop + 0.5 * DURATION).length, 8);
		// the pour stopped at 84.5% of the loop and its last particles lived a quarter second
		assert.equal(run(wheel, loop + 0.93 * DURATION).length, 0);
		assert.equal(run(wheel, loop + 0.99 * DURATION).length, 0);
	});
});
