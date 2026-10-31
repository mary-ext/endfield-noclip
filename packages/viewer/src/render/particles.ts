/**
 * plays the package's mesh particle systems. a system's particles each follow from their emission time and
 * their own random values (a hash of the emitter and the particle's index), so any moment can be evaluated on
 * its own: {@link ParticleSimulation} lists the particles alive at a system time, and {@link ParticleField}
 * writes them as instance rows next to the blocks, which the mesh selection then buckets like any instance.
 *
 * the game's random draws can't be reproduced, so particles start in other places than in the game, with the
 * same distributions. looping systems are shown as if they had played for a while; others start when their
 * emitter is first drawn.
 *
 * @module
 */

import {
	CurveMode,
	type MinMaxCurveInfo,
	ParticleAlignment,
	ParticleShapeKind,
	type ParticleSystemInfo,
	type ParticlesTable,
} from '@endfield-noclip/package-format/particles';

import type { RangeAllocation } from '../gfx/range-allocator.ts';
import type { Vec3 } from '../scene/camera.ts';
import type { ResidentInstances } from '../streaming/stream-manager.ts';

import { ROW_WORDS, RowKind } from './instance-rows.ts';
import { evaluateCurve } from './lens-flare-layout.ts';

/** Unity's gravity, m/s² */
const GRAVITY = 9.81;

/** floats per particle in {@link ParticleSimulation.evaluate}'s output: position, rotation (xyzw), size */
export const PARTICLE_FLOATS = 10;

/** the most particles one emitter shows */
const MAX_PARTICLES = 1024;

// #region randomness

/** @returns a well-mixed 32-bit hash of two 32-bit values (a PCG-style permutation) */
const hash2 = (a: number, b: number): number => {
	let h = Math.imul(a ^ 0x9e37_79b9, 0x85eb_ca6b) ^ Math.imul(b + 0x7f4a_7c15, 0xc2b2_ae35);
	h = Math.imul(h ^ (h >>> 16), 0x7feb_352d);
	h = Math.imul(h ^ (h >>> 15), 0x846c_a68b);
	return (h ^ (h >>> 16)) >>> 0;
};

/** @returns a value in [0, 1) for one particle and one of its random channels */
const random = (seed: number, particle: number, channel: number): number =>
	hash2(hash2(seed, particle), channel) / 4_294_967_296;

/** the random channels a particle draws from */
const Channel = {
	Lifetime: 0,
	Speed: 1,
	Size: 2,
	RotationX: 3,
	RotationY: 4,
	RotationZ: 5,
	Gravity: 6,
	Mesh: 7,
	Shape0: 8,
	Shape1: 9,
	Shape2: 10,
	Direction0: 11,
	Direction1: 12,
	Position0: 13,
	Position1: 14,
	Position2: 15,
	VelocityX: 16,
	VelocityY: 17,
	VelocityZ: 18,
	OrbitalX: 19,
	OrbitalY: 20,
	OrbitalZ: 21,
	Radial: 22,
	SpeedModifier: 23,
	SpinX: 24,
	SpinY: 25,
	SpinZ: 26,
	SizeOverLifetime: 27,
	Burst: 28,
} as const;

/**
 * @param seed text to hash
 * @returns a 32-bit FNV-1a hash
 */
export const hashText = (seed: string): number => {
	let h = 0x811c_9dc5;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 0x0100_0193);
	}
	return h >>> 0;
};

// #endregion

// #region evaluation

/**
 * @param curve a MinMaxCurve
 * @param time where curves are read, 0–1
 * @param r the random value choosing between the two ends, 0–1
 * @returns its value
 */
export const evaluateMinMax = (curve: MinMaxCurveInfo, time: number, r: number): number => {
	switch (curve.mode) {
		case CurveMode.Constant: {
			return curve.scalar;
		}
		case CurveMode.Curve: {
			return curve.curve === null ? curve.scalar : curve.scalar * evaluateCurve(curve.curve, time);
		}
		case CurveMode.TwoCurves: {
			const high = curve.curve === null ? 1 : evaluateCurve(curve.curve, time);
			const low = curve.minCurve === null ? high : evaluateCurve(curve.minCurve, time);
			return curve.scalar * (low + (high - low) * r);
		}
		case CurveMode.TwoConstants: {
			return curve.min + (curve.scalar - curve.min) * r;
		}
	}
};

