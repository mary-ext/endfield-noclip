import { evaluateCurve, evaluateGradientInto } from '@endfield-noclip/package-format/curves';
import {
	CurveMode,
	GradientMode,
	type MinMaxCurveInfo,
	type MinMaxGradientInfo,
} from '@endfield-noclip/package-format/particles';

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
			return curve.scalar * evaluateCurve(curve.curve, time);
		}
		case CurveMode.TwoCurves: {
			const high = evaluateCurve(curve.curve, time);
			const low = evaluateCurve(curve.minCurve, time);
			return curve.scalar * (low + (high - low) * r);
		}
		case CurveMode.TwoConstants: {
			return curve.min + (curve.scalar - curve.min) * r;
		}
	}
};

/**
 * @param gradient a MinMaxGradient
 * @param time where gradients are read, 0–1
 * @param r the random value choosing between the two ends, or along a random colour's gradient, 0–1
 * @returns its colour and alpha, as authored
 */
export const evaluateMinMaxGradient = (
	gradient: MinMaxGradientInfo,
	time: number,
	r: number,
): [number, number, number, number] => evaluateMinMaxGradientInto([0, 0, 0, 0], gradient, time, r);

type Rgba = [number, number, number, number];

/** the upper gradient of two, read before blending ({@link evaluateMinMaxGradientInto}) */
const upper: Rgba = [0, 0, 0, 0];

/** sets `out` to the colour `r` of the way from `a` to `b` @returns `out` */
const between = (out: Rgba, a: readonly number[], b: readonly number[], r: number): Rgba => {
	for (let c = 0; c < 4; c++) {
		out[c] = a[c] + (b[c] - a[c]) * r;
	}
	return out;
};

/**
 * {@link evaluateMinMaxGradient} into an array of the caller's, for per-particle reads
 *
 * @param out where the colour and alpha go
 * @param gradient a MinMaxGradient
 * @param time where gradients are read, 0–1
 * @param r the random value choosing between the two ends, or along a random colour's gradient, 0–1
 * @returns `out`
 */
export const evaluateMinMaxGradientInto = (
	out: Rgba,
	gradient: MinMaxGradientInfo,
	time: number,
	r: number,
): Rgba => {
	switch (gradient.mode) {
		case GradientMode.Color: {
			return between(out, gradient.color, gradient.color, 0);
		}
		case GradientMode.Gradient: {
			return evaluateGradientInto(out, gradient.gradient, time);
		}
		case GradientMode.TwoColors: {
			return between(out, gradient.min, gradient.max, r);
		}
		case GradientMode.TwoGradients: {
			evaluateGradientInto(upper, gradient.max, time);
			return between(out, evaluateGradientInto(out, gradient.min, time), upper, r);
		}
		case GradientMode.RandomColor: {
			return evaluateGradientInto(out, gradient.gradient, r);
		}
	}
};

/** @returns the largest value a MinMaxCurve can take, keys bounding its curves */
export const upperBound = (curve: MinMaxCurveInfo): number => {
	switch (curve.mode) {
		case CurveMode.Constant: {
			return curve.scalar;
		}
		case CurveMode.TwoConstants: {
			return Math.max(curve.scalar, curve.min);
		}
		case CurveMode.Curve:
		case CurveMode.TwoCurves: {
			const keys =
				curve.mode === CurveMode.TwoCurves ? [...curve.curve.keys, ...curve.minCurve.keys] : curve.curve.keys;
			let most = -Infinity;
			for (const key of keys) {
				most = Math.max(most, key.value * curve.scalar);
			}
			return Number.isFinite(most) ? most : 0;
		}
	}
};

/**
 * @param age a particle's age, s
 * @param life its lifetime, s
 * @returns its age over its lifetime, where over-lifetime curves are read: held at 1 past its end, and 0 for
 *   a particle without a lifetime
 */
export const livedAt = (age: number, life: number): number => (life > 0 ? Math.min(age / life, 1) : 0);
