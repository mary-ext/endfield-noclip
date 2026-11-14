import {
	CurveMode,
	GRAVITY,
	type MinMaxCurveInfo,
	type ParticleDragInfo,
	type ParticleForcesInfo,
	type ParticleVelocityInfo,
	ParticleMeshSpawn,
	ParticleShapeKind,
	type ParticleShapeRadius,
	type ParticleClampInfo,
	type ParticleSystemInfo,
} from '@endfield-noclip/package-format/particles';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { srgbToLinear } from '../math/color.ts';
import { eulerQuaternion, eulerQuaternionInto, type Quat, rotateByInto, rotateInto } from '../math/quat.ts';
import { normalizeOrZInto } from '../math/vec3.ts';

import { type DrawnCurve, integrateOverAge } from './curve-integrals.ts';
import { evaluateMinMax, evaluateMinMaxGradientInto, livedAt, upperBound } from './curves.ts';
import { type EmissionStream, emissionStream } from './emission-rate.ts';
import { applyForces, type ForceRandoms, type PreparedField, prepareField } from './forces.ts';
import { meshShapePoint, type PreparedMeshShape, prepareMeshShape } from './mesh-shape.ts';
import { dragged, draggedFall, type SteppedState, splinePoint, steppedPath, travelled } from './motion.ts';
import { Channel, hash2, random } from './random.ts';
import { sheetTile } from './texture-sheet.ts';
import { unitVectorInto } from './vector-math.ts';

/**
 * floats per particle in {@link ParticleSimulation.evaluate}'s output: position, rotation (xyzw), size, the
 * texture sheet's tile (0 without a sheet), colour (linear rgb, alpha), velocity (m/s), all in the emitter's
 * frame, then its custom data (`ParticleSystemInfo.customData`, zero without)
 */
export const PARTICLE_FLOATS = 22;

/** where each value starts in a particle's {@link PARTICLE_FLOATS} */
export const ParticleFloat = {
	position: 0,
	rotation: 3,
	size: 7,
	tile: 10,
	color: 11,
	velocity: 15,
	custom: 18,
} as const;

/** the most particles one emitter shows */
export const MAX_PARTICLES = 1024;

/**
 * @param lived a ring-buffered particle's age over its lifetime, which can pass 1
 * @param loopRange the span of the lifetime it replays once it reaches the span's end, or `null` to hold it
 *   at the end of its lifetime
 * @returns the age over its lifetime it shows
 */
export const ringBufferAge = (lived: number, loopRange: readonly [number, number] | null): number => {
	if (loopRange === null) {
		return Math.min(lived, 1);
	}
	const [start, end] = loopRange;
	if (lived <= end) {
		return lived;
	}
	const span = end - start;
	return span > 0 ? start + ((lived - end) % span) : end;
};

/** one emission: when (system time) and which particle */
interface Emission {
	time: number;
	id: number;
}

interface AdmittedEmission extends Emission {
	/** s */
	life: number;
}

const byTime = (a: Emission, b: Emission): number => a.time - b.time;

/** adds a value to a binary min-heap */
const pushMin = (heap: number[], value: number): void => {
	let i = heap.length;
	heap.push(value);
	while (i > 0) {
		const parent = (i - 1) >> 1;
		if (heap[parent] <= value) {
			break;
		}
		heap[i] = heap[parent];
		i = parent;
	}
	heap[i] = value;
};

/** removes a binary min-heap's smallest value; the heap must not be empty */
const popMin = (heap: number[]): void => {
	const last = heap.pop() ?? 0;
	const n = heap.length;
	if (n === 0) {
		return;
	}
	let i = 0;
	for (;;) {
		let child = 2 * i + 1;
		if (child >= n) {
			break;
		}
		if (child + 1 < n && heap[child + 1] < heap[child]) {
			child++;
		}
		if (heap[child] >= last) {
			break;
		}
		heap[i] = heap[child];
		i = child;
	}
	heap[i] = last;
};

/** a burst firing's key within its loop */
const burstKey = (burst: number, cycle: number): number => burst * 2 ** 20 + cycle;

/** @returns the inner fraction of a round shape's radius particles don't start in */
const innerRadius = (shape: ParticleShapeRadius): number =>
	1 - Math.min(Math.max(shape.radiusThickness, 0), 1);

/** a live particle being placed */
interface Placing {
	id: number;
	/** its emission's system time */
	born: number;
	/** s */
	life: number;
	/** the age its curves read, s */
	age: number;
	/** the age it has moved for, s: it differs for a ring buffer's paused particle, which holds its age */
	moved: number;
}

/** what a freely moving particle's path starts from, in the emitter's frame */
interface PathStart {
	id: number;
	start: Vec3;
	direction: Vec3;
	/** m/s along {@link direction}, the speed modifier left out */
	speed: number;
	/** the velocity module's speed modifier, 1 when it's a curve ({@link modifierAt}) */
	modifier: number;
	/**
	 * a speed modifier curve at an age, s; `null` when it's constant. the packer leaves such systems without
	 * drag
	 */
	modifierAt: ((age: number) => number) | null;
	/** the curve {@link modifierAt} reads and the particle's random value for it, set when it is */
	modifierCurve: DrawnCurve;
	/** m/s² down the world's y */
	gravity: number;
	/** seconds */
	age: number;
	life: number;
	/** its size along each axis at birth */
	startSize: Vec3;
	/** its random value for the size over lifetime */
	growth: number;
}

// #region scratch

// every live particle is placed each frame, so the hot path works in these rather than allocating. each is
// written by the one step named beside it and read before that step runs again; evaluations don't nest

const vec3 = (): Vec3 => [0, 0, 0];
const ZERO: Readonly<Vec3> = [0, 0, 0];
const quat = (): Quat => [0, 0, 0, 1];

/** {@link ParticleSimulation.evaluate}'s particle */
const placing: Placing = { id: 0, born: 0, life: 0, age: 0, moved: 0 };
/**
 * the place and direction a particle starts from and the shape's tint of its colour (`#start`), and its size
 * then (`#place`)
 */
