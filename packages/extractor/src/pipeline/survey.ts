import { fileURLToPath } from 'node:url';

import type { SceneEnvironmentVolume } from '../game/environment.ts';
import { DEFAULT_OUT } from '../install/config.ts';
import type { Context } from '../install/context.ts';

import { PackCache } from './cache/pack-cache.ts';
import {
	collectPlacedVolumes,
	collectPlacementSources,
	type ScenePlacementSources,
} from './discover/entities.ts';
import { PackContent } from './discover/pack-content.ts';
import { indexScene, type SceneIndex } from './scene-index.ts';
import { progressionControls } from './states.ts';

const DEFAULT_CACHE_DIR = fileURLToPath(new URL('.cache', DEFAULT_OUT));

// the entities phase's placement sources run on their own, without the chunk files or prefab renderers, so
// the inspection commands see the placements, gating and volumes a package of the scene holds

/** a whole scene's placements, as the packer finds them */
export interface ScenePlacementSurvey extends ScenePlacementSources {
	scene: SceneIndex;
	/** the content the sources wrote; its stand-ins and unsupported inputs are the package's */
	content: PackContent;
}

/**
 * @param context install readers
 * @param scene streaming scene id
 * @param level optional LevelConfig id to restrict interactive placement decoding to one level
 * @param options.includeEcs whether to decode dynamic ECS entity/light chunks (default `true`)
 * @returns every placement source of the scene (or level)
 * @throws {Error} what the packer's setup and placement sources throw
 */
export const surveyPlacements = async (
	context: Context,
	scene: string,
	level: string | null = null,
	options?: { includeEcs?: boolean; cache?: PackCache | null },
): Promise<ScenePlacementSurvey> => {
	const [index, cache] = await Promise.all([
		indexScene(context, { scene, level, bounds: null }, { terrain: false, hlod: false }),
		options?.cache !== undefined ? options.cache : PackCache.openReadOnly(DEFAULT_CACHE_DIR),
	]);
	const content = await PackContent.create(context.world, index, () => {});
	return {
		scene: index,
		content,
		...(await collectPlacementSources(context, content, { ...options, cache })),
	};
};

/**
 * @param context install readers
 * @param survey the scene's placements
 * @returns the environment volumes its placed prefabs carry, with whether each loads by default
 */
export const surveyPlacedVolumes = async (
	context: Context,
	survey: ScenePlacementSurvey,
): Promise<SceneEnvironmentVolume[]> =>
	collectPlacedVolumes(
		survey.roots,
		survey.content,
		survey.placements,
		await progressionControls(context.world, survey.scene.id),
	);
