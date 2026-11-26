/* oxlint-disable no-await-in-loop -- traverse in authored order with bounded bundle residency */
import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { DynamicModel } from '@endfield-noclip/formats/endfield/dynamic-scene';
import {
	EnvironmentVolumeType,
	type EnvironmentVolume,
	type PolyLineShape,
	yawRotation,
} from '@endfield-noclip/formats/endfield/environment-volume';
import type { SerializedType } from '@endfield-noclip/formats/unity/serialized-file';
import {
	multiplyQuaternions,
	quaternionUnityEuler,
	unityEulerQuaternion,
} from '@endfield-noclip/formats/unity/transform';
import { hasTypeFields, type TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	booleanField,
	numberField,
	objectField,
	objectsField,
	pptrField,
	vector3Field,
} from '@endfield-noclip/formats/unity/values';
import { conditionVisible } from '@endfield-noclip/package-format/conditions';

import { unique } from '@mary-ext/array-fns';

import { formatErrorOnly } from '../../errors.ts';
import {
	bundleSources,
	relocateSaved,
	type SavedLocator,
	saveLocated,
	sourcesCurrent,
} from '../../ir/bundle-memo.ts';
import type { BundleSource, MemoCache } from '../../ir/cache.ts';
import { mapPool } from '../../pool.ts';
import {
	type AssetResolver,
	type LocatedObject,
	locatedObject,
	type ObjectRef,
	recordBundleReads,
} from '../assets/assets.ts';
import type { SceneEnvironmentVolume } from '../environment.ts';
import type { Visibility } from '../state/scene-control.ts';

import type { PrefabRoots } from './prefab-root.ts';
import { PRUNE, walkPrefab } from './prefab-walk.ts';

/** unique prefab roots resolved in parallel while scanning for environment volumes */
const PREFAB_CONCURRENCY = 16;

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

const PREFAB_ENV_ENTRY = new URL(import.meta.url);

/** a prefab's environment volume in prefab-local space, independent of placement */
interface LocalPrefabVolume {
	name: string;
	local: Placement;
	volumeType: number;
	blendMode: number;
	priority: number;
	blendDistance: number;
	fadeInDuration: number;
	fadeOutDuration: number;
	shape: PolyLineShape | null;
	phase: LocatedObject | null;
}

interface SavedLocalPrefabVolume extends Omit<LocalPrefabVolume, 'phase'> {
	phase: SavedLocator | null;
}

interface PrefabVolumesMemo {
	label: string;
	sources: BundleSource[];
	volumes: SavedLocalPrefabVolume[];
}

const IDENTITY_PLACEMENT: Placement = {
	position: [0, 0, 0],
	rotation: [0, 0, 0, 1],
	scale: [1, 1, 1],
};

const composePlacement = (parent: Placement, local: Placement): Placement => {
	const [px, py, pz] = rotate(parent.rotation, [
		local.position[0] * parent.scale[0],
		local.position[1] * parent.scale[1],
		local.position[2] * parent.scale[2],
	]);
	return {
		position: [parent.position[0] + px, parent.position[1] + py, parent.position[2] + pz],
		rotation: multiplyQuaternions(parent.rotation, local.rotation),
		scale: local.scale.map((s, i) => s * parent.scale[i]),
	};
};

const isIdentityPlacement = (placement: Placement): boolean =>
	placement.position.every((v) => v === 0) &&
	placement.rotation.slice(0, 3).every((v) => v === 0) &&
	placement.scale.every((v) => v === 1);

const readLocalVolumes = async (resolver: AssetResolver, root: ObjectRef): Promise<LocalPrefabVolume[]> => {
	if (!fileMayHaveVolumes(root)) {
		return [];
	}
	const result: LocalPrefabVolume[] = [];
	await walkPrefab<Placement>(
		resolver,
		root,
		{
			enter: (node, parent) => {
				if (!node.active) {
					return PRUNE;
				}
				if (node.isRoot) {
					return parent;
				}
				return composePlacement(parent, node.saved);
			},
			visit: async (node, local) => {
				for (const component of node.behaviours(isVolumeType)) {
					const value = await component.read();
					if (!booleanField(value, 'm_Enabled')) {
						continue;
					}
					const phaseRef = await resolver.resolve(component.ref, pptrField(value, '_envPhase'));
					result.push({
						name: node.name,
						local,
						volumeType: numberField(value, '_volumeType'),
						blendMode: numberField(value, '_blendMode'),
						priority: numberField(value, '_priority'),
						blendDistance: numberField(value, '_blendDistance'),
						fadeInDuration: numberField(value, '_fadeInDuration'),
						fadeOutDuration: numberField(value, '_fadeOutDuration'),
						shape: readShape(objectField(value, '_polyLineShape')),
						phase: phaseRef === null ? null : locatedObject(phaseRef),
					});
				}
			},
		},
		IDENTITY_PLACEMENT,
	);
	return result;
};

const placeLocalVolumes = (
	localVolumes: readonly LocalPrefabVolume[],
	placement: Placement,
): { volume: EnvironmentVolume; phase: LocatedObject | null }[] => {
	const identity = isIdentityPlacement(placement);
	return localVolumes.map((entry) => {
		if (entry.shape !== null && entry.volumeType === EnvironmentVolumeType.PolyArea && !identity) {
			throw new FormatError('prefab prism volume under a moved placement');
		}
		const world = composePlacement(placement, entry.local);
		return {
			volume: {
				id: 0,
				name: entry.name,
				transform: {
					position: [world.position[0], world.position[1], world.position[2]],
					rotation: quaternionUnityEuler(world.rotation),
					scale: [world.scale[0], world.scale[1], world.scale[2]],
				},
				volumeType: entry.volumeType,
				blendMode: entry.blendMode,
				priority: entry.priority,
				blendDistance: entry.blendDistance,
				fadeInDuration: entry.fadeInDuration,
				fadeOutDuration: entry.fadeOutDuration,
				envPhase: null,
				shape: entry.shape,
			},
			phase: entry.phase,
		};
	});
};