const begin = {
	position: vec3(),
	direction: vec3(),
	away: vec3(),
	tint: [1, 1, 1, 1] as [number, number, number, number],
	size: vec3(),
	randoms: [0, 0, 0] as [number, number, number],
};
/** the path `#place` hands `#freePath` or `#steppedPath` */
const path: PathStart = {
	id: 0,
	start: begin.position,
	direction: begin.direction,
	speed: 0,
	modifier: 1,
	modifierAt: null,
	modifierCurve: { curve: { mode: CurveMode.Constant, scalar: 1 }, r: 0 },
	gravity: 0,
	age: 0,
	life: 0,
	startSize: begin.size,
	growth: 0,
};
/** where the path puts the particle and how it moves there (`#freePath`, `#steppedPath`, `#place`) */
const placed = {
	position: vec3(),
	moving: vec3(),
	angles: vec3(),
	rotation: quat(),
	/** the start colour, then the colour over lifetime, each read before the next is written */
	color: [0, 0, 0, 0] as [number, number, number, number],
};
/** `#freePath`'s velocity module terms */
const free = { linear: vec3(), linearNow: vec3(), outward: vec3(), turn: vec3(), around: vec3() };
/** `#steppedPath`'s per-particle inputs and the per-step terms of its extra velocity and forces */
const stepped = {
	start: vec3(),
	acceleration: vec3(),
	linearRandoms: vec3(),
	orbitRandoms: vec3(),
	linear: vec3(),
	spin: vec3(),
	from: vec3(),
	outward: vec3(),
	extra: vec3(),
	at: vec3(),
	randoms: {
		multiplier: 0,
		tiltX: 0,
		tiltZ: 0,
		direction: [0, 0, 0],
		gravity: 0,
		spin: 0,
		attraction: 0,
		drag: 0,
	} satisfies ForceRandoms,
};

/** the extra velocity of a particle without a velocity module */
const noExtra = (): Readonly<Vec3> => ZERO;

/** sets `out` to `v` */
const copy = (out: Vec3, v: Readonly<Vec3>): void => {
	out[0] = v[0];
	out[1] = v[1];
	out[2] = v[2];
};

// #endregion

/**
 * a system's particles over time, for one emitter
 *
 * @see ParticleField for the emitter's frame
 */
export class ParticleSimulation {
	readonly info: ParticleSystemInfo;
	readonly #seed: number;
	/** seconds before the first emission, drawn once per emitter as the game draws it once per play */
	readonly #startDelay: number;
	/** the longest a particle lives, s */
	readonly #longest: number;
	/** how far back emissions can still be alive, s: their lifetime, or until enough newer ones replace them */
	readonly #lookback: number;
	/** the rate over time's emissions; `null` when only bursts emit */
	readonly #stream: EmissionStream | null;
	readonly #meshTotal: number;
	readonly #shapeRotation: Quat;
	/** the mesh a mesh shape emits from; `null` for other shapes */
	readonly #meshShape: PreparedMeshShape | null;
	/**
	 * whether burst particles take even ids numbering them in emission order, for a mesh shape's vertex spawn
	 * modes, which step through the vertices by that count. the count is known only without the rate's stream
	 * (whose ids are the even ones otherwise), and when every loop emits the same particles or the system plays
	 * once
	 */
	readonly #burstsNumbered: boolean;
	/** the bursts' firings within a loop, in time order: burst index, cycle */
	readonly #burstOrder: [burst: number, cycle: number][] = [];
	/** the emissions of the window {@link #emitted} last listed, drawn from {@link #emissionPool} */
	readonly #emissions: Emission[] = [];
	/** emission records kept for reuse, as many as the largest window held */
	readonly #emissionPool: Emission[] = [];
	/** whether the cap can turn emissions away, so that which particles live depends on what came before */
	readonly #capped: boolean;
	/** the emissions the cap let in that may still be alive, oldest first */
	readonly #admitted: AdmittedEmission[] = [];
	/**
	 * a min-heap of the end times of the {@link #admitted} emissions still alive at the last emission played:
	 * its size is how many the cap counts
	 */
	readonly #admittedEnds: number[] = [];
	/** the system time {@link #admitted} has been played to */
	#admittedUntil = -Infinity;
	/** the force fields, prepared; `null` without */
	readonly #forces: { multiplier: MinMaxCurveInfo; fields: PreparedField[] } | null;
	/**
	 * where each stepped particle drawn last frame had got to, so the next frame steps on from there rather
	 * than from its birth
	 */
	#stepped = new Map<number, SteppedState>();
	/** the stepped particles placed during the current {@link evaluate} */
	#steppedNow = new Map<number, SteppedState>();
	/** world down in the emitter's frame, for the current {@link evaluate} */
	#down: Readonly<Vec3> = ZERO;
	/** turns a world direction into the emitter's frame, for the current {@link evaluate} */
	#worldToLocal: (direction: Vec3) => Vec3 = (direction) => direction;
	/** where a moving emitter was at an emission, for the current {@link evaluate}; `null` when it holds still */
	#emittedFrom: ((born: number) => Readonly<Float64Array>) | null = null;
	/** the particle being placed's random value for a channel */
	readonly #randomOf = (channel: number): number => random(this.#seed, placing.id, channel);

