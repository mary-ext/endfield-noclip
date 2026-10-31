import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReadyMaterial, ShaderEntry } from '@endfield-noclip/package-format/materials';

import {
	ErosionRow,
	LayerBlendRow,
	LayerSource,
	LookFlags,
	LookRow,
	materialLooks,
	UV1_SHIFT,
} from './materials.ts';

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
		baseTextureMapCount: null,
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
		baseTextureMapCount: null,
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

test('dither-alpha effects shade as opaque two-sided surfaces from the tinted main texture and their normal map', () => {
	const shaders: ShaderEntry[] = [
		{
			name: 'HGRP/Effect/VFXDitherAlpha',
			family: 'vfxDitherAlpha',
			floats: { _UseLighting: 1, _TintColorIntensity: 1, _Roughness: 0.5, _NormalScale: 1 },
			colors: { _TintColor: [1, 1, 1, 1], _MainTex2Color: [1, 1, 1, 1] },
			vectors: {},
			textures: { _MainTex: 'white', _MainTex2: 'white', _NormalMap: 'bump' },
			normalMaps: [],
		},
	];
	const material = (id: number, overrides: Partial<ReadyMaterial>): ReadyMaterial => ({
		id,
		status: 'ready',
		shader: 0,
		keywords: ['_NORMAL_MAP', '_USE_MAIN2'],
		renderQueue: 2450,
		blend: 'alphaTest',
		blendFactors: null,
		alphaClipThreshold: 0.5,
		cull: 'none',
		zWrite: true,
		baseTextureMapCount: null,
		slots: {
			_MainTex: { texture: 3, uv: 0, scale: [4, 4], offset: [0, 0] },
			_MainTex2: { texture: 4, uv: 0, scale: [1, 1], offset: [0, 0] },
			_NormalMap: { texture: 5, uv: 0, scale: [1, 1], offset: [0, 0] },
		},
		floats: { _UseMainTex2AsAlpha: 1, _TintColorIntensity: 10, _NormalScale: 1.5, _Roughness: 1 },
		colors: { _TintColor: [1, 0.5, 0, 1] },
		vectors: {},
		...overrides,
	});
	const [rock, colored, dissolving] = materialLooks({
		shaders,
		entries: [
			material(0, {}),
			// a second texture's colour isn't drawn
			material(1, { floats: { _UseMainTex2AsAlpha: 0 } }),
			material(2, { keywords: ['_USE_DISSOLVE'] }),
		],
	});
	assert.equal(rock.drawn, true);
	assert.equal(rock.cutout, false);
	assert.equal(rock.castsShadows, false);
	assert.equal(rock.cull, 'none');
	assert.deepEqual(rock.textures.slice(0, 3), [3, 5, -1]);
	assert.equal(rock.flags, LookFlags.BaseMap | LookFlags.NormalMap | LookFlags.NormalRag);
	// the tint times its intensity, linear; the shader saturates the product with the texture
	assert.deepEqual(
		Array.from(rock.params.subarray(LookRow.tint, LookRow.tint + 4), (v) => Math.round(v * 1000) / 1000),
		[10, 2.14, 0, -1],
	);
	assert.deepEqual(Array.from(rock.params.subarray(LookRow.surface, LookRow.surface + 4)), [1, 1, 0, 1.5]);
	assert.deepEqual(Array.from(rock.params.subarray(LookRow.uv, LookRow.uv + 4)), [4, 4, 0, 0]);
	assert.equal(colored.drawn, false);
	assert.equal(dissolving.drawn, false);
});

