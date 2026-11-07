import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TextureSlot } from '@endfield-noclip/package-format/materials';
import type { MaterialSurface } from '@endfield-noclip/package-format/surfaces';

import { describeMaterial } from '../material-describe.ts';
import type { MaterialValues, ShaderEntry, ShaderFamily } from '../material-values.ts';

const shader = (name: string, family: ShaderFamily, overrides: Partial<ShaderEntry> = {}): ShaderEntry => ({
	name,
	family,
	floats: {},
	colors: {},
	vectors: {},
	textures: {},
	normalMaps: [],
	...overrides,
});

const slot = (texture: number, scale: [number, number] = [1, 1]): TextureSlot => ({
	texture,
	uv: 0,
	scale,
	offset: [0, 0],
});

/** a premultiplied effect material with no overrides */
const material = (overrides: Partial<MaterialValues>): MaterialValues => ({
	shader: 0,
	keywords: [],
	renderQueue: 3000,
	blend: 'premultiplied',
	blendFactors: [1, 10],
	alphaClipThreshold: null,
	cull: 'back',
	zWrite: false,
	baseTextureMapCount: null,
	slots: {},
	floats: {},
	colors: {},
	vectors: {},
	...overrides,
});

/** the surface, failing the test unless it's of `kind` */
const ofKind = <K extends MaterialSurface['kind']>(
	surface: MaterialSurface,
	kind: K,
): Extract<MaterialSurface, { kind: K }> => {
	if (surface.kind !== kind) {
		throw new Error(`expected ${kind}, got ${JSON.stringify(surface)}`);
	}
	return surface as Extract<MaterialSurface, { kind: K }>;
};

describe('mist', () => {
	it('draws additive cards with HDR colours as stored, and equal fade ends as a step', () => {
		const card = ofKind(
			describeMaterial(
				material({
					blend: 'additive',
					keywords: ['_USE_SOFTBLEND'],
					slots: { _MainTex: slot(1), _NoiseTex: slot(2) },
					floats: {
						_BaseAlphaIntensity: 2,
						_DistanceFadeStart: 0.001,
						_DistanceFadeEnd: 0.001,
						_NearCameraFadeDistanceStart: 3000,
						_NearCameraFadeDistanceEnd: 2500,
						_SoftDistance: 12,
					},
					// Suiming's cave-exit card (`M_fog_indie_dg016_001`)
					colors: { _BaseColor: [16.07, 19.84, 29.89, 1], _IndirectColor: [0.5, 0.25, 2, 1] },
				}),
				shader('HGRP/FogSimple', 'fogSimple'),
			),
			'mistCard',
		);
		assert.equal(card.baseAlphaIntensity, 2);
		assert.deepEqual(card.color, [16.07, 19.84, 29.89, 1]);
		assert.deepEqual([card.indirectColor, card.additive], [[0.5, 0.25, 2], true]);
		assert.deepEqual(
			card.distanceFade.map((v) => Number(v.toFixed(4))),
			[0.001, 0.0011],
		);
		assert.deepEqual(card.nearFade, [3000, 2500]);
		assert.equal(card.softDistance, 12);
		const other = describeMaterial(
			material({ keywords: ['_USE_SOMETHING_ELSE'], slots: { _MainTex: slot(1), _NoiseTex: slot(2) } }),
			shader('HGRP/FogSimple', 'fogSimple'),
		);
		assert.deepEqual(other, { kind: 'unsupported', reason: 'keywords _USE_SOMETHING_ELSE' });
	});

	it('samples an unbound noise texture as white, and fades by its Fresnel term', () => {
		// Marker Stone Interiors' `M_fog_indie_dg007_001`, which binds no noise texture
		const fog = shader('HGRP/FogSimple', 'fogSimple', {
			textures: { _MainTex: 'white', _NoiseTex: 'white' },
		});
		const card = ofKind(
			describeMaterial(
				material({
					blend: 'additive',
					slots: { _MainTex: slot(1) },
					floats: { _UseFresnel: 1, _FresnelIntensity: 0.282, _FresnelContract: 1, _FlipFresnel: 1 },
				}),
				fog,
			),
			'mistCard',
		);
		assert.equal(card.noise, null);
		assert.deepEqual(card.fresnel, { intensity: 0.282, contrast: 1, flip: 1 });
		const grey = shader('HGRP/FogSimple', 'fogSimple', { textures: { _NoiseTex: 'grey' } });
		assert.equal(describeMaterial(material({ slots: { _MainTex: slot(1) } }), grey).kind, 'unsupported');
	});

	it('draws walk-in boxes without the close-up fade, and their 3D noise only with its keyword', () => {
		const box = (overrides: Partial<MaterialValues>) =>
			ofKind(
				describeMaterial(
					material({ blend: 'additive', slots: { _NoiseTex3D: slot(3) }, ...overrides }),
					shader('HGRP/Effect/VFXFakeVolumeFog', 'vfxFakeVolumeFog'),
				),
				'mistVolume',
			);
		const walkIn = box({ floats: { _canWalkIn: 1, _NearFadeDistance: 5, _FogDensity: 4 } });
		assert.deepEqual([walkIn.density, walkIn.nearFade, walkIn.noise], [4, 0, null]);
		const noisy = box({
			keywords: ['_USE_NOISE3D'],
			floats: { _NoiseIntensity: 0, _NoiseFarIntensity: -0.3, _NoiseFar: 2, _NoiseUVWSpeed1: 0.5 },
			vectors: { _NoiseTexTilling1: [0.02, 0.02, 0.02, 1], _NoiseUVWDir1: [1, 0, -1, 0] },
		});
		assert.deepEqual(noisy.noise, {
			texture: 3,
			tiling: [0.02, 0.02, 0.02],
			world: true,
			flow: [0.5, 0, -0.5],
			nearIntensity: 0,
			farIntensity: -0.3,
			farPerMetre: 0.05,
		});
		assert.equal(
			describeMaterial(material({}), shader('HGRP/Effect/VFXFakeVolumeFog', 'vfxFakeVolumeFog')).kind,
			'unsupported',
		);
	});
});

describe('light beams', () => {
	const beamShader = shader('Hidden/VLB_HGRP_SinglePass', 'volumetricBeam', {
		floats: { _BlendMode: 1, _BlendSrcFactor: 1, _BlendDstFactor: 1, _FresnelPow: 1 },
		colors: { _ColorFlat: [1, 1, 1, 1] },
		vectors: { _ConeParams0: [0, 0, 0, 0], _ConeParams1: [0, 0, 0, 0], _DistanceFallOff: [0, 0, 0, 0] },
	});
	// dung02_dg005's `VLB_5006340546849160366`, one of the Wuling rift's two great beams
	const riftBeam = (overrides: Partial<MaterialValues> = {}) =>
		describeMaterial(
			material({
				keywords: ['VLB_DEPTH_BLEND'],
				blend: 'alphaBlend',
				blendFactors: [5, 10],
				floats: {
					_AlphaInside: 0.15,
					_AlphaOutside: 0.15,
					_AttenuationLerpLinearQuad: 1,
					_DepthBlendDistance: 22,
					_DistanceFadeStart: 256,
					_DistanceFadeEnd: 200,
					_DistanceFadeStartSecond: 0,
					_DistanceFadeEndSecond: 0,
					_FresnelPow: 2,
				},
				colors: { _ColorFlat: [0.45, 0.5875, 1, 1] },
				vectors: {
					_ConeParams0: [1, 1.00087571, 0.99999994, 0.0002919],
					_ConeParams1: [0, 0, 1, 0],
					_DistanceFallOff: [1, 3, 3, 0],
				},
				...overrides,
			}),
			beamShader,
		);

	it('reads an additive beam: its cone, falloff, linear colour and a step for equal fade ends', () => {
		const beam = ofKind(riftBeam(), 'lightBeam');
		assert.equal(beam.additive, true);
		assert.deepEqual(beam.falloff, [1, 3, 3, 0]);
		assert.equal(beam.cone[1], 1.00087571);
		assert.equal(beam.depthBlend, 22);
		assert.deepEqual([beam.alphaInside, beam.alphaOutside], [0.15, 0.15]);
		// `_ColorFlat` is an LDR colour: decoded to linear
		assert.ok(Math.abs(beam.color[0] - 0.1708) < 1e-3);
		assert.ok(beam.distanceFadeSecond[1] > beam.distanceFadeSecond[0]);
		assert.equal(beam.unfogged, true);
	});

	it('keeps a beam without depth blending, or alpha-blended under fog, to its own settings', () => {
		assert.equal(ofKind(riftBeam({ keywords: ['VLB_NOISE_3D'] }), 'lightBeam').depthBlend, 0);
		const fogged = ofKind(
			riftBeam({
				keywords: ['VLB_DEPTH_BLEND', 'VLB_USE_FOG'],
				floats: { _BlendMode: 0, _BlendSrcFactor: 5, _BlendDstFactor: 10 },
			}),
			'lightBeam',
		);
		assert.deepEqual([fogged.unfogged, fogged.additive], [false, false]);
	});

	it('marks blending the game pairs with neither mode unsupported', () => {
		const odd = riftBeam({ floats: { _BlendMode: 1, _BlendSrcFactor: 5, _BlendDstFactor: 10 } });
		assert.equal(odd.kind, 'unsupported');
	});
});

/** a layer's role, red-alpha flag, source and disturb share */
const roleOf = (
	layer: { role: string; redAlpha: boolean; source: string | null; disturbShare: number } | null,
) => (layer === null ? null : [layer.role, layer.redAlpha, layer.source, layer.disturbShare]);

