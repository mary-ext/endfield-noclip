import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { syntheticMesh, syntheticMeshKey, triangulatePolygon } from './synthetic-mesh.ts';

/** the area of triangles over x, z points, and whether each is a front face seen from +y */
const triangleStats = (points: readonly (readonly [number, number])[], indices: readonly number[]) => {
	let area = 0;
	let allUp = true;
	for (let t = 0; t < indices.length; t += 3) {
		const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map((i) => points[i]);
		const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
		area += Math.abs(cross) / 2;
		// as the cube's +y face is wound
		allUp &&= cross > 0;
	}
	return { area, allUp };
};

describe('triangulatePolygon', () => {
	// an L: 3 × 3 minus its 2 × 2 top-right corner, area 5
	const ell: [number, number][] = [
		[0, 0],
		[3, 0],
		[3, 1],
		[1, 1],
		[1, 3],
		[0, 3],
	];

	it('covers a concave outline with front faces up, in either winding', () => {
		for (const points of [ell, ell.toReversed()]) {
			const indices = triangulatePolygon(points);
			assert.equal(indices.length, (points.length - 2) * 3);
			const { area, allUp } = triangleStats(points, indices);
			assert.equal(area, 5);
			assert.ok(allUp);
		}
	});

	it('skips collinear corners', () => {
		const points: [number, number][] = [
			[0, 0],
			[1, 0],
			[2, 0],
			[2, 2],
			[0, 2],
		];
		const { area, allUp } = triangleStats(points, triangulatePolygon(points));
		assert.equal(area, 4);
		assert.ok(allUp);
	});
});

describe('syntheticMeshKey', () => {
	it('tells polygons apart by their points', () => {
		const a = syntheticMeshKey({
			kind: 'polygon',
			points: [
				[0, 0],
				[1, 0],
				[0, 1],
			],
		});
		const b = syntheticMeshKey({
			kind: 'polygon',
			points: [
				[0, 0],
				[2, 0],
				[0, 1],
			],
		});
		assert.notEqual(a, b);
		assert.equal(syntheticMeshKey('cube'), 'synthetic:cube');
	});
});

describe('syntheticMesh', () => {
	it('makes a closed unit cube with outward face normals', () => {
		const cube = syntheticMesh('cube');
		assert.equal(cube.vertexCount, 24);
		assert.equal(cube.indices.length, 36);
		const { positions, normals } = cube;
		assert.ok(normals !== null);
		for (let v = 0; v < cube.vertexCount; v++) {
			for (let axis = 0; axis < 3; axis++) {
				assert.equal(Math.abs(positions[v * 3 + axis]), 0.5);
			}
			// the normal points along the axis the vertex's face lies on
			const face: number | undefined = [0, 1, 2].find((a) => normals[v * 3 + a] !== 0);
			assert.ok(face !== undefined);
			assert.equal(Math.sign(positions[v * 3 + face]), normals[v * 3 + face]);
		}
		// every triangle faces out (Unity winds front faces clockwise in its left-handed frame)
		for (let t = 0; t < cube.indices.length; t += 3) {
			const [a, b, c] = [cube.indices[t], cube.indices[t + 1], cube.indices[t + 2]].map((i) =>
				Array.from(positions.subarray(i * 3, i * 3 + 3)),
			);
			const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
			const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
			const cross = [
				ab[1] * ac[2] - ab[2] * ac[1],
				ab[2] * ac[0] - ab[0] * ac[2],
				ab[0] * ac[1] - ab[1] * ac[0],
			];
			const n: number[] = Array.from(normals.subarray(cube.indices[t] * 3, cube.indices[t] * 3 + 3));
			// seen from outside, a clockwise triangle's edge cross product points inward
			assert.ok(cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] < 0);
		}
	});
});
