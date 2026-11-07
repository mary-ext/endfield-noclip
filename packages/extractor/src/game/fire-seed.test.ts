import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ControlDriver } from '@endfield-noclip/package-format/states';

import { FIRE_SEED_CONTROL, fireSeedActionTarget, fireSeedControl } from './fire-seed.ts';

describe('fireSeedControl', () => {
	const radii: [number, number][] = [
		[9999, 50000],
		[4, 4.5],
		[7, 7.5],
	];
	const actions = [
		{ script: '10200030004', node: 66, level: 1 },
		{ script: '10200030004', node: 82, level: 0 },
		{ script: '10200260001', node: 200, level: null },
	];
	const script: ControlDriver = { kind: 'script', position: [1, 2, 3], radius: 50, value: null };

	it('offers a level per radius, not carried by default, with the value each script sets', () => {
		const drivers = new Map(actions.map((action) => [fireSeedActionTarget(action), [script]]));
		const control = fireSeedControl(radii, actions, drivers);
		assert.equal(control.id, FIRE_SEED_CONTROL);
		assert.equal(control.default, 0);
		assert.deepEqual(
			control.values.map(({ label }) => label),
			['not carried, invisible bridges hidden', 'level 1, reveals within 4 m', 'level 2, reveals within 7 m'],
		);
		assert.deepEqual(
			control.drivers.map(({ value }) => value),
			[1, 0, null],
		);
	});
});