describe('VFXDecal', () => {
	const decal = shader('HGRP/Effect/VFXDecal', 'decal');

	it('takes its keyworded textures with their roles, the HDR base colour as stored, and its angle fade', () => {
		const stack = ofKind(
			describeMaterial(
				material({
					keywords: ['_USE_MASK', '_USE_DISTURB', '_USE_NORMALBLEND'],
					slots: {
						_MainTex: slot(1),
						_MaskTex: slot(2),
						_DisturbTex1: slot(3),
						_DisturbTex2: slot(4),
						_BlendTex: slot(5, [2, 2]),
					},
					floats: {
						_TintColorAlpha: 0.5,
						_MaskTexUseDisturb: 0.25,
						_UseMaskTexAsAlpha: 1,
						_AngleBlendFallOff: 5,
					},
					colors: { _DecalBaseColor: [2, 0.5, 1, 0.8] },
				}),
				decal,
			),
			'effectStack',
		);
		assert.equal(stack.variant, 'decal');
		// main, disturb 1, mask; disturb 2 and blend lack their keywords, and there's no weight texture
		assert.deepEqual(stack.layers.map(roleOf), [
			['main', false, 'uv0', 0],
			['disturb1', false, 'uv0', 0],
			null,
			null,
			['mask', true, 'uv0', 0.25],
			null,
			null,
		]);
		assert.deepEqual(stack.tint, [2, 0.5, 1, 0.4]);
		assert.equal(stack.decalFade?.angle, 5);
		assert.equal(stack.unfogged, true);
	});

	it('starts its mask from polar UVs where computed, its weight from the box where screen UVs are not', () => {
		const stack = ofKind(
			describeMaterial(
				material({
					keywords: ['_USE_MASK', '_USE_WEIGHT', '_USE_POLARUV'],
					slots: { _MainTex: slot(1), _MaskTex: slot(2), _WeightTex: slot(3) },
					floats: {
						_UsePolarUV: 1,
						_MaskSwitchUV: 2,
						_WeightSwitchUV: 1,
						_WeightTexIntensity: 0.5,
						_DissolveUseWeight: 1,
					},
				}),
				decal,
			),
			'effectStack',
		);
		assert.equal(stack.layers[4]?.source, 'polar');
		assert.equal(stack.layers[3]?.source, 'uv0');
		assert.deepEqual(stack.weight, { disturb: 0.5, dissolve: 0.5, used: true });
	});

	it('moves a texture by its speed’s zw times its constant custom data, turned and scaled, before its offset', () => {
		const stack = ofKind(
			describeMaterial(
				material({
					slots: { _MainTex: slot(1, [2, 1]) },
					// a quarter turn: the shift (0.5, 0) turns to (0, 0.5)
					floats: { _MainCustomData: 2, _MainTexUVRotate: -90 },
					colors: { _MainTexUVSpeed: [0, 0, 0.25, 0] },
				}),
				decal,
			),
			'effectStack',
		);
		const main = stack.layers[0];
		assert.ok(main !== null);
		assert.deepEqual(main.customScroll, [0, 0]);
		assert.ok(Math.abs(main.offset[0]) < 1e-9 && Math.abs(main.offset[1] - 0.5) < 1e-9, String(main.offset));
	});

	// Marker Stone Interiors' ash (`M_fxmap_map02_lv004_ash_01_03`)
	const ash = (overrides: Partial<MaterialValues> = {}) =>
		material({
			keywords: ['_USE_DISSOLVE', '_USE_DISTURB', '_USE_PARALLAX', '_USE_POLARUV'],
			slots: {
				_MainTex: slot(1),
				_DisturbTex1: slot(2),
				_DissolveTex: slot(3),
				_DepthTex: slot(4),
				_CrackMask: slot(5),
				_CrackNoiseTex: slot(6, [3, 1]),
			},
			floats: {
				_UsePolarUV: 1,
				_ParallaxScale: 0.007,
				_ParallaxSwitchUV: 2,
				_ParallaxUseDisturb: 1,
				_CrackNoiseIntensity: 2,
			},
			colors: {
				_CrackColor: [0.5, 0.7, 1, 0],
				_CrackNoiseColor: [1, 1, 2, 1],
				_CrackNoiseSpeed: [0, -0.02, 0, 0],
			},
			...overrides,
		});

	it('steps its parallax through the depth texture and adds cracks, in the slots no layer takes', () => {
		const { parallax } = ofKind(describeMaterial(ash(), decal), 'effectStack');
		assert.ok(parallax !== null);
		// main, disturb 1 and the dissolve take slots 0, 1 and 6
		assert.deepEqual([parallax.depthSlot, parallax.crackSlot, parallax.noiseSlot], [2, 3, 4]);
		assert.deepEqual([parallax.depth.texture, parallax.crack.texture, parallax.noise.texture], [4, 5, 6]);
		assert.deepEqual([parallax.noiseSource, parallax.noiseDisturb, parallax.scale], ['polar', 1, 0.007]);
		// the noise scrolls after its `_ST`
		assert.deepEqual(parallax.noise.scroll, [0, -0.02]);
		assert.deepEqual(
			[parallax.crackColor, parallax.noiseColor],
			[
				[0.5, 0.7, 1],
				[2, 2, 4],
			],
		);
	});

	it('leaves out parallax beside a blend layer', () => {
		const blended = ash({ keywords: ['_USE_PARALLAX', '_USE_BLEND'] });
		assert.equal(describeMaterial(blended, decal).kind, 'unsupported');
	});
});

describe('lit decals', () => {
	const litDecal = shader('HGRP/DecalLit', 'decal');
	const floats = {
		_ColorMask2: 2,
		_ColorMask3: 14,
		_DecalOpacity: 0.5,
		_AngleBlendFallOff: 2,
		_RoughnessMin: 0.4,
	};

	it('draws its base and PBR maps through the placement and writes what its masks allow', () => {
		const decal = ofKind(
			describeMaterial(
				material({
					keywords: ['_COMPLETE_PBR', '_NORMAL_ANGLE_BLEND'],
					slots: { _BaseColorMap: slot(1), _SampleTex1: slot(2) },
					floats,
				}),
				litDecal,
			),
			'litDecal',
		);
		assert.deepEqual([decal.base, decal.pbr, decal.opacity], [1, { texture: 2, ownTransform: null }, 0.5]);
		assert.equal(decal.angleFade, 2);
		// roughness only: `_ColorMask2` 2 is blue
		assert.deepEqual([decal.writesNormal, decal.writesRoughness, decal.relight], [false, true, false]);
	});

	it('relights without albedo, projects its water flow at world positions, and skips what changes nothing', () => {
		const placed = (overrides: Partial<MaterialValues>) =>
			describeMaterial(material({ slots: { _BaseColorMap: slot(1) }, floats, ...overrides }), litDecal);
		const relit = ofKind(
			placed({
				slots: { _BaseColorMap: slot(1), _SampleTex1: slot(2) },
				floats: { ...floats, _ColorMask3: 0 },
			}),
			'litDecal',
		);
		assert.equal(relit.relight, true);
		const water = ofKind(
			placed({
				keywords: ['_BLEND_WATER_FLOW'],
				slots: { _BaseColorMap: slot(1), _WaterNormalTex: slot(3, [0.1, 0.2]) },
				floats: {
					...floats,
					_ColorMask2: 14,
					_ColorMask3: 0,
					_WaterNormalScale: 0.4,
					_WaterRoughness: 0.13,
					_NormalFactor: 0.01,
					_AngleBlendFallOff2: 0.1,
				},
				vectors: { _UVMovement: [0.02, 0.05, 1, 1] },
			}),
			'litDecal',
		);
		// its `_ST` scale per metre
		assert.deepEqual(water.pbr, { texture: 3, ownTransform: { scale: [0.1, 0.2], offset: [0, 0] } });
		assert.deepEqual([water.writesNormal, water.writesRoughness, water.relight], [true, true, true]);
		assert.deepEqual(water.waterFlow, {
			normalScale: 0.4,
			roughness: 0.13,
			normalFactor: 0.01,
			movement: [0.02, 0.05, 1, 1],
			levelFade: 0.1,
		});
		assert.equal(placed({ keywords: ['_BLEND_SLUDGE_EROSION'] }).kind, 'unsupported');
		// writes no albedo, and has no map to change the surface with
		assert.equal(placed({ floats: { ...floats, _ColorMask3: 0 } }).kind, 'undrawn');
	});

	it('glows by its PBR map channel with _BLEND_EMISSIVE', () => {
		// Deep Dale Street's purple glow decals (dung02_rdg008)
		const emissive = ofKind(
			describeMaterial(
				material({
					blend: 'opaque',
					keywords: ['_BLEND_EMISSIVE', '_COMPLETE_PBR', '_NORMAL_ANGLE_BLEND'],
					slots: { _BaseColorMap: slot(1), _SampleTex1: slot(2) },
					floats: {
						_AffectNormal: 1,
						_AlbedoAffectEmissive: 0,
						_ColorMask2: 14,
						_ColorMask3: 14,
						_EmissiveChannel: 3,
					},
					colors: { _EmissiveColor: [1, 1, 1, 1] },
				}),
				litDecal,
			),
			'litDecal',
		);
		// `_SampleTex1`'s alpha, times the albedo, ignoring the post exposure
		assert.deepEqual(emissive.emission, {
			color: [1, 1, 1],
			channel: 3,
			albedoAffect: 0,
			ignorePostExposure: 1,
		});
	});
});

