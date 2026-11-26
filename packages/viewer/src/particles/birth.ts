import {
	CurveMode,
	GradientMode,
	type MinMaxCurveInfo,
	type ParticleShapeInfo,
	ParticleShapeKind,
	type ParticleShapeRadius,
	type ParticleSystemInfo,
} from '@endfield-noclip/package-format/particles';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { type Quat, rotateInto } from '../math/quat.ts';
import { normalizeOrZInto } from '../math/vec3.ts';

import { evaluateMinMax, evaluateMinMaxGradientInto } from './curves.ts';
import { type PreparedMeshShape, meshShapePoint } from './mesh-shape.ts';
import { Channel, random } from './random.ts';
import { unitVectorInto } from './vector-math.ts';

/** intervals for tabulated over-lifetime curves and gradients */
export const LUT_INTERVALS = 128;

/**
 * converts linear colour to sRGB for particle RGBA packing (preserving HDR values > 1 via 1/2.2 gamma,
 * matching the particle shader's decode)
 *
 * @param c linear colour channel
 * @returns encoded sRGB channel
 */
export const linearToSrgb = (c: number): number => {
	if (c <= 0) {
		return 0;
	}
	if (c <= 0.0031308) {
		return c * 12.92;
	}
	if (c >= 1) {
		return c ** (1 / 2.2);
	}
	return 1.055 * c ** (1 / 2.4) - 0.055;
};

/**
 * adds a value to a binary min-heap
 *
 * @param heap the min-heap array
 * @param value the value to insert
 */
