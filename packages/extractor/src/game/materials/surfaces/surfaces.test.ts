import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeMaterial } from '../material-describe.ts';
import type { MaterialValues, ShaderEntry } from '../material-values.ts';

import { keywordsNotDrawn } from './surface-keywords.ts';

/** a shader entry declaring only the overrides' properties */
const shaderEntry = (
	overrides: Partial<ShaderEntry> & Pick<ShaderEntry, 'name' | 'family'>,
): ShaderEntry => ({
	floats: {},
	colors: {},
	vectors: {},
	textures: {},
	normalMaps: [],
	...overrides,
});

/** an opaque material with no overrides */
const values = (overrides: Partial<MaterialValues> = {}): MaterialValues => ({
	shader: 0,
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
	...overrides,
});

describe('dithered effects', () => {
	const shader = shaderEntry({
		name: 'HGRP/Effect/VFXDitherAlpha',
		family: 'vfxDitherAlpha',
		floats: {
			_UseLighting: 1,
			_TintColorIntensity: 1,
			_Roughness: 0.5,
			_NormalScale: 1,
			_TintColorAlpha: 1,
			_DitherAlphaExp: 1,
			_DitherTilling: 1,
			_DitherAlphaMode: 0,
		},
		colors: { _TintColor: [1, 1, 1, 1], _MainTex2Color: [1, 1, 1, 1] },
		textures: { _MainTex: 'white', _MainTex2: 'white', _NormalMap: 'bump' },
	});

	it('shade as lit surfaces from the tinted main texture and their normal map, masked by a second texture', () => {
		const rock = (overrides: Partial<MaterialValues>) =>
			describeMaterial(
				values({
					keywords: ['_NORMAL_MAP', '_USE_MAIN2'],
					blend: 'alphaTest',
					alphaClipThreshold: 0.5,
					slots: {
						_MainTex: { texture: 3, uv: 0, scale: [4, 4], offset: [0, 0] },
						_MainTex2: { texture: 4, uv: 0, scale: [1, 1], offset: [0, 0] },
						_NormalMap: { texture: 5, uv: 0, scale: [1, 1], offset: [0, 0] },
					},
					floats: { _UseMainTex2AsAlpha: 1, _TintColorIntensity: 10, _NormalScale: 1.5, _Roughness: 1 },
					colors: { _TintColor: [1, 0.5, 0, 1] },
					...overrides,
				}),
				shader,
			);
		const surface = rock({});
		assert.equal(surface.kind, 'dithered');
		if (surface.kind !== 'dithered') {
			return;
		}
		assert.equal(surface.baseMap?.texture, 3);
		assert.equal(surface.normalMap?.texture, 5);
		// with the second texture's mask, the main texture's alpha isn't dithered
		assert.equal(surface.dither, null);
		assert.deepEqual(
			surface.color.map((c) => Math.round(c * 1000) / 1000),
			[10, 2.14, 0],
		);
		assert.deepEqual(surface.lighting, { roughness: 1, metallic: 0, normalScale: 1.5, subsurface: null });
		// a second texture's colour isn't drawn; a dissolve makes it an effect
		assert.equal(rock({ floats: { _UseMainTex2AsAlpha: 0 } }).kind, 'unsupported');
		assert.notEqual(rock({ keywords: ['_USE_DISSOLVE'] }).kind, 'dithered');
	});

	it('dither by the scaled alpha of their main texture, or its red alone when unlit', () => {
		const spot = (floats: Record<string, number>) =>
			describeMaterial(
				values({
					blend: 'alphaTest',
					alphaClipThreshold: 0.5,
					slots: { _MainTex: { texture: 6, uv: 0, scale: [2, 2], offset: [0, 0] } },
					floats: { _UseLighting: 0, ...floats },
					colors: { _TintColor: [0.5, 0.5, 0.5, 0.5] },
				}),
				shader,
			);
		const plain = spot({ _TintColorAlpha: 1.5 });
		const mask = spot({ _UseMainTexAsAlpha: 1, _DitherAlphaExp: 14, _DitherTilling: 0.1 });
		const edged = spot({ _DitherAlphaMode: 1 });
		assert.ok(plain.kind === 'dithered' && mask.kind === 'dithered' && edged.kind === 'dithered');
		assert.deepEqual(
			{ ...plain.dither, texture: plain.dither?.texture.texture },
			{
				texture: 6,
				redAlpha: false,
				alphaScale: 0.75,
				exponent: 1,
				tiling: 1,
				vertexAlpha: true,
				near: null,
			},
		);
		assert.equal(plain.lighting, null);
		assert.equal(mask.baseMap, null);
		assert.deepEqual(
			{ ...mask.dither, texture: mask.dither?.texture.texture },
			{
				texture: 6,
				redAlpha: true,
				alphaScale: 0.5,
				exponent: 14,
				tiling: 0.1,
				vertexAlpha: true,
				near: null,
			},
		);
		// the edge mode isn't drawn
		assert.equal(edged.dither, null);
	});

	it('dither lit waterfall splashes by their main texture red, coloured by the tint alone', () => {
		// the splash sheet at the foot of Si's Painting's cave falls (`M_fx_map_common_waterdecal_splashes_2504_01`)
		const surface = describeMaterial(
			values({
				keywords: ['_NORMAL_MAP'],
				blend: 'alphaTest',
				alphaClipThreshold: 0.5,
				cull: 'none',
				slots: {
					_MainTex: { texture: 8, uv: 0, scale: [1, 1], offset: [0, 0] },
					_NormalMap: { texture: 9, uv: 0, scale: [1, 1], offset: [0, 0] },
				},
				floats: {
					_UseMainTexAsAlpha: 1,
					_TintColorIntensity: 50,
					_TintColorAlpha: 2,
					_DitherAlphaExp: 2,
					_Metallic: 0.8,
				},
			}),
			shaderEntry({ ...shader, name: 'HGRP/Effect/VFXWaterDitherAlpha' }),
		);
		assert.ok(surface.kind === 'dithered');
		assert.equal(surface.baseMap, null);
		assert.equal(surface.normalMap?.texture, 9);
		assert.deepEqual(surface.lighting, { roughness: 0.5, metallic: 0.8, normalScale: 1, subsurface: null });
		assert.deepEqual(
			{ ...surface.dither, texture: surface.dither?.texture.texture },
			{ texture: 8, redAlpha: true, alphaScale: 2, exponent: 2, tiling: 1, vertexAlpha: true, near: null },
		);
	});

	it('read the subsurface colour of waterfall splashes as hue, saturation and value while it is enabled', () => {
		const splash = (floats: Record<string, number>, color: [number, number, number, number]) =>
			describeMaterial(
				values({
					keywords: ['_NORMAL_MAP', '_SUBSURFACE'],
					blend: 'alphaTest',
					alphaClipThreshold: 0.5,
					slots: { _MainTex: { texture: 8, uv: 0, scale: [1, 1], offset: [0, 0] } },
					floats: { _EnableSubsurface: 1, _SubsurfaceIndirect: 1, ...floats },
					colors: { _SubsurfaceColor: color },
				}),
				shaderEntry({ ...shader, name: 'HGRP/Effect/VFXWaterDitherAlpha' }),
			);
		// Wuling City's dam splashes (`M_fxmap_water_citywaterfall_820`): a grey, on a surface with no metallic
		const dam = splash({ _Metallic: 0 }, [0.577, 0.577, 0.577, 1]);
		assert.ok(dam.kind === 'dithered');
		assert.deepEqual(dam.lighting?.subsurface, [0, 0, 0.577, 1]);
		// its particles fade by their colour's alpha, and with the camera's distance
		const faded = splash(
			{
				_UseNearCameraFade: 1,
				_NearCameraFadeDistanceStart: 1,
				_NearCameraFadeDistanceEnd: 2,
				_NearCameraFadeDistanceStart2: 120,
				_NearCameraFadeDistanceEnd2: 80,
			},
			[0.577, 0.577, 0.577, 1],
		);
		assert.ok(faded.kind === 'dithered');
		assert.deepEqual([faded.dither?.vertexAlpha, faded.dither?.near], [true, [1, 2, 120, 80]]);
		const still = splash({ _DisableVertColor: 1 }, [0.577, 0.577, 0.577, 1]);
		assert.ok(still.kind === 'dithered');
		assert.deepEqual([still.dither?.vertexAlpha, still.dither?.near], [false, null]);
		assert.equal(dam.lighting?.metallic, 0);
		const teal = splash({ _SubsurfaceIndirect: 0.5 }, [0.25, 1, 0.75, 1]);
		assert.ok(teal.kind === 'dithered');
		assert.deepEqual(
			teal.lighting?.subsurface?.map((c) => Math.round(c * 1000) / 1000),
			[0.444, 0.75, 1, 0.5],
		);
		// a material that never registered its colour scatters nothing
		const off = splash({ _EnableSubsurface: 0 }, [1, 0, 0, 1]);
		assert.ok(off.kind === 'dithered');
		assert.deepEqual(off.lighting?.subsurface, [0, 0, 0, 0]);
	});

	it('draw the NoLighting variant unlit, though it declares no lighting switch', () => {
		// Si's Painting's ink plane (`M_fxmap_map02_lv010_inkpattern_huge_01_fj_03_d02`)
		const { _UseLighting, ...floats } = shader.floats;
		const surface = describeMaterial(
			values({
				blend: 'alphaTest',
				alphaClipThreshold: 0.5,
				cull: 'front',
				slots: { _MainTex: { texture: 7, uv: 0, scale: [1, 1], offset: [0, 0] } },
				floats: { _UseMainTexAsAlpha: 1, _TintColorIntensity: 2 },
			}),
			shaderEntry({ ...shader, name: 'HGRP/Effect/VFXDitherAlphaNoLighting', floats }),
		);
		assert.ok(surface.kind === 'dithered');
		assert.equal(surface.lighting, null);
		assert.equal(surface.baseMap, null);
		assert.deepEqual(
			{ ...surface.dither, texture: surface.dither?.texture.texture },
			{ texture: 7, redAlpha: true, alphaScale: 1, exponent: 1, tiling: 1, vertexAlpha: true, near: null },
		);
	});
});