describe('VFXBaseV2', () => {
	const base = shader('HGRP/Effect/VFXBaseV2', 'vfxBase');
	const stackOf = (overrides: Partial<MaterialValues>, entry = base) =>
		describeMaterial(material({ slots: { _MainTex: slot(1) }, ...overrides }), entry);

	it('keeps each texture’s custom data shift, and lets the custom data’s w scale the distortion', () => {
		// the anchors' black smoke (`M_fx_angel_anchorlight_834`) shifts its main texture by (1, 1) per unit of x
		const stack = ofKind(
			stackOf({
				floats: { _UseParticleDisturb: 1 },
				vectors: { _MainTexUVSpeed: [0.1, 0, 1, 1] },
			}),
			'effectStack',
		);
		assert.deepEqual(stack.layers[0]?.customScroll, [1, 1]);
		assert.equal(stack.particleDisturb, true);
		// the ink-wash path has no w to scale by
		const inked = ofKind(
			stackOf({
				floats: { _UseParticleDisturb: 1, _SyncDisturbWithInkWash: 1, _RenderTransparentAfterDOF: 1 },
			}),
			'effectStack',
		);
		assert.equal(inked.particleDisturb, false);
	});

	it("takes a sample texture's role from its weights and the _ST of that role's texture", () => {
		const stack = ofKind(
			stackOf({
				keywords: ['_SAMPLE_TEX0', '_SAMPLE_TEX1', '_USE_SOFTBLEND'],
				slots: {
					_MainTex: slot(1),
					_SampleTex0: slot(2),
					_DisturbTex1: slot(2, [3, 0.5]),
					_SampleTex1: slot(4),
					_BlendTex: slot(4, [0.3, 2]),
				},
				floats: { _SampleTex0UseWeight0: 1, _SampleTex1UseWeight4: 1, _SoftDistance: 4 },
				vectors: { _SampleTex1UVRotateMat: [0, 1, -1, 0], _SampleTex1UVSpeed: [0, -0.1, 0, 0] },
			}),
			'effectStack',
		);
		assert.deepEqual(
			stack.layers.slice(0, 3).map((layer) => [layer?.texture, layer?.role, layer?.scale]),
			[
				[1, 'main', [1, 1]],
				[2, 'disturb1', [3, 0.5]],
				[4, 'blend', [0.3, 2]],
			],
		);
		assert.deepEqual(
			[stack.layers[2]?.scroll, stack.layers[2]?.rotation],
			[
				[0, -0.1],
				[0, 1],
			],
		);
		assert.deepEqual(stack.soft, { distance: 4, bias: 0 });
	});

	it('marks features the viewer lacks, additive blending and a missing main texture unsupported', () => {
		const kinds = [
			stackOf({
				keywords: ['_USE_VERTOFFSET'],
				floats: { _InParticle: 0 },
				slots: { _MainTex: slot(1, [1, 1]) },
			}),
			stackOf({ blend: 'additive' }),
			stackOf({ slots: {} }, { ...base, textures: { _MainTex: 'black' } }),
			stackOf({ keywords: ['_USE_BRIGHT'], floats: { _BrightType: 1 } }),
			stackOf({ keywords: ['_USE_BRIGHT'], vectors: { _BrightCenter: [10, 0, 5, 1] } }),
		].map((surface) => surface.kind);
		// a vertex offset without an offset texture, whose shader declares no white default
		assert.deepEqual(kinds, ['unsupported', 'unsupported', 'unsupported', 'unsupported', 'unsupported']);
	});

	it('draws water blending as without it, keeping a height within the world for the viewer to mark below', () => {
		const below = (height: number) =>
			ofKind(stackOf({ keywords: ['_USE_WATER_BLEND'], floats: { _WaterHeight: height } }), 'effectStack')
				.waterBlendBelow;
		// the Aurelyne orbs' `M_fx_coin_10_1` keeps −999, many others 0 or −9999
		assert.deepEqual([below(-9999), below(-999), below(0)], [null, -999, 0]);
		assert.equal(ofKind(stackOf({ floats: { _WaterHeight: 0 } }), 'effectStack').waterBlendBelow, null);
	});

	it('draws _USE_FORCE_DYNAMIC_LIGHTING as without it, since no variant reads it', () => {
		// the rift monsters' glow (`M_fx_monster_enemy_etthillu_lsq_01`, Marker Stone Interiors)
		const forced = stackOf({ keywords: ['_USE_FORCE_DYNAMIC_LIGHTING'] });
		assert.deepEqual(ofKind(forced, 'effectStack'), ofKind(stackOf({}), 'effectStack'));
	});

	it('pulses its alpha under _USE_ANIM_BREATHING, and not without the keyword', () => {
		// Dijiang's clue board (`M_fxmap_base01_lv001_clue_wall_2515`), added over the board
		const breathing = {
			floats: { _BlendMode: 1, _BreathingMinAlpha: 0.2, _BreathingSpeed: 5, _BreathingPower: 1 },
			blend: 'premultiplied' as const,
		};
		const pulsing = ofKind(stackOf({ ...breathing, keywords: ['_USE_ANIM_BREATHING'] }), 'effectStack');
		assert.deepEqual(pulsing.breathing, { minAlpha: 0.2, speed: 5, power: 1 });
		assert.equal(ofKind(stackOf(breathing), 'effectStack').breathing, null);
	});

	it('marks where it meets what lies behind under _USE_EDGECOLOR, its colour as stored', () => {
		// the frames of Dijiang's aisle-guide panels (`M_fxmap_base01_lv001_ship_aisle_guide_01_fj_05`)
		const edged = {
			floats: { _EdgeColorMode: 1, _EdgeDistance: 0.002, _EdgeDistanceOffset: 0.0001, _TintColorAlpha: 0.5 },
			colors: { _EdgeColor: [1.5, 1.5, 1.5, 1] satisfies [number, number, number, number] },
		};
		const surface = ofKind(stackOf({ ...edged, keywords: ['_USE_EDGECOLOR'] }), 'effectStack');
		assert.deepEqual(surface.edge, {
			color: [1.5, 1.5, 1.5, 1],
			alpha: 0.5,
			mode: 1,
			distance: 0.002,
			offset: 0.0001,
		});
		assert.equal(ofKind(stackOf(edged), 'effectStack').edge, null);
	});

	it('draws a soft body from its position texture, playing its frames on its own or holding one', () => {
		// map01's Aurelyne blob (`M_erosionmud_core`), whose HDR offsets are stored as they are
		const blob = {
			keywords: ['_USE_FOG', '_USE_WATER_BLEND', '_VAT_SOFTBODY'],
			slots: { _MainTex: slot(1), _PositionTexture: slot(2), _RotationTexture: slot(3) },
			floats: {
				_WaterHeight: -9999,
				_TextureFormat: 1,
				_B_autoPlayback: 1,
				_frameCount: 100,
				_houdiniFPS: 70,
				_playbackSpeed: 5,
				_boundMinX: -0.699999988079071,
				_boundMinY: -0.7009999752044678,
				_boundMinZ: -0.699999988079071,
				_boundMaxX: 0.699999988079071,
				_boundMaxY: 0.699999988079071,
				_boundMaxZ: 0.75,
			},
		};
		const body = ofKind(stackOf(blob), 'effectStack').softBody;
		assert.deepEqual(
			{ ...body, cycleRate: Number(body?.cycleRate.toFixed(4)) },
			{
				texture: 2,
				min: [0, 0, 0],
				range: [1, 1, 1],
				frameCount: 100,
				cycleRate: 3.5004,
				cycleStart: 0,
				fixedFrame: null,
				// ten times the bounds land on whole numbers in f32, so neither pads
				uScale: 1,
				vScale: 1,
			},
		);
		// 8-bit textures store a fraction of the bounds; `_displayFrame` is 1-based
		const held = ofKind(
			stackOf({
				...blob,
				floats: { ...blob.floats, _TextureFormat: 0, _B_autoPlayback: 0, _displayFrame: 3 },
			}),
			'effectStack',
		).softBody;
		assert.deepEqual(
			[held?.min[0], held?.range[2], held?.fixedFrame],
			[-0.699999988079071, 1.449999988079071, 2],
		);
		const kinds = [
			stackOf({ ...blob, keywords: [...blob.keywords, '_USE_FRESNEL'] }),
			stackOf({ ...blob, slots: { _MainTex: slot(1) } }),
			stackOf({ ...blob, floats: { ...blob.floats, _HoudiniVATInParticle: 1 } }),
			stackOf({ ...blob, keywords: ['_VAT_RIGIDBODY'] }),
		].map((surface) => surface.kind);
		assert.deepEqual(kinds, ['unsupported', 'unsupported', 'unsupported', 'unsupported']);
	});

	it('stays out of the fog without _USE_FOG, and starts slots from polar UVs only where computed', () => {
		assert.equal(ofKind(stackOf({}), 'effectStack').unfogged, true);
		assert.equal(ofKind(stackOf({ keywords: ['_USE_FOG'] }), 'effectStack').unfogged, false);
		const polar = ofKind(
			stackOf({
				keywords: ['_SAMPLE_TEX0', '_USE_POLARUV', '_USE_SCREENUV'],
				slots: { _MainTex: slot(1), _SampleTex0: slot(2) },
				floats: { _UsePolarUV: 1, _SampleTex0UseWeight0: 1 },
				vectors: { _SampleTex0UVWeights: [0, 0, 1, 0], _MainTexUVWeights: [0, 0, 0, 1] },
			}),
			'effectStack',
		);
		// screen UVs without `_UseScreenUV` aren't computed
		assert.deepEqual([polar.layers[0]?.source, polar.layers[1]?.source], [null, 'polar']);
	});

	it('takes screen UVs about the object’s origin under _LocalPivortSpace', () => {
		const pivot = ofKind(
			stackOf({
				keywords: ['_USE_SCREENUV'],
				floats: { _UseScreenUV: 1, _LocalPivortSpace: 1, _ScreenUVUseDepth: 0 },
				vectors: { _MainTexUVWeights: [0, 0, 0, 1] },
			}),
			'effectStack',
		);
		assert.equal(pivot.layers[0]?.source, 'screen');
		assert.deepEqual(pivot.screenUv, { localPivot: true, byDepth: false, heightAsV: false });
	});

	it('puts the sixth sample texture in the last slot, scrolled by the first sample texture', () => {
		const stack = ofKind(
			stackOf({
				keywords: ['_SAMPLE_TEX5'],
				slots: { _MainTex: slot(1), _SampleTex5: slot(2), _DissolveTex: slot(3, [2, 3]) },
				floats: { _SampleTex5UseWeight5: 1 },
				vectors: { _SampleTex0UVSpeed: [0, -1, 0, 0], _SampleTex5UVSpeed: [5, 5, 0, 0] },
			}),
			'effectStack',
		);
		const sixth = stack.layers[6];
		assert.deepEqual(
			[sixth?.texture, sixth?.role, sixth?.scale, sixth?.scroll],
			[2, 'dissolve', [2, 3], [0, -1]],
		);
	});

	it('adds under _BlendMode 1, multiplies under 2 with the multiplying blend state, and not otherwise', () => {
		const additive = { ...base, floats: { _BlendMode: 1 } };
		// the flash under the rift's ripples: `Blend DstColor Zero`
		const multiply = { blend: 'custom' as const, blendFactors: [2, 0] as [number, number] };
		const modes = [
			stackOf({}, additive),
			stackOf({ floats: { _BlendMode: 0 } }, additive),
			stackOf({ floats: { _BlendMode: 2 } }, additive),
			stackOf({ ...multiply, floats: { _BlendMode: 2 } }, additive),
			stackOf({ ...multiply, floats: { _BlendMode: 0 } }, additive),
		].map((surface) => (surface.kind === 'effectStack' ? surface.blendMode : surface.kind));
		assert.deepEqual(modes, ['add', 'over', 'unsupported', 'multiply', 'unsupported']);
	});

	it('samples a switched-on sample texture without a texture at its white default, and not another', () => {
		const masks = ['white', 'black'].map((fallback) =>
			ofKind(
				stackOf(
					{
						keywords: ['_SAMPLE_TEX0'],
						floats: { _SampleTex0UseWeight3: 1, _UseSampleTex0AsAlpha: 1, _UseMask: 1 },
					},
					{ ...base, textures: { _MainTex: 'white', _SampleTex0: fallback } },
				),
				'effectStack',
			),
		);
		assert.deepEqual(roleOf(masks[0].layers[1]), ['mask', true, 'uv0', 0]);
		assert.equal(masks[0].layers[1]?.texture, null);
		assert.equal(masks[1].layers[1], null);
		// slot 0 binds white without a main texture when that's the default
		const noMain = ofKind(
			stackOf(
				{ slots: { _SampleTex0: slot(2) }, keywords: ['_SAMPLE_TEX0'], floats: { _SampleTex0UseWeight3: 1 } },
				{ ...base, textures: { _MainTex: 'white' } },
			),
			'effectStack',
		);
		assert.equal(noMain.layers[0], null);
	});

	it('pulls towards the camera outside particle mode, with or without a vertex offset', () => {
		// Marker Stone's tower lamp stars (`M_fxmap_map_lv004_lamp_light_05`): particles left out of particle mode
		const pull = (floats: Record<string, number>) =>
			ofKind(stackOf({ keywords: ['_SAMPLE_TEX0', '_USE_SOFTBLEND'], floats }), 'effectStack').cameraPull;
		assert.deepEqual(
			[
				pull({ _InParticle: 0, _VertCameraOffset: 50 }),
				pull({ _InParticle: 0 }),
				pull({ _VertCameraOffset: 50 }),
			],
			[50, 0, null],
		);
	});

	it('draws with a vertex offset cancelled by particle mode, and moves vertices outside it', () => {
		const cancelled = ofKind(
			stackOf({
				keywords: ['_USE_BRIGHT', '_USE_VERTOFFSET'],
				floats: { _InParticle: 1, _OffsetIntensity: 0.5 },
			}),
			'effectStack',
		);
		assert.equal(cancelled.offset, null);
		const moved = ofKind(
			stackOf({
				keywords: ['_USE_VERTOFFSET'],
				slots: { _MainTex: slot(1), _OffsetTex: slot(2, [1, 0.5]) },
				floats: { _InParticle: 0, _OffsetIntensity: 0.5, _OffsetSwitchDir: 1, _OffsetUVSet: 1 },
				vectors: { _OffsetDir: [0, 1, 0, 0], _OffsetSpeed: [0, 0.2, 0, 0] },
			}),
			'effectStack',
		);
		assert.deepEqual(moved.offset, {
			texture: {
				texture: 2,
				scale: [1, 0.5],
				offset: [0, 0],
				scroll: [0, 0.2],
				rotation: [1, 0],
				customScroll: [0, 0],
			},
			uv1: true,
			direction: [0, 1, 0],
			space: 'world',
			intensity: 0.5,
			bias: 0,
			vertexAlphaWeight: 0,
			mask: null,
		});
	});

	it('masks a vertex offset from a sample slot the stack leaves free', () => {
		// the collectible pieces' glow (`M_fx_interactive_collection_2102`) masks its offset by a star texture
		// each sample texture bound as a mask, drawn only with its keyword
		const samples = [0, 1, 2, 3, 4];
		const masked = (keywords: string[] = []) =>
			stackOf({
				keywords: ['_USE_VERTOFFSET', '_USE_VERTOFFSETMASK', ...keywords],
				slots: {
					_MainTex: slot(1),
					_OffsetTex: slot(2),
					_OffsetMaskTex: slot(3, [2, 2]),
					...Object.fromEntries(samples.map((n) => [`_SampleTex${n}`, slot(10 + n)])),
				},
				floats: {
					_InParticle: 0,
					_OffsetIntensity: 12,
					_OffsetMaskPower: 3,
					...Object.fromEntries(samples.map((n) => [`_SampleTex${n}UseWeight3`, 1])),
				},
				vectors: { _OffsetMaskSpeed: [0.1, 0, 1, 1] },
			});
		const stack = ofKind(masked(), 'effectStack');
		assert.deepEqual(stack.offset?.mask, {
			texture: {
				texture: 3,
				scale: [2, 2],
				offset: [0, 0],
				scroll: [0.1, 0],
				rotation: [1, 0],
				customScroll: [0, 0],
			},
			slot: 5,
			strength: 3 * 0.2,
		});
		// a fifth sample texture takes slot 5, so the mask moves down
		assert.equal(ofKind(masked(['_SAMPLE_TEX4']), 'effectStack').offset?.mask?.slot, 4);
		assert.deepEqual(masked(samples.map((n) => `_SAMPLE_TEX${n}`)), {
			kind: 'unsupported',
			reason: 'a vertex offset mask with every sample slot taken',
		});
	});

	it('writes only the stencil when opaque with a replacing stencil, and rejects other stencil operations', () => {
		const portal = { ...base, floats: { _StencilComp: 8, _StencilOp: 2, _StencilRef: 3, _ZTest: 4 } };
		const mask = ofKind(stackOf({ blend: 'opaque' }, portal), 'stencilMask');
		assert.deepEqual(mask.stencil, {
			compare: 'always',
			replace: true,
			reference: 3,
			readMask: 255,
			writeMask: 255,
			depthCompare: 'less-equal',
		});
		assert.equal(stackOf({}, { ...base, floats: { _StencilComp: 3, _StencilOp: 1 } }).kind, 'unsupported');
		// the effects behind a portal test what its mask wrote
		const chasm = ofKind(
			stackOf({
				floats: { _StencilComp: 3, _StencilRef: 7, _StencilReadMask: 7, _StencilWriteMask: 7, _ZTest: 8 },
			}),
			'effectStack',
		);
		assert.deepEqual(chasm.stencil, {
			compare: 'equal',
			replace: false,
			reference: 7,
			readMask: 7,
			writeMask: 7,
			depthCompare: 'always',
		});
		assert.equal(ofKind(stackOf({}), 'effectStack').stencil, null);
	});

	it('draws an opaque blend state as an opaque layer, unless it reads the depth it writes', () => {
		// the falling gravel's lit rocks (`M_fx_quicksand_1104`, in `p_fxmap_common_gravel_02`)
		const opaque = (overrides: Partial<MaterialValues> = {}) =>
			stackOf({
				renderQueue: 2000,
				blend: 'opaque',
				blendFactors: null,
				zWrite: true,
				keywords: ['_USE_LIGHTING'],
				floats: { _BlendMode: 0, _UseMainTexAsAlpha: 1, _RotateNormalToWorldUp: 1 },
				...overrides,
			});
		const gravel = ofKind(opaque(), 'effectStack');
		assert.equal(gravel.opaque, true);
		assert.deepEqual(gravel.lighting, { worldUp: true });
		assert.equal(gravel.layers[0]?.redAlpha, true);
		assert.equal(ofKind(stackOf({}), 'effectStack').opaque, false);
		// `_BlendMode` 2 writes `lerp(1, colour, alpha)`, which only a multiplying blend state makes sense of
		assert.equal(opaque({ floats: { _BlendMode: 2 } }).kind, 'unsupported');
		assert.equal(opaque({ zWrite: false }).kind, 'unsupported');
		assert.deepEqual(
			opaque({ keywords: ['_USE_SOFTBLEND'], floats: { _UseSoftBlend: 1, _SoftDistance: 1 } }),
			{
				kind: 'unsupported',
				reason: 'opaque blending with a soft blend or edge colour',
			},
		);
	});
});

