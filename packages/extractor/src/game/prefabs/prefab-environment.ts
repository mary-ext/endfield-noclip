/* oxlint-disable no-await-in-loop -- traverse in authored order with bounded bundle residency */
import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { DynamicModel } from '@endfield-noclip/formats/endfield/dynamic-resources';
import {
	EnvironmentVolumeType,
	type EnvironmentVolume,
	type PolyLineShape,
	yawRotation,
} from '@endfield-noclip/formats/endfield/environment-volume';
import {
	multiplyQuaternions,
	quaternionUnityEuler,
	unityEulerQuaternion,
} from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	booleanField,
	isObject,
	numberField,
	objectField,
	pptrField,
} from '@endfield-noclip/formats/unity/values';
import { conditionVisible } from '@endfield-noclip/package-format/conditions';

import { formatErrorOnly } from '../../errors.ts';
import type { AssetResolver, ObjectRef } from '../assets/assets.ts';
import type { SceneEnvironmentVolume } from '../environment.ts';
import type { Visibility } from '../state/scene-control.ts';

import type { PrefabRoots } from './prefab-root.ts';
import { PRUNE, walkPrefab } from './prefab-walk.ts';

// reads HGEnvironmentVolume components from gated prefabs; phases are PPtrs rather than path hashes.
// source layout: docs/game-data/environment.md#prefab-volumes.

/** an environment volume found in a prefab */
export interface PrefabEnvironmentVolume {
	/** `id` is 0 and `envPhase` `null`: prefab volumes have no entity id, and their phase is {@link phase} */
	volume: EnvironmentVolume;
	/** the `HGEnvironmentPhase` object, or `null` if unset */
	phase: ObjectRef | null;
}

/** a placement's transform: position, xyzw rotation, scale */
export interface Placement {
	position: readonly number[];
	rotation: readonly number[];
	scale: readonly number[];
}

/** a prefab a dynamic entity places, with when it loads */
export interface PlacedPrefab {
	model: DynamicModel;
	levelTag: number;
	visibility: Visibility;
}

/**
 * reads the environment volumes of placed prefabs. each volume belongs to its placement's level and loads
 * with its visibility
 *
 * @param roots the placed prefabs' roots
 * @param placements dynamic model placements
 * @param defaults every control's default value, to tell which volumes load by default
 * @returns the volumes, in placement order, and the prefabs that couldn't be read (path and reason)
 */
export const loadPlacedVolumes = async (
	roots: PrefabRoots,
	placements: readonly PlacedPrefab[],
	defaults: Readonly<Record<string, number>>,
): Promise<{ volumes: SceneEnvironmentVolume[]; unsupported: { path: string; reason: string }[] }> => {
	const volumes: SceneEnvironmentVolume[] = [];
	const unsupported: { path: string; reason: string }[] = [];
	for (const { model, levelTag, visibility } of placements) {
		// oxlint-disable-next-line no-await-in-loop -- placement order
		const { label, root } = await roots.root(model.pathHash);
		// oxlint-disable-next-line no-await-in-loop -- as above
		const found = await (root instanceof FormatError
			? root
			: readPrefabEnvironmentVolumes(roots.resolver, root, {
					position: model.position,
					rotation: unityEulerQuaternion(model.rotation),
					scale: model.scale,
				}).catch(formatErrorOnly));
		if (found instanceof FormatError) {
			unsupported.push({ path: label, reason: found.message });
			continue;
		}
		const loadedByDefault = conditionVisible(visibility, defaults);
		for (const { volume, phase } of found) {
			volumes.push({
				tag: levelTag,
				sceneStates: [],
				volume,
				phaseObject: phase,
				condition: visibility,
				loadedByDefault,
			});
		}
	}
	return { volumes, unsupported };
};

const xyz = (value: TypeTreeObject): [number, number, number] => [
	numberField(value, 'x'),
	numberField(value, 'y'),
	numberField(value, 'z'),
];

/** whether a MonoBehaviour's serialized fields are an `HGEnvironmentVolume`'s, without reading the object */
const isVolumeType = (ref: ObjectRef): boolean => {
	const names = new Set(ref.info.type?.nodes.filter((node) => node.level === 1).map((node) => node.name));
	return names.has('_volumeType') && names.has('_envPhase') && names.has('_polyLineShape');
};