/**
 * reads the environment volumes of placed prefabs. each volume belongs to its placement's level and loads
 * with its visibility
 *
 * @param roots the placed prefabs' roots
 * @param placements dynamic model placements
 * @param defaults every control's default value, to tell which volumes load by default
 * @param cache optional pack cache for per-prefab local volumes
 * @returns the volumes, in placement order, and the prefabs that couldn't be read (path and reason)
 */
export const loadPlacedVolumes = async (
	roots: PrefabRoots,
	placements: readonly PlacedPrefab[],
	defaults: Readonly<Record<string, number>>,
	cache: MemoCache | null = null,
): Promise<{ volumes: SceneEnvironmentVolume[]; unsupported: { path: string; reason: string }[] }> => {
	const { resolver } = roots;
	const fp = cache === null ? null : await cache.fingerprint(PREFAB_ENV_ENTRY);
	const uniqueHashes = unique(placements.map(({ model }) => model.pathHash));
	const loadedList = await mapPool(uniqueHashes, PREFAB_CONCURRENCY, async (hash) => {
		const memoKey =
			cache === null || fp === null ? null : cache.keyWith(fp, { kind: 'prefabEnvVolumes', hash });
		if (memoKey !== null) {
			const recalled = await cache!.recallValue<PrefabVolumesMemo>(memoKey);
			if (recalled !== undefined && (await sourcesCurrent(resolver, recalled.sources))) {
				const relocated: LocalPrefabVolume[] = [];
				let ok = true;
				for (const item of recalled.volumes) {
					if (item.phase === null) {
						relocated.push({ ...item, phase: null });
					} else {
						const phase = relocateSaved(resolver.manifest, item.phase);
						if (phase === undefined) {
							ok = false;
							break;
						}
						relocated.push({ ...item, phase });
					}
				}
				if (ok) {
					return { label: recalled.label, read: relocated as LocalPrefabVolume[] | FormatError };
				}
			}
		}
		const { result: loaded, bundles } = await recordBundleReads(async () => {
			const { label, root } = await roots.root(hash);
			if (root instanceof FormatError) {
				return { label, read: root as LocalPrefabVolume[] | FormatError };
			}
			const read = await readLocalVolumes(resolver, root).catch(formatErrorOnly);
			return { label, read };
		});
		if (memoKey !== null && !(loaded.read instanceof FormatError)) {
			await cache!.rememberValue(memoKey, {
				label: loaded.label,
				sources: await bundleSources(resolver, bundles),
				volumes: loaded.read.map((item) => ({
					...item,
					phase: item.phase === null ? null : saveLocated(resolver.manifest, item.phase),
				})),
			} satisfies PrefabVolumesMemo);
		}
		return loaded;
	});
	const byHash = new Map(uniqueHashes.map((hash, i) => [hash, loadedList[i]]));

	const volumes: SceneEnvironmentVolume[] = [];
	const unsupported: { path: string; reason: string }[] = [];
	for (const { model, levelTag, visibility } of placements) {
		const { label, read } = byHash.get(model.pathHash)!;
		if (read instanceof FormatError) {
			unsupported.push({ path: label, reason: read.message });
			continue;
		}
		if (read.length === 0) {
			continue;
		}
		let placed: { volume: EnvironmentVolume; phase: LocatedObject | null }[];
		try {
			placed = placeLocalVolumes(read, {
				position: model.position,
				rotation: unityEulerQuaternion(model.rotation),
				scale: model.scale,
			});
		} catch (error) {
			if (error instanceof FormatError) {
				unsupported.push({ path: label, reason: error.message });
				continue;
			}
			throw error;
		}
		const loadedByDefault = conditionVisible(visibility, defaults);
		for (const { volume, phase } of placed) {
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

/** whether a SerializedFile type has the serialized fields of an `HGEnvironmentVolume` */
const isVolumeSerializedType = (type: SerializedType | undefined): boolean =>
	hasTypeFields(type, '_volumeType', '_envPhase', '_polyLineShape');

/** whether a MonoBehaviour's serialized fields are an `HGEnvironmentVolume`'s, without reading the object */
const isVolumeType = (ref: ObjectRef): boolean => isVolumeSerializedType(ref.info.type);

/**
 * fast pre-check: a prefab's GameObject and MonoBehaviour components are serialized in its own
 * SerializedFile, so one whose type table declares no `HGEnvironmentVolume` cannot contain an environment
 * volume
 */
const fileMayHaveVolumes = (root: ObjectRef): boolean => root.file.file.types.some(isVolumeSerializedType);

/**
 * reads the enabled environment volumes of a prefab's active GameObjects. box volumes take the GameObject's
 * transform under the placement, composed per axis: exact only for unrotated or uniformly scaled hierarchies.
 * prism shapes are in world coordinates, so one under a placement that moves it is rejected
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
	const list = objectsField(shape, 'm_posList');
	if (list.length === 0) {
		return null;
	}
	const position = vector3Field(shape, 'm_position');
	const rotation = vector3Field(shape, 'm_rotation');
	const turn = yawRotation(rotation[1]);
	const points = list.map((point): [number, number] => {
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
