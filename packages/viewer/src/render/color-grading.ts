/**
 * the game's colour grading (`HGColorGradingConfig`) in shader units, as
 * `UberPostPassUtils.PrepareColorGradingParametersFromEnvVolume` packs it for the LUT builder. a section
 * that's off reads as its neutral default, as the config's getters return. colour curves and the external LUT
 * aren't packed, so they stay neutral.
 *
 * @module
 */

import type { ColorGradingConfig, Vec4 } from '@endfield-noclip/package-format/format';

import type { Vec3 } from '../scene/camera.ts';

import { srgbToLinear } from './colour.ts';

/** the parts of the game's colour grading the viewer reads */
export type ColorGradingInput = Omit<
	ColorGradingConfig,
	| 'tonemappingMode'
	| 'colorLookupEnabled'
	| 'colorLookupTexture'
	| 'colorLookupContribution'
	| 'colorCurvesEnabled'
>;

/** the grading as the shader takes it (`_ColorGradingCB` and the uber pass's post exposure) */
export interface Grading {
	/** multiplies the colour before grading: `2^postExposure` */
	postExposure: number;
	/** white balance, LMS coefficients */
	colourBalance: Vec3;
	/** linear */
	colourFilter: Vec3;
	/** turns, added to the hue */
	hueShift: number;
	/** 1 is neutral */
	saturation: number;
	/** 1 is neutral */
	contrast: number;
	/** output red, green and blue as weights of the input channels */
	channelMixer: [Vec3, Vec3, Vec3];
	shadows: Vec3;
	midtones: Vec3;
	highlights: Vec3;
	/** shadows start and end, highlights start and end (luminance) */
	limits: Vec4;
	lift: Vec3;
	/** reciprocal exponents */
	gamma: Vec3;
	gain: Vec3;
	splitShadows: Vec3;
	splitHighlights: Vec3;
	/** −1–1, shifts the split between the two tints */
	splitBalance: number;
}

/** every section off */
export const NEUTRAL_GRADING: ColorGradingInput = {
	whiteBalanceEnabled: false,
	whiteBalanceTemperature: 0,
	whiteBalanceTint: 0,
	colorAdjustmentsEnabled: false,
	colorAdjustmentsPostExposure: 0,
	colorAdjustmentsContrast: 0,
	colorAdjustmentsColorFilter: [1, 1, 1, 1],
	colorAdjustmentsHueShift: 0,
	colorAdjustmentsSaturation: 0,
	channelMixerEnabled: false,
	channelMixerRedOutRedIn: 100,
	channelMixerRedOutGreenIn: 0,
	channelMixerRedOutBlueIn: 0,
	channelMixerGreenOutRedIn: 0,
	channelMixerGreenOutGreenIn: 100,
	channelMixerGreenOutBlueIn: 0,
	channelMixerBlueOutRedIn: 0,
	channelMixerBlueOutGreenIn: 0,
	channelMixerBlueOutBlueIn: 100,
	shadowsMidtonesHighlightsEnabled: false,
	shadowsMidtonesHighlights: {
		shadows: [1, 1, 1, 0],
		midtones: [1, 1, 1, 0],
		highlights: [1, 1, 1, 0],
		shadowsStart: 0,
		shadowsEnd: 0.3,
		highlightsStart: 0.55,
		highlightsEnd: 1,
		shadowsOverriding: false,
		midtonesOverriding: false,
		highlightsOverriding: false,
		shadowsStartOverriding: false,
		shadowsEndOverriding: false,
		highlightsStartOverriding: false,
		highlightsEndOverriding: false,
	},
	liftGammaGainEnabled: false,
	liftGammaGain: {
		lift: [1, 1, 1, 0],
		gamma: [1, 1, 1, 0],
		gain: [1, 1, 1, 0],
		liftOverriding: false,
		gammaOverriding: false,
		gainOverriding: false,
	},
	splitToningEnabled: false,
	splitToningShadows: [0.5, 0.5, 0.5, 1],
	splitToningHighlights: [0.5, 0.5, 0.5, 1],
	splitToningBalance: 0,
};

const rec709Luminance = (c: Vec3): number => c[0] * 0.2126729 + c[1] * 0.7151522 + c[2] * 0.072175;

const linear3 = (c: Readonly<Vec4>, scale: number): Vec3 => [
	srgbToLinear(c[0]) * scale,
	srgbToLinear(c[1]) * scale,
	srgbToLinear(c[2]) * scale,
];

