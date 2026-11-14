import {
	inverseAffine,
	multiplyMatrices,
	trsMatrix,
	transformBounds,
} from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { arrayField, asPPtr, isObject, numberField, type Aabb } from '@endfield-noclip/formats/unity/values';
import type { ParticleEmitterMotion } from '@endfield-noclip/package-format/particles';

import { objectKey, type AssetResolver, type ObjectRef } from '../assets/assets.ts';
import type { LocalTransform } from '../effects/particle-mesh.ts';

import { type ClipPaths, posedLocal } from './pose-paths.ts';
import type { PrefabPose, SkinMotion } from './prefab.ts';

// a prefab's skinned renderers in their authored pose, and its Transforms posed again at each frame of a
// looping clip

/** bone matrices that move less than this between frames hold still */
const STILL = 1e-5;

/** a Transform as the renderer walk met it, for posing it again at each frame of a clip */
export interface PosedNode {
	/** the Transform's {@link objectKey} */
	key: string;
	/** the parent Transform's key, `null` for the prefab root */
	parent: string | null;
	/** the local transform as saved */
	saved: LocalTransform;
	/** the GameObject's {@link ClipPaths} */
	below: ClipPaths;
}

/** a skinned renderer posed by {@link poseSkin} */
export interface PosedSkin {
	skin: Float32Array[];
	bounds: Aabb;
	/** per bone, its Transform's {@link objectKey} */
	bones: string[];
	/** per bone, its bind pose */
	binds: Float32Array[];
}

/** every Transform's prefab-space matrix at each frame of a pose's looping clip */
export interface PoseFrames {
	frameRate: number;
	/** per frame, by Transform key */
	matrices: Map<string, Float32Array>[];
}

const boxBounds = (min: readonly number[], max: readonly number[]): Aabb => ({
	center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
	extents: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
});

/**
 * bakes a skinned renderer's authored pose: each bone's prefab-space matrix times its bind pose
 *
 * @param resolver bundle reader
 * @param renderer the SkinnedMeshRenderer
 * @param mesh its mesh's fields
 * @param meshBounds the mesh's own bounds
 * @param transforms every Transform's prefab-space matrix, by key
 * @returns the bone matrices, the bounds every weighted position lies in, and per bone its Transform's key
 *   and bind pose; or why the skeleton can't be posed
 */
export const poseSkin = async (
	resolver: AssetResolver,
	renderer: { ref: ObjectRef; data: TypeTreeObject },
	mesh: TypeTreeObject,
	meshBounds: Aabb,
	transforms: ReadonlyMap<string, Float32Array>,
): Promise<PosedSkin | { reason: string }> => {
	const bones = arrayField(renderer.data, 'm_Bones');
	const bindPoses = arrayField(mesh, 'm_BindPose');
	if (bones.length !== bindPoses.length || bones.length === 0) {
		return { reason: 'invalid skeleton' };
	}
	const skin: Float32Array[] = [];
	const boneKeys: string[] = [];
	const binds: Float32Array[] = [];
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const [i, pointer] of bones.entries()) {
		// oxlint-disable-next-line no-await-in-loop -- bones are few and their reads cached
		const bone = await resolver.resolve(renderer.ref, asPPtr(pointer));
		const boneMatrix = bone && transforms.get(objectKey(bone));
		const bind = bindPoses[i];
		if (!boneMatrix || !isObject(bind)) {
			return { reason: 'unresolved bone' };
		}
		const bindMatrix = new Float32Array(
			Array.from({ length: 16 }, (_, k) => numberField(bind, 'e' + (k % 4) + Math.floor(k / 4))),
		);
		const posed = multiplyMatrices(boneMatrix, bindMatrix);
		skin.push(posed);
		boneKeys.push(objectKey(bone));
		binds.push(bindMatrix);
		const transformed = transformBounds(meshBounds, posed);
		for (let axis = 0; axis < 3; axis++) {
			min[axis] = Math.min(min[axis], transformed.center[axis] - transformed.extents[axis]);
			max[axis] = Math.max(max[axis], transformed.center[axis] + transformed.extents[axis]);
		}
	}
	// weighted positions lie inside this union, including poses whose bones move beyond the bind bounds
	return { skin, bounds: boxBounds(min, max), bones: boneKeys, binds };
};

/**
 * poses the prefab's Transforms at each frame of the pose's first looping clip that moves any; the pose's
 * other clips hold their end poses, and its looping clips play on those frames
 *
 * @param nodes the walk's Transforms, parents first
 * @param pose the pose the walk drew
 * @returns the frames, or `null` when nothing keeps moving a Transform
 */