describe('erosion', () => {
	it('tiles each map by its own property, linearizes the base colour and keeps HDR colours as stored', () => {
		const shader = shaderEntry({
			name: 'HGRP/Erosion',
			family: 'erosion',
			floats: {
				_BaseNormalTilling: 1,
				_DetailNormalTilling: 1,
				_NoisePatternMapTilling: 1,
				_FlowNormalSpeed: 1,
			},
			colors: { _BaseColor: [1, 1, 1, 1], _FlowBottomColor: [1, 1, 1, 1] },
		});
		const slot = (texture: number) => ({
			texture,
			uv: 1,
			scale: [9, 9] as [number, number],
			offset: [0, 0] as [number, number],
		});
		const surface = describeMaterial(
			values({
				slots: {
					_BaseNormalMap: slot(1),
					_MetalMixMap: slot(2),
					_FlowRampMap: slot(3),
					_DetailNormalMap: slot(4),
					_NoisePatternMap: slot(5),
				},
				floats: { _DetailNormalTilling: 5, _NoisePatternMapTilling: 3 },
				colors: { _BaseColor: [0.5, 0.5, 0.5, 1], _FlowBottomColor: [4, 4, 4, 1] },
			}),
			shader,
		);
		assert.equal(surface.kind, 'erosion');
		if (surface.kind !== 'erosion') {
			return;
		}
		// UV set 0, tiled by their own properties in place of their `_ST`
		const tiled = (texture: number, tiling: number) => ({
			texture,
			uv: 0,
			scale: [tiling, tiling],
			offset: [0, 0],
		});
		assert.deepEqual(surface.textures, {
			baseNormal: tiled(1, 1),
			metalMix: tiled(2, 1),
			flowRamp: tiled(3, 1),
			detailNormal: tiled(4, 5),
			noisePattern: tiled(5, 3),
		});
		assert.ok(Math.abs(surface.baseColor[0] - 0.214) < 1e-3);
		assert.deepEqual(surface.flow.bottom, [4, 4, 4]);
		assert.equal(surface.flow.scroll, 0.05);
	});
});

