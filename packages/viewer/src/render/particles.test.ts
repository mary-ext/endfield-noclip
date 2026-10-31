import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	CurveMode,
	type MinMaxCurveInfo,
	ParticleAlignment,
	ParticleShapeKind,
	type ParticleSystemInfo,
	type ParticleTextureSheetInfo,
	SheetRow,
} from '@endfield-noclip/package-format/particles';

import type { Vec3 } from '../scene/camera.ts';

import { RowKind, packRowColor, rowInfo } from './instance-rows.ts';
import {
	PARTICLE_FLOATS,
	ParticleSimulation,
	evaluateMinMax,
	ringBufferAge,
	sheetTile,
} from './particles.ts';

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
	startColor: [1, 1, 1, 1],
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
	ringBuffer: null,
	textureSheet: null,
	...overrides,
});

const sheet = (overrides: Partial<ParticleTextureSheetInfo> = {}): ParticleTextureSheetInfo => ({
	tiles: [8, 8],
	row: null,
	frameOverTime: { ...line(0, 1), scalar: 0.9999 },
	fps: 30,
	startFrame: constant(0),
	cycles: 1,
	uvChannels: 3,
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
		tile: out[i * PARTICLE_FLOATS + 10],
	}));
};

describe('ringBufferAge', () => {
	it('holds a particle at its end, or replays its loop range', () => {
		assert.equal(ringBufferAge(0.5, null), 0.5);
		assert.equal(ringBufferAge(3.2, null), 1);
		assert.equal(ringBufferAge(0.5, [0.2, 0.8]), 0.5);
		assert.ok(Math.abs(ringBufferAge(1.1, [0.2, 0.8]) - 0.5) < 1e-9);
		assert.ok(Math.abs(ringBufferAge(1.25, [0, 1]) - 0.25) < 1e-9);
	});
});

describe('sheetTile', () => {
	const r = () => 0.5;
	it('steps through the whole sheet over the lifetime, cycles times', () => {
		assert.equal(sheetTile(sheet(), 0, 0, 0, r, 0), 0);
		assert.equal(sheetTile(sheet(), 0.5, 0, 0, r, 0), 31);
		assert.equal(sheetTile(sheet(), 1, 0, 0, r, 0), 63);
		assert.equal(sheetTile(sheet({ cycles: 2 }), 0.75, 0, 0, r, 0), 31);
	});

	it('steps by frames per second, and along a single row', () => {
		// 30 fps through 64 frames: one second in, the 30th frame, wrapping after 64
		assert.equal(sheetTile(sheet({ frameOverTime: null }), 0, 1, 0, r, 0), 30);
		assert.equal(sheetTile(sheet({ frameOverTime: null }), 0, 3, 0, r, 0), 90 % 64);
		assert.equal(sheetTile(sheet({ row: 2 }), 0.5, 0, 0, r, 0), 2 * 8 + 3);
		assert.equal(sheetTile(sheet({ row: SheetRow.MeshIndex }), 0, 0, 0, r, 1), 8);
		assert.equal(sheetTile(sheet({ row: SheetRow.Random }), 0, 0, 0, r, 0), 4 * 8);
	});

	it('packs into the row info word next to the row kind', () => {
		const info = rowInfo(RowKind.Detail, [8, 4], 63, 1);
		assert.equal(info & 0xf, RowKind.Detail);
		assert.equal(((info >>> 4) & 63) + 1, 8);
		assert.equal(((info >>> 10) & 63) + 1, 4);
		assert.equal((info >>> 16) & 0xfff, 63);
		assert.equal(info >>> 28, 1);
		assert.equal(packRowColor([1, 0, 0.5, 0.25]), (64 << 24) | (128 << 16) | 255);
	});
});

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

	it('keeps a ring-buffered particle past its lifetime until the next replaces it, flipping its sheet', () => {
		// the campfire flames: one particle per two-second loop, living two seconds, through an 8×8 sheet
		const flame = system({
			duration: 2,
			maxParticles: 1,
			rate: constant(0),
			startLifetime: constant(2),
			bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
			shape: null,
			gravityModifier: constant(0),
			ringBuffer: { loop: false, loopRange: [0, 1] },
			textureSheet: sheet(),
		});
		const tiles = [100.25, 101, 101.75].map((time) => {
			const particles = run(flame, time);
			assert.equal(particles.length, 1);
			return particles[0].tile;
		});
		// an eighth of the way through: 0.9999 · ⅛ · 64 frames, just short of the 8th
		assert.deepEqual(tiles, [7, 31, 55]);
		// a longer loop than the lifetime holds the last tile until the next emission
		const held = run({ ...flame, duration: 3 }, 3 * 40 + 2.5);
		assert.equal(held.length, 1);
		assert.equal(held[0].tile, 63);
		// without the ring buffer the particle is gone by then
		assert.equal(run({ ...flame, duration: 3, ringBuffer: null }, 3 * 40 + 2.5).length, 0);
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
