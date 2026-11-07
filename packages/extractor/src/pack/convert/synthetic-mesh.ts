import { createHash } from 'node:crypto';

import { type DecodedMesh, MeshTopology, VertexAttributeFormat } from '@endfield-noclip/formats/unity/mesh';
import type { Aabb } from '@endfield-noclip/formats/unity/values';

/**
 * meshes the packer makes itself rather than reads from the install: the stand-in `cube`, or a flat `polygon`
 * at y = 0 from an outline in x, z (a water volume's surface)
 */
export type SyntheticMesh =
	| 'cube'
	| { kind: 'polygon'; points: readonly (readonly [x: number, z: number])[] };

/** the object key of a synthetic mesh, standing in for a mesh's `CAB-<hex>:<path id>` */
export const syntheticMeshKey = (mesh: SyntheticMesh): string => {
	if (mesh === 'cube') {
		return 'synthetic:cube';
	}
	const digest = createHash('sha256');
	for (const [x, z] of mesh.points) {
		digest.update(`${x},${z};`);
	}
	return `synthetic:polygon:${digest.digest('hex').slice(0, 32)}`;
};

/**
 * @param mesh which synthetic mesh
 * @returns it decoded, as a mesh read from the install would be
 * @throws {Error} for a polygon that can't be triangulated
 */
export const syntheticMesh = (mesh: SyntheticMesh): DecodedMesh => {
	if (mesh === 'cube') {
		return unitCube();
	}
	return flatPolygon(mesh.points);
};

/**
 * triangulates a simple polygon by ear clipping
 *
 * @param points a simple (not self-intersecting) outline in x, z, either winding, without a repeated last
 *   point
 * @returns vertex indices, three per triangle, each a front face seen from +y in Unity's frame
 * @throws {Error} for fewer than 3 points, or when no corner can be clipped (some self-intersecting outlines)
 */
export const triangulatePolygon = (points: readonly (readonly [number, number])[]): number[] => {
	const n = points.length;
	if (n < 3) {
		throw new Error(`a polygon needs 3 points, not ${n}`);
	}
	// the ring is wound so that its convex corners have cross < 0; a triangle (a, b, c) of it is then emitted
	// as (a, c, b), whose positive x, z cross product is a front face seen from +y in Unity's left-handed frame
	let area = 0;
	for (let i = 0; i < n; i++) {
		const [ax, az] = points[i];
		const [bx, bz] = points[(i + 1) % n];
		area += ax * bz - bx * az;
	}
	const ring = Array.from({ length: n }, (_, i) => i);
	if (area > 0) {
		ring.reverse();
	}
	const cross = (a: number, b: number, c: number): number => {
		const [ax, az] = points[a];
		const [bx, bz] = points[b];
		const [cx, cz] = points[c];
		return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
	};
	const inside = (p: number, a: number, b: number, c: number): boolean =>
		cross(a, b, p) < 0 && cross(b, c, p) < 0 && cross(c, a, p) < 0;
	const indices: number[] = [];
	let guard = 0;
	while (ring.length > 3) {
		if (guard++ > n * n) {
			throw new Error('no corner of the polygon outline can be clipped');
		}
		let clipped = false;
		for (let i = 0; i < ring.length; i++) {
			const a = ring[(i + ring.length - 1) % ring.length];
			const b = ring[i];
			const c = ring[(i + 1) % ring.length];
			if (cross(a, b, c) >= 0) {
				continue;
			}
			if (ring.some((p) => p !== a && p !== b && p !== c && inside(p, a, b, c))) {
				continue;
			}
			indices.push(a, c, b);
			ring.splice(i, 1);
			clipped = true;
			break;
		}
		if (!clipped) {
			// only collinear corners remain to clip; drop one
			const flat = ring.findIndex(
				(b, i) => cross(ring[(i + ring.length - 1) % ring.length], b, ring[(i + 1) % ring.length]) === 0,
			);
			if (flat < 0) {
				throw new Error('no corner of the polygon outline can be clipped');
			}
			ring.splice(flat, 1);
		}
	}
	if (cross(ring[0], ring[1], ring[2]) < 0) {
		indices.push(ring[0], ring[2], ring[1]);
	}
	return indices;
};