describe('VFXDitherAlpha effect variants', () => {
	const dither = (floats: Record<string, number>, textures: Record<string, string>) =>
		shader('HGRP/Effect/VFXDitherAlpha', 'vfxDitherAlpha', { floats, textures });

	it('draw an unlit dissolve, distortion and polar UVs as a fogged texture stack', () => {
		// the rift's ripple walls (`M_fxmap_dung02_dg005_boss_semicircle_ripple_01_1102_01`)
		const entry = dither(
			{ _MainTexUseDisturb: 1, _DissolveTexUseDisturb: 1, _UseMainTexAsAlpha: 1, _InParticle: 1 },
			{ _MainTex: 'white', _DisturbTex1: 'white', _DissolveTex: 'white' },
		);
		const ripple = ofKind(
			describeMaterial(
				material({
					blend: 'alphaTest',
					blendFactors: null,
					keywords: ['_USE_DISSOLVE', '_USE_DISTURB', '_USE_POLARUV', '_USE_SCREENUV'],
					slots: {
						_MainTex: slot(1, [2, 1]),
						_DisturbTex1: slot(2, [0.5, 10]),
						_DissolveTex: slot(3, [2, 5]),
					},
					floats: {
						_DisturbUIntensity1: 0.15,
						_DisturbVIntensity1: 0.15,
						_UsePolarUV: 1,
						_UseNearCameraFade: 1,
						_NearCameraFadeDistanceStart2: 1000,
						_NearCameraFadeDistanceEnd2: 500,
					},
					colors: { _TintColor: [0.5, 0.5, 1, 1] },
					vectors: { _DisturbUVSpeed1: [0, 0.05, 0, 0], _DissolveUVWeights: [0, 0, 1, 0] },
				}),
				entry,
			),
			'effectStack',
		);
		assert.equal(ripple.variant, 'dither');
		// the main texture's red is its alpha, and it takes all of the distortion; the dissolve starts from polar UVs
		assert.deepEqual(ripple.layers.slice(0, 3).map(roleOf), [
			['main', true, 'uv0', 1],
			['disturb1', false, 'uv0', 0],
			['dissolve', false, 'polar', 1],
		]);
		assert.deepEqual([ripple.dissolve !== null, ripple.distorted, ripple.unfogged], [true, true, false]);
		assert.deepEqual(ripple.layers[1]?.scroll, [0, 0.05]);
		assert.deepEqual(ripple.near, [0, 1, 1000, 500]);
		// lit variants aren't drawn this way
		const lit = describeMaterial(
			material({ blend: 'alphaTest', keywords: ['_USE_DISSOLVE'], floats: { _UseLighting: 1 } }),
			entry,
		);
		assert.equal(lit.kind, 'unsupported');
	});

	it('mask only the tested alpha, by the mask red, and raise the alpha to _DitherAlphaExp', () => {
		// the rift's outer ring (`M_fxmap_map_lv008_boss_semicircle_01_fj_08`)
		const entry = dither(
			{ _UseMaskTexAsAlpha: 1, _MaskTexUseDisturb: 1, _UseMainTexAsAlpha: 1, _DitherAlphaExp: 1 },
			{ _MainTex: 'white', _MaskTex: 'white', _DisturbTex1: 'white', _DissolveTex: 'white' },
		);
		const ring = (floats: Record<string, number>, keywords = ['_USE_MASK']) =>
			describeMaterial(
				material({
					blend: 'alphaTest',
					blendFactors: null,
					keywords,
					slots: { _MainTex: slot(1), _MaskTex: { ...slot(1), offset: [1, 0] } },
					floats: { _MaskTexUseDisturb: 0, _TintColorAlpha: 0.5, ...floats },
					colors: { _TintColor: [0.35, 0.32, 1, 1] },
				}),
				entry,
			);
		const masked = ofKind(ring({}), 'effectStack');
		assert.deepEqual(roleOf(masked.layers[3]), ['mask', true, 'uv0', 0]);
		assert.deepEqual([masked.layers[3]?.offset, masked.masked, masked.tint[3]], [[1, 0], true, 0.5]);
		// the stack's mask would tint by the mask's colour, which the game's colour pass doesn't
		assert.equal(ring({ _UseMaskTexAsAlpha: 0 }).kind, 'unsupported');
		const raised = ofKind(
			ring({ _DitherAlphaExp: 3 }, ['_USE_DISSOLVE', '_USE_DISTURB', '_USE_MASK']),
			'effectStack',
		);
		assert.equal(raised.alphaPower, 3);
	});

	it('multiply the colour by _MainTex2Color when _USE_MAIN2 takes the second texture as alpha', () => {
		// the red tide's walls in Wuling City (`M_fxmap_chichao_06_05`)
		const entry = dither(
			{ _UseMainTexAsAlpha: 1, _UseMainTex2AsAlpha: 0, _MainTex2BlendMode: 0 },
			{ _MainTex: 'white', _MainTex2: 'white', _DisturbTex1: 'white', _DissolveTex: 'white' },
		);
		const tide = (floats: Record<string, number>) =>
			describeMaterial(
				material({
					blend: 'alphaTest',
					blendFactors: null,
					keywords: ['_USE_DISSOLVE', '_USE_DISTURB', '_USE_MAIN2'],
					slots: { _MainTex: slot(1), _MainTex2: slot(2) },
					floats: { _UseMainTex2AsAlpha: 1, ...floats },
					colors: { _TintColor: [1, 1, 1, 1], _MainTex2Color: [1, 0, 1, 1] },
				}),
				entry,
			);
		assert.deepEqual(ofKind(tide({}), 'effectStack').tint, [1, 0, 1, 1]);
		// colouring or adding the second texture isn't drawn
		assert.equal(tide({ _UseMainTex2AsAlpha: 0 }).kind, 'unsupported');
		assert.equal(tide({ _MainTex2BlendMode: 1 }).kind, 'unsupported');
	});

	it('move their vertices by the offset texture outside particle mode, without VFXBaseV2-only terms', () => {
		// the rift's escaping trails (`M_fxmap_dung02_dg005_boss_semicircle_escapism_trail_01_1101`)
		const entry = dither(
			{ _UseMainTexAsAlpha: 1, _InParticle: 1 },
			{ _MainTex: 'white', _DisturbTex1: 'white', _DissolveTex: 'white', _OffsetTex: 'white' },
		);
		const trail = (
			floats: Record<string, number>,
			keywords = ['_USE_DISSOLVE', '_USE_DISTURB', '_USE_VERTOFFSET'],
		) =>
			describeMaterial(
				material({
					blend: 'alphaTest',
					blendFactors: null,
					keywords,
					slots: {
						_MainTex: slot(1, [2.5, 1]),
						_DisturbTex1: slot(2),
						_DissolveTex: slot(3),
						_OffsetTex: slot(4),
					},
					floats: {
						_InParticle: 0,
						_OffsetIntensity: -0.5,
						_OffsetSwitchDir: 2,
						_UseVertexColorAlphaAsVertOffsetWeight: 1,
						_VertCameraOffset: 3,
						...floats,
					},
					vectors: { _OffsetSpeed: [0.005, -0.05, 0, 0] },
				}),
				entry,
			);
		const moved = ofKind(trail({}), 'effectStack');
		assert.deepEqual(
			[
				moved.offset?.texture.texture,
				moved.offset?.texture.scroll,
				moved.offset?.space,
				moved.offset?.intensity,
			],
			[4, [0.005, -0.05], 'normal', -0.5],
		);
		assert.deepEqual(
			// VFXDitherAlpha doesn't pull towards the camera
			[moved.offset?.vertexAlphaWeight, moved.cameraPull, moved.offset?.uv1],
			[0, null, false],
		);
		assert.equal(ofKind(trail({ _InParticle: 1 }), 'effectStack').offset, null);
		// a vertex offset alone doesn't make it an effect variant, and the dithered surface doesn't draw it
		assert.deepEqual(trail({}, ['_USE_VERTOFFSET']), {
			kind: 'unsupported',
			reason: 'keywords _USE_VERTOFFSET',
		});
	});
});

