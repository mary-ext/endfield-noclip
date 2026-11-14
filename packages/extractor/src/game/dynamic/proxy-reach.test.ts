import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rectContains, type Rect } from '@endfield-noclip/package-format/values';

import { proxyLevelReaches } from './proxy-reach.ts';

// indie_ccdg002's green light beam (p_fxmap_map02_lv002_dragonball_lightbeam_01): an effect row of L3 cell
// (8, 7), its proxy following L2 cell (17, 15) and that L3 cell
const ROW = (3 << 16) | (7 << 8) | 8;
const CHAIN = [(2 << 16) | (15 << 8) | 17, ROW] as const;
// the battle arena, about 225 m west of the beam, and a spot beside it
const ARENA = [-20.4, -1.8] as const;
const BESIDE = [171.7, 7.1] as const;

const inside = (rects: readonly Rect[], [x, z]: readonly [number, number]): boolean =>
	rects.some((rect) => rectContains(rect, x, z));

test('the near grid sets level 0, the far grid alone level 1', () => {
	assert.equal(inside(proxyLevelReaches(ROW, CHAIN, 0b001), BESIDE), true);
	assert.equal(inside(proxyLevelReaches(ROW, CHAIN, 0b001), ARENA), false);
	assert.equal(inside(proxyLevelReaches(ROW, CHAIN, 0b010), ARENA), true);
	assert.equal(inside(proxyLevelReaches(ROW, CHAIN, 0b010), BESIDE), false);
});

test('a row whose far grid is its own never reaches level 2', () => {
	assert.deepEqual(proxyLevelReaches(ROW, CHAIN, 0b100), []);
});

test('levels that together cover the row are one rectangle', () => {
	// the L3 block around cell (8, 7): x −256..512, z −512..256
	const own = { minX: -256, minZ: -512, maxX: 512, maxZ: 256 };
	assert.deepEqual(proxyLevelReaches(ROW, CHAIN, 0b111), [own]);
	assert.deepEqual(proxyLevelReaches(ROW, CHAIN, 0b011), [own]);
});

test('the levels beyond the near grid ring it', () => {
	const ring = proxyLevelReaches(ROW, CHAIN, 0b110);
	assert.equal(ring.length, 4);
	assert.equal(inside(ring, ARENA), true);
	assert.equal(inside(ring, BESIDE), false);
});
