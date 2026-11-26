import {
	CurveMode,
	GRAVITY,
	type MinMaxCurveInfo,
	type ParticleClampInfo,
	type ParticleDragInfo,
	type ParticleForcesInfo,
	ParticleMeshSpawn,
	ParticleShapeKind,
	type ParticleSubEmitterInfo,
	ParticleSubEmitterProperty,
	ParticleSubEmitterType,
	type ParticleSystemInfo,
	type ParticleVelocityInfo,
} from '@endfield-noclip/package-format/particles';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { srgbToLinear } from '../math/color.ts';
import { type Quat, eulerQuaternion, eulerQuaternionInto, rotateByInto } from '../math/quat.ts';
import { normalizeOrZInto } from '../math/vec3.ts';

import {
	type BirthState,
	LUT_INTERVALS,
	emptyBirth,
	isZeroCurve,
	linearToSrgb,
	popMin,
	pushMin,
	sameCurve,
	sampleLut,
	spawnShape,
	tabulateCurve,
	tabulateGradient,
} from './birth.ts';
import {
	type DrawnCurve,
	type PreparedIntegral,
	evalPreparedIntegral,
	prepareIntegral,
} from './curve-integrals.ts';
import { evaluateMinMax, evaluateMinMaxGradientInto, livedAt, upperBound } from './curves.ts';
import { type EmissionStream, emissionStream } from './emission-rate.ts';
import { type ForceRandoms, type PreparedField, applyForces, prepareField } from './forces.ts';
import { type PreparedMeshShape, prepareMeshShape } from './mesh-shape.ts';
import { type SteppedState, dragged, draggedFall, splinePoint, steppedPath } from './motion.ts';
import { Channel, hash2, random } from './random.ts';
import { sheetTile } from './texture-sheet.ts';

/**
 * floats per particle in {@link ParticleSimulation.evaluate}'s output: position, rotation (xyzw), size, the
 * texture sheet's tile (0 without a sheet), colour (linear rgb, alpha), velocity (m/s), all in the emitter's
 * frame, then its custom data (`ParticleSystemInfo.customData`, zero without) and its 3-bit axis flip mask
 * (`ParticleSystemInfo.flip`, bit 0 x, bit 1 y, bit 2 z)
 */
export const PARTICLE_FLOATS = 23;

/** where each value starts in a particle's {@link PARTICLE_FLOATS} */
export const ParticleFloat = {
	position: 0,
	rotation: 3,
	size: 7,
	tile: 10,
	color: 11,
	velocity: 15,
	custom: 18,
	flip: 22,
} as const;

/** the most particles one emitter shows */
export const MAX_PARTICLES = 1024;

/** points along each trail ({@link ParticleSimulation.trailPoints}), head and tail included */
export const TRAIL_POINTS = 9;

/** floats per trail point: position in the emitter's frame, width (m), colour (linear rgb, alpha) */
export const TRAIL_POINT_FLOATS = 8;

/** where each value starts in a trail point's {@link TRAIL_POINT_FLOATS} */
export const TrailFloat = {
	position: 0,
	width: 3,
	color: 4,
} as const;

/** floats per particle {@link ParticleSimulation.evaluate} keeps for its trail: its {@link Placing} */
const WRITTEN_FLOATS = 5;

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

/** a sub-emitter emission spawned by a parent particle, carrying its inherited start state */
interface SubEmission extends Emission {
	/** spawn offset in this emitter's frame, m */
	ox: number;
	oy: number;
	oz: number;
	/** inherited start colour multiplier (sRGB, 1 when uninherited) */
	cr: number;
	cg: number;
	cb: number;
	ca: number;
	/** inherited start size multiplier (1 when uninherited) */
	sx: number;
	sy: number;
	sz: number;
	/** inherited Euler rotation offset, rad (0 when uninherited) */
	rx: number;
	ry: number;
	rz: number;
	/** inherited lifetime, s (-1 when uninherited) */
	lifeOverride: number;
	/** inherited normalized emission time, 0–1 (-1 when uninherited) */
	inheritedU: number;
}

/**
 * inverse of `srgbToLinear`, for passing a parent particle's linear colour into a sub-emitter's sRGB start
 * colour
 */
const byTime = (a: Emission, b: Emission): number => a.time - b.time;

