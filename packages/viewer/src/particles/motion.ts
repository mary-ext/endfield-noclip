import {
	CurveMode,
	type MinMaxCurveInfo,
	type ParticleDragInfo,
	PARTICLE_STEP_RATE,
	type ParticleSpeedLimitInfo,
	type ParticleSplineInfo,
} from '@endfield-noclip/package-format/particles';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { evaluateMinMax, livedAt } from './curves.ts';

/** the drag's deceleration (m/s², or per unit of speed squared), for a particle of a size */
const dragRate = (drag: ParticleDragInfo, size: number, r: number): number =>
	Math.max(evaluateMinMax(drag.amount, 0, r), 0) * (drag.bySize ? Math.PI * (size / 2) ** 2 : 1);

/**
 * a start velocity slowed by drag alone
 *
 * @returns how far it has carried the particle by `age` (m), and its speed then (m/s)
 */
export const dragged = (
	drag: ParticleDragInfo,
	speed: number,
	size: number,
	age: number,
	r: number,
): [number, number] => {
	const k = dragRate(drag, size, r);
	if (k <= 0) {
		return [speed * age, speed];
	}
	const sign = Math.sign(speed);
	const v = Math.abs(speed);
	if (drag.byVelocity) {
		// dv/dt = −k v²
		return [(sign * Math.log1p(k * v * age)) / k, (sign * v) / (1 + k * v * age)];
	}
	// dv/dt = −k until the particle stops
	const moving = Math.min(age, v / k);
	return [sign * (v * moving - 0.5 * k * moving * moving), sign * (v - k * moving)];
};

/**
 * a fall from rest under gravity and drag: towards its terminal speed under drag by speed squared, else at
 * gravity less the drag's deceleration, or not at all when that's the larger
 *
 * @param gravity the acceleration down the world's y, m/s² (negative rises)
 * @returns how far it has fallen by `age` (m), and its speed then (m/s)
 */
export const draggedFall = (
	drag: ParticleDragInfo,
	gravity: number,
	size: number,
	age: number,
	r: number,
): [number, number] => {
	const k = dragRate(drag, size, r);
	if (k <= 0 || gravity === 0) {
		return [0.5 * gravity * age * age, gravity * age];
	}
	const sign = Math.sign(gravity);
	const g = Math.abs(gravity);
	if (drag.byVelocity) {
		const terminal = Math.sqrt(g / k);
		const x = (g * age) / terminal;
		// ln(cosh(x)), kept finite for large x
		const logCosh = x + Math.log1p(Math.exp(-2 * x)) - Math.LN2;
		return [(sign * terminal * terminal * logCosh) / g, sign * terminal * Math.tanh(x)];
	}
	const a = Math.max(g - k, 0);
	return [sign * 0.5 * a * age * age, sign * a * age];
};

/** the most steps {@link steppedPath} takes; longer ages take longer steps */
const MAX_STEPS = 600;

/** where a stepped particle had got to: its age, its own velocity and how far it had moved */
export interface SteppedState {
	readonly age: number;
	readonly own: Readonly<Vec3>;
	readonly offset: Readonly<Vec3>;
}

/**
 * a particle's path where it has no closed form (a speed limit or force fields), stepped at
 * {@link PARTICLE_STEP_RATE} from its birth or from an earlier state of the same path, in the game's order:
 * each step adds gravity to the particle's own velocity, lets the forces change it, pulls the whole speed
 * (its own velocity plus the extra velocity) towards the limit, taking the excess from its own velocity, then
 * moves it by the whole velocity times the speed modifier
 *
 * @param path the limit (and its random value) or `null`, the particle's start velocity, its acceleration,
 *   the forces (which change its own velocity in place, given the step's age, how far it had moved and the
 *   step's length) or `null`, the extra velocity at an age and a distance moved from the start, the speed
 *   modifier at an age, its age and lifetime, in seconds, and the state to continue from (one at or before
 *   `age`, else the birth)
 * @returns how far it has moved by `age`, the velocity it moves at then (the modifier included), and the
 *   state to continue from later, which holds the same `offset`: neither may be changed
 */