describe('VFXAdvance', () => {
	const advance = shader('HGRP/Effect/VFXAdvance', 'vfxAdvance', {
		textures: { _MainTex: 'white', _MaskTex: 'white', _DisturbTex1: 'white', _DissolveTex: 'white' },
	});
	// Yinglung Pass's invisible ink bridge (`M_fx_map02_lv007_inkbridge_freelance_801`)
	const bridge = (overrides: Partial<MaterialValues> = {}) =>
		material({
			keywords: [
				'_INK_DISTORT',
				'_USE_BRIGHT',
				'_USE_DISTURB',
				'_USE_FOG',
				'_USE_FRESNEL',
				'_USE_GLOBAL_APPEAR',
				'_USE_MASK',
			],
			cull: 'none',
			slots: { _MainTex: slot(1), _MaskTex: slot(2), _DisturbTex1: slot(3) },
			floats: {
				_UseMainTexAsAlpha: 1,
				_UseMaskTexAsAlpha: 1,
				_MaskTexUseDisturb: 0.15,
				_DisturbUIntensity1: 2,
				_FresnelPower: 11,
				_FresnelBias: 0.6,
				_FresnelFlip: 1,
				_FresnelAffectOpacity: 1,
				_InnerRadius: 2,
				_OuterRadius: -4,
				_DistortAlpha: 0,
				_DistortOnEdge: 1,
				_DistortScale: 8,
				_DistortSpeed: 0.5,
				_BrightUseVertColor: 1,
				_CharacterHeight: 0.25,
				_InParticle: 0,
			},
			colors: { _TintColor: [1, 1, 1, 1], _BrightColor: [0, 0, 0, 1], _BrightCenter: [0, 0, 0, 0] },
			vectors: { _MaskTexUVSpeed: [0.215, 0, 0, 0], _DisturbUVSpeed1: [0.0025, 0.2, 0, 0] },
			...overrides,
		});

	it('draws its main texture, distortion and mask as a fogged texture stack revealed about the player', () => {
		const surface = ofKind(describeMaterial(bridge(), advance), 'effectStack');
		assert.equal(surface.variant, 'advance');
		assert.deepEqual(surface.layers.slice(0, 4).map(roleOf), [
			['main', true, 'uv0', 0],
			['disturb1', false, 'uv0', 0],
			['mask', true, 'uv0', 0.15],
			null,
		]);
		assert.deepEqual(surface.layers[1]?.scroll, [0.0025, 0.2]);
		assert.deepEqual([surface.distorted, surface.masked, surface.unfogged], [true, true, false]);
		assert.deepEqual(surface.fresnel, { power: 11, bias: 0.6, flip: 1, opacity: 1 });
		assert.deepEqual(surface.appear, {
			global: true,
			inner: 2,
			outer: -4,
			alphaFar: 0,
			edge: 1,
			noiseScale: 8,
			noiseSpeed: 0.5,
			brightColor: [0, 0, 0, 1],
			brightVertexAlpha: true,
			characterHeight: 0.25,
		});
	});

	// the ink bridge walls' torn edge (`M_fx_map02_lv007_inkbridge_freelance_wall_05`)
	it('dissolves by its dissolve texture after the distortion', () => {
		const surface = ofKind(
			describeMaterial(
				bridge({
					keywords: ['_USE_DISSOLVE', '_USE_DISTURB', '_USE_MASK'],
					slots: { _MainTex: slot(1), _MaskTex: slot(2), _DisturbTex1: slot(3), _DissolveTex: slot(4) },
					floats: {
						_TintColorIntensity: 3,
						_DissolveTexUseDisturb: 0,
						_DissolveScheduleOffset: 0.5,
						_DissolveEdgeSharp: 4,
						_DissolveEmissiveEdge: 0.1,
					},
					colors: { _TintColor: [1, 1, 1, 1], _DissolveEmissiveColor: [1, 0.5, 0, 1] },
				}),
				advance,
			),
			'effectStack',
		);
		assert.deepEqual(surface.layers.slice(0, 5).map(roleOf), [
			['main', false, 'uv0', 0],
			['disturb1', false, 'uv0', 0],
			['mask', false, 'uv0', 0],
			null,
			['dissolve', false, 'uv0', 0],
		]);
		assert.deepEqual(surface.dissolve, {
			threshold: 0,
			sharpness: 4,
			edgeWidth: 0.1,
			edgeColor: [3, 1.5, 0],
		});
	});

	// Yinglung Pass's ink room floor (`M_fx_map02_lv007_inkroom_floor_04_01`)
	it('tints by its blend layer, reads its disturb texture as a normal and reveals by its own radii', () => {
		const surface = ofKind(
			describeMaterial(
				bridge({
					keywords: ['_INK_COLOR_DISTORT', '_USE_BLEND', '_USE_BRIGHT', '_USE_DISTURB', '_USE_MASK'],
					slots: { _MainTex: slot(1), _MaskTex: slot(2), _DisturbTex1: slot(3), _BlendTex: slot(4) },
					floats: {
						_UseMaskTexAsAlpha: 1,
						_MainTexUseDisturb: 0.295,
						_BlendTexUseDisturb: 0.07,
						_DisturbTex1Normal: 1,
						_InnerRadius: 8,
						_OuterRadius: 1,
						_DistortAlpha: 0,
						_CharacterHeight: 2,
					},
					colors: { _TintColor: [1, 1, 1, 1], _BlendTint: [1.5, 1.5, 1.5, 0.2], _BrightColor: [0, 0, 0, 1] },
				}),
				advance,
			),
			'effectStack',
		);
		assert.deepEqual(surface.layers.slice(0, 5).map(roleOf), [
			['main', false, 'uv0', 0.295],
			['disturb1', false, 'uv0', 0],
			['mask', true, 'uv0', 0],
			['blend', false, 'uv0', 0.07],
			null,
		]);
		assert.deepEqual(
			[surface.blendTint, surface.blendVertexColor, surface.disturbNormal],
			[[1.5, 1.5, 1.5, 0.2], true, true],
		);
		assert.deepEqual(
			[surface.appear?.global, surface.appear?.inner, surface.appear?.outer, surface.appear?.alphaFar],
			[false, 8, 1, 0],
		);
	});

	// Si's Painting's ink road over the cave falls (`M_fxmap_map02_lv010_cave_inkroad_02_fj_01`)
	it('fades in front of what lies behind under _USE_SOFTBLEND, and not without it', () => {
		const road = (keywords: string[]) =>
			ofKind(
				describeMaterial(
					bridge({ keywords, floats: { _SoftDistance: 2, _SoftBias: 0.5, _InParticle: 0 } }),
					advance,
				),
				'effectStack',
			);
		const keywords = ['_INK_DISTORT', '_USE_DISTURB', '_USE_FOG', '_USE_MASK'];
		assert.deepEqual(road([...keywords, '_USE_SOFTBLEND']).soft, { distance: 2, bias: 0.5 });
		assert.equal(road(keywords).soft, null);
	});

	it('leaves out what it can’t draw', () => {
		const reasons = [
			bridge({ keywords: ['_USE_EDGECOLOR'] }),
			bridge({ keywords: ['_USE_GLOBAL_APPEAR'] }),
			bridge({ colors: { _BrightCenter: [1, 2, 3, 1] } }),
			bridge({ floats: { _UseInterior: 1 } }),
			bridge({ colors: { _FresnelColor: [1, 1, 1, 1] } }),
		].map((values) => describeMaterial(values, advance).kind);
		assert.deepEqual(reasons, Array(5).fill('unsupported'));
	});
});

