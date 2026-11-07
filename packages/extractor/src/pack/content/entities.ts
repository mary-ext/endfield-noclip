import type { Context } from '../../context.ts';
import { type DynamicStructures, loadDynamicStructures } from '../../game/dynamic/dynamic-structures.ts';
import type { SceneEnvironmentVolume } from '../../game/environment.ts';
import { loadPlacedVolumes, type PlacedPrefab } from '../../game/prefabs/prefab-environment.ts';
import { PrefabRoots } from '../../game/prefabs/prefab-root.ts';
import type { DraftControl } from '../../game/state/scene-control.ts';
import { readWaterVolumes } from '../../game/water/water-volumes.ts';
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
// chunk files hold keeps their gating over a dynamic structure's. a new kind of content is one more source
// here, writing through PackContent; a new kind of placed prefab only needs to join the placement list.
// `world find` and `world env` run the placement sources and placed volumes on their own, so they list what
// the package holds

/** what the entities phase finds besides instance rows, for the phases after it */
export interface SceneEntities extends Pick<
	SceneInteractives,
	'scriptWater' | 'waterDrivers' | 'placements' | 'unsupported'
> {
	/** how many HLOD clusters' bounds centres lie in the tile they're filed under */
	hlodNameMatches: number;
	/** environment volumes that placed prefabs carry */
	placedVolumes: SceneEnvironmentVolume[];
	/** Dijiang's cabin slots, with the group that shows their built cabin */
	cabinRooms: CabinRoomGroup[];
	/**
	 * gameplay water volumes, the entity ids of the instance rows floating on each (by volume id), and the
	 * LevelData files they couldn't be read from
	 */
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
export const collectEntities = async (
	context: Context,
	content: PackContent,
	progressions: readonly DraftControl[],
): Promise<SceneEntities> => {
	const { scene, controls } = content;
	const hlodNameMatches = await collectStaticChunks(context.world, content);
	const sources = await collectPlacementSources(context, content);
	const { scriptWater, waterDrivers, placements, unsupported, cabinRooms } = sources.interactives;

	const waterVolumes = await readWaterVolumes(context, scene.id, scene.level, scene.partition);
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

	const roots = new PrefabRoots(await context.resolver());
	await placePrefabs(context.world, roots, content, sources.placements, floaterVolume);
	const placedVolumes = await collectPlacedVolumes(roots, content, sources.placements, progressions);
	content.count('unsupportedPrefabs', content.unsupportedPrefabs.length);
	content.count('standIns', content.standInReports().length);
	return {
		scriptWater,
		waterDrivers,
		placements,
		unsupported,
		hlodNameMatches,
		placedVolumes,
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
	/** every placed prefab, whatever placed it: dynamic structures', then facilities', then cabins' */
	placements: DynamicStructures['models'];
}

/**
 * loads the dynamic structures, level scripts, facilities and cabins, registers their controls and places the
 * dynamic structures' entities and the facility stand-ins
 *
 * @param context install readers
 * @param content the pack's content, after the static chunks; controls, rows and counts are added
 * @returns the sources and the prefabs they place
 */
export const collectPlacementSources = async (
	context: Context,
	content: PackContent,
): Promise<ScenePlacementSources> => {
	const { scene, controls } = content;
	const dynamic = await loadDynamicStructures(context, scene.id, scene.partition, scene.game);
	for (const [key, count] of Object.entries(dynamic.counts)) {
		content.count(`dynamic_${key}`, count);
	}
	content.count('dynamicRenderers', 0);
	controls.add(...dynamic.controls);
	controls.require(dynamic);
	placeDynamicEntities(content, dynamic);
	const interactives = await collectInteractives(context, content, dynamic);
	return {
		dynamic,
		interactives,
		placements: [...dynamic.models, ...interactives.facilityModels, ...interactives.cabinModels],
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
): Promise<SceneEnvironmentVolume[]> => {
	const placed = await loadPlacedVolumes(
		roots,
		placements,
		defaultValues(content.scene, content.controls, progressions),
	);
	content.count('prefabEnvironmentVolumes', placed.volumes.length);
	for (const failure of placed.unsupported) {
		content.unsupportedPrefab(failure);
	}
	return placed.volumes;
};
