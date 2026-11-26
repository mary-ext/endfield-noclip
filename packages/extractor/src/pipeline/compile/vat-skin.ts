/**
 * bakes `HGRP/Lit`'s vertex animations (`docs/game-data/materials.md#vertex-animation-textures`) into
 * skeletal ones: each piece or point of a Houdini animation becomes a bone, whose matrix at every frame is
 * the transform the shader reads from the position and rotation textures, and a bone animation's map already
 * holds its bones' matrices
 */

import { VkFormat } from '@endfield-noclip/formats/binary/ktx2';
import { type DecodedMesh, VertexAttributeFormat } from '@endfield-noclip/formats/unity/mesh';
import type { DecodedTexture } from '@endfield-noclip/formats/unity/texture';

import type { ObjectLocator } from '../../game/assets/assets.ts';
import type { BoneVat, HoudiniVat } from '../../game/materials/surfaces/vat-animation.ts';
import type { SkinMotion } from '../../game/prefabs/prefab.ts';

/** a vertex animation as the conversion worker reads it */
export type VatBake = HoudiniBake | BoneBake;

/** a {@link HoudiniVat} as the conversion worker reads it */
export interface HoudiniBake extends Omit<HoudiniVat, 'position' | 'rotation'> {
	position: ObjectLocator;
	rotation: ObjectLocator;
	/** the submeshes drawn with the animation; the others hold still */
	submeshes: number[];
}

/** a {@link BoneVat} as the conversion worker reads it */
export interface BoneBake extends Omit<BoneVat, 'map'> {
	map: ObjectLocator;
	/** the submeshes drawn with the animation; the others hold still */
	submeshes: number[];
}

/** a VAT texture's top level as RGBA floats, as the shader samples it */
export interface VatTexels {
	width: number;
	height: number;
	/** RGBA per texel, row 0 first (`v = 0`) */
	texels: Float32Array;
}

/** the most bones a vertex's `uint16x4` indices can name */
const MAX_BONES = 65_536;

/**
 * @param texture a decoded VAT texture
 * @returns its top level as floats
 * @throws {Error} for a format other than RGBA half, float or 8-bit unorm
 */
export const vatTexels = (texture: DecodedTexture): VatTexels => {
	const level = texture.levels[0];
	const count = texture.width * texture.height * 4;
	let texels: Float32Array;
	switch (texture.vkFormat) {
		case VkFormat.R16G16B16A16_SFLOAT: {
			// copied, as a level's bytes may start at an odd offset
			texels = Float32Array.from(new Float16Array(level.slice(0, count * 2).buffer));
			break;
		}
		case VkFormat.R32G32B32A32_SFLOAT: {
			texels = new Float32Array(level.buffer.slice(level.byteOffset, level.byteOffset + count * 4));
			break;
		}
		case VkFormat.R8G8B8A8_UNORM: {
			texels = Float32Array.from(level.subarray(0, count), (value) => value / 255);
			break;
		}
		default: {
			throw new Error(`VAT texture ${texture.name} has format ${texture.format.name}`);
		}
	}
	return { width: texture.width, height: texture.height, texels };
};

/** the bake's result: the skinned mesh and its motion, or why it can't be baked */
type VatSkinned = { mesh: DecodedMesh; motion: SkinMotion } | { reason: string };

/**
 * @param mesh the mesh the animation's materials draw
 * @param submeshes the submeshes drawn with the animation
 * @returns per vertex, 1 where one of those submeshes uses it
 */
const movingVertices = (mesh: DecodedMesh, submeshes: readonly number[]): Uint8Array => {
	const moving = new Uint8Array(mesh.vertexCount);
	for (const index of submeshes) {
		const submesh = mesh.submeshes[index];
		if (submesh === undefined) {
			continue;
		}
		for (let i = submesh.firstIndex; i < submesh.firstIndex + submesh.indexCount; i++) {
			moving[mesh.indices[i] + submesh.baseVertex] = 1;
		}
	}
	return moving;
};

/**
 * @param mesh the mesh the animation's materials draw
 * @param bake the animation, with the submeshes it moves
 * @param position its position texture
 * @param rotation its rotation texture
 * @returns a copy of the mesh skinned to one bone per piece (bone 0 holding the other submeshes still) and
 *   the motion that plays the animation, or the reason it can't be baked. a soft body's pieces are its points
 *   (each distinct UV1 and rest position), and its moving vertices' normals and tangents become +y and −x,
 *   which the bones turn as the shader turns them
 */