/** @returns the largest value a MinMaxCurve can take, keys bounding its curves */
const upperBound = (curve: MinMaxCurveInfo): number => {
	switch (curve.mode) {
		case CurveMode.Constant: {
			return curve.scalar;
		}
		case CurveMode.TwoConstants: {
			return Math.max(curve.scalar, curve.min);
		}
		default: {
			let most = -Infinity;
			for (const key of [...(curve.curve?.keys ?? []), ...(curve.minCurve?.keys ?? [])]) {
				most = Math.max(most, key.value * curve.scalar);
			}
			return Number.isFinite(most) ? most : 0;
		}
	}
};

/** @returns a constant or random-between-two-constants rate's mean */
const meanOf = (curve: MinMaxCurveInfo): number =>
	curve.mode === CurveMode.TwoConstants ? (curve.min + curve.scalar) / 2 : curve.scalar;

/** @returns the xyzw quaternion of Unity Euler angles in radians (Z, then X, then Y) */
const eulerQuaternion = (x: number, y: number, z: number): [number, number, number, number] => {
	const cx = Math.cos(x / 2),
		cy = Math.cos(y / 2),
		cz = Math.cos(z / 2);
	const sx = Math.sin(x / 2),
		sy = Math.sin(y / 2),
		sz = Math.sin(z / 2);
	return [
		cy * sx * cz + sy * cx * sz,
		sy * cx * cz - cy * sx * sz,
		cy * cx * sz - sy * sx * cz,
		cy * cx * cz + sy * sx * sz,
	];
};

/** @returns `v` rotated by the xyzw quaternion `q` */
const rotate = (q: ArrayLike<number>, v: ArrayLike<number>): Vec3 => {
	const x = q[0],
		y = q[1],
		z = q[2],
		w = q[3];
	// t = 2 · cross(q.xyz, v); v' = v + w · t + cross(q.xyz, t)
	const tx = 2 * (y * v[2] - z * v[1]);
	const ty = 2 * (z * v[0] - x * v[2]);
	const tz = 2 * (x * v[1] - y * v[0]);
	return [
		v[0] + w * tx + (y * tz - z * ty),
		v[1] + w * ty + (z * tx - x * tz),
		v[2] + w * tz + (x * ty - y * tx),
	];
};

/** @returns `v` rotated about the unit axis of `omega` by its length (radians) */
const rotateBy = (omega: Vec3, v: Vec3): Vec3 => {
	const angle = Math.hypot(omega[0], omega[1], omega[2]);
	if (angle < 1e-9) {
		return v;
	}
	const s = Math.sin(angle / 2) / angle;
	return rotate([omega[0] * s, omega[1] * s, omega[2] * s, Math.cos(angle / 2)], v);
};

const normalize = (v: Vec3): Vec3 => {
	const length = Math.hypot(v[0], v[1], v[2]);
	return length > 1e-12 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 1];
};

/** a uniformly random unit vector from two random values */
const unitVector = (a: number, b: number): Vec3 => {
	const z = 2 * a - 1;
	const r = Math.sqrt(Math.max(0, 1 - z * z));
	const phi = 2 * Math.PI * b;
	return [r * Math.cos(phi), r * Math.sin(phi), z];
};

/** one emission: when (system time) and which particle */
interface Emission {
	time: number;
	id: number;
}

/**
 * a system's particles over time, for one emitter
 *
 * @see ParticleField for the emitter's frame
 */
export class ParticleSimulation {
	readonly info: ParticleSystemInfo;
	readonly #seed: number;
	/** the longest a particle lives, s */
	readonly #longest: number;
	/** particles per second */
	readonly #rate: number;
	readonly #meshTotal: number;
	readonly #shapeRotation: [number, number, number, number];
	readonly #emissions: Emission[] = [];