/** a burst firing's key within its loop */
const burstKey = (burst: number, cycle: number): number => burst * 2 ** 20 + cycle;

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
	/** the velocity module's speed modifier, 1 when it's a curve ({@link hasModifierCurve}) */
	modifier: number;
	/** whether the velocity module's speed modifier is a curve ({@link modifierCurve}) rather than a constant */
	hasModifierCurve: boolean;
	/** the curve read when {@link hasModifierCurve} is true, and the particle's random value for it */
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
	hasModifierCurve: false,
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
/** a trail's colour before it's read along the trail (`trailPoints`) */
const trailColor: [number, number, number, number] = [0, 0, 0, 0];
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
	/** live particles' cached birth attributes, keyed by particle id and stamped with {@link #evalFrame} */
	readonly #births = new Map<number, BirthState>();
	/** increments on each {@link evaluate} to stamp live {@link BirthState}s without Map churn */
	#evalFrame = 0;
	/** recycled {@link BirthState} records from dead particles */
	readonly #birthPool: BirthState[] = [];
	/** precomputed flags for skipping constant-zero modules on every particle */
	readonly #hasLinear: boolean;
	readonly #hasRadial: boolean;
	readonly #hasOrbital: boolean;
	readonly #hasSpin: boolean;
	readonly #spinAxis: readonly [boolean, boolean, boolean];
	readonly #hasCustom: boolean;
	readonly #modifierConstant: boolean;
	/** pre-resolved curve integrals for this system, avoiding WeakMap lookups per particle */
	readonly #scaleInt0: PreparedIntegral | null;
	readonly #scaleInt1: PreparedIntegral | null;
	readonly #linearInts: readonly [PreparedIntegral, PreparedIntegral, PreparedIntegral] | null;
	readonly #radialInt: PreparedIntegral | null;
	readonly #orbitalInts: readonly [PreparedIntegral, PreparedIntegral, PreparedIntegral] | null;
	readonly #spinInts:
		| readonly [PreparedIntegral | null, PreparedIntegral | null, PreparedIntegral | null]
		| null;
	readonly #splineInt: PreparedIntegral | null;
	/** whether `sizeOverLifetime` uses the same curve on all three axes */
	readonly #uniformSizeOver: boolean;
	/** tabulated `sizeOverLifetime` curves when `CurveMode.Curve`, else `null` per axis */
	readonly #sizeOverLuts: readonly [Float32Array | null, Float32Array | null, Float32Array | null] | null;
	/** tabulated `colorOverLifetime` when `GradientMode.Gradient`, else `null` */
	readonly #colorOverLut: Float32Array | null;
	/** world down in the emitter's frame, for the current {@link evaluate} */
	#down: Readonly<Vec3> = ZERO;
	/** turns a world direction into the emitter's frame, for the current {@link evaluate} */
	#worldToLocal: (direction: Vec3) => Vec3 = (direction) => direction;
	/** where a moving emitter was at an emission, for the current {@link evaluate}; `null` when it holds still */
	#emittedFrom: ((born: number) => Readonly<Float64Array>) | null = null;
	/** the {@link Placing} of each particle the current {@link evaluate} wrote, for {@link trailPoints} */
	#written = new Float64Array(0);
	/** one particle's floats, which {@link trailPoints} places it at its trail's earlier ages into */
	readonly #earlier = new Float32Array(PARTICLE_FLOATS);
	/** parent simulation when this system is driven as a sub-emitter (`SubModule`); `null` otherwise */
	readonly #subEmitter: ParticleSubEmitterInfo | null;
	readonly #parent: ParticleSimulation | null;
	/** scratch buffer for evaluating one parent particle at a sub-emitter spawn time */
	readonly #parentOut: Float32Array | null;
	/** sub-emitter emissions collected for the current {@link evaluate} */
	readonly #subEmissions: SubEmission[] = [];
	/** the particle being placed's random value for a channel */
	readonly #randomOf = (channel: number): number => random(this.#seed, placing.id, channel);

	/**
	 * @param info the system
	 * @param seed the emitter's random seed; emitters drawing other meshes of the same renderer share it
	 */
	constructor(info: ParticleSystemInfo, seed: number) {
		this.info = info;
		this.#seed = seed;
		this.#subEmitter = info.subEmitter ?? null;
		this.#parent =
			this.#subEmitter === null
				? null
				: new ParticleSimulation(this.#subEmitter.parent, hash2(seed, 0x517c_c1b7));
		this.#parentOut = this.#parent === null ? null : new Float32Array(PARTICLE_FLOATS);
		this.#startDelay = Math.max(evaluateMinMax(info.startDelay, 0, random(seed, 0, Channel.StartDelay)), 0);
		this.#longest = Math.max(upperBound(info.startLifetime), 0);
		if (
			this.#subEmitter !== null &&
			(this.#subEmitter.properties & ParticleSubEmitterProperty.Lifetime) !== 0
		) {
			const parentSpeed = Math.max(this.#subEmitter.parent.simulationSpeed, 1e-6);
			const parentLongest = Math.max(upperBound(this.#subEmitter.parent.startLifetime), 0);
			this.#longest = Math.max(this.#longest, (parentLongest * info.simulationSpeed) / parentSpeed);
		}
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
		const velocity = info.motion.kind === 'free' ? info.motion.velocity : null;
		this.#hasLinear =
			velocity !== null &&
			(!isZeroCurve(velocity.linear[0]) ||
				!isZeroCurve(velocity.linear[1]) ||
				!isZeroCurve(velocity.linear[2]));
		this.#hasRadial = velocity !== null && !isZeroCurve(velocity.radial);
		this.#hasOrbital =
			velocity !== null &&
			(!isZeroCurve(velocity.orbital[0]) ||
				!isZeroCurve(velocity.orbital[1]) ||
				!isZeroCurve(velocity.orbital[2]));
		const spin = info.rotationOverLifetime;
		this.#spinAxis =
			spin === null
				? [false, false, false]
				: [!isZeroCurve(spin[0]), !isZeroCurve(spin[1]), !isZeroCurve(spin[2])];
		this.#hasSpin = this.#spinAxis[0] || this.#spinAxis[1] || this.#spinAxis[2];
		const custom = info.customData;
		this.#hasCustom =
			custom !== null &&
			(custom[0] !== null || custom[1] !== null || custom[2] !== null || custom[3] !== null);
		this.#modifierConstant =
			velocity === null ||
			velocity.speedModifier.mode === CurveMode.Constant ||
			velocity.speedModifier.mode === CurveMode.TwoConstants;
		const scaleCurve = velocity !== null && !this.#modifierConstant ? velocity.speedModifier : null;
		this.#scaleInt0 = scaleCurve === null ? null : prepareIntegral(scaleCurve, null, 0);
		this.#scaleInt1 = scaleCurve === null ? null : prepareIntegral(scaleCurve, null, 1);
		this.#linearInts =
			velocity !== null && this.#hasLinear
				? [
						prepareIntegral(velocity.linear[0], scaleCurve, 0),
						prepareIntegral(velocity.linear[1], scaleCurve, 0),
						prepareIntegral(velocity.linear[2], scaleCurve, 0),
					]
				: null;
		this.#radialInt =
			velocity !== null && this.#hasRadial ? prepareIntegral(velocity.radial, scaleCurve, 0) : null;
		this.#orbitalInts =
			velocity !== null && this.#hasOrbital
				? [
						prepareIntegral(velocity.orbital[0], scaleCurve, 0),
						prepareIntegral(velocity.orbital[1], scaleCurve, 0),
						prepareIntegral(velocity.orbital[2], scaleCurve, 0),
					]
				: null;
		this.#spinInts =
			spin !== null && this.#hasSpin
				? [
						this.#spinAxis[0] ? prepareIntegral(spin[0], null, 0) : null,
						this.#spinAxis[1] ? prepareIntegral(spin[1], null, 0) : null,
						this.#spinAxis[2] ? prepareIntegral(spin[2], null, 0) : null,
					]
				: null;
		this.#splineInt = info.motion.kind === 'spline' ? prepareIntegral(info.motion.speed, null, 0) : null;
		const sizeOver = info.sizeOverLifetime;
		this.#uniformSizeOver =
			sizeOver !== null && sameCurve(sizeOver[0], sizeOver[1]) && sameCurve(sizeOver[0], sizeOver[2]);
		if (sizeOver === null) {
			this.#sizeOverLuts = null;
		} else if (this.#uniformSizeOver) {
			const lut = tabulateCurve(sizeOver[0]);
			this.#sizeOverLuts = [lut, lut, lut];
		} else {
			this.#sizeOverLuts = [
				tabulateCurve(sizeOver[0]),
				tabulateCurve(sizeOver[1]),
				tabulateCurve(sizeOver[2]),
			];
		}
		this.#colorOverLut = tabulateGradient(info.colorOverLifetime);
	}

	/** whether this system loops on its own or is driven by a looping parent sub-emitter */
	get loops(): boolean {
		return this.#parent !== null ? this.#parent.loops : this.info.looping;
	}

	/** seconds a looping system needs to look as if it had always played */
	get settleTime(): number {
		if (this.#parent !== null) {
			const speedRatio =
				Math.max(this.info.simulationSpeed, 1e-6) / Math.max(this.#parent.info.simulationSpeed, 1e-6);
			return this.#parent.settleTime * speedRatio + this.#lookback;
		}
		return this.#startDelay + this.#lookback + this.info.duration;
	}

	/**
	 * the most particles alive at once: the cap, or less when one lifetime of emission holds fewer. a looping
	 * ring buffer adds the replaced particles living out their cycle, one per emission within a lifetime
	 */
	get liveBound(): number {
		const { maxParticles, ringBuffer, emissionBound } = this.info;
		if (this.#parent !== null) {
			return Math.min(maxParticles, MAX_PARTICLES);
		}
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
		// sub-emitters evaluate their parent first so module-level scratch buffers never nest
		const subEmissions = this.#parent !== null ? this.#collectSubEmissions(time, down, worldToLocal) : null;
		this.#down = down;
		this.#worldToLocal = worldToLocal;
		this.#emittedFrom = emittedFrom ?? null;
		let emissions: readonly Emission[];
		if (subEmissions !== null) {
			emissions = subEmissions;
		} else if (this.#capped) {
			emissions = this.#admit(time);
		} else {
			emissions = this.#emitted(time - this.#lookback, time);
		}
		const evalFrame = ++this.#evalFrame;
		this.#steppedNow.clear();
		const capacity = Math.floor(out.length / PARTICLE_FLOATS);
		if (this.info.trail !== null && this.#written.length < capacity * WRITTEN_FLOATS) {
			this.#written = new Float64Array(capacity * WRITTEN_FLOATS);
		}
		const { maxParticles, ringBuffer } = this.info;
		let count = 0;
		let alive = 0;
		for (let i = emissions.length - 1; i >= 0 && count < capacity; i--) {
			// without a ring buffer the cap holds whatever the emissions; with one, replacement does
			if (ringBuffer === null && alive >= maxParticles) {
				break;
			}
			const emission = emissions[i];
			const sub = subEmissions !== null ? subEmissions[i] : null;
			const { time: born, id } = emission;
			let age = time - born;
			const birth = this.#birthOf(emission, sub);
			const life = birth.life;
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
			if (this.#splineAt(birth.splineR, age, life) === null) {
				continue;
			}
			alive++;
			if (birth.drawsMesh) {
				placing.id = id;
				placing.born = born;
				placing.life = life;
				placing.age = age;
				placing.moved = moved;
				this.#place(placing, birth, out, count * PARTICLE_FLOATS, sub);
				if (this.info.trail !== null) {
					const w = count * WRITTEN_FLOATS;
					this.#written[w] = id;
					this.#written[w + 1] = born;
					this.#written[w + 2] = life;
					this.#written[w + 3] = age;
					this.#written[w + 4] = moved;
				}
				count++;
			}
		}
		// keep only the particles still drawn; sweep dead birth records periodically to avoid per-frame Map churn
		[this.#stepped, this.#steppedNow] = [this.#steppedNow, this.#stepped];
		if ((evalFrame & 63) === 0 || this.#births.size > Math.max(this.info.maxParticles * 2, 128)) {
			for (const [id, entry] of this.#births) {
				if (entry.frame !== evalFrame) {
					this.#births.delete(id);
					this.#birthPool.push(entry);
				}
			}
		}
		return count;
	}

	/**
	 * collects sub-emitter emissions driven by {@link #parent} whose particles may still be alive at `time`. all
	 * parent evaluations finish before returning, so module-level scratch buffers never nest
	 */
	#collectSubEmissions(
		time: number,
		down: Vec3,
		worldToLocal: (direction: Vec3) => Vec3,
		windowFrom = time - this.#lookback,
	): SubEmission[] {
		const sub = this.#subEmitter!;
		const parent = this.#parent!;
		const parentOut = this.#parentOut!;
		const out = this.#subEmissions;
		out.length = 0;

		const childSpeed = Math.max(this.info.simulationSpeed, 1e-6);
		const parentSpeed = Math.max(parent.info.simulationSpeed, 1e-6);
		const speedRatio = parentSpeed / childSpeed;
		const parentTime = time * speedRatio;
		const parentFrom = windowFrom * speedRatio;

		// gather parent emissions whose lifetimes overlap [parentFrom, parentTime]
		const parentEvents = parent.#collectWindow(parentFrom, parentTime, down, worldToLocal);
		if (parentEvents.length === 0) {
			return out;
		}

		// collect candidate child triggers (parent event + spawn time) without touching `#place` scratch yet
		interface Trigger {
			parent: { emission: Emission; sub: SubEmission | null; life: number };
			born: number;
			id: number;
		}
		const triggers: Trigger[] = [];
		const parentSeed = parent.#seed;
		for (const pe of parentEvents) {
			if (random(parentSeed, pe.emission.id, Channel.SubEmitter) >= sub.probability) {
				continue;
			}
			const cStart = pe.emission.time / speedRatio;
			const cLife = pe.life / speedRatio;
			if (sub.type === ParticleSubEmitterType.Birth) {
				const localFrom = Math.max(0, windowFrom - cStart);
				const localTo = Math.min(cLife, time - cStart);
				if (localTo < localFrom) {
					continue;
				}
				const localEmissions = this.#emitted(localFrom, localTo);
				for (let j = 0; j < localEmissions.length; j++) {
					const le = localEmissions[j];
					const born = cStart + le.time;
					if (born < windowFrom || born > time) {
						continue;
					}
					triggers.push({ parent: pe, born, id: hash2(pe.emission.id, le.id) });
				}
			} else if (sub.type === ParticleSubEmitterType.Death) {
				const born = cStart + cLife;
				if (born < windowFrom || born > time) {
					continue;
				}
				const localEmissions = this.#emitted(0, 1e-6);
				for (let j = 0; j < localEmissions.length; j++) {
					const le = localEmissions[j];
					triggers.push({ parent: pe, born, id: hash2(pe.emission.id, le.id) });
				}
			}
		}
		if (triggers.length === 0) {
			return out;
		}

		// evaluate each parent particle at its trigger time (all parent `#place` calls finish here)
		parent.#down = down;
		parent.#worldToLocal = worldToLocal;
		parent.#emittedFrom = null;
		const m = sub.fromParent;
		const props = sub.properties;
		const inheritColor = (props & ParticleSubEmitterProperty.Color) !== 0;
		const inheritSize = (props & ParticleSubEmitterProperty.Size) !== 0;
		const inheritRotation = (props & ParticleSubEmitterProperty.Rotation) !== 0;
		const inheritLifetime = (props & ParticleSubEmitterProperty.Lifetime) !== 0;
		const inheritDuration = (props & ParticleSubEmitterProperty.Duration) !== 0;

		for (const trigger of triggers) {
			const pe = trigger.parent;
			const pBorn = pe.emission.time;
			const pAt = trigger.born * speedRatio;
			const pAge = Math.min(Math.max(pAt - pBorn, 0), pe.life);
			const pBirth = parent.#birthOf(pe.emission, pe.sub);
			placing.id = pe.emission.id;
			placing.born = pBorn;
			placing.life = pe.life;
			placing.age = pAge;
			placing.moved = pAge;
			parent.#place(placing, pBirth, parentOut, 0, pe.sub);

			const px = parentOut[ParticleFloat.position];
			const py = parentOut[ParticleFloat.position + 1];
			const pz = parentOut[ParticleFloat.position + 2];
			const ox = m[0] * px + m[4] * py + m[8] * pz + m[12];
			const oy = m[1] * px + m[5] * py + m[9] * pz + m[13];
			const oz = m[2] * px + m[6] * py + m[10] * pz + m[14];

			out.push({
				time: trigger.born,
				id: trigger.id,
				ox,
				oy,
				oz,
				cr: inheritColor ? linearToSrgb(parentOut[ParticleFloat.color]) : 1,
				cg: inheritColor ? linearToSrgb(parentOut[ParticleFloat.color + 1]) : 1,
				cb: inheritColor ? linearToSrgb(parentOut[ParticleFloat.color + 2]) : 1,
				ca: inheritColor ? parentOut[ParticleFloat.color + 3] : 1,
				sx: inheritSize ? parentOut[ParticleFloat.size] : 1,
				sy: inheritSize ? parentOut[ParticleFloat.size + 1] : 1,
				sz: inheritSize ? parentOut[ParticleFloat.size + 2] : 1,
				rx: inheritRotation ? pBirth.rotX : 0,
				ry: inheritRotation ? pBirth.rotY : 0,
				rz: inheritRotation ? pBirth.rotZ : 0,
				lifeOverride: inheritLifetime ? Math.max(pe.life - pAge, 0) / speedRatio : -1,
				inheritedU: inheritDuration ? livedAt(pAge, pe.life) : -1,
			});
		}
		out.sort(byTime);
		return out;
	}

	/** returns this system's emissions whose lifetimes overlap `[from, to]`, for driving a child sub-emitter */
	#collectWindow(
		from: number,
		to: number,
		down: Vec3,
		worldToLocal: (direction: Vec3) => Vec3,
	): { emission: Emission; sub: SubEmission | null; life: number }[] {
		const events: { emission: Emission; sub: SubEmission | null; life: number }[] = [];
		if (this.#parent !== null) {
			// multi-level chain: gather our own sub-emissions whose lifetimes can overlap [from, to]
			const subs = this.#collectSubEmissions(to, down, worldToLocal, from - this.#longest);
			for (const s of subs) {
				const life = s.lifeOverride >= 0 ? s.lifeOverride : this.#lifetime(s);
				if (s.time + life >= from && s.time <= to) {
					events.push({ emission: { time: s.time, id: s.id }, sub: { ...s }, life });
				}
			}
			return events;
		}
		if (this.#capped) {
			const retain = Math.max(to - from, 0);
			const source = this.#admit(to, retain);
			for (let i = 0; i < source.length; i++) {
				const e = source[i];
				if (e.time + e.life >= from && e.time <= to) {
					events.push({ emission: { time: e.time, id: e.id }, sub: null, life: e.life });
				}
			}
		} else {
			const source = this.#emitted(from - this.#longest, to);
			for (let i = 0; i < source.length; i++) {
				const e = source[i];
				const life = this.#lifetime(e);
				if (e.time + life >= from && e.time <= to) {
					events.push({ emission: { time: e.time, id: e.id }, sub: null, life });
				}
			}
		}
		return events;
	}

	/** looks up or creates a live particle's {@link BirthState}, stamping it with {@link #evalFrame} */
	#birthOf(emission: Emission, sub: SubEmission | null = null): BirthState {
		const { id, time: born } = emission;
		const hasEmittedFrom = this.#emittedFrom !== null;
		let birth = this.#births.get(id);
		if (birth !== undefined && birth.born === born && birth.emittedFrom === hasEmittedFrom) {
			birth.frame = this.#evalFrame;
			return birth;
		}
		birth = this.#birthPool.pop() ?? emptyBirth();
		const u = sub !== null && sub.inheritedU >= 0 ? sub.inheritedU : this.#loopFraction(born);
		birth.born = born;
		birth.frame = this.#evalFrame;
		birth.u = u;
		birth.life =
			sub !== null && sub.lifeOverride >= 0
				? sub.lifeOverride
				: evaluateMinMax(this.info.startLifetime, u, random(this.#seed, id, Channel.Lifetime));
		birth.drawsMesh = this.#drawsMesh(id);
		birth.placed = false;
		birth.emittedFrom = hasEmittedFrom;
		if (this.info.motion.kind === 'spline') {
			birth.splineR = random(this.#seed, id, Channel.SplineSpeed);
		}
		this.#births.set(id, birth);
		return birth;
	}

	/**
	 * @returns where a particle is along the system's path and how it moves there, in the path's frame:
	 *   `undefined` without a path, `null` once it has run off the end
	 */
	#splineAt(r: number, age: number, life: number): { position: Vec3; moving: Vec3 } | null | undefined {
		const spline = this.info.motion;
		if (spline.kind !== 'spline' || this.#splineInt === null) {
			return undefined;
		}
		const point = splinePoint(spline, evalPreparedIntegral(this.#splineInt, r, 0, age, life));
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
	#admit(time: number, retain = 0): AdmittedEmission[] {
		const { maxParticles } = this.info;
		const startDelay = this.#startDelay;
		const admitted = this.#admitted;
		const ends = this.#admittedEnds;
		// further back than a few lifetimes (plus any sub-emitter retention) the history barely shows, so a long
		// jump or a step back starts afresh from an empty system there
		const horizon = 4 * this.#longest + this.info.duration + retain;
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
			// drop those past their lifetime + retention by the window's end, in order
			let kept = 0;
			for (const emission of admitted) {
				if (emission.time + emission.life + retain > to) {
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
				if (emission.time + emission.life + retain > time) {
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
		// trails follow every particle, whichever mesh it draws
		if (weights.length <= 1 || this.info.trail !== null) {
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
		spawnShape(
			this.info.shape,
			this.#meshShape,
			this.#shapeRotation,
			this.#seed,
			id,
			position,
			direction,
			begin.tint,
		);
	}

	/** writes where an unlimited particle is at an age and how it moves then, in closed form */
	#freePath(
		drag: ParticleDragInfo | null,
		velocity: ParticleVelocityInfo | null,
		motion: PathStart,
		birth: BirthState,
		position: Vec3,
		moving: Vec3,
	): void {
		const down = this.#down;
		const {
			start,
			direction,
			speed,
			modifier,
			hasModifierCurve,
			modifierCurve,
			gravity,
			startSize,
			age,
			life,
		} = motion;
		const scaleR = birth.modifierR;
		// a ring buffer's paused particle moves on past its lifetime with its curves at their end
		const lived = livedAt(age, life);
		// the game moves a particle by its whole velocity times the speed modifier: `scaledAge` is the modifier's
		// integral over the age, which a constant velocity moves by, and `scaleNow` its value now
		const scaledAge =
			this.#scaleInt0 === null ? age : evalPreparedIntegral(this.#scaleInt0, scaleR, 0, age, life);
		const scaleNow = hasModifierCurve ? evaluateMinMax(modifierCurve.curve, lived, modifierCurve.r) : 1;
		let launch: number, launchSpeed: number, fall: number, fallSpeed: number;
		if (drag === null) {
			launch = speed * modifier * scaledAge;
			launchSpeed = speed * modifier * scaleNow;
			// gravity builds up in the velocity the modifier scales, so the fall is ∫ g·τ·m(τ) dτ
			fall =
				this.#scaleInt1 === null
					? 0.5 * gravity * modifier * age * age
					: gravity * evalPreparedIntegral(this.#scaleInt1, scaleR, 0, age, life);
			fallSpeed = gravity * age * modifier * scaleNow;
		} else {
			// drag slows the velocity itself and the constant modifier (curves don't come with drag) scales the move
			const size = Math.max(startSize[0], startSize[1], startSize[2]);
			[launch, launchSpeed] = dragged(drag, speed, size, age, birth.dragR);
			[fall, fallSpeed] = draggedFall(drag, gravity, size, age, birth.dragR);
			launch *= modifier;
			launchSpeed *= modifier;
			fall *= modifier;
			fallSpeed *= modifier;
		}
		position[0] = start[0] + direction[0] * launch + down[0] * fall;
		position[1] = start[1] + direction[1] * launch + down[1] * fall;
		position[2] = start[2] + direction[2] * launch + down[2] * fall;
		moving[0] = direction[0] * launchSpeed + down[0] * fallSpeed;
		moving[1] = direction[1] * launchSpeed + down[1] * fallSpeed;
		moving[2] = direction[2] * launchSpeed + down[2] * fallSpeed;
		if (velocity === null) {
			return;
		}
		const { linear, linearNow, turn, around } = free;
		const linearInts = this.#linearInts;
		if (linearInts !== null) {
			linear[0] = evalPreparedIntegral(linearInts[0], birth.linearR0, scaleR, age, life);
			linear[1] = evalPreparedIntegral(linearInts[1], birth.linearR1, scaleR, age, life);
			linear[2] = evalPreparedIntegral(linearInts[2], birth.linearR2, scaleR, age, life);
			linearNow[0] = evaluateMinMax(velocity.linear[0], lived, birth.linearR0) * scaleNow;
			linearNow[1] = evaluateMinMax(velocity.linear[1], lived, birth.linearR1) * scaleNow;
			linearNow[2] = evaluateMinMax(velocity.linear[2], lived, birth.linearR2) * scaleNow;
			if (velocity.linearInWorld) {
				copy(linear, this.#worldToLocal(linear));
				copy(linearNow, this.#worldToLocal(linearNow));
			}
			position[0] += linear[0] * modifier;
			position[1] += linear[1] * modifier;
			position[2] += linear[2] * modifier;
			moving[0] += linearNow[0] * modifier;
			moving[1] += linearNow[1] * modifier;
			moving[2] += linearNow[2] * modifier;
		}
		const radialInt = this.#radialInt;
		if (radialInt !== null) {
			const radialSpeed = evaluateMinMax(velocity.radial, lived, birth.radialR) * modifier * scaleNow;
			const radial = evalPreparedIntegral(radialInt, birth.radialR, scaleR, age, life) * modifier;
			position[0] += birth.outwardX * radial;
			position[1] += birth.outwardY * radial;
			position[2] += birth.outwardZ * radial;
			moving[0] += birth.outwardX * radialSpeed;
			moving[1] += birth.outwardY * radialSpeed;
			moving[2] += birth.outwardZ * radialSpeed;
		}
		const orbitalInts = this.#orbitalInts;
		if (orbitalInts !== null) {
			// the orbit turns the particle about the offset by its rate's integral over the age; applied to the whole
			// path, which is exact when the other motion runs along the orbit's axis (the crater rocks rise along
			// theirs)
			const offset = velocity.orbitalOffset;
			turn[0] = evalPreparedIntegral(orbitalInts[0], birth.orbitalR0, scaleR, age, life) * modifier;
			turn[1] = evalPreparedIntegral(orbitalInts[1], birth.orbitalR1, scaleR, age, life) * modifier;
			turn[2] = evalPreparedIntegral(orbitalInts[2], birth.orbitalR2, scaleR, age, life) * modifier;
			around[0] = position[0] - offset[0];
			around[1] = position[1] - offset[1];
			around[2] = position[2] - offset[2];
			rotateByInto(around, turn, around);
			position[0] = around[0] + offset[0];
			position[1] = around[1] + offset[1];
			position[2] = around[2] + offset[2];
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
		const {
			id,
			start,
			direction,
			speed,
			modifier,
			hasModifierCurve,
			modifierCurve,
			gravity,
			age,
			life,
			startSize,
			growth,
		} = motion;
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
		let dragInput = null;
		if (drag !== null) {
			dragInput = {
				info: drag,
				r: random(seed, id, Channel.Drag),
				// the larger axis of a 3D size, as the game reads it
				size: (t: number) => {
					const lived = livedAt(t, life);
					let size = 0;
					for (let axis = 0; axis < 3; axis++) {
						const over = sizeOver === null ? 1 : evaluateMinMax(sizeOver[axis], lived, growth);
						size = Math.max(size, startSize[axis] * over);
					}
					return size;
				},
			};
		}
		const {
			offset,
			velocity: v,
			state,
		} = steppedPath({
			limit: limit === null ? null : { info: limit, r: random(seed, id, Channel.SpeedLimit) },
			drag: dragInput,
			start: launch,
			acceleration,
			push,
			extra,
			modifier: hasModifierCurve
				? (a) => evaluateMinMax(modifierCurve.curve, livedAt(a, life), modifierCurve.r)
				: () => modifier,
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
	/**
	 * the points of a particle's trail, from its head at the particle to its tail, where the particle was a
	 * trail's lifetime before (or at its birth). along the trail, its width and colour are read at the point's
	 * place in the points, 0 at the head and 1 at the tail
	 *
	 * @param index the particle, in the order the last {@link evaluate} wrote them
	 * @param particles what that {@link evaluate} wrote
	 * @param out {@link TRAIL_POINTS} × {@link TRAIL_POINT_FLOATS} floats
	 * @returns how many points were written: {@link TRAIL_POINTS}, or 0 for a particle without a trail or
	 *   before its trail has any length
	 */
	trailPoints(index: number, particles: Float32Array, out: Float32Array): number {
		const trail = this.info.trail;
		if (trail === null) {
			return 0;
		}
		const seed = this.#seed;
		const w = this.#written;
		const at = index * WRITTEN_FLOATS;
		const id = w[at];
		const life = w[at + 2];
		const age = w[at + 3];
		const moved = w[at + 4];
		if (life <= 0 || moved <= 0 || random(seed, id, Channel.TrailRatio) >= trail.ratio) {
			return 0;
		}
		const base = index * PARTICLE_FLOATS;
		const size = particles[base + ParticleFloat.size];
		let lifetime = evaluateMinMax(trail.lifetime, 0, random(seed, id, Channel.TrailLifetime)) * life;
		if (trail.sizeAffectsLifetime) {
			lifetime *= size;
		}
		const span = Math.min(moved, lifetime);
		if (!(span > 0)) {
			return 0;
		}
		// the whole trail's colour, then the particle's when it inherits it
		const tint = evaluateMinMaxGradientInto(
			placed.color,
			trail.colorOverLifetime,
			livedAt(age, life),
			random(seed, id, Channel.TrailColor),
		);
		const color = trailColor;
		for (let c = 0; c < 4; c++) {
			const own = c < 3 ? srgbToLinear(tint[c]) : tint[3];
			color[c] = trail.inheritParticleColor ? own * particles[base + ParticleFloat.color + c] : own;
		}
		const widthRandom = random(seed, id, Channel.TrailWidth);
		const alongRandom = random(seed, id, Channel.TrailColorOverTrail);
		const earlier = this.#earlier;
		const birth = this.#births.get(id);
		if (birth === undefined) {
			return 0;
		}
		placing.id = id;
		placing.born = w[at + 1];
		placing.life = life;
		for (let k = 0; k < TRAIL_POINTS; k++) {
			const along = k / (TRAIL_POINTS - 1);
			const o = k * TRAIL_POINT_FLOATS;
			let from = particles;
			let fromAt = base;
			if (k > 0) {
				// where the particle was then; only paths read at any age have trails (the packer checks)
				const earlierMoved = moved - along * span;
				placing.moved = earlierMoved;
				placing.age = Math.min(earlierMoved, life);
				this.#place(placing, birth, earlier, 0);
				from = earlier;
				fromAt = 0;
			}
			for (let axis = 0; axis < 3; axis++) {
				out[o + TrailFloat.position + axis] = from[fromAt + ParticleFloat.position + axis];
			}
			out[o + TrailFloat.width] =
				evaluateMinMax(trail.width, along, widthRandom) * (trail.sizeAffectsWidth ? size : 1);
			const shade = evaluateMinMaxGradientInto(placed.color, trail.colorOverTrail, along, alongRandom);
			for (let c = 0; c < 3; c++) {
				out[o + TrailFloat.color + c] = color[c] * srgbToLinear(shade[c]);
			}
			out[o + TrailFloat.color + 3] = color[3] * shade[3];
		}
		return TRAIL_POINTS;
	}

	/** computes a particle's immutable birth attributes and random draws once, into `birth` */
	#populateBirth(id: number, birth: BirthState, sub: SubEmission | null): void {
		const info = this.info;
		const seed = this.#seed;
		const u = birth.u;
		const start = begin.position;
		const direction = begin.direction;
		this.#start(id, start, direction);
		if (sub !== null) {
			start[0] += sub.ox;
			start[1] += sub.oy;
			start[2] += sub.oz;
		}
		if (this.#emittedFrom !== null) {
			// it leaves from the shape where the emitter was then, and moves on in the world from there
			const m = this.#emittedFrom(birth.born);
			const [x, y, z] = start;
			start[0] = m[0] * x + m[1] * y + m[2] * z + m[3];
			start[1] = m[4] * x + m[5] * y + m[6] * z + m[7];
			start[2] = m[8] * x + m[9] * y + m[10] * z + m[11];
			const [dx, dy, dz] = direction;
			normalizeOrZInto(
				direction,
				m[0] * dx + m[1] * dy + m[2] * dz,
				m[4] * dx + m[5] * dy + m[6] * dz,
				m[8] * dx + m[9] * dy + m[10] * dz,
			);
		}
		birth.startX = start[0];
		birth.startY = start[1];
		birth.startZ = start[2];
		birth.dirX = direction[0];
		birth.dirY = direction[1];
		birth.dirZ = direction[2];

		const sizeRandom = random(seed, id, Channel.Size);
		birth.sizeX = evaluateMinMax(info.startSize[0], u, sizeRandom) * (sub?.sx ?? 1);
		birth.sizeY = evaluateMinMax(info.startSize[1], u, sizeRandom) * (sub?.sy ?? 1);
		birth.sizeZ = evaluateMinMax(info.startSize[2], u, sizeRandom) * (sub?.sz ?? 1);
		birth.growth = info.sizeOverLifetime === null ? 0 : random(seed, id, Channel.SizeOverLifetime);

		const motion = info.motion;
		if (motion.kind === 'free') {
			const { velocity, clamp } = motion;
			birth.speed = evaluateMinMax(motion.startSpeed, u, random(seed, id, Channel.Speed));
			// gravity, which Unity always pulls down the world's y
			birth.gravity = GRAVITY * evaluateMinMax(motion.gravityModifier, u, random(seed, id, Channel.Gravity));
			if (velocity !== null) {
				const r = random(seed, id, Channel.SpeedModifier);
				birth.modifierR = r;
				birth.modifier = this.#modifierConstant ? evaluateMinMax(velocity.speedModifier, 0, r) : 1;
				if (this.#hasLinear) {
					birth.linearR0 = random(seed, id, Channel.VelocityX);
					birth.linearR1 = random(seed, id, Channel.VelocityY);
					birth.linearR2 = random(seed, id, Channel.VelocityZ);
				}
				if (this.#hasRadial) {
					birth.radialR = random(seed, id, Channel.Radial);
					const offset = velocity.orbitalOffset;
					normalizeOrZInto(free.outward, start[0] - offset[0], start[1] - offset[1], start[2] - offset[2]);
					birth.outwardX = free.outward[0];
					birth.outwardY = free.outward[1];
					birth.outwardZ = free.outward[2];
				}
				if (this.#hasOrbital) {
					birth.orbitalR0 = random(seed, id, Channel.OrbitalX);
					birth.orbitalR1 = random(seed, id, Channel.OrbitalY);
					birth.orbitalR2 = random(seed, id, Channel.OrbitalZ);
				}
			} else {
				birth.modifier = 1;
			}
			if (clamp !== null) {
				birth.dragR = random(seed, id, Channel.Drag);
			}
		}

		birth.rotX =
			evaluateMinMax(info.startRotation[0], u, random(seed, id, Channel.RotationX)) + (sub?.rx ?? 0);
		birth.rotY =
			evaluateMinMax(info.startRotation[1], u, random(seed, id, Channel.RotationY)) + (sub?.ry ?? 0);
		birth.rotZ =
			evaluateMinMax(info.startRotation[2], u, random(seed, id, Channel.RotationZ)) + (sub?.rz ?? 0);
		if (this.#hasSpin) {
			if (this.#spinAxis[0]) {
				birth.spinR0 = random(seed, id, Channel.SpinX);
			}
			if (this.#spinAxis[1]) {
				birth.spinR1 = random(seed, id, Channel.SpinY);
			}
			if (this.#spinAxis[2]) {
				birth.spinR2 = random(seed, id, Channel.SpinZ);
			}
		} else {
			const q = eulerQuaternionInto(placed.rotation, birth.rotX, birth.rotY, birth.rotZ);
			birth.qx = q[0];
			birth.qy = q[1];
			birth.qz = q[2];
			birth.qw = q[3];
		}

		const color = evaluateMinMaxGradientInto(
			placed.color,
			info.startColor,
			u,
			random(seed, id, Channel.Color),
		);
		const shapeTint = begin.tint;
		const red = color[0] * shapeTint[0] * (sub?.cr ?? 1);
		const green = color[1] * shapeTint[1] * (sub?.cg ?? 1);
		const blue = color[2] * shapeTint[2] * (sub?.cb ?? 1);
		const alpha = color[3] * shapeTint[3] * (sub?.ca ?? 1);
		if (info.colorOverLifetime === null) {
			birth.colorR = srgbToLinear(red);
			birth.colorG = srgbToLinear(green);
			birth.colorB = srgbToLinear(blue);
			birth.colorA = alpha;
		} else {
			birth.colorR = red;
			birth.colorG = green;
			birth.colorB = blue;
			birth.colorA = alpha;
			birth.colorOverR = random(seed, id, Channel.ColorOverLifetime);
		}

		if (info.flip !== undefined) {
			const [fx, fy, fz] = info.flip;
			birth.flip =
				(fx > 0 && (fx >= 1 || random(seed, id, Channel.FlipX) < fx) ? 1 : 0) |
				(fy > 0 && (fy >= 1 || random(seed, id, Channel.FlipY) < fy) ? 2 : 0) |
				(fz > 0 && (fz >= 1 || random(seed, id, Channel.FlipZ) < fz) ? 4 : 0);
		} else {
			birth.flip = 0;
		}

		if (this.#hasCustom && info.customData !== null) {
			if (info.customData[0] !== null) {
				birth.customR0 = random(seed, id, Channel.CustomX);
			}
			if (info.customData[1] !== null) {
				birth.customR1 = random(seed, id, Channel.CustomY);
			}
			if (info.customData[2] !== null) {
				birth.customR2 = random(seed, id, Channel.CustomZ);
			}
			if (info.customData[3] !== null) {
				birth.customR3 = random(seed, id, Channel.CustomW);
			}
		}
		birth.placed = true;
	}

	#place(
		particle: Readonly<Placing>,
		birth: BirthState,
		out: Float32Array,
		at: number,
		sub: SubEmission | null = null,
	): void {
		const info = this.info;
		const { id, life, age, moved } = particle;
		if (!birth.placed) {
			this.#populateBirth(id, birth, sub);
		}
		const start = begin.position;
		start[0] = birth.startX;
		start[1] = birth.startY;
		start[2] = birth.startZ;
		const direction = begin.direction;
		direction[0] = birth.dirX;
		direction[1] = birth.dirY;
		direction[2] = birth.dirZ;
		const startSize = begin.size;
		startSize[0] = birth.sizeX;
		startSize[1] = birth.sizeY;
		startSize[2] = birth.sizeZ;

		const lived = life > 0 ? age / life : 0;
		const { position, moving } = placed;
		const motion = info.motion;
		if (motion.kind === 'spline') {
			// a path's particles start at their place in the shape, offset from it
			const along = this.#splineAt(birth.splineR, age, life);
			position[0] = start[0] + (along?.position[0] ?? 0);
			position[1] = start[1] + (along?.position[1] ?? 0);
			position[2] = start[2] + (along?.position[2] ?? 0);
			moving[0] = along?.moving[0] ?? 0;
			moving[1] = along?.moving[1] ?? 0;
			moving[2] = along?.moving[2] ?? 0;
		} else {
			const { velocity, clamp } = motion;
			const hasModifierCurve = !this.#modifierConstant && velocity !== null;
			if (hasModifierCurve) {
				path.modifierCurve.curve = velocity.speedModifier;
				path.modifierCurve.r = birth.modifierR;
			}
			path.id = id;
			path.speed = birth.speed;
			path.modifier = birth.modifier;
			path.hasModifierCurve = hasModifierCurve;
			path.gravity = birth.gravity;
			path.age = moved;
			path.life = life;
			path.growth = birth.growth;
			const dragWithVelocity =
				clamp?.kind === 'drag' && (this.#hasLinear || this.#hasRadial || this.#hasOrbital);
			if (clamp?.kind === 'limit' || motion.forces !== null || dragWithVelocity) {
				this.#steppedPath(clamp, velocity, path, position, moving);
			} else {
				this.#freePath(clamp, velocity, path, birth, position, moving);
			}
		}

		out[at + ParticleFloat.position] = position[0];
		out[at + ParticleFloat.position + 1] = position[1];
		out[at + ParticleFloat.position + 2] = position[2];
		const over = info.sizeOverLifetime;
		if (over === null) {
			out[at + ParticleFloat.size] = birth.sizeX;
			out[at + ParticleFloat.size + 1] = birth.sizeY;
			out[at + ParticleFloat.size + 2] = birth.sizeZ;
		} else {
			const l = livedAt(age, life);
			const luts = this.#sizeOverLuts;
			if (this.#uniformSizeOver) {
				const s = luts?.[0] != null ? sampleLut(luts[0], l) : evaluateMinMax(over[0], l, birth.growth);
				out[at + ParticleFloat.size] = birth.sizeX * s;
				out[at + ParticleFloat.size + 1] = birth.sizeY * s;
				out[at + ParticleFloat.size + 2] = birth.sizeZ * s;
			} else {
				const s0 = luts?.[0] != null ? sampleLut(luts[0], l) : evaluateMinMax(over[0], l, birth.growth);
				const s1 = luts?.[1] != null ? sampleLut(luts[1], l) : evaluateMinMax(over[1], l, birth.growth);
				const s2 = luts?.[2] != null ? sampleLut(luts[2], l) : evaluateMinMax(over[2], l, birth.growth);
				out[at + ParticleFloat.size] = birth.sizeX * s0;
				out[at + ParticleFloat.size + 1] = birth.sizeY * s1;
				out[at + ParticleFloat.size + 2] = birth.sizeZ * s2;
			}
		}

		const spinInts = this.#spinInts;
		if (spinInts !== null) {
			const ax =
				spinInts[0] !== null
					? birth.rotX + evalPreparedIntegral(spinInts[0], birth.spinR0, 0, moved, life)
					: birth.rotX;
			const ay =
				spinInts[1] !== null
					? birth.rotY + evalPreparedIntegral(spinInts[1], birth.spinR1, 0, moved, life)
					: birth.rotY;
			const az =
				spinInts[2] !== null
					? birth.rotZ + evalPreparedIntegral(spinInts[2], birth.spinR2, 0, moved, life)
					: birth.rotZ;
			const rotation = eulerQuaternionInto(placed.rotation, ax, ay, az);
			out[at + ParticleFloat.rotation] = rotation[0];
			out[at + ParticleFloat.rotation + 1] = rotation[1];
			out[at + ParticleFloat.rotation + 2] = rotation[2];
			out[at + ParticleFloat.rotation + 3] = rotation[3];
		} else {
			out[at + ParticleFloat.rotation] = birth.qx;
			out[at + ParticleFloat.rotation + 1] = birth.qy;
			out[at + ParticleFloat.rotation + 2] = birth.qz;
			out[at + ParticleFloat.rotation + 3] = birth.qw;
		}

		if (info.colorOverLifetime === null) {
			out[at + ParticleFloat.color] = birth.colorR;
			out[at + ParticleFloat.color + 1] = birth.colorG;
			out[at + ParticleFloat.color + 2] = birth.colorB;
			out[at + ParticleFloat.color + 3] = birth.colorA;
		} else if (this.#colorOverLut !== null) {
			const lut = this.#colorOverLut;
			const u = lived <= 0 ? 0 : lived >= 1 ? 1 : lived;
			const x = u * LUT_INTERVALS;
			const i = x >= LUT_INTERVALS ? LUT_INTERVALS - 1 : x | 0;
			const f = x - i;
			const o = i * 4;
			const r0 = lut[o];
			const g0 = lut[o + 1];
			const b0 = lut[o + 2];
			const a0 = lut[o + 3];
			out[at + ParticleFloat.color] = srgbToLinear(birth.colorR * (r0 + (lut[o + 4] - r0) * f));
			out[at + ParticleFloat.color + 1] = srgbToLinear(birth.colorG * (g0 + (lut[o + 5] - g0) * f));
			out[at + ParticleFloat.color + 2] = srgbToLinear(birth.colorB * (b0 + (lut[o + 6] - b0) * f));
			out[at + ParticleFloat.color + 3] = birth.colorA * (a0 + (lut[o + 7] - a0) * f);
		} else {
			const tint = evaluateMinMaxGradientInto(
				placed.color,
				info.colorOverLifetime,
				Math.min(lived, 1),
				birth.colorOverR,
			);
			out[at + ParticleFloat.color] = srgbToLinear(birth.colorR * tint[0]);
			out[at + ParticleFloat.color + 1] = srgbToLinear(birth.colorG * tint[1]);
			out[at + ParticleFloat.color + 2] = srgbToLinear(birth.colorB * tint[2]);
			out[at + ParticleFloat.color + 3] = birth.colorA * tint[3];
		}

		out[at + ParticleFloat.tile] =
			info.textureSheet === null
				? 0
				: sheetTile(info.textureSheet, lived, age, birth.u, this.#randomOf, info.mesh);
		out[at + ParticleFloat.velocity] = moving[0];
		out[at + ParticleFloat.velocity + 1] = moving[1];
		out[at + ParticleFloat.velocity + 2] = moving[2];

		// read every frame at the age over the lifetime, each component's random fixed for the particle's life
		if (this.#hasCustom && info.customData !== null) {
			const custom = info.customData;
			const clamped = Math.min(lived, 1);
			out[at + ParticleFloat.custom] =
				custom[0] === null ? 0 : evaluateMinMax(custom[0], clamped, birth.customR0);
			out[at + ParticleFloat.custom + 1] =
				custom[1] === null ? 0 : evaluateMinMax(custom[1], clamped, birth.customR1);
			out[at + ParticleFloat.custom + 2] =
				custom[2] === null ? 0 : evaluateMinMax(custom[2], clamped, birth.customR2);
			out[at + ParticleFloat.custom + 3] =
				custom[3] === null ? 0 : evaluateMinMax(custom[3], clamped, birth.customR3);
		} else {
			out[at + ParticleFloat.custom] = 0;
			out[at + ParticleFloat.custom + 1] = 0;
			out[at + ParticleFloat.custom + 2] = 0;
			out[at + ParticleFloat.custom + 3] = 0;
		}
		out[at + ParticleFloat.flip] = birth.flip;
	}
}
