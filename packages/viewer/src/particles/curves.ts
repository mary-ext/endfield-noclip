import { evaluateCurve, evaluateGradient } from '@endfield-noclip/package-format/curves';
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
): [number, number, number, number] => {
	const between = (a: readonly number[], b: readonly number[]): [number, number, number, number] => [
		a[0] + (b[0] - a[0]) * r,
		a[1] + (b[1] - a[1]) * r,
		a[2] + (b[2] - a[2]) * r,
		a[3] + (b[3] - a[3]) * r,
	];
	switch (gradient.mode) {
		case GradientMode.Color: {
			return [...gradient.color];
		}
		case GradientMode.Gradient: {
			return evaluateGradient(gradient.gradient, time);
		}
		case GradientMode.TwoColors: {
			return between(gradient.min, gradient.max);
		}
		case GradientMode.TwoGradients: {
			return between(evaluateGradient(gradient.min, time), evaluateGradient(gradient.max, time));
		}
		case GradientMode.RandomColor: {
			return evaluateGradient(gradient.gradient, r);
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

/** @returns a constant or random-between-two-constants rate's mean */
export const meanOf = (curve: MinMaxCurveInfo): number =>
	curve.mode === CurveMode.TwoConstants ? (curve.min + curve.scalar) / 2 : curve.scalar;

/**
 * @param age a particle's age, s
 * @param life its lifetime, s
 * @returns its age over its lifetime, where over-lifetime curves are read: held at 1 past its end, and 0 for
 *   a particle without a lifetime
 */
export const livedAt = (age: number, life: number): number => (life > 0 ? Math.min(age / life, 1) : 0);