	/**
	 * @param info the system
	 * @param seed the emitter's random seed; emitters drawing other meshes of the same renderer share it
	 */
	constructor(info: ParticleSystemInfo, seed: number) {
		this.info = info;
		this.#seed = seed;
		this.#startDelay = Math.max(evaluateMinMax(info.startDelay, 0, random(seed, 0, Channel.StartDelay)), 0);
		this.#longest = Math.max(upperBound(info.startLifetime), 0);
		this.#stream = emissionStream(info.rate, info.duration);
		this.#lookback = this.#longest;
		if (info.ringBuffer !== null) {
			// the newest `maxParticles` emissions stay; look back far enough to find that many
			const burstsPerLoop = info.bursts.reduce(
				(sum, burst) => sum + Math.max(upperBound(burst.count), 0) * burst.cycles * burst.probability,
				0,
			);
			const perSecond = (this.#stream?.mean ?? 0) + burstsPerLoop / info.duration;
			const kept = Math.min(info.maxParticles, MAX_PARTICLES) + 1;
			if (!info.looping) {
				this.#lookback = Infinity;
			} else if (perSecond > 0) {
				// a looping one's replaced particles live out their cycle, up to a lifetime after their replacement
				const playOut = info.ringBuffer.loop ? this.#longest : 0;
				this.#lookback = Math.max(this.#longest, kept / perSecond + info.duration + playOut);
			}
		}
		this.#capped = info.ringBuffer === null && info.emissionBound > info.maxParticles;
		this.#meshTotal = info.meshWeights.reduce((sum, weight) => sum + weight, 0);
		const forces: ParticleForcesInfo | null = info.motion.kind === 'free' ? info.motion.forces : null;
		this.#forces =
			forces === null ? null : { multiplier: forces.multiplier, fields: forces.fields.map(prepareField) };
		const shapeMesh = info.shape?.kind === ParticleShapeKind.Mesh ? info.shape.mesh : null;
		this.#meshShape = shapeMesh === null ? null : prepareMeshShape(shapeMesh);
		{
			const bursts = info.bursts;
			for (let b = 0; b < bursts.length; b++) {
				for (let cycle = 0; cycle < bursts[b].cycles; cycle++) {
					if (bursts[b].time + cycle * bursts[b].interval <= info.duration) {
						this.#burstOrder.push([b, cycle]);
					}
				}
			}
			const offsetOf = ([b, cycle]: [number, number]) => bursts[b].time + cycle * bursts[b].interval;
			this.#burstOrder.sort((x, y) => offsetOf(x) - offsetOf(y));
			const sameEachLoop = bursts.every(
				(burst) =>
					burst.probability >= 1 &&
					(burst.count.mode === CurveMode.Constant || burst.count.mode === CurveMode.Curve),
			);
			this.#burstsNumbered =
				shapeMesh !== null &&
				shapeMesh.spawn !== ParticleMeshSpawn.Random &&
				this.#stream === null &&
				(!info.looping || sameEachLoop);
		}
		const rotation = info.shape?.rotation ?? [0, 0, 0];
		this.#shapeRotation = eulerQuaternion(
			(rotation[0] * Math.PI) / 180,
			(rotation[1] * Math.PI) / 180,
			(rotation[2] * Math.PI) / 180,
		);
	}

	/** seconds a looping system needs to look as if it had always played */
	get settleTime(): number {
		return this.#startDelay + this.#lookback + this.info.duration;
	}

	/**
	 * the most particles alive at once: the cap, or less when one lifetime of emission holds fewer. a looping
	 * ring buffer adds the replaced particles living out their cycle, one per emission within a lifetime
	 */
	get liveBound(): number {
		const { maxParticles, ringBuffer, emissionBound } = this.info;
		if (ringBuffer === null) {
			return Math.min(maxParticles, emissionBound);
		}
		return ringBuffer.loop ? maxParticles + emissionBound : maxParticles;
	}

