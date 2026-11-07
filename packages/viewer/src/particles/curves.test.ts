import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Gradient } from '@endfield-noclip/package-format/curves';
import {
	CurveMode,
	GradientMode,
	type MinMaxCurveInfo,
	type MinMaxGradientInfo,
} from '@endfield-noclip/package-format/particles';

import { evaluateMinMax, evaluateMinMaxGradient } from './curves.ts';
import { between, constant, line } from './test-systems.ts';

describe('min-max gradients', () => {
	const fade: Gradient = {
		colorKeys: [
			{ time: 0, color: [1, 1, 1] },
			{ time: 1, color: [0.5, 0.5, 0.5] },
		],
		alphaKeys: [
			{ time: 0, alpha: 0 },
			{ time: 0.4, alpha: 1 },
		],
		fixed: false,
	};
	it('pick between two colours or gradients by the random value', () => {
		const two: MinMaxGradientInfo = {
			mode: GradientMode.TwoColors,
			min: [1, 1, 1, 0.2],
			max: [1, 1, 1, 0.45],
		};
		assert.ok(Math.abs(evaluateMinMaxGradient(two, 0, 0.5)[3] - 0.325) < 1e-9);
		const gradients: MinMaxGradientInfo = { mode: GradientMode.TwoGradients, min: fade, max: fade };
		assert.deepEqual(evaluateMinMaxGradient(gradients, 0.2, 0.3), [0.9, 0.9, 0.9, 0.5]);
	});
});

describe('evaluateMinMax', () => {
	it('reads constants, curves and the random ends of either', () => {
		assert.equal(evaluateMinMax(constant(3), 0.5, 0.9), 3);
		assert.equal(evaluateMinMax(between(2, 4), 0.5, 0.25), 2.5);
		assert.equal(evaluateMinMax(line(1, 0), 0.25, 0), 0.75);
		const curves: MinMaxCurveInfo = {
			mode: CurveMode.TwoCurves,
			scalar: 2,
			curve: line(1, 1).curve,
			minCurve: line(0, 0).curve,
		};
		assert.equal(evaluateMinMax(curves, 0.5, 0.5), 1);
	});
});
