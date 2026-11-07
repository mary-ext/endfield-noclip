import {
	EnvironmentVolumeType,
	type EnvironmentVolume,
	type PostVolume,
	readEnvironmentVolume,
	readPostVolume,
} from '@endfield-noclip/formats/endfield/environment-volume';
import { levelTagOf, type PartitionLevel } from '@endfield-noclip/formats/endfield/level-partition';
import { CELL_SIZE } from '@endfield-noclip/formats/endfield/map-config';
import {
	hasMonoComponents,
	MonoComponentType,
	readMonoObjects,
} from '@endfield-noclip/formats/endfield/mono-objects';
import {
	mapSections,
	type EnvironmentPhase,
	type EnvironmentSection,
	type EnvironmentSectionName,
	readEnvironmentPhase,
} from '@endfield-noclip/formats/hg/environment-phase';
import { type PlainObject, toPlainObject } from '@endfield-noclip/formats/unity/plain-object';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { arrayField, asPPtr, stringField } from '@endfield-noclip/formats/unity/values';
import type { EnvironmentBlend, EnvironmentVolumeShape } from '@endfield-noclip/package-format/environment';
import { compareVolumes, volumeFootprintContains } from '@endfield-noclip/package-format/environment-volumes';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { mapDefined } from '@mary-ext/array-fns';

import { mapPool } from '../pool.ts';

import type { AssetResolver, ObjectRef } from './assets/assets.ts';
import type { Visibility } from './state/scene-control.ts';
import type { WorldIndex } from './world/world-index.ts';

// which environment a level is lit by. the game has no per-level setting, only environment volumes blended by
// priority at the camera, so a level's base environment is the volume that wins over most of the level's
// cells (docs/extraction/environments.md#the-levels-base-environment); `world env <level>` shows the vote.

// #region scene volumes

/** a volume with the level tag of its entity id and the scene states it loads with */
export interface TaggedVolume<T> {
	tag: number;
	/**
	 * MapConfig scene state indices of the chunk files holding it, any of which loads it; empty if always
	 * loaded
	 */
	sceneStates: number[];
	volume: T;
}

/**
 * an environment volume with its level tag and load conditions: a chunk object, or one a placed prefab
 * carries (`prefab-environment.ts`)
 */
export interface SceneEnvironmentVolume extends TaggedVolume<EnvironmentVolume> {
	/** a prefab volume's `HGEnvironmentPhase` object (its `envPhase` is `null`); `null` for chunk volumes */
	phaseObject: ObjectRef | null;
	/** a prefab volume's load condition (its placing entity's), `null` for chunk volumes */
	condition: Visibility | null;
	/** whether {@link condition} holds under the default scene values; true without one */
	loadedByDefault: boolean;
}

/** every environment and post-processing volume of a scene's default stream area, in any scene state */
export interface SceneVolumes {
	environment: SceneEnvironmentVolume[];
	post: TaggedVolume<PostVolume>[];
}

/** chunk files read at once */
const READ_CONCURRENCY = 16;

const VOLUME_COMPONENTS = BigInt(MonoComponentType.HGEnvironmentVolume | MonoComponentType.Volume);

/**
 * reads the environment and post volumes of a scene's default-area chunks (Init with its paired Streaming
 * file), each once, with the scene states whose files hold them
 *
 * @param world world index
 * @param scene streaming scene
 * @returns the volumes, in chunk-file order
 */
