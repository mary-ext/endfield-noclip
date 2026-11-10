import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type LightEntry, LightKind, type LightShadow } from '@endfield-noclip/package-format/lights';

import {
	SHADOW_RECORD_VEC4S,
	type ShadowCandidate,
	type ShadowFrame,
	ShadowTiles,
	slotLevel,
	slotRect,
} from './shadow-tiles.ts';

const shadow = (patch: Partial<LightShadow> = {}): LightShadow => ({
	strength: 1,
	normalBias: 0.4,
	nearPlane: 0.2,
	farPlane: 50,
	guardAngle: 0,
	faces: 0,
	cullDistance: 100,
	fadeRatio: 0.8,
	...patch,
});

const light = (patch: Partial<LightEntry> = {}): LightEntry => ({
	kind: LightKind.Spot,
	entityId: 1,
	group: 0,
	position: [0, 10, 0],
	direction: [0, -1, 0],
	color: [1, 1, 1],
	range: 50,
	spotAngle: 90,
	innerSpotAngle: 30,
	tubeLength: 0,
	softSourceRadius: 0,
	falloffExponent: 2,
	specularIntensity: 1,
	volumetricScatteringIntensity: 1,
	priority: 0,
	distanceFade: null,
	cullingBox: null,
	shadow: shadow(),
	...patch,
});

/** a light as a frame draws it from an eye at the origin */
const candidate = (entry: LightEntry): ShadowCandidate => {
	const rel = entry.position;
	return { entry, rel, distance2: rel[0] ** 2 + rel[1] ** 2 + rel[2] ** 2 };
};

const frame = (patch: Partial<ShadowFrame> = {}): ShadowFrame => ({
	enabled: true,
	compiling: false,
	contentVersion: 1,
	streamIdle: true,
	...patch,
});

test('the atlas holds twelve tiles a level, each level in the last quadrant of the one before', () => {
	assert.deepEqual(slotRect(0), { x: 0, y: 0, size: 1024 });
	assert.deepEqual(slotRect(11), { x: 1024, y: 3072, size: 1024 });
	assert.deepEqual(slotRect(12), { x: 2048, y: 2048, size: 512 });
	assert.deepEqual(slotRect(24), { x: 3072, y: 3072, size: 256 });
	// the last level also takes the quadrant the others leave for the next
	assert.deepEqual(slotRect(39), { x: 3840, y: 3840, size: 256 });
	assert.deepEqual(
		[slotLevel(11), slotLevel(12), slotLevel(23), slotLevel(24), slotLevel(39)],
		[0, 1, 1, 2, 2],
	);
	const rects = Array.from({ length: 40 }, (_, slot) => slotRect(slot));
	for (const [i, a] of rects.entries()) {
		assert.ok(a.x + a.size <= 4096 && a.y + a.size <= 4096);
		for (const b of rects.slice(i + 1)) {
			const apart = a.x + a.size <= b.x || b.x + b.size <= a.x || a.y + a.size <= b.y || b.y + b.size <= a.y;
			assert.ok(apart, 'tiles overlap');
		}
	}
});

test('a tile is drawn at once with what the view holds, then again once its casters were asked for', () => {
	const tiles = new ShadowTiles();
	const selected = [candidate(light())];
	tiles.update(selected, frame());
	assert.deepEqual([tiles.request?.x, tiles.request?.y, tiles.request?.size], [0, 0, 1024]);
	assert.equal(tiles.pending, true);
	// the next selection is asked for the light's casters: a sphere around its cone
	const spheres = tiles.casterSpheres();
	assert.deepEqual(
		Array.from(spheres, (value) => Math.round(value * 1e6) / 1e6),
		[0, -40, 0, 50],
	);
	tiles.update(selected, frame());
	assert.notEqual(tiles.request, null);
	// drawn with them and the stream idle, it's settled: nothing more to draw or ask for
	tiles.update(selected, frame());
	assert.equal(tiles.request, null);
	assert.equal(tiles.pending, false);
	assert.equal(tiles.casterSpheres().length, 0);
});

test('a tile waits out a busy stream and is drawn again as content arrives', () => {
	const tiles = new ShadowTiles();
	const selected = [candidate(light())];
	tiles.update(selected, frame({ streamIdle: false }));
	tiles.casterSpheres();
	tiles.update(selected, frame({ streamIdle: false }));
	assert.equal(tiles.request, null);
	assert.equal(tiles.pending, true);
	tiles.update(selected, frame({ streamIdle: false, contentVersion: 2 }));
	assert.notEqual(tiles.request, null);
	// pipelines still compiling would leave casters out
	tiles.update(selected, frame({ contentVersion: 3, compiling: true }));
	assert.equal(tiles.request, null);
	assert.equal(tiles.pending, true);
});