export const poseFrames = (nodes: readonly PosedNode[], pose: PrefabPose): PoseFrames | null => {
	const playing = pose.clips.find(
		(clip) => clip.motion !== null && clip.motion.loops && clip.motion.paths.length > 0,
	)?.motion;
	if (playing === undefined || playing === null || playing.duration <= 0 || playing.sampleRate <= 0) {
		return null;
	}
	const frameRate = playing.sampleRate;
	const frameCount = Math.max(Math.round(playing.duration * frameRate), 1);
	const matrices: Map<string, Float32Array>[] = [];
	for (let frame = 0; frame < frameCount; frame++) {
		const time = frame / frameRate;
		const sampled = pose.clips.map((clip) =>
			clip.motion?.loops === true ? clip.motion.sample(time % clip.motion.duration) : clip.transforms,
		);
		const posed = new Map<string, Float32Array>();
		for (const node of nodes) {
			const parent = node.parent === null ? undefined : posed.get(node.parent);
			if (parent === undefined) {
				// the root keeps the caller's placement
				posed.set(node.key, trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]));
				continue;
			}
			const local = posedLocal(node.saved, sampled, node.below);
			posed.set(node.key, multiplyMatrices(parent, trsMatrix(local.position, local.rotation, local.scale)));
		}
		matrices.push(posed);
	}
	return { frameRate, matrices };
};

/**
 * @param frames the prefab's Transforms at each frame of its looping clip
 * @param posed the renderer's skeleton: per bone, its Transform's key and bind pose
 * @param meshBounds the mesh's own bounds
 * @returns the bones' skinning matrices at each frame and the bounds they keep the mesh in, or `null` when no
 *   bone moves
 */
export const skinMotion = (
	frames: PoseFrames,
	posed: Pick<PosedSkin, 'bones' | 'binds'>,
	meshBounds: Aabb,
): { motion: SkinMotion; bounds: Aabb } | null => {
	const boneCount = posed.bones.length;
	const frameCount = frames.matrices.length;
	const matrices = new Float32Array(frameCount * boneCount * 12);
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	let moves = false;
	for (const [frame, byKey] of frames.matrices.entries()) {
		for (let bone = 0; bone < boneCount; bone++) {
			const boneMatrix = byKey.get(posed.bones[bone]);
			if (boneMatrix === undefined) {
				return null;
			}
			const skin = multiplyMatrices(boneMatrix, posed.binds[bone]);
			const at = (frame * boneCount + bone) * 12;
			// column-major to rows3x4
			for (let row = 0; row < 3; row++) {
				for (let column = 0; column < 4; column++) {
					matrices[at + row * 4 + column] = skin[column * 4 + row];
				}
			}
			for (let k = 0; k < 12; k++) {
				moves ||= Math.abs(matrices[at + k] - matrices[bone * 12 + k]) > STILL;
			}
			const box = transformBounds(meshBounds, skin);
			for (let axis = 0; axis < 3; axis++) {
				min[axis] = Math.min(min[axis], box.center[axis] - box.extents[axis]);
				max[axis] = Math.max(max[axis], box.center[axis] + box.extents[axis]);
			}
		}
	}
	if (!moves) {
		return null;
	}
	return {
		motion: { boneCount, frameCount, frameRate: frames.frameRate, matrices },
		bounds: boxBounds(min, max),
	};
};

/** the most frames a second an emitter's motion keeps: emission points between them barely differ */
const EMITTER_FRAME_RATE = 30;

/**
 * @param frames the prefab's Transforms at each frame of its looping clip
 * @param emitter the system's Transform key, its prefab-space matrix as the walk placed it (the clip's end
 *   pose), the emitter matrix its draw is placed with, and whether its particles are simulated in the world
 * @param reach the bounds its particles reach, in the emitter's frame
 * @returns the emitter's motion relative to its draw's frame and the bounds its particles reach in that frame
 *   over the whole clip, or `null` when the clip doesn't move it
 */
export const emitterMotion = (
	frames: PoseFrames,
	emitter: { transform: string; placed: Float32Array; matrix: Float32Array; inWorld: boolean },
	reach: Aabb,
): { motion: ParticleEmitterMotion; bounds: Aabb } | null => {
	const step = Math.max(Math.round(frames.frameRate / EMITTER_FRAME_RATE), 1);
	// the emitter matrix is the Transform's times a fixed correction (a scaling mode dropping the parents'
	// scale), so the Transform's motion, seen from the emitter's frame, is the emitter's
	const toEmitter = inverseAffine(emitter.matrix);
	const fromPlaced = multiplyMatrices(inverseAffine(emitter.placed), emitter.matrix);
	const values: number[] = [];
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	let moves = false;
	for (let frame = 0; frame < frames.matrices.length; frame += step) {
		const transform = frames.matrices[frame].get(emitter.transform);
		if (transform === undefined) {
			return null;
		}
		const relative = multiplyMatrices(toEmitter, multiplyMatrices(transform, fromPlaced));
		// column-major to rows3x4, rounded: the motion is stored in the package's JSON
		for (let row = 0; row < 3; row++) {
			for (let column = 0; column < 4; column++) {
				const value = Math.round(relative[column * 4 + row] * 1e5) / 1e5;
				moves ||= Math.abs(value - (row === column ? 1 : 0)) > STILL;
				values.push(value);
			}
		}
		const box = transformBounds(reach, relative);
		for (let axis = 0; axis < 3; axis++) {
			min[axis] = Math.min(min[axis], box.center[axis] - box.extents[axis]);
			max[axis] = Math.max(max[axis], box.center[axis] + box.extents[axis]);
		}
	}
	if (!moves) {
		return null;
	}
	return {
		motion: { inWorld: emitter.inWorld, frameRate: frames.frameRate / step, frames: values },
		bounds: boxBounds(min, max),
	};
};