export const loadSceneVolumes = async (world: WorldIndex, scene: string): Promise<SceneVolumes> => {
	const files = (await world.chunkFiles()).filter((file) => file.scene === scene && file.area === 0);
	const perFile = await mapPool(files, READ_CONCURRENCY, async (file) => {
		const init = await world.readInitPayload(file);
		if (!hasMonoComponents(init, VOLUME_COMPONENTS)) {
			return [];
		}
		return readMonoObjects(init, await world.readStreamingPayload(file));
	});

	const volumes: SceneVolumes = { environment: [], post: [] };
	// a volume is repeated in every cell chunk it overlaps; the files' scene state ids are collected per volume
	const fileStates = new Map<number, Set<number>>();
	for (const [i, objects] of perFile.entries()) {
		for (const object of objects) {
			const known = fileStates.get(object.id);
			if (known !== undefined) {
				known.add(files[i].sceneState);
				continue;
			}
			const environment = readEnvironmentVolume(object);
			const post = readPostVolume(object);
			if (environment === undefined && post === undefined) {
				continue;
			}
			const states = new Set([files[i].sceneState]);
			fileStates.set(object.id, states);
			const tag = levelTagOf(object.id);
			// scene states are filled in below, once every file was seen
			if (environment !== undefined) {
				volumes.environment.push({
					tag,
					sceneStates: [],
					volume: environment,
					phaseObject: null,
					condition: null,
					loadedByDefault: true,
				});
			}
			if (post !== undefined) {
				volumes.post.push({ tag, sceneStates: [], volume: post });
			}
		}
	}
	for (const entry of [...volumes.environment, ...volumes.post]) {
		const states = fileStates.get(entry.volume.id)!;
		if (!states.has(0)) {
			entry.sceneStates.push(...[...states].map((id) => id - 1).toSorted((a, b) => a - b));
		}
	}
	return volumes;
};

/**
 * @param entry a volume
 * @param enabled MapConfig scene state indices taken as active
 * @returns whether the volume is loaded with those states
 */
export const volumeLoaded = (
	entry: Pick<TaggedVolume<unknown>, 'sceneStates'>,
	enabled: ReadonlySet<number>,
): boolean => entry.sceneStates.length === 0 || entry.sceneStates.some((index) => enabled.has(index));

// #endregion

// #region level resolution

/** samples per cell edge; 4 gives a 32 m grid */
const SAMPLES_PER_CELL = 4;

/** how much of a level a volume covers */
export interface VolumeShare {
	volume: EnvironmentVolume;
	/** samples inside it */
	covered: number;
	/** samples where it has the highest priority, so it's what the game shows there */
	wins: number;
}

/** how a level's base environment was chosen */
export interface LevelEnvironmentChoice {
	/** the base volume, or `null` if no volume of the level covers any sample */
	volume: EnvironmentVolume | null;
	/** the scene's global volume, which the level's phase leaves inactive sections to */
	global: EnvironmentVolume | null;
	/** every volume of the level that covers a sample, the base first, then by coverage */
	shares: VolumeShare[];
	/** samples taken */
	samples: number;
}

/**
 * chooses a base environment by 2D coverage of the level's cells, falling back to the scene's global volume.
 * respects scene-state and default prefab loading, but assumes loaded volumes are enabled by scripts.
 * sampling and tie rules: `docs/extraction/environments.md#the-levels-base-environment`.
 *
 * @param level ownership tag and cells to sample
 * @param volumes the scene's volumes
 * @param enabled MapConfig scene state indices taken as active
 * @returns the selected volume (null without a candidate or global volume), global fallback and per-volume
 *   coverage
 */