export const steppedPath = (path: {
	limit: { info: ParticleSpeedLimitInfo; r: number } | null;
	start: Readonly<Vec3>;
	acceleration: Readonly<Vec3>;
	push: ((age: number, moved: Readonly<Vec3>, own: Vec3, step: number) => void) | null;
	/** its result is read before the next call, so it may reuse one array */
	extra: (age: number, moved: Readonly<Vec3>) => Readonly<Vec3>;
	modifier: (age: number) => number;
	age: number;
	life: number;
	from?: SteppedState;
}): { offset: Vec3; velocity: Vec3; state: SteppedState } => {
	const { limit, acceleration, push, extra, modifier, age, life } = path;
	const from = path.from !== undefined && path.from.age <= age ? path.from : null;
	const fromAge = from?.age ?? 0;
	const fromOwn = from?.own ?? path.start;
	const own: Vec3 = [fromOwn[0], fromOwn[1], fromOwn[2]];
	const offset: Vec3 = from === null ? [0, 0, 0] : [from.offset[0], from.offset[1], from.offset[2]];
	const span = age - fromAge;
	const steps = span > 0 ? Math.min(Math.ceil(span * PARTICLE_STEP_RATE), MAX_STEPS) : 0;
	const h = steps > 0 ? span / steps : 0;
	const pull = limit === null ? 0 : 1 - (1 - limit.info.dampen) ** (h * PARTICLE_STEP_RATE);
	const whole: Vec3 = [0, 0, 0];
	for (let i = 1; i <= steps; i++) {
		const t = fromAge + i * h;
		for (let axis = 0; axis < 3; axis++) {
			own[axis] += acceleration[axis] * h;
		}
		// the forces see the age and place from before this step
		push?.(t - h, offset, own, h);
		const added = extra(t, offset);
		for (let axis = 0; axis < 3; axis++) {
			whole[axis] = own[axis] + added[axis];
		}
		const speed = Math.hypot(whole[0], whole[1], whole[2]);
		const cap = limit === null ? Infinity : evaluateMinMax(limit.info.limit, livedAt(t, life), limit.r);
		if (speed > cap) {
			const scale = (speed + (cap - speed) * pull) / speed;
			for (let axis = 0; axis < 3; axis++) {
				whole[axis] *= scale;
				own[axis] = whole[axis] - added[axis];
			}
		}
		const m = modifier(t);
		for (let axis = 0; axis < 3; axis++) {
			offset[axis] += whole[axis] * m * h;
		}
	}
	const added = extra(age, offset);
	const m = modifier(age);
	return {
		offset,
		velocity: [(own[0] + added[0]) * m, (own[1] + added[1]) * m, (own[2] + added[2]) * m],
		state: { age, own, offset },
	};
};

/** sample pairs {@link integrateAge} takes */
const TRAVEL_STEPS = 8;

/**
 * @param f a rate at an age, s
 * @param age the age to integrate it up to, s
 * @returns its integral from birth to `age` (Simpson's rule)
 */
export const integrateAge = (f: (age: number) => number, age: number): number => {
	const n = TRAVEL_STEPS * 2;
	const h = age / n;
	let sum = f(0) + f(age);
	for (let i = 1; i < n; i++) {
		sum += f(i * h) * (i % 2 === 1 ? 4 : 2);
	}
	return (sum * h) / 3;
};

/**
 * @param curve a velocity, m/s, read at the particle's age over its lifetime
 * @param age the particle's age, s
 * @param life its lifetime, s
 * @param r its random value for the velocity
 * @param scale a factor on the velocity at an age, s, such as a speed modifier curve; none when omitted
 * @returns how far the velocity has carried it, m
 */
export const travelled = (
	curve: MinMaxCurveInfo,
	age: number,
	life: number,
	r: number,
	scale?: (age: number) => number,
): number => {
	if (scale === undefined && (curve.mode === CurveMode.Constant || curve.mode === CurveMode.TwoConstants)) {
		return evaluateMinMax(curve, 0, r) * age;
	}
	return integrateAge((a) => evaluateMinMax(curve, livedAt(a, life), r) * (scale?.(a) ?? 1), age);
};

/**
 * a point along a particle path, as the game finds it: the segment the distance falls in, at the Bézier
 * parameter its share of that segment's length
 *
 * @param spline the path
 * @param distance m along it
 * @returns the point and the derivative per metre of distance, or `null` past the path's end
 */
export const splinePoint = (
	spline: ParticleSplineInfo,
	distance: number,
): { position: Vec3; tangent: Vec3 } | null => {
	let start = 0;
	for (const segment of spline.segments) {
		if (distance < start + segment.length) {
			const u = Math.max(distance - start, 0) / segment.length;
			const [p0, p1, p2, p3] = segment.points;
			const v = 1 - u;
			const b = [v * v * v, 3 * u * v * v, 3 * u * u * v, u * u * u];
			const d = [-3 * v * v, 3 * v * v - 6 * u * v, 6 * u * v - 3 * u * u, 3 * u * u];
			const position: Vec3 = [0, 0, 0];
			const tangent: Vec3 = [0, 0, 0];
			for (let axis = 0; axis < 3; axis++) {
				position[axis] = b[0] * p0[axis] + b[1] * p1[axis] + b[2] * p2[axis] + b[3] * p3[axis];
				tangent[axis] =
					(d[0] * p0[axis] + d[1] * p1[axis] + d[2] * p2[axis] + d[3] * p3[axis]) / segment.length;
			}
			return { position, tangent };
		}
		start += segment.length;
	}
	return null;
};
