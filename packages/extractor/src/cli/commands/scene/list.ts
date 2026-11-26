import { voteLevelTags } from '@endfield-noclip/formats/endfield/level-partition';

import { mapDefined } from '@mary-ext/array-fns';

import { stripMarkup } from '../../../game/state/story.ts';
import { loadDungeonUses, readOperatorNames } from '../../../game/world/dungeons.ts';
import { indexTerrain } from '../../../game/world/terrain-source.ts';
import type { WorldIndex } from '../../../game/world/world-index.ts';
import { type Context, withContext } from '../../../install/context.ts';
import { compareNatural, compareStrings } from '../../../util/compare.ts';

import type { SceneSubArgs } from './parser.ts';
import { requirePartition } from './shared.ts';

/**
 * runs `endfield-extract scene list`
 *
 * @param args parsed CLI arguments
 */
export const runSceneList = async (args: SceneSubArgs<'list'>): Promise<void> => {
	await withContext(args.config, async (context) => {
		if (args.dungeons) {
			await listDungeons(context, {
				category: args.category,
				json: args.json,
			});
		} else {
			await listScenes(context, args.json);
		}
	});
};

/**
 * runs `endfield-extract scene levels`
 *
 * @param args parsed CLI arguments
 */
export const runSceneLevels = async (args: SceneSubArgs<'levels'>): Promise<void> => {
	await withContext(args.config, async (context) => {
		await listLevels(context.world, args.map, args.verify);
	});
};

const listScenes = async (context: Context, json: boolean): Promise<void> => {
	const { world, vfs } = context;
	const [names, files, scenes, terrain] = await Promise.all([
		world.names(),
		world.chunkFiles(),
		world.scenes(),
		indexTerrain(vfs),
	]);
	const partitions = await Promise.all(scenes.map((scene) => world.partition(scene)));
	const rows = scenes.map((scene, i) => {
		const chunks = files.filter((file) => file.scene === scene).length;
		const partition = partitions[i];
		const terrainTiles = terrain.get(scene)?.tiles.size ?? 0;
		return {
			scene,
			chunks,
			levels: partition?.levels.length ?? 0,
			grid: partition?.map.sideGridNum ?? null,
			terrainTiles,
			name: names.get(scene) ?? null,
		};
	});
	if (json) {
		console.log(JSON.stringify(rows, null, '\t'));
		return;
	}
	for (const row of rows) {
		const levels = row.grid === null ? '' : `${row.levels} levels, ${row.grid}² grid`;
		const tiles = row.terrainTiles === 0 ? '' : `${row.terrainTiles} terrain`;
		console.log(
			`${row.scene.padEnd(20)} ${String(row.chunks).padStart(6)} chunks  ${levels.padEnd(22)} ${tiles.padEnd(14)} ${row.name ?? ''}`,
		);
	}
};

const listDungeons = async (
	context: Context,
	options: { category: RegExp | undefined; json: boolean },
): Promise<void> => {
	const { vfs, world } = context;
	const [uses, levelNames, operators, text] = await Promise.all([
		loadDungeonUses(context),
		world.names(),
		world.englishText().then((english) => readOperatorNames(vfs, english)),
		world.text(),
	]);
	const missionName = (key: string | null): string | null => {
		const value = key === null ? undefined : text(key);
		return value === undefined ? null : stripMarkup(value);
	};
	const rows = mapDefined(uses, ({ dungeon, scene, charId, missions }) =>
		options.category === undefined || options.category.test(dungeon.category ?? '')
			? {
					id: dungeon.id,
					name: dungeon.name ?? (dungeon.levelId === null ? null : levelNames.get(dungeon.levelId)) ?? null,
					category: dungeon.category,
					level: dungeon.levelId,
					scene,
					charId,
					operator: charId === null ? null : (operators.get(charId) ?? null),
					missions: missions.map((mission) => ({ id: mission.id, name: missionName(mission.nameKey) })),
				}
			: undefined,
	);
	rows.sort((a, b) => compareNatural(a.level ?? '', b.level ?? '') || compareStrings(a.id, b.id));
	if (options.json) {
		console.log(JSON.stringify(rows, null, '\t'));
		return;
	}
	console.log(
		'level                  scene                  category                dungeon                         operator          missions',
	);
	for (const row of rows) {
		let scene = row.scene ?? '-';
		if (row.level !== null && row.scene === row.level) {
			scene = '=';
		} else if (row.level !== null && row.scene === null) {
			scene = '(not shipped)';
		}
		const missions =
			row.missions
				.map((mission) => (mission.name ? `${mission.id} ${mission.name}` : mission.id))
				.join(', ') || '-';
		console.log(
			`${(row.level ?? '-').padEnd(22)} ${scene.padEnd(22)} ${(row.category ?? '-').padEnd(23)} ${row.id.padEnd(31)} ${(row.operator ?? '-').padEnd(17)} ${missions}`,
		);
	}
	const unreached = rows.filter((row) => row.missions.length === 0).length;
	console.error(
		`${rows.length} dungeon entries, ${unreached} named by no mission; scene '=' is the level's own`,
	);
};

const listLevels = async (world: WorldIndex, mapId: string, verify: boolean): Promise<void> => {
	const partition = await requirePartition(world, mapId);
	const names = await world.names();
	console.log('tag  level          idNum  cells  rect (x,z min → max)          init pos             name');
	for (const level of partition.levels) {
		const { config } = level;
		const rect = `${config.rectLeftBottom.join(',')} → ${config.rectRightTop.join(',')}`;
		const init = config.playerInitPos.map((v) => Math.round(v)).join(',');
		console.log(
			`${String(level.tag).padStart(3)}  ${level.id.padEnd(14)} ${String(level.idNum).padStart(5)}  ${String(level.cells.size).padStart(5)}  ${rect.padEnd(28)}  ${init.padEnd(19)}  ${names.get(level.id) ?? ''}`,
		);
	}
	const owned = partition.map.levelIds.filter((id) => id !== 0).length;
	console.log(`\n${owned} of ${partition.map.levelIds.length} grid cells owned by a level`);
	for (const issue of partition.issues) {
		console.log(`issue: ${issue.level}: ${issue.message}`);
	}
	if (partition.issues.length === 0) {
		console.log('MapConfig grid and LevelConfig levelGrids agree exactly');
	}
	if (verify) {
		const samples: { tag: number; x: number; z: number }[] = [];
		for await (const entity of world.sceneEntities(
			mapId,
			(file) => file.cell !== null && file.sceneState === 0,
		)) {
			if (entity.pivot !== null) {
				samples.push({ tag: entity.id >>> 27, x: entity.pivot.x, z: entity.pivot.z });
			}
		}
		console.log('\ntag  rule level      majority cell owner  share   entities');
		for (const vote of voteLevelTags(partition, samples)) {
			const flag = vote.rule === null || vote.rule === vote.majority ? '' : '  MISMATCH';
			console.log(
				`${String(vote.tag).padStart(3)}  ${(vote.rule ?? '-').padEnd(14)} ${(vote.majority ?? '-').padEnd(20)} ${(vote.share * 100).toFixed(1).padStart(5)}%  ${String(vote.count).padStart(8)}${flag}`,
			);
		}
	}
};

// #endregion
