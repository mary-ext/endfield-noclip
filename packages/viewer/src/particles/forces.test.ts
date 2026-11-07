import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type MinMaxCurveInfo, ParticleShapeKind } from '@endfield-noclip/package-format/particles';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { applyForces, type ForceRandoms, prepareField } from './forces.ts';
import { PARTICLE_FLOATS, ParticleSimulation } from './simulation.ts';
import { DOWN, between, constant, placement, same, system } from './test-systems.ts';

describe('force fields', () => {
	// Jingyu Valley's fish school: a sphere field 3–15 m out, centred on the emitter, whose +y is the emitter's
	const fish = {
		fromEmitter: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
		startRange: 3,
		endRange: 15,
		gravityFocus: 0,
		rotationRandomness: [0, 0] as [number, number],
		direction: [constant(0), constant(0), constant(0)] as [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo],
		gravity: constant(0.1),
		rotationSpeed: constant(4),
		rotationAttraction: constant(0.05),
		drag: constant(0),
		dragBySize: false,
		dragByVelocity: true,
	};
	const randoms: ForceRandoms = {
		multiplier: 0,
		tiltX: 0.5,
		tiltZ: 0.5,
		direction: [0, 0, 0],
		gravity: 0,
		spin: 0,
		attraction: 0,
		drag: 0,
	};
	const forces = (info: typeof fish) => ({ multiplier: constant(1), fields: [prepareField(info)] });
	it('pulls a particle in by 30 times its gravity per second', () => {
		const own: Vec3 = [0, 0, 0];
		applyForces(forces({ ...fish, rotationSpeed: constant(0) }), [5, 0, 0], own, 0, 1, randoms, 0.1);
		assert.ok(Math.abs(own[0] - -0.1 * 30 * 0.1) < 1e-9);
		assert.equal(own[1], 0);
	});
	it('pulls the velocity towards a swirl about the field’s +y', () => {
		const own: Vec3 = [0, 0, 0];
		applyForces(forces({ ...fish, gravity: constant(0) }), [5, 0, 0], own, 0, 1, randoms, 1 / 30);
		// ŷ × x̂ = −ẑ, 5% of the way to 4 m/s
		assert.ok(Math.abs(own[2] - -0.2) < 1e-9);
		assert.ok(Math.abs(own[0]) < 1e-9);
	});
	it('leaves a particle within the start range or beyond the end alone', () => {
		for (const at of [[1, 0, 0] as Vec3, [20, 0, 0] as Vec3]) {
			const own: Vec3 = [1, 2, 3];
			applyForces(forces(fish), at, own, 0, 1, randoms, 0.1);
			assert.deepEqual(own, [1, 2, 3]);
		}
	});
	it('measures the range in the field’s own frame, its scale included', () => {
		// a field squashed to 0.2 up its y, as the fish's is: 2 m above it is 10 field units
		const squashed = { ...fish, fromEmitter: [1, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
		const own: Vec3 = [0, 0, 0];
		applyForces(forces({ ...squashed, rotationSpeed: constant(0) }), [0, 2, 0], own, 0, 1, randoms, 0.1);
		assert.ok(own[1] < 0);
	});
	it('slows a particle by its speed squared under drag', () => {
		const own: Vec3 = [2, 0, 0];
		const dragging = { ...fish, gravity: constant(0), rotationSpeed: constant(0), drag: constant(0.3) };
		applyForces(forces(dragging), [5, 0, 0], own, 0, 1, randoms, 0.1);
		assert.ok(Math.abs(own[0] - (2 - 0.3 * 4 * 0.1)) < 1e-9);
	});
	it('keep a school launched outwards circling within the field', () => {
		// the fish burst from a 3 m ring at 1 m/s outwards, in the emitter's xz plane, held past their lifetime
		const school = system({
			looping: false,
			startLifetime: between(5, 10),
			rate: constant(0),
			bursts: [{ time: 0, count: constant(20), cycles: 1, interval: 0.01, probability: 1 }],
			maxParticles: 50,
			ringBuffer: { loop: false, loopRange: [0, 1] },
			startSpeed: constant(1),
			gravityModifier: constant(0),
			shape: {
				kind: ParticleShapeKind.Cone,
				radius: 3,
				radiusThickness: 0,
				arc: 360,
				angle: 90,
				...placement,
				rotation: [90, 0, 0],
			},
			forces: {
				multiplier: constant(1),
				fields: [{ ...fish, rotationSpeed: between(-4, 4), drag: constant(0.3) }],
			},
		});
		const simulation = new ParticleSimulation(school, 3);
		const out = new Float32Array(64 * PARTICLE_FLOATS);
		let count = 0;
		for (let time = 0; time <= 60; time += 1 / 30) {
			count = simulation.evaluate(time, DOWN, same, out);
		}
		assert.equal(count, 20);
		for (let i = 0; i < count; i++) {
			const p = out.subarray(i * PARTICLE_FLOATS, i * PARTICLE_FLOATS + 3);
			assert.ok(Math.hypot(p[0], p[1], p[2]) < 15, `fish ${i} left the field`);
		}
	});
});