export const vatSkin = (
	mesh: DecodedMesh,
	bake: HoudiniBake,
	position: VatTexels,
	rotation: VatTexels,
): VatSkinned => {
	const soft = bake.body === 'soft';
	const lookup = mesh.uvs[1];
	const pivotX = mesh.uvs[2];
	const pivotYz = mesh.uvs[3];
	if (lookup == null) {
		return { reason: 'a vertex-animated mesh without UV set 1' };
	}
	if (!soft && (pivotX == null || pivotYz == null)) {
		return { reason: 'a rigid-body mesh without UV sets 2 and 3' };
	}
	// the shader's per-vertex inputs: UV1 finds the piece's texels; a rigid piece's pivot is in UV2.x and UV3,
	// a soft body's point moves from its rest position
	const moving = movingVertices(mesh, bake.submeshes);
	const pieces: { u: number; v: number; pivot: [number, number, number] }[] = [];
	const pieceOf = new Map<string, number>();
	const bones = new Float32Array(mesh.vertexCount);
	for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
		if (moving[vertex] === 0) {
			continue;
		}
		const u = lookup.data[vertex * lookup.dimension];
		const v = lookup.data[vertex * lookup.dimension + 1];
		let pivot: [number, number, number];
		if (soft || pivotX == null || pivotYz == null) {
			pivot = [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1], mesh.positions[vertex * 3 + 2]];
		} else {
			pivot = [
				-pivotX.data[vertex * pivotX.dimension],
				pivotYz.data[vertex * pivotYz.dimension],
				1 - pivotYz.data[vertex * pivotYz.dimension + 1],
			];
		}
		const key = `${u} ${v} ${pivot.join(' ')}`;
		let piece = pieceOf.get(key);
		if (piece === undefined) {
			piece = pieces.push({ u, v, pivot });
			pieceOf.set(key, piece);
		}
		bones[vertex] = piece;
	}
	const boneCount = pieces.length + 1;
	if (boneCount > MAX_BONES) {
		return { reason: `a vertex-animated mesh of ${pieces.length} pieces, more than ${MAX_BONES - 1}` };
	}

	const { frameCount, cycleRate, cycleStart } = bake;
	// the baked loop's frame j shows the game's frame at the middle of its span, so a negative rate plays it
	// backwards and the start time shifts it
	const frameRate = Math.abs(cycleRate) * frameCount || 1;
	const matrices = new Float32Array(frameCount * boneCount * 12);
	const texel = (texture: VatTexels, u: number, v: number): Float32Array => {
		// point sampling with repeat wrapping, as the VAT textures are set up
		const x = (((Math.floor(u * texture.width) % texture.width) + texture.width) % texture.width) * 4;
		const y = ((Math.floor(v * texture.height) % texture.height) + texture.height) % texture.height;
		return texture.texels.subarray(y * texture.width * 4 + x, y * texture.width * 4 + x + 4);
	};
	for (let frame = 0; frame < frameCount; frame++) {
		const time = (frame + 0.5) / frameRate;
		const cycle = (time - cycleStart) * cycleRate;
		const shown = Math.floor((cycle - Math.floor(cycle)) * frameCount);
		const rest = shown === 0 && !bake.animateFirstFrame;
		for (let bone = 0; bone < boneCount; bone++) {
			const m = (frame * boneCount + bone) * 12;
			const piece = bone === 0 ? null : pieces[bone - 1];
			// vertices whose UV1 v is at most 0.1 collapse to the object's origin, even in the rest pose
			if (piece !== null && piece.v <= 0.1) {
				continue;
			}
			if (piece === null || rest) {
				matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], m);
				continue;
			}
			const { u, v, pivot } = piece;
			const at: [number, number] = [u * bake.uScale, 1 - bake.vScale * (1 - v + shown / frameCount)];
			const p = texel(position, ...at);
			const r = texel(rotation, ...at);
			const [a, b, c, e] = bake.hdr
				? [r[0], r[1], r[2], r[3]]
				: [(r[0] - 0.5) * 2, (r[1] - 0.5) * 2, (r[2] - 0.5) * 2, (r[3] - 0.5) * 2];
			let q: [x: number, y: number, z: number, w: number];
			let scale = 1;
			if (soft) {
				q = [a, b, c, e];
			} else {
				const d = Math.sqrt(Math.max(1 - a * a - b * b - c * c, 0));
				// the rotation texture leaves out the largest component, which the position's alpha names
				const slot = p[3] * 4;
				switch (Math.floor(slot)) {
					case 1: {
						q = [d, b, c, a];
						break;
					}
					case 2: {
						q = [a, -d, c, -b];
						break;
					}
					case 3: {
						q = [a, b, -d, -c];
						break;
					}
					default: {
						q = [a, b, c, d];
						break;
					}
				}
				scale =
					bake.scale *
					(bake.maxPieceScale === null ? 1 : bake.maxPieceScale * (1 - (slot - Math.floor(slot))));
			}
			const [x, y, z, w] = q;
			const rows = [
				[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
				[2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
				[2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
			];
			for (let row = 0; row < 3; row++) {
				const [m0, m1, m2] = rows[row].map((value) => value * scale);
				// a soft body's offset is from the rest position, a rigid piece's position is absolute
				const offset = (soft ? pivot[row] : 0) + bake.min[row] + p[row] * bake.range[row];
				matrices.set([m0, m1, m2, offset - (m0 * pivot[0] + m1 * pivot[1] + m2 * pivot[2])], m + row * 4);
			}
		}
	}
	return {
		mesh: {
			...mesh,
			...(soft ? softFrames(mesh, moving) : {}),
			skin: {
				bonesPerVertex: 1,
				bindPoseCount: boneCount,
				boneNameHashCount: 0,
				hasBlendWeights: true,
				hasBlendIndices: true,
				weights: {
					dimension: 1,
					format: VertexAttributeFormat.Float32,
					data: new Float32Array(mesh.vertexCount).fill(1),
				},
				indices: { dimension: 1, format: VertexAttributeFormat.Float32, data: bones },
			},
		},
		motion: { boneCount, frameCount, frameRate, matrices },
	};
};