export const resolveLevelEnvironment = (
	level: Pick<PartitionLevel, 'tag'> & { config: Pick<PartitionLevel['config'], 'levelGrids'> },
	volumes: SceneVolumes,
	enabled: ReadonlySet<number>,
): LevelEnvironmentChoice => {
	const loaded = volumes.environment.filter((entry) => entry.loadedByDefault && volumeLoaded(entry, enabled));
	const global =
		loaded.find(({ tag, volume }) => tag === 0 && volume.volumeType === EnvironmentVolumeType.Global)
			?.volume ?? null;
	const candidates = mapDefined(loaded, ({ tag, volume }) => {
		const shape = tag === level.tag ? environmentVolumeShape(volume) : null;
		return shape === null || typeof shape === 'string'
			? undefined
			: { volume, stacking: { priority: volume.priority, shape }, share: { volume, covered: 0, wins: 0 } };
	});

	let samples = 0;
	for (const cell of level.config.levelGrids ?? []) {
		for (let i = 0; i < SAMPLES_PER_CELL; i++) {
			for (let j = 0; j < SAMPLES_PER_CELL; j++) {
				const x = (cell.x + (i + 0.5) / SAMPLES_PER_CELL) * CELL_SIZE;
				const z = (cell.z + (j + 0.5) / SAMPLES_PER_CELL) * CELL_SIZE;
				samples++;
				let best: (typeof candidates)[number] | null = null;
				for (const candidate of candidates) {
					if (!volumeFootprintContains(candidate.stacking.shape, x, z)) {
						continue;
					}
					candidate.share.covered++;
					// the volume stacked on top is shown; on a full tie the later one, as in the viewer's blend
					if (best === null || compareVolumes(candidate.stacking, best.stacking) >= 0) {
						best = candidate;
					}
				}
				if (best !== null) {
					best.share.wins++;
				}
			}
		}
	}
	const shares = mapDefined(candidates, ({ share }) => (share.covered > 0 ? share : undefined));
	shares.sort(
		(a, b) => b.covered - a.covered || a.volume.priority - b.volume.priority || a.volume.id - b.volume.id,
	);
	// require at least one priority win, then choose by total coverage, not win count
	const base = shares.find((share) => share.wins > 0);
	return {
		volume: base?.volume ?? global,
		global,
		shares: base === undefined ? shares : [base, ...shares.filter((share) => share !== base)],
		samples,
	};
};

/**
 * picks a level's post-processing profile: its own global `Volume`, else the scene's, highest priority first
 *
 * @param level the level
 * @param volumes the scene's volumes
 * @param enabled MapConfig scene state indices taken as active
 * @returns the volume, or `null` if neither exists
 */
export const resolveLevelPost = (
	level: Pick<PartitionLevel, 'tag'>,
	volumes: SceneVolumes,
	enabled: ReadonlySet<number>,
): PostVolume | null => {
	const globals = volumes.post.filter(
		(entry) => entry.volume.isGlobal && entry.volume.profile !== null && volumeLoaded(entry, enabled),
	);
	const pick = (tag: number) =>
		globals.filter((entry) => entry.tag === tag).toSorted((a, b) => b.volume.priority - a.volume.priority)[0]
			?.volume;
	return pick(level.tag) ?? pick(0) ?? null;
};

/**
 * @param volume an environment volume
 * @returns how it blends in, by its `_blendMode` (the game's `EnvBlendMode`: 0 none, 1 distance, 2 time, 3
 *   manual), or why the mode isn't understood
 */
export const environmentBlend = (volume: EnvironmentVolume): EnvironmentBlend | string => {
	switch (volume.blendMode) {
		case 0: {
			return { kind: 'replace' };
		}
		case 1: {
			return { kind: 'depth', distance: volume.blendDistance };
		}
		case 2: {
			return { kind: 'fade', fadeIn: volume.fadeInDuration, fadeOut: volume.fadeOutDuration };
		}
		case 3: {
			return { kind: 'scripted' };
		}
		default: {
			return `unknown blend mode ${volume.blendMode}`;
		}
	}
};

/**
 * @param position a box volume's transform position
 * @param rotation its Euler angles, degrees, which Unity applies z, then x, then y
 * @param scale its scale
 * @returns the unit cube under the transform, which is what a box volume covers
 */
