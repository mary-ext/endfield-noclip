import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type ChunkLight, LightType } from '@endfield-noclip/formats/endfield/chunk-lights';
import { LightKind } from '@endfield-noclip/package-format/format';

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
		null,
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
	const spot = lightEntry(light({ type: LightType.Spot }), null);
	assert.equal(spot.kind, LightKind.Spot);
	assert.deepEqual([spot.spotAngle, spot.innerSpotAngle, spot.tubeLength], [30, 20, 0]);
	const point = lightEntry(light(), null);
	assert.deepEqual([point.kind, point.spotAngle, point.tubeLength], [LightKind.Point, 0, 3]);
});

test('lights load unconditionally from always-loaded files and with their scene states otherwise', () => {
	const collector = new LightCollector();
	collector.add(light({ id: 1 }), 0);
	collector.add(light({ id: 1 }), 3);
	collector.add(light({ id: 2 }), 2);
	collector.add(light({ id: 2 }), 5);
	collector.add(light({ id: 3, shadowOnly: true }), 0);
	collector.add(light({ id: 4, type: LightType.Directional }), 0);
	const seen: number[][] = [];
	const table = collector.finish((states) => {
		seen.push(states);
		return 7;
	});
	assert.deepEqual(
		table.lights.map((entry) => [entry.id, entry.condition]),
		[
			[1, null],
			[2, 7],
		],
	);
	// MapConfig indices are the files' suffixes minus one
	assert.deepEqual(seen, [[1, 4]]);
	assert.deepEqual(collector.skipped, { 'shadow only': 1, 'type 1': 1 });
});
