import { parseArgs } from 'node:util';

import {
	cellKey,
	levelOfTag,
	voteLevelTags,
	type LevelPartition,
} from '@endfield-noclip/formats/endfield/level-partition';
import { CELL_SIZE } from '@endfield-noclip/formats/endfield/map-config';

import { parseInteger, parseOptionalInteger, separatePositionals } from '../cli-args.ts';
import { withContext } from '../context.ts';
import type { IndexedEntity, WorldIndex } from '../game/world-index.ts';

export const summary =
	'world index: maps | levels <map> [--verify] | cells <level> | entities <map> <x> <z>|global | members <level> | resolve <path|hash>';

const USAGE = `usage:
  world maps                               streaming scenes, with level counts for open-world maps
  world levels <map> [--verify]            levels with tag, cells and names; --verify votes tags against cells
  world cells <level>                      cells a level owns and their chunk files
  world entities <map> <x> <z> [--json]    entities in one cell's chunks (or 'global'); --layer/--state filter
  world members <level> [--json]           every entity the level owns, bucketed by placement
  world resolve <path|hash>                path ↔ hash, then asset → bundle + dependencies`;

const OPTIONS = {
	config: { type: 'string' },
	json: { type: 'boolean', default: false },
	verify: { type: 'boolean', default: false },
	layer: { type: 'string' },
	state: { type: 'string' },
} as const;

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args: separatePositionals(args, OPTIONS),
		allowPositionals: true,
		options: OPTIONS,
	});
	const [sub, ...rest] = positionals;

	await withContext(values.config, async ({ world }) => {
		switch (sub) {
			case 'maps': {
				await listMaps(world);
				break;
			}
			case 'levels': {
				await listLevels(world, need(rest[0], 'map'), values.verify);
				break;
			}
			case 'cells': {
				await listCells(world, need(rest[0], 'level'));
				break;
			}
			case 'entities': {
				await listEntities(world, need(rest[0], 'map'), need(rest[1], 'x'), rest[2], {
					json: values.json,
					layer: parseOptionalInteger(values.layer, '--layer'),
					state: parseOptionalInteger(values.state, '--state'),
				});
				break;
			}
			case 'members': {
				await listMembers(world, need(rest[0], 'level'), values.json);
				break;
			}
			case 'resolve': {
				await resolve(world, need(rest[0], 'path or hash'));
				break;
			}
			default: {
				throw new Error(USAGE);
			}
		}
	});
};

const need = (value: string | undefined, what: string): string => {
	if (value === undefined) {
		throw new Error(`missing ${what}\n${USAGE}`);
	}
	return value;
};

const requirePartition = async (world: WorldIndex, mapId: string): Promise<LevelPartition> => {
	const partition = await world.partition(mapId);
	if (partition === undefined) {
		throw new Error(`${mapId} has no MapConfig, so it has no level partition`);
	}
	return partition;
};

// #region subcommands