	/**
	 * the live particles that draw this entry's mesh at a system time, newest last.
	 *
	 * @param time seconds of system time (the viewer's time times the simulation speed)
	 * @param down world down in the emitter's frame, unit length per metre of world (gravity's direction)
	 * @param worldToLocal turns a world direction into the emitter's frame (for world-space velocities). its
	 *   result is read before the next call, so it may reuse one array
	 * @param out {@link PARTICLE_FLOATS} floats per particle: position in the emitter's frame, rotation, size,
	 *   texture sheet tile
	 * @param emittedFrom for an emitter that moves while its particles stay in the world, where it was at a
	 *   system time: a rows3x4 matrix taking its frame then into the frame `time`'s particles are written in,
	 *   which each particle starts from. its result is read before the next call, so it may reuse one array
	 * @returns how many particles were written (at most `out.length / PARTICLE_FLOATS`)
	 */
	evaluate(
		time: number,
		down: Vec3,
		worldToLocal: (direction: Vec3) => Vec3,
		out: Float32Array,
		emittedFrom?: (born: number) => Readonly<Float64Array>,
	): number {
		this.#down = down;
		this.#worldToLocal = worldToLocal;
		this.#emittedFrom = emittedFrom ?? null;
		const emissions = this.#capped ? this.#admit(time) : this.#emitted(time - this.#lookback, time);
		this.#steppedNow.clear();
		const capacity = Math.floor(out.length / PARTICLE_FLOATS);
		const { maxParticles, ringBuffer } = this.info;
		let count = 0;
		let alive = 0;
		for (let i = emissions.length - 1; i >= 0 && count < capacity; i--) {
			// without a ring buffer the cap holds whatever the emissions; with one, replacement does
			if (ringBuffer === null && alive >= maxParticles) {
				break;
			}
			const { time: born, id } = emissions[i];
			let age = time - born;
			const life = this.#lifetime(emissions[i]);
			if (age < 0 || (ringBuffer === null && age >= life)) {
				continue;
			}
			// a paused particle holds its age but keeps moving, as the game goes on stepping it; a looping one
			// replays its path with its age
			let moved = age;
			if (ringBuffer !== null) {
				// past the cap, each emission takes the slot of the particle emitted `maxParticles` before it
				const replacer = i + maxParticles < emissions.length ? emissions[i + maxParticles] : null;
				if (replacer === null) {
					if (life > 0) {
						age = life * ringBufferAge(age / life, ringBuffer.loop ? ringBuffer.loopRange : null);
						if (ringBuffer.loop) {
							moved = age;
						}
					}
				} else if (ringBuffer.loop && life > 0) {
					// a looping one isn't dropped but stops looping, living out the cycle it was in, so its colour
					// over lifetime fades it out as it would without the ring buffer
					const swapped = life * ringBufferAge((replacer.time - born) / life, ringBuffer.loopRange);
					age = swapped + (time - replacer.time);
					if (age >= life) {
						continue;
					}
					moved = age;
				} else {
					continue;
				}
			}
			// a particle that runs off its path's end is gone
			if (this.#splineAt(id, age, life) === null) {
				continue;
			}
			alive++;
			if (this.#drawsMesh(id)) {
				placing.id = id;
				placing.born = born;
				placing.life = life;
				placing.age = age;
				placing.moved = moved;
				this.#place(placing, out, count * PARTICLE_FLOATS);
				count++;
			}
		}
		// keep only the particles still drawn
		[this.#stepped, this.#steppedNow] = [this.#steppedNow, this.#stepped];
		return count;
	}

	/**
	 * @returns where a particle is along the system's path and how it moves there, in the path's frame:
	 *   `undefined` without a path, `null` once it has run off the end
	 */
	#splineAt(id: number, age: number, life: number): { position: Vec3; moving: Vec3 } | null | undefined {
		const spline = this.info.motion;
		if (spline.kind !== 'spline') {
			return undefined;
		}
		const r = random(this.#seed, id, Channel.SplineSpeed);
		const point = splinePoint(spline, travelled(spline.speed, age, life, r));
		if (point === null) {
			return null;
		}
		const speed = evaluateMinMax(spline.speed, livedAt(age, life), r);
		const t = point.tangent;
		return { position: point.position, moving: [t[0] * speed, t[1] * speed, t[2] * speed] };
	}

	/** @returns how long an emission's particle lives, s */
	#lifetime({ time, id }: Emission): number {
		return evaluateMinMax(
			this.info.startLifetime,
			this.#loopFraction(time),
			random(this.#seed, id, Channel.Lifetime),
		);
	}

	/**
	 * plays the cap forward to `time`: an emission is let in only while fewer than the cap are alive, as the
	 * game skips emissions once the system is full. the result depends on every earlier emission, so it's kept
	 * between calls and played from where it stopped.
	 *
	 * @returns the admitted emissions that may still be alive, oldest first
	 */
	#admit(time: number): AdmittedEmission[] {
		const { maxParticles } = this.info;
		const startDelay = this.#startDelay;
		const admitted = this.#admitted;
		const ends = this.#admittedEnds;
		// further back than a few lifetimes the history barely shows, so a long jump or a step back starts
		// afresh from an empty system there
		const horizon = 4 * this.#longest + this.info.duration;
		let after = this.#admittedUntil;
		if (time < after || time - after > horizon) {
			admitted.length = 0;
			ends.length = 0;
			after = Math.max(startDelay, time - horizon) - 1e-9;
		}
		// the stream's emissions per window are capped, so play in steps that hold them all
		const step = Math.max(
			this.#stream === null ? this.#longest : Math.min(this.#longest, MAX_PARTICLES / this.#stream.peak),
			1e-3,
		);
		while (after < time) {
			// a full system turns every emission away until its first particle dies, so play on from there: a
			// stream of millions a second capped at one particle would otherwise walk all of them
			while (ends.length > 0 && ends[0] <= after) {
				popMin(ends);
			}
			if (ends.length >= maxParticles) {
				const freed = ends[0] - 1e-9;
				if (freed >= time) {
					after = time;
					break;
				}
				after = Math.max(after, freed);
			}
			const to = Math.min(time, after + step);
			for (const emission of this.#emitted(after, to)) {
				if (emission.time <= after) {
					continue;
				}
				// emissions come in time order, so the ones gone by now are gone for every later one too
				while (ends.length > 0 && ends[0] <= emission.time) {
					popMin(ends);
				}
				if (ends.length < maxParticles) {
					const life = this.#lifetime(emission);
					admitted.push({ time: emission.time, id: emission.id, life });
					pushMin(ends, emission.time + life);
				}
			}
			// drop those gone by the window's end, in order
			let kept = 0;
			for (const emission of admitted) {
				if (emission.time + emission.life > to) {
					admitted[kept++] = emission;
				}
			}
			admitted.length = kept;
			after = to;
		}
		{
			// a jump past the end skips the window's drop
			let kept = 0;
			for (const emission of admitted) {
				if (emission.time + emission.life > time) {
					admitted[kept++] = emission;
				}
			}
			admitted.length = kept;
		}
		this.#admittedUntil = time;
		return admitted;
	}

