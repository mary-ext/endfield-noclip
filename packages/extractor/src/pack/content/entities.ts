import type { Context } from '../../context.ts';
import { loadDynamicStructures } from '../../game/dynamic-structures.ts';
import type { SceneEnvironmentVolume } from '../../game/environment.ts';
import { loadPlacedVolumes } from '../../game/prefab-environment.ts';
import type { DraftControl } from '../../game/scene-control.ts';
import { readWaterVolumes } from '../../game/water-volumes.ts';
import type { CabinRoomGroup } from '../irradiance.ts';
import { defaultValues } from '../states.ts';
import type { WaterVolumeInput } from '../water.ts';

import { placeDynamicEntities } from './dynamic-entities.ts';
import { collectInteractives, type SceneInteractives } from './interactives.ts';
import type { PackContent } from './pack-content.ts';
import { placePrefabs } from './prefab-placements.ts';
import { collectStaticChunks } from './static-chunks.ts';

// the entities phase: every content source of the scene, in a fixed order. the order matters: geometry and
// material ids are handed out in first-reference order, synthetic entity ids in call order, and an entity the
// chunk files hold keeps their gating over a dynamic structure's. a new kind of content is one more source
// here, writing through PackContent; a new kind of placed prefab only needs to join the placement list

/** what the entities phase finds besides instance rows, for the phases after it */
export interface SceneEntities extends Omit<SceneInteractives, 'models' | 'cabinRooms'> {
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

	const dynamic = await loadDynamicStructures(context, scene.id, scene.partition, scene.game);
	for (const [key, count] of Object.entries(dynamic.counts)) {
		content.count(`dynamic_${key}`, count);
	}
	content.count('dynamicRenderers', 0);
	controls.add(...dynamic.controls);
	controls.require(dynamic);
	placeDynamicEntities(content, dynamic);

	const { models, cabinRooms, ...interactives } = await collectInteractives(context, content, dynamic);

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

	const resolver = await context.resolver();
	const placements = [...dynamic.models, ...models];
	await placePrefabs(context.world, resolver, content, placements, floaterVolume);
	const placed = await loadPlacedVolumes(resolver, placements, defaultValues(scene, controls, progressions));
	content.count('prefabEnvironmentVolumes', placed.volumes.length);
	for (const failure of placed.unsupported) {
		content.unsupportedPrefab(failure);
	}
	content.count('unsupportedPrefabs', content.unsupportedPrefabs.length);
	content.count('standIns', content.standInReports().length);
	return {
		...interactives,
		hlodNameMatches,
		placedVolumes: placed.volumes,
		cabinRooms: cabinRooms.map(({ control, levelTag, position, roomType }) => ({
			group: controls.group(levelTag, controls.condition({ alternatives: [[{ control, mask: 2 }]] })),
			position,
			roomType,
		})),
		waterVolumes: { volumes: waterVolumes.volumes, unsupported: waterVolumes.unsupported },
	};
};
