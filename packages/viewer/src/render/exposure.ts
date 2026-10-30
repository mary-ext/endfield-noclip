/**
 * the game's auto exposure as arithmetic: a luminance histogram of the lit scene picks a post exposure that
 * brings the scene's average towards middle grey, within the profile's EV limits, and the exposure eases
 * towards it. the profiles mostly allow brightening only, so it lifts dark interiors and leaves daylight
 * alone. the histogram itself is taken on the GPU (`auto-exposure.ts`).
 *
 * the average ignores the darkest and brightest samples (`autoExposurePixelLuminanceRange`) and clamps each
 * bin's EV to `autoExposureEv100HistogramRange`; the exposure is `2^compensation · 0.18 / 2^average`.
 *
 * @module
 */

import type { AutoExposureConfig, Vec2 } from '@endfield-noclip/package-format/format';

/** histogram bins, as the game's */
export const BINS = 16;

/** the parts of the game's auto-exposure config the viewer reads */
export type AutoExposureInput = AutoExposureConfig;

/** how the exposure follows the scene, from a profile's {@link AutoExposureInput} */
export interface AutoExposureSettings {
	/** `auto` meters the scene; `manual` holds `2^manualEv` */
	mode: 'auto' | 'manual';
	/** EV added to the metered exposure */
	compensation: number;
	manualEv: number;
	/** per second, towards a brighter and a darker exposure */
	upSpeed: number;
	downSpeed: number;
	/** the log2 luminance the histogram's {@link BINS} bins span */
	meteringRange: Vec2;
	/** the log2 luminance each bin counts as at most and at least, when averaging */
	binRange: Vec2;
	centreWeighted: boolean;
	/** the fractions of the weighted samples below which and above which samples are ignored */
	percentiles: Vec2;
	/** the exposure's limits, EV */
	evLimits: Vec2;
}

/**
 * @param config a profile's auto-exposure config
 * @returns the settings the viewer follows
 */
export const autoExposureLook = (config: AutoExposureInput): AutoExposureSettings => ({
	mode: config.autoExposureMode === 0 ? 'auto' : 'manual',
	compensation: config.autoExposureManualEvCompensationAuto,
	manualEv: config.autoExposureManualEvCompensationManual,
	upSpeed: config.autoExposureLerpUpSpeed,
	downSpeed: config.autoExposureLerpDownSpeed,
	meteringRange: config.autoExposureEv100Range,
	binRange: config.autoExposureEv100HistogramRange,
	centreWeighted: config.autoExposureMeteringMode === 1,
	percentiles: config.autoExposurePixelLuminanceRange,
	evLimits: config.autoExposureEvClampRange,
});

const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

/**
 * @param bins {@link BINS} weighted sample counts, darkest first
 * @param settings the exposure settings
 * @returns the exposure the histogram asks for, before the EV limits
 */
export const meteredExposure = (bins: ArrayLike<number>, settings: AutoExposureSettings): number => {
	let total = 0;
	for (let i = 0; i < BINS; i++) {
		total += bins[i];
	}
	const lo = settings.percentiles[0] * total;
	const hi = settings.percentiles[1] * total;
	const [first, last] = settings.meteringRange;
	let below = 0;
	let sum = 0;
	for (let i = 0; i < BINS; i++) {
		const count = bins[i];
		if (count === 0) {
			continue;
		}
		// a bin counts as its lower edge
		const ev = clamp(first + ((last - first) * i) / BINS, settings.binRange[0], settings.binRange[1]);
		const kept = Math.max(0, Math.min(below + count, hi) - Math.max(below, lo));
		sum += kept * ev;
		below += count;
	}
	// over all samples, not only the kept ones, as the game divides
	const average = sum / Math.max(1, total);
	return (2 ** settings.compensation * 0.18) / clamp(2 ** average, 0.01, 8);
};

/**
 * @param metered the metered exposure, or `null` before the first histogram
 * @param settings the exposure settings
 * @returns the exposure to ease towards: the metered or manual one within the EV limits
 */
export const targetExposure = (metered: number | null, settings: AutoExposureSettings): number => {
	const wanted = settings.mode === 'manual' ? 2 ** settings.manualEv : (metered ?? 1);
	return clamp(wanted, 2 ** settings.evLimits[0], 2 ** settings.evLimits[1]);
};

/**
 * @param current the exposure now
 * @param target the exposure to reach
 * @param settings the exposure settings
 * @param dt seconds since the last step
 * @returns the next exposure, moving `clamp(speed · dt)` of the way
 */
export const easeExposure = (
	current: number,
	target: number,
	settings: AutoExposureSettings,
	dt: number,
): number => {
	const speed = current < target ? settings.upSpeed : settings.downSpeed;
	return current + (target - current) * clamp(speed * dt, 0, 1);
};
