import type { Aabb } from './values.ts';

/**
 * @param position translation
 * @param quaternion normalized rotation, xyzw
 * @param scale axis scales
 * @returns a column-major TRS matrix
 */
export const trsMatrix = (
	position: readonly number[],
	quaternion: readonly number[],
	scale: readonly number[],
): Float32Array => {
	const [x, y, z, w] = quaternion;
	const [sx, sy, sz] = scale;
	return new Float32Array([
		(1 - 2 * (y * y + z * z)) * sx,
		2 * (x * y + z * w) * sx,
		2 * (x * z - y * w) * sx,
		0,
		2 * (x * y - z * w) * sy,
		(1 - 2 * (x * x + z * z)) * sy,
		2 * (y * z + x * w) * sy,
		0,
		2 * (x * z + y * w) * sz,
		2 * (y * z - x * w) * sz,
		(1 - 2 * (x * x + y * y)) * sz,
		0,
		position[0],
		position[1],
		position[2],
		1,
	]);
};

/**
 * @param angles Unity Euler angles in degrees, applied Z then X then Y
 * @returns the rotation as an xyzw quaternion
 */
export const unityEulerQuaternion = (angles: readonly number[]): [number, number, number, number] => {
	const [x, y, z] = angles.map((angle) => (angle * Math.PI) / 360);
	const cx = Math.cos(x),
		cy = Math.cos(y),
		cz = Math.cos(z);
	const sx = Math.sin(x),
		sy = Math.sin(y),
		sz = Math.sin(z);
	return [
		cy * sx * cz + sy * cx * sz,
		sy * cx * cz - cy * sx * sz,
		cy * cx * sz - sy * sx * cz,
		cy * cx * cz + sy * sx * sz,
	];
};

/**
 * @param parent column-major parent matrix
 * @param local column-major local matrix
 * @returns their product; neither input is modified
 */
export const multiplyMatrices = (parent: Float32Array, local: Float32Array): Float32Array => {
	const result = new Float32Array(16);
	for (let c = 0; c < 4; c++) {
		for (let r = 0; r < 4; r++) {
			for (let k = 0; k < 4; k++) {
				result[c * 4 + r] += parent[k * 4 + r] * local[c * 4 + k];
			}
		}
	}
	return result;
};

/**
 * @param bounds local axis-aligned bounds
 * @param matrix affine column-major matrix
 * @returns enclosing world bounds, including rotated and nonuniformly scaled extents
 */
export const transformBounds = (bounds: Aabb, matrix: Float32Array): Aabb => {
	const center: [number, number, number] = [0, 0, 0];
	const extents: [number, number, number] = [0, 0, 0];
	for (let r = 0; r < 3; r++) {
		center[r] = matrix[12 + r];
		for (let c = 0; c < 3; c++) {
			center[r] += matrix[c * 4 + r] * bounds.center[c];
			extents[r] += Math.abs(matrix[c * 4 + r]) * bounds.extents[c];
		}
	}
	return { center, extents };
};
