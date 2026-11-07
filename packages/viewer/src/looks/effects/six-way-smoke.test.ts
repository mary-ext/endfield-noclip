import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
	EffectTexture,
	SixWaySmokeSurface,
	SixWayUvSource,
} from '@endfield-noclip/package-format/surfaces';

import { EffectKind, EffectRow, ROLE_NONE, SlotSource } from './effect-look.ts';
import { SIX_WAY_SCREEN_DEPTH, SixWayFlags, SixWayRow, sixWaySmokeLook } from './six-way-smoke.ts';

const UV0: SixWayUvSource = { source: 'uv0', screenDepth: false };

const texture = (id: number, overrides: Partial<EffectTexture> = {}): EffectTexture => ({
	texture: id,
	scale: [1, 1],
	offset: [0, 0],
	scroll: [0, 0],
	rotation: [1, 0],
	customScroll: [0, 0],
	...overrides,
});

test('six-way smoke samples its negative lightmap at the positive one’s UVs, and packs its stack', () => {
	const smoke: SixWaySmokeSurface = {
		kind: 'sixWaySmoke',
		positive: { ...texture(1, { scale: [2, 2], rotation: [0, -1] }), ...UV0, disturbShare: 1 },
		negative: 2,
		disturb: [{ texture: texture(3), intensity: [0.11, 0.09], normal: false }, null],
		disturbSource: UV0,
		disturbBias: 0,
		screenVFromHeight: false,
		mask: { texture: { ...texture(4), ...UV0, disturbShare: 0.5 }, redAlpha: true },
		blend: null,
		blendTint: [0.5, 0.5, 0.5, 1],
		dissolve: null,
		tint: [1, 1, 1, 3],
		vertexColor: true,
		brighten: { threshold: 1, intensity: 0 },
		absorptionRange: 1.934,
		envSaturation: 1,
		soft: { distance: 0.5, bias: 0 },
		near: { on: false, range: [0, 1, 1e5, 2e5] },
		unfogged: false,
	};
	const look = sixWaySmokeLook(smoke);
	const { params } = look;
	assert.deepEqual(look.textures, [1, 3, -1, 4, -1, -1, 2]);
	assert.deepEqual(
		[...params.subarray(EffectRow.uv + 24, EffectRow.uv + 28)],
		[...params.subarray(EffectRow.uv, EffectRow.uv + 4)],
	);
	assert.equal(
		params[SixWayRow.flags],
		SixWayFlags.Disturb1 | SixWayFlags.Mask | SixWayFlags.MaskRedAlpha | SixWayFlags.VertexColor,
	);
	assert.ok(Math.abs(params[SixWayRow.flags + 2] - 1.934) < 1e-6);
	assert.deepEqual([...params.subarray(SixWayRow.disturbUse, SixWayRow.disturbUse + 2)], [1, 0.5]);
	assert.ok(Math.abs(params[SixWayRow.disturb + 1] - 0.09) < 1e-6);
	assert.equal(params[EffectRow.unfogged + 1], EffectKind.SixWaySmoke);
	assert.equal(params[EffectRow.tint + 3], 3);
	assert.deepEqual(
		[...params.subarray(EffectRow.slotBits, EffectRow.slotBits + 7)],
		[ROLE_NONE, ROLE_NONE, ROLE_NONE, ROLE_NONE, ROLE_NONE, ROLE_NONE, ROLE_NONE],
	);
});

test('six-way smoke starts each slot from its switched UVs, scaling screen UVs by depth only where asked', () => {
	// M_fx_lv001_207_09 (p_fxmap_smoke_range_f_smoke_02, Valley Pass) switches its blend layer to the screen
	const smoke: SixWaySmokeSurface = {
		kind: 'sixWaySmoke',
		positive: { ...texture(1), ...UV0, disturbShare: 1 },
		negative: 2,
		disturb: [{ texture: texture(3), intensity: [-0.03, 0], normal: false }, null],
		disturbSource: { source: 'polar', screenDepth: true },
		disturbBias: 0,
		screenVFromHeight: true,
		mask: null,
		blend: { ...texture(5), source: 'screen', screenDepth: false, disturbShare: 1 },
		blendTint: [1.84, 0.25, 0.12, 1],
		dissolve: {
			texture: { ...texture(6), source: 'screen', screenDepth: true, disturbShare: 1 },
			dissolve: { on: true, threshold: -1.01, sharpness: 0.25, edgeWidth: 0, edgeColor: [0, 0, 0] },
		},
		tint: [1, 1, 1, 2.3],
		vertexColor: true,
		brighten: { threshold: 1, intensity: 0 },
		absorptionRange: 0.47,
		envSaturation: 2.2,
		soft: null,
		near: { on: true, range: [0.5, 10, 400, 100] },
		unfogged: false,
	};
	const { params } = sixWaySmokeLook(smoke);
	assert.deepEqual(
		[...params.subarray(EffectRow.slotBits, EffectRow.slotBits + 7)],
		[
			ROLE_NONE,
			// polar UVs never scale by depth
			ROLE_NONE + SlotSource.Polar * 32,
			ROLE_NONE,
			ROLE_NONE,
			ROLE_NONE + SlotSource.Screen * 32,
			ROLE_NONE + SlotSource.Screen * 32 + SIX_WAY_SCREEN_DEPTH,
			ROLE_NONE,
		],
	);
	// v from the world height, without the stack's own depth scaling
	assert.equal(params[EffectRow.unfogged + 3], 2);
});
