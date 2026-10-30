import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReadyMaterial, ShaderEntry } from '@endfield-noclip/package-format/format';

import { LookFlags, LookRow, materialLooks, UV1_SHIFT } from './materials.ts';

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
		alphaClipThreshold: null,
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
		alphaClipThreshold: 1,
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
	assert.deepEqual(Array.from(look.params.subarray(LookRow.surface, LookRow.surface + 2)), [1, 4]);
});

test('originium crystals: UV set 1 base colour, tri-channel tint, detail and parallax glow', () => {
	const shaders: ShaderEntry[] = [
		{
			name: 'HGRP/Lit',
			family: 'lit',
			floats: { _BaseTextureMapCount: 2, _UseParallaxMask: 0, _ParallaxIntensity: 1 },
			colors: { _MaskAlbedoG: [0, 1, 0, 1], _MaskAlbedoB: [0, 0, 1, 1] },
			vectors: {},
			textures: {},
			normalMaps: ['_NormalMap'],
		},
	];
	const slot = (texture: number, uv: number, scale = 1) => ({
		texture,
		uv,
		scale: [scale, scale] as [number, number],
		offset: [0, 0] as [number, number],
	});
	const entry = (keywords: string[]): ReadyMaterial => ({
		id: 0,
		status: 'ready',
		shader: 0,
		keywords,
		renderQueue: 2000,
		blend: 'opaque',
		blendFactors: null,
		alphaClipThreshold: null,
		cull: 'back',
		zWrite: true,
		normalLayout: 'RG',
		usesMro: false,
		slots: {
			_BaseColorMap: slot(1, 1, 5),
			_NormalMap: slot(2, 0),
			_MROMap: slot(3, 0),
			_MaskMap: slot(4, 0),
			_DetailMap: slot(5, 1, 5),
			_ParallaxMap: slot(6, 0),
			_ParallaxNoiseMap: slot(6, 0),
		},
		floats: {
			_ParallaxStrength: 0.314,
			_ParallaxMarchNum: 3.41,
			_ParallaxTilling: 2,
			_ParallaxNoiseMapTilling: 3,
			_ParallaxMinBrightness: 0.2,
			_ParallaxMaskChannel: 2,
		},
		colors: { _MaskAlbedoR: [1, 0.5, 0, 0.5], _ParallaxColor: [2.8, 0.7, 0, 1] },
		vectors: {},
	});
	const keywords = ['_DETAIL_MAP', '_PARALLAX_MAP', '_TRI_CHANNEL_MASK', '_TWO_BASEMAP'];
	const [look] = materialLooks({ shaders, entries: [entry(keywords)] });
	assert.deepEqual(look.textures, [1, 2, 4, -1, 5, 6, 6]);
	assert.equal(look.flags & LookFlags.TriChannelMask, LookFlags.TriChannelMask);
	// base and detail sample UV set 1
	assert.equal((look.flags >> UV1_SHIFT) & 0x7f, 0b10001);
	const row = (at: number) => Array.from(look.params.subarray(at, at + 4));
	assert.deepEqual(row(LookRow.maskAlbedo), [1, Math.fround(0.21404114), 0, 0.5].map(Math.fround));
	assert.deepEqual(row(LookRow.uv + 5 * 4), [2, 2, 0, 0]);
	assert.deepEqual(row(LookRow.uv + 6 * 4), [3, 3, 0, 0]);
	// three steps, a pulse between 0.2 and 1, the HDR colour as stored
	assert.deepEqual(row(LookRow.parallax), [0.314, 3, 1, 0.4].map(Math.fround));
	assert.equal(look.params[LookRow.parallax2 + 3], Math.fround(0.6));
	assert.deepEqual(row(LookRow.parallaxColour), [2.8, 0.7, 0, 2].map(Math.fround));

	// switch-texture variants take G and B from textures without a slot: they don't blend
	const [switched] = materialLooks({
		shaders,
		entries: [entry([...keywords, '_TRI_CHANNEL_MASK_SWITCH_TEXTURE'])],
	});
	assert.equal(switched.params[LookRow.maskAlbedo + 4 + 3], 0);
	assert.equal(switched.params[LookRow.maskAlbedo + 8 + 3], 0);
});
