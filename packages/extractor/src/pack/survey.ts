import type { Context } from '../context.ts';
import type { SceneEnvironmentVolume } from '../game/environment.ts';

import {
	collectPlacedVolumes,
	collectPlacementSources,
	type ScenePlacementSources,
} from './content/entities.ts';
import { PackContent } from './content/pack-content.ts';
import { indexScene, type SceneIndex } from './scene-index.ts';
import { progressionControls } from './states.ts';

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
 * @returns every placement source of the whole scene
 * @throws {Error} what the packer's setup and placement sources throw
 */
export const surveyPlacements = async (context: Context, scene: string): Promise<ScenePlacementSurvey> => {
	const index = await indexScene(context, { scene, level: null, bounds: null });
	const content = await PackContent.create(context.world, index, () => {});
	return { scene: index, content, ...(await collectPlacementSources(context, content)) };
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
