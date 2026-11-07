/**
 * mesh particles that stand still: a particle system that emits one mesh particle and keeps it once its
 * lifetime ends (ring buffer mode) draws a fixed mesh, which the packer can place like a mesh renderer.
 * scenery uses these for slow effect shapes, such as the threads swirling over Wuling City's pillar array.
 *
 * @module
 */

import { multiplyMatrices, trsMatrix, unityEulerQuaternion } from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	type Aabb,
	booleanField,
	isObject,
	numberField,
	objectField,
	vector3Field,
} from '@endfield-noclip/formats/unity/values';
import {
	type MinMaxCurveInfo,
	ParticleAlignment,
	ParticleRenderMode,
	ParticleShapeKind,
} from '@endfield-noclip/package-format/particles';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { constantMidpoint, readStartPose, ScalingMode } from './particle-system.ts';

/** a Transform's local placement */
export interface LocalTransform {
	position: readonly number[];
	/** xyzw */
	rotation: readonly number[];
	scale: readonly number[];
}

/**
 * the matrix a played particle system's particles move in: its whole world matrix, except under the `Local`
 * scaling mode, which drops the parents' scale. the `Shape` mode keeps the hierarchy's scale here, since that
 * scale still moves its particles; only their size ignores it.
 *
 * @param parent the parent's world matrix
 * @param local the system's local transform
 * @param scalingMode `ParticleSystem.scalingMode`
 * @returns the emitter's world matrix
 */
export const particleEmitterMatrix = (
	parent: Float32Array,
	local: LocalTransform,
	scalingMode: number,
): Float32Array =>
	scalingMode === ScalingMode.Local
		? particleStandInMatrix(parent, local, ScalingMode.Local)
		: multiplyMatrices(parent, trsMatrix(local.position, local.rotation, local.scale));

/**
 * where a particle system the viewer can't play stands in: at its transform, sized as the game sizes its
 * particles. `Hierarchy` takes the whole hierarchy's scale, `Local` only the system's own and `Shape` none,
 * so a system whose parent stretches a wide spawn box doesn't stand in as a quad as wide as the box.
 *
 * @param parent the parent's world matrix
 * @param local the system's local transform
 * @param scalingMode `ParticleSystem.scalingMode`
 * @returns the stand-in's world matrix
 */
export const particleStandInMatrix = (
	parent: Float32Array,
	local: LocalTransform,
	scalingMode: number,
): Float32Array => {
	if (scalingMode === ScalingMode.Hierarchy) {
		return multiplyMatrices(parent, trsMatrix(local.position, local.rotation, local.scale));
	}
	const matrix = multiplyMatrices(parent, trsMatrix(local.position, local.rotation, [1, 1, 1]));
	// rescaling each axis to the system's own scale drops the parents' scale and keeps where the axes point
	return withAxisLengths(matrix, scalingMode === ScalingMode.Shape ? [1, 1, 1] : local.scale);
};

/**
 * @param matrix a 4×4 column-major matrix
 * @returns the lengths of its x, y and z axes
 */
export const axisLengths = (matrix: Float32Array): Vec3 => [
	Math.hypot(matrix[0], matrix[1], matrix[2]),
	Math.hypot(matrix[4], matrix[5], matrix[6]),
	Math.hypot(matrix[8], matrix[9], matrix[10]),
];

/**
 * @param matrix a 4×4 column-major matrix
 * @param lengths the length each of its x, y and z axes should have
 * @returns a copy whose axes point where the matrix's do, at those lengths
 */
export const withAxisLengths = (matrix: Float32Array, lengths: readonly number[]): Float32Array => {
	const out = new Float32Array(matrix);
	const current = axisLengths(matrix);
	for (let axis = 0; axis < 3; axis++) {
		const factor = current[axis] > 0 ? lengths[axis] / current[axis] : 0;
		for (let i = 0; i < 3; i++) {
			out[axis * 4 + i] *= factor;
		}
	}
	return out;
};

/**
 * a mesh particle's size at particle size 1, per axis, which its renderer's pivot is a multiple of: the
 * engine measures the mesh as twice its bounds' farthest reach from the origin along each axis
 *
 * @param bounds the mesh's `m_LocalAABB`
 * @returns the size per axis
 */
export const particleMeshSize = (bounds: Aabb): Vec3 => {
	const { center, extents } = bounds;
	const reach = (axis: number) => 2 * (Math.abs(center[axis]) + Math.abs(extents[axis]));
	return [reach(0), reach(1), reach(2)];
};

/**
 * @param pivot a mesh particle renderer's `m_Pivot`, in multiples of the mesh's size
 * @param meshSize the mesh's {@link particleMeshSize}
 * @returns the pivot in multiples of the particle's size, as `ParticleSystemInfo.pivot` keeps it
 */
