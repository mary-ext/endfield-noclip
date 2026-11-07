import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReadyMaterial } from '@endfield-noclip/package-format/materials';
import type { EffectTexture, WaterSheetSurface } from '@endfield-noclip/package-format/surfaces';

import { LookFlags } from '../look.ts';
import { materialLooks } from '../material-looks.ts';

import { EffectKind, EffectRow } from './effect-look.ts';
import { WaterSheetFlags, WaterSheetRow } from './water-sheet.ts';

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

test('a water sheet lays out its frames, motion vectors and normals, and keeps its own rows', () => {
	const sheet: WaterSheetSurface = {
		kind: 'waterSheet',
		tint: [0.5, 0.25, 2, 2],
		textures: {
			main: null,
			disturb: null,
			mask: texture(2, { scale: [2, 3] }),
			sequence: texture(5),
			sequenceMotion: texture(6),
			normals: { texture: texture(7), flipbook: true, scale: 0.3 },
		},
		disturbNormal: false,
		mainAsAlpha: true,
		maskAsAlpha: true,
		vertexOpacity: false,
		fresnelOpacity: false,
		vertexColor: true,
		additive: false,
		useLighting: 1,
		randomUv: 0,
		disturbBias: 0,
		disturb: [0, 0],
		disturbUse: [0, 0, 0, 0],
		dissolve: null,
		sequence: {
			columns: 8,
			rows: 4,
			framesPerSecond: 40,
			randomStartByPosition: 0,
			motionStrength: 0,
			opacityScale: 1,
			opacityThreshold: 0,
			colorThreshold: 0,
			tint: [1, 1, 1],
		},
		roughness: 0.6,
		specular: 1,
		directSpecular: 1,
		fresnel: 0,
		subsurface: [1, 1, 1, 1],
		indirectSaturation: 1,
		soft: { distance: 3, bias: 0 },
		ignorePostExposure: 1,
		near: null,
	};
	const [look] = materialLooks({ entries: [described(sheet)] });
	assert.equal(look.flags, LookFlags.Effect);
	// main (white default), mask, flipbook colour and motion, normals in slot 6
	assert.deepEqual(look.textures, [null, null, 2, null, 5, 6, 7]);
	assert.deepEqual([...look.params.subarray(EffectRow.tint, EffectRow.tint + 4)], [0.5, 0.25, 2, 2]);
	assert.equal(
		look.params[WaterSheetRow.flags],
		WaterSheetFlags.Mask |
			WaterSheetFlags.Sequence |
			WaterSheetFlags.SequenceMotion |
			WaterSheetFlags.SequenceNormal |
			WaterSheetFlags.MainAsAlpha |
			WaterSheetFlags.MaskAsAlpha |
			WaterSheetFlags.VertexColor,
	);
	assert.deepEqual([...look.params.subarray(WaterSheetRow.sequence, WaterSheetRow.sequence + 3)], [8, 4, 40]);
	assert.ok(Math.abs(look.params[WaterSheetRow.sequenceTint + 3] - 0.3) < 1e-6);
	assert.equal(look.params[EffectRow.unfogged + 1], EffectKind.WaterSheet);
	// the vertex offset stays off, since its switch shares the last rows
	assert.equal(look.params[EffectRow.offsetMode], 0);
	assert.equal(look.params[EffectRow.soft], 3);
});