describe('CharacterNPR_VFX', () => {
	const character = shader('HGRP/CharacterNPR_VFX', 'vfxAdvance', {
		textures: { _MainTex: 'white', _MaskTex: 'white', _BlendTex: 'white', _OffsetTex: 'white' },
	});
	// the glow over Marker Stone Interiors' rift monsters (`M_fx_monster_enemy_etthillu_01d11d12_01_04_01`)
	const glow = (overrides: Partial<MaterialValues> = {}) =>
		material({
			keywords: [
				'_USE_BLEND',
				'_USE_DISTURB',
				'_USE_FOG',
				'_USE_FRESNEL',
				'_USE_MASK',
				'_USE_SCREENUV',
				'_USE_SOFTBLEND',
				'_USE_VERTOFFSET',
			],
			cull: 'none',
			slots: { _MainTex: slot(1), _DisturbTex1: slot(2), _MaskTex: slot(3), _BlendTex: slot(4) },
			floats: {
				_InParticle: 0,
				_UseScreenUV: 1,
				_LocalPivortSpace: 1,
				_ScreenUVUseDepth: 0,
				_UseMainTexAsAlpha: 1,
				_UseMaskTexAsAlpha: 1,
				_MainTexUseDisturb: 0.75,
				_DisturbUIntensity1: 2,
				_OffsetSwitchDir: 2,
				_OffsetIntensity: 0.25,
			},
			vectors: { _MainTexUVWeights: [0, 0, 0, 1], _DisturbUVWeights1: [0, 0, 0, 1] },
			...overrides,
		});

	it('draws as VFXAdvance’s stack on screen UVs about its origin, pushed out along its normals', () => {
		const surface = ofKind(describeMaterial(glow(), character), 'effectStack');
		assert.deepEqual(surface.layers.slice(0, 5).map(roleOf), [
			['main', true, 'screen', 0.75],
			['disturb1', false, 'screen', 0],
			['mask', true, 'uv0', 0],
			['blend', false, 'uv0', 0],
			null,
		]);
		assert.equal(surface.screenUv.localPivot, true);
		// the shader defaults its offset texture to white
		assert.deepEqual([surface.offset?.space, surface.offset?.intensity], ['normal', 0.25]);
		assert.equal(surface.cameraPull, 0);
	});

	it('leaves out its dissolve and an uncapped pull towards the camera', () => {
		const reasons = [
			glow({ keywords: ['VFX_CHARACTER_DISSOLVE'] }),
			glow({ floats: { _InParticle: 0, _VertCameraOffset: 1 } }),
		].map((values) => describeMaterial(values, character).kind);
		assert.deepEqual(reasons, ['unsupported', 'unsupported']);
	});
});

describe('VFXRefract', () => {
	const refract = (overrides: Partial<ShaderEntry> = {}) =>
		shader('HGRP/Effect/VFXRefract', 'vfxRefract', {
			floats: { _RefractIsNormal: 1, _UseMaskTexAsAlpha: 1, _Intensity: 1, _RBIntensity: 1, _GOffset: -1 },
			vectors: { _RefractDir: [1, 1, 0, 0], _RBOffset: [0, 0, 0, 0] },
			...overrides,
		});

	it('offsets the scene behind by its texture, masked by its mask red, on UV0 under either switch', () => {
		// the rift's ground ripple (`M_fxmap_dung02_dg005_boss_semicircle_ripple_01_ground_1101`)
		const ground = ofKind(
			describeMaterial(
				material({
					blend: 'alphaBlend',
					blendFactors: [5, 10],
					keywords: ['_USE_MASK', '_USE_POLARUV'],
					slots: { _MaskTex: slot(1, [3, 1]), _RefractTex: slot(2, [2, 1]) },
					floats: { _Intensity: 0.5, _TintColorAlpha: 2, _RefractIsNormal: 0, _MaskTexUVRotate: 180 },
					vectors: { _RefractUVSpeed: [0, 0.1, 0, 1] },
				}),
				refract(),
			),
			'refract',
		);
		assert.deepEqual(
			[ground.refraction.texture, ground.refraction.scroll, ground.refraction.source],
			[2, [0, 0.1], 'uv0'],
		);
		assert.deepEqual(
			[ground.mask?.texture.texture, ground.mask?.texture.source, ground.mask?.redAlpha],
			[1, 'uv0', true],
		);
		// half a turn: cos −1
		assert.equal(ground.mask?.texture.rotation[0], -1);
		assert.deepEqual([ground.direction, ground.strength, ground.isNormal], [[1, 1], 1, false]);
		assert.deepEqual([ground.softDistance, ground.colorOffsets, ground.dissolve], [0, null, null]);
	});

	it('dissolves its offset by a rotated UV0 texture past the schedule threshold', () => {
		// the balloon's glitch over its "connecting" sign (`M_fx_robotemoji_821`)
		const glitch = ofKind(
			describeMaterial(
				material({
					blend: 'alphaBlend',
					blendFactors: [5, 10],
					keywords: ['_USE_DISSOLVE', '_USE_MASK', '_USE_RBOFFSET'],
					slots: { _DissolveTex: slot(3, [2, 1.2]), _MaskTex: slot(1), _RefractTex: slot(2, [1, 25]) },
					floats: { _DissolveScheduleOffset: 0.399, _DissolveEdgeSharp: 1, _DissolveUVRotate: 90 },
				}),
				refract(),
			),
			'refract',
		);
		const { dissolve } = glitch;
		assert.ok(dissolve !== null);
		assert.deepEqual([dissolve.texture.texture, dissolve.texture.scale], [3, [2, 1.2]]);
		// a quarter turn: cos 0, −sin −1
		assert.ok(Math.abs(dissolve.texture.rotation[0]) < 1e-9);
		assert.equal(dissolve.texture.rotation[1], -1);
		assert.ok(Math.abs(dissolve.threshold - (0.399 * 2.02 - 1.01)) < 1e-9);
		assert.deepEqual([dissolve.sharpness, dissolve.affectsAlpha], [1, 0]);
		const uv1 = describeMaterial(
			material({
				blend: 'alphaBlend',
				keywords: ['_USE_DISSOLVE'],
				slots: { _DissolveTex: { ...slot(3), uv: 1 }, _RefractTex: slot(2) },
			}),
			refract(),
		);
		assert.equal(uv1.kind, 'unsupported');
	});

	it('splits colours along its offset and fades in front of the scene', () => {
		// the Deep Dale Street fog walls' heat haze (`M_fxmap_map02_lv008_fogwall_01_09`)
		const masks = refract({
			colors: {
				_RBMainColorMask: [1, 0, 0, 1],
				_RBOffsetColorMask: [0, 1, 1, 1],
				_RBOffset1ColorMask: [0, 1, 0, 1],
				_RBOffset2ColorMask: [0, 0, 1, 1],
			},
		});
		const haze = (keywords: string[]) =>
			ofKind(
				describeMaterial(
					material({
						blend: 'alphaBlend',
						blendFactors: [5, 10],
						keywords,
						slots: { _MaskTex: slot(1), _RefractTex: slot(2) },
						floats: { _GOffset: -0.89, _Intensity: 0.109, _TintColorAlpha: 0.39, _SoftDistance: 2.42 },
						vectors: { _RBOffset: [0, 9.31, 0, 0] },
					}),
					masks,
				),
				'refract',
			);
		const two = haze(['_USE_MASK', '_USE_RBOFFSET', '_USE_RGBOFFSET', '_USE_SOFTBLEND']);
		const offsets = two.colorOffsets;
		assert.ok(offsets !== null);
		assert.equal(offsets.offset[0], 0);
		assert.ok(Math.abs(offsets.offset[1] - 9.31 * 0.01 * 0.109) < 1e-9);
		assert.deepEqual([offsets.secondShare, offsets.intensity], [-0.89, 1]);
		assert.deepEqual(
			[offsets.main, offsets.first, offsets.second],
			[
				[1, 0, 0],
				[0, 1, 0],
				[0, 0, 1],
			],
		);
		assert.equal(two.softDistance, 2.42);
		// one further sample: its own mask, no second
		const one = haze(['_USE_RBOFFSET']);
		assert.deepEqual(
			[one.colorOffsets?.first, one.colorOffsets?.second, one.softDistance],
			[[0, 1, 1], null, 0],
		);
	});

	it('tints by its blend layer and sweeps its cover by the spread', () => {
		// the fire column's haze at Valley Pass (`M_fx_common_smoke_01_02_03_1`)
		const haze = ofKind(
			describeMaterial(
				material({
					blend: 'alphaBlend',
					blendFactors: [5, 10],
					keywords: ['_USE_BLEND', '_USE_MASK', '_USE_RBOFFSET', '_USE_SOFTBLEND', '_USE_SPREAD'],
					slots: {
						_MaskTex: slot(1),
						_RefractTex: slot(2, [0.25, 0.5]),
						_SpreadTex: slot(3, [0.5, 0.5]),
						_BlendTex: slot(4, [0.5, 1]),
					},
					floats: {
						_BlendTexUseRefract: 1,
						_SpreadFlip: 1,
						_SpreadRange: 0.649,
						_SpreadScheduleOffset: 0.095,
						_SpreadAlphaCurve: 1,
						_SpreadUVRotate: 90,
					},
					colors: { _BlendColor: [1.498, 1.059, 1.059, 1] },
					vectors: { _BlendTexUVSpeed: [-0.1, 0.05, 1, 1], _SpreadUVSpeed: [0, 0, 1, 1] },
				}),
				refract(),
			),
			'refract',
		);
		const { blend, spread } = haze;
		assert.ok(blend !== null && spread !== null);
		assert.deepEqual(
			[
				blend.texture.texture,
				blend.texture.scroll,
				blend.texture.customScroll,
				blend.texture.source,
				blend.redAlpha,
			],
			[4, [-0.1, 0.05], [1, 1], 'uv0', false],
		);
		// HDR, as stored
		assert.deepEqual([blend.color, blend.usesRefraction], [[1.498, 1.059, 1.059, 1], 1]);
		assert.deepEqual([spread.texture.texture, spread.texture.scale], [3, [0.5, 0.5]]);
		// the spread takes no custom data
		assert.deepEqual(spread.texture.customScroll, [0, 0]);
		assert.equal(spread.texture.rotation[1], -1);
		assert.deepEqual([spread.schedule, spread.range, spread.flip, spread.alphaScale], [0.095, 0.649, 1, 1]);
	});
});