export const meshParticlePivot = (pivot: readonly number[], meshSize: readonly number[]): Vec3 => [
	pivot[0] * meshSize[0],
	pivot[1] * meshSize[1],
	pivot[2] * meshSize[2],
];

/** @returns each curve's {@link constantMidpoint}, or `null` when any is a curve */
const midpoints = (curves: readonly MinMaxCurveInfo[]): number[] | null => {
	const values: number[] = [];
	for (const curve of curves) {
		const value = constantMidpoint(curve);
		if (value === null) {
			return null;
		}
		values.push(value);
	}
	return values;
};

/**
 * the placement of the one particle a frozen mesh particle system shows. the particle keeps its start size
 * and start rotation, at the shape's centre; the drift and spin it picks up over its lifetime are left out,
 * so the system's lifetime should be short against its speeds. the scaling mode sizes it as it sizes played
 * particles ({@link particleStandInMatrix}) and moves the shape's centre as {@link particleEmitterMatrix}
 * does. the renderer's pivot offsets the mesh within the particle, as for played particles.
 *
 * @param system the emitter's `ParticleSystem`
 * @param renderer its `ParticleSystemRenderer`
 * @param parent the emitter's parent's world matrix
 * @param emitter the emitter's local transform
 * @param meshSize the particle mesh's {@link particleMeshSize}
 * @returns the particle mesh's world matrix, or `null` when the system doesn't keep a single mesh particle
 *   from awake in a fixed orientation and look (camera-facing alignment, velocity alignment without a box
 *   shape, several particles, curves, a texture sheet)
 */
export const frozenParticleMatrix = (
	system: TypeTreeObject,
	renderer: TypeTreeObject,
	parent: Float32Array,
	emitter: LocalTransform,
	meshSize: readonly number[],
): Float32Array | null => {
	const initial = objectField(system, 'InitialModule');
	const shape = objectField(system, 'ShapeModule');
	if (
		numberField(renderer, 'm_RenderMode') !== ParticleRenderMode.Mesh ||
		// ring buffer mode 0 lets particles die at the end of their lifetime
		numberField(system, 'ringBufferMode') === 0 ||
		!booleanField(system, 'playOnAwake') ||
		numberField(initial, 'maxNumParticles') !== 1 ||
		// a flipbook changes the particle's tile as it ages, which a still mesh can't show
		(isObject(system['UVModule']) && booleanField(system['UVModule'], 'enabled'))
	) {
		return null;
	}
	const scalingMode = numberField(system, 'scalingMode');
	// the emitter's axes, each as long as the scale that sizes its particles
	const sizing = particleStandInMatrix(parent, emitter, scalingMode);
	let frame: Float32Array;
	switch (numberField(renderer, 'm_RenderAlignment')) {
		case ParticleAlignment.World: {
			// the world's axes, keeping the sizing scale
			const lengths = [0, 1, 2].map((axis) =>
				Math.hypot(sizing[axis * 4], sizing[axis * 4 + 1], sizing[axis * 4 + 2]),
			);
			frame = trsMatrix([0, 0, 0], [0, 0, 0, 1], lengths);
			break;
		}
		case ParticleAlignment.Local: {
			frame = sizing;
			break;
		}
		case ParticleAlignment.Velocity: {
			// a box sends its particles along the emitter's forward axis, so they face where the emitter does
			if (!booleanField(shape, 'enabled') || numberField(shape, 'type') !== ParticleShapeKind.Box) {
				return null;
			}
			frame = sizing;
			break;
		}
		default: {
			return null;
		}
	}
	const pose = readStartPose(initial);
	const size = midpoints(pose.startSize);
	const angles = midpoints(pose.startRotation);
	if (size === null || angles === null) {
		return null;
	}
	const degrees = angles.map((radians) => (radians * 180) / Math.PI);
	// the shape's centre moves with the emitter's matrix, as played particles do
	const [x, y, z] = booleanField(shape, 'enabled') ? vector3Field(shape, 'm_Position') : [0, 0, 0];
	const moving = particleEmitterMatrix(parent, emitter, scalingMode);
	const placed = Float32Array.from(frame);
	for (let r = 0; r < 3; r++) {
		placed[12 + r] = moving[r] * x + moving[4 + r] * y + moving[8 + r] * z + moving[12 + r];
	}
	// the pivot moves the mesh in the particle's turned and sized frame
	const pivot = meshParticlePivot(vector3Field(renderer, 'm_Pivot'), meshSize);
	return multiplyMatrices(
		multiplyMatrices(placed, trsMatrix([0, 0, 0], unityEulerQuaternion(degrees), size)),
		trsMatrix(pivot, [0, 0, 0, 1], [1, 1, 1]),
	);
};
