import { createHash } from 'node:crypto';

import { type DecodedMesh, MeshTopology, VertexAttributeFormat } from '@endfield-noclip/formats/unity/mesh';
import type { Aabb } from '@endfield-noclip/formats/unity/values';

/** one station along a synthetic line ribbon, running along local `+x` */
export interface LineRibbonSample {
	/** distance along `+x` in metres */
	x: number;
	/** full width across `y` in metres */
	width: number;
	/** texture U coordinate */
	u: number;
	/** linear RGBA vertex colour */
	color: readonly [r: number, g: number, b: number, a: number];
}

/**
 * meshes the packer makes itself rather than reads from the install: the stand-in `cube`, a flat `polygon` at
 * y = 0 from an outline in x, z (a water volume's surface), a subdivided unit `grid` in `[0, 1]`
 * (heightfield-displaced sludge patches), or a `lineRibbon` along `+x` (a `LineRenderer` segment run)
 */
export type SyntheticMesh =
	| 'cube'
	| { kind: 'polygon'; points: readonly (readonly [x: number, z: number])[] }
	| { kind: 'grid'; cells: number }
	| { kind: 'lineRibbon'; samples: readonly LineRibbonSample[] };

/** the object key of a synthetic mesh, standing in for a mesh's `CAB-<hex>:<path id>` */
export const syntheticMeshKey = (mesh: SyntheticMesh): string => {
	if (mesh === 'cube') {
		return 'synthetic:cube';
	}
	if (mesh.kind === 'grid') {
		return `synthetic:grid:${mesh.cells}`;
	}
	if (mesh.kind === 'lineRibbon') {
		const digest = createHash('sha256');
		for (const { x, width, u, color } of mesh.samples) {
			digest.update(`${x},${width},${u},${color[0]},${color[1]},${color[2]},${color[3]};`);
		}
		return `synthetic:line:${digest.digest('hex').slice(0, 32)}`;
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
	if (mesh.kind === 'grid') {
		return unitGrid(mesh.cells);
	}
	if (mesh.kind === 'lineRibbon') {
		return lineRibbon(mesh.samples);
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
	// the ring is wound so that its convex corners have cross < 0: in Unity's left-handed frame, a triangle
	// (a, b, c) with negative x, z cross product winds clockwise seen from +y (a front face, as terrain patches
	// are wound)
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
			indices.push(a, b, c);
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
		indices.push(ring[0], ring[1], ring[2]);
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
 * a flat `cells × cells` subdivided grid over `[0, 1] × {0} × [0, 1]` facing `+y`, with `uv0 = (x, z)` and
 * bounds covering `[0, 1]³` so frustum culling holds heightfield displacement up to `y = 1`
 */
const unitGrid = (cells: number): DecodedMesh => {
	const side = cells + 1;
	const vertexCount = side * side;
	const positions = new Float32Array(vertexCount * 3);
	const normals = new Float32Array(vertexCount * 3);
	const uvs = new Float32Array(vertexCount * 2);
	for (let z = 0; z < side; z++) {
		const v = z / cells;
		for (let x = 0; x < side; x++) {
			const u = x / cells;
			const i = z * side + x;
			positions[i * 3] = u;
			positions[i * 3 + 2] = v;
			normals[i * 3 + 1] = 1;
			uvs[i * 2] = u;
			uvs[i * 2 + 1] = v;
		}
	}
	const indexCount = cells * cells * 6;
	const indices = vertexCount > 0xffff ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
	let at = 0;
	for (let z = 0; z < cells; z++) {
		for (let x = 0; x < cells; x++) {
			const i00 = z * side + x;
			const i10 = i00 + 1;
			const i01 = i00 + side;
			const i11 = i01 + 1;
			// clockwise seen from +y (front face in Unity's left-handed frame)
			indices[at++] = i00;
			indices[at++] = i01;
			indices[at++] = i11;
			indices[at++] = i00;
			indices[at++] = i11;
			indices[at++] = i10;
		}
	}
	const bounds: Aabb = { center: [0.5, 0.5, 0.5], extents: [0.5, 0.5, 0.5] };
	return {
		name: `unit grid ${cells}x${cells}`,
		vertexCount,
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
		indices,
		submeshes: [
			{
				firstIndex: 0,
				indexCount,
				topology: MeshTopology.Triangles,
				baseVertex: 0,
				firstVertex: 0,
				vertexCount,
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
			// Unity's front faces wind clockwise (u × v points along `sign · axis`, so (0, 1, 2) faces out)
			indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
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

/**
 * a ribbon lying in the XY plane along `+x`, facing `-z`, with vertex colours and `uv0 = (u, 0|1)`. bounds
 * carry the half-width on both `y` and `z` so axial billboarding about `+x` stays inside them
 */
const lineRibbon = (samples: readonly LineRibbonSample[]): DecodedMesh => {
	const count = samples.length;
	const vertexCount = count * 2;
	const positions = new Float32Array(vertexCount * 3);
	const normals = new Float32Array(vertexCount * 3);
	const uvs = new Float32Array(vertexCount * 2);
	const colors = new Float32Array(vertexCount * 4);
	let minX = Infinity;
	let maxX = -Infinity;
	let maxHalfWidth = 0;
	for (const [i, { x, width, u, color }] of samples.entries()) {
		const half = Math.max(width, 0) * 0.5;
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		maxHalfWidth = Math.max(maxHalfWidth, half);
		for (let side = 0; side < 2; side++) {
			const v = i * 2 + side;
			positions[v * 3] = x;
			positions[v * 3 + 1] = side === 0 ? -half : half;
			normals[v * 3 + 2] = -1;
			uvs[v * 2] = u;
			uvs[v * 2 + 1] = side;
			colors[v * 4] = color[0];
			colors[v * 4 + 1] = color[1];
			colors[v * 4 + 2] = color[2];
			colors[v * 4 + 3] = color[3];
		}
	}
	const segments = Math.max(count - 1, 0);
	const indexCount = segments * 6;
	const indices = vertexCount > 0xffff ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
	let at = 0;
	for (let i = 0; i < segments; i++) {
		const v0 = i * 2;
		const v1 = v0 + 1;
		const v2 = v0 + 2;
		const v3 = v0 + 3;
		// clockwise seen from -z (front face in Unity's left-handed frame)
		indices[at++] = v0;
		indices[at++] = v1;
		indices[at++] = v3;
		indices[at++] = v0;
		indices[at++] = v3;
		indices[at++] = v2;
	}
	const bounds: Aabb = {
		center: [(minX + maxX) * 0.5, 0, 0],
		extents: [(maxX - minX) * 0.5, maxHalfWidth, maxHalfWidth],
	};
	return {
		name: 'line ribbon',
		vertexCount,
		channels: [],
		positions,
		normals,
		packedNormals: null,
		tangents: null,
		colors: { dimension: 4, format: VertexAttributeFormat.Float32, data: colors },
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
		indices,
		submeshes: [
			{
				firstIndex: 0,
				indexCount,
				topology: MeshTopology.Triangles,
				baseVertex: 0,
				firstVertex: 0,
				vertexCount,
				bounds,
			},
		],
		bounds,
		skin: null,
	};
};
