import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReadyMaterial } from '@endfield-noclip/package-format/materials';
import type { LitDecalSurface } from '@endfield-noclip/package-format/surfaces';

import { LookFlags } from '../look.ts';
import { materialLooks } from '../material-looks.ts';

import { EffectKind, EffectRow } from './effect-look.ts';
import { DecalLitRow } from './lit-decal.ts';

/** a ready material drawing `surface` */
const described = (
	surface: ReadyMaterial['surface'],
	cull: ReadyMaterial['cull'] = 'back',
): ReadyMaterial => ({ status: 'ready', cull, surface });

test('a lit decal draws its maps through the placement or the PBR map’s own transform, and relights without albedo', () => {
	const decal: LitDecalSurface = {
		kind: 'litDecal',
		base: 1,
		opacity: 0.5,
		pbr: { texture: 2, ownTransform: null },
		relight: false,
		roughness: [0.4, 1],
		normalScale: 1,
		angleFade: 2,
		writesNormal: false,
		writesRoughness: true,
		writesMetallic: false,
		writesOcclusion: false,
		blendSceneNormal: 0,
		metallic: 0,
		occlusionStrength: 1,
		pbrBase: false,
		metallicChannel: 0,
		occlusionChannel: 0,
		affectNormal: 0,
		waterFlow: null,
		sludge: null,
		emission: { color: [1, 1, 1], channel: 3, albedoAffect: 0, ignorePostExposure: 1 },
	};
	const [look, water, sludged] = materialLooks({
		entries: [
			described(decal),
			described({
				...decal,
				relight: true,
				pbr: { texture: 3, ownTransform: { scale: [0.1, 0.2], offset: [0, 0] } },
				waterFlow: {
					normalScale: 0.4,
					roughness: 0.13,
					normalFactor: 0.01,
					movement: [0.02, 0.05, 1, 1],
					levelFade: 0.1,
				},
				emission: null,
			}),
			described({
				...decal,
				sludge: { texture: 4, scale: [2, 3], alphaScale: 3, heightFalloff: 5.75 },
				emission: null,
			}),
		],
	});
	assert.deepEqual([look.flags, look.cull, look.queue], [LookFlags.Effect, 'front', 'litDecal']);
	assert.deepEqual(look.textures.slice(0, 2), [1, 2]);
	// the placement's colour and UV transform are the row's: the look holds the opacity, and that the PBR map
	// takes the placement's transform
	assert.deepEqual([...look.params.subarray(EffectRow.tint, EffectRow.tint + 4)], [1, 1, 1, 0.5]);
	assert.equal(look.params[DecalLitRow.pbrPlaced], 1);
	assert.equal(look.params[DecalLitRow.surface + 3], 2);
	assert.deepEqual([...look.params.subarray(DecalLitRow.writes, DecalLitRow.writes + 2)], [0, 1]);
	assert.deepEqual([...look.params.subarray(DecalLitRow.emissive, DecalLitRow.emissive + 4)], [1, 1, 1, 1]);
	assert.deepEqual(
		[...look.params.subarray(DecalLitRow.emissiveMask, DecalLitRow.emissiveMask + 3)],
		[3, 0, 1],
	);
	assert.equal(look.params[EffectRow.unfogged + 1], EffectKind.LitDecal);
	assert.equal(water.queue, 'decalRelight');
	assert.equal(water.params[DecalLitRow.pbrPlaced], 0);
	assert.deepEqual(
		[...water.params.subarray(EffectRow.uv + 4, EffectRow.uv + 6)].map((v) => Math.round(v * 1000) / 1000),
		[0.1, 0.2],
	);
	assert.deepEqual(
		[...water.params.subarray(DecalLitRow.water, DecalLitRow.water + 4)].map(
			(v) => Math.round(v * 1000) / 1000,
		),
		[1, 0.4, 0.13, 0.01],
	);
	assert.equal(look.params[DecalLitRow.sludge], 0);
	// the sludge texture's slot holds its scale of the box's position
	assert.equal(sludged.textures[2], 4);
	assert.deepEqual([...sludged.params.subarray(EffectRow.uv + 8, EffectRow.uv + 10)], [2, 3]);
	assert.deepEqual([...sludged.params.subarray(DecalLitRow.sludge, DecalLitRow.sludge + 4)], [1, 3, 5.75, 0]);
});