test('casters rank nearest first: twelve tiles a level, none past the fortieth or the cull distance', () => {
	const tiles = new ShadowTiles();
	const lights = Array.from({ length: 45 }, (_, i) => light({ entityId: i, position: [0, 10 + i, 0] }));
	const selected = lights.map(candidate);
	const drawn: number[] = [];
	for (let i = 0; i < 45; i++) {
		tiles.update(selected, frame({ streamIdle: false }));
		if (tiles.request !== null) {
			drawn.push(tiles.request.size);
		}
	}
	assert.deepEqual(
		[drawn.filter((size) => size === 1024).length, drawn.filter((size) => size === 512).length, drawn.length],
		[12, 12, 40],
	);
	const out = new Float32Array(SHADOW_RECORD_VEC4S * 4);
	assert.equal(tiles.writeRecords(out, 0, selected[39]), 1);
	assert.equal(tiles.writeRecords(out, 0, selected[40]), 0);

	// 200 m cuts every light's shadow off, whatever its own cull distance
	const far = new ShadowTiles();
	const distant = [
		candidate(light({ position: [0, 150, 0] })),
		candidate(light({ position: [0, 250, 0], shadow: shadow({ cullDistance: 1000 }) })),
		candidate(light({ position: [0, 20, 0], shadow: null })),
	];
	far.update(distant, frame());
	assert.equal(far.request, null);
	assert.equal(far.pending, false);
});

test("a record maps the light's axis to the tile's centre, and depth to 0 at the near plane and 1 at the far", () => {
	const tiles = new ShadowTiles();
	const entry = light();
	const selected = [candidate(entry)];
	tiles.update(selected, frame());
	const out = new Float32Array(SHADOW_RECORD_VEC4S * 4);
	assert.equal(tiles.writeRecords(out, 0, selected[0]), 1);
	const project = (p: number[]): number[] => {
		const clip = [0, 1, 2, 3].map((r) => out[r] * p[0] + out[4 + r] * p[1] + out[8 + r] * p[2] + out[12 + r]);
		return [clip[0] / clip[3], clip[1] / clip[3], clip[2] / clip[3], clip[3]];
	};
	const close = (actual: number[], expected: number[]) =>
		actual.forEach((value, i) =>
			assert.ok(Math.abs(value - expected[i]) < 1e-4, `${actual.join()} ≠ ${expected.join()}`),
		);
	// the light points down from 10 m up: the ground under it is 10 m along its axis
	close(project([0, 0, 0]), [0.5, 0.5, (50 / 49.8) * (1 - 0.2 / 10), 10]);
	close(project([0, 10 - 0.2, 0]).slice(2), [0, 0.2]);
	close(project([0, 10 - 50, 0]).slice(2), [1, 50]);
	// a 90° cone reaches the tile's edge one metre out per metre down
	const edge = project([10, 0, 0]);
	assert.ok(Math.abs(edge[0] - 0.5) < 1e-4 || Math.abs(Math.abs(edge[0] - 0.5) - 0.5) < 1e-4);
	assert.ok(Math.abs(Math.abs(edge[0] - 0.5) + Math.abs(edge[1] - 0.5) - 0.5) < 1e-4);
	// the rect, then a texel at 1 m, the game's normal offset, the far plane and the drawn flag
	close(Array.from(out.subarray(16, 24)), [0, 0, 0.25, 0.25, 2 / 1024, (2 / 1024) * 0.4 * 7.5, 50, 1]);

	// a point light writes its six faces in order, the ones it doesn't cast through left empty
	const point = light({ kind: LightKind.Point, spotAngle: 0, shadow: shadow({ faces: 0b001001 }) });
	const points = [candidate(point)];
	const cube = new ShadowTiles();
	cube.update(points, frame({ streamIdle: false }));
	cube.update(points, frame({ streamIdle: false }));
	const records = new Float32Array(6 * SHADOW_RECORD_VEC4S * 4);
	assert.equal(cube.writeRecords(records, 0, points[0]), 6);
	assert.deepEqual(
		Array.from({ length: 6 }, (_, face) => records[face * SHADOW_RECORD_VEC4S * 4 + 23]),
		[1, 0, 0, 1, 0, 0],
	);
});

test("a shadow fades out over the last of its cull distance, and goes with the sun's shadow passes", () => {
	const tiles = new ShadowTiles();
	const entry = light({ shadow: shadow({ strength: 0.5, cullDistance: 100, fadeRatio: 0.8 }) });
	assert.equal(tiles.strength(entry, 50 ** 2), 0.5);
	assert.ok(Math.abs(tiles.strength(entry, 90 ** 2) - 0.25) < 1e-9);
	assert.equal(tiles.strength(entry, 120 ** 2), 0);
	assert.equal(tiles.strength(light({ shadow: null }), 1), 0);

	const selected = [candidate(entry)];
	tiles.update(selected, frame());
	const out = new Float32Array(SHADOW_RECORD_VEC4S * 4);
	assert.equal(tiles.writeRecords(out, 0, selected[0]), 1);
	tiles.update(selected, frame({ enabled: false }));
	assert.equal(tiles.request, null);
	assert.equal(tiles.pending, false);
	assert.equal(tiles.writeRecords(out, 0, selected[0]), 0);
});
