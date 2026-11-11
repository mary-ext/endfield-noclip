import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CurveMode, type MinMaxCurveInfo } from '@endfield-noclip/package-format/particles';

import { integrateOverAge } from './curve-integrals.ts';
import { evaluateMinMax, livedAt } from './curves.ts';
import { constant, line } from './test-systems.ts';

/** the integral by many midpoint samples, as the tables stand in for */
const sampled = (rate: (age: number) => number, age: number): number => {
	const n = 20000;
	let sum = 0;
	for (let i = 0; i < n; i++) {
		sum += rate(((i + 0.5) * age) / n);
	}
	return (sum * age) / n;
};

describe('curve integrals', () => {
	const eased = line(0, 2);
	const between: MinMaxCurveInfo = {
		mode: CurveMode.TwoCurves,
		scalar: 3,
		curve: line(1, 0).curve,
		minCurve: line(0, 0.5).curve,
	};
	it('integrates a curve up to an age within the lifetime', () => {
		// 0 → 2 m/s over a 4 s life: at 1 s it has covered ¼ m
		assert.ok(Math.abs(integrateOverAge({ curve: eased, r: 0 }, null, 0, 1, 4) - 0.25) < 1e-9);
	});
	it('holds the curve at its end past the lifetime, and at its start without one', () => {
		assert.ok(Math.abs(integrateOverAge({ curve: eased, r: 0 }, null, 0, 3, 1) - (1 + 2 * 2)) < 1e-9);
		assert.equal(integrateOverAge({ curve: line(5, 2), r: 0 }, null, 0, 3, 0), 15);
	});
	it('matches sampling for a random curve times a scale, plain and weighted by the age', () => {
		const scale = { curve: line(1.8, 0.4), r: 0.3 };
		for (const [age, life] of [
			[0.7, 2],
			[2, 2],
			[2.6, 2],
		]) {
			const rate = (a: number): number =>
				evaluateMinMax(between, livedAt(a, life), 0.4) *
				evaluateMinMax(scale.curve, livedAt(a, life), scale.r);
			const plain = integrateOverAge({ curve: between, r: 0.4 }, scale, 0, age, life);
			assert.ok(Math.abs(plain - sampled(rate, age)) < 1e-5, `${plain} at ${age}`);
			const weighted = integrateOverAge({ curve: between, r: 0.4 }, scale, 1, age, life);
			assert.ok(Math.abs(weighted - sampled((a) => rate(a) * a, age)) < 1e-5, `${weighted} at ${age}`);
		}
	});
	it('integrates constants in closed form', () => {
		assert.ok(Math.abs(integrateOverAge({ curve: constant(3), r: 0 }, null, 0, 2, 10) - 6) < 1e-12);
		assert.ok(Math.abs(integrateOverAge({ curve: constant(3), r: 0 }, null, 1, 2, 10) - 6) < 1e-12);
	});
});