	/** the emissions in a window of system time whose particles could be alive at its end */
	#emitted(start: number, time: number): Emission[] {
		const emissions = this.#emissions;
		emissions.length = 0;
		const { duration, looping, bursts } = this.info;
		const startDelay = this.#startDelay;
		const from = Math.max(start, startDelay);
		const end = looping ? time : Math.min(time, startDelay + duration);
		if (end < from) {
			return emissions;
		}
		// bursts first, then the rate's steady stream, each with ids of their own
		for (let b = 0; b < bursts.length; b++) {
			const burst = bursts[b];
			const firstLoop = looping
				? Math.max(0, Math.floor((from - startDelay - burst.time) / duration) - 1)
				: 0;
			const lastLoop = looping ? Math.floor((end - startDelay) / duration) : 0;
			for (let loop = firstLoop; loop <= lastLoop; loop++) {
				const numbers = this.#burstsNumbered ? this.#burstNumbers(loop) : null;
				for (let cycle = 0; cycle < burst.cycles; cycle++) {
					const offset = burst.time + cycle * burst.interval;
					const at = startDelay + loop * duration + offset;
					if (offset > duration || at < from || at > end) {
						continue;
					}
					const event = hash2(hash2(b, loop), cycle);
					const count = this.#burstCount(b, loop, cycle);
					const first = numbers?.get(burstKey(b, cycle)) ?? 0;
					for (let j = 0; j < count; j++) {
						this.#emit(at, numbers === null ? hash2(event, j) | 1 : ((first + j) * 2) >>> 0);
					}
				}
			}
		}
		emissions.sort(byTime);
		const stream = this.#stream;
		if (stream !== null) {
			const first = Math.max(0, Math.ceil(stream.emitted(from - startDelay)));
			const last = Math.floor(stream.emitted(end - startDelay));
			for (let k = Math.max(first, last - MAX_PARTICLES); k <= last; k++) {
				// even ids for the stream, odd for bursts
				this.#emit(startDelay + stream.timeOf(k), (k * 2) >>> 0);
			}
		}
		emissions.sort(byTime);
		return emissions;
	}

	/** @returns how many particles a burst's firing emits: 0 when its probability turns it down */
	#burstCount(b: number, loop: number, cycle: number): number {
		const burst = this.info.bursts[b];
		const event = hash2(hash2(b, loop), cycle);
		if (random(this.#seed, event, Channel.Burst) >= burst.probability) {
			return 0;
		}
		const offset = burst.time + cycle * burst.interval;
		const count = Math.round(
			evaluateMinMax(burst.count, offset / this.info.duration, random(this.#seed, event, 0)),
		);
		return Math.min(Math.max(count, 0), MAX_PARTICLES);
	}

	/**
	 * @returns the emission number of the first particle of each of a loop's burst firings, by
	 *   {@link burstKey}, counting every particle the system emitted before ({@link #burstsNumbered})
	 */
	#burstNumbers(loop: number): Map<number, number> {
		const numbers = new Map<number, number>();
		let total = 0;
		for (const [b, cycle] of this.#burstOrder) {
			numbers.set(burstKey(b, cycle), total);
			total += this.#burstCount(b, loop, cycle);
		}
		// numbered looping systems emit the same particles every loop
		if (loop > 0) {
			for (const [key, first] of numbers) {
				numbers.set(key, first + loop * total);
			}
		}
		return numbers;
	}

	/** adds an emission to {@link #emissions}, reusing a pooled record */
	#emit(time: number, id: number): void {
		const emissions = this.#emissions;
		const pool = this.#emissionPool;
		let emission = pool[emissions.length];
		if (emission === undefined) {
			emission = { time, id };
			pool.push(emission);
		} else {
			emission.time = time;
			emission.id = id;
		}
		emissions.push(emission);
	}

	/** @returns the emission time's place within its loop, 0–1, where start values read their curves */
	#loopFraction(born: number): number {
		const t = (born - this.#startDelay) / this.info.duration;
		return this.info.looping ? t - Math.floor(t) : Math.min(Math.max(t, 0), 1);
	}

	/** whether a particle picked this entry's mesh */
	#drawsMesh(id: number): boolean {
		const weights = this.info.meshWeights;
		if (weights.length <= 1) {
			return true;
		}
		let pick = random(this.#seed, id, Channel.Mesh) * this.#meshTotal;
		for (let i = 0; i < weights.length; i++) {
			pick -= weights[i];
			if (pick < 0) {
				return i === this.info.mesh;
			}
		}
		return weights.length - 1 === this.info.mesh;
	}

	/** writes where a particle starts and which way it leaves, in the emitter's frame, and its tint */
	#start(id: number, position: Vec3, direction: Vec3): void {
		const shape = this.info.shape;
		const tint = begin.tint;
		tint.fill(1);
		if (shape === null) {
			copy(position, ZERO);
			direction[0] = 0;
			direction[1] = 0;
			direction[2] = 1;
			return;
		}
		const seed = this.#seed;
		const r0 = random(seed, id, Channel.Shape0);
		const r1 = random(seed, id, Channel.Shape1);
		const r2 = random(seed, id, Channel.Shape2);
		switch (shape.kind) {
			case ParticleShapeKind.Sphere:
			case ParticleShapeKind.Hemisphere: {
				const inner = innerRadius(shape);
				unitVectorInto(direction, r0, r1);
				if (shape.kind === ParticleShapeKind.Hemisphere) {
					direction[2] = Math.abs(direction[2]);
				}
				// uniform in the shell's volume
				const radius = shape.radius * Math.cbrt(inner ** 3 + (1 - inner ** 3) * r2);
				position[0] = direction[0] * radius;
				position[1] = direction[1] * radius;
				position[2] = direction[2] * radius;
				break;
			}
			case ParticleShapeKind.Cone:
			case ParticleShapeKind.ConeVolume:
			case ParticleShapeKind.Circle: {
				const inner = innerRadius(shape);
				const phi = (r0 * shape.arc * Math.PI) / 180;
				// uniform in the ring's area
				const rho = Math.sqrt(inner * inner + (1 - inner * inner) * r1);
				const c = Math.cos(phi);
				const s = Math.sin(phi);
				position[0] = rho * shape.radius * c;
				position[1] = rho * shape.radius * s;
				position[2] = 0;
				if (shape.kind === ParticleShapeKind.Circle) {
					direction[0] = c;
					direction[1] = s;
					direction[2] = 0;
					break;
				}
				// towards the matching point on the cone's far end
				const spread = rho * Math.tan((shape.angle * Math.PI) / 180);
				normalizeOrZInto(direction, spread * c, spread * s, 1);
				if (shape.kind === ParticleShapeKind.ConeVolume) {
					const along = (shape.length * r2) / direction[2];
					position[0] = position[0] + direction[0] * along;
					position[1] = position[1] + direction[1] * along;
					position[2] = position[2] + direction[2] * along;
				}
				break;
			}
			case ParticleShapeKind.Box: {
				position[0] = r0 - 0.5;
				position[1] = r1 - 0.5;
				position[2] = r2 - 0.5;
				direction[0] = 0;
				direction[1] = 0;
				direction[2] = 1;
				break;
			}
			case ParticleShapeKind.Mesh: {
				if (this.#meshShape === null) {
					copy(position, ZERO);
					direction[0] = 0;
					direction[1] = 0;
					direction[2] = 1;
					break;
				}
				const randoms = begin.randoms;
				randoms[0] = r0;
				randoms[1] = r1;
				randoms[2] = r2;
				// even ids number the emissions: the rate's stream, or numbered bursts (`#burstsNumbered`)
				meshShapePoint(this.#meshShape, randoms, id % 2 === 0 ? id / 2 : null, position, direction, tint);
				break;
			}
			case ParticleShapeKind.Donut: {
				// a point of the circle, then one of the tube's cross-section around it, uniform in its area
				const inner = innerRadius(shape);
				const phi = (r0 * shape.arc * Math.PI) / 180;
				const theta = 2 * Math.PI * r1;
				const rho = shape.donutRadius * Math.sqrt(inner * inner + (1 - inner * inner) * r2);
				const outX = Math.cos(phi);
				const outY = Math.sin(phi);
				direction[0] = outX * Math.cos(theta);
				direction[1] = outY * Math.cos(theta);
				direction[2] = Math.sin(theta);
				position[0] = outX * shape.radius + direction[0] * rho;
				position[1] = outY * shape.radius + direction[1] * rho;
				position[2] = direction[2] * rho;
				break;
			}
		}
		const scale = shape.scale;
		const centre = shape.position;
		rotateInto(
			position,
			this.#shapeRotation,
			position[0] * scale[0],
			position[1] * scale[1],
			position[2] * scale[2],
		);
		position[0] = position[0] + centre[0];
		position[1] = position[1] + centre[1];
		position[2] = position[2] + centre[2];
		rotateInto(
			direction,
			this.#shapeRotation,
			direction[0] * scale[0],
			direction[1] * scale[1],
			direction[2] * scale[2],
		);
		normalizeOrZInto(direction, direction[0], direction[1], direction[2]);
		const away = begin.away;
		if (shape.randomDirection > 0) {
			unitVectorInto(away, random(seed, id, Channel.Direction0), random(seed, id, Channel.Direction1));
			const a = shape.randomDirection;
			normalizeOrZInto(
				direction,
				direction[0] + (away[0] - direction[0]) * a,
				direction[1] + (away[1] - direction[1]) * a,
				direction[2] + (away[2] - direction[2]) * a,
			);
		}
		if (shape.sphericalDirection > 0) {
			normalizeOrZInto(away, position[0] - centre[0], position[1] - centre[1], position[2] - centre[2]);
			const a = shape.sphericalDirection;
			normalizeOrZInto(
				direction,
				direction[0] + (away[0] - direction[0]) * a,
				direction[1] + (away[1] - direction[1]) * a,
				direction[2] + (away[2] - direction[2]) * a,
			);
		}
		if (shape.randomPosition > 0) {
			const a = shape.randomPosition * 2;
			position[0] = position[0] + (random(seed, id, Channel.Position0) - 0.5) * a;
			position[1] = position[1] + (random(seed, id, Channel.Position1) - 0.5) * a;
			position[2] = position[2] + (random(seed, id, Channel.Position2) - 0.5) * a;
		}
	}

	/** writes where an unlimited particle is at an age and how it moves then, in closed form */
	#freePath(
		drag: ParticleDragInfo | null,
		velocity: ParticleVelocityInfo | null,
		motion: PathStart,
		position: Vec3,
		moving: Vec3,
	): void {
		const seed = this.#seed;
		const down = this.#down;
		const { id, start, direction, speed, modifier, modifierAt, gravity, startSize, age, life } = motion;
		const scale = modifierAt === null ? undefined : motion.modifierCurve;
		// a ring buffer's paused particle moves on past its lifetime with its curves at their end
		const lived = livedAt(age, life);
		// the game moves a particle by its whole velocity times the speed modifier: `scaledAge` is the modifier's
		// integral over the age, which a constant velocity moves by, and `scaleNow` its value now
		const scaledAge = scale === undefined ? age : integrateOverAge(scale, null, 0, age, life);
		const scaleNow = modifierAt === null ? 1 : modifierAt(age);
		let launch: number, launchSpeed: number, fall: number, fallSpeed: number;
		if (drag === null) {
			launch = speed * modifier * scaledAge;
			launchSpeed = speed * modifier * scaleNow;
			// gravity builds up in the velocity the modifier scales, so the fall is ∫ g·τ·m(τ) dτ
			if (scale === undefined) {
				fall = 0.5 * gravity * modifier * age * age;
			} else {
				fall = gravity * integrateOverAge(scale, null, 1, age, life);
			}
			fallSpeed = gravity * age * modifier * scaleNow;
		} else {
			// drag slows the velocity itself and the constant modifier (curves don't come with drag) scales the move
			const size = Math.max(startSize[0], startSize[1], startSize[2]);
			const r = random(seed, id, Channel.Drag);
			[launch, launchSpeed] = dragged(drag, speed, size, age, r);
			[fall, fallSpeed] = draggedFall(drag, gravity, size, age, r);
			launch *= modifier;
			launchSpeed *= modifier;
			fall *= modifier;
			fallSpeed *= modifier;
		}
		for (let axis = 0; axis < 3; axis++) {
			position[axis] = start[axis] + direction[axis] * launch + down[axis] * fall;
			moving[axis] = direction[axis] * launchSpeed + down[axis] * fallSpeed;
		}
		if (velocity === null) {
			return;
		}
		const { linear, linearNow, outward, turn, around } = free;
		for (let axis = 0; axis < 3; axis++) {
			const r = random(seed, id, Channel.VelocityX + axis);
			linear[axis] = travelled(velocity.linear[axis], age, life, r, scale);
			linearNow[axis] = evaluateMinMax(velocity.linear[axis], lived, r) * scaleNow;
		}
		if (velocity.linearInWorld) {
			copy(linear, this.#worldToLocal(linear));
			copy(linearNow, this.#worldToLocal(linearNow));
		}
		const offset = velocity.orbitalOffset;
		const radialRandom = random(seed, id, Channel.Radial);
		const radialSpeed = evaluateMinMax(velocity.radial, lived, radialRandom) * modifier * scaleNow;
		const radial = travelled(velocity.radial, age, life, radialRandom, scale) * modifier;
		normalizeOrZInto(outward, start[0] - offset[0], start[1] - offset[1], start[2] - offset[2]);
		for (let axis = 0; axis < 3; axis++) {
			position[axis] = position[axis] + linear[axis] * modifier + outward[axis] * radial;
			moving[axis] = moving[axis] + linearNow[axis] * modifier + outward[axis] * radialSpeed;
		}
		// the orbit turns the particle about the offset by its rate's integral over the age; applied to the whole
		// path, which is exact when the other motion runs along the orbit's axis (the crater rocks rise along
		// theirs)
		for (let axis = 0; axis < 3; axis++) {
			const r = random(seed, id, Channel.OrbitalX + axis);
			turn[axis] = travelled(velocity.orbital[axis], age, life, r, scale) * modifier;
			around[axis] = position[axis] - offset[axis];
		}
		rotateByInto(around, turn, around);
		for (let axis = 0; axis < 3; axis++) {
			position[axis] = around[axis] + offset[axis];
		}
	}

	/**
	 * writes where a particle under a speed limit or force fields is at an age and how it moves then, stepped
	 * ({@link steppedPath}). the velocity module's linear, orbital and radial terms are the extra velocity the
	 * limit includes, and the speed modifier scales each step's move, not what the limit sees; the orbit moves
	 * the particle along its circle's tangent at its current place. drag slows the limited speed, by the size
	 * at each step's age
	 */
	#steppedPath(
		clamp: ParticleClampInfo | null,
		velocity: ParticleVelocityInfo | null,
		motion: PathStart,
		position: Vec3,
		moving: Vec3,
	): void {
		const seed = this.#seed;
		const down = this.#down;
		const worldToLocal = this.#worldToLocal;
		const { id, start, direction, speed, modifier, modifierAt, gravity, age, life, startSize, growth } =
			motion;
		const sizeOver = this.info.sizeOverLifetime;
		const forces = this.#forces;
		const limit = clamp?.kind === 'limit' ? clamp : null;
		const drag = clamp?.kind === 'drag' ? clamp : (limit?.drag ?? null);
		let push: ((age: number, moved: Readonly<Vec3>, own: Vec3, step: number) => void) | null = null;
		if (forces !== null) {
			const randoms = stepped.randoms;
			randoms.multiplier = random(seed, id, Channel.ForceMultiplier);
			randoms.tiltX = random(seed, id, Channel.ForceTiltX);
			randoms.tiltZ = random(seed, id, Channel.ForceTiltZ);
			randoms.direction[0] = random(seed, id, Channel.ForceDirectionX);
			randoms.direction[1] = random(seed, id, Channel.ForceDirectionY);
			randoms.direction[2] = random(seed, id, Channel.ForceDirectionZ);
			randoms.gravity = random(seed, id, Channel.ForceGravity);
			randoms.spin = random(seed, id, Channel.ForceSpin);
			randoms.attraction = random(seed, id, Channel.ForceAttraction);
			randoms.drag = random(seed, id, Channel.ForceDrag);
			const at = stepped.at;
			push = (t, moved, own, step) => {
				for (let axis = 0; axis < 3; axis++) {
					at[axis] = start[axis] + moved[axis];
				}
				const lived = livedAt(t, life);
				// drag by size reads the first axis' size
				const size = startSize[0] * (sizeOver === null ? 1 : evaluateMinMax(sizeOver[0], lived, growth));
				applyForces(forces, at, own, lived, size, randoms, step);
			};
		}
		let extra: (age: number, moved: Readonly<Vec3>) => Readonly<Vec3> = noExtra;
		if (velocity !== null) {
			const { linearRandoms, orbitRandoms, linear, spin, from, outward } = stepped;
			for (let axis = 0; axis < 3; axis++) {
				linearRandoms[axis] = random(seed, id, Channel.VelocityX + axis);
				orbitRandoms[axis] = random(seed, id, Channel.OrbitalX + axis);
			}
			const radialRandom = random(seed, id, Channel.Radial);
			const result = stepped.extra;
			extra = (t, moved) => {
				const lived = livedAt(t, life);
				for (let axis = 0; axis < 3; axis++) {
					linear[axis] = evaluateMinMax(velocity.linear[axis], lived, linearRandoms[axis]);
					spin[axis] = evaluateMinMax(velocity.orbital[axis], lived, orbitRandoms[axis]);
				}
				const radial = evaluateMinMax(velocity.radial, lived, radialRandom);
				if (velocity.linearInWorld) {
					copy(linear, worldToLocal(linear));
				}
				const centre = velocity.orbitalOffset;
				for (let axis = 0; axis < 3; axis++) {
					from[axis] = start[axis] + moved[axis] - centre[axis];
				}
				normalizeOrZInto(outward, from[0], from[1], from[2]);
				// ω × r, the orbit's velocity at the particle's place
				result[0] = linear[0] + spin[1] * from[2] - spin[2] * from[1] + outward[0] * radial;
				result[1] = linear[1] + spin[2] * from[0] - spin[0] * from[2] + outward[1] * radial;
				result[2] = linear[2] + spin[0] * from[1] - spin[1] * from[0] + outward[2] * radial;
				return result;
			};
		}
		const launch = stepped.start;
		const acceleration = stepped.acceleration;
		for (let axis = 0; axis < 3; axis++) {
			launch[axis] = direction[axis] * speed;
			acceleration[axis] = down[axis] * gravity;
		}
		const {
			offset,
			velocity: v,
			state,
		} = steppedPath({
			limit: limit === null ? null : { info: limit, r: random(seed, id, Channel.SpeedLimit) },
			drag:
				drag === null
					? null
					: {
							info: drag,
							r: random(seed, id, Channel.Drag),
							// the larger axis of a 3D size, as the game reads it
							size: (t) => {
								const lived = livedAt(t, life);
								let size = 0;
								for (let axis = 0; axis < 3; axis++) {
									const over = sizeOver === null ? 1 : evaluateMinMax(sizeOver[axis], lived, growth);
									size = Math.max(size, startSize[axis] * over);
								}
								return size;
							},
						},
			start: launch,
			acceleration,
			push,
			extra,
			modifier: modifierAt ?? (() => modifier),
			age,
			life,
			from: this.#stepped.get(id),
		});
		this.#steppedNow.set(id, state);
		for (let axis = 0; axis < 3; axis++) {
			position[axis] = start[axis] + offset[axis];
		}
		copy(moving, v);
	}

	/** writes one live particle at `out[at]` */
	#place(particle: Readonly<Placing>, out: Float32Array, at: number): void {
		const info = this.info;
		const seed = this.#seed;
		const { id, born, life, age, moved } = particle;
		const u = this.#loopFraction(born);
		const start = begin.position;
		this.#start(id, start, begin.direction);
		if (this.#emittedFrom !== null) {
			// it leaves from the shape where the emitter was then, and moves on in the world from there
			const m = this.#emittedFrom(born);
			const [x, y, z] = start;
			start[0] = m[0] * x + m[1] * y + m[2] * z + m[3];
			start[1] = m[4] * x + m[5] * y + m[6] * z + m[7];
			start[2] = m[8] * x + m[9] * y + m[10] * z + m[11];
			const direction = begin.direction;
			const [dx, dy, dz] = direction;
			normalizeOrZInto(
				direction,
				m[0] * dx + m[1] * dy + m[2] * dz,
				m[4] * dx + m[5] * dy + m[6] * dz,
				m[8] * dx + m[9] * dy + m[10] * dz,
			);
		}
		const lived = life > 0 ? age / life : 0;
		const sizeRandom = random(seed, id, Channel.Size);
		const growth = random(seed, id, Channel.SizeOverLifetime);
		const startSize = begin.size;
		for (let axis = 0; axis < 3; axis++) {
			startSize[axis] = evaluateMinMax(info.startSize[axis], u, sizeRandom);
		}
		const { position, moving } = placed;
		const motion = info.motion;
		if (motion.kind === 'spline') {
			// a path's particles start at their place in the shape, offset from it
			const along = this.#splineAt(id, age, life);
			for (let axis = 0; axis < 3; axis++) {
				position[axis] = start[axis] + (along?.position[axis] ?? 0);
				moving[axis] = along?.moving[axis] ?? 0;
			}
		} else {
			const { velocity, clamp } = motion;
			let modifier = 1;
			let modifierAt: ((age: number) => number) | null = null;
			if (velocity !== null) {
				const curve = velocity.speedModifier;
				const r = random(seed, id, Channel.SpeedModifier);
				if (curve.mode === CurveMode.Constant || curve.mode === CurveMode.TwoConstants) {
					modifier = evaluateMinMax(curve, 0, r);
				} else {
					// the game reads it each step at the particle's age over its lifetime, as linear velocities
					modifierAt = (a) => evaluateMinMax(curve, livedAt(a, life), r);
					path.modifierCurve.curve = curve;
					path.modifierCurve.r = r;
				}
			}
			path.id = id;
			path.speed = evaluateMinMax(motion.startSpeed, u, random(seed, id, Channel.Speed));
			path.modifier = modifier;
			path.modifierAt = modifierAt;
			// gravity, which Unity always pulls down the world's y
			path.gravity = GRAVITY * evaluateMinMax(motion.gravityModifier, u, random(seed, id, Channel.Gravity));
			path.age = moved;
			path.life = life;
			path.growth = growth;
			if (clamp?.kind === 'limit' || motion.forces !== null) {
				this.#steppedPath(clamp, velocity, path, position, moving);
			} else {
				this.#freePath(clamp, velocity, path, position, moving);
			}
		}
		const over = info.sizeOverLifetime;
		for (let axis = 0; axis < 3; axis++) {
			out[at + ParticleFloat.position + axis] = position[axis];
			out[at + ParticleFloat.size + axis] =
				startSize[axis] * (over === null ? 1 : evaluateMinMax(over[axis], livedAt(age, life), growth));
		}

		const angles = placed.angles;
		const spin = info.rotationOverLifetime;
		for (let axis = 0; axis < 3; axis++) {
			angles[axis] = evaluateMinMax(info.startRotation[axis], u, random(seed, id, Channel.RotationX + axis));
			if (spin !== null) {
				// a paused particle keeps spinning at its last rate
				angles[axis] += travelled(spin[axis], moved, life, random(seed, id, Channel.SpinX + axis));
			}
		}
		const rotation = eulerQuaternionInto(placed.rotation, angles[0], angles[1], angles[2]);
		for (let k = 0; k < 4; k++) {
			out[at + ParticleFloat.rotation + k] = rotation[k];
		}
		const color = evaluateMinMaxGradientInto(
			placed.color,
			info.startColor,
			u,
			random(seed, id, Channel.Color),
		);
		const shapeTint = begin.tint;
		let red = color[0] * shapeTint[0];
		let green = color[1] * shapeTint[1];
		let blue = color[2] * shapeTint[2];
		let alpha = color[3] * shapeTint[3];
		if (info.colorOverLifetime !== null) {
			const tint = evaluateMinMaxGradientInto(
				placed.color,
				info.colorOverLifetime,
				Math.min(lived, 1),
				random(seed, id, Channel.ColorOverLifetime),
			);
			red = red * tint[0];
			green = green * tint[1];
			blue = blue * tint[2];
			alpha = alpha * tint[3];
		}
		out[at + ParticleFloat.tile] =
			info.textureSheet === null ? 0 : sheetTile(info.textureSheet, lived, age, u, this.#randomOf, info.mesh);
		out[at + ParticleFloat.color] = srgbToLinear(red);
		out[at + ParticleFloat.color + 1] = srgbToLinear(green);
		out[at + ParticleFloat.color + 2] = srgbToLinear(blue);
		out[at + ParticleFloat.color + 3] = alpha;
		for (let axis = 0; axis < 3; axis++) {
			out[at + ParticleFloat.velocity + axis] = moving[axis];
		}
		// read every frame at the age over the lifetime, each component's random fixed for the particle's life
		const custom = info.customData;
		for (let c = 0; c < 4; c++) {
			const curve = custom?.[c] ?? null;
			out[at + ParticleFloat.custom + c] =
				curve === null ? 0 : evaluateMinMax(curve, Math.min(lived, 1), random(seed, id, Channel.CustomX + c));
		}
	}
}