describe('matte paintings', () => {
	it('fold the alpha scale into the threshold and take the tint times its intensity', () => {
		const shader = shaderEntry({
			name: 'HGRP/MattePainting',
			family: 'mattePainting',
			floats: { _TintColorIntensity: 1, _TintColorAlpha: 1, _ExpThreshold: 1, _ExpIntensity: 0 },
			colors: { _TintColor: [1, 1, 1, 1] },
			textures: { _MainTex: 'white' },
		});
		const surface = describeMaterial(
			values({
				keywords: ['_ALPHATEST_ON'],
				blend: 'alphaTest',
				alphaClipThreshold: 1,
				slots: { _MainTex: { texture: 7, uv: 0, scale: [1, 1], offset: [0, 0] } },
				floats: { _TintColorAlpha: 10, _TintColorIntensity: 2, _ExpIntensity: 4 },
				colors: { _TintColor: [1, 1, 1, 0.5] },
			}),
			shader,
		);
		assert.deepEqual(surface, {
			kind: 'mattePainting',
			texture: { texture: 7, uv: 0, scale: [1, 1], offset: [0, 0] },
			color: [2, 2, 2],
			alphaClip: 0.2,
			highlight: { threshold: 1, intensity: 4 },
			ignorePostExposure: 1,
		});
	});
});

