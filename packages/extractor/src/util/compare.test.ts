import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compareNatural, compareNumbers, compareStrings } from './compare.ts';

describe('compareNumbers', () => {
	it('orders numbers ascending', () => {
		const values = [10, -2, 0, 2, 1];
		values.sort(compareNumbers);
		assert.deepEqual(values, [-2, 0, 1, 2, 10]);
	});
});

describe('compareStrings', () => {
	it('orders strings by UTF-16 code units', () => {
		const values = ['b', 'a', 'B', 'a10', 'a2'];
		values.sort(compareStrings);
		assert.deepEqual(values, ['B', 'a', 'a10', 'a2', 'b']);
		assert.equal(compareStrings('same', 'same'), 0);
	});
});

describe('compareNatural', () => {
	it('orders embedded digit runs numerically', () => {
		const values = ['e1m10', 'e1m2', 'e1m1', 'e1m9d10', 'e1m9d2', 'e1m9', 'c13m1'];
		values.sort(compareNatural);
		assert.deepEqual(values, ['c13m1', 'e1m1', 'e1m2', 'e1m9', 'e1m9d2', 'e1m9d10', 'e1m10']);
	});

	it('handles leading zeros and empty strings deterministically', () => {
		const values = ['map01_lv010', 'map01_lv002', 'map01_lv2', ''];
		values.sort(compareNatural);
		assert.deepEqual(values, ['', 'map01_lv002', 'map01_lv2', 'map01_lv010']);
		assert.equal(compareNatural('a01', 'a01'), 0);
		assert.notEqual(compareNatural('a01', 'a1'), 0);
		assert.equal(Math.sign(compareNatural('a01', 'a1')), -Math.sign(compareNatural('a1', 'a01')));
	});
});
