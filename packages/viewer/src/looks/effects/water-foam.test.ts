import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReadyMaterial } from '@endfield-noclip/package-format/materials';
import type { EffectTexture, WaterFoamSurface } from '@endfield-noclip/package-format/surfaces';

import { materialLooks } from '../material-looks.ts';

import { EffectKind, EffectRow } from './effect-look.ts';
import { EROSION_SLOTS, WaterFoamFlags, WaterFoamRow } from './water-foam.ts';

/** a ready material drawing `surface` */
const described = (
	surface: ReadyMaterial['surface'],
	cull: ReadyMaterial['cull'] = 'back',
): ReadyMaterial => ({ status: 'ready', cull, surface });

const texture = (id: number, overrides: Partial<EffectTexture> = {}): EffectTexture => ({
	texture: id,
	scale: [1, 1],
	offset: [0, 0],
	scroll: [0, 0],
	rotation: [1, 0],
	customScroll: [0, 0],
	...overrides,
});

test('a water foam box draws into the water’s foam, by the depth test its material names', () => {
	const foam: WaterFoamSurface = {
		kind: 'waterFoam',
		textures: {
			base: texture(1, { scroll: [0, -1.3] }),
			disturb: texture(2),
			mask: texture(3),
		},
		sources: { base: 1, disturb: 0, mask: 0, dissolve: 0 },
		maskMatrix: [1, 0, 0, 1],
		boxUv: [1, 1, 0, 0],
		baseColor: [0, 0, 0],
		tint: [3.4, 4.2, 4.2],
		baseAlpha: 1,
		maskAsAlpha: 1,
		disturbBias: 0,
		disturb: [0.1, 0.1],
		disturbUse: [1, 1, 0],
		edgeFade: [0, 0],
		clipToBox: false,
		depthTest: 'less-equal',
		mipBias: { base: 0, mask: 0, dissolve: 0 },
		blendMode: 1,
		opacity: 0.5,
		soft: { distance: 0.001, bias: 0.6 },
		dissolve: null,
		erosion: null,
	};
	const [front, behind, through] = materialLooks({
		entries: [
			described(foam),
			described({ ...foam, depthTest: 'greater', clipToBox: true }, 'front'),
			described({ ...foam, depthTest: 'always', mipBias: { base: 3, mask: 2, dissolve: 2 } }),
		],
	});
	assert.deepEqual(
		[front.queue, behind.queue, through.queue],
		['waterFoam', 'waterFoamBehind', 'waterFoamThrough'],
	);
	assert.deepEqual([...through.params.subarray(WaterFoamRow.mip, WaterFoamRow.mip + 3)], [3, 2, 2]);
	assert.deepEqual([front.cull, behind.cull], ['back', 'front']);
	assert.deepEqual(front.textures, [1, 2, 3, null, null, null, null]);
	assert.equal(front.params[EffectRow.unfogged + 1], EffectKind.WaterFoam);
	assert.equal(front.params[WaterFoamRow.base + 3], 0.5);
	assert.equal(
		front.params[WaterFoamRow.tint + 3],
		WaterFoamFlags.Disturb | WaterFoamFlags.Mask | WaterFoamFlags.EdgeFade | WaterFoamFlags.Soft,
	);
	assert.equal(behind.params[WaterFoamRow.tint + 3] & WaterFoamFlags.ClipToBox, WaterFoamFlags.ClipToBox);
	assert.deepEqual([...front.params.subarray(WaterFoamRow.sources, WaterFoamRow.sources + 4)], [1, 0, 0, 0]);
	assert.equal(front.params[WaterFoamRow.disturb + 3], 1);
	assert.ok(Math.abs(front.params[WaterFoamRow.fade + 2] - 0.6) < 1e-6);
	assert.equal(front.params[EffectRow.anim + 1], Math.fround(-1.3));
});

test('a red tide’s erosion takes the slots after the base colour map, with its layers’ colours', () => {
	const layer = (id: number, threshold: number) => ({
		noise: texture(id, { scale: [20, 20], scroll: [-0.1, 0] }),
		color: [36, 2, 0] as [number, number, number],
		threshold,
	});
	const tide: WaterFoamSurface = {
		kind: 'waterFoam',
		textures: { base: texture(1), disturb: null, mask: null },
		sources: { base: 3, disturb: 2, mask: 3, dissolve: 0 },
		maskMatrix: [0, 1, -1, 0],
		boxUv: [1, 1, 0, 0],
		baseColor: [0, 0, 0],
		tint: [1, 0.06, 0.94],
		baseAlpha: 0,
		maskAsAlpha: 1,
		disturbBias: 1,
		disturb: [0, 0],
		disturbUse: [1, 1, 0],
		edgeFade: null,
		clipToBox: false,
		depthTest: 'less-equal',
		mipBias: { base: -16, mask: -16, dissolve: -16 },
		blendMode: 1,
		opacity: 1,
		soft: null,
		dissolve: null,
		erosion: {
			flow: texture(3, { scale: [15, 1.29], offset: [-11.75, 0] }),
			flowNoise: texture(4),
			gradient: texture(5),
			layers: [layer(2, 0.15), layer(6, 0.14), layer(7, 0.34)],
			noiseStrength: 0.02,
			flowShift: 7,
			distance: 1.01,
			offset: 0.14,
			edgeColor: [0.4, 0.4, 0.4],
		},
	};
	const [look] = materialLooks({ entries: [described(tide)] });
	assert.deepEqual(look.textures, [1, 3, 4, 5, 2, 6, 7]);
	assert.equal(look.params[WaterFoamRow.tint + 3], WaterFoamFlags.Erosion);
	assert.deepEqual(
		[...look.params.subarray(WaterFoamRow.erosion, WaterFoamRow.erosion + 4)],
		[0.02, 7, 1.01, 0.14].map(Math.fround),
	);
	assert.deepEqual(
		[...look.params.subarray(WaterFoamRow.erosionLayers + 8, WaterFoamRow.erosionLayers + 12)],
		[36, 2, 0, 0.34].map(Math.fround),
	);
	// the layers' noises scroll as their slots do
	assert.equal(look.params[EffectRow.anim + (EROSION_SLOTS.layers + 1) * 4], Math.fround(-0.1));
});