describe('the Lit model', () => {
	/** a Lit surface, failing the test for any other kind */
	const lit = (surface: ReturnType<typeof describeMaterial>) => {
		assert.equal(surface.kind, 'lit', JSON.stringify(surface));
		if (surface.kind !== 'lit') {
			throw new Error('not lit');
		}
		return surface;
	};
	const slot = (texture: number, uv = 0, scale = 1) => ({
		texture,
		uv,
		scale: [scale, scale] as [number, number],
		offset: [0, 0] as [number, number],
	});

	it('takes glass opacity from the tint alpha and the alpha the mask channel picks, and premultiplied blending', () => {
		const shader = shaderEntry({
			name: 'HGRP/LitTransparent',
			family: 'litTransparent',
			floats: { _AlphaMaskChannel: 0 },
			colors: { _BaseColor: [1, 1, 1, 1] },
			normalMaps: ['_NormalMap'],
		});
		const glass = (blend: MaterialValues['blend']) =>
			lit(
				describeMaterial(
					values({
						keywords: ['_TWO_BASEMAP'],
						renderQueue: 3000,
						blend,
						alphaClipThreshold: 0.5,
						baseTextureMapCount: 1,
						slots: { _BaseColorMap: slot(1), _NormalMap: slot(2) },
						floats: { _AlphaMaskChannel: 1 },
						colors: { _BaseColor: [0.8, 0.8, 0.8, 0.5] },
					}),
					shader,
				),
			);
		const blended = glass('alphaBlend');
		assert.deepEqual([blended.blend, blended.opacity, blended.alphaFromNormal], ['alphaBlend', 0.5, true]);
		assert.deepEqual([blended.layout, blended.metallicFromBaseAlpha], ['twoBasemap', true]);
		assert.equal(glass('premultiplied').blend, 'premultiplied');
	});

	it('draws HGRP/LitForward as Lit in the MRO layout, emitting by its mask, without its own cubemap', () => {
		const shader = shaderEntry({
			name: 'HGRP/LitForward',
			family: 'litForward',
			normalMaps: ['_NormalMap'],
		});
		// M_anm_com_treasurechest+1_001_02, the golden treasure chest's body
		const material = values({
			keywords: ['_CUSTOM_IBL', '_EMISSIVE_MASK'],
			baseTextureMapCount: 0,
			slots: { _BaseColorMap: slot(1), _NormalMap: slot(2), _MROMap: slot(3), _CustomIBL: slot(4) },
			floats: { _EmissiveMaskChannel: 4, _Metallic: 1, _Specular: 0.5 },
			colors: { _EmissiveColor: [6.207, 6.323, 3.567, 1], _BaseColor: [1, 1, 1, 1] },
		});
		const chest = lit(describeMaterial(material, shader));
		assert.deepEqual([chest.layout, chest.textures.mro?.texture], ['mro', 3]);
		assert.deepEqual(
			[chest.emission?.source, chest.emission?.maskChannel, chest.emission?.color],
			['mask', 4, [6.207, 6.323, 3.567]],
		);
		assert.deepEqual(keywordsNotDrawn(shader.name, material.keywords), ['_CUSTOM_IBL']);
	});

	it('pulses _EMISSIVE_ANIM emission unless it flickers', () => {
		const shader = shaderEntry({
			name: 'HGRP/Lit',
			family: 'lit',
			floats: { _EmissiveAnimInterval: 1, _EnableEmissiveAnimFlicker: 0 },
			colors: { _EmissiveColor: [1, 1, 1, 1] },
		});
		// M_module_tylight+1_001_03, the white lamp cubes on Wuling's and Marker Stone's towers
		const lamp = (keywords: string[], floats: Record<string, number>) =>
			lit(
				describeMaterial(
					values({
						keywords,
						baseTextureMapCount: 1,
						slots: { _BaseColorMap: slot(1), _EmissiveMap: slot(2) },
						floats: { _EmissiveAnimSpeed: 40, ...floats },
						colors: { _EmissiveColor: [23.97, 23.97, 23.97, 1] },
					}),
					shader,
				),
			);
		const anim = ['_EMISSIVE_ANIM', '_EMISSIVE_MAP', '_TWO_BASEMAP'];
		const pulsing = lamp(anim, {});
		assert.equal(pulsing.emission?.source, 'map');
		assert.deepEqual(pulsing.emission?.color, [23.97, 23.97, 23.97]);
		// one cycle every 2π · 20 / 40 s
		assert.ok(Math.abs((pulsing.emission?.pulse?.rate ?? 0) - 1 / Math.PI) < 1e-6);
		assert.deepEqual(
			{ ...pulsing.emission?.pulse, rate: 0 },
			{ rate: 0, phase: 0, interval: 1, minimum: 0, depth: 1 },
		);
		assert.equal(lamp(anim, { _EnableEmissiveAnimFlicker: 1 }).emission?.pulse, null);
		assert.equal(lamp(['_EMISSIVE_MAP', '_TWO_BASEMAP'], {}).emission?.pulse, null);
	});

	it("adds the emissive map's G, B and A colours by _EmissiveType", () => {
		const shader = shaderEntry({
			name: 'HGRP/LitEffect',
			family: 'litEffect',
			floats: { _EmissiveType: 0 },
			colors: { _EmissiveColorG: [0, 1, 0, 1], _EmissiveColorB: [0, 0, 1, 1], _EmissiveColorA: [0, 0, 0, 1] },
		});
		// M_fx_base01_lv001_ship_line_1123, the stripe ring round Dijiang's shaft cargo
		const ring = (keywords: string[], type: number) =>
			lit(
				describeMaterial(
					values({
						keywords,
						slots: { _EmissiveMap: slot(1) },
						floats: { _EmissiveType: type },
						colors: { _EmissiveColor: [1, 0, 0, 1] },
					}),
					shader,
				),
			).emission;
		assert.deepEqual(ring(['_EMISSIVE_MAP'], 1)?.channels, [
			[0, 1, 0],
			[0, 0, 1],
			[0, 0, 0],
		]);
		assert.deepEqual(ring(['_EMISSIVE_MAP'], 2)?.channels?.[0], [0, 2, 0]);
		// type 0 leaves the channels out, and a mask emits by its one channel
		assert.equal(ring(['_EMISSIVE_MAP'], 0)?.channels, null);
		assert.equal(ring(['_EMISSIVE_MASK'], 1)?.channels ?? null, null);
	});

	it('leaves out _EMISSIVE_ANIM_SWEEP colours that glow only in the sweep band', () => {
		const shader = shaderEntry({
			name: 'HGRP/Lit',
			family: 'lit',
			floats: { _EmissiveType: 0 },
			colors: { _EmissiveColorG: [0, 0, 0, 1], _EmissiveColorB: [0, 0, 0, 1], _EmissiveColorA: [0, 0, 0, 1] },
		});
		// M_interactive_hongshan_obstaclerock+1_001_01, Jingyu's clearable rock: red cracks always, a grey
		// sweep from G
		const rock = (keywords: string[]) =>
			lit(
				describeMaterial(
					values({
						keywords,
						baseTextureMapCount: 2,
						slots: { _BaseColorMap: slot(1), _EmissiveMap: slot(2) },
						floats: { _EmissiveType: 1 },
						colors: {
							_EmissiveColor: [191.75, 6.02, 0, 0],
							_EmissiveColorG: [2.12, 2.12, 2.12, 1],
							_EmissiveColorB: [4, 0, 0, 0.5],
						},
					}),
					shader,
				),
			).emission;
		const swept = rock(['_EMISSIVE_ANIM_SWEEP', '_EMISSIVE_MAP', '_TWO_BASEMAP']);
		assert.deepEqual(swept?.color, [191.75, 6.02, 0]);
		assert.deepEqual(swept?.channels, [
			[0, 0, 0],
			[2, 0, 0],
			[0, 0, 0],
		]);
		assert.deepEqual(rock(['_EMISSIVE_MAP', '_TWO_BASEMAP'])?.channels?.[0], [2.12, 2.12, 2.12]);
	});

	it('describes the originium crystals: tri-channel tint, detail and parallax glow', () => {
		const shader = shaderEntry({
			name: 'HGRP/Lit',
			family: 'lit',
			floats: { _BaseTextureMapCount: 2, _UseParallaxMask: 0, _ParallaxIntensity: 1 },
			colors: { _MaskAlbedoG: [0, 1, 0, 1], _MaskAlbedoB: [0, 0, 1, 1] },
			normalMaps: ['_NormalMap'],
		});
		const crystal = (keywords: string[]) =>
			lit(
				describeMaterial(
					values({
						keywords,
						baseTextureMapCount: 2,
						slots: {
							_BaseColorMap: slot(1, 1, 5),
							_NormalMap: slot(2),
							_MROMap: slot(3),
							_MaskMap: slot(4),
							_DetailMap: slot(5, 1, 5),
							_ParallaxMap: slot(6),
							_ParallaxNoiseMap: slot(7),
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
					}),
					shader,
				),
			);
		const keywords = ['_DETAIL_MAP', '_PARALLAX_MAP', '_TRI_CHANNEL_MASK', '_TWO_BASEMAP'];
		const surface = crystal(keywords);
		// the two-basemap layout has no MRO map
		assert.deepEqual(surface.textures, { base: slot(1, 1, 5), normal: slot(2), mro: null, emissive: null });
		assert.equal(surface.detail?.texture.texture, 5);
		const red = surface.triChannel?.channels[0];
		assert.deepEqual(
			[...(red?.albedo ?? []).map((c) => Math.round(c * 1e4) / 1e4), red?.strength],
			[1, 0.214, 0, 0.5],
		);
		assert.deepEqual(surface.overlay, {
			kind: 'parallax',
			// tiled by their own properties, the noise on the pattern's UV set
			pattern: slot(6, 0, 2),
			noise: slot(7, 0, 3),
			depth: 0.314,
			// the step count truncates
			steps: 3,
			fresnelPower: 1,
			pulseRate: 0,
			pulsePhasePerMetre: 0,
			pulseMinimum: 0.2,
			bright: [2.8, 0.7, 0],
			dark: [0, 0, 0],
			maskChannel: 2,
			ignorePostExposure: 1,
			near: { outer: 25, inner: 3, strength: 20 },
		});
		// switch-texture variants take G and B from textures without a slot: they don't blend
		const switched = crystal([...keywords, '_TRI_CHANNEL_MASK_SWITCH_TEXTURE']).triChannel?.channels;
		assert.deepEqual([switched?.[1].strength, switched?.[2].strength], [0, 0]);
	});

	it('glows with an empty noise slot, as the campfire crystals do', () => {
		const shader = shaderEntry({
			name: 'HGRP/Lit',
			family: 'lit',
			floats: { _BaseTextureMapCount: 0, _UseParallaxMask: 0, _ParallaxIntensity: 1 },
		});
		const surface = lit(
			describeMaterial(
				values({
					keywords: ['_MATCAP', '_PARALLAX_MAP'],
					baseTextureMapCount: 0,
					slots: { _BaseColorMap: slot(1), _MROMap: slot(2), _ParallaxMap: slot(3), _MatcapMap: slot(4) },
					floats: { _ParallaxStrength: 0.119, _ParallaxMarchNum: 3.61 },
					colors: { _ParallaxColor: [95.87, 36.64, 3.51, 1] },
				}),
				shader,
			),
		);
		const glow = surface.overlay;
		assert.ok(glow?.kind === 'parallax');
		assert.deepEqual(
			[glow.pattern, glow.noise, glow.steps, glow.bright],
			[slot(3), null, 3, [95.87, 36.64, 3.51]],
		);
	});

	it('describes a moss rock top layer with its own tiling and offset, without moss unless keyworded', () => {
		const shader = shaderEntry({
			name: 'HGRP/Lit',
			family: 'lit',
			floats: { _LayerBlendHeight: 1, _TopBlendSmoothness: 0.5 },
			vectors: { _Layer1Offset: [0, 0, 0, 0] },
		});
		const surface = lit(
			describeMaterial(
				values({
					keywords: ['_LAYERBLEND_TOP', '_TERRAIN_BLEND', '_TWO_BASEMAP'],
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
				}),
				shader,
			),
		);
		const layer = surface.overlay;
		assert.ok(layer?.kind === 'layer');
		const layered = (texture: number) => ({ texture, uv: 0, scale: [2, 2], offset: [0.25, 0.5] });
		assert.deepEqual([layer.base, layer.bump, layer.uvType], [layered(2), layered(3), 'uv2']);
		assert.deepEqual(layer.coverage, { kind: 'top' });
		assert.deepEqual(layer.top, { bumped: 0, threshold: -1, smoothness: 0.5 });
		assert.equal(layer.heightTransition, 0.056);
		// the tint linearized, times the brighter scale; saturation 1 − 0.25
		assert.deepEqual(
			[...layer.tint.map((c) => Math.round(c * 1e4) / 1e4), layer.saturation],
			[2, 0.4281, 0, 0.75],
		);
		assert.equal(layer.moss, null);
	});

	it('describes moss mounds: a mask layer on the UV set its type picks, mask channels, and no noise variant', () => {
		const shader = shaderEntry({
			name: 'HGRP/Lit',
			family: 'lit',
			floats: { _LayerBlendMaskUVType: 0, _Layer1FuzzyDarkPower: 1, _Layer1FuzzyBrightPower: 6 },
			textures: { _LayerBlendMaskMap: 'white' },
		});
		const mound = (keywords: string[], slots: MaterialValues['slots'], floats: Record<string, number>) =>
			lit(
				describeMaterial(
					values({
						keywords,
						blend: 'alphaTest',
						alphaClipThreshold: 0.5,
						baseTextureMapCount: 2,
						slots,
						floats,
					}),
					shader,
				),
			);
		const layerSlots = {
			_BaseColorMap: slot(0),
			_Layer1BaseMap: slot(2, 0, 3),
			_Layer1BumpMap: slot(3, 0, 3),
		};
		const moss = mound(
			['_ALPHATEST_ON', '_LAYERBLEND_MASK', '_LAYERBLEND_MOSS', '_TWO_BASEMAP'],
			// the slot's own UV set (2) doesn't matter: the type picks the set
			{ ...layerSlots, _LayerBlendMaskMap: slot(4, 2) },
			{ _Layer1FuzzyCoreDarkness: 0.2, _Layer1FuzzyEdgeShadowRange: 0.01, _Layer1FuzzyDarkPower: 0.05 },
		).overlay;
		assert.ok(moss?.kind === 'layer');
		assert.deepEqual(moss.coverage, { kind: 'maskMap', map: slot(4, 1) });
		// the dark power is floored at 0.1
		assert.deepEqual(moss.moss, {
			coreDarkness: 0.2,
			edgeBrightness: 0,
			edgeShadowRange: 0.01,
			edgeShadowOffset: 0,
			edgeShadowIntensity: 0,
			darkPower: 0.1,
			brightPower: 6,
			normalStrength: 0,
		});
		const channel = mound(['_LAYERBLEND_MASK', '_TWO_BASEMAP'], layerSlots, {
			_LayerBlendMaskType: 2,
		}).overlay;
		assert.deepEqual(channel?.kind === 'layer' && channel.coverage, { kind: 'baseAlpha' });
		const noise = mound(
			['_LAYERBLEND_MASK', '_LAYERBLEND_NOISEBLEND', '_TWO_BASEMAP'],
			{ ...layerSlots, _LayerBlendMaskMap: slot(4) },
			{},
		);
		assert.equal(noise.overlay, null);
	});

	it("sways HGRP/Lit cloth by its own direction or the wind's, but not GPU cloth or other shaders", () => {
		// M_prop_map02_kite+1_001_01a's values
		const shader = shaderEntry({
			name: 'HGRP/Lit',
			family: 'lit',
			floats: {
				_SimpleVertexAnimationWindIntensity: 0,
				_SimpleVertexAnimationWindFreq: 1,
				_SimpleVertexAnimationWindSoftFactor: 0,
				_NoiseOffsetIntensity: 0,
				_Use_Custom_WindDir: 0,
				_MainDirectionAngle: 0,
				_DirectionTendency: 0,
				_Kite: 0,
			},
		});
		const kite = {
			_SimpleVertexAnimationWindIntensity: 1.5,
			_SimpleVertexAnimationWindFreq: 7.4,
			_SimpleVertexAnimationWindSoftFactor: 0.12,
			_Use_Custom_WindDir: 1,
			_MainDirectionAngle: 90,
			_Kite: 1,
		};
		const cloth = ['_SIMPLE_VERTEXANIM', '_SIMPLE_VERTEXANIM_CLOTH'];
		const sway = (keywords: string[], floats: Record<string, number>, entry = shader) =>
			lit(describeMaterial(values({ keywords, floats }), entry)).sway;
		const swung = sway(cloth, kite);
		assert.ok(swung !== null && swung.direction !== null);
		assert.deepEqual(
			{ ...swung, direction: null },
			{
				intensity: 1.5,
				frequency: 7.4,
				softness: 0.12,
				kite: 1,
				tendency: 0,
				direction: null,
			},
		);
		assert.ok(Math.abs(swung.direction[0]) < 1e-9 && swung.direction[1] === 1);
		assert.equal(sway(cloth, { ...kite, _Use_Custom_WindDir: 0 })?.direction, null);
		assert.equal(sway(cloth, { ...kite, _SimpleVertexAnimationWindIntensity: 0 }), null);
		assert.equal(sway([...cloth, '_GPU_CLOTH'], kite), null);
		assert.equal(sway(['_SIMPLE_VERTEXANIM', '_SIMPLE_VERTEXANIM_PENDULUM'], kite), null);
		assert.equal(
			sway(cloth, kite, { ...shader, name: 'HGRP/LitTransparent', family: 'litTransparent' }),
			null,
		);
	});

	it('offsets HGRP/Lit vertices by a scrolling texture on the UV set its switch picks, with its mask', () => {
		// M_cloth_map02_sfcanvas+1_001_01a's values
		const shader = shaderEntry({
			name: 'HGRP/Lit',
			family: 'lit',
			floats: {
				_OffsetSwitchDir: 0,
				_OffsetIntensity: 0,
				_Bi_Offset: 0,
				_OffsetUVSet: 0,
				_OffsetMaskPower: 0,
				_UseVertexColorMask: 0,
			},
			textures: { _OffsetTex: 'white', _OffsetMaskTex: 'white' },
		});
		const ribbon = {
			_OffsetSwitchDir: 1,
			_OffsetIntensity: 0.4,
			_OffsetUVSet: 1,
			_OffsetMaskPower: 5,
		};
		const colors: MaterialValues['colors'] = {
			_OffsetDir: [2, 2, 2, 15],
			_OffsetSpeed: [-1, -2, 2, 20],
			_OffsetMaskSpeed: [0, 0, 0, 0],
		};
		const noise = {
			texture: 7,
			uv: 0,
			scale: [1, 1.3] as [number, number],
			offset: [0, 0] as [number, number],
		};
		const mask = { texture: 8, uv: 0, scale: [1, 1] as [number, number], offset: [0, 1] as [number, number] };
		const both = ['_USE_VERTOFFSET', '_USE_VERTOFFSETMASK'];
		const offset = (
			keywords: string[],
			floats: Record<string, number> = ribbon,
			slots: MaterialValues['slots'] = { _OffsetTex: noise, _OffsetMaskTex: mask },
			entry = shader,
		) => lit(describeMaterial(values({ keywords, floats, colors, slots }), entry)).vertexOffset;

		assert.deepEqual(offset(both), {
			texture: { ...noise, uv: 1 },
			scroll: [-1, -2],
			direction: [2, 2, 2],
			space: 'world',
			intensity: 0.4,
			bias: 0,
			vertexAlphaWeight: false,
			mask: { texture: { ...mask, uv: 1 }, scroll: [0, 0], strength: 1 },
		});
		// without the mask keyword, or with a mask texture left unset, which reads as white: unmasked
		assert.equal(offset(['_USE_VERTOFFSET'])?.mask, null);
		assert.equal(offset(both, ribbon, { _OffsetTex: noise })?.mask, null);
		// the balloon tube's: its direction in object space, on UV set 0
		const tube = offset(both, { _OffsetIntensity: -0.1, _OffsetMaskPower: 5 });
		assert.deepEqual([tube?.space, tube?.texture.uv, tube?.intensity], ['object', 0, -0.1]);
		assert.equal(offset(both, { ...ribbon, _OffsetSwitchDir: 2 })?.space, 'normal');
		assert.equal(offset(both, { ...ribbon, _UseVertexColorMask: 1 })?.vertexAlphaWeight, true);

		assert.equal(offset(['_USE_VERTOFFSETMASK']), null);
		assert.equal(offset(both, ribbon, { _OffsetMaskTex: mask }), null);
		assert.equal(
			offset(both, ribbon, { _OffsetTex: noise }, { ...shader, textures: { _OffsetMaskTex: 'black' } }),
			null,
		);
		assert.equal(
			offset(both, ribbon, undefined, { ...shader, name: 'HGRP/LitEffect', family: 'litEffect' }),
			null,
		);
		assert.deepEqual(keywordsNotDrawn('HGRP/Lit', [...both, '_SIMPLE_VERTEXANIM_ROPE']), [
			'_SIMPLE_VERTEXANIM_ROPE',
		]);
		assert.deepEqual(keywordsNotDrawn('HGRP/LitEffect', both), both);
	});

	it("keeps lit decals off surfaces whose shader writes a _StencilRef with the decals' bit; HLODs write 0", () => {
		const keepsOff = (name: string, family: ShaderEntry['family'], stencilRef: number) =>
			lit(describeMaterial(values(), shaderEntry({ name, family, floats: { _StencilRef: stencilRef } })))
				.keepsLitDecalsOff;
		assert.deepEqual(
			[
				keepsOff('HGRP/Foliage/Grass', 'grass', 33),
				keepsOff('HGRP/Foliage/Trunk', 'trunk', 32),
				keepsOff('HGRP/Foliage/Leaf', 'leaf', 1),
				keepsOff('HGRP/Lit', 'lit', 0),
				keepsOff('HGRP/LitHLOD', 'hlod', 32),
			],
			[true, true, false, false, false],
		);
	});

	it("reads a leaf's _BLEND_COLOR only with its keyword", () => {
		// the pear blossoms' values
		const shader = shaderEntry({
			name: 'HGRP/Foliage/Leaf',
			family: 'leaf',
			floats: { _BlendNormalAdd: -0.86, _BlendNormalPower: 1.8, _BlendWithVertexNormal: 1 },
			colors: { _BlendColor: [1, 0.5, 0, 0.75] },
		});
		const blend = (keywords: string[]) => {
			const foliage = lit(describeMaterial(values({ keywords }), shader)).foliage;
			assert.equal(foliage?.kind, 'leaf');
			return foliage.blend;
		};
		assert.equal(blend([]), null);
		const read = blend(['_BLEND_COLOR']);
		assert.deepEqual(read, {
			color: [1, read?.color[1], 0],
			strength: 0.75,
			normalAdd: -0.86,
			normalPower: 1.8,
			withVertexNormal: 1,
		});
		// sRGB 0.5 is linear 0.214
		assert.ok(Math.abs((read?.color[1] ?? 0) - 0.214) < 1e-3);
		assert.deepEqual(keywordsNotDrawn('HGRP/Foliage/Leaf', ['_BLEND_COLOR', '_AO_MASK_TUNE_COLOR']), [
			'_AO_MASK_TUNE_COLOR',
		]);
	});

	it("reads a leaf's _TwoSidedNormal, which is off unless the material sets it", () => {
		const leaf = (floats: Record<string, number>) => {
			const shader = shaderEntry({ name: 'HGRP/Foliage/Leaf', family: 'leaf', floats });
			const foliage = lit(describeMaterial(values({}), shader)).foliage;
			assert.equal(foliage?.kind, 'leaf');
			return foliage.twoSidedNormal;
		};
		// the Jingyu cherry trees' leaves keep their canopy's normals on back faces
		assert.equal(leaf({ _TwoSidedNormal: 0 }), false);
		assert.equal(leaf({}), false);
		assert.equal(leaf({ _TwoSidedNormal: 1 }), true);
	});

	it("reads a trunk's vertex AO and ramp only with _FOLIAGE_TRUNK", () => {
		// the Jingyu arch tree's bark: texture occlusion off, vertex AO nearly full, no ramp
		const floats = { _TrunkVertexAoStrength: 0.9, _EnableTrunkRamp: 0, _TrunkRampIntensity: 1 };
		const trunk = (keywords: string[], patch: Record<string, number> = {}) => {
			const shader = shaderEntry({
				name: 'HGRP/Foliage/Trunk',
				family: 'trunk',
				floats: { ...floats, ...patch, _TrunkRampRange: 0.25, _TrunkRampTransitionRange: 0.5 },
				colors: { _TrunkRampColor: [1, 0.5, 0, 1] },
			});
			return lit(describeMaterial(values({ keywords }), shader)).trunk;
		};
		assert.equal(trunk([]), null);
		assert.deepEqual(trunk(['_FOLIAGE_TRUNK']), { vertexAo: 0.9, ramp: null });
		const ramp = trunk(['_FOLIAGE_TRUNK'], { _EnableTrunkRamp: 1 })?.ramp;
		assert.deepEqual(ramp, { color: [1, ramp?.color[1], 0], intensity: 1, range: 0.25, transition: 0.5 });
		assert.deepEqual(keywordsNotDrawn('HGRP/Foliage/Trunk', ['_FOLIAGE_TRUNK', '_DETAIL_MAP']), [
			'_DETAIL_MAP',
		]);
		// Lit has the keyword too, but only the trunk shader's is read
		const litShader = shaderEntry({ name: 'HGRP/Lit', family: 'lit', floats });
		assert.equal(lit(describeMaterial(values({ keywords: ['_FOLIAGE_TRUNK'] }), litShader)).trunk, null);
	});

	it('rejects maps on UV sets past 1', () => {
		const shader = shaderEntry({ name: 'HGRP/Lit', family: 'lit' });
		const surface = describeMaterial(values({ slots: { _BaseColorMap: slot(1, 2) } }), shader);
		assert.deepEqual(surface, { kind: 'unsupported', reason: '_BaseColorMap on UV set 2' });
	});
});
