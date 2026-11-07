import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { isSparkBean, parseSparkTable, type SparkValue } from '@endfield-noclip/formats/hg/spark-buffer';

import type { Context } from '../../context.ts';
import { VfsGroup } from '../../hg/vfs.ts';

import type { ProgressionLink } from './game-state.ts';
import { loadProgressions, progressionId, type SceneProgression } from './scenery-variants.ts';

// an outpost's level-up missions (docs/game-data/scene-states.md#outpost-upgrade-missions): each level but the
// last names the mission that raises the outpost past it, so the mission is complete exactly when the outpost
// stands above that level.

const SETTLEMENT_TABLE = 'Data/TableCfg/SettlementBasicDataTable.bytes';

/** an outpost's level-up mission */
export interface SettlementUpgrade {
	missionId: string;
	settlementId: string;
	/** the level the mission raises the outpost from */
	level: number;
}

/**
 * @param vfs the game's VFS
 * @returns every outpost's level-up missions
 * @throws {FormatError} if the table is missing or an outpost's levels aren't a level map
 */
export const readSettlementUpgrades = async (vfs: Context['vfs']): Promise<SettlementUpgrade[]> => {
	const file = await vfs.find(VfsGroup.Table, SETTLEMENT_TABLE);
	if (file === undefined) {
		throw new FormatError(`missing ${SETTLEMENT_TABLE}`);
	}
	const upgrades: SettlementUpgrade[] = [];
	for (const [settlementId, entry] of parseSparkTable(await vfs.readVerified(file)).entries) {
		const levels: SparkValue | undefined = isSparkBean(entry) ? entry.settlementLevelMap : undefined;
		if (typeof settlementId !== 'string' || !isSparkBean(levels)) {
			throw new FormatError(`${SETTLEMENT_TABLE} has an invalid entry`);
		}
		for (const [level, row] of Object.entries(levels)) {
			const missionId = isSparkBean(row) ? row.upgradeMissionId : undefined;
			if (typeof missionId !== 'string') {
				throw new FormatError(
					`${SETTLEMENT_TABLE} ${settlementId} level ${level} has no upgrade mission field`,
				);
			}
			// the final level has none
			if (missionId !== '') {
				upgrades.push({ missionId, settlementId, level: Number(level) });
			}
		}
	}
	return upgrades;
};

/**
 * @param upgrades every outpost's level-up missions
 * @param progressions the scene's progressions
 * @returns by mission id, the scene's outpost level control each mission follows. a mission whose outpost
 *   isn't in the scene, or has no authored level above the one the mission raises it from, is left out
 */
export const upgradeLinks = (
	upgrades: readonly SettlementUpgrade[],
	progressions: readonly SceneProgression[],
): Map<string, ProgressionLink> => {
	const links = new Map<string, ProgressionLink>();
	for (const { missionId, settlementId, level } of upgrades) {
		const progression = progressions.find(({ kind, key }) => kind === 'settlement' && key === settlementId);
		if (progression === undefined || !progression.levels.some((value) => value > level)) {
			continue;
		}
		links.set(missionId, {
			control: progressionId('settlement', settlementId),
			levels: progression.levels,
			completedFrom: level + 1,
		});
	}
	return links;
};

/**
 * @param context install readers
 * @param scene streaming scene id
 * @returns by mission id, the scene's outpost level control each level-up mission follows
 * @throws {FormatError} if the outpost table can't be read
 */
export const loadUpgradeLinks = async (
	context: Pick<Context, 'vfs' | 'world'>,
	scene: string,
): Promise<Map<string, ProgressionLink>> => {
	const [upgrades, progressions] = await Promise.all([
		readSettlementUpgrades(context.vfs),
		loadProgressions(context.world, scene),
	]);
	return upgradeLinks(upgrades, progressions);
};
