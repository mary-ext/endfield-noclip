import { FormatError } from '../binary/binary-reader.ts';

import type { DecodedMesh } from './mesh.ts';
import type { Aabb } from './values.ts';

/**
 * bakes linear blend skinning into a new static mesh, preserving the input arrays
 *
 * @param mesh decoded mesh with vertex weights and bone indices
 * @param pose bone-to-output transforms multiplied by their mesh bind poses
 * @returns geometry in the pose's output space, with updated normals, tangents and bounds
 * @throws {FormatError} for missing influences, invalid bone references or singular transforms
 */
export const bakeSkinPose = (mesh: DecodedMesh, pose: readonly Float32Array[]): DecodedMesh => {
	const weights = mesh.skin?.weights;
	const indices = mesh.skin?.indices;
	if (!weights || !indices || weights.dimension !== indices.dimension) {
		throw new FormatError(`mesh ${mesh.name} has no matching skin influences`);
	}
	const positions = new Float32Array(mesh.positions.length);
	const normals = mesh.normals?.slice() ?? null;
	const tangents = mesh.tangents ? { ...mesh.tangents, data: mesh.tangents.data.slice() } : null;
	const min = [Infinity, Infinity, Infinity],
		max = [-Infinity, -Infinity, -Infinity];
	for (let v = 0; v < mesh.vertexCount; v++) {
		const matrix = new Float64Array(16);
		let total = 0;
		for (let k = 0; k < weights.dimension; k++) {
			const weight = weights.data[v * weights.dimension + k];
			if (weight === 0) {
				continue;
			}
			const index = indices.data[v * indices.dimension + k];
			const bone = pose[index];
			if (!Number.isFinite(weight) || weight < 0 || !Number.isInteger(index) || !bone || bone.length !== 16) {
				throw new FormatError(`mesh ${mesh.name} has an invalid skin influence`);
			}
			for (let i = 0; i < 16; i++) {
				matrix[i] += bone[i] * weight;
			}
			total += weight;
		}
		if (total <= 0) {
			throw new FormatError(`mesh ${mesh.name} has an unweighted vertex`);
		}
		for (let i = 0; i < 16; i++) {
			matrix[i] /= total;
		}
		for (let axis = 0; axis < 3; axis++) {
			let value = matrix[12 + axis];
			for (let c = 0; c < 3; c++) {
				value += matrix[c * 4 + axis] * mesh.positions[v * 3 + c];
			}
			positions[v * 3 + axis] = value;
			min[axis] = Math.min(min[axis], value);
			max[axis] = Math.max(max[axis], value);
		}
		const [a, b, c, d, e, f, g, h, i] = [
			matrix[0],
			matrix[4],
			matrix[8],
			matrix[1],
			matrix[5],
			matrix[9],
			matrix[2],
			matrix[6],
			matrix[10],
		];
		const cofactor = [
			e * i - f * h,
			f * g - d * i,
			d * h - e * g,
			c * h - b * i,
			a * i - c * g,
			b * g - a * h,
			b * f - c * e,
			c * d - a * f,
			a * e - b * d,
		];
		const determinant = a * cofactor[0] + b * cofactor[1] + c * cofactor[2];
		if (Math.abs(determinant) < 1e-12) {
			throw new FormatError(`mesh ${mesh.name} has a singular skin pose`);
		}
		if (normals && mesh.normals) {
			const n = mesh.normals.subarray(v * 3, v * 3 + 3);
			const out = [0, 1, 2].map(
				(row) =>
					(cofactor[row * 3] * n[0] + cofactor[row * 3 + 1] * n[1] + cofactor[row * 3 + 2] * n[2]) /
					determinant,
			);
			const length = Math.hypot(...out);
			normals.set(
				out.map((x) => (length === 0 ? 0 : x / length)),
				v * 3,
			);
		}
		if (tangents && mesh.tangents && tangents.dimension >= 4) {
			const offset = v * tangents.dimension;
			const t = mesh.tangents.data.subarray(offset, offset + 3);
			const out = [0, 1, 2].map(
				(row) => matrix[row] * t[0] + matrix[row + 4] * t[1] + matrix[row + 8] * t[2],
			);
			const length = Math.hypot(...out);
			tangents.data.set(
				out.map((x) => (length === 0 ? 0 : x / length)),
				offset,
			);
			tangents.data[offset + 3] *= Math.sign(determinant);
		}
	}
	const bounds: Aabb = {
		center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
		extents: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
	};
	return {
		...mesh,
		positions,
		normals,
		packedNormals: null,
		tangents,
		bounds,
		submeshes: mesh.submeshes.map((submesh) => ({ ...submesh, bounds })),
		skin: null,
	};
};