/** a flat polygon at y = 0 facing +y, with uv0 = world x, z */
const flatPolygon = (points: readonly (readonly [number, number])[]): DecodedMesh => {
	const indices = triangulatePolygon(points);
	const positions = new Float32Array(points.length * 3);
	const normals = new Float32Array(points.length * 3);
	const uvs = new Float32Array(points.length * 2);
	let minX = Infinity;
	let minZ = Infinity;
	let maxX = -Infinity;
	let maxZ = -Infinity;
	for (const [i, [x, z]] of points.entries()) {
		positions[i * 3] = x;
		positions[i * 3 + 2] = z;
		normals[i * 3 + 1] = 1;
		uvs[i * 2] = x;
		uvs[i * 2 + 1] = z;
		minX = Math.min(minX, x);
		minZ = Math.min(minZ, z);
		maxX = Math.max(maxX, x);
		maxZ = Math.max(maxZ, z);
	}
	const bounds: Aabb = {
		center: [(minX + maxX) / 2, 0, (minZ + maxZ) / 2],
		extents: [(maxX - minX) / 2, 0, (maxZ - minZ) / 2],
	};
	return {
		name: 'water volume surface',
		vertexCount: points.length,
		channels: [],
		positions,
		normals,
		packedNormals: null,
		tangents: null,
		colors: null,
		uvs: [
			{ dimension: 2, format: VertexAttributeFormat.Float32, data: uvs },
			null,
			null,
			null,
			null,
			null,
			null,
			null,
		],
		indices: points.length > 0xffff ? new Uint32Array(indices) : new Uint16Array(indices),
		submeshes: [
			{
				firstIndex: 0,
				indexCount: indices.length,
				topology: MeshTopology.Triangles,
				baseVertex: 0,
				firstVertex: 0,
				vertexCount: points.length,
				bounds,
			},
		],
		bounds,
		skin: null,
	};
};

/**
 * the unit cube, from −0.5 to 0.5 on each axis, with a flat normal per face. stand-ins for content the viewer
 * doesn't draw scale it to that content's bounds
 */
const unitCube = (): DecodedMesh => {
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const indices: number[] = [];
	for (let axis = 0; axis < 3; axis++) {
		for (const sign of [-1, 1]) {
			// u and v run along the other two axes, wound so the face looks out along `sign`
			const u = (axis + (sign > 0 ? 1 : 2)) % 3;
			const v = (axis + (sign > 0 ? 2 : 1)) % 3;
			const first = positions.length / 3;
			for (const [cu, cv] of [
				[-1, -1],
				[1, -1],
				[1, 1],
				[-1, 1],
			]) {
				const position = [0, 0, 0];
				position[axis] = sign * 0.5;
				position[u] = cu * 0.5;
				position[v] = cv * 0.5;
				positions.push(...position);
				const normal = [0, 0, 0];
				normal[axis] = sign;
				normals.push(...normal);
				uvs.push((cu + 1) / 2, (cv + 1) / 2);
			}
			// Unity's front faces wind clockwise
			indices.push(first, first + 2, first + 1, first, first + 3, first + 2);
		}
	}
	const bounds: Aabb = { center: [0, 0, 0], extents: [0.5, 0.5, 0.5] };
	return {
		name: 'stand-in cube',
		vertexCount: positions.length / 3,
		channels: [],
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		packedNormals: null,
		tangents: null,
		colors: null,
		uvs: [
			{ dimension: 2, format: VertexAttributeFormat.Float32, data: new Float32Array(uvs) },
			null,
			null,
			null,
			null,
			null,
			null,
			null,
		],
		indices: new Uint16Array(indices),
		submeshes: [
			{
				firstIndex: 0,
				indexCount: indices.length,
				topology: MeshTopology.Triangles,
				baseVertex: 0,
				firstVertex: 0,
				vertexCount: positions.length / 3,
				bounds,
			},
		],
		bounds,
		skin: null,
	};
};