/**
 * @param mesh the mesh the animation's materials draw
 * @param bake the bone animation, with the submeshes it moves
 * @param map its map, a row of 3 × 4 matrices per frame (three texels per bone, its rows)
 * @returns a copy of the mesh skinned to the map's bones (bone 0 added to hold the other submeshes still) and
 *   the motion that plays them, or the reason it can't be baked. the vertices' weights are normalized when
 *   packed, where the game blends them as stored
 */
export const boneVatSkin = (mesh: DecodedMesh, bake: BoneBake, map: VatTexels): VatSkinned => {
	const bones = mesh.uvs[2];
	const weights = mesh.uvs[3];
	const n = bake.influences;
	if (bones == null || weights == null || bones.dimension < n || weights.dimension < n) {
		return { reason: `a bone-animated mesh without ${n} bones and weights in UV sets 2 and 3` };
	}
	if (map.width < bake.boneCount * 3 || map.height < bake.frameCount) {
		return { reason: 'a bone animation whose map is smaller than its bones and frames' };
	}
	const moving = movingVertices(mesh, bake.submeshes);
	const boneCount = bake.boneCount + 1;
	const indices = new Float32Array(mesh.vertexCount * n);
	const blend = new Float32Array(mesh.vertexCount * n);
	for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
		if (moving[vertex] === 0) {
			blend[vertex * n] = 1;
			continue;
		}
		for (let k = 0; k < n; k++) {
			// 8-bit signed bone indices, read back as index / 127; the shader's column is 3 · (127 · u − 0.1) + 0.5
			// texels in, so a point sample lands on the index's first texel
			const bone = Math.round(bones.data[vertex * bones.dimension + k] * 127);
			const weight = weights.data[vertex * weights.dimension + k];
			if (weight !== 0 && (bone < 0 || bone >= bake.boneCount)) {
				return { reason: `a bone-animated mesh naming bone ${bone} of ${bake.boneCount}` };
			}
			indices[vertex * n + k] = weight === 0 ? 0 : bone + 1;
			blend[vertex * n + k] = weight;
		}
	}
	const matrices = new Float32Array(bake.frameCount * boneCount * 12);
	for (let frame = 0; frame < bake.frameCount; frame++) {
		// frame f is read at v = 1 − (f + 0.5) / frames, the map's row from the top
		const row = bake.frameCount - 1 - frame;
		matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], frame * boneCount * 12);
		const start = row * map.width * 4;
		matrices.set(map.texels.subarray(start, start + bake.boneCount * 12), (frame * boneCount + 1) * 12);
	}
	return {
		mesh: {
			...mesh,
			skin: {
				bonesPerVertex: n,
				bindPoseCount: boneCount,
				boneNameHashCount: 0,
				hasBlendWeights: true,
				hasBlendIndices: true,
				weights: { dimension: n, format: VertexAttributeFormat.Float32, data: blend },
				indices: { dimension: n, format: VertexAttributeFormat.Float32, data: indices },
			},
		},
		motion: { boneCount, frameCount: bake.frameCount, frameRate: bake.frameRate || 1, matrices },
	};
};

/**
 * @param mesh a soft-body mesh
 * @param moving per vertex, 1 where the animation moves it
 * @returns its normals and tangents with the moving vertices' set to +y and −x, the directions the shader
 *   turns by each frame's rotation in place of the mesh's own. the shader passes a bitangent sign of 0, which
 *   flattens the normal map across the tangent; the sign is kept here
 */
const softFrames = (
	mesh: DecodedMesh,
	moving: Uint8Array,
): Pick<DecodedMesh, 'normals' | 'packedNormals' | 'tangents'> => {
	const normals = mesh.normals?.slice() ?? new Float32Array(mesh.vertexCount * 3);
	const source = mesh.tangents;
	const tangents = new Float32Array(mesh.vertexCount * 4);
	for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
		if (source !== null) {
			for (let k = 0; k < Math.min(source.dimension, 4); k++) {
				tangents[vertex * 4 + k] = source.data[vertex * source.dimension + k];
			}
		}
		if (moving[vertex] === 0) {
			continue;
		}
		normals.set([0, 1, 0], vertex * 3);
		const sign =
			source !== null && source.dimension >= 4 && source.data[vertex * source.dimension + 3] < 0 ? -1 : 1;
		tangents.set([-1, 0, 0, sign], vertex * 4);
	}
	return {
		normals,
		packedNormals: null,
		tangents: { dimension: 4, format: VertexAttributeFormat.Float32, data: tangents },
	};
};
