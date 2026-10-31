import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	CurveMode,
	type MinMaxCurveInfo,
	ParticleAlignment,
	ParticleShapeKind,
	type ParticleSystemInfo,
} from '@endfield-noclip/package-format/particles';

import type { Vec3 } from '../scene/camera.ts';

import { PARTICLE_FLOATS, ParticleSimulation, evaluateMinMax } from './particles.ts';

const constant = (value: number): MinMaxCurveInfo => ({
	mode: CurveMode.Constant,
	scalar: value,
	min: 0,
	curve: null,
	minCurve: null,
});

const between = (min: number, max: number): MinMaxCurveInfo => ({
	mode: CurveMode.TwoConstants,
	scalar: max,
	min,
	curve: null,
	minCurve: null,
});

const line = (from: number, to: number): MinMaxCurveInfo => ({
	mode: CurveMode.Curve,
	scalar: 1,
	min: 0,
	curve: {
		keys: [
			{
				time: 0,
				value: from,
				inSlope: to - from,
				outSlope: to - from,
				weightedMode: 0,
				inWeight: 0,
				outWeight: 0,
			},
			{
				time: 1,
				value: to,
				inSlope: to - from,
				outSlope: to - from,
				weightedMode: 0,
				inWeight: 0,
				outWeight: 0,
			},
		],
		preWrapMode: 2,
		postWrapMode: 2,
	},
	minCurve: null,
});

const system = (overrides: Partial<ParticleSystemInfo> = {}): ParticleSystemInfo => ({
	duration: 5,
	looping: true,
	startDelay: 0,
	maxParticles: 150,
	simulationSpeed: 1,
	startLifetime: constant(80),
	startSpeed: constant(0),
	startSize: [constant(4), constant(4), constant(4)],
	startRotation: [constant(0), constant(0), between(0, Math.PI * 2)],
	gravityModifier: constant(-0.01),
	rate: constant(1),
	bursts: [],
	shape: {
		kind: ParticleShapeKind.Cone,
		radius: 65,
		radiusThickness: 0.5,
		angle: 2,
		length: 5,
		arc: 360,
		position: [0, 0, 0],
		rotation: [0, 0, 0],
		scale: [1, 1, 1],
		randomDirection: 0,
		sphericalDirection: 0,
		randomPosition: 0,
	},
	velocity: null,
	sizeOverLifetime: null,
	rotationOverLifetime: null,
	alignment: ParticleAlignment.View,
	pivot: [0, 0, 0],
	meshWeights: [1],
	mesh: 0,
	...overrides,
});

/** the emitter's z is the world's up, as on the crater's rock emitters, so the cone's base lies flat */
const DOWN: Vec3 = [0, 0, -1];
const same = (direction: Vec3): Vec3 => direction;

/** @returns the live particles' positions, rotations and sizes */
const run = (info: ParticleSystemInfo, time: number, seed = 7) => {
	const out = new Float32Array(1024 * PARTICLE_FLOATS);
	const count = new ParticleSimulation(info, seed).evaluate(time, DOWN, same, out);
	return Array.from({ length: count }, (_, i) => ({
		position: Array.from(out.subarray(i * PARTICLE_FLOATS, i * PARTICLE_FLOATS + 3)),
		size: Array.from(out.subarray(i * PARTICLE_FLOATS + 7, i * PARTICLE_FLOATS + 10)),
	}));
};

describe('evaluateMinMax', () => {
	it('reads constants, curves and the random ends of either', () => {
		assert.equal(evaluateMinMax(constant(3), 0.5, 0.9), 3);
		assert.equal(evaluateMinMax(between(2, 4), 0.5, 0.25), 2.5);
		assert.equal(evaluateMinMax(line(1, 0), 0.25, 0), 0.75);
		const curves: MinMaxCurveInfo = {
			...line(1, 1),
			mode: CurveMode.TwoCurves,
			scalar: 2,
			minCurve: line(0, 0).curve,
		};
		assert.equal(evaluateMinMax(curves, 0.5, 0.5), 1);
	});
});

describe('ParticleSimulation', () => {
	it('keeps a settled looping system at its rate times its lifetime, rising under negative gravity', () => {
		const particles = run(system(), 1000);
		// one per second for 80 seconds
		assert.ok(particles.length >= 79 && particles.length <= 81);
		for (const { position } of particles) {
			// on the cone's base ring, between half the radius and the radius, then lifted along z
			const radius = Math.hypot(position[0], position[1]);
			assert.ok(radius >= 32.5 - 1e-3 && radius <= 65 + 1e-3);
			assert.ok(position[2] >= 0);
		}
		// the oldest has risen ½ · 9.81 · 0.01 · 80² m at most
		const highest = Math.max(...particles.map(({ position }) => position[2]));
		assert.ok(highest <= 0.5 * 9.81 * 0.01 * 80 * 80 + 1e-3);
		assert.ok(highest > 0.5 * 9.81 * 0.01 * 78 * 78);
	});

	it('gives the same particles for the same seed and time, and others for another seed', () => {
		assert.deepEqual(run(system(), 500), run(system(), 500));
		assert.notDeepEqual(run(system(), 500, 1), run(system(), 500, 2));
	});

	it('splits particles between the entries drawing each of a renderer mesh', () => {
		const all = run(system(), 1000).length;
		const first = run(system({ meshWeights: [1, 3], mesh: 0 }), 1000);
		const second = run(system({ meshWeights: [1, 3], mesh: 1 }), 1000);
		assert.equal(first.length + second.length, all);
		assert.ok(first.length < second.length);
	});

	it('plays a burst once when not looping, and shrinks particles by the size over lifetime', () => {
		const once = system({
			looping: false,
			duration: 2,
			rate: constant(0),
			startLifetime: constant(10),
			bursts: [{ time: 0, count: constant(30), cycles: 1, interval: 0.01, probability: 1 }],
			sizeOverLifetime: [line(1, 0), line(1, 0), line(1, 0)],
		});
		const early = run(once, 2.5);
		assert.equal(early.length, 30);
		// a quarter of the way through its life, the size is three quarters of the start size
		for (const { size } of early) {
			assert.ok(Math.abs(size[0] - 3) < 1e-3);
		}
		assert.equal(run(once, 10.5).length, 0);
	});

	it('caps the live particles at the system maximum', () => {
		assert.equal(run(system({ maxParticles: 20 }), 1000).length, 20);
	});

	it('orbits particles about the emitter axis without changing their distance from it', () => {
		const still = run(system({ gravityModifier: constant(0) }), 1000);
		const orbiting = run(
			system({
				gravityModifier: constant(0),
				velocity: {
					linear: [constant(0), constant(0), constant(0)],
					linearInWorld: false,
					orbital: [constant(0), constant(0), constant(0.05)],
					orbitalOffset: [0, 0, 0],
					radial: constant(0),
					speedModifier: constant(1),
				},
			}),
			1000,
		);
		assert.equal(orbiting.length, still.length);
		let moved = 0;
		for (const [i, { position }] of orbiting.entries()) {
			const before = still[i].position;
			assert.ok(Math.abs(Math.hypot(position[0], position[1]) - Math.hypot(before[0], before[1])) < 1e-2);
			moved += Math.hypot(position[0] - before[0], position[1] - before[1]);
		}
		assert.ok(moved > 1);
	});
});