export const pushMin = (heap: number[], value: number): void => {
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

/**
 * removes a binary min-heap's smallest value; the heap must not be empty
 *
 * @param heap the min-heap array
 */
export const popMin = (heap: number[]): void => {
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

/**
 * @param curve a MinMaxCurve
 * @returns whether a MinMaxCurve is always zero
 */
export const isZeroCurve = (curve: MinMaxCurveInfo): boolean =>
	curve.mode === CurveMode.Constant && curve.scalar === 0;

/**
 * @param a first curve
 * @param b second curve
 * @returns whether two single-curve or constant MinMaxCurves are identical
 */
export const sameCurve = (a: MinMaxCurveInfo, b: MinMaxCurveInfo): boolean => {
	if (a === b) {
		return true;
	}
	if (a.mode !== b.mode || a.scalar !== b.scalar) {
		return false;
	}
	if (a.mode === CurveMode.Constant) {
		return true;
	}
	if (a.mode === CurveMode.TwoConstants && b.mode === CurveMode.TwoConstants) {
		return a.min === b.min;
	}
	return false;
};

/**
 * @param curve a MinMaxCurve
 * @returns a 129-sample lookup table for a single-curve MinMaxCurve, or `null` for other modes
 */
export const tabulateCurve = (curve: MinMaxCurveInfo): Float32Array | null => {
	if (curve.mode !== CurveMode.Curve) {
		return null;
	}
	const lut = new Float32Array(LUT_INTERVALS + 1);
	for (let i = 0; i <= LUT_INTERVALS; i++) {
		lut[i] = evaluateMinMax(curve, i / LUT_INTERVALS, 0);
	}
	return lut;
};

/**
 * samples a {@link tabulateCurve} table at `u` in [0, 1]
 *
 * @param lut tabulated curve
 * @param u normalized age in `[0, 1]`
 * @returns interpolated curve value
 */
export const sampleLut = (lut: Float32Array, u: number): number => {
	const clamped = u <= 0 ? 0 : u >= 1 ? 1 : u;
	const x = clamped * LUT_INTERVALS;
	const i = x >= LUT_INTERVALS ? LUT_INTERVALS - 1 : x | 0;
	const f = x - i;
	const a = lut[i];
	return a + (lut[i + 1] - a) * f;
};

/**
 * @param gradient colour-over-lifetime gradient
 * @returns a 129×4 RGBA lookup table for a single-gradient colorOverLifetime, or `null` for other modes
 */
export const tabulateGradient = (gradient: ParticleSystemInfo['colorOverLifetime']): Float32Array | null => {
	if (gradient === null || gradient.mode !== GradientMode.Gradient) {
		return null;
	}
	const lut = new Float32Array((LUT_INTERVALS + 1) * 4);
	const tmp: [number, number, number, number] = [0, 0, 0, 0];
	for (let i = 0; i <= LUT_INTERVALS; i++) {
		evaluateMinMaxGradientInto(tmp, gradient, i / LUT_INTERVALS, 0);
		const o = i * 4;
		lut[o] = tmp[0];
		lut[o + 1] = tmp[1];
		lut[o + 2] = tmp[2];
		lut[o + 3] = tmp[3];
	}
	return lut;
};

/**
 * a particle's immutable birth attributes and over-lifetime random draws, computed once when the particle is
 * first seen and reused across frames until it dies
 */
export interface BirthState {
	born: number;
	/** last evaluation frame this particle was alive */
	frame: number;
	u: number;
	life: number;
	drawsMesh: boolean;
	placed: boolean;
	emittedFrom: boolean;
	startX: number;
	startY: number;
	startZ: number;
	dirX: number;
	dirY: number;
	dirZ: number;
	sizeX: number;
	sizeY: number;
	sizeZ: number;
	speed: number;
	gravity: number;
	modifier: number;
	modifierR: number;
	rotX: number;
	rotY: number;
	rotZ: number;
	qx: number;
	qy: number;
	qz: number;
	qw: number;
	colorR: number;
	colorG: number;
	colorB: number;
	colorA: number;
	growth: number;
	colorOverR: number;
	dragR: number;
	splineR: number;
	linearR0: number;
	linearR1: number;
	linearR2: number;
	radialR: number;
	outwardX: number;
	outwardY: number;
	outwardZ: number;
	orbitalR0: number;
	orbitalR1: number;
	orbitalR2: number;
	spinR0: number;
	spinR1: number;
	spinR2: number;
	customR0: number;
	customR1: number;
	customR2: number;
	customR3: number;
	/** 3-bit axis flip mask (bit 0 x, bit 1 y, bit 2 z) */
	flip: number;
}

/** @returns a zeroed {@link BirthState} ready to populate */
export const emptyBirth = (): BirthState => ({
	born: 0,
	frame: 0,
	u: 0,
	life: 0,
	drawsMesh: true,
	placed: false,
	emittedFrom: false,
	startX: 0,
	startY: 0,
	startZ: 0,
	dirX: 0,
	dirY: 0,
	dirZ: 1,
	sizeX: 1,
	sizeY: 1,
	sizeZ: 1,
	speed: 0,
	gravity: 0,
	modifier: 1,
	modifierR: 0,
	rotX: 0,
	rotY: 0,
	rotZ: 0,
	qx: 0,
	qy: 0,
	qz: 0,
	qw: 1,
	colorR: 1,
	colorG: 1,
	colorB: 1,
	colorA: 1,
	growth: 0,
	colorOverR: 0,
	dragR: 0,
	splineR: 0,
	linearR0: 0,
	linearR1: 0,
	linearR2: 0,
	radialR: 0,
	outwardX: 0,
	outwardY: 0,
	outwardZ: 1,
	orbitalR0: 0,
	orbitalR1: 0,
	orbitalR2: 0,
	spinR0: 0,
	spinR1: 0,
	spinR2: 0,
	customR0: 0,
	customR1: 0,
	customR2: 0,
	customR3: 0,
	flip: 0,
});

const innerRadius = (shape: ParticleShapeRadius): number =>
	1 - Math.min(Math.max(shape.radiusThickness, 0), 1);

const spawnScratch = {
	away: [0, 0, 0] as Vec3,
	randoms: [0, 0, 0] as [number, number, number],
};

/**
 * writes where a particle starts and which way it leaves, in the emitter's frame, and its tint
 *
 * @param shape the emitter's shape module, or `null` for a point emitter
 * @param meshShape prepared mesh shape when `shape.kind === ParticleShapeKind.Mesh`
 * @param shapeRotation precomputed quaternion for `shape.rotation`
 * @param seed the system's seed
 * @param id the particle's emission id
 * @param position output start position in emitter space
 * @param direction output unit start direction in emitter space
 * @param tint output RGBA tint (reset to `[1, 1, 1, 1]` before sampling)
 */
export const spawnShape = (
	shape: ParticleShapeInfo | null,
	meshShape: PreparedMeshShape | null,
	shapeRotation: Quat,
	seed: number,
	id: number,
	position: Vec3,
	direction: Vec3,
	tint: [number, number, number, number],
): void => {
	tint.fill(1);
	if (shape === null) {
		position[0] = 0;
		position[1] = 0;
		position[2] = 0;
		direction[0] = 0;
		direction[1] = 0;
		direction[2] = 1;
		return;
	}
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
			if (meshShape === null) {
				position[0] = 0;
				position[1] = 0;
				position[2] = 0;
				direction[0] = 0;
				direction[1] = 0;
				direction[2] = 1;
				break;
			}
			const randoms = spawnScratch.randoms;
			randoms[0] = r0;
			randoms[1] = r1;
			randoms[2] = r2;
			// even ids number the emissions: the rate's stream, or numbered bursts (`#burstsNumbered`)
			meshShapePoint(meshShape, randoms, id % 2 === 0 ? id / 2 : null, position, direction, tint);
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
	rotateInto(position, shapeRotation, position[0] * scale[0], position[1] * scale[1], position[2] * scale[2]);
	position[0] = position[0] + centre[0];
	position[1] = position[1] + centre[1];
	position[2] = position[2] + centre[2];
	rotateInto(
		direction,
		shapeRotation,
		direction[0] * scale[0],
		direction[1] * scale[1],
		direction[2] * scale[2],
	);
	normalizeOrZInto(direction, direction[0], direction[1], direction[2]);
	const away = spawnScratch.away;
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
};