/**
 * reads the enabled environment volumes of a prefab's active GameObjects. box volumes take the GameObject's
 * transform under the placement (rotation and scale composed per axis, which holds for the unrotated or
 * uniformly scaled hierarchies authored); prism shapes are stored in world coordinates as in chunk data, so a
 * prism under a placement that moves it is rejected
 *
 * @param resolver bundle reader
 * @param root prefab GameObject
 * @param placement where the prefab is placed
 * @returns the volumes in hierarchy order
 * @throws {FormatError} on a malformed hierarchy, or a prism under a placement other than the identity
 */
export const readPrefabEnvironmentVolumes = async (
	resolver: AssetResolver,
	root: ObjectRef,
	placement: Placement,
): Promise<PrefabEnvironmentVolume[]> => {
	const result: PrefabEnvironmentVolume[] = [];
	const identity =
		placement.position.every((v) => v === 0) &&
		placement.rotation.slice(0, 3).every((v) => v === 0) &&
		placement.scale.every((v) => v === 1);
	await walkPrefab<Placement>(
		resolver,
		root,
		{
			enter: (node, parent) => {
				if (!node.active) {
					return PRUNE;
				}
				// the root's own transform is the placement's
				if (node.isRoot) {
					return parent;
				}
				const { position, rotation, scale } = node.saved;
				const [px, py, pz] = rotate(parent.rotation, [
					position[0] * parent.scale[0],
					position[1] * parent.scale[1],
					position[2] * parent.scale[2],
				]);
				return {
					position: [parent.position[0] + px, parent.position[1] + py, parent.position[2] + pz],
					rotation: multiplyQuaternions(parent.rotation, rotation),
					scale: scale.map((s, i) => s * parent.scale[i]),
				};
			},
			visit: async (node, world) => {
				for (const component of node.behaviours(isVolumeType)) {
					const value = await component.read();
					if (!booleanField(value, 'm_Enabled')) {
						continue;
					}
					const volumeType = numberField(value, '_volumeType');
					const shape = readShape(objectField(value, '_polyLineShape'));
					if (shape !== null && volumeType === EnvironmentVolumeType.PolyArea && !identity) {
						throw new FormatError('prefab prism volume under a moved placement');
					}
					result.push({
						volume: {
							id: 0,
							name: node.name,
							transform: {
								position: [world.position[0], world.position[1], world.position[2]],
								rotation: quaternionUnityEuler(world.rotation),
								scale: [world.scale[0], world.scale[1], world.scale[2]],
							},
							volumeType,
							blendMode: numberField(value, '_blendMode'),
							priority: numberField(value, '_priority'),
							blendDistance: numberField(value, '_blendDistance'),
							fadeInDuration: numberField(value, '_fadeInDuration'),
							fadeOutDuration: numberField(value, '_fadeOutDuration'),
							envPhase: null,
							shape,
						},
						phase: await resolver.resolve(component.ref, pptrField(value, '_envPhase')),
					});
				}
			},
		},
		placement,
	);
	return result;
};

/** @returns `v` turned by the xyzw quaternion `q` */
const rotate = (q: readonly number[], v: readonly number[]): [number, number, number] => {
	const [x, y, z, w] = q;
	const [vx, vy, vz] = v;
	// t = 2 q.xyz × v; v' = v + w t + q.xyz × t
	const tx = 2 * (y * vz - z * vy),
		ty = 2 * (z * vx - x * vz),
		tz = 2 * (x * vy - y * vx);
	return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
};

/** the serialized `PolyLineShape`, read as the chunk blob is: points relative to the position, turned by yaw */
const readShape = (shape: TypeTreeObject): PolyLineShape | null => {
	const list = arrayField(shape, 'm_posList');
	if (list.length === 0) {
		return null;
	}
	const position = xyz(objectField(shape, 'm_position'));
	const rotation = xyz(objectField(shape, 'm_rotation'));
	const turn = yawRotation(rotation[1]);
	const points = list.map((point): [number, number] => {
		if (!isObject(point)) {
			throw new FormatError('polyline point is not an object');
		}
		const [x, z] = turn(numberField(point, 'x'), numberField(point, 'y'));
		return [position[0] + x, position[2] + z];
	});
	return {
		position,
		rotation,
		points,
		height: numberField(shape, 'm_height'),
		baseHeightOffset: numberField(shape, 'm_baseHeightOffset'),
	};
};
