import {
	EnvironmentVolumeType,
	type EnvironmentVolume,
	polygonArea,
	polygonContains,
	type PostVolume,
	readEnvironmentVolume,
	readPostVolume,
	yawRotation,
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

import { mapPool } from '../pool.ts';

import type { AssetResolver, ObjectRef } from './assets.ts';
import type { WorldIndex } from './world-index.ts';

// which environment a level is lit by. the game has no per-level setting: environment volumes (tag-1 chunk
// objects, see formats' `environment-volume.ts`) are blended by priority wherever the camera is. each scene has
// one global volume (priority 100), and each level a large volume over its ground (priority 200 or so) with
// smaller ones for caves, interiors and set pieces above it. a level's base environment is therefore the volume
// that wins over most of the level's cells; `world env <level>` shows the vote.

// #region scene volumes

/** a volume with the level tag of its entity id */
export interface TaggedVolume<T> {
	tag: number;
	volume: T;
}

/** every environment and post-processing volume of a scene's default state */
export interface SceneVolumes {
	environment: TaggedVolume<EnvironmentVolume>[];
	post: TaggedVolume<PostVolume>[];
}

/** chunk files read at once */
const READ_CONCURRENCY = 16;

const VOLUME_COMPONENTS = BigInt(MonoComponentType.HGEnvironmentVolume | MonoComponentType.Volume);

/**
 * reads the environment and post volumes of a scene's default-state chunks (Init with its paired Streaming
 * file), each once
 *
 * @param world world index
 * @param scene streaming scene
 * @returns the volumes, in chunk-file order
 */
export const loadSceneVolumes = async (world: WorldIndex, scene: string): Promise<SceneVolumes> => {
	const files = (await world.chunkFiles()).filter((file) => file.scene === scene && file.state === 0);
	const perFile = await mapPool(files, READ_CONCURRENCY, async (file) => {
		const init = await world.readInitPayload(file);
		if (!hasMonoComponents(init, VOLUME_COMPONENTS)) {
			return [];
		}
		return readMonoObjects(init, await world.readStreamingPayload(file));
	});

	const volumes: SceneVolumes = { environment: [], post: [] };
	// a volume is repeated in every cell chunk it overlaps
	const seen = new Set<number>();
	for (const objects of perFile) {
		for (const object of objects) {
			if (seen.has(object.id)) {
				continue;
			}
			const environment = readEnvironmentVolume(object);
			const post = readPostVolume(object);
			const tag = levelTagOf(object.id);
			if (environment !== undefined) {
				volumes.environment.push({ tag, volume: environment });
			}
			if (post !== undefined) {
				volumes.post.push({ tag, volume: post });
			}
			if (environment !== undefined || post !== undefined) {
				seen.add(object.id);
			}
		}
	}
	return volumes;
};

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
 * picks a level's base environment. levels are authored as one broad volume (usually priority 200, often
 * named `*global*`) under smaller, higher-priority ones for caves, interiors and set pieces; the base is that
 * broad one: of the volumes the level owns (by entity tag) and the game shows somewhere on a 32 m grid over
 * the level's cells, the one covering most points, the lower priority on a tie. a volume is shown where it
 * has the highest priority of those containing the point (the smaller footprint on equal priority, an
 * assumption). the scene's global volume stands in when the level has none. heights are ignored, and every
 * volume is taken as enabled (level scripts can toggle them)
 *
 * @param level the level
 * @param volumes the scene's volumes
 * @returns the choice and the per-volume coverage
 */