test('portal effects: an opaque mask writes only the stencil, its effects test it, other stencil operations stay hidden', () => {
	const shaders: ShaderEntry[] = [
		{
			name: 'HGRP/Effect/VFXBaseV2',
			family: 'vfxBase',
			floats: {
				_StencilComp: 8,
				_StencilOp: 0,
				_StencilRef: 0,
				_StencilReadMask: 255,
				_StencilWriteMask: 255,
				_ZTest: 4,
			},
			colors: {},
			vectors: {},
			textures: { _MainTex: 'white' },
			normalMaps: [],
		},
	];
	const material = (id: number, overrides: Partial<ReadyMaterial>): ReadyMaterial => ({
		id,
		status: 'ready',
		shader: 0,
		keywords: [],
		renderQueue: 3000,
		blend: 'premultiplied',
		blendFactors: [1, 10],
		alphaClipThreshold: null,
		cull: 'none',
		zWrite: false,
		baseTextureMapCount: null,
		slots: {},
		floats: {},
		colors: {},
		vectors: {},
		...overrides,
	});
	const [mask, chasm, plain, inverting] = materialLooks({
		shaders,
		entries: [
			material(0, {
				renderQueue: 2000,
				blend: 'opaque',
				blendFactors: null,
				cull: 'back',
				zWrite: true,
				floats: { _StencilOp: 2, _StencilRef: 7, _StencilWriteMask: 7 },
			}),
			material(1, {
				floats: { _StencilComp: 3, _StencilRef: 7, _StencilReadMask: 7, _StencilWriteMask: 7, _ZTest: 8 },
			}),
			material(2, {}),
			material(3, { floats: { _StencilOp: 5 } }),
		],
	});
	assert.equal(mask.drawn, true);
	assert.equal(mask.transparent, false);
	assert.equal(mask.castsShadows, false);
	assert.equal(mask.cull, 'back');
	assert.deepEqual(mask.stencil, {
		compare: 'always',
		replace: true,
		reference: 7,
		readMask: 255,
		writeMask: 7,
		depthCompare: 'greater-equal',
		maskOnly: true,
	});
	assert.equal(chasm.transparent, true);
	assert.deepEqual(chasm.stencil, {
		compare: 'equal',
		replace: false,
		reference: 7,
		readMask: 7,
		writeMask: 7,
		depthCompare: 'always',
		maskOnly: false,
	});
	assert.equal(plain.drawn, true);
	assert.equal(plain.stencil, null);
	assert.equal(inverting.drawn, false);
});

test('glass is transparent, casts no shadow and takes its opacity from the tint alpha and the picked map alpha', () => {
	const shaders: ShaderEntry[] = [
		{
			name: 'HGRP/LitTransparent',
			family: 'litTransparent',
			floats: { _AlphaMaskChannel: 0 },
			colors: { _BaseColor: [1, 1, 1, 1] },
			vectors: {},
			textures: {},
			normalMaps: ['_NormalMap'],
		},
	];
	const entry: ReadyMaterial = {
		id: 0,
		status: 'ready',
		shader: 0,
		keywords: ['_TWO_BASEMAP'],
		renderQueue: 3000,
		blend: 'alphaBlend',
		blendFactors: [5, 10],
		alphaClipThreshold: 0.5,
		cull: 'back',
		zWrite: false,
		baseTextureMapCount: 1,
		slots: {
			_BaseColorMap: { texture: 1, uv: 0, scale: [1, 1], offset: [0, 0] },
			_NormalMap: { texture: 2, uv: 0, scale: [1, 1], offset: [0, 0] },
		},
		floats: { _AlphaMaskChannel: 1 },
		colors: { _BaseColor: [0.8, 0.8, 0.8, 0.5] },
		vectors: {},
	};
	const [look] = materialLooks({ shaders, entries: [entry] });
	assert.equal(look.transparent, true);
	assert.equal(look.cutout, false);
	assert.equal(look.castsShadows, false);
	assert.equal(look.params[LookRow.emissive2 + 3], 0.5);
	assert.notEqual(look.flags & LookFlags.AlphaNormal, 0);
});

