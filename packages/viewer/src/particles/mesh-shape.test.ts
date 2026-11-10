import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	ParticleMeshPlacement,
	ParticleMeshSpawn,
	type ParticleShapeMeshInfo,
} from '@endfield-noclip/package-format/particles';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { meshShapePoint, prepareMeshShape } from './mesh-shape.ts';

/** a 2×1 triangle (area 1) and a 1×1 one (area ½) side by side, normals up +z */
const mesh = (overrides: Partial<ParticleShapeMeshInfo> = {}): ParticleShapeMeshInfo => ({
	placement: ParticleMeshPlacement.Triangle,
	spawn: ParticleMeshSpawn.Random,
	spread: 0,
	normalOffset: 0,
	positions: [0, 0, 0, 2, 0, 0, 0, 1, 0, 3, 0, 0, 4, 0, 0, 3, 1, 0],
	normals: [0, 0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 2],
	colors: null,
	corners: 3,
	primitives: [0, 1, 2, 3, 4, 5],
	...overrides,
});

const point = (
	info: ParticleShapeMeshInfo,
	randoms: [number, number, number],
	ordinal: number | null = null,
) => {
	const position: Vec3 = [0, 0, 0];
	const direction: Vec3 = [0, 0, 0];
	const tint: [number, number, number, number] = [0, 0, 0, 0];
	meshShapePoint(prepareMeshShape(info), randoms, ordinal, position, direction, tint);
	return { position, direction, tint };
};

describe('meshShapePoint', () => {
	it('picks triangles by area and points evenly within them', () => {
		// the first triangle holds two thirds of the area
		assert.ok(point(mesh(), [0.6, 0.1, 0.1]).position[0] < 2);
		assert.ok(point(mesh(), [0.7, 0.1, 0.1]).position[0] >= 3);
		// barycentrics past the far edge fold back inside
		const { position, direction } = point(mesh(), [0, 0.9, 0.8]);
		// weights (0.1, 0.2, 0.7) on (0, 0), (2, 0) and (0, 1)
		assert.ok(Math.abs(position[0] - 0.4) < 1e-9 && Math.abs(position[1] - 0.7) < 1e-9);
		assert.deepEqual(direction, [0, 0, 1]);
	});

	it('walks a triangle outline in thirds whatever the sides are long', () => {
		const edge = mesh({ placement: ParticleMeshPlacement.Edge });
		// one sixth of the first triangle's share: half of its first side
		const half = point(edge, [(2 / 3) * (1 / 6), 0, 0]).position;
		assert.ok(Math.abs(half[0] - 1) < 1e-9 && Math.abs(half[1]) < 1e-9);
		// the second third runs from the second corner to the third
		const middle = point(edge, [(2 / 3) * 0.5, 0, 0]).position;
		assert.ok(Math.abs(middle[0] - 1) < 1e-9 && Math.abs(middle[1] - 0.5) < 1e-9);
		// spread snaps the place down to its steps
		const stepped = point({ ...edge, spread: 0.25 }, [(2 / 3) * 0.2, 0, 0]).position;
		assert.deepEqual(stepped, [0, 0, 0]);
	});

	it('picks vertices through a random primitive, or steps through the vertex buffer', () => {
		const vertex = mesh({ placement: ParticleMeshPlacement.Vertex });
		// primitives are picked evenly, not by area
		assert.deepEqual(point(vertex, [0.6, 0.5, 0]).position, [4, 0, 0]);
		const loop = { ...vertex, spawn: ParticleMeshSpawn.Loop };
		assert.deepEqual(point(loop, [0, 0, 0], 7).position, [2, 0, 0]);
		const pingPong = { ...vertex, spawn: ParticleMeshSpawn.PingPong };
		// 0 1 2 3 4 5 5 4 3 …
		assert.deepEqual(point(pingPong, [0, 0, 0], 7).position, [4, 0, 0]);
		// without an emission number (bursts the simulation doesn't number), they pick at random
		assert.deepEqual(point(loop, [0.6, 0.5, 0], null).position, [4, 0, 0]);
	});

	it('leaves along the normal, offset by it before normalizing, tinted by the vertex colours', () => {
		const colors = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		const { position, direction, tint } = point(
			mesh({ placement: ParticleMeshPlacement.Vertex, normalOffset: 0.5, colors }),
			[0, 0, 0],
		);
		assert.deepEqual(position, [0, 0, 1]);
		assert.deepEqual(direction, [0, 0, 1]);
		assert.deepEqual(tint, [1, 0, 0, 1]);
		// without normals, +z
		const bare = point(mesh({ normals: null, normalOffset: 1 }), [0, 0, 0]);
		assert.deepEqual(bare.direction, [0, 0, 1]);
		assert.deepEqual(bare.tint, [1, 1, 1, 1]);
		assert.equal(bare.position[2], 1);
	});
});
