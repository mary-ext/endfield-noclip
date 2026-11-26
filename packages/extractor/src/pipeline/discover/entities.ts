import type { ClothGroup } from '@endfield-noclip/formats/endfield/cloth-groups';

import { readDynamicEnvironmentVolumes } from '../../game/dynamic-environment.ts';
import { poseDecorationModels } from '../../game/dynamic/decoration-animators.ts';
import { type DynamicStructures, loadDynamicStructures } from '../../game/dynamic/dynamic-structures.ts';
import type { SceneEnvironmentVolume, SceneVolumes } from '../../game/environment.ts';
import { loadPlacedVolumes, type PlacedPrefab } from '../../game/prefabs/prefab-environment.ts';
import { PrefabRoots } from '../../game/prefabs/prefab-root.ts';
import type { DraftControl } from '../../game/state/scene-control.ts';
import type { SceneWater } from '../../game/water/water-source.ts';
import { readWaterVolumes } from '../../game/water/water-volumes.ts';
import type { Context } from '../../install/context.ts';
import { VfsGroup } from '../../install/vfs.ts';
import type { PackCache } from '../cache/pack-cache.ts';
import { defaultValues } from '../states.ts';
import type { CabinRoomGroup } from '../tables/irradiance.ts';
import type { WaterVolumeInput } from '../tables/water.ts';

import { placeDynamicEntities } from './dynamic-entities.ts';
import { collectInteractives, type SceneInteractives } from './interactives.ts';
import type { PackContent } from './pack-content.ts';
import { placePrefabs } from './prefab-placements.ts';
import { collectStaticChunks } from './static-chunks.ts';

// the entities phase: every content source of the scene, in a fixed order. the order matters: geometry and
// material ids are handed out in first-reference order, synthetic entity ids in call order, and an entity the
// chunk files hold keeps their gating over a dynamic structure's. `world find` and `world env` run the
// placement sources and placed volumes on their own (docs/extraction.md#code-layout)

/** what the entities phase finds besides instance rows, for the phases after it */
export interface SceneEntities extends Pick<
	SceneInteractives,
	'scriptWater' | 'waterDrivers' | 'placements' | 'places' | 'fireSeed' | 'unsupported'
> {
	/** how many HLOD clusters' bounds centres lie in the tile they're filed under */
	hlodNameMatches: number;
	/** environment and post-processing volumes collected from the scene's chunk files */
	chunkVolumes: SceneVolumes;
	/** placed water surfaces and global bindings collected from the scene's Global chunk files */
	sceneWater: SceneWater;
	/** unique cloth simulation groups referenced by packed entities */
	clothGroups: ClothGroup[];
	/** environment volumes that placed prefabs carry */
	placedVolumes: SceneEnvironmentVolume[];
	/** script-activated dynamic environment volumes from LevelData */
	dynamicVolumes: SceneEnvironmentVolume[];
	/** Dijiang's cabin slots, with the group that shows their built cabin */
	cabinRooms: CabinRoomGroup[];
	/** gameplay water volumes, and the LevelData files they couldn't be read from */
	waterVolumes: WaterVolumeInput;
}

/**
 * reads every content source of the scene into the pack's content
 *
 * @param context install readers
 * @param content the pack's empty content
 * @param progressions one control per progression of the scene, at its default
 * @returns what the later phases need
 */
const WATER_VOLUMES_ENTRY = new URL('../../game/water/water-volumes.ts', import.meta.url);
const DYNAMIC_ENV_ENTRY = new URL('../../game/dynamic-environment.ts', import.meta.url);

