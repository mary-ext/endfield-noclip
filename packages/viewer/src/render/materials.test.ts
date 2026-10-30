import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReadyMaterial, ShaderEntry } from '@endfield-noclip/package-format/format';

import { materialLooks } from './materials.ts';

test('effect geometry cannot become opaque walls through the fallback, while ordinary unknown shaders remain visible', () => {
	const shaders: ShaderEntry[] = [
		{
			name: 'HGRP/Effect/VFXBaseV2',
			family: 'vfxBase',
			floats: {},
			colors: {},
			vectors: {},
			textures: {},
			normalMaps: [],
		},
		{
			name: 'HGRP/Effect/VFXDecal',
			family: 'unknown',
			floats: {},
			colors: {},
			vectors: {},
			textures: {},
			normalMaps: [],
		},
		{
			name: 'Other/Surface',
			family: 'unknown',
			floats: {},
			colors: {},
			vectors: {},
			textures: {},
			normalMaps: [],
		},
	];
	const entries: ReadyMaterial[] = shaders.map((_, id) => ({
		id,
		status: 'ready',
		shader: id,
		keywords: [],
		renderQueue: 2000,
		blend: 'opaque',
		blendFactors: null,
		alphaClip: null,
		cull: 'back',
		zWrite: true,
		normalLayout: null,
		usesMro: false,
		slots: {},
		floats: {},
		colors: {},
		vectors: {},
	}));
	assert.deepEqual(
		materialLooks({ shaders, entries }).map((look) => look.drawn),
		[false, false, true],
	);
});

test('matte paintings are unlit, cast no shadows and test the texture alpha against the scaled threshold', () => {
	const shaders: ShaderEntry[] = [
		{
			name: 'HGRP/MattePainting',
			family: 'mattePainting',
			floats: { _TintColorIntensity: 1, _TintColorAlpha: 1, _ExpThreshold: 1, _ExpIntensity: 0 },
			colors: { _TintColor: [1, 1, 1, 1] },
			vectors: {},
			textures: { _MainTex: 'white' },
			normalMaps: [],
		},
	];
	const entry: ReadyMaterial = {
		id: 0,
		status: 'ready',
		shader: 0,
		keywords: ['_ALPHATEST_ON'],
		renderQueue: 2000,
		blend: 'alphaTest',
		blendFactors: null,
		alphaClip: 1,
		cull: 'back',
		zWrite: true,
		normalLayout: null,
		usesMro: false,
		slots: { _MainTex: { texture: 7, uv: 0, scale: [1, 1], offset: [0, 0] } },
		floats: { _TintColorAlpha: 10, _TintColorIntensity: 2, _ExpIntensity: 4 },
		colors: { _TintColor: [1, 1, 1, 0.5] },
		vectors: {},
	};
	const [look] = materialLooks({ shaders, entries: [entry] });
	assert.equal(look.castsShadows, false);
	assert.equal(look.cutout, true);
	assert.equal(look.textures[0], 7);
	assert.deepEqual(Array.from(look.params.subarray(0, 4)), [2, 2, 2, Math.fround(0.2)]);
	assert.deepEqual(Array.from(look.params.subarray(20, 22)), [1, 4]);
});