describe('VFXWater', () => {
	it('lays out a flipbook sheet: its frames as they are, motion vectors and normals, the HDR tint as stored', () => {
		// without a main texture the sheet samples the shader's white default
		const water = shader('HGRP/Effect/VFXWater', 'water', { textures: { _MainTex: 'white' } });
		const sheet = ofKind(
			describeMaterial(
				material({
					keywords: [
						'_SUBSURFACE',
						'_USE_MASK',
						'_USE_SEQUENCE_FRAME',
						'_USE_SEQUENCE_FRAME_MV',
						'_USE_SEQUENCE_FRAME_NORMAL',
						'_USE_SOFTBLEND',
					],
					slots: {
						_MaskTex: slot(2, [2, 3]),
						_SequenceBaseColorMap: slot(5, [4, 4]),
						_SequenceMotionVectorMap: slot(6),
						_SequenceNormalMap: slot(7),
					},
					floats: {
						_TintColorAlpha: 2,
						_PlaybackSpeed: 40,
						_FrameNormalScale: 0.3,
						_SoftDistance: 3,
						_Roughness: 0.6,
					},
					colors: { _TintColor: [0.5, 0.25, 2, 1] },
					vectors: { _SequenceFrameSize: [8, 4, 0, 0] },
				}),
				water,
			),
			'waterSheet',
		);
		assert.deepEqual(sheet.tint, [0.5, 0.25, 2, 2]);
		assert.equal(sheet.textures.main, null);
		assert.deepEqual([sheet.textures.mask?.texture, sheet.textures.mask?.scale], [2, [2, 3]]);
		assert.deepEqual([sheet.textures.sequence?.texture, sheet.textures.sequence?.scale], [5, [1, 1]]);
		assert.equal(sheet.textures.sequenceMotion?.texture, 6);
		assert.deepEqual(
			[
				sheet.textures.normals?.texture.texture,
				sheet.textures.normals?.flipbook,
				sheet.textures.normals?.scale,
			],
			[7, true, 0.3],
		);
		assert.deepEqual(
			[sheet.sequence.columns, sheet.sequence.rows, sheet.sequence.framesPerSecond],
			[8, 4, 40],
		);
		assert.deepEqual([sheet.mainAsAlpha, sheet.maskAsAlpha, sheet.vertexColor], [true, true, true]);
		assert.deepEqual(sheet.soft, { distance: 3, bias: 0 });
		assert.equal(describeMaterial(material({ keywords: ['VFX_WATER_REFRACT'] }), water).kind, 'unsupported');
	});
});

describe('WaterDecal', () => {
	const waterDecal = shader('HGRP/WaterDecal', 'waterDecal');

	it('draws the foam of the Wuling falls from its base, disturb and mask, as stored', () => {
		// the slab at the foot of Wuling City's falls (`M_fx_map_water_hongshan_splashes_2503`)
		const foam = ofKind(
			describeMaterial(
				material({
					keywords: ['_BLEND_BASECOLOR', '_USE_DISTURB', '_USE_MASK', '_USE_SOFTBLEND'],
					slots: { _BaseColorMap: slot(1, [1.5, 3]), _DisturbTex1: slot(2), _MaskTex: slot(3) },
					floats: {
						_BlendMode: 1,
						_UseEdgeFade: 1,
						_UseAChannelAsAlpha: 1,
						_UseMaskTexAsAlpha: 1,
						_MainTexUseDisturb: 1,
						_MaskTexUseDisturb: 1,
						_DisturbUIntensity1: 0.1,
						_DisturbVIntensity1: 0.1,
						_SoftBias: 0.6,
						_SoftDistance: 0.001,
						_ZTest: 4,
						_MeshType: 0,
					},
					colors: { _BaseColorTint: [3.394, 4.237, 4.229, 1], _BaseColor: [0, 0, 0, 0] },
					vectors: { _BaseColorSpeed: [0, -1.3, 0, 0], _DisturbUVSpeed1: [0, 0, 1.2, 0.8] },
				}),
				waterDecal,
			),
			'waterFoam',
		);
		assert.deepEqual(
			[foam.textures.base.texture, foam.textures.base.scale, foam.textures.base.scroll],
			[1, [1.5, 3], [0, -1.3]],
		);
		assert.deepEqual([foam.textures.disturb?.texture, foam.textures.disturb?.scroll], [2, [0, 0]]);
		assert.equal(foam.textures.mask?.texture, 3);
		assert.equal(foam.dissolve, null);
		assert.deepEqual(foam.tint, [3.394, 4.237, 4.229]);
		assert.deepEqual([foam.blendMode, foam.depthTest, foam.clipToBox], [1, 'less-equal', false]);
		assert.deepEqual([foam.edgeFade, foam.soft], [[0, 0], { distance: 0.001, bias: 0.6 }]);
		assert.deepEqual(foam.disturbUse, [1, 1, 0]);
	});

	it('draws the red tide’s erosion in the slots its zero distortion and unset mask leave free', () => {
		// the red tide over Wuling City's water (`M_fxmap_waterdecal_03`)
		const tide = (floats: Record<string, number>, slots: Record<string, ReturnType<typeof slot>> = {}) =>
			describeMaterial(
				material({
					keywords: ['_BLEND_BASECOLOR', '_USE_DISTURB', '_USE_MASK', '_USE_WATER_EROSION'],
					slots: {
						_BaseColorMap: slot(1, [5, 5]),
						_DisturbTex1: slot(2),
						_FlowmapTex: { ...slot(3, [15, 1.29]), offset: [-11.75, 0] },
						_FlowmapNoiseTex: slot(4, [17.35, 10]),
						_FlowGradienteTex: { ...slot(5, [300, 1]), offset: [-297.4, 0] },
						_FlowGradientNoiseTex: slot(2, [1, 1]),
						_FlowGradientNoiseTex2: slot(6),
						_FlowGradientNoiseTex3: slot(7, [2, 3]),
						...slots,
					},
					floats: {
						_DisturbUIntensity1: 0,
						_DisturbVIntensity1: 0,
						_EdgeSharp: 0.152,
						_EdgeSharp2: 0.14,
						_EdgeSharp3: 0.337,
						_FlowmapNoiseStrength: 0.02,
						_FlowmapUVNoiseStrength: 7,
						_FlowDistance: 1.01,
						_FlowOffset: 0.141,
						...floats,
					},
					colors: {
						_EdgeColor: [0.4, 0.4, 0.4, 1],
						_EdgeSharpColor: [0, 2.78, 14.75, 1],
						_EdgeSharpColor2: [36.33, 2.28, 0, 1],
						_EdgeSharpColor3: [2.43, 0.37, 0, 1],
					},
					vectors: {
						_FlowmapNoiseMovement: [-0.07, 0.001, 1, 1],
						_FlowGradientMovement: [-0.01, 0, 0.5, 20],
						_FlowGradientMovement2: [-0.1, 0, 20, 20],
						_FlowGradientMovement3: [-0.02, 0, 15, 15],
					},
				}),
				waterDecal,
			);
		const foam = ofKind(tide({}), 'waterFoam');
		assert.deepEqual([foam.textures.disturb, foam.textures.mask], [null, null]);
		assert.ok(foam.erosion !== null);
		const { erosion } = foam;
		assert.deepEqual(
			[erosion.flow.texture, erosion.flow.scale, erosion.flow.offset],
			[3, [15, 1.29], [-11.75, 0]],
		);
		assert.deepEqual([erosion.flowNoise.texture, erosion.flowNoise.scroll], [4, [-0.07, 0.001]]);
		assert.deepEqual(
			[erosion.gradient.scale, erosion.gradient.offset],
			[
				[300, 1],
				[-297.4, 0],
			],
		);
		// the noises take their scale and scroll from the movement vectors, not their `_ST`
		assert.deepEqual(
			erosion.layers.map(({ noise }) => [noise.texture, noise.scale, noise.offset, noise.scroll]),
			[
				[2, [0.5, 20], [0, 0], [-0.01, 0]],
				[6, [20, 20], [0, 0], [-0.1, 0]],
				[7, [15, 15], [0, 0], [-0.02, 0]],
			],
		);
		assert.deepEqual(
			erosion.layers.map(({ color, threshold }) => [color, threshold]),
			[
				[[0, 2.78, 14.75], 0.152],
				[[36.33, 2.28, 0], 0.14],
				[[2.43, 0.37, 0], 0.337],
			],
		);
		assert.deepEqual(
			[erosion.noiseStrength, erosion.flowShift, erosion.distance, erosion.offset, erosion.edgeColor],
			[0.02, 7, 1.01, 0.141, [0.4, 0.4, 0.4]],
		);
		// past the look's seven slots
		assert.equal(tide({ _DisturbUIntensity1: 0.1 }).kind, 'unsupported');
		assert.equal(tide({}, { _MaskTex: slot(8) }).kind, 'unsupported');
	});

	it('dissolves with its edge colour as stored, and tests behind the scene under _ZTest 5', () => {
		const foam = ofKind(
			describeMaterial(
				material({
					keywords: ['_BLEND_BASECOLOR', '_USE_DISSOLVE'],
					slots: { _BaseColorMap: slot(1), _DissolveTex: slot(4) },
					floats: { _DissolveScheduleOffset: 0.5, _DissolveEdgeSharp: 3, _ZTest: 5, _MeshType: 1 },
					colors: { _DissolveEmissiveColor: [2, 1, 0, 1] },
				}),
				waterDecal,
			),
			'waterFoam',
		);
		assert.ok(foam.dissolve !== null);
		assert.ok(Math.abs(foam.dissolve.threshold - (0.5 * 2.02 - 1.01)) < 1e-9);
		assert.deepEqual([foam.dissolve.sharpness, foam.dissolve.edgeColor], [3, [2, 1, 0]]);
		assert.deepEqual([foam.dissolve.texture.texture, foam.depthTest, foam.clipToBox], [4, 'greater', true]);
	});

	it('draws through the scene under _ZTest 8, with its mip bias', () => {
		// the bamboo raft's wake (`M_fx_interactive_bambooraft_waterdecal_802`)
		const foam = ofKind(
			describeMaterial(
				material({
					keywords: ['_BLEND_BASECOLOR', '_USE_DISSOLVE', '_USE_DISTURB', '_USE_MASK'],
					slots: { _BaseColorMap: slot(1), _DisturbTex1: slot(2), _MaskTex: slot(3), _DissolveTex: slot(4) },
					floats: { _ZTest: 8, _Bias: 2.3, _MinMipLevel: 1 },
				}),
				waterDecal,
			),
			'waterFoam',
		);
		assert.equal(foam.depthTest, 'always');
		assert.deepEqual(foam.mipBias, { base: 3, mask: 2, dissolve: 2 });
	});

	it('leaves variants without the base colour blend, or with other keywords, unsupported', () => {
		for (const keywords of [['_USE_DISTURB'], ['_BLEND_BASECOLOR', '_USE_BUBBLE']]) {
			const surface = describeMaterial(material({ keywords, slots: { _BaseColorMap: slot(1) } }), waterDecal);
			assert.equal(surface.kind, 'unsupported');
		}
	});
});