export const unitCubeShape = (
	position: Vec3,
	rotation: Vec3,
	scale: Vec3,
): Extract<EnvironmentVolumeShape, { kind: 'box' }> => {
	const [rx, ry, rz] = rotation.map((degrees) => (degrees * Math.PI) / 180);
	// undoes the rotation: inverse yaw, then pitch, then roll
	const toBox = ([vx, vy, vz]: Vec3): Vec3 => {
		let [x, y, z] = [vx, vy, vz];
		[x, z] = [x * Math.cos(ry) - z * Math.sin(ry), x * Math.sin(ry) + z * Math.cos(ry)];
		[y, z] = [y * Math.cos(rx) + z * Math.sin(rx), -y * Math.sin(rx) + z * Math.cos(rx)];
		[x, y] = [x * Math.cos(rz) + y * Math.sin(rz), -x * Math.sin(rz) + y * Math.cos(rz)];
		return [x, y, z];
	};
	// the images of the world axes are the matrix's columns
	const [cx, cy, cz] = [toBox([1, 0, 0]), toBox([0, 1, 0]), toBox([0, 0, 1])];
	return {
		kind: 'box',
		center: [...position],
		toBox: [cx[0], cy[0], cz[0], cx[1], cy[1], cz[1], cx[2], cy[2], cz[2]],
		halfExtents: [Math.abs(scale[0]) / 2, Math.abs(scale[1]) / 2, Math.abs(scale[2]) / 2],
	};
};

/**
 * @param volume an environment volume
 * @returns where it applies, or why its shape isn't understood
 */
export const environmentVolumeShape = (volume: EnvironmentVolume): EnvironmentVolumeShape | string => {
	switch (volume.volumeType) {
		case EnvironmentVolumeType.Global: {
			return { kind: 'global' };
		}
		case EnvironmentVolumeType.Box: {
			const transform = volume.transform;
			return transform === null
				? 'box volume without a transform'
				: unitCubeShape(transform.position, transform.rotation, transform.scale);
		}
		case EnvironmentVolumeType.PolyArea: {
			const shape = volume.shape;
			if (shape === null || shape.points.length < 3) {
				return `polygon volume with ${shape?.points.length ?? 0} points`;
			}
			const bottom = shape.position[1] + shape.baseHeightOffset;
			return { kind: 'prism', points: shape.points, bottom, top: bottom + shape.height };
		}
		default: {
			return `volume type ${volume.volumeType} isn't supported`;
		}
	}
};

// #endregion

// #region assets

/**
 * @param resolver asset resolver
 * @param hash StringPathHash key of the asset
 * @param pathOf hash → path lookup
 * @returns the asset's main MonoBehaviour
 * @throws {Error} if the hash is unknown or names no single MonoBehaviour
 */
const findMonoBehaviour = async (
	resolver: AssetResolver,
	hash: bigint,
	pathOf: (hash: bigint) => string | undefined,
): Promise<ObjectRef> => {
	const path = pathOf(hash);
	if (path === undefined) {
		throw new Error(`asset 0x${hash.toString(16)} isn't in StringPathHash`);
	}
	return resolver.findUnique({ hash, path }, UnityClass.MonoBehaviour);
};

/** a decoded phase and where it came from */
export interface LoadedPhase {
	ref: ObjectRef;
	phase: EnvironmentPhase;
}

/**
 * @param resolver asset resolver
 * @param hash StringPathHash key of an `HGEnvironmentPhase` asset
 * @param pathOf hash → path lookup
 * @returns the decoded phase
 * @throws {Error} if the asset can't be found or read
 */
export const loadEnvironmentPhase = async (
	resolver: AssetResolver,
	hash: bigint,
	pathOf: (hash: bigint) => string | undefined,
): Promise<LoadedPhase> => {
	return loadEnvironmentPhaseObject(resolver, await findMonoBehaviour(resolver, hash, pathOf));
};

/**
 * @param resolver asset resolver
 * @param ref an `HGEnvironmentPhase` MonoBehaviour, such as one a prefab volume references
 * @returns the decoded phase
 * @throws {Error} if the object can't be read as a phase
 */
export const loadEnvironmentPhaseObject = async (
	resolver: AssetResolver,
	ref: ObjectRef,
): Promise<LoadedPhase> => ({
	ref,
	phase: readEnvironmentPhase(ref.info.type.nodes, await resolver.read(ref)),
});

/** where a composed section came from */
export type SectionSource = 'level' | 'global' | 'inactive';

