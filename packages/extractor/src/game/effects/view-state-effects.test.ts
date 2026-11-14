import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PPtr } from '@endfield-noclip/formats/unity/values';

import type { AssetResolver, ObjectRef } from '../assets/assets.ts';

import { effectDistanceLod, effectProxyBands, intersectRanges } from './view-state-effects.ts';

/** a resolver whose objects are only their path ids, keyed `CAB-test:<id>` */
const resolver = {
	resolve: async (_: ObjectRef, pptr: PPtr) => ({
		file: { node: { path: 'CAB-test' } },
		info: { pathId: pptr.pathId },
	}),
} as unknown as AssetResolver;
const setting = {} as ObjectRef;

const entry = (pathId: number, active: number[]) => ({
	gameobject: { m_FileID: 0, m_PathID: BigInt(pathId) },
	_distanceLodInfos: active.map((isActive) => ({ speedPercent: 1, isActive })),
});

// the collectible marker's table (int_collection_common_postmodel): bands from 0, 30 and 60 m, culled past 80 m
const marker = {
	m_Enabled: 1,
	isUseDistanceLod: 1,
	_isCullDisable: 1,
	cullDis: 80,
	distanceLodCfgList: [0, 30, 60].map((distance) => ({ distance, framePercent: 1 })),
	lodSetting: [
		entry(1, [1, 1, 1]),
		entry(2, [1, 0, 0]),
		entry(3, [1, 1, 0]),
		entry(4, [0, 1, 1]),
		entry(5, [1, 0, 1]),
	],
};

test('effect distance bands turn into the camera distances each GameObject shows at', async () => {
	const lod = await effectDistanceLod(resolver, setting, marker);
	assert.notEqual(lod, null);
	assert.deepEqual(lod?.self, [{ near: 0, far: 80 }]);
	assert.deepEqual(Object.fromEntries(lod?.nodes ?? []), {
		'CAB-test:1': [{ near: 0, far: Infinity }],
		'CAB-test:2': [{ near: 0, far: 30 }],
		'CAB-test:3': [{ near: 0, far: 60 }],
		'CAB-test:4': [{ near: 30, far: Infinity }],
		'CAB-test:5': [
			{ near: 0, far: 30 },
			{ near: 60, far: Infinity },
		],
	});
	// the cull distance applies to the whole effect
	assert.deepEqual(intersectRanges(lod?.self ?? [], lod?.nodes.get('CAB-test:5') ?? []), [
		{ near: 0, far: 30 },
		{ near: 60, far: 80 },
	]);
});

test('a LOD proxy picks the band by its level, with no cull distance', async () => {
	// as the dynamic scene drives it: whether the setting switches by distance doesn't matter
	const levels = await effectProxyBands(resolver, setting, { ...marker, isUseDistanceLod: 0 });
	assert.deepEqual(Object.fromEntries(levels ?? []), {
		'CAB-test:1': 0b111,
		'CAB-test:2': 0b001,
		'CAB-test:3': 0b011,
		'CAB-test:4': 0b110,
		'CAB-test:5': 0b101,
	});
	// with two bands, the level past them keeps the last
	const two = await effectProxyBands(resolver, setting, {
		...marker,
		distanceLodCfgList: marker.distanceLodCfgList.slice(0, 2),
	});
	assert.equal(two?.get('CAB-test:4'), 0b110);
	assert.equal(two?.get('CAB-test:5'), 0b001);
	assert.equal(await effectProxyBands(resolver, setting, { ...marker, distanceLodCfgList: [] }), null);
});

test("an effect that doesn't switch by distance, or keeps itself on past its cull distance, says so", async () => {
	assert.equal(await effectDistanceLod(resolver, setting, { ...marker, isUseDistanceLod: 0 }), null);
	const kept = await effectDistanceLod(resolver, setting, { ...marker, _isCullDisable: 0 });
	assert.deepEqual(kept?.self, [{ near: 0, far: Infinity }]);
});