describe('VFXSmoke_SixWay', () => {
	const sixWay = shader('HGRP/Effect/VFXSmoke_SixWay', 'vfxSmokeSixWay', {
		textures: {
			_PositiveAxesLightmap: 'white',
			_NegativeAxesLightmap: 'white',
			_MaskTex: 'white',
			_BlendTex: 'black',
		},
	});
	// Valley's Aberrants' black smoke (`M_fx_damagesmoke_06`)
	const smoke = (overrides: Partial<MaterialValues> = {}) =>
		describeMaterial(
			material({
				blend: 'alphaBlend',
				blendFactors: [5, 10],
				keywords: [
					'_USE_BLEND',
					'_USE_DISSOLVE',
					'_USE_DISTURB',
					'_USE_DISTURB_TEX2',
					'_USE_FOG',
					'_USE_MASK',
					'_USE_SIXWAY_LIGHTMAP',
					'_USE_SOFTBLEND',
				],
				slots: {
					_PositiveAxesLightmap: slot(1, [3, 3]),
					_NegativeAxesLightmap: slot(2),
					_MaskTex: slot(3),
					_BlendTex: slot(4, [2, 2]),
					_DissolveTex: slot(5),
					_DisturbTex1: slot(6, [0.5, 0.5]),
					_DisturbTex2: slot(7),
				},
				floats: {
					_AbsorptionRange: 1,
					_DisturbUIntensity1: 0.11,
					_DisturbVIntensity1: 0.09,
					_DisturbUIntensity2: 0.11,
					_DisturbVIntensity2: 0.06,
					_LightMapUseDisturb: 1,
					_LightMapUVRotate: 90,
					_MaskTexUseDisturb: 1,
					_DissolveTexUseDisturb: 1,
					_TintColorAlpha: 3,
					_SoftDistance: 0.5,
					_UseNearCameraFade: 1,
				},
				colors: { _TintColor: [1, 1, 1, 1], _BlendTint: [0.678, 0.678, 0.678, 1] },
				vectors: { _LightMapControls: [1, 1, 0, 0], _DisturbUVSpeed1: [0.1, 0, 0, 0] },
				...overrides,
			}),
			sixWay,
		);

	it('takes the lightmaps’ transform from `_LightMapControls`, turned by −`_LightMapUVRotate`', () => {
		const surface = ofKind(smoke(), 'sixWaySmoke');
		assert.deepEqual([surface.positive.texture, surface.negative], [1, 2]);
		assert.deepEqual(surface.positive.scale, [1, 1]);
		assert.ok(Math.abs(surface.positive.rotation[0]) < 1e-9);
		assert.equal(surface.positive.rotation[1], -1);
		assert.equal(surface.positive.disturbShare, 1);
		assert.deepEqual(surface.disturb[0]?.intensity, [0.11, 0.09]);
		assert.deepEqual(surface.disturb[0]?.texture.scroll, [0.1, 0]);
		assert.deepEqual(surface.disturb[1]?.intensity, [0.11, 0.06]);
		assert.deepEqual(surface.blend?.scale, [2, 2]);
		assert.deepEqual(surface.blendTint, [0.678, 0.678, 0.678, 1]);
		assert.equal(surface.mask?.redAlpha, true);
		assert.deepEqual(surface.tint, [1, 1, 1, 3]);
		assert.ok(Math.abs(surface.absorptionRange - 1.934) < 1e-3);
		assert.deepEqual(surface.soft, { distance: 0.5, bias: 0 });
		assert.equal(surface.unfogged, false);
	});

	it('leaves the distortion’s second texture out without `_USE_DISTURB_TEX2`', () => {
		const keywords = ['_USE_DISTURB', '_USE_SIXWAY_LIGHTMAP'];
		const surface = ofKind(smoke({ keywords }), 'sixWaySmoke');
		assert.equal(surface.disturb[1], null);
		assert.deepEqual([surface.mask, surface.blend, surface.dissolve], [null, null, null]);
	});

	it('marks main textures, particle custom UVs and other blending unsupported', () => {
		assert.equal(smoke({ keywords: ['_USE_SIXWAY_LIGHTMAP', '_USE_MAINTEX'] }).kind, 'unsupported');
		assert.equal(smoke({ keywords: ['_USE_MASK'] }).kind, 'unsupported');
		assert.equal(smoke({ floats: { _MaskUVSet: 1 } }).kind, 'unsupported');
		assert.equal(smoke({ blend: 'premultiplied', blendFactors: [1, 10] }).kind, 'unsupported');
		// the shader has no variant with one of the two
		assert.equal(smoke({ keywords: ['_USE_SIXWAY_LIGHTMAP', '_USE_POLARUV'] }).kind, 'unsupported');
	});

	it('starts each texture from the UVs its switch picks under `_USE_POLARUV` and `_USE_SCREENUV`', () => {
		// the fire column's smoke at Valley Pass (`M_fx_lv001_207_09`): its blend layer reads the screen
		const keywords = ['_USE_BLEND', '_USE_DISSOLVE', '_USE_DISTURB', '_USE_MASK', '_USE_SIXWAY_LIGHTMAP'];
		const floats = {
			_InParticle: 1,
			_BlendSwitchUV: 1,
			_DisturbSwitchUV: 2,
			_DisturbScreenDepthUV: 1,
			_DissolveSwitchUV: 1,
			_DissolveScreenDepthUV: 1,
			_MaskSwitchUV: 3,
			_UsePosYAsScreenV: 1,
		};
		const switched = ofKind(
			smoke({ keywords: [...keywords, '_USE_POLARUV', '_USE_SCREENUV'], floats }),
			'sixWaySmoke',
		);
		assert.deepEqual(
			[switched.positive.source, switched.blend?.source, switched.mask?.texture.source],
			['uv0', 'screen', 'uv0'],
		);
		assert.deepEqual(switched.disturbSource, { source: 'polar', screenByDepth: true });
		assert.deepEqual(
			[switched.dissolve?.texture.source, switched.dissolve?.texture.screenByDepth],
			['screen', true],
		);
		assert.equal(switched.screenHeightAsV, true);
		// UV set 1 takes the dissolve's UVs over its switch
		const uvSet = ofKind(
			smoke({
				keywords: [...keywords, '_USE_POLARUV', '_USE_SCREENUV'],
				floats: { ...floats, _DissolveUVSet: 1 },
			}),
			'sixWaySmoke',
		);
		assert.equal(uvSet.dissolve?.texture.source, 'uv0');
		// without the keywords the switches are ignored
		const plain = ofKind(smoke({ keywords, floats }), 'sixWaySmoke');
		assert.deepEqual([plain.blend?.source, plain.disturbSource.source], ['uv0', 'uv0']);
	});
});