test('erosion rock: its maps tile by their own properties on UV set 0, the ramp streams whole, HDR colours stay as stored', () => {
	const shaders: ShaderEntry[] = [
		{
			name: 'HGRP/Erosion',
			family: 'erosion',
			floats: {
				_BaseNormalTilling: 1,
				_DetailNormalTilling: 1,
				_NoisePatternMapTilling: 1,
				_FlowNormalSpeed: 1,
			},
			colors: { _BaseColor: [1, 1, 1, 1], _FlowBottomColor: [1, 1, 1, 1] },
			vectors: {},
			textures: {},
			normalMaps: [],
		},
	];
	const slot = (texture: number) => ({
		texture,
		uv: 1,
		scale: [9, 9] as [number, number],
		offset: [0, 0] as [number, number],
	});
	const entry: ReadyMaterial = {
		id: 0,
		status: 'ready',
		shader: 0,
		keywords: [],
		renderQueue: 2000,
		blend: 'opaque',
		blendFactors: null,
		alphaClipThreshold: null,
		cull: 'back',
		zWrite: true,
		baseTextureMapCount: null,
		slots: {
			_BaseNormalMap: slot(1),
			_MetalMixMap: slot(2),
			_FlowRampMap: slot(3),
			_DetailNormalMap: slot(4),
			_NoisePatternMap: slot(5),
		},
		floats: { _DetailNormalTilling: 5, _NoisePatternMapTilling: 3 },
		colors: { _BaseColor: [0.5, 0.5, 0.5, 1], _FlowBottomColor: [4, 4, 4, 1] },
		vectors: {},
	};
	const [look] = materialLooks({ shaders, entries: [entry] });
	assert.deepEqual(look.textures, [-1, 1, 2, 3, 4, 5, 5]);
	assert.equal(look.flags & (0x7f << UV1_SHIFT), 0);
	assert.notEqual(look.flags & LookFlags.Erosion, 0);
	assert.equal(look.uvScales[3], 0);
	const uv = (slot: number) =>
		Array.from(look.params.subarray(LookRow.uv + slot * 4, LookRow.uv + slot * 4 + 4));
	assert.deepEqual(
		[uv(1), uv(4), uv(5), uv(6)],
		[
			[1, 1, 0, 0],
			[5, 5, 0, 0],
			[3, 3, 0, 0],
			[1, 1, 0, 0],
		],
	);
	assert.ok(Math.abs(look.params[ErosionRow.base] - 0.214) < 1e-3);
	assert.deepEqual(
		Array.from(look.params.subarray(ErosionRow.flowBottom, ErosionRow.flowBottom + 3)),
		[4, 4, 4],
	);
	assert.equal(look.params[ErosionRow.flow + 2], Math.fround(0.05));
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
		baseTextureMapCount: 2,
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
			_ParallaxCharPos: 1,
			_ParallaxBrightOuterRadius: 25,
			_ParallaxBrightInnerRadius: 3,
			_ParallaxBrightStrength: 20,
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
	assert.deepEqual(row(LookRow.parallaxColor), [2.8, 0.7, 0, 2].map(Math.fround));
	assert.deepEqual(row(LookRow.parallaxBright).slice(0, 3), [25, 3, 20]);

	// switch-texture variants take G and B from textures without a slot: they don't blend
	const [switched] = materialLooks({
		shaders,
		entries: [entry([...keywords, '_TRI_CHANNEL_MASK_SWITCH_TEXTURE'])],
	});
	assert.equal(switched.params[LookRow.maskAlbedo + 4 + 3], 0);
	assert.equal(switched.params[LookRow.maskAlbedo + 8 + 3], 0);
});

test('moss rock: the top layer takes the parallax slots and rows, its own tiling and the default grey height', () => {
	const shaders: ShaderEntry[] = [
		{
			name: 'HGRP/Lit',
			family: 'lit',
			floats: { _LayerBlendHeight: 1, _TopBlendSmoothness: 0.5 },
			colors: {},
			vectors: { _Layer1Offset: [0, 0, 0, 0] },
			textures: {},
			normalMaps: [],
		},
	];
	const slot = (texture: number) => ({
		texture,
		uv: 0,
		scale: [1, 1] as [number, number],
		offset: [0, 0] as [number, number],
	});
	const [look] = materialLooks({
		shaders,
		entries: [
			{
				id: 0,
				status: 'ready',
				shader: 0,
				keywords: ['_LAYERBLEND_TOP', '_TERRAIN_BLEND', '_TWO_BASEMAP'],
				renderQueue: 2000,
				blend: 'opaque',
				blendFactors: null,
				alphaClipThreshold: null,
				cull: 'back',
				zWrite: true,
				baseTextureMapCount: 2,
				slots: { _NormalMap: slot(1), _Layer1BaseMap: slot(2), _Layer1BumpMap: slot(3) },
				floats: {
					_Layer1Tilling: 2,
					_LayerBlendUVType: 2,
					_TopBlendThreshold: -1,
					_LayerBlendHeightTransition: 0.056,
					_Layer1Saturation: -0.25,
					_Layer1ColorBrighterScale: 2,
				},
				colors: { _Layer1TintColor: [1, 0.5, 0, 1] },
				vectors: { _Layer1Offset: [0.25, 0.5, 0, 0] },
			},
		],
	});
	assert.deepEqual(look.textures, [-1, 1, -1, -1, -1, 2, 3]);
	assert.notEqual(look.flags & LookFlags.LayerBlend, 0);
	const row = (at: number) => Array.from(look.params.subarray(at, at + 4));
	assert.deepEqual(row(LookRow.uv + 5 * 4), [2, 2, 0.25, 0.5]);
	assert.deepEqual(row(LookRow.uv + 6 * 4), [2, 2, 0.25, 0.5]);
	assert.deepEqual(row(LayerBlendRow.coverage), [0, -1, 0.5, 2]);
	assert.deepEqual(row(LayerBlendRow.height), [1, Math.fround(0.056), 0.5, LayerSource.Top]);
	// the tint linearized, times the brighter scale; saturation 1 − 0.25
	assert.deepEqual(row(LayerBlendRow.color), [2, 0.42808229, 0, 0.75].map(Math.fround));
	// no moss: the fuzzy shading is neutral
	assert.deepEqual(row(LayerBlendRow.fuzzy), [0, 0, 1, 0]);
	assert.deepEqual(row(LayerBlendRow.fuzzy2), [0, 1, 1, 0]);
});

