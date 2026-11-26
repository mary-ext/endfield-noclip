import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type ChunkLight, LightType } from '@endfield-noclip/formats/endfield/chunk-lights';
import { LightKind } from '@endfield-noclip/package-format/lights';

import type { ChunkSource } from '../../game/world/world-index.ts';

import { LightCollector, lightEntry } from './lights.ts';

const light = (patch: Partial<ChunkLight> = {}): ChunkLight => ({
	id: (2 << 27) | 1,
	levelTag: 2,
	name: 'Point Light',
	type: LightType.Point,
	position: [0, 0, 0],
	direction: [0, 0, 1],
	color: [1, 1, 1],
	intensity: 1,
	range: 10,
	spotAngle: 30,
	innerSpotAngle: 20,
	bakeType: 4,
	specularIntensity: 1,
	shadowOnly: false,
	characterOnly: false,
	tubeLength: 3,
	softSourceRadius: 0,
	falloffExponent: -1,
	volumetricScatteringIntensity: 1,
	priority: 0,
	distanceFade: null,
	cullingBox: null,
	shadows: 0,
	shadowStrength: 1,
	shadowNormalBias: 0.4,
	shadowNearPlane: 0.2,
	shadowFarPlane: 10,
	shadowCullDistance: 50,
	shadowFadeRatio: 0.8,
	shadowGuardAngle: 0,
	shadowCasterFaces: -1,
	shadowCasterProperties: 6,
	...patch,
});

/** applies a rows3x4 matrix to a point */
const apply = (m: number[], p: number[]): number[] =>
	[0, 1, 2].map((r) => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]);

test('a culling box maps its centre to 0 and its faces to ±1, rotated by Unity Euler angles', () => {
	const entry = lightEntry(
		light({
			cullingBox: { offset: [1, 2, 3], halfExtents: [2, 4, 8], rotation: [0, 90, 0], falloffThreshold: 0.8 },
		}),
		0,
	);
	const matrix = entry.cullingBox?.matrix ?? [];
	const close = (actual: number[], expected: number[]) =>
		actual.forEach((value, i) =>
			assert.ok(Math.abs(value - expected[i]) < 1e-9, `${actual.join()} ≠ ${expected.join()}`),
		);
	close(apply(matrix, [1, 2, 3]), [0, 0, 0]);
	// yaw 90° turns the box's +x to world −z and its +z to world +x
	close(apply(matrix, [1, 2, 1]), [1, 0, 0]);
	close(apply(matrix, [9, 2, 3]), [0, 0, 1]);
	close(apply(matrix, [1, 6, 3]), [0, 1, 0]);
});

test('spots keep their cone and lose the length field, which only tubes use', () => {
	const spot = lightEntry(light({ type: LightType.Spot }), 0);
	assert.equal(spot.kind, LightKind.Spot);
	assert.deepEqual([spot.spotAngle, spot.innerSpotAngle, spot.tubeLength], [30, 20, 0]);
	const point = lightEntry(light(), 0);
	assert.deepEqual([point.kind, point.spotAngle, point.tubeLength], [LightKind.Point, 0, 3]);
});

test('a light keeps its shadow only when it casts one from static scenery through a cached map', () => {
	assert.equal(lightEntry(light(), 0).shadow, null);
	// the Jingyu cherry-tree pit's key light
	const spot = lightEntry(
		light({
			type: LightType.Spot,
			shadows: 2,
			shadowNormalBias: 0.18,
			shadowFarPlane: 90,
			shadowCullDistance: 176.1,
			shadowGuardAngle: 3,
		}),
		0,
	);
	assert.deepEqual(spot.shadow, {
		strength: 1,
		normalBias: 0.18,
		nearPlane: 0.2,
		farPlane: 90,
		guardAngle: 3,
		faces: 0,
		cullDistance: 176.1,
		fadeRatio: 0.8,
	});
	// a point light casts through the faces its mask names, and a guard angle means nothing to it
	const point = lightEntry(light({ shadows: 2, shadowCasterFaces: 0b001001, shadowGuardAngle: 3 }), 0);
	assert.deepEqual([point.shadow?.faces, point.shadow?.guardAngle], [0b001001, 0]);
	assert.equal(lightEntry(light({ shadows: 2 }), 0).shadow?.faces, 0b111111);
	assert.equal(lightEntry(light({ shadows: 2, shadowCasterFaces: 0 }), 0).shadow, null);
	// a moving light's map is drawn every frame, and one that shadows only moving objects has nothing to shadow
	assert.equal(lightEntry(light({ shadows: 2, shadowCasterProperties: 7 }), 0).shadow, null);
	assert.equal(lightEntry(light({ shadows: 2, shadowCasterProperties: 4 }), 0).shadow, null);
});

test('lights carry every file holding them, for gating like instances', () => {
	const collector = new LightCollector();
	collector.add(light({ id: 1 }), { sceneState: 0, area: 0 });
	collector.add(light({ id: 1 }), { sceneState: 3, area: 0 });
	collector.add(light({ id: 2 }), { sceneState: 2, area: 0 });
	collector.add(light({ id: 2 }), { sceneState: 0, area: 7 });
	collector.add(light({ id: 3, shadowOnly: true }), { sceneState: 0, area: 0 });
	collector.add(light({ id: 4, type: LightType.Directional }), { sceneState: 0, area: 0 });
	const seen: [number, ChunkSource[]][] = [];
	const table = collector.finish(
		(levelTag, sources) => {
			seen.push([levelTag, [...sources]]);
			return seen.length;
		},
		() => assert.fail('no conditional lights'),
	);
	assert.deepEqual(
		table.lights.map((entry) => [entry.entityId, entry.group]),
		[
			[1, 1],
			[2, 2],
		],
	);
	assert.deepEqual(seen, [
		[
			2,
			[
				{ sceneState: 0, area: 0 },
				{ sceneState: 3, area: 0 },
			],
		],
		[
			2,
			[
				{ sceneState: 2, area: 0 },
				{ sceneState: 0, area: 7 },
			],
		],
	]);
	assert.deepEqual(collector.skipped, { 'shadow only': 1, 'type 1': 1 });
});

test('dynamic structure lights merge their visibilities, and chunk files win over them', () => {
	const collector = new LightCollector();
	const a = [{ control: 'progression:a', mask: 0b100 }];
	const b = [{ control: 'progression:a', mask: 0b1000 }];
	collector.add(light({ id: 1 }), { sceneState: 0, area: 0 });
	collector.addConditional(light({ id: 1 }), { alternatives: [a] });
	collector.addConditional(light({ id: 2 }), { alternatives: [a] });
	collector.addConditional(light({ id: 2 }), { alternatives: [b] });
	const table = collector.finish(
		() => 10,
		(levelTag, visibility) => {
			assert.equal(levelTag, 2);
			assert.deepEqual(visibility.alternatives, [a, b]);
			return 20;
		},
	);
	assert.deepEqual(
		table.lights.map((entry) => [entry.entityId, entry.group]),
		[
			[1, 10],
			[2, 20],
		],
	);
});