export const resolveLevelEnvironment = (
	level: Pick<PartitionLevel, 'tag'> & { config: Pick<PartitionLevel['config'], 'levelGrids'> },
	volumes: SceneVolumes,
): LevelEnvironmentChoice => {
	const global =
		volumes.environment.find(
			({ tag, volume }) => tag === 0 && volume.volumeType === EnvironmentVolumeType.Global,
		)?.volume ?? null;
	const candidates = volumes.environment
		.filter(({ tag }) => tag === level.tag)
		.flatMap(({ volume }) => {
			const shape = footprint(volume);
			return shape === null ? [] : [{ volume, shape, share: { volume, covered: 0, wins: 0 } }];
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
					if (!candidate.shape.contains(x, z)) {
						continue;
					}
					candidate.share.covered++;
					const { priority } = candidate.volume;
					if (
						best === null ||
						priority > best.volume.priority ||
						(priority === best.volume.priority && candidate.shape.area < best.shape.area)
					) {
						best = candidate;
					}
				}
				if (best !== null) {
					best.share.wins++;
				}
			}
		}
	}
	const shares = candidates
		.map(({ share }) => share)
		.filter((share) => share.covered > 0)
		.toSorted(
			(a, b) => b.covered - a.covered || a.volume.priority - b.volume.priority || a.volume.id - b.volume.id,
		);
	// a volume the game never shows in the level (always beaten) can't be its look
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
 * @returns the volume, or `null` if neither exists
 */
export const resolveLevelPost = (
	level: Pick<PartitionLevel, 'tag'>,
	volumes: SceneVolumes,
): PostVolume | null => {
	const globals = volumes.post.filter(({ volume }) => volume.isGlobal && volume.profile !== null);
	const pick = (tag: number) =>
		globals.filter((entry) => entry.tag === tag).toSorted((a, b) => b.volume.priority - a.volume.priority)[0]
			?.volume;
	return pick(level.tag) ?? pick(0) ?? null;
};

interface Footprint {
	/** m² on the x, z plane; infinite for global volumes */
	area: number;
	contains(x: number, z: number): boolean;
}

/** a volume's x, z footprint, or `null` for shapes not understood */
const footprint = (volume: EnvironmentVolume): Footprint | null => {
	switch (volume.volumeType) {
		case EnvironmentVolumeType.Global: {
			return { area: Infinity, contains: () => true };
		}
		case EnvironmentVolumeType.PolyLine: {
			const points = volume.shape?.points;
			if (points === undefined || points.length < 3) {
				return null;
			}
			return { area: polygonArea(points), contains: (x, z) => polygonContains(points, x, z) };
		}
		case EnvironmentVolumeType.Box: {
			// a unit cube scaled by the transform; only rotation about y matters on the ground plane
			const transform = volume.transform;
			if (transform === null) {
				return null;
			}
			const [cx, , cz] = transform.position;
			const halfX = Math.abs(transform.scale[0]) / 2;
			const halfZ = Math.abs(transform.scale[2]) / 2;
			// into the box frame
			const inverse = yawRotation(-transform.rotation[1]);
			return {
				area: 4 * halfX * halfZ,
				contains: (x, z) => {
					const [lx, lz] = inverse(x - cx, z - cz);
					return Math.abs(lx) <= halfX && Math.abs(lz) <= halfZ;
				},
			};
		}
		default: {
			return null;
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
	const ref = await findMonoBehaviour(resolver, hash, pathOf);
	return { ref, phase: readEnvironmentPhase(ref.info.type.nodes, await resolver.read(ref)) };
};

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
 * @param loadPhase loads a phase by StringPathHash key (callers cache: levels share phases)
 * @returns the phases, or `null` if the base volume has no phase
 * @throws {Error} what `loadPhase` throws
 */
export const loadLevelPhases = async (
	choice: LevelEnvironmentChoice,
	loadPhase: (hash: bigint) => Promise<LoadedPhase>,
): Promise<LevelPhases | null> => {
	const hash = choice.volume?.envPhase ?? null;
	if (hash === null) {
		return null;
	}
	const globalHash = choice.global?.envPhase ?? null;
	const [own, global] = await Promise.all([
		loadPhase(hash),
		globalHash === null || globalHash === hash ? null : loadPhase(globalHash),
	]);
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
