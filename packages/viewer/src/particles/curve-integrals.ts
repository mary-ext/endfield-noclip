/**
 * integrals of over-lifetime curves up to a particle's age, read from tables built once per curve. a particle
 * is placed from its age alone every frame, and how far a velocity curve has carried it is that curve's
 * integral; summing samples per particle and frame took most of the time particles are placed in.
 *
 * a `MinMaxCurve` is a sum of at most two terms, a factor (which holds the particle's random value) times a
 * curve of its age over its lifetime, so the integral of one, or of two multiplied, is a sum of factors times
 * integrals that depend on the curves alone.
 *
 * @module
 */

import { type AnimationCurve, CurveWrapMode, evaluateCurve } from '@endfield-noclip/package-format/curves';
import { CurveMode, type MinMaxCurveInfo } from '@endfield-noclip/package-format/particles';

/** a `MinMaxCurve` with the random value that picks between its two ends */
export interface DrawnCurve {
	curve: MinMaxCurveInfo;
	/** 0–1 */
	r: number;
}

/** intervals a table splits 0–1 into */
const INTERVALS = 128;

/** an integrand over 0–1 and its running integral, at {@link INTERVALS} + 1 even samples */
interface IntegralTable {
	values: Float64Array;
	sums: Float64Array;
}

/** stands for no second curve in {@link tables} */
const ALONE: AnimationCurve = {
	keys: [],
	preWrapMode: CurveWrapMode.Clamp,
	postWrapMode: CurveWrapMode.Clamp,
};

/** a curve's tables by the curve it's multiplied with ({@link ALONE} for none), then by the power of the age */
const tables = new WeakMap<AnimationCurve, WeakMap<AnimationCurve, (IntegralTable | undefined)[]>>();

/** @returns the table of `a(u) · b(u) · u^power`, `b` being {@link ALONE} for `a(u) · u^power` */
const tableOf = (a: AnimationCurve, b: AnimationCurve, power: 0 | 1): IntegralTable => {
	const byPower = tables.getOrInsertComputed(a, () => new WeakMap()).getOrInsertComputed(b, () => []);
	let table = byPower[power];
	if (table === undefined) {
		const at = (u: number): number =>
			evaluateCurve(a, u) * (b === ALONE ? 1 : evaluateCurve(b, u)) * (power === 1 ? u : 1);
		const values = new Float64Array(INTERVALS + 1);
		const sums = new Float64Array(INTERVALS + 1);
		const h = 1 / INTERVALS;
		values[0] = at(0);
		for (let i = 1; i <= INTERVALS; i++) {
			values[i] = at(i * h);
			// Simpson's rule over the interval
			sums[i] = sums[i - 1] + ((values[i - 1] + 4 * at((i - 0.5) * h) + values[i]) * h) / 6;
		}
		table = { values, sums };
		byPower[power] = table;
	}
	return table;
};

/**
 * @param a a curve, or `null` for 1
 * @param b the curve it's multiplied with, or `null` for 1
 * @param power the power of `u` the product is multiplied with
 * @param u where the integral ends, 0–1
 * @returns the integral of `a · b · u^power` from 0 to `u`
 */
const integralTo = (a: AnimationCurve | null, b: AnimationCurve | null, power: 0 | 1, u: number): number => {
	const first = a ?? b;
	if (first === null) {
		return power === 1 ? 0.5 * u * u : u;
	}
	const second = a === null || b === null ? ALONE : b;
	const { values, sums } = tableOf(first, second, power);
	const x = Math.min(Math.max(u, 0), 1) * INTERVALS;
	const i = Math.min(Math.floor(x), INTERVALS - 1);
	const f = x - i;
	// the integrand taken as linear within the interval
	const from = values[i];
	return sums[i] + ((from + from + (values[i + 1] - from) * f) * f) / (2 * INTERVALS);
};

/** a `MinMaxCurve`'s terms for a random value: each a factor times a curve (`null` for 1) */
interface Terms {
	count: number;
	factors: [number, number];
	curves: [AnimationCurve | null, AnimationCurve | null];
}

const terms = (): Terms => ({ count: 0, factors: [0, 0], curves: [null, null] });

/** the integrated curve's terms and its scale's; integrals don't nest */
const ofCurve = terms();
const ofScale = terms();
const UNSCALED: Terms = { count: 1, factors: [1, 0], curves: [null, null] };

/** writes `drawn`'s terms into `out` @returns `out` */
const termsInto = (out: Terms, { curve, r }: DrawnCurve): Terms => {
	out.count = 1;
	out.curves[0] = null;
	switch (curve.mode) {
		case CurveMode.Constant: {
			out.factors[0] = curve.scalar;
			break;
		}
		case CurveMode.Curve: {
			out.factors[0] = curve.scalar;
			out.curves[0] = curve.curve;
			break;
		}
		case CurveMode.TwoCurves: {
			out.count = 2;
			out.factors[0] = curve.scalar * (1 - r);
			out.curves[0] = curve.minCurve;
			out.factors[1] = curve.scalar * r;
			out.curves[1] = curve.curve;
			break;
		}
		case CurveMode.TwoConstants: {
			out.factors[0] = curve.min + (curve.scalar - curve.min) * r;
			break;
		}
	}
	return out;
};

/** @returns a term's curve at `u` */
const valueAt = (curve: AnimationCurve | null, u: number): number =>
	curve === null ? 1 : evaluateCurve(curve, u);

/**
 * @param drawn a rate read at a particle's age over its lifetime (held at its end past the lifetime, and at
 *   its start for a particle without a lifetime)
 * @param scale a factor on the rate read the same way, such as a speed modifier curve, or `null` for none
 * @param power 1 to weight the rate by the age in seconds, as a fall's speed grows with it; 0 for the rate
 *   alone
 * @param age the particle's age, s
 * @param life its lifetime, s
 * @returns the integral of `rate · scale · age^power` from birth to `age`
 */
export const integrateOverAge = (
	drawn: DrawnCurve,
	scale: DrawnCurve | null,
	power: 0 | 1,
	age: number,
	life: number,
): number => {
	const a = termsInto(ofCurve, drawn);
	const b = scale === null ? UNSCALED : termsInto(ofScale, scale);
	// within the lifetime the age runs 0–1 of it; past it, or without one, the curves hold one value
	const within = life > 0 ? Math.min(age, life) : 0;
	const u = life > 0 ? within / life : 0;
	const held = life > 0 ? 1 : 0;
	const lifeScale = power === 1 ? life * life : life;
	const beyond = power === 1 ? 0.5 * (age * age - within * within) : age - within;
	let sum = 0;
	for (let i = 0; i < a.count; i++) {
		for (let j = 0; j < b.count; j++) {
			const factor = a.factors[i] * b.factors[j];
			if (factor === 0) {
				continue;
			}
			let integral = 0;
			if (within > 0) {
				integral += lifeScale * integralTo(a.curves[i], b.curves[j], power, u);
			}
			if (beyond > 0) {
				integral += valueAt(a.curves[i], held) * valueAt(b.curves[j], held) * beyond;
			}
			sum += factor * integral;
		}
	}
	return sum;
};
