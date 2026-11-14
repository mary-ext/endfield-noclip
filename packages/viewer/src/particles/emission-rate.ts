/**
 * a system's steady emission: when each particle of its rate over time is emitted. the nth particle leaves
 * when the rate's integral reaches n, which is what an engine adding `rate · dt` to a running count every
 * step comes to (the game's step isn't traced). a curve is read at the system's time over its duration and
 * repeats every loop; its integral over one loop is tabulated once.
 *
 * @module
 */

import { type AnimationCurve, evaluateCurve } from '@endfield-noclip/package-format/curves';
import { CurveMode, type MinMaxCurveInfo } from '@endfield-noclip/package-format/particles';

/** a rate over time's emissions, counted from the end of the start delay */
export interface EmissionStream {
	/** particles per second, averaged over a loop */
	mean: number;
	/** the most particles per second */
	peak: number;
	/**
	 * @param elapsed seconds of emission
	 * @returns the particles emitted by then, fractions included
	 */
	emitted(elapsed: number): number;
	/**
	 * @param count a number of particles
	 * @returns the seconds of emission after which that many have been emitted
	 */
	timeOf(count: number): number;
}

/** intervals a loop's table splits it into */
const INTERVALS = 256;

/** a curve rate's particles per second at a place in the loop; a negative rate emits nothing */
const rateAt = (scalar: number, high: AnimationCurve, low: AnimationCurve | null, u: number): number => {
	const top = evaluateCurve(high, u);
	// between two curves the game draws a value the viewer can't reproduce, so take their mean
	return Math.max(scalar * (low === null ? top : (top + evaluateCurve(low, u)) / 2), 0);
};

/**
 * @param rate the system's rate over time
 * @param duration seconds per loop
 * @returns its emissions, or `null` when it emits nothing. a random rate takes its mean
 */
export const emissionStream = (rate: MinMaxCurveInfo, duration: number): EmissionStream | null => {
	if (rate.mode === CurveMode.Constant || rate.mode === CurveMode.TwoConstants) {
		const perSecond = rate.mode === CurveMode.TwoConstants ? (rate.min + rate.scalar) / 2 : rate.scalar;
		if (!(perSecond > 0)) {
			return null;
		}
		return {
			mean: perSecond,
			peak: perSecond,
			emitted: (elapsed) => elapsed * perSecond,
			timeOf: (count) => count / perSecond,
		};
	}
	const low = rate.mode === CurveMode.TwoCurves ? rate.minCurve : null;
	// the particles emitted from the loop's start to each interval's end
	const sums = new Float64Array(INTERVALS + 1);
	let peak = 0;
	{
		const h = 1 / INTERVALS;
		let from = rateAt(rate.scalar, rate.curve, low, 0);
		for (let i = 1; i <= INTERVALS; i++) {
			const middle = rateAt(rate.scalar, rate.curve, low, (i - 0.5) * h);
			const to = rateAt(rate.scalar, rate.curve, low, i * h);
			// Simpson's rule over the interval
			sums[i] = sums[i - 1] + ((from + 4 * middle + to) * h * duration) / 6;
			peak = Math.max(peak, from, middle, to);
			from = to;
		}
	}
	const perLoop = sums[INTERVALS];
	if (!(perLoop > 0)) {
		return null;
	}
	return {
		mean: perLoop / duration,
		peak,
		emitted(elapsed) {
			const loops = Math.floor(elapsed / duration);
			const x = (elapsed / duration - loops) * INTERVALS;
			const i = Math.min(Math.floor(x), INTERVALS - 1);
			return loops * perLoop + sums[i] + (sums[i + 1] - sums[i]) * (x - i);
		},
		timeOf(count) {
			if (count <= 0) {
				return 0;
			}
			// a count the loop's end reaches exactly belongs to that loop
			const loop = Math.ceil(count / perLoop) - 1;
			const within = Math.min(count - loop * perLoop, perLoop);
			// the first interval whose end reaches the count, so a stretch that emits nothing is skipped
			let end = 1;
			let last = INTERVALS;
			while (end < last) {
				const middle = (end + last) >> 1;
				if (sums[middle] >= within) {
					last = middle;
				} else {
					end = middle + 1;
				}
			}
			const span = sums[end] - sums[end - 1];
			const f = span > 0 ? (within - sums[end - 1]) / span : 1;
			return (loop + (end - 1 + f) / INTERVALS) * duration;
		},
	};
};
