/**
 * Unity's `AnimationCurve` and `Gradient` as packages store them, and how a viewer reads them. particle
 * systems and lens flares share these
 *
 * @module
 */

/** {@link CurveKey.weightedMode} bits, Unity's `WeightedMode` */
export const WeightedMode = {
	/** the key's {@link CurveKey.inWeight} applies */
	In: 1 << 0,
	/** the key's {@link CurveKey.outWeight} applies */
	Out: 1 << 1,
} as const;

/** an `AnimationCurve` key */
export interface CurveKey {
	time: number;
	value: number;
	inSlope: number;
	outSlope: number;
	/** which of {@link inWeight} and {@link outWeight} apply, {@link WeightedMode} bits */
	weightedMode: number;
	inWeight: number;
	outWeight: number;
}

/**
 * {@link AnimationCurve.preWrapMode} and {@link AnimationCurve.postWrapMode} values, Unity's internal wrap
 * modes as `AnimationCurve` serializes them
 */
export const CurveWrapMode = {
	PingPong: 0,
	Repeat: 1,
	/** what a curve without a stored mode gets */
	Clamp: 2,
	Default: 3,
} as const;

export type CurveWrapMode = (typeof CurveWrapMode)[keyof typeof CurveWrapMode];

/** an `AnimationCurve` */
export interface AnimationCurve {
	keys: CurveKey[];
	/** how the curve continues before its first key and after its last; {@link evaluateCurve} clamps either way */
	preWrapMode: CurveWrapMode;
	postWrapMode: CurveWrapMode;
}

/** a Unity `Gradient`: colour and alpha keys over 0–1, in time order */
export interface Gradient {
	/** colours as authored (sRGB for particle colours) */
	colorKeys: { time: number; color: [r: number, g: number, b: number] }[];
	alphaKeys: { time: number; alpha: number }[];
	/** each key's value holds until the key's time instead of blending towards it (Unity's `Fixed` mode) */
	fixed: boolean;
}

/** the weight Unity gives a key's unweighted side, which makes the Bézier segment its Hermite one */
const DEFAULT_WEIGHT = 1 / 3;

/**
 * @param curve an `AnimationCurve`
 * @param time where to read it
 * @returns its value, clamped to the first and last keys whatever the wrap modes (curves are read within
 *   their keys' span); 0 without keys. a segment is Hermite unless a key weights it, which makes it the
 *   Bézier curve whose handles reach that far along the slopes
 */
export const evaluateCurve = (curve: AnimationCurve, time: number): number => {
	const keys = curve.keys;
	if (keys.length === 0) {
		return 0;
	}
	if (time <= keys[0].time) {
		return keys[0].value;
	}
	const last = keys.at(-1)!;
	if (time >= last.time) {
		return last.value;
	}
	let i = 0;
	while (keys[i + 1].time < time) {
		i++;
	}
	const a = keys[i];
	const b = keys[i + 1];
	if (!Number.isFinite(a.outSlope) || !Number.isFinite(b.inSlope)) {
		return a.value;
	}
	const dt = b.time - a.time;
	const outWeighted = (a.weightedMode & WeightedMode.Out) !== 0;
	const inWeighted = (b.weightedMode & WeightedMode.In) !== 0;
	if (outWeighted || inWeighted) {
		return weightedSegment(
			a.value,
			a.outSlope * dt,
			outWeighted ? a.outWeight : DEFAULT_WEIGHT,
			b.value,
			b.inSlope * dt,
			inWeighted ? b.inWeight : DEFAULT_WEIGHT,
			(time - a.time) / dt,
		);
	}
	const s = (time - a.time) / dt;
	const s2 = s * s;
	const s3 = s2 * s;
	return (
		(2 * s3 - 3 * s2 + 1) * a.value +
		(s3 - 2 * s2 + s) * a.outSlope * dt +
		(-2 * s3 + 3 * s2) * b.value +
		(s3 - s2) * b.inSlope * dt
	);
};

/** a cubic Bézier through `p0`…`p3`, at `u` */
const bezier = (p0: number, p1: number, p2: number, p3: number, u: number): number => {
	const v = 1 - u;
	return v * v * v * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u * p3;
};

/**
 * a weighted segment over 0–1: the cubic Bézier through `(0, from)`, `(outWeight, from + outRise ·
 * outWeight)`, `(1 − inWeight, to − inRise · inWeight)` and `(1, to)`, read where its x reaches `s`
 */
const weightedSegment = (
	from: number,
	outRise: number,
	outWeight: number,
	to: number,
	inRise: number,
	inWeight: number,
	s: number,
): number => {
	const x1 = outWeight;
	const x2 = 1 - inWeight;
	// x rises over u while both weights stay within 0–1, so bisection finds where it reaches s
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 32; i++) {
		const mid = (lo + hi) / 2;
		if (bezier(0, x1, x2, 1, mid) < s) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	return bezier(from, from + outRise * outWeight, to - inRise * inWeight, to, (lo + hi) / 2);
};

/**
 * @param gradient a `Gradient`
 * @param time where to read it, 0–1
 * @returns its colour and alpha there, as authored (white without keys)
 */
export const evaluateGradient = (
	gradient: Gradient,
	time: number,
): [r: number, g: number, b: number, a: number] => evaluateGradientInto([1, 1, 1, 1], gradient, time);

/**
 * @param keys keys in time order
 * @param time where to read them
 * @returns the index of the first key at or past `time` and how far `time` lies from the key before it
 *   towards it (1 at the first key, or in fixed mode, where a key's value holds until its time); the last
 *   key's index and 1 past the last. -1 without keys
 */
const keyAt = (
	keys: readonly { time: number }[],
	time: number,
	fixed: boolean,
): [index: number, t: number] => {
	keySpan[0] = keys.length - 1;
	keySpan[1] = 1;
	for (let i = 0; i < keys.length; i++) {
		if (time <= keys[i].time) {
			keySpan[0] = i;
			if (i > 0 && !fixed) {
				const before = keys[i - 1].time;
				keySpan[1] = (time - before) / Math.max(keys[i].time - before, 1e-6);
			}
			break;
		}
	}
	return keySpan;
};

/** {@link keyAt}'s result, reused */
const keySpan: [index: number, t: number] = [0, 1];

/**
 * {@link evaluateGradient} into an array of the caller's, for per-particle reads: between two keys it blends
 * them, or in fixed mode holds the later one's value
 *
 * @param out where the colour and alpha go
 * @param gradient a `Gradient`
 * @param time where to read it, 0–1
 * @returns `out`
 */
export const evaluateGradientInto = (
	out: [r: number, g: number, b: number, a: number],
	gradient: Gradient,
	time: number,
): [r: number, g: number, b: number, a: number] => {
	const { colorKeys, alphaKeys, fixed } = gradient;
	out[0] = 1;
	out[1] = 1;
	out[2] = 1;
	out[3] = 1;
	{
		const [i, t] = keyAt(colorKeys, time, fixed);
		if (i >= 0) {
			const to = colorKeys[i].color;
			const from = t < 1 ? colorKeys[i - 1].color : to;
			out[0] = from[0] + (to[0] - from[0]) * t;
			out[1] = from[1] + (to[1] - from[1]) * t;
			out[2] = from[2] + (to[2] - from[2]) * t;
		}
	}
	{
		const [i, t] = keyAt(alphaKeys, time, fixed);
		if (i >= 0) {
			const to = alphaKeys[i].alpha;
			const from = t < 1 ? alphaKeys[i - 1].alpha : to;
			out[3] = from + (to - from) * t;
		}
	}
	return out;
};
