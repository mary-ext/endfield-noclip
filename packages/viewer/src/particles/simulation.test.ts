import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	type MinMaxCurveInfo,
	type ParticleClampInfo,
	ParticleMeshPlacement,
	ParticleMeshSpawn,
	ParticleRenderMode,
	ParticleShapeKind,
	ParticleSubEmitterProperty,
	ParticleSubEmitterType,
} from '@endfield-noclip/package-format/particles';

import { compareNumbers } from '../math/compare.ts';

import {
	PARTICLE_FLOATS,
	ParticleSimulation,
	ringBufferAge,
	TRAIL_POINT_FLOATS,
	TRAIL_POINTS,
	TrailFloat,
} from './simulation.ts';
import { DOWN, constant, line, placement, run, same, sheet, system, trailed } from './test-systems.ts';

describe('ringBufferAge', () => {
	it('holds a particle at its end, or replays its loop range', () => {
		assert.equal(ringBufferAge(0.5, null), 0.5);
		assert.equal(ringBufferAge(3.2, null), 1);
		assert.equal(ringBufferAge(0.5, [0.2, 0.8]), 0.5);
		assert.ok(Math.abs(ringBufferAge(1.1, [0.2, 0.8]) - 0.5) < 1e-9);
		assert.ok(Math.abs(ringBufferAge(1.25, [0, 1]) - 0.25) < 1e-9);
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

	it('skips emissions while the system is full, so a capped particle lives out its lifetime', () => {
		// the Very Large Rift's ripple walls: a burst every 0.1 s loop, one particle allowed, living 6 s
		const ripple = system({
			duration: 0.1,
			maxParticles: 1,
			rate: constant(0),
			startLifetime: constant(6),
			bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
			shape: null,
			gravityModifier: constant(0),
			sizeOverLifetime: [line(0, 1), line(0, 1), line(0, 1)],
		});
		const simulation = new ParticleSimulation(ripple, 7);
		const out = new Float32Array(PARTICLE_FLOATS);
		const sizes: number[] = [];
		for (let time = 30; time < 48; time += 0.25) {
			assert.equal(simulation.evaluate(time, DOWN, same, out), 1);
			sizes.push(out[7]);
		}
		// one ring grows for its 6 s before the next starts (at the first loop after), so the size drops two or
		// three times in 18 s, not every loop
		const drops = sizes.filter((size, i) => i > 0 && size < sizes[i - 1]).length;
		assert.ok(drops >= 2 && drops <= 3, `${drops} restarts`);
	});

	it('plays a full system forward to its first free slot instead of through every emission it turns away', () => {
		// a stream of ten million a second capped at one particle, as some of map02's effects are authored
		const flood = system({
			duration: 5,
			maxParticles: 1,
			rate: constant(1e7),
			startLifetime: constant(5),
			bursts: [],
			shape: null,
			gravityModifier: constant(0),
		});
		const simulation = new ParticleSimulation(flood, 3);
		const out = new Float32Array(PARTICLE_FLOATS);
		const started = performance.now();
		for (let time = 10; time < 30; time += 0.5) {
			assert.equal(simulation.evaluate(time, DOWN, same, out), 1);
		}
		assert.ok(performance.now() - started < 200, 'plays forward in steps of a lifetime');
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

	it('orbits particles by the integral of an orbital curve over their age', () => {
		// Jingyu's drifting petals (p_fxmap_map02_lv001_flower_801) spin up about z over their lifetime
		const orbiting = (orbitalZ: MinMaxCurveInfo) =>
			run(
				system({
					gravityModifier: constant(0),
					looping: false,
					rate: constant(0),
					startLifetime: constant(1),
					bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
					velocity: {
						linear: [constant(0), constant(0), constant(0)],
						linearInWorld: false,
						orbital: [constant(0), constant(0), orbitalZ],
						orbitalOffset: [0, 0, 0],
						radial: constant(0),
						speedModifier: constant(1),
					},
				}),
				0.5,
			)[0].position;
		const still = orbiting(constant(0));
		// 0 rad/s at birth to 2 rad/s at death: a quarter radian halfway
		const turned = orbiting(line(0, 2));
		const angle = Math.atan2(turned[1], turned[0]) - Math.atan2(still[1], still[0]);
		assert.ok(Math.abs(angle - 0.25) < 1e-4, `${angle}`);
		assert.ok(Math.abs(Math.hypot(turned[0], turned[1]) - Math.hypot(still[0], still[1])) < 1e-5);
	});

	it('starts donut particles inside its tube, the outer part its thickness allows', () => {
		const donut = run(
			system({
				gravityModifier: constant(0),
				looping: false,
				rate: constant(0),
				startLifetime: constant(10),
				bursts: [{ time: 0, count: constant(100), cycles: 1, interval: 0.01, probability: 1 }],
				shape: {
					kind: ParticleShapeKind.Donut,
					radius: 1,
					radiusThickness: 0.4,
					arc: 360,
					donutRadius: 0.2,
					...placement,
				},
			}),
			0.5,
		);
		assert.equal(donut.length, 100);
		for (const { position } of donut) {
			// distance from the circle of radius 1 in the xy plane
			const tube = Math.hypot(Math.hypot(position[0], position[1]) - 1, position[2]);
			assert.ok(tube >= 0.2 * 0.6 - 1e-4 && tube <= 0.2 + 1e-4, `${tube}`);
		}
	});

	it('starts mesh-shape particles on the mesh, scaled by the shape and tinted by its vertex colours', () => {
		const info = system({
			gravityModifier: constant(0),
			looping: false,
			rate: constant(0),
			startLifetime: constant(10),
			bursts: [{ time: 0, count: constant(20), cycles: 1, interval: 0.01, probability: 1 }],
			shape: {
				kind: ParticleShapeKind.Mesh,
				...placement,
				scale: [2, 2, 2],
				mesh: {
					placement: ParticleMeshPlacement.Vertex,
					spawn: ParticleMeshSpawn.Random,
					spread: 0,
					normalOffset: 0,
					positions: [1, 0, 0, 0, 1, 0],
					normals: null,
					colors: [255, 0, 0, 255, 255, 0, 0, 255],
					corners: 2,
					primitives: [0, 1],
				},
			},
		});
		const out = new Float32Array(1024 * PARTICLE_FLOATS);
		const count = new ParticleSimulation(info, 7).evaluate(0.5, DOWN, same, out);
		assert.equal(count, 20);
		for (let i = 0; i < count; i++) {
			const at = i * PARTICLE_FLOATS;
			const [x, y] = out.subarray(at, at + 2);
			// one of the two vertices, twice as far out
			assert.ok(Math.abs(Math.max(x, y) - 2) < 1e-6 && Math.abs(Math.min(x, y)) < 1e-6, `${x} ${y}`);
			assert.deepEqual(Array.from(out.subarray(at + 11, at + 15)), [1, 0, 0, 1]);
		}
	});

	it('steps a burst through the vertices in Loop mode, one particle per vertex', () => {
		// Wuling's tower lamps (`p_fxmap_map02_lv002_citywall_lighting_02`) burst one particle per lamp onto a mesh
		// of their positions
		const positions = [1, 0, 0, 0, 1, 0, 0, 0, 1, -1, 0, 0];
		const info = system({
			gravityModifier: constant(0),
			duration: 1,
			rate: constant(0),
			startLifetime: constant(10),
			bursts: [{ time: 0, count: constant(4), cycles: 1, interval: 0.01, probability: 1 }],
			shape: {
				kind: ParticleShapeKind.Mesh,
				...placement,
				mesh: {
					placement: ParticleMeshPlacement.Vertex,
					spawn: ParticleMeshSpawn.Loop,
					spread: 0,
					normalOffset: 0,
					positions,
					normals: null,
					colors: null,
					corners: 2,
					primitives: [0, 1, 2, 3],
				},
			},
		});
		// later loops start where the earlier ones left off, which with 4 particles is the first vertex again
		for (const time of [0.5, 3.5]) {
			const out = new Float32Array(1024 * PARTICLE_FLOATS);
			const count = new ParticleSimulation(info, 7).evaluate(time, DOWN, same, out);
			const picked = [];
			for (let i = 0; i < count; i++) {
				const p = Array.from(out.subarray(i * PARTICLE_FLOATS, i * PARTICLE_FLOATS + 3), Math.round);
				picked.push(
					positions.findIndex((_, v) => v % 3 === 0 && p.every((c, a) => c === positions[v + a])) / 3,
				);
			}
			// each loop's burst covers every vertex once
			const perLoop = new Map<number, number>();
			for (const v of picked) {
				perLoop.set(v, (perLoop.get(v) ?? 0) + 1);
			}
			assert.deepEqual(
				// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
				[...perLoop.keys()].sort(compareNumbers),
				[0, 1, 2, 3],
			);
			assert.ok([...perLoop.values()].every((n) => n === perLoop.get(0)));
		}
	});

	it('turns particles by the integral of a rotation curve over their age', () => {
		const spinning = run(
			system({
				gravityModifier: constant(0),
				looping: false,
				rate: constant(0),
				startLifetime: constant(1),
				startRotation: [constant(0), constant(0), constant(0)],
				bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
				// 0 rad/s at birth to 2 rad/s at death: 1 rad by the end, a quarter of that halfway
				rotationOverLifetime: [constant(0), constant(0), line(0, 2)],
			}),
			0.5,
		);
		assert.equal(spinning.length, 1);
		assert.ok(Math.abs(spinning[0].rotation[2] - Math.sin(0.25 / 2)) < 1e-4);
	});

	it('moves particles by their velocity times a speed modifier curve integrated over their age', () => {
		// the floating stones of Valley's Aberrants (`floatstone01`) rise at a constant speed that their speed
		// modifier ramps up over their lifetime
		const rising = (speedModifier: MinMaxCurveInfo) =>
			run(
				system({
					gravityModifier: constant(0),
					looping: false,
					rate: constant(0),
					startLifetime: constant(1),
					shape: null,
					bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
					velocity: {
						linear: [constant(0), constant(0), constant(1)],
						linearInWorld: false,
						orbital: [constant(0), constant(0), constant(0)],
						orbitalOffset: [0, 0, 0],
						radial: constant(0),
						speedModifier,
					},
				}),
				0.5,
			);
		// 0 at birth to 2 at death: ∫₀^½ 2a da = ¼ m by halfway
		const [ramped] = rising(line(0, 2));
		assert.ok(Math.abs(ramped.position[2] - 0.25) < 1e-6, `${ramped.position[2]}`);
		const [steady] = rising(constant(2));
		assert.ok(Math.abs(steady.position[2] - 1) < 1e-6, `${steady.position[2]}`);
	});

	it('scales the fall by the speed modifier, as gravity builds up in the velocity it scales', () => {
		const falling = (speedModifier: MinMaxCurveInfo) =>
			run(
				system({
					gravityModifier: constant(1),
					looping: false,
					rate: constant(0),
					startLifetime: constant(1),
					shape: null,
					bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
					velocity: {
						linear: [constant(0), constant(0), constant(0)],
						linearInWorld: false,
						orbital: [constant(0), constant(0), constant(0)],
						orbitalOffset: [0, 0, 0],
						radial: constant(0),
						speedModifier,
					},
				}),
				0.5,
			);
		// down is the emitter's −z here. ∫₀^½ g·a·2a da = g / 12 for a modifier from 0 to 2, and ½ g ¼ · 2 =
		// g / 4 for a constant 2
		const [ramped] = falling(line(0, 2));
		assert.ok(Math.abs(ramped.position[2] + 9.81 / 12) < 1e-6, `${ramped.position[2]}`);
		const [steady] = falling(constant(2));
		assert.ok(Math.abs(steady.position[2] + 9.81 / 4) < 1e-6, `${steady.position[2]}`);
	});

	it('steps drag against velocity-module orbital motion instead of spinning undragged', () => {
		// Jingyu waterfall splashes (`shuihua`): strong orbitalX + drag with dampen=0; Unity applies drag to the
		// combined velocity (own + orbital) and subtracts it from own velocity
		const orbital = (clamp: ParticleClampInfo | null) =>
			system({
				looping: false,
				startLifetime: constant(2),
				rate: constant(0),
				bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
				startSpeed: constant(0),
				gravityModifier: constant(0),
				startSize: [constant(2), constant(2), constant(2)],
				shape: {
					kind: ParticleShapeKind.Box,
					position: [0, 5, 0],
					rotation: [0, 0, 0],
					scale: [0, 0, 0],
					randomDirection: 0,
					sphericalDirection: 0,
					randomPosition: 0,
				},
				velocity: {
					linear: [constant(0), constant(0), constant(0)],
					linearInWorld: false,
					orbital: [constant(10), constant(0), constant(0)],
					orbitalOffset: [0, 0, 0],
					radial: constant(0),
					speedModifier: constant(1),
				},
				clamp,
			});
		const [undragged] = run(orbital(null), 1);
		const [dragged] = run(
			orbital({ kind: 'drag', amount: constant(0.1), bySize: true, byVelocity: true }),
			1,
		);
		// undragged orbits at r = 5 m around x (10 rad ≈ 1.6 turns, landing at y = 5·cos(10) ≈ -4.2); with s²
		// drag on combined speed, drag brakes the orbital motion so the particle spirals inward and stays on +y
		assert.ok(Math.abs(Math.hypot(undragged.position[1], undragged.position[2]) - 5) < 1e-3);
		assert.ok(undragged.position[1] < 0, `expected undragged y < 0, got ${undragged.position[1]}`);
		assert.ok(dragged.position[1] > 0, `expected dragged y > 0, got ${dragged.position[1]}`);
		assert.ok(
			Math.hypot(dragged.position[1], dragged.position[2]) < 4,
			`expected dragged radius < 4, got ${Math.hypot(dragged.position[1], dragged.position[2])}`,
		);
	});
});

describe('ring buffers', () => {
	it('move a paused particle on past its lifetime', () => {
		const info = system({
			looping: false,
			startLifetime: constant(1),
			rate: constant(0),
			bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
			ringBuffer: { loop: false, loopRange: [0, 1] },
			startSpeed: constant(1),
			gravityModifier: constant(0),
			shape: null,
		});
		const [particle] = run(info, 5);
		assert.ok(Math.abs(particle.position[2] - 5) < 1e-6);
	});

	it('let a looping particle that a newer one replaces live out its cycle, where a paused one goes', () => {
		// Wuling City's bamboo smoke, simplified: more emissions than its cap within a lifetime, each puff
		// shrinking to nothing over its life
		const smoke = system({
			maxParticles: 1,
			startLifetime: constant(4),
			sizeOverLifetime: [line(1, 0), line(1, 0), line(1, 0)],
			ringBuffer: { loop: true, loopRange: [0, 1] },
		});
		// one a second: the newest keeps its slot, and each older one was swapped out a second into its life
		// and has aged on since, until it ends four seconds after its emission
		const sizes = run(smoke, 100.5).map(({ size }) => size[0]);
		assert.deepEqual(
			sizes.map((size) => Math.round(size * 1000) / 1000),
			[3.5, 2.5, 1.5, 0.5],
		);
		assert.equal(run({ ...smoke, ringBuffer: { loop: false, loopRange: [0, 1] } }, 100.5).length, 1);
		// with a cap of 0 every particle is swapped out as it's emitted, so it lives once and never loops
		assert.equal(run({ ...smoke, maxParticles: 0 }, 100.5).length, 4);
	});

	it('lays a trail through where its particle was, back over the trail lifetime or to its birth', () => {
		const points = (info = trailed(), time = 1) => {
			const simulation = new ParticleSimulation(info, 7);
			const particles = new Float32Array(PARTICLE_FLOATS);
			assert.equal(simulation.evaluate(time, DOWN, same, particles), 1);
			const out = new Float32Array(TRAIL_POINTS * TRAIL_POINT_FLOATS);
			const count = simulation.trailPoints(0, particles, out);
			return Array.from({ length: count }, (_, k) => {
				const at = k * TRAIL_POINT_FLOATS;
				return {
					z: out[at + TrailFloat.position + 2],
					width: out[at + TrailFloat.width],
					alpha: out[at + TrailFloat.color + 3],
				};
			});
		};
		const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-5, `${a} ≠ ${b}`);
		// half of its 2 s lifetime: from the particle at 1 m back to 0.5 m, narrowing as it goes
		const trail = points();
		assert.equal(trail.length, TRAIL_POINTS);
		near(trail[0].z, 1);
		near(trail[TRAIL_POINTS - 1].z, 0.5);
		near(trail[0].width, 0.1);
		near(trail[TRAIL_POINTS - 1].width, 0.05);
		near(trail[0].alpha, 0.5);
		// a young particle's trail reaches back only to its birth
		const young = points(trailed(), 0.2);
		near(young[TRAIL_POINTS - 1].z, 0);
		near(young[TRAIL_POINTS - 1].width, 0.05);
		// a paused ring buffer keeps moving past its lifetime, and its trail follows its actual motion
		const paused = points({ ...trailed(), ringBuffer: { loop: false, loopRange: [0, 1] } }, 5);
		assert.equal(paused.length, TRAIL_POINTS);
		near(paused[0].z, 5);
		near(paused[TRAIL_POINTS - 1].z, 4.5);
		// and a particle the ratio leaves out has none
		const none = trailed();
		assert.equal(
			points({ ...none, trail: none.trail === null ? null : { ...none.trail, ratio: 0 } }).length,
			0,
		);
	});

	it('spawns birth sub-emitter particles at parent positions and outlives a capped short-lived parent', () => {
		// mirrors p_fxmap_map_spark_02: RenderMode.None capped parent (life 0.15s, max 1) -> child bursts (life 2s)
		const still = {
			kind: 'free' as const,
			startSpeed: constant(0),
			gravityModifier: constant(0),
			velocity: null,
			clamp: null,
			forces: null,
		};
		const parent = system({
			renderMode: ParticleRenderMode.None,
			maxParticles: 1,
			emissionBound: 2,
			duration: 1,
			looping: true,
			startLifetime: constant(0.15),
			rate: constant(4),
			shape: null,
			motion: still,
		});
		const fromParent = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, -2, 5, 1];
		const child = system({
			looping: false,
			duration: 1,
			maxParticles: 100,
			emissionBound: 3,
			startLifetime: constant(2),
			rate: constant(0),
			bursts: [{ time: 0, count: constant(3), cycles: 1, interval: 0.01, probability: 1 }],
			shape: null,
			motion: still,
			subEmitter: {
				parent,
				fromParent,
				type: ParticleSubEmitterType.Birth,
				properties: ParticleSubEmitterProperty.Duration,
				probability: 1,
			},
		});
		const sim = new ParticleSimulation(child, 11);
		assert.equal(sim.loops, true);
		const live = run(child, 5.1);
		// parent emits every 0.25 s (capped at 1, life 0.15 s), so ~8 parent births in the 2 s child window × 3 = 24
		assert.ok(live.length >= 20, `expected >= 20 live sparks, got ${live.length}`);
		for (const p of live) {
			assert.ok(Math.abs(p.position[0] - 3) < 1e-4);
			assert.ok(Math.abs(p.position[1] + 2) < 1e-4);
			assert.ok(Math.abs(p.position[2] - 5) < 1e-4);
		}
	});

	it('inherits size and lifetime on sub-emitters and supports multi-level chains', () => {
		const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
		const grandparent = system({
			looping: true,
			duration: 2,
			maxParticles: 10,
			emissionBound: 10,
			startLifetime: constant(1),
			startSize: [constant(2), constant(2), constant(2)],
			rate: constant(0),
			bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
			shape: null,
		});
		const parent = system({
			looping: false,
			duration: 1,
			maxParticles: 10,
			emissionBound: 10,
			startLifetime: constant(0.001),
			startSize: [constant(0.5), constant(0.5), constant(0.5)],
			rate: constant(0),
			bursts: [{ time: 0, count: constant(1), cycles: 1, interval: 0.01, probability: 1 }],
			shape: null,
			subEmitter: {
				parent: grandparent,
				fromParent: identity,
				type: ParticleSubEmitterType.Birth,
				properties: ParticleSubEmitterProperty.Size | ParticleSubEmitterProperty.Lifetime,
				probability: 1,
			},
		});
		// parent inherits size 2 (0.5 * 2 = 1) and lifetime 1 s from grandparent
		const mid = run(parent, 2.5);
		assert.equal(mid.length, 1);
		assert.ok(Math.abs(mid[0].size[0] - 1) < 1e-4);

		const child = system({
			looping: false,
			duration: 1,
			maxParticles: 10,
			emissionBound: 10,
			startLifetime: constant(0.5),
			rate: constant(0),
			bursts: [{ time: 0, count: constant(2), cycles: 1, interval: 0.01, probability: 1 }],
			shape: null,
			subEmitter: {
				parent,
				fromParent: identity,
				type: ParticleSubEmitterType.Birth,
				properties: 0,
				probability: 1,
			},
		});
		const leaf = run(child, 2.25);
		assert.equal(leaf.length, 2);
	});
});