test('moss mounds: the mask layer takes its mask map into the emissive slot, on the UV set its type picks, and shades as moss', () => {
	const shaders: ShaderEntry[] = [
		{
			name: 'HGRP/Lit',
			family: 'lit',
			floats: { _LayerBlendMaskUVType: 0, _Layer1FuzzyDarkPower: 1, _Layer1FuzzyBrightPower: 6 },
			colors: {},
			vectors: {},
			textures: { _LayerBlendMaskMap: 'white' },
			normalMaps: [],
		},
	];
	const slot = (texture: number, uv = 0) => ({
		texture,
		uv,
		scale: [3, 3] as [number, number],
		offset: [0, 0] as [number, number],
	});
	const entry = (
		id: number,
		keywords: string[],
		slots: ReadyMaterial['slots'],
		floats: Record<string, number>,
	): ReadyMaterial => ({
		id,
		status: 'ready',
		shader: 0,
		keywords,
		renderQueue: 2450,
		blend: 'alphaTest',
		blendFactors: null,
		alphaClipThreshold: 0.5,
		cull: 'back',
		zWrite: true,
		baseTextureMapCount: 2,
		slots,
		floats,
		colors: {},
		vectors: {},
	});
	const layerSlots = { _BaseColorMap: slot(0), _Layer1BaseMap: slot(2), _Layer1BumpMap: slot(3) };
	const moss = ['_ALPHATEST_ON', '_LAYERBLEND_MASK', '_LAYERBLEND_MOSS', '_TWO_BASEMAP'];
	const [mound] = materialLooks({
		shaders,
		entries: [
			entry(
				0,
				moss,
				// the slot's own UV set (2) and tiling don't matter: the type picks the set and the map isn't tiled
				{ ...layerSlots, _LayerBlendMaskMap: slot(4, 2) },
				{ _Layer1FuzzyCoreDarkness: 0.2, _Layer1FuzzyEdgeShadowRange: 0.01, _Layer1FuzzyDarkPower: 0.05 },
			),
		],
	});
	assert.deepEqual(mound.textures, [0, -1, -1, 4, -1, 2, 3]);
	assert.notEqual(mound.flags & LookFlags.LayerBlend, 0);
	assert.notEqual(mound.flags & LookFlags.EmissiveMap, 0);
	assert.notEqual(mound.flags & (1 << (UV1_SHIFT + 3)), 0);
	const row = (at: number) => Array.from(mound.params.subarray(at, at + 4));
	assert.deepEqual(row(LookRow.uv + 3 * 4), [1, 1, 0, 0]);
	assert.equal(row(LayerBlendRow.height)[3], LayerSource.MaskMap);
	assert.deepEqual(row(LayerBlendRow.fuzzy), [0.2, 0, 0.01, 0].map(Math.fround));
	// the dark power is floored at 0.1
	assert.deepEqual(row(LayerBlendRow.fuzzy2), [0, 0.1, 6, 0].map(Math.fround));

	// a mask type reads a map channel instead; an emissive map leaves no slot for the mask map, and the noise
	// variant isn't ported
	const [channel, emissive, noise] = materialLooks({
		shaders,
		entries: [
			entry(0, ['_LAYERBLEND_MASK', '_TWO_BASEMAP'], layerSlots, { _LayerBlendMaskType: 2 }),
			entry(
				1,
				['_EMISSIVE_MAP', '_LAYERBLEND_MASK', '_TWO_BASEMAP'],
				{ ...layerSlots, _EmissiveMap: slot(5), _LayerBlendMaskMap: slot(4) },
				{},
			),
			entry(
				2,
				['_LAYERBLEND_MASK', '_LAYERBLEND_NOISEBLEND', '_TWO_BASEMAP'],
				{ ...layerSlots, _LayerBlendMaskMap: slot(4) },
				{},
			),
		],
	});
	assert.equal(channel.params[LayerBlendRow.height + 3], LayerSource.BaseAlpha);
	assert.equal(channel.textures[3], -1);
	for (const look of [emissive, noise]) {
		assert.equal(look.flags & LookFlags.LayerBlend, 0);
		assert.deepEqual(look.textures.slice(5), [-1, -1]);
	}
});
