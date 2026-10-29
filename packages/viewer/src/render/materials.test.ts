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
