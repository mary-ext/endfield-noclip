import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EffectTexture, WaterSheetSurface } from '@endfield-noclip/package-format/surfaces';

import { LookFlags } from '../look.ts';
import { materialLooks } from '../material-looks.ts';
import { described } from '../test-materials.ts';

import { EffectKind, EffectRow } from './effect-look.ts';
import { OFFSET_SLOT, VertexMotion } from './stack.ts';
import { WaterSheetFlags, WaterSheetRow } from './water-sheet.ts';

const texture = (id: number, overrides: Partial<EffectTexture> = {}): EffectTexture => ({
	texture: id,
	scale: [1, 1],
	offset: [0, 0],
	scroll: [0, 0],
	rotation: [1, 0],
	customScroll: [0, 0],
	...overrides,
});

/** a masked flipbook sheet with motion vectors and normals */
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
	softBody: null,
};

test('a water sheet lays out its frames, motion vectors and normals, and keeps its own rows', () => {
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
	// no vertex motion, whose switch shares the stack's row
	assert.equal(look.params[EffectRow.offsetMode], VertexMotion.None);
	assert.equal(look.params[EffectRow.soft], 3);
});

test('a soft-body sheet binds its rotation and position textures for the vertex stage alone', () => {
	// the water Qingbo's waterwheels pour (`M_fx_xiaoshuiche`), held at frame 37 of 400
	const poured: WaterSheetSurface = {
		...sheet,
		textures: { ...sheet.textures, sequence: null, sequenceMotion: null, normals: null },
		softBody: {
			texture: 8,
			min: [0, 0, 0],
			range: [1, 1, 1],
			frameCount: 400,
			cycleRate: 60 / 399.99,
			cycleStart: 0,
			fixedFrame: 37,
			uScale: 1,
			vScale: 1,
			rotation: 9,
			rotationPacked: false,
		},
	};
	const [look] = materialLooks({ entries: [described(poured)] });
	assert.deepEqual(look.textures, [null, null, 2, null, null, 9, 8]);
	assert.equal(look.params[EffectRow.offsetMode], VertexMotion.SoftBody);
	// neither is a flipbook's or a normal map's to the fragment stage
	assert.equal(
		look.params[WaterSheetRow.flags] &
			(WaterSheetFlags.Sequence | WaterSheetFlags.SequenceMotion | WaterSheetFlags.NormalMap),
		0,
	);
	assert.deepEqual(
		[...look.params.subarray(WaterSheetRow.softMin, WaterSheetRow.softMin + 4)],
		[0, 0, 0, 400],
	);
	assert.deepEqual(
		[...look.params.subarray(WaterSheetRow.softRange, WaterSheetRow.softRange + 4)],
		[1, 1, 1, 2],
	);
	// a held frame is a still phase in the middle of it
	assert.deepEqual(
		[...look.params.subarray(EffectRow.anim + OFFSET_SLOT * 4, EffectRow.anim + OFFSET_SLOT * 4 + 2)],
		[0, Math.fround(37.5 / 400)],
	);
	// the sheet's own surface rows are where the stack keeps its soft body's
	assert.ok(Math.abs(look.params[WaterSheetRow.surface] - 0.6) < 1e-6);
});
