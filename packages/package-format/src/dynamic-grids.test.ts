import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeDynamicGrid, dynamicGridLoaded } from './dynamic-grids.ts';

// base01_lv001 (Dijiang) rows, seen from its exterior deck at unity (0.9, 10, −110.5)
const DECK = [0.9, -110.5] as const;

test('decodes level and cell from a grid id', () => {
	assert.deepEqual(decodeDynamicGrid(262915), { level: 4, x: 3, z: 3 });
	assert.deepEqual(decodeDynamicGrid(458752), { level: 7, x: 0, z: 0 });
	assert.deepEqual(decodeDynamicGrid(15679), { level: 0, x: 63, z: 61 });
});

test('a grid loads within one cell of the centre at its level', () => {
	// the planet blight's effect row: L4 cell (3, 3), the deck in L4 cell (4, 3)
	assert.equal(dynamicGridLoaded(decodeDynamicGrid(262915), ...DECK), true);
	// one more 512 m cell east of the block
	assert.equal(dynamicGridLoaded(decodeDynamicGrid(262915), 0.9 + 1024, -110.5), false);
	// a prop's L0 cell (63, 61) spans x −32..0, z −96..−64: in reach from (10, −110), not from (40, −110)
	assert.equal(dynamicGridLoaded(decodeDynamicGrid(15679), 10, -110), true);
	assert.equal(dynamicGridLoaded(decodeDynamicGrid(15679), 40, -110), false);
});

test('level 7 covers the whole frame and centres past it are clamped in', () => {
	assert.equal(dynamicGridLoaded(decodeDynamicGrid(458752), ...DECK), true);
	assert.equal(dynamicGridLoaded(decodeDynamicGrid(458752), 9000, -9000), true);
	// L0 cell (0, 0) is the frame's corner; a centre beyond it clamps to that corner
	assert.equal(dynamicGridLoaded({ level: 0, x: 0, z: 0 }, -5000, -5000), true);
});