	/**
	 * @param info the system
	 * @param seed the emitter's random seed; emitters drawing other meshes of the same renderer share it
	 */
	constructor(info: ParticleSystemInfo, seed: number) {
		this.info = info;
		this.#seed = seed;
		this.#longest = Math.max(upperBound(info.startLifetime), 0);
		this.#rate = Math.max(meanOf(info.rate), 0);
		this.#meshTotal = info.meshWeights.reduce((sum, weight) => sum + weight, 0);
		const rotation = info.shape?.rotation ?? [0, 0, 0];
		this.#shapeRotation = eulerQuaternion(
			(rotation[0] * Math.PI) / 180,
			(rotation[1] * Math.PI) / 180,
			(rotation[2] * Math.PI) / 180,
		);
	}

	/** seconds a looping system needs to look as if it had always played */
	get settleTime(): number {
		return this.info.startDelay + this.#longest + this.info.duration;
	}

	/**
	 * the live particles that draw this entry's mesh at a system time, newest last.
	 *
	 * @param time seconds of system time (the viewer's time times the simulation speed)
	 * @param down world down in the emitter's frame, unit length per metre of world (gravity's direction)
	 * @param worldToLocal turns a world direction into the emitter's frame (for world-space velocities)
	 * @param out {@link PARTICLE_FLOATS} floats per particle: position in the emitter's frame, rotation, size
	 * @returns how many particles were written (at most `out.length / PARTICLE_FLOATS`)
	 */
	evaluate(time: number, down: Vec3, worldToLocal: (direction: Vec3) => Vec3, out: Float32Array): number {
		const emissions = this.#emitted(time);
		const capacity = Math.floor(out.length / PARTICLE_FLOATS);
		let count = 0;
		// the newest particles win when there are more than the system allows; the game would skip the newest
		// emissions instead, which the closed form can't tell apart
		let alive = 0;
		for (let i = emissions.length - 1; i >= 0 && alive < this.info.maxParticles && count < capacity; i--) {
			const { time: born, id } = emissions[i];
			const age = time - born;
			const life = evaluateMinMax(
				this.info.startLifetime,
				this.#loopFraction(born),
				random(this.#seed, id, Channel.Lifetime),
			);
			if (age < 0 || age >= life) {
				continue;
			}
			alive++;
			if (this.#drawsMesh(id)) {
				this.#place(id, born, age, down, worldToLocal, out, count * PARTICLE_FLOATS);
				count++;
			}
		}
		return count;
	}

	/** the emissions whose particles could be alive at `time` */
	#emitted(time: number): Emission[] {
		const emissions = this.#emissions;
		emissions.length = 0;
		const { duration, looping, startDelay, bursts } = this.info;
		const from = Math.max(time - this.#longest, startDelay);
		const end = looping ? time : Math.min(time, startDelay + duration);
		if (end < from) {
			return emissions;
		}
		// bursts first, then the rate's steady stream, each with ids of their own
		for (const [b, burst] of bursts.entries()) {
			const firstLoop = looping
				? Math.max(0, Math.floor((from - startDelay - burst.time) / duration) - 1)
				: 0;
			const lastLoop = looping ? Math.floor((end - startDelay) / duration) : 0;
			for (let loop = firstLoop; loop <= lastLoop; loop++) {
				for (let cycle = 0; cycle < burst.cycles; cycle++) {
					const offset = burst.time + cycle * burst.interval;
					const at = startDelay + loop * duration + offset;
					if (offset > duration || at < from || at > end) {
						continue;
					}
					const event = hash2(hash2(b, loop), cycle);
					if (random(this.#seed, event, Channel.Burst) >= burst.probability) {
						continue;
					}
					const count = Math.round(
						evaluateMinMax(burst.count, offset / duration, random(this.#seed, event, 0)),
					);
					for (let j = 0; j < Math.min(count, MAX_PARTICLES); j++) {
						emissions.push({ time: at, id: hash2(event, j) | 1 });
					}
				}
			}
		}
		emissions.sort((a, b) => a.time - b.time);
		if (this.#rate > 0) {
			const first = Math.max(0, Math.ceil((from - startDelay) * this.#rate));
			const last = Math.floor((end - startDelay) * this.#rate);
			for (let k = Math.max(first, last - MAX_PARTICLES); k <= last; k++) {
				// even ids for the stream, odd for bursts
				emissions.push({ time: startDelay + k / this.#rate, id: (k * 2) >>> 0 });
			}
		}
		emissions.sort((a, b) => a.time - b.time);
		return emissions;
	}

	/** @returns the emission time's place within its loop, 0–1, where start values read their curves */
	#loopFraction(born: number): number {
		const t = (born - this.info.startDelay) / this.info.duration;
		return this.info.looping ? t - Math.floor(t) : Math.min(Math.max(t, 0), 1);
	}

	/** whether a particle picked this entry's mesh */
	#drawsMesh(id: number): boolean {
		const weights = this.info.meshWeights;
		if (weights.length <= 1) {
			return true;
		}
		let pick = random(this.#seed, id, Channel.Mesh) * this.#meshTotal;
		for (const [i, weight] of weights.entries()) {
			pick -= weight;
			if (pick < 0) {
				return i === this.info.mesh;
			}
		}
		return weights.length - 1 === this.info.mesh;
	}

	/** where a particle starts and which way it leaves, in the emitter's frame */
	#start(id: number): { position: Vec3; direction: Vec3 } {
		const shape = this.info.shape;
		if (shape === null) {
			return { position: [0, 0, 0], direction: [0, 0, 1] };
		}
		const r0 = random(this.#seed, id, Channel.Shape0);
		const r1 = random(this.#seed, id, Channel.Shape1);
		const r2 = random(this.#seed, id, Channel.Shape2);
		const inner = 1 - Math.min(Math.max(shape.radiusThickness, 0), 1);
		let position: Vec3;
		let direction: Vec3;
		switch (shape.kind) {
			case ParticleShapeKind.Sphere:
			case ParticleShapeKind.Hemisphere: {
				direction = unitVector(r0, r1);
				if (shape.kind === ParticleShapeKind.Hemisphere) {
					direction[2] = Math.abs(direction[2]);
				}
				// uniform in the shell's volume
				const radius = shape.radius * Math.cbrt(inner ** 3 + (1 - inner ** 3) * r2);
				position = [direction[0] * radius, direction[1] * radius, direction[2] * radius];
				break;
			}
			case ParticleShapeKind.Cone:
			case ParticleShapeKind.ConeVolume:
			case ParticleShapeKind.Circle: {
				const phi = (r0 * shape.arc * Math.PI) / 180;
				// uniform in the ring's area
				const rho = Math.sqrt(inner * inner + (1 - inner * inner) * r1);
				const c = Math.cos(phi);
				const s = Math.sin(phi);
				position = [rho * shape.radius * c, rho * shape.radius * s, 0];
				if (shape.kind === ParticleShapeKind.Circle) {
					direction = [c, s, 0];
					break;
				}
				// towards the matching point on the cone's far end
				const spread = rho * Math.tan((shape.angle * Math.PI) / 180);
				direction = normalize([spread * c, spread * s, 1]);
				if (shape.kind === ParticleShapeKind.ConeVolume) {
					const along = (shape.length * r2) / direction[2];
					position = [
						position[0] + direction[0] * along,
						position[1] + direction[1] * along,
						position[2] + direction[2] * along,
					];
				}
				break;
			}
			case ParticleShapeKind.Box: {
				position = [r0 - 0.5, r1 - 0.5, r2 - 0.5];
				direction = [0, 0, 1];
				break;
			}
		}
		// the shape's own placement
		position = rotate(this.#shapeRotation, [
			position[0] * shape.scale[0],
			position[1] * shape.scale[1],
			position[2] * shape.scale[2],
		]);
		position = [
			position[0] + shape.position[0],
			position[1] + shape.position[1],
			position[2] + shape.position[2],
		];
		direction = normalize(
			rotate(this.#shapeRotation, [
				direction[0] * shape.scale[0],
				direction[1] * shape.scale[1],
				direction[2] * shape.scale[2],
			]),
		);
		if (shape.randomDirection > 0) {
			const away = unitVector(
				random(this.#seed, id, Channel.Direction0),
				random(this.#seed, id, Channel.Direction1),
			);
			const a = shape.randomDirection;
			direction = normalize([
				direction[0] + (away[0] - direction[0]) * a,
				direction[1] + (away[1] - direction[1]) * a,
				direction[2] + (away[2] - direction[2]) * a,
			]);
		}
		if (shape.sphericalDirection > 0) {
			const out = normalize([
				position[0] - shape.position[0],
				position[1] - shape.position[1],
				position[2] - shape.position[2],
			]);
			const a = shape.sphericalDirection;
			direction = normalize([
				direction[0] + (out[0] - direction[0]) * a,
				direction[1] + (out[1] - direction[1]) * a,
				direction[2] + (out[2] - direction[2]) * a,
			]);
		}
		if (shape.randomPosition > 0) {
			const a = shape.randomPosition * 2;
			position = [
				position[0] + (random(this.#seed, id, Channel.Position0) - 0.5) * a,
				position[1] + (random(this.#seed, id, Channel.Position1) - 0.5) * a,
				position[2] + (random(this.#seed, id, Channel.Position2) - 0.5) * a,
			];
		}
		return { position, direction };
	}

	/** writes one live particle */
	#place(
		id: number,
		born: number,
		age: number,
		down: Vec3,
		worldToLocal: (direction: Vec3) => Vec3,
		out: Float32Array,
		at: number,
	): void {
		const info = this.info;
		const seed = this.#seed;
		const u = this.#loopFraction(born);
		const life = evaluateMinMax(info.startLifetime, u, random(seed, id, Channel.Lifetime));
		const { position: start, direction } = this.#start(id);
		const velocity = info.velocity;
		const modifier =
			velocity === null
				? 1
				: evaluateMinMax(velocity.speedModifier, 0, random(seed, id, Channel.SpeedModifier));
		const speed = evaluateMinMax(info.startSpeed, u, random(seed, id, Channel.Speed)) * modifier;
		let travel: Vec3 = [direction[0] * speed * age, direction[1] * speed * age, direction[2] * speed * age];
		// gravity, which Unity always pulls down the world's y
		const fall =
			0.5 * GRAVITY * evaluateMinMax(info.gravityModifier, u, random(seed, id, Channel.Gravity)) * age * age;
		travel = [travel[0] + down[0] * fall, travel[1] + down[1] * fall, travel[2] + down[2] * fall];
		let position: Vec3 = [start[0] + travel[0], start[1] + travel[1], start[2] + travel[2]];
		if (velocity !== null) {
			let linear: Vec3 = [
				evaluateMinMax(velocity.linear[0], 0, random(seed, id, Channel.VelocityX)),
				evaluateMinMax(velocity.linear[1], 0, random(seed, id, Channel.VelocityY)),
				evaluateMinMax(velocity.linear[2], 0, random(seed, id, Channel.VelocityZ)),
			];
			if (velocity.linearInWorld) {
				linear = worldToLocal(linear);
			}
			const offset = velocity.orbitalOffset;
			const radial = evaluateMinMax(velocity.radial, 0, random(seed, id, Channel.Radial)) * modifier * age;
			const outward = normalize([start[0] - offset[0], start[1] - offset[1], start[2] - offset[2]]);
			position = [
				position[0] + linear[0] * modifier * age + outward[0] * radial,
				position[1] + linear[1] * modifier * age + outward[1] * radial,
				position[2] + linear[2] * modifier * age + outward[2] * radial,
			];
			// the orbit turns the particle about the offset at a constant rate; applied to the whole path, which is
			// exact when the other motion runs along the orbit's axis (the crater rocks rise along theirs)
			const turn: Vec3 = [
				evaluateMinMax(velocity.orbital[0], 0, random(seed, id, Channel.OrbitalX)) * modifier * age,
				evaluateMinMax(velocity.orbital[1], 0, random(seed, id, Channel.OrbitalY)) * modifier * age,
				evaluateMinMax(velocity.orbital[2], 0, random(seed, id, Channel.OrbitalZ)) * modifier * age,
			];
			const turned = rotateBy(turn, [
				position[0] - offset[0],
				position[1] - offset[1],
				position[2] - offset[2],
			]);
			position = [turned[0] + offset[0], turned[1] + offset[1], turned[2] + offset[2]];
		}

		const lived = life > 0 ? age / life : 0;
		const sizeRandom = random(seed, id, Channel.Size);
		const growth = random(seed, id, Channel.SizeOverLifetime);
		const size = info.startSize.map((curve, axis) => {
			const over = info.sizeOverLifetime;
			return (
				evaluateMinMax(curve, u, sizeRandom) * (over === null ? 1 : evaluateMinMax(over[axis], lived, growth))
			);
		});

		const angles = info.startRotation.map((curve, axis) =>
			evaluateMinMax(curve, u, random(seed, id, Channel.RotationX + axis)),
		);
		const spin = info.rotationOverLifetime;
		if (spin !== null) {
			for (let axis = 0; axis < 3; axis++) {
				angles[axis] += evaluateMinMax(spin[axis], lived, random(seed, id, Channel.SpinX + axis)) * age;
			}
		}
		const rotation = eulerQuaternion(angles[0], angles[1], angles[2]);
		if (info.pivot.some((value) => value !== 0)) {
			const pivot = rotate(rotation, [
				info.pivot[0] * size[0],
				info.pivot[1] * size[1],
				info.pivot[2] * size[2],
			]);
			position = [position[0] + pivot[0], position[1] + pivot[1], position[2] + pivot[2]];
		}
		out.set(position, at);
		out.set(rotation, at + 3);
		out.set(size, at + 7);
	}
}

// #endregion

// #region rows

/** the camera inputs particle rows depend on */
export interface ParticleView {
	/** seconds of the viewer's clock */
	time: number;
	/** the camera's right, up and forward axes (Unity frame), which view-aligned particles turn with */
	right: Vec3;
	up: Vec3;
	forward: Vec3;
}

/** one emitter's particles: its rows in the instance buffer and its clock */
interface Emitter {
	simulation: ParticleSimulation;
	rows: RangeAllocation;
	/** the viewer time the emitter was first drawn, which non-looping systems start from */
	start: number;
	/** the frame its rows were last written */
	frame: number;
	/** global indices of the rows holding live particles */
	live: number[];
}

/** what {@link ParticleField} needs of the instance buffer */
export interface ParticleRowStore {
	allocateRows(count: number): RangeAllocation | null;
	freeRows(alloc: RangeAllocation): void;
	writeRows(start: number, rows: Uint32Array<ArrayBuffer>, count: number): void;
}

/**
 * the particles of every drawn emitter, as instance rows. an emitter is an instance row whose draw names a
 * particle system: its transform is the system's frame, and its particles' rows use its block's origin
 */
export class ParticleField {
	readonly #systems: readonly ParticleSystemInfo[];
	/** each system's seed salt, the same for entries differing only in their mesh */
	readonly #salts: number[];
	readonly #store: ParticleRowStore;
	readonly #emitters = new Map<ResidentInstances, Map<number, Emitter>>();
	readonly #scratch = new Float32Array(MAX_PARTICLES * PARTICLE_FLOATS);
	readonly #rows = new Uint32Array(MAX_PARTICLES * ROW_WORDS);
	readonly #rowsF32 = new Float32Array(this.#rows.buffer);

	/**
	 * @param table the package's particle systems
	 * @param store the instance buffer the rows go to
	 */
	constructor(table: ParticlesTable, store: ParticleRowStore) {
		this.#systems = table.systems;
		this.#salts = table.systems.map((system) => hashText(JSON.stringify({ ...system, mesh: 0 })));
		this.#store = store;
	}

	/**
	 * writes an emitter's live particles for this frame, once per frame however many draws ask.
	 *
	 * @param instances the emitter's block
	 * @param row the emitter's row in the block
	 * @param system the particles-table entry its draw names
	 * @param frame the frame number
	 * @param view the clock and camera
	 * @returns the global row indices of its live particles (valid until the next frame)
	 */
	rows(
		instances: ResidentInstances,
		row: number,
		system: number,
		frame: number,
		view: ParticleView,
	): readonly number[] {
		let emitters = this.#emitters.get(instances);
		if (emitters === undefined) {
			emitters = new Map();
			this.#emitters.set(instances, emitters);
		}
		// one emitter per row and system: a renderer's meshes are separate rows
		const key = row * this.#systems.length + system;
		let emitter = emitters.get(key);
		if (emitter === undefined) {
			const info = this.#systems[system];
			if (info === undefined) {
				return [];
			}
			const capacity = Math.min(info.maxParticles, MAX_PARTICLES);
			const rows = this.#store.allocateRows(capacity);
			if (rows === null) {
				return [];
			}
			const f32 = instances.rowsF32;
			const at = row * ROW_WORDS;
			// emitters of one renderer's meshes share their place, so they share their particles' random values
			const seed = hash2(
				hash2(this.#salts[system], hashText(`${f32[at + 3]},${f32[at + 7]},${f32[at + 11]}`)),
				0,
			);
			emitter = {
				simulation: new ParticleSimulation(info, seed),
				rows,
				start: view.time,
				frame: -1,
				live: [],
			};
			emitters.set(key, emitter);
		}
		if (emitter.frame !== frame) {
			emitter.frame = frame;
			this.#write(instances, row, emitter, view);
		}
		return emitter.live;
	}

	/** forgets a released block's emitters and frees their rows */
	release(instances: ResidentInstances): void {
		const emitters = this.#emitters.get(instances);
		if (emitters === undefined) {
			return;
		}
		for (const emitter of emitters.values()) {
			this.#store.freeRows(emitter.rows);
		}
		this.#emitters.delete(instances);
	}

	#write(instances: ResidentInstances, row: number, emitter: Emitter, view: ParticleView): void {
		const simulation = emitter.simulation;
		const info = simulation.info;
		const f32 = instances.rowsF32;
		const at = row * ROW_WORDS;
		// the emitter's rows3x4 matrix, translation relative to the block origin
		const m = f32.subarray(at, at + 12);
		const columns: Vec3[] = [
			[m[0], m[4], m[8]],
			[m[1], m[5], m[9]],
			[m[2], m[6], m[10]],
		];
		const scales = columns.map((column) => Math.hypot(column[0], column[1], column[2]));
		// the inverse of a rotation times a scale: project onto each column, divided by its squared length
		const along = (i: number, d: Vec3): number =>
			(columns[i][0] * d[0] + columns[i][1] * d[1] + columns[i][2] * d[2]) /
			Math.max(scales[i] * scales[i], 1e-12);
		const local = (direction: Vec3): Vec3 => [along(0, direction), along(1, direction), along(2, direction)];
		const elapsed = (view.time - emitter.start) * info.simulationSpeed;
		const time = info.looping ? elapsed + simulation.settleTime : elapsed;
		const scratch = this.#scratch;
		const count = simulation.evaluate(
			time,
			local([0, -1, 0]),
			local,
			scratch.subarray(0, Math.min(emitter.rows.count, MAX_PARTICLES) * PARTICLE_FLOATS),
		);
		const out = this.#rowsF32;
		const words = this.#rows;
		const block = instances.blockSlot;
		emitter.live.length = 0;
		for (let i = 0; i < count; i++) {
			const p = scratch.subarray(i * PARTICLE_FLOATS, i * PARTICLE_FLOATS + 3);
			const q = scratch.subarray(i * PARTICLE_FLOATS + 3, i * PARTICLE_FLOATS + 7);
			const s = scratch.subarray(i * PARTICLE_FLOATS + 7, i * PARTICLE_FLOATS + 10);
			// the particle's place, through the emitter's matrix
			const center: Vec3 = [
				m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
				m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
				m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
			];
			// the rotation's axes, then the frame they turn in: the emitter's (local), the world's, or the camera's
			let axes: Vec3[] = [rotate(q, [1, 0, 0]), rotate(q, [0, 1, 0]), rotate(q, [0, 0, 1])];
			let sizes = [s[0] * scales[0], s[1] * scales[1], s[2] * scales[2]];
			switch (info.alignment) {
				case ParticleAlignment.Local: {
					axes = axes.map((axis) => [
						m[0] * axis[0] + m[1] * axis[1] + m[2] * axis[2],
						m[4] * axis[0] + m[5] * axis[1] + m[6] * axis[2],
						m[8] * axis[0] + m[9] * axis[1] + m[10] * axis[2],
					]);
					sizes = [s[0], s[1], s[2]];
					break;
				}
				case ParticleAlignment.View: {
					const { right, up, forward } = view;
					axes = axes.map((axis) => [
						right[0] * axis[0] + up[0] * axis[1] + forward[0] * axis[2],
						right[1] * axis[0] + up[1] * axis[1] + forward[1] * axis[2],
						right[2] * axis[0] + up[2] * axis[1] + forward[2] * axis[2],
					]);
					break;
				}
				case ParticleAlignment.World: {
					break;
				}
			}
			const o = i * ROW_WORDS;
			for (let r = 0; r < 3; r++) {
				out[o + r * 4] = axes[0][r] * sizes[0];
				out[o + r * 4 + 1] = axes[1][r] * sizes[1];
				out[o + r * 4 + 2] = axes[2][r] * sizes[2];
				out[o + r * 4 + 3] = center[r];
			}
			const extent = Math.max(sizes[0], sizes[1], sizes[2]);
			out.set(center, o + 12);
			words[o + 15] = block;
			out[o + 16] = extent;
			out[o + 17] = extent;
			out[o + 18] = extent;
			words[o + 19] = RowKind.Detail;
			emitter.live.push(emitter.rows.start + i);
		}
		if (count > 0) {
			this.#store.writeRows(emitter.rows.start, words, count);
		}
	}
}

// #endregion