/** URP's `ColorUtils.ColorBalanceToLMSCoeffs`: a white point moved along the Planckian locus and tinted */
const colourBalance = (temperature: number, tint: number): Vec3 => {
	const t1 = temperature / 65;
	const t2 = tint / 65;
	const x = 0.31271 - t1 * (t1 < 0 ? 0.1 : 0.05);
	const y = 2.87 * x - 3 * x * x - 0.27509507 + t2 * 0.05;
	// CIE xy at Y = 1 to LMS (CAT02)
	const X = x / y;
	const Z = (1 - x - y) / y;
	const l = 0.7328 * X + 0.4296 - 0.1624 * Z;
	const m = -0.7036 * X + 1.6975 + 0.0061 * Z;
	const s = 0.003 * X + 0.0136 + 0.9834 * Z;
	return [0.949237 / l, 1.03542 / m, 1.08728 / s];
};

/** URP's `PrepareShadowsMidtonesHighlights` for one tint: w brightens (×4) or darkens */
const toneTint = (c: Readonly<Vec4>): Vec3 => {
	const offset = c[3] * (c[3] < 0 ? 1 : 4);
	const [r, g, b] = linear3(c, 1);
	return [Math.max(0, r + offset), Math.max(0, g + offset), Math.max(0, b + offset)];
};

/**
 * @param input the colour grading in effect
 * @returns its shader values
 */
export const gradingLook = (input: ColorGradingInput): Grading => {
	const neutral = NEUTRAL_GRADING;
	const wb = input.whiteBalanceEnabled;
	const adjust = input.colorAdjustmentsEnabled ? input : neutral;
	const mixer = input.channelMixerEnabled ? input : neutral;
	const smh = (input.shadowsMidtonesHighlightsEnabled ? input : neutral).shadowsMidtonesHighlights;
	const lgg = (input.liftGammaGainEnabled ? input : neutral).liftGammaGain;
	const split = input.splitToningEnabled ? input : neutral;

	let lift: Vec3;
	{
		const c = linear3(lgg.lift, 0.15);
		const luma = rec709Luminance(c);
		lift = [c[0] - luma + lgg.lift[3], c[1] - luma + lgg.lift[3], c[2] - luma + lgg.lift[3]];
	}
	let gamma: Vec3;
	{
		const c = linear3(lgg.gamma, 0.8);
		const luma = rec709Luminance(c);
		const w = lgg.gamma[3] + 1;
		gamma = [
			1 / Math.max(c[0] - luma + w, 1e-3),
			1 / Math.max(c[1] - luma + w, 1e-3),
			1 / Math.max(c[2] - luma + w, 1e-3),
		];
	}
	let gain: Vec3;
	{
		const c = linear3(lgg.gain, 0.8);
		const luma = rec709Luminance(c);
		const w = lgg.gain[3] + 1;
		gain = [c[0] - luma + w, c[1] - luma + w, c[2] - luma + w];
	}
	return {
		postExposure: 2 ** adjust.colorAdjustmentsPostExposure,
		colourBalance: colourBalance(wb ? input.whiteBalanceTemperature : 0, wb ? input.whiteBalanceTint : 0),
		colourFilter: linear3(adjust.colorAdjustmentsColorFilter, 1),
		hueShift: adjust.colorAdjustmentsHueShift / 360,
		saturation: adjust.colorAdjustmentsSaturation / 100 + 1,
		contrast: adjust.colorAdjustmentsContrast / 100 + 1,
		channelMixer: [
			[
				mixer.channelMixerRedOutRedIn / 100,
				mixer.channelMixerRedOutGreenIn / 100,
				mixer.channelMixerRedOutBlueIn / 100,
			],
			[
				mixer.channelMixerGreenOutRedIn / 100,
				mixer.channelMixerGreenOutGreenIn / 100,
				mixer.channelMixerGreenOutBlueIn / 100,
			],
			[
				mixer.channelMixerBlueOutRedIn / 100,
				mixer.channelMixerBlueOutGreenIn / 100,
				mixer.channelMixerBlueOutBlueIn / 100,
			],
		],
		shadows: toneTint(smh.shadows),
		midtones: toneTint(smh.midtones),
		highlights: toneTint(smh.highlights),
		limits: [smh.shadowsStart, smh.shadowsEnd, smh.highlightsStart, smh.highlightsEnd],
		lift,
		gamma,
		gain,
		// split toning tints go in raw; the shader blends them in gamma space
		splitShadows: [split.splitToningShadows[0], split.splitToningShadows[1], split.splitToningShadows[2]],
		splitHighlights: [
			split.splitToningHighlights[0],
			split.splitToningHighlights[1],
			split.splitToningHighlights[2],
		],
		splitBalance: split.splitToningBalance / 100,
	};
};
