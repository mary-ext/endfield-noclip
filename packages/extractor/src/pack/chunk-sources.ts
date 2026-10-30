import type { ConditionalSetInfo, SceneRequirement } from '@endfield-noclip/package-format/states';
import { streamAreaControl } from '@endfield-noclip/package-format/stream-areas';

import { sceneStateControl } from '../game/scene-conditions.ts';
import type { ChunkSource } from '../game/world-index.ts';

/**
 * @param sources the chunk files holding a piece of content (repeats are fine)
 * @returns when the game loads it, one alternative per file: the file's scene state and stream area; `null`
 *   when an always-loaded file of the default area holds it
 */
export const sourceVisibility = (sources: Iterable<ChunkSource>): ConditionalSetInfo | null => {
	const alternatives: SceneRequirement[][] = [];
	for (const { sceneState, area } of sources) {
		const requirements: SceneRequirement[] = [];
		if (sceneState !== 0) {
			requirements.push({ control: sceneStateControl(sceneState - 1), mask: 2 });
		}
		if (area !== 0) {
			requirements.push({ control: streamAreaControl(area), mask: 2 });
		}
		if (requirements.length === 0) {
			return null;
		}
		alternatives.push(requirements);
	}
	return { alternatives };
};
