import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ParticleShapeKind, type ParticleSplineInfo } from '@endfield-noclip/package-format/particles';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { dragged, draggedFall, splinePoint, steppedPath, travelled } from './motion.ts';
import { constant, line, placement, run, system } from './test-systems.ts';

describe('spline paths', () => {
	// Dijiang's central shaft lifts its cargo 70 m up a straight segment whose handles sit on its ends
	const lift: ParticleSplineInfo = {
		kind: 'spline',
		segments: [
			{
				points: [
					[0, -20, 0],
					[0, -20, 0],
					[0, 50, 0],
					[0, 50, 0],
				] as [Vec3, Vec3, Vec3, Vec3],
				length: 70,
			},
		],
		speed: constant(1),
	};
	it('places a distance at its share of the segment as a Bézier parameter, so the lift eases in and out', () => {
		assert.deepEqual(splinePoint(lift, 35)?.position, [0, 15, 0]);
		// smoothstep(0.25) of the way up
		assert.ok(Math.abs((splinePoint(lift, 17.5)?.position[1] ?? 0) - (-20 + 70 * 0.15625)) < 1e-9);
		assert.equal(splinePoint(lift, 70.5), null);
	});
	it('moves particles by the speed along the path, from their box offset', () => {
		const info = system({
			startLifetime: constant(49),
			rate: constant(0.5),
			maxParticles: 26,
			shape: { kind: ParticleShapeKind.Box, ...placement, position: [2, 0, 0], scale: [0, 0, 0] },
			startRotation: [constant(0), constant(0), constant(0)],
			spline: lift,
		});
		const particles = run(info, 1000);
		assert.ok(particles.length > 20);
		for (const { position } of particles) {
			assert.equal(position[0], 2);
			// 49 m of 70 at most
			assert.ok(position[1] >= -20 && position[1] <= -20 + 70 * (3 * 0.7 ** 2 - 2 * 0.7 ** 3) + 1e-4);
		}
	});
	it('drops particles that run off the end within their lifetime', () => {
		const info = system({ startLifetime: constant(200), rate: constant(1), maxParticles: 201, spline: lift });
		assert.ok(run(info, 1000).length <= 71);
	});
});

describe('motion', () => {
	it('integrates a velocity curve over the age', () => {
		// 0 → 2 m/s over a 1 s life covers 1 m
		assert.ok(Math.abs(travelled(line(0, 2), 1, 1, 0) - 1) < 1e-6);
		assert.equal(travelled(constant(3), 2, 10, 0), 6);
	});
	it('slows a launch and caps a fall at the terminal speed under quadratic drag', () => {
		const drag = { kind: 'drag', amount: constant(1), bySize: false, byVelocity: true } as const;
		const [distance, speed] = dragged(drag, 4, 1, 1, 0);
		assert.ok(Math.abs(distance - Math.log1p(4)) < 1e-9);
		assert.ok(Math.abs(speed - 4 / 5) < 1e-9);
		// terminal speed √(g / k) = √9.81
		const [, falling] = draggedFall(drag, 9.81, 1, 100, 0);
		assert.ok(Math.abs(falling - Math.sqrt(9.81)) < 1e-6);
	});
	// the challenge start point's rising stones: 1 m/s up from velocity over lifetime, limited to 0.1 m/s with
	// a dampen of 0.1
	const stones = {
		limit: { info: { kind: 'limit' as const, limit: constant(0.1), dampen: 0.1 }, r: 0 },
		start: [0, 0, 0] as Vec3,
		acceleration: [0, 0, 0] as Vec3,
		push: null,
		extra: (): Vec3 => [0, 1, 0],
		modifier: () => 1,
		life: 3,
	};
	it('pulls the whole speed, extra velocity included, down to the limit', () => {
		const { velocity } = steppedPath({ ...stones, age: 3 });
		// 90 steps at 0.1 of the excess each leave 0.9^90 of it
		assert.ok(Math.abs(velocity[1] - (0.1 + 0.9 * 0.9 ** 90)) < 1e-9);
		const { offset } = steppedPath({ ...stones, age: 0.5 });
		assert.ok(offset[1] > 0.05 && offset[1] < 0.5);
	});
	it('gives the same path whatever the age it is read at', () => {
		const once = steppedPath({ ...stones, age: 2 }).offset[1];
		const again = steppedPath({ ...stones, age: 2 }).offset[1];
		assert.equal(once, again);
	});
	it('steps on from an earlier state to where stepping from birth gets', () => {
		const fresh = steppedPath({ ...stones, age: 2 });
		let state = steppedPath({ ...stones, age: 0.5 }).state;
		for (let age = 0.5 + 1 / 60; age <= 2 + 1e-9; age += 1 / 60) {
			state = steppedPath({ ...stones, age, from: state }).state;
		}
		// frame-sized steps rather than 1/30 s ones differ by a little
		assert.ok(Math.abs(state.offset[1] - fresh.offset[1]) < 5e-3);
		// a state past the age is ignored, so a path read earlier starts again from birth
		const back = steppedPath({ ...stones, age: 0.5, from: fresh.state });
		assert.equal(back.offset[1], steppedPath({ ...stones, age: 0.5 }).offset[1]);
	});
	it('leaves a particle under the limit alone', () => {
		const { offset, velocity } = steppedPath({
			...stones,
			limit: { info: { ...stones.limit.info, limit: constant(5) }, r: 0 },
			age: 2,
		});
		assert.ok(Math.abs(offset[1] - 2) < 1e-9);
		assert.deepEqual(velocity, [0, 1, 0]);
	});
	it('scales each step by the speed modifier at its age, after the limit', () => {
		// the collectible pieces' rings: a 4 m/s push limited to 1 m/s, moved at 1.8 times a modifier falling to
		// 0.24 over their life
		const rings = {
			...stones,
			limit: { info: { ...stones.limit.info, limit: constant(1), dampen: 0.015 }, r: 0 },
			extra: (): Vec3 => [0, 0, -4],
			modifier: (age: number) => 1.8 * (1 - (0.76 * age) / 2),
			life: 2,
		};
		const plain = steppedPath({ ...rings, modifier: () => 1, age: 2 });
		const scaled = steppedPath({ ...rings, age: 2 });
		// the limit sees the same speed, so only the moves differ
		assert.deepEqual(scaled.state.own, plain.state.own);
		assert.ok(Math.abs(scaled.velocity[2] - plain.velocity[2] * 1.8 * 0.24) < 1e-9);
		assert.ok(scaled.offset[2] < 0 && scaled.offset[2] !== plain.offset[2]);
		// a constant modifier moves it that many times as far
		const doubled = steppedPath({ ...rings, modifier: () => 2, age: 2 });
		assert.ok(Math.abs(doubled.offset[2] - 2 * plain.offset[2]) < 1e-9);
	});
});
