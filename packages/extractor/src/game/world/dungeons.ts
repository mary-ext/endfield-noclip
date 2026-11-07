import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { MissionRuntime } from '@endfield-noclip/formats/endfield/mission-runtime';
import { isSparkBean, parseSparkTable, type SparkValue } from '@endfield-noclip/formats/hg/spark-buffer';

import type { Context } from '../../context.ts';
import { VfsGroup } from '../../hg/vfs.ts';

// the dungeon entries the client defines and what reaches them (docs/game-data/world.md#scene-names): each
// DungeonTable row sends the party to a level, the level streams a scene (often its own, sometimes another
// level's or an open-world map's), and missions name the level when their story takes the party there.

const DUNGEON_TABLE = 'Data/TableCfg/DungeonTable.bytes';
const CHARACTER_TABLE = 'Data/TableCfg/CharacterTable.bytes';

/** a DungeonTable row */
export interface DungeonEntry {
	/** `dungeonId`, e.g. `dung_minghe_02` */
	id: string;
	/** English `dungeonName`, or `null` when it has none */
	name: string | null;
	/** `dungeonCategory`, e.g. `dungeon_char`, or `null` for none */
	category: string | null;
	/** the level it sends the party to: `sceneId`, else `levelId`; `null` for rows that name neither */
	levelId: string | null;
	/** `relatedCharId`, or `null` when unset */
	charId: string | null;
}

/** a dungeon entry with what it streams and what reaches it */
export interface DungeonUse {
	dungeon: DungeonEntry;
	/** the streaming scene its level streams, or `null` without a level or if the client ships no such scene */
	scene: string | null;
	/** the operator it belongs to: `relatedCharId`, else that of a character mission reaching it */
	charId: string | null;
	/** missions that name its level, in id order; empty when only menus or nothing lead there */
	missions: MissionRuntime[];
}

/**
 * @param vfs the game's VFS
 * @param english I18nTextTable_EN by text id
 * @returns every DungeonTable row, in table order
 * @throws {FormatError} if the table is missing or a row lacks its id
 */
export const readDungeons = async (
	vfs: Context['vfs'],
	english: Map<bigint, string>,
): Promise<DungeonEntry[]> => {
	const dungeons: DungeonEntry[] = [];
	for (const [key, row] of (await readTable(vfs, DUNGEON_TABLE)).entries) {
		if (!isSparkBean(row) || typeof row.dungeonId !== 'string') {
			throw new FormatError(`${DUNGEON_TABLE} row ${String(key)} has no dungeonId`);
		}
		dungeons.push({
			id: row.dungeonId,
			name: textOf(row.dungeonName, english),
			category: nonEmpty(row.dungeonCategory),
			levelId: nonEmpty(row.sceneId) ?? nonEmpty(row.levelId),
			charId: nonEmpty(row.relatedCharId),
		});
	}
	return dungeons;
};

/**
 * @param vfs the game's VFS
 * @param english I18nTextTable_EN by text id
 * @returns English operator names by character id, e.g. `chr_0035_liino` → `Liino`
 * @throws {FormatError} if the table is missing
 */
export const readOperatorNames = async (
	vfs: Context['vfs'],
	english: Map<bigint, string>,
): Promise<Map<string, string>> => {
	const names = new Map<string, string>();
	for (const [key, row] of (await readTable(vfs, CHARACTER_TABLE)).entries) {
		const name = isSparkBean(row) ? textOf(row.name, english) : null;
		if (typeof key === 'string' && name !== null) {
			names.set(key, name);
		}
	}
	return names;
};

/**
 * joins every dungeon entry with the scene its level streams and the missions that name the level
 *
 * @param context install readers
 * @returns one use per DungeonTable row, in table order
 * @throws {FormatError} if a table or mission file is malformed
 */
export const loadDungeonUses = async (context: Pick<Context, 'vfs' | 'world'>): Promise<DungeonUse[]> => {
	const { vfs, world } = context;
	const [dungeons, levels, scenes, missions] = await Promise.all([
		world.englishText().then((english) => readDungeons(vfs, english)),
		world.levelConfigs(),
		world.scenes().then((list) => new Set(list)),
		world.missions(),
	]);
	const missionsByLevel = new Map<string, MissionRuntime[]>();
	for (const mission of missions) {
		for (const level of mission.levels) {
			missionsByLevel.getOrInsert(level, []).push(mission);
		}
	}
	return dungeons.map((dungeon): DungeonUse => {
		const { levelId } = dungeon;
		if (levelId === null) {
			return { dungeon, scene: null, charId: dungeon.charId, missions: [] };
		}
		// a level streams the scene its exported config sits under; a bare map id is its own scene
		const path = levels.get(levelId)?.defaultState.exportedSceneConfigPath;
		const scene = path ? path.split('/')[0] : levelId;
		const reaching = missionsByLevel.get(levelId) ?? [];
		return {
			dungeon,
			scene: scenes.has(scene) ? scene : null,
			charId: dungeon.charId ?? reaching.find((mission) => mission.charId !== null)?.charId ?? null,
			missions: reaching,
		};
	});
};

const readTable = async (vfs: Context['vfs'], name: string) => {
	const file = await vfs.find(VfsGroup.Table, name);
	if (file === undefined) {
		throw new FormatError(`missing ${name}`);
	}
	return parseSparkTable(await vfs.readVerified(file));
};

const nonEmpty = (value: SparkValue | undefined): string | null =>
	typeof value === 'string' && value !== '' ? value : null;

/** @returns the English string a `{ id }` text reference points to, or `null` */
const textOf = (value: SparkValue | undefined, english: Map<bigint, string>): string | null => {
	if (!isSparkBean(value) || typeof value.id !== 'bigint') {
		return null;
	}
	return english.get(value.id) || null;
};
