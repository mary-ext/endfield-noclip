import type { QuestRef } from '@endfield-noclip/package-format/states';

import { questRef } from '../state/story.ts';
import type { WorldIndex } from '../world/world-index.ts';

import type { LevelWaterVolume } from './water-volumes.ts';

// quests whose objectives need a pool drained (docs/game-data/water.md#depletable-pools)

/** a quest that completes once a water volume is (nearly) empty */
export interface WaterDrain {
	quest: QuestRef;
	/** the amount the objective waits for the volume to reach or go under */
	target: number;
}

/** an amount at most this share of a full volume counts as drained */
const DRAINED = 0.05;

/** `CompareOperator` < and ≤ */
const BELOW = new Set([4, 5]);

/**
 * @param world world index
 * @param volumes the scene's water volumes
 * @returns by volume id, the quests whose objectives test it at or under a twentieth of its full amount
 */
export const loadWaterDrains = async (
	world: WorldIndex,
	volumes: readonly LevelWaterVolume[],
): Promise<Map<string, WaterDrain[]>> => {
	const byId = new Map(volumes.map((volume) => [volume.id, volume]));
	const drains = new Map<string, WaterDrain[]>();
	for (const mission of await world.missions()) {
		for (const quest of mission.quests) {
			for (const check of quest.fluidChecks) {
				const volume = byId.get(check.volume);
				if (volume === undefined || !BELOW.has(check.compare) || check.target > volume.amountMax * DRAINED) {
					continue;
				}
				// oxlint-disable-next-line no-await-in-loop -- a handful of quests
				const ref = await questRef(world, quest.id);
				drains.getOrInsertComputed(check.volume, () => []).push({ quest: ref, target: check.target });
			}
		}
	}
	return drains;
};
