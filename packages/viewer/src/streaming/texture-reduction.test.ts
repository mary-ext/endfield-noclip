import assert from 'node:assert/strict';
import { it } from 'node:test';

import { MAX_REDUCTION, type ReductionStream, TextureReduction } from './texture-reduction.ts';

const MIB = 2 ** 20;
const BUDGET = 768 * MIB;

/** a stream whose saturation and bytes in use the test sets */
const fakeStream = (state: { saturated: boolean; all: number; texture: number }): ReductionStream => ({
	get saturated() {
		return state.saturated;
	},
	usedBytes: () => ({ all: state.all, kind: state.texture }),
});

/** runs frames `[from, to)` */
const run = (reduction: TextureReduction, stream: ReductionStream, from: number, to: number): void => {
	for (let frame = from; frame < to; frame++) {
		reduction.update(stream, frame, BUDGET);
	}
};

it('raises the reduction while textures fill a saturated budget, up to its limit', () => {
	const state = { saturated: true, all: 770 * MIB, texture: 610 * MIB };
	const stream = fakeStream(state);
	const reduction = new TextureReduction();
	run(reduction, stream, 0, 5);
	assert.equal(reduction.levels, 0.5);
	assert.equal(reduction.raising, true);
	run(reduction, stream, 5, 200);
	assert.equal(reduction.levels, MAX_REDUCTION);
	assert.equal(reduction.raising, false);
});

it("doesn't reduce textures when other content fills the budget", () => {
	const stream = fakeStream({ saturated: true, all: 770 * MIB, texture: 100 * MIB });
	const reduction = new TextureReduction();
	run(reduction, stream, 0, 100);
	assert.equal(reduction.levels, 0);
	assert.equal(reduction.raising, false);
});

it('lowers the reduction only when the grown textures would leave headroom', () => {
	const state = { saturated: true, all: 770 * MIB, texture: 610 * MIB };
	const stream = fakeStream(state);
	const reduction = new TextureReduction();
	run(reduction, stream, 0, 10);
	assert.equal(reduction.levels, 1);
	// 400 + 260 doubled to 660 MiB is past 85% of the budget
	Object.assign(state, { saturated: false, all: 400 * MIB, texture: 260 * MIB });
	run(reduction, stream, 10, 100);
	assert.equal(reduction.levels, 1);
	// 300 + 150 more fits
	Object.assign(state, { all: 300 * MIB, texture: 150 * MIB });
	run(reduction, stream, 100, 200);
	assert.equal(reduction.levels, 0);
});

it('starts over for a new stream', () => {
	const reduction = new TextureReduction();
	run(reduction, fakeStream({ saturated: true, all: 770 * MIB, texture: 610 * MIB }), 0, 10);
	assert.notEqual(reduction.levels, 0);
	reduction.update(fakeStream({ saturated: false, all: 0, texture: 0 }), 10, BUDGET);
	assert.equal(reduction.levels, 0);
});
