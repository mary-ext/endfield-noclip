import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReadyMaterial } from '@endfield-noclip/package-format/materials';
import type { EffectTexture, RefractSurface } from '@endfield-noclip/package-format/surfaces';

import { materialLooks } from '../material-looks.ts';

import { EffectKind, EffectRow, SlotSource } from './effect-look.ts';
import { RefractRow } from './refract.ts';

/** a ready material drawing `surface` */
const described = (
	id: number,
	surface: ReadyMaterial['surface'],
	cull: ReadyMaterial['cull'] = 'back',
): ReadyMaterial => ({ id, status: 'ready', cull, surface });

const texture = (id: number, overrides: Partial<EffectTexture> = {}): EffectTexture => ({
	texture: id,
	scale: [1, 1],
	offset: [0, 0],
	scroll: [0, 0],
	rotation: [1, 0],
	customScroll: [0, 0],
	...overrides,
});

test('a refraction draws over the composited scene, its mask red as alpha, with its colour offsets', () => {
	const refract: RefractSurface = {
		kind: 'refract',
		refraction: { ...texture(2, { scroll: [0, 0.1] }), source: 'uv0' },
		mask: { texture: { ...texture(1, { rotation: [-1, 0] }), source: 'polar' }, redAlpha: true },
		direction: [1, 1],
		strength: 1,
		bias: 0,
		isNormal: false,
		maskUsesRefraction: 0,
		colorOffsets: {
			offset: [0, 0.01],
			secondShare: -0.89,
			intensity: 1,
			main: [1, 0, 0],
			first: [0, 1, 0],
			mainAsMask: 0,
			second: null,
		},
		dissolve: { texture: texture(3), threshold: -0.2, sharpness: 2, affectsAlpha: 0.5 },
		blend: null,
		spread: null,
		softDistance: 2.42,
		near: null,
	};
	const [look] = materialLooks({ entries: [described(0, refract, 'none')] });
	assert.equal(look.queue, 'refract');
	assert.deepEqual(look.textures, [2, 1, 3, null, null, null, null]);
	assert.equal(look.params[EffectRow.slotBits + 2], SlotSource.Uv0 * 32);
	assert.deepEqual(
		[...look.params.subarray(RefractRow.dissolve, RefractRow.dissolve + 4)].map(
			(v) => Math.round(v * 100) / 100,
		),
		[-0.2, 2, 0.5, 1],
	);
	assert.deepEqual(
		[...look.params.subarray(EffectRow.slotBits, EffectRow.slotBits + 2)],
		[SlotSource.Uv0 * 32, SlotSource.Polar * 32 + 16],
	);
	assert.deepEqual([...look.params.subarray(RefractRow.refract, RefractRow.refract + 4)], [1, 1, 1, 0]);
	assert.deepEqual([...look.params.subarray(RefractRow.refract2, RefractRow.refract2 + 4)], [0, 0, 1, 0]);
	assert.equal(look.params[EffectRow.anim + 4 + 2], -1);
	assert.deepEqual([...look.params.subarray(RefractRow.rbMain, RefractRow.rbMain + 4)], [1, 0, 0, 1]);
	assert.deepEqual([...look.params.subarray(RefractRow.rbFirst, RefractRow.rbFirst + 4)], [0, 1, 0, 0]);
	assert.equal(look.params[RefractRow.rbSecond + 3], 0);
	assert.ok(Math.abs(look.params[EffectRow.soft] - 2.42) < 1e-6);
	assert.equal(look.params[EffectRow.unfogged + 1], EffectKind.Refract);
	assert.equal(look.params[RefractRow.spread + 1], 0);
	assert.equal(look.params[RefractRow.blend], 0);
});

test('a refraction packs its blend layer in slot 3 and its spread in slot 4, off the vertex stage’s rows', () => {
	const refract: RefractSurface = {
		kind: 'refract',
		refraction: { ...texture(2), source: 'uv0' },
		mask: null,
		direction: [1, 1],
		strength: 1,
		bias: 0,
		isNormal: true,
		maskUsesRefraction: 0,
		colorOffsets: null,
		dissolve: null,
		// M_fx_common_smoke_01_02_03_1 (p_fxmap_smoke_range_f_smoke_02, Valley Pass)
		blend: {
			texture: { ...texture(5), source: 'uv0' },
			redAlpha: false,
			color: [1.5, 1.06, 1.06, 1],
			usesRefraction: 1,
		},
		spread: { texture: texture(6), schedule: 0.095, range: 0.649, flip: 1, alphaScale: 1 },
		softDistance: 4.16,
		near: [0, 1, 1e5, 2e5],
	};
	const [look] = materialLooks({ entries: [described(0, refract, 'none')] });
	assert.deepEqual(look.textures, [2, null, null, 5, 6, null, null]);
	assert.deepEqual(
		[...look.params.subarray(EffectRow.slotBits + 3, EffectRow.slotBits + 5)],
		[SlotSource.Uv0 * 32, SlotSource.Uv0 * 32],
	);
	assert.deepEqual(
		[...look.params.subarray(RefractRow.blendColor, RefractRow.blendColor + 4)].map(
			(v) => Math.round(v * 100) / 100,
		),
		[1.5, 1.06, 1.06, 1],
	);
	assert.deepEqual([...look.params.subarray(RefractRow.blend, RefractRow.blend + 2)], [1, 1]);
	assert.deepEqual(
		[...look.params.subarray(RefractRow.spread, RefractRow.spread + 4)].map(
			(v) => Math.round(v * 1000) / 1000,
		),
		[0.095, 0.649, 1, 1],
	);
	// the vertex stage moves vertices only by these rows' motion and pull
	assert.equal(look.params[EffectRow.offsetMode], 0);
	assert.equal(look.params[EffectRow.cameraPull + 1], 0);
});