/** a phase's section as it applies, with its source */
export interface ComposedSection {
	source: SectionSource;
	section: EnvironmentSection;
}

/**
 * stacks a level's phase over the scene's global phase, as the game's priority blend does where only those
 * two apply: each section comes from the level phase if it's active there, else from the global phase if
 * active there, else it's the level phase's own (inactive) values
 *
 * @param level the level's phase
 * @param global the scene's global phase, or `null` if the scene has none
 * @returns every section with its source
 */
export const composeEnvironment = (
	level: EnvironmentPhase,
	global: EnvironmentPhase | null,
): Record<EnvironmentSectionName, ComposedSection> =>
	mapSections((name): ComposedSection => {
		const own = level.sections[name];
		const below = global?.sections[name];
		if (own.active) {
			return { source: 'level', section: own };
		}
		if (below?.active === true) {
			return { source: 'global', section: below };
		}
		return { source: 'inactive', section: own };
	});

/** a level's phases, loaded for its {@link LevelEnvironmentChoice} */
export interface LevelPhases {
	/** the base volume's phase */
	own: LoadedPhase;
	/** the scene's global phase under it, or `null` without one (or when the base is the global volume) */
	global: LoadedPhase | null;
	/** {@link own} stacked over {@link global} */
	composed: Record<EnvironmentSectionName, ComposedSection>;
}

/**
 * loads the phases a level's choice names and stacks them
 *
 * @param choice the level's base environment
 * @param loadPhase loads a volume's phase, or returns `null` when it has none (callers cache: levels share
 *   phases)
 * @returns the phases, or `null` if the base volume has no phase
 * @throws {Error} what `loadPhase` throws
 */
export const loadLevelPhases = async (
	choice: LevelEnvironmentChoice,
	loadPhase: (volume: EnvironmentVolume) => Promise<LoadedPhase> | null,
): Promise<LevelPhases | null> => {
	const ownLoad = choice.volume === null ? null : loadPhase(choice.volume);
	if (ownLoad === null) {
		return null;
	}
	const sameAsOwn =
		choice.global === choice.volume ||
		(choice.global?.envPhase != null && choice.global.envPhase === choice.volume?.envPhase);
	const globalLoad = choice.global === null || sameAsOwn ? null : loadPhase(choice.global);
	const [own, global] = await Promise.all([ownLoad, globalLoad]);
	return { own, global, composed: composeEnvironment(own.phase, global?.phase ?? null) };
};

/** a decoded `VolumeProfile`: its components by name (the component class) */
export interface LoadedVolumeProfile {
	name: string;
	/** component name → its fields (see `unity/plain-object.ts`), or `null` when the component is inactive */
	components: Map<string, PlainObject | null>;
}

/**
 * @param resolver asset resolver
 * @param hash StringPathHash key of a `VolumeProfile` asset
 * @param pathOf hash → path lookup
 * @returns the profile's components
 * @throws {Error} if the asset or one of its components can't be read
 */
export const loadVolumeProfile = async (
	resolver: AssetResolver,
	hash: bigint,
	pathOf: (hash: bigint) => string | undefined,
): Promise<LoadedVolumeProfile> => {
	const ref = await findMonoBehaviour(resolver, hash, pathOf);
	const profile = await resolver.read(ref);
	const entries = await Promise.all(
		arrayField(profile, 'components').map(async (pointer) => {
			const target = await resolver.resolve(ref, asPPtr(pointer));
			if (target === null) {
				return null;
			}
			const object = await resolver.read(target);
			const { value } = toPlainObject(target.info.type.nodes, object, {
				keepPPtr: () => false,
				dropField: (name) => name.startsWith('m_') || name === 'active',
			});
			const active = object.active !== 0 && object.active !== false;
			return [stringField(object, 'm_Name'), active ? value : null] as const;
		}),
	);
	return {
		name: stringField(profile, 'm_Name'),
		components: new Map(entries.filter((entry) => entry !== null)),
	};
};

// #endregion