export const collectEntities = async (
	context: Context,
	content: PackContent,
	progressions: readonly DraftControl[],
	cache: PackCache | null = null,
): Promise<SceneEntities> => {
	const { scene, controls } = content;
	const { hlodNameMatches, chunkVolumes, sceneWater, clothGroups } = await collectStaticChunks(
		context.world,
		content,
		cache,
	);
	const sources = await collectPlacementSources(context, content, { cache });
	const { scriptWater, waterDrivers, placements, places, fireSeed, unsupported, cabinRooms } =
		sources.interactives;

	type WaterVolumesResult = Awaited<ReturnType<typeof readWaterVolumes>>;
	let waterVolumes: WaterVolumesResult | undefined;
	let waterMemoKey: string | null = null;
	if (cache !== null) {
		const [fp, jsonHash] = await Promise.all([
			cache.fingerprint(WATER_VOLUMES_ENTRY),
			context.vfs.group(VfsGroup.JsonData).then((g) => g.catalogHash),
		]);
		waterMemoKey = cache.keyWith(fp, { kind: 'waterVolumes', scene: scene.id, level: scene.level, jsonHash });
		waterVolumes = await cache.recallValue<WaterVolumesResult>(waterMemoKey);
	}
	if (waterVolumes === undefined) {
		waterVolumes = await readWaterVolumes(context, scene.id, scene.level, scene.partition);
		if (waterMemoKey !== null && cache !== null) {
			await cache.rememberValue(waterMemoKey, waterVolumes);
		}
	}
	content.count('waterVolumes', waterVolumes.volumes.length);
	/** by floating interactive's level logic id, its volume's id */
	const floaterVolume = new Map<string, string>();
	{
		const known = new Set(waterVolumes.volumes.map(({ id }) => id));
		for (const { id, volume } of waterVolumes.floaters) {
			if (known.has(volume)) {
				floaterVolume.set(id, volume);
			}
		}
	}

	const { roots } = sources;
	await placePrefabs(context.world, roots, content, sources.placements, floaterVolume, cache);
	const placedVolumes = await collectPlacedVolumes(roots, content, sources.placements, progressions, cache);
	let dynamicVolumes: SceneEnvironmentVolume[] | undefined;
	let dynamicEnvMemoKey: string | null = null;
	if (cache !== null) {
		const [fp, jsonHash] = await Promise.all([
			cache.fingerprint(DYNAMIC_ENV_ENTRY),
			context.vfs.group(VfsGroup.JsonData).then((g) => g.catalogHash),
		]);
		dynamicEnvMemoKey = cache.keyWith(fp, {
			kind: 'dynamicEnvVolumes',
			scene: scene.id,
			level: scene.level,
			jsonHash,
		});
		dynamicVolumes = await cache.recallValue<SceneEnvironmentVolume[]>(dynamicEnvMemoKey);
	}
	if (dynamicVolumes === undefined) {
		dynamicVolumes = await readDynamicEnvironmentVolumes(context, scene.id, scene.level, scene.partition);
		if (dynamicEnvMemoKey !== null && cache !== null) {
			await cache.rememberValue(dynamicEnvMemoKey, dynamicVolumes);
		}
	}
	content.count('dynamicEnvironmentVolumes', dynamicVolumes.length);
	content.count('unsupportedPrefabs', content.unsupportedPrefabs.length);
	content.count('standIns', content.standInReports().length);
	return {
		scriptWater,
		waterDrivers,
		placements,
		places,
		fireSeed,
		unsupported,
		hlodNameMatches,
		chunkVolumes,
		sceneWater,
		clothGroups,
		placedVolumes,
		dynamicVolumes,
		cabinRooms: cabinRooms.map(({ control, levelTag, position, roomType }) => ({
			group: controls.group(levelTag, controls.condition({ alternatives: [[{ control, mask: 2 }]] })),
			position,
			roomType,
		})),
		waterVolumes: { volumes: waterVolumes.volumes, unsupported: waterVolumes.unsupported },
	};
};

/** the sources of the scene's content outside its chunk files, and every prefab they place */
export interface ScenePlacementSources {
	dynamic: DynamicStructures;
	interactives: SceneInteractives;
	/** the dynamic structures' placed prefabs, posed by what their level scripts set as they start */
	structureModels: DynamicStructures['models'];
	/** every placed prefab, whatever placed it: dynamic structures', then facilities', then cabins' */
	placements: DynamicStructures['models'];
	/** the placed prefabs' roots, for the readers after the sources */
	roots: PrefabRoots;
}

/**
 * loads the dynamic structures, level scripts, facilities and cabins, registers their controls and places the
 * dynamic structures' entities and the facility stand-ins
 *
 * @param context install readers
 * @param content the pack's content, after the static chunks; controls, rows and counts are added
 * @param options.includeEcs whether to decode dynamic ECS entity/light chunks (default `true`)
 * @returns the sources and the prefabs they place
 */
export const collectPlacementSources = async (
	context: Context,
	content: PackContent,
	options?: { includeEcs?: boolean; cache?: PackCache | null },
): Promise<ScenePlacementSources> => {
	const { scene, controls } = content;
	const cache = options?.cache ?? null;
	const dynamic = await loadDynamicStructures(context, scene.id, scene.partition, scene.game, options);
	for (const [key, count] of Object.entries(dynamic.counts)) {
		content.count(`dynamic_${key}`, count);
	}
	content.count('dynamicRenderers', 0);
	controls.add(...dynamic.controls);
	controls.require(dynamic);
	placeDynamicEntities(content, dynamic);
	const interactives = await collectInteractives(context, content, dynamic, cache);
	const roots = new PrefabRoots(await context.resolver());
	// level scripts are read with the interactives, after the dynamic structures, so the Animator values they
	// set as they start pose the structures' prefabs here
	const decorated = await poseDecorationModels(roots, dynamic.models, interactives.decorationAnimators);
	content.count('decorationAnimatorModels', decorated.posed);
	controls.add(...decorated.controls);
	return {
		dynamic,
		interactives,
		structureModels: decorated.models,
		placements: [...decorated.models, ...interactives.facilityModels, ...interactives.cabinModels],
		roots,
	};
};

/**
 * reads the environment volumes placed prefabs carry, and which load under the controls' defaults
 *
 * @param roots the placed prefabs' roots
 * @param content the pack's content, after every placement source; prefabs that can't be read are recorded
 * @param placements every placed prefab
 * @param progressions one control per progression of the scene, at its default
 * @returns the volumes, in placement order
 */
export const collectPlacedVolumes = async (
	roots: PrefabRoots,
	content: PackContent,
	placements: readonly PlacedPrefab[],
	progressions: readonly DraftControl[],
	cache: PackCache | null = null,
): Promise<SceneEnvironmentVolume[]> => {
	const placed = await loadPlacedVolumes(
		roots,
		placements,
		defaultValues(content.scene, content.controls, progressions),
		cache,
	);
	content.count('prefabEnvironmentVolumes', placed.volumes.length);
	for (const failure of placed.unsupported) {
		content.unsupportedPrefab(failure);
	}
	return placed.volumes;
};
