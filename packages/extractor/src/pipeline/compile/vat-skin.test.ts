import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	type DecodedMesh,
	type MeshAttribute,
	MeshTopology,
	VertexAttributeFormat,
} from '@endfield-noclip/formats/unity/mesh';

import { type BoneBake, boneVatSkin, type HoudiniBake, vatSkin, type VatTexels } from './vat-skin.ts';

const attribute = (dimension: number, values: number[]): MeshAttribute => ({
	dimension,
	format: VertexAttributeFormat.Float32,
	data: Float32Array.from(values),
});

const bounds = {
	center: [0, 0, 0] as [number, number, number],
	extents: [1, 1, 1] as [number, number, number],
};

// submesh 0, drawn with the animation: a triangle (piece 1, pivot (0.5, 0.25, 0.75)) and a triangle whose UV1
// v is 0.05 (collapsed). submesh 1, drawn without it: one more triangle
const mesh: DecodedMesh = {
	name: 'pieces',
	vertexCount: 9,
	channels: [],
	positions: Float32Array.from([
		0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0, 5, 0, 0, 6, 0, 0, 5, 1, 0,
	]),
	normals: null,
	packedNormals: null,
	tangents: null,
	colors: null,
	uvs: [
		null,
		// UV1: column 0.25 of a two-texel-wide texture; rows from the top, as Houdini lays them out
		attribute(
			2,
			[0.25, 0.875, 0.25, 0.875, 0.25, 0.875, 0.75, 0.05, 0.75, 0.05, 0.75, 0.05, 0, 0, 0, 0, 0, 0],
		),
		// UV2.x and UV3 hold the pivot as (−x) and (y, 1 − z)
		attribute(2, [-0.5, 0, -0.5, 0, -0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
		attribute(2, [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
		null,
		null,
		null,
		null,
	],
	indices: Uint16Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]),
	submeshes: [
		{
			firstIndex: 0,
			indexCount: 6,
			topology: MeshTopology.Triangles,
			baseVertex: 0,
			firstVertex: 0,
			vertexCount: 6,
			bounds,
		},
		{
			firstIndex: 6,
			indexCount: 3,
			topology: MeshTopology.Triangles,
			baseVertex: 0,
			firstVertex: 6,
			vertexCount: 3,
			bounds,
		},
	],
	bounds,
	skin: null,
};

// four frames, two texels wide: piece 1's column moves by (frame, 0, 0) and turns about z by 30° a frame;
// the position's alpha of 0.75 names w as the component the rotation texture leaves out
const position: VatTexels = { width: 2, height: 4, texels: new Float32Array(32) };
const rotation: VatTexels = { width: 2, height: 4, texels: new Float32Array(32) };
for (let row = 0; row < 4; row++) {
	// frame f sits at row 3 − f, since rows are read from v = 1 down
	const frame = 3 - row;
	const half = ((frame * 30) / 2) * (Math.PI / 180);
	position.texels.set([frame, 0, 0, 0.0], row * 8);
	rotation.texels.set([0, 0, Math.sin(half), 0], row * 8);
}

const bake: HoudiniBake = {
	body: 'rigid',
	position: { bundleIndex: 0, file: '', pathId: 0n },
	rotation: { bundleIndex: 0, file: '', pathId: 0n },
	submeshes: [0],
	frameCount: 4,
	cycleRate: 30 / (4 - 0.01),
	cycleStart: 0,
	animateFirstFrame: false,
	uScale: 1,
	vScale: 1,
	min: [0, 0, 0],
	range: [1, 1, 1],
	hdr: true,
	scale: 1,
	maxPieceScale: null,
};

/** the shader's own vertex stage for a vertex of piece 1 at a frame (`docs/game-data/materials.md`) */
const shaderPosition = (vertex: number, frame: number): number[] => {
	const p = [...mesh.positions.subarray(vertex * 3, vertex * 3 + 3)];
	const half = ((frame * 30) / 2) * (Math.PI / 180);
	const q = [0, 0, Math.sin(half)];
	const w = Math.sqrt(1 - q[2] * q[2]);
	const v = [p[0] - 0.5, p[1] - 0.25, p[2] - 0.75];
	const cross = (a: number[], b: number[]) => [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
	const inner = cross(q, v).map((value, i) => value + v[i] * w);
	return cross(q, inner).map((value, i) => value * 2 + v[i] + [frame, 0, 0][i]);
};

/** a vertex skinned by the baked frame */
const bakedPosition = (
	baked: { mesh: DecodedMesh; motion: { boneCount: number; matrices: Float32Array } },
	vertex: number,
	frame: number,
): number[] => {
	const bone = baked.mesh.skin!.indices!.data[vertex];
	const m = baked.motion.matrices.subarray((frame * baked.motion.boneCount + bone) * 12);
	const [x, y, z] = mesh.positions.subarray(vertex * 3, vertex * 3 + 3);
	return [0, 1, 2].map((row) => m[row * 4] * x + m[row * 4 + 1] * y + m[row * 4 + 2] * z + m[row * 4 + 3]);
};

describe('vertex animation', () => {
	it('moves each piece as the shader does, holds the rest pose on frame 0 and other submeshes still', () => {
		const baked = vatSkin(mesh, bake, position, rotation);
		assert.ok(!('reason' in baked));
		// still, piece 1 and the collapsed piece
		assert.equal(baked.motion.boneCount, 3);
		assert.ok(Math.abs(baked.motion.frameRate - (30 * 4) / 3.99) < 1e-9);
		for (const frame of [1, 2, 3]) {
			for (const vertex of [0, 1, 2]) {
				const expected = shaderPosition(vertex, frame);
				bakedPosition(baked, vertex, frame).forEach((value, i) =>
					assert.ok(Math.abs(value - expected[i]) < 1e-5),
				);
			}
		}
		for (const vertex of [0, 1, 2, 6, 7, 8]) {
			assert.deepEqual(bakedPosition(baked, vertex, 0), [
				...mesh.positions.subarray(vertex * 3, vertex * 3 + 3),
			]);
		}
		// vertices whose UV1 v is at most 0.1 sit at the origin, even at rest
		for (const frame of [0, 2]) {
			assert.deepEqual(bakedPosition(baked, 4, frame), [0, 0, 0]);
		}
	});

	it('plays a negative rate backwards', () => {
		const baked = vatSkin(
			mesh,
			{ ...bake, cycleRate: -bake.cycleRate, animateFirstFrame: true },
			position,
			rotation,
		);
		assert.ok(!('reason' in baked));
		// the baked frames show the game's 3, 2, 1, 0
		const expected = shaderPosition(1, 3);
		bakedPosition(baked, 1, 0).forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-5));
	});

	it('moves a soft body point by its offset from rest, and turns +y and −x into its normal and tangent', () => {
		// frame 2 of every column: offset (0.5, 0, 0), a quarter turn about z
		const offsets: VatTexels = { width: 2, height: 4, texels: new Float32Array(32) };
		const turns: VatTexels = { width: 2, height: 4, texels: new Float32Array(32) };
		for (let row = 0; row < 4; row++) {
			for (let column = 0; column < 2; column++) {
				turns.texels.set([0, 0, 0, 1], (row * 2 + column) * 4);
			}
		}
		const half = Math.SQRT1_2;
		offsets.texels.set([0.5, 0, 0, 0], 1 * 8);
		turns.texels.set([0, 0, half, half], 1 * 8);
		const baked = vatSkin(mesh, { ...bake, body: 'soft', animateFirstFrame: true }, offsets, turns);
		assert.ok(!('reason' in baked));
		// each point of submesh 0 is its own bone, after the still bone
		assert.equal(baked.motion.boneCount, 7);
		assert.deepEqual(
			bakedPosition(baked, 1, 2).map((value) => Math.round(value * 1e5) / 1e5),
			[1.5, 0, 0],
		);
		assert.deepEqual([...baked.mesh.normals!.subarray(3, 6)], [0, 1, 0]);
		assert.deepEqual([...baked.mesh.tangents!.data.subarray(4, 7)], [-1, 0, 0]);
		const bone = baked.mesh.skin!.indices!.data[1];
		const m = baked.motion.matrices.subarray((2 * baked.motion.boneCount + bone) * 12);
		// the normal +y turns to −x
		assert.deepEqual(
			[m[1], m[5], m[9]].map((value) => Math.round(value * 1e5) / 1e5),
			[-1, 0, 0],
		);
		// submesh 1 keeps its own frame
		assert.deepEqual([...baked.mesh.normals!.subarray(18, 21)], [0, 0, 0]);
	});

	it("can't bake a mesh without the pivot's UV sets", () => {
		const baked = vatSkin({ ...mesh, uvs: [null, mesh.uvs[1], null] }, bake, position, rotation);
		assert.ok('reason' in baked);
	});
});

describe('bone animation', () => {
	// two bones over three frames: bone 0 moves by (frame, 0, 0), bone 1 by (0, frame, 0). vertex 0 follows
	// bone 0, vertex 1 blends both halves, vertex 2 (submesh 1) holds still
	const map: VatTexels = { width: 6, height: 3, texels: new Float32Array(6 * 3 * 4) };
	for (let frame = 0; frame < 3; frame++) {
		// frame f is the row at v = 1 − (f + 0.5) / 3, counted from the top
		const row = 2 - frame;
		map.texels.set([1, 0, 0, frame, 0, 1, 0, 0, 0, 0, 1, 0], row * 24);
		map.texels.set([1, 0, 0, 0, 0, 1, 0, frame, 0, 0, 1, 0], row * 24 + 12);
	}
	const tubes: DecodedMesh = {
		...mesh,
		vertexCount: 3,
		positions: Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]),
		uvs: [
			null,
			null,
			// bone indices as 8-bit signed values, index / 127
			attribute(2, [0, 0, 0, 1 / 127, 0, 0]),
			attribute(2, [1, 0, 0.5, 0.5, 0, 0]),
			null,
			null,
			null,
			null,
		],
		indices: Uint16Array.from([0, 1, 0, 2, 2, 2]),
		submeshes: [
			{ ...mesh.submeshes[0], firstIndex: 0, indexCount: 3 },
			{ ...mesh.submeshes[1], firstIndex: 3, indexCount: 3 },
		],
	};
	const bones: BoneBake = {
		body: 'bone',
		map: { bundleIndex: 0, file: '', pathId: 0n },
		boneCount: 2,
		frameCount: 3,
		frameRate: 30,
		influences: 2,
		submeshes: [0],
	};

	it("blends the map's matrices by the vertices' weights, the other submeshes still", () => {
		const baked = boneVatSkin(tubes, bones, map);
		assert.ok(!('reason' in baked));
		assert.deepEqual([baked.motion.boneCount, baked.motion.frameCount, baked.motion.frameRate], [3, 3, 30]);
		const skinned = (vertex: number, frame: number): number[] => {
			const { indices, weights } = baked.mesh.skin!;
			const out = [0, 0, 0];
			for (let k = 0; k < 2; k++) {
				const m = baked.motion.matrices.subarray((frame * 3 + indices!.data[vertex * 2 + k]) * 12);
				const [x, y, z] = tubes.positions.subarray(vertex * 3, vertex * 3 + 3);
				for (let row = 0; row < 3; row++) {
					out[row] +=
						weights!.data[vertex * 2 + k] *
						(m[row * 4] * x + m[row * 4 + 1] * y + m[row * 4 + 2] * z + m[row * 4 + 3]);
				}
			}
			return out;
		};
		assert.deepEqual(skinned(0, 2), [2, 0, 0]);
		assert.deepEqual(skinned(1, 2), [2, 2, 1]);
		assert.deepEqual(skinned(2, 2), [2, 2, 2]);
	});

	it("can't bake a mesh naming a bone the map doesn't hold", () => {
		const baked = boneVatSkin(tubes, { ...bones, boneCount: 1 }, map);
		assert.ok('reason' in baked);
	});
});
