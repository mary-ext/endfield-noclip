import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReadyMaterial, ShaderEntry, TextureSlot } from '@endfield-noclip/package-format/materials';

import { EffectRole, EffectRow, MistRow, OFFSET_SLOT, ROLE_NONE } from './effect-looks.ts';
import { LookFlags, materialLooks } from './materials.ts';

const shader = (name: string): ShaderEntry => ({
	name,
	family: 'vfxBase',
	floats: {},
	colors: {},
	vectors: {},
	textures: {},
	normalMaps: [],
});

const slot = (texture: number, scale: [number, number] = [1, 1]): TextureSlot => ({
	texture,
	uv: 0,
	scale,
	offset: [0, 0],
});

const material = (overrides: Partial<ReadyMaterial>): ReadyMaterial => ({
	id: 0,
	status: 'ready',
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

test('a VFXDecal is a transparent, shadowless box drawn by its back faces, its disturb textures ahead of the rest', () => {
	const [look] = materialLooks({
		shaders: [shader('HGRP/Effect/VFXDecal')],
		entries: [
			material({
				keywords: ['_USE_MASK', '_USE_DISTURB', '_USE_NORMALBLEND'],
				slots: {
					_MainTex: slot(1),
					_MaskTex: slot(2),
					_DisturbTex1: slot(3),
					_DisturbTex2: slot(4),
					_BlendTex: slot(5, [2, 2]),
				},
				floats: { _TintColorAlpha: 0.5, _MaskTexUseDisturb: 1, _UseMaskTexAsAlpha: 1, _AngleBlendFallOff: 5 },
				colors: { _DecalBaseColor: [2, 0.5, 1, 0.8] },
			}),
		],
	});
	assert.equal(look.drawn, true);
	assert.equal(look.transparent, true);
	assert.equal(look.castsShadows, false);
	assert.equal(look.cull, 'front');
	assert.equal(look.flags, LookFlags.Effect | LookFlags.EffectDecal);
	// main, disturb 1; disturb 2 and blend lack their keywords
	assert.deepEqual(look.textures, [1, 3, -1, 2, -1, -1, -1]);
	const bits = [...look.params.subarray(EffectRow.slotBits, EffectRow.slotBits + 4)];
	assert.deepEqual(bits, [EffectRole.Main, EffectRole.Disturb1, ROLE_NONE, EffectRole.Mask + 8 + 16]);
	// the HDR base colour as stored, its alpha times `_TintColorAlpha`
	assert.deepEqual(
		[...look.params.subarray(EffectRow.tint, EffectRow.tint + 4)],
		[2, 0.5, 1, 0.4000000059604645],
	);
	assert.equal(look.params[EffectRow.decal + 1], 5);
});

test('a VFXBaseV2 sample texture takes its role from its weights and the _ST of that role', () => {
	const [look] = materialLooks({
		shaders: [shader('HGRP/Effect/VFXBaseV2')],
		entries: [
			material({
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
		],
	});
	assert.equal(look.flags, LookFlags.Effect);
	assert.equal(look.cull, 'back');
	assert.deepEqual(look.textures.slice(0, 3), [1, 2, 4]);
	assert.deepEqual(
		[...look.params.subarray(EffectRow.uv + 4, EffectRow.uv + 12)],
		[3, 0.5, 0, 0, 0.30000001192092896, 2, 0, 0],
	);
	assert.deepEqual(
		[...look.params.subarray(EffectRow.anim + 8, EffectRow.anim + 12)],
		[0, -0.10000000149011612, 0, 1],
	);
	assert.deepEqual(
		[...look.params.subarray(EffectRow.slotBits, EffectRow.slotBits + 3)],
		[EffectRole.Main, EffectRole.Disturb1, EffectRole.Blend],
	);
	assert.equal(look.params[EffectRow.soft], 4);
});

test('effects with features the viewer lacks, or additive blending, stay hidden', () => {
	const looks = materialLooks({
		shaders: [shader('HGRP/Effect/VFXBaseV2')],
		entries: [
			material({
				id: 0,
				keywords: ['_USE_VERTOFFSET'],
				slots: { _MainTex: slot(1) },
				floats: { _InParticle: 0 },
			}),
			material({ id: 1, blend: 'additive', slots: { _MainTex: slot(1) } }),
			material({ id: 2, slots: {} }),
			material({
				id: 3,
				keywords: ['_USE_BRIGHT'],
				slots: { _MainTex: slot(1) },
				floats: { _BrightType: 1 },
			}),
			material({
				id: 4,
				keywords: ['_USE_BRIGHT'],
				slots: { _MainTex: slot(1) },
				vectors: { _BrightCenter: [10, 0, 5, 1] },
			}),
		],
	});
	assert.deepEqual(
		looks.map((look) => look.drawn),
		[false, false, false, false, false],
	);
});

test('a VFXBaseV2 without a main texture draws with its shader default only when that is white', () => {
	const looks = materialLooks({
		shaders: [
			{ ...shader('HGRP/Effect/VFXBaseV2'), textures: { _MainTex: 'white' } },
			{ ...shader('HGRP/Effect/VFXBaseV2'), textures: { _MainTex: 'black' } },
		],
		entries: [
			material({
				id: 0,
				shader: 0,
				keywords: ['_SAMPLE_TEX0'],
				slots: { _SampleTex0: slot(2) },
				floats: { _SampleTex0UseWeight3: 1 },
			}),
			material({ id: 1, shader: 1 }),
		],
	});
	assert.deepEqual(
		looks.map((look) => look.drawn),
		[true, false],
	);
	// slot 0 binds white; the mask still applies
	assert.deepEqual(looks[0].textures.slice(0, 2), [-1, 2]);
});

test('a VFXBaseV2 draws when its vertex offset is cancelled by particle mode and its glow follows the player', () => {
	const [look] = materialLooks({
		shaders: [shader('HGRP/Effect/VFXBaseV2')],
		entries: [
			material({
				keywords: ['_USE_BRIGHT', '_USE_VERTOFFSET'],
				slots: { _MainTex: slot(1) },
				floats: { _InParticle: 1, _OffsetIntensity: 0.5 },
				colors: { _BrightColor: [0, 2.6, 2.2, 0] },
			}),
		],
	});
	assert.equal(look.drawn, true);
	assert.equal(look.flags, LookFlags.Effect);
	assert.equal(look.params[EffectRow.offsetMode], 0);
});

test('a VFXBaseV2 vertex offset outside particle mode samples its texture in the offset slot', () => {
	const [look] = materialLooks({
		shaders: [shader('HGRP/Effect/VFXBaseV2')],
		entries: [
			material({
				keywords: ['_USE_VERTOFFSET'],
				slots: { _MainTex: slot(1), _OffsetTex: slot(2, [1, 0.5]) },
				floats: { _InParticle: 0, _OffsetIntensity: 0.5, _OffsetSwitchDir: 1, _OffsetUVSet: 1 },
				vectors: { _OffsetDir: [0, 1, 0, 0], _OffsetSpeed: [0, 0.2, 0, 0] },
			}),
		],
	});
	assert.equal(look.drawn, true);
	assert.equal(look.textures[OFFSET_SLOT], 2);
	// the fragment stage skips the slot
	assert.equal(look.params[EffectRow.slotBits + OFFSET_SLOT], ROLE_NONE);
	assert.deepEqual(
		[...look.params.subarray(EffectRow.uv + OFFSET_SLOT * 4, EffectRow.uv + OFFSET_SLOT * 4 + 4)],
		[1, 0.5, 0, 0],
	);
	assert.deepEqual(
		Array.from(
			look.params.subarray(EffectRow.anim + OFFSET_SLOT * 4, EffectRow.anim + OFFSET_SLOT * 4 + 2),
			(v) => Number(v.toFixed(4)),
		),
		[0, 0.2],
	);
	assert.deepEqual([...look.params.subarray(EffectRow.offsetDir, EffectRow.offsetDir + 4)], [0, 1, 0, 1]);
	assert.equal(look.params[EffectRow.offset], 0.5);
	assert.deepEqual([...look.params.subarray(EffectRow.offsetMode, EffectRow.offsetMode + 2)], [1, 1]);
});

test('mist: additive FogSimple cards and walk-in fog boxes draw; equal fade ends become a step', () => {
	const looks = materialLooks({
		shaders: [shader('HGRP/FogSimple'), shader('HGRP/Effect/VFXFakeVolumeFog')],
		entries: [
			material({
				id: 0,
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
			}),
			material({
				id: 1,
				shader: 1,
				blend: 'additive',
				keywords: ['_USE_NOISE3D'],
				slots: { _NoiseTex3D: slot(3) },
				floats: { _canWalkIn: 1, _NearFadeDistance: 5, _FogDensity: 4 },
			}),
			material({
				id: 2,
				keywords: ['_USE_SOMETHING_ELSE'],
				slots: { _MainTex: slot(1), _NoiseTex: slot(2) },
			}),
		],
	});
	const [card, box] = looks;
	assert.equal(card.flags, LookFlags.Effect | LookFlags.EffectMist);
	assert.deepEqual(card.textures.slice(0, 2), [1, 2]);
	assert.equal(card.params[MistRow.card], 2);
	assert.equal(card.params[MistRow.indirect + 3], 1);
	assert.deepEqual(
		Array.from(card.params.subarray(MistRow.fade, MistRow.fade + 4), (v) => Number(v.toFixed(4))),
		[0.001, 0.0011, 3000, 2500],
	);
	assert.equal(card.params[MistRow.top + 2], 12);
	assert.equal(box.flags, LookFlags.Effect | LookFlags.EffectMist | LookFlags.EffectDecal);
	assert.equal(box.cull, 'front');
	assert.equal(box.params[MistRow.volume + 1], 4);
	// walk-in boxes skip the close-up fade
	assert.equal(box.params[MistRow.volume + 3], 0);
	assert.equal(looks[2].drawn, false);
});
