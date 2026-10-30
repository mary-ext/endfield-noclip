import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReadyMaterial, ShaderEntry, TextureSlot } from '@endfield-noclip/package-format/materials';

import { EffectRole, EffectRow, ROLE_NONE } from './effect-looks.ts';
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
			material({ id: 0, keywords: ['_USE_VERTOFFSET'], slots: { _MainTex: slot(1) } }),
			material({ id: 1, blend: 'additive', slots: { _MainTex: slot(1) } }),
			material({ id: 2, slots: {} }),
		],
	});
	assert.deepEqual(
		looks.map((look) => look.drawn),
		[false, false, false],
	);
});
