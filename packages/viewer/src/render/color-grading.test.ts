import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NEUTRAL_GRADING, gradingLook } from './color-grading.ts';

const near = (actual: readonly number[], expected: readonly number[], epsilon = 1e-3): void => {
	assert.equal(actual.length, expected.length);
	actual.forEach((value, i) => {
		assert.ok(Math.abs(value - expected[i]) < epsilon, `[${i}] ${value} ≉ ${expected[i]}`);
	});
};

describe('gradingLook', () => {
	it('packs every neutral section as an identity', () => {
		const g = gradingLook(NEUTRAL_GRADING);
		near([g.postExposure, g.hueShift, g.saturation, g.contrast], [1, 0, 1, 1]);
		near(g.colorBalance, [1, 1, 1]);
		near(g.colorFilter, [1, 1, 1]);
		near(g.channelMixer.flat(), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
		near([...g.shadows, ...g.midtones, ...g.highlights], [1, 1, 1, 1, 1, 1, 1, 1, 1]);
		near([...g.lift, ...g.gamma, ...g.gain], [0, 0, 0, 1, 1, 1, 1, 1, 1]);
		near([...g.splitShadows, ...g.splitHighlights, g.splitBalance], [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0]);
	});

	it('reads a section that is off as neutral', () => {
		const g = gradingLook({
			...NEUTRAL_GRADING,
			colorAdjustmentsContrast: 50,
			colorAdjustmentsSaturation: -20,
		});
		near([g.saturation, g.contrast], [1, 1]);
	});

	it('scales colour adjustments as the game does', () => {
		const g = gradingLook({
			...NEUTRAL_GRADING,
			colorAdjustmentsEnabled: true,
			colorAdjustmentsContrast: 9,
			colorAdjustmentsSaturation: -5,
			colorAdjustmentsHueShift: 90,
			colorAdjustmentsColorFilter: [1, 0.5, 1, 1],
		});
		near([g.hueShift, g.saturation, g.contrast], [0.25, 0.95, 1.09]);
		near(g.colorFilter, [1, 0.214, 1]);
	});
});