const listMaps = async (world: WorldIndex): Promise<void> => {
	const names = await world.names();
	const files = await world.chunkFiles();
	for (const scene of await world.scenes()) {
		const chunks = files.filter((file) => file.scene === scene);
		const partition = await world.partition(scene);
		const levels =
			partition === undefined ? '' : `${partition.levels.length} levels, ${partition.map.sideGridNum}² grid`;
		console.log(
			`${scene.padEnd(20)} ${String(chunks.length).padStart(6)} init chunks  ${levels.padEnd(24)} ${names.get(scene) ?? ''}`,
		);
	}
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
		// tag votes over layer-0 default-state scenery: which level's cells hold each tag's pivots
		const samples: { tag: number; x: number; z: number }[] = [];
		for await (const entity of world.sceneEntities(mapId, (file) => file.cell !== null && file.layer === 0)) {
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

const findLevel = async (world: WorldIndex, levelId: string) => {
	const mapId = (await world.levelConfigs()).get(levelId)?.mapId;
	if (!mapId) {
		throw new Error(`${levelId} has no LevelConfig`);
	}
	const partition = await requirePartition(world, mapId);
	const level = partition.levels.find((candidate) => candidate.id === levelId);
	if (level === undefined) {
		throw new Error(`${levelId} owns no cells of ${mapId}'s grid`);
	}
	return { partition, level };
};

const listCells = async (world: WorldIndex, levelId: string): Promise<void> => {
	const { partition, level } = await findLevel(world, levelId);
	const byCell = new Map<number, string[]>();
	for (const file of await world.chunkFiles()) {
		if (file.scene === partition.mapId && file.cell !== null) {
			const key = cellKey(file.cell.x, file.cell.z);
			if (level.cells.has(key)) {
				const list = byCell.get(key) ?? [];
				list.push(`${file.layer}/${file.state}`);
				byCell.set(key, list);
			}
		}
	}
	const cells = (level.config.levelGrids ?? []).toSorted((a, b) => a.z - b.z || a.x - b.x);
	console.log(`${level.id} (tag ${level.tag}): ${cells.length} cells`);
	console.log('   x    z   world x,z min        chunk files (layer/state)');
	for (const cell of cells) {
		const files = byCell.get(cellKey(cell.x, cell.z)) ?? [];
		const origin = `${cell.x * CELL_SIZE},${cell.z * CELL_SIZE}`;
		console.log(
			`${String(cell.x).padStart(4)} ${String(cell.z).padStart(4)}   ${origin.padEnd(18)} ${files.join(' ') || '-'}`,
		);
	}
};

const listEntities = async (
	world: WorldIndex,
	mapId: string,
	xArg: string,
	zArg: string | undefined,
	options: { json: boolean; layer: number | undefined; state: number | undefined },
): Promise<void> => {
	const cell =
		xArg === 'global' ? 'global' : { x: parseInteger(xArg, 'cell x'), z: parseInteger(zArg ?? '', 'cell z') };
	const partition = await world.partition(mapId);
	const files = await world.cellChunkFiles(mapId, cell, options);
	if (files.length === 0) {
		throw new Error(`no InitChunkData for ${mapId} ${cell === 'global' ? 'Global' : `${cell.x},${cell.z}`}`);
	}

	const rows: object[] = [];
	for (const file of files) {
		const entities = await world.readChunk(file, partition);
		if (!options.json) {
			console.log(`# ${file.name} (${entities.length} entities)`);
		}
		for (const entity of entities) {
			if (options.json) {
				rows.push(await entityJson(world, entity, partition));
			} else {
				console.log(await entityLine(world, entity));
			}
		}
	}
	if (options.json) {
		console.log(JSON.stringify(rows, null, '\t'));
	}
};

const listMembers = async (world: WorldIndex, levelId: string, json: boolean): Promise<void> => {
	const { partition, level } = await findLevel(world, levelId);
	const counts = new Map<string, { all: number; renderer: number }>();
	const rows: object[] = [];
	for await (const entity of world.entitiesOfLevel(level, partition)) {
		const where = entity.source.cell === null ? 'global' : entity.membership.placement;
		const count = counts.get(where) ?? { all: 0, renderer: 0 };
		count.all++;
		if (entity.renderer !== null) {
			count.renderer++;
		}
		counts.set(where, count);
		if (json) {
			rows.push(await entityJson(world, entity, partition));
		}
	}
	if (json) {
		console.log(JSON.stringify(rows, null, '\t'));
		return;
	}
	console.log(`${level.id} (tag ${level.tag}) members by placement:`);
	let total = 0;
	let renderers = 0;
	for (const [where, count] of [...counts].toSorted(([a], [b]) => a.localeCompare(b))) {
		console.log(`  ${where.padEnd(10)} ${String(count.all).padStart(8)}  (${count.renderer} with renderers)`);
		total += count.all;
		renderers += count.renderer;
	}
	console.log(`  ${'total'.padEnd(10)} ${String(total).padStart(8)}  (${renderers} with renderers)`);
};

const resolve = async (world: WorldIndex, query: string): Promise<void> => {
	const manifest = await world.manifest();
	let hashes: bigint[];
	if (/^(0x[0-9a-f]+|\d+)$/i.test(query)) {
		hashes = [BigInt.asUintN(64, BigInt(query))];
		const path = await world.pathOf(hashes[0]);
		console.log(`hash ${hashes[0]} (0x${hashes[0].toString(16)}) → ${path ?? '(not in StringPathHash)'}`);
	} else {
		hashes = await world.hashesOf(query);
		if (hashes.length === 0) {
			throw new Error(`${query} is not in StringPathHash`);
		}
		console.log(`${query} → hash ${hashes.map((hash) => `${hash} (0x${hash.toString(16)})`).join(', ')}`);
	}

	for (const hash of hashes) {
		const assets = manifest.findAssets(hash);
		if (assets.length === 0) {
			console.log('  not a bundled asset (no manifest AssetInfo)');
		}
		const seen = new Set<number>();
		for (const asset of assets) {
			if (seen.has(asset.bundleIndex)) {
				continue;
			}
			seen.add(asset.bundleIndex);
			const bundle = manifest.bundle(asset.bundleIndex);
			console.log(`  asset ${manifest.assetPath(asset)} (${asset.size} bytes)`);
			console.log(`  bundle #${bundle.index} ${bundle.name}`);
			console.log(`    direct deps (${bundle.directDependencies.length}):`);
			for (const dep of bundle.directDependencies) {
				console.log(`      ${manifest.bundle(dep).name}`);
			}
			console.log(`    closure: ${bundle.dependencies.length} bundles`);
		}
	}
};

// #endregion

// #region formatting

const entityLine = async (world: WorldIndex, entity: IndexedEntity): Promise<string> => {
	const p = entity.pivot;
	const pos = p === null ? '-' : `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`;
	const { membership } = entity;
	const owner = membership.level?.id ?? membership.bucket;
	let draws = '';
	if (entity.renderer !== null) {
		const first = entity.renderer.draws[0];
		const mesh = first === undefined ? '' : ((await world.pathOf(first.meshHash)) ?? '?').split('##').pop();
		draws = `  ${entity.renderer.draws.length} draws/${entity.renderer.lodCount} lods  ${mesh}`;
	}
	return `${String(entity.id).padStart(10)} t${String(entity.levelTag).padEnd(2)} ${owner.padEnd(12)} ${membership.placement.padEnd(9)} ${pos.padEnd(26)} ${entity.name}${draws}`;
};

const entityJson = async (
	world: WorldIndex,
	entity: IndexedEntity,
	partition: LevelPartition | undefined,
): Promise<object> => {
	const manifest = await world.manifest();
	const bundleOf = (hash: bigint): string | null => {
		const asset = manifest.findAssets(hash)[0];
		return asset === undefined ? null : manifest.bundle(asset.bundleIndex).name;
	};
	return {
		id: entity.id,
		levelTag: entity.levelTag,
		level: entity.membership.level?.id ?? (partition && levelOfTag(partition, entity.levelTag)?.id) ?? null,
		bucket: entity.membership.bucket,
		placement: entity.membership.placement,
		cellOwner: entity.membership.cellOwner?.id ?? null,
		name: entity.name,
		source: entity.source.name,
		matrix: entity.matrix === null ? null : [...entity.matrix],
		bounds: entity.bounds,
		decal: entity.decal,
		components: entity.components,
		renderer:
			entity.renderer === null
				? null
				: {
						lodCount: entity.renderer.lodCount,
						draws: await Promise.all(
							entity.renderer.draws.map(async (draw) => ({
								lod: draw.lod,
								mesh: (await world.pathOf(draw.meshHash)) ?? `0x${draw.meshHash.toString(16)}`,
								meshBundle: bundleOf(draw.meshHash),
								material: (await world.pathOf(draw.materialHash)) ?? `0x${draw.materialHash.toString(16)}`,
								materialBundle: bundleOf(draw.materialHash),
								submesh: draw.submesh,
								flags: draw.flags,
								lodMaxSquared: draw.lodMaxSquared,
								lodMinSquared: draw.lodMinSquared,
							})),
						),
					},
	};
};

// #endregion
