import { readFile } from 'node:fs/promises';
import { basename } from 'node:path/posix';
import { parseArgs } from 'node:util';

import type { EnvironmentVolume } from '@endfield-noclip/formats/endfield/environment-volume';
import { StreamingLayer, type ChunkEntity } from '@endfield-noclip/formats/endfield/init-chunk-data';
import {
	cellKey,
	levelOfTag,
	voteLevelTags,
	type LevelPartition,
} from '@endfield-noclip/formats/endfield/level-partition';
import { CELL_SIZE } from '@endfield-noclip/formats/endfield/map-config';
import type { Aabb } from '@endfield-noclip/formats/unity/values';
import { ruleText } from '@endfield-noclip/package-format/conditions';

import { mapDefined } from '@mary-ext/array-fns';

import {
	DEFAULT_OUT,
	hashText,
	need as needArg,
	parseHash,
	parseInteger,
	parseNumbers,
	parseOptionalInteger,
	separatePositionals,
} from '../cli-args.ts';
import { type Context, withContext } from '../context.ts';
import { errorText, ignoreMissing } from '../errors.ts';
import type { StructureModel } from '../game/dynamic/dynamic-structures.ts';
import {
	loadLevelPhases,
	loadSceneVolumes,
	resolveLevelEnvironment,
	resolveLevelPost,
	scenePhaseLoader,
} from '../game/environment.ts';
import {
	boxDistance,
	describeAlternatives,
	parsePlacementKinds,
	PLACEMENT_KINDS,
	type PlacementKind,
} from '../game/placements.ts';
import { sourceVisibility } from '../game/state/chunk-sources.ts';
import { defaultSceneStates, sceneStateControl } from '../game/state/scene-conditions.ts';
import { stripMarkup } from '../game/state/story.ts';
import { loadDungeonUses, readOperatorNames } from '../game/world/dungeons.ts';
import { type IndexedEntity, pivotOf, type WorldIndex } from '../game/world/world-index.ts';
import { DEBUG_DIR, STAND_INS_FILE, type StandInReport } from '../pack/debug.ts';
import { type ScenePlacementSurvey, surveyPlacedVolumes, surveyPlacements } from '../pack/survey.ts';

export const summary = 'browse scenes and levels; search asset paths and everything placed in a scene';

/** command usage, available without opening the install */
export const usage = `usage:
  world paths <re> [--limit n] [--json]    search both path catalogs, with hashes and bundle names
  world find <scene> [--name re] [--near x,y,z --radius n] [--kind k,…] [--max-size n] [--limit n] [--json]
                                          everything placed in a scene, in every state and area, with what
                                          gates it. kinds: static (chunk entities), dynamic (dynamic-structure
                                          entities), model and effect (dynamic prefab rows), facility
                                          (interactives), cabin (Dijiang cabin rows); default all
                                          --name matches entity names, mesh/material and prefab paths
                                          --near: Unity coordinates, 3D distance to the bounds (else the
                                          pivot), nearest and then smallest first; marks stand-ins from
                                          out/<scene>/debug/stand-ins.json
                                          --max-size drops bounds longer than n m (HLOD clusters, volumes)
                                          --scene-state/--area filter static chunk files only
  world scenes                             streaming scenes, with level counts for open-world maps
  world dungeons [--category re] [--json]  dungeon entries (operator stories are dungeon_char): their level, the
                                          scene it streams, operator, and the missions that lead there ('-': none,
                                          so reached from a menu or NPC, or not at all)
  world levels <map> [--verify]            levels with tag, cells and names; --verify votes tags against cells
  world cells <level>                      cells a level owns and their chunk files
  world entities <scene> <x> <z> [--json]  entities in one cell's chunks (or 'global'); --scene-state/--area filter
  world members <level> [--json]           every entity the level owns, bucketed by placement
  world env <map|level>                    base environment per level (a map lists all), and why
  world resolve <path|hash>                path ↔ hash, then asset → bundle + dependencies`;

const OPTIONS = {
	config: { type: 'string' },
	json: { type: 'boolean', default: false },
	verify: { type: 'boolean', default: false },
	'scene-state': { type: 'string' },
	area: { type: 'string' },
	name: { type: 'string' },
	near: { type: 'string' },
	radius: { type: 'string' },
	kind: { type: 'string' },
	'max-size': { type: 'string' },
	limit: { type: 'string' },
	category: { type: 'string' },
} as const;

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args: separatePositionals(args, OPTIONS),
		allowPositionals: true,
		options: OPTIONS,
	});
	const [sub, ...rest] = positionals;

	await withContext(values.config, async (context) => {
		const { world } = context;
		switch (sub) {
			case 'paths': {
				await findPaths(
					world,
					new RegExp(need(rest[0], 'pattern'), 'i'),
					searchLimit(values.limit),
					values.json,
				);
				break;
			}
			case 'find': {
				const near = values.near === undefined ? undefined : parseNumbers(values.near, 3, '--near');
				const radius =
					values.radius === undefined ? undefined : parseNumbers(values.radius, 1, '--radius')[0];
				if ((near === undefined) !== (radius === undefined) || (radius !== undefined && radius < 0)) {
					throw new Error('use --near x,y,z with --radius n (nonnegative)');
				}
				await findPlacements(context, need(rest[0], 'scene'), {
					pattern: values.name === undefined ? undefined : new RegExp(values.name, 'i'),
					near,
					radius,
					kinds: values.kind === undefined ? new Set(PLACEMENT_KINDS) : parsePlacementKinds(values.kind),
					maxSize:
						values['max-size'] === undefined
							? undefined
							: parseNumbers(values['max-size'], 1, '--max-size')[0],
					limit: searchLimit(values.limit),
					json: values.json,
					sceneState: parseOptionalInteger(values['scene-state'], '--scene-state'),
					area: parseOptionalInteger(values.area, '--area'),
				});
				break;
			}
			case 'scenes': {
				await listScenes(world);
				break;
			}
			case 'dungeons': {
				await listDungeons(context, {
					category: values.category === undefined ? undefined : new RegExp(values.category, 'i'),
					json: values.json,
				});
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
				await listEntities(world, need(rest[0], 'scene'), need(rest[1], 'x'), rest[2], {
					json: values.json,
					sceneState: parseOptionalInteger(values['scene-state'], '--scene-state'),
					area: parseOptionalInteger(values.area, '--area'),
				});
				break;
			}
			case 'members': {
				await listMembers(world, need(rest[0], 'level'), values.json);
				break;
			}
			case 'env': {
				await showEnvironment(context, need(rest[0], 'map or level'));
				break;
			}
			case 'resolve': {
				await resolve(world, need(rest[0], 'path or hash'));
				break;
			}
			default: {
				throw new Error(usage);
			}
		}
	});
};

const need = (value: string | undefined, what: string): string => needArg(value, what, usage);

const requirePartition = async (world: WorldIndex, mapId: string): Promise<LevelPartition> => {
	const partition = await world.partition(mapId);
	if (partition === undefined) {
		throw new Error(`${mapId} has no MapConfig, so it has no level partition`);
	}
	return partition;
};

// #region subcommands

const searchLimit = (text: string | undefined): number => {
	const limit = parseOptionalInteger(text, '--limit') ?? 100;
	if (limit < 1) {
		throw new Error('--limit must be a positive integer');
	}
	return limit;
};

const findPaths = async (world: WorldIndex, pattern: RegExp, limit: number, json: boolean): Promise<void> => {
	const [main, initial, manifest] = await Promise.all([
		world.pathHash(),
		world.initPathHash(),
		world.manifest(),
	]);
	const rows: { hash: string; path: string; bundles: string[] }[] = [];
	const seen = new Set<string>();
	for (const table of [main, initial]) {
		for (const [hash, path] of table.entries()) {
			const key = `${hash}:${path}`;
			if (!pattern.test(path) || seen.has(key)) {
				continue;
			}
			seen.add(key);
			const bundles = [
				...new Set(manifest.findAssets(hash).map((asset) => manifest.bundleName(asset.bundleIndex))),
			];
			rows.push({ hash: hashText(hash), path, bundles });
			if (rows.length >= limit) {
				break;
			}
		}
		if (rows.length >= limit) {
			break;
		}
	}
	if (json) {
		console.log(JSON.stringify(rows, null, '\t'));
	} else {
		for (const row of rows) {
			console.log(`${row.hash}\t${row.path}\t${row.bundles.join(',') || '-'}`);
		}
	}
	console.error(
		`${rows.length} matches${rows.length === limit ? ' (limit reached; raise --limit for more)' : ''}`,
	);
};

/** a `world find` result, from any placement source */
interface FoundRow {
	kind: PlacementKind;
	name: string;
	/** world position: the pivot or placement position */
	position: [number, number, number] | null;
	/** to the bounds where known, else to the position; `null` without `--near` */
	distance: number | null;
	/** the bounds' longest side, `null` without bounds */
	size: number | null;
	/** owning level id, or the membership bucket for static entities */
	level: string | null;
	/** when the game loads it, as `describeAlternatives` writes it */
	visibility: string;
	/** chunk file, dynamic resource row, LevelData row or cabin row */
	source: string;
	/** draws or the prefab, for the text line */
	summary: string;
	/** stand-in reasons from the package's `debug/stand-ins.json` */
	standIns: string[];
	json: object;
}

/** `world find`'s options */
interface FindOptions {
	pattern: RegExp | undefined;
	near: number[] | undefined;
	radius: number | undefined;
	kinds: Set<PlacementKind>;
	/** drops rows whose bounds' longest side is longer, in metres */
	maxSize: number | undefined;
	limit: number;
	json: boolean;
	sceneState: number | undefined;
	area: number | undefined;
}

const findPlacements = async (context: Context, scene: string, options: FindOptions): Promise<void> => {
	const { world } = context;
	if (!(await world.scenes()).includes(scene)) {
		throw new Error(`unknown streaming scene ${scene}`);
	}
	const { kinds, limit } = options;
	const partition = await world.partition(scene);
	const lookups: FindLookups = {
		partition,
		names: await assetNames(world),
		standIns: await loadStandIns(scene),
		levelOf: (tag) => (partition && levelOfTag(partition, tag)?.id) ?? (tag === 0 ? 'shared' : `tag ${tag}`),
	};
	const rows = new FoundRows(options);

	if (kinds.has('static')) {
		for await (const candidate of staticCandidates(world, scene, options, lookups)) {
			rows.add(candidate);
			if (rows.full) {
				break;
			}
		}
	}
	const placedKinds = kinds.has('static') ? kinds.size > 1 : kinds.size > 0;
	const survey = rows.full || !placedKinds ? null : await surveyPlacements(context, scene).catch(errorText);
	if (typeof survey === 'string') {
		console.error(`${[...kinds].filter((kind) => kind !== 'static').join(', ')}: not searched: ${survey}`);
	} else if (survey !== null) {
		for (const candidate of surveyCandidates(survey, kinds, lookups)) {
			rows.add(candidate);
			if (rows.full) {
				break;
			}
		}
	}

	const shown = rows.shown();
	if (options.json) {
		console.log(
			JSON.stringify(
				shown.map((row) => row.json),
				null,
				'\t',
			),
		);
	} else {
		for (const row of shown) {
			console.log(foundLine(row));
		}
	}
	const counts = PLACEMENT_KINDS.flatMap((kind) => {
		const n = shown.filter((row) => row.kind === kind).length;
		return n === 0 ? [] : [`${n} ${kind}`];
	});
	console.error(
		`${shown.length} matches${counts.length === 0 ? '' : ` (${counts.join(', ')})`}${rows.length >= limit ? '; limit reached, raise --limit for more' : ''}${lookups.standIns.found ? '' : `; no out/${scene}/debug/stand-ins.json, so stand-ins aren't marked`}`,
	);
};

/** a placement a source found, before `--max-size`, `--near` and `--name` filter it */
interface FoundCandidate {
	bounds: Aabb | null;
	position: readonly number[] | null;
	/** what `--name` matches */
	labels: readonly string[];
	/** builds the row, only for candidates kept */
	row: (distance: number | null) => Omit<FoundRow, 'distance' | 'size'>;
}

/** what the sources name and mark their rows with */
interface FindLookups {
	partition: LevelPartition | undefined;
	names: AssetNames;
	standIns: StandInIndex;
	/** a level tag's level id, `shared` for tag 0 */
	levelOf: (tag: number) => string | null;
}

/** the rows `world find` keeps, filtered as they're added */
class FoundRows {
	readonly #options: Pick<FindOptions, 'pattern' | 'near' | 'radius' | 'maxSize' | 'limit'>;
	readonly #rows: FoundRow[] = [];

	constructor(options: FindOptions) {
		this.#options = options;
	}

	get length(): number {
		return this.#rows.length;
	}

	/** whether the scan can stop: without `--near`, results keep source order and stop at the limit */
	get full(): boolean {
		return this.#options.near === undefined && this.#rows.length >= this.#options.limit;
	}

	/** keeps a candidate that passes the filters */
	add(candidate: FoundCandidate): void {
		const { pattern } = this.#options;
		const place = this.#measure(candidate.bounds, candidate.position);
		if (
			place === undefined ||
			(pattern !== undefined && !candidate.labels.some((label) => pattern.test(label)))
		) {
			return;
		}
		this.#rows.push({ ...candidate.row(place.distance), ...place });
	}

	/**
	 * @returns the rows up to the limit: with `--near` nearest first and, among rows whose bounds hold the
	 *   point, the smallest first, so HLOD clusters, merged meshes and wide volumes don't crowd out what sits
	 *   there
	 */
	shown(): FoundRow[] {
		const rows =
			this.#options.near === undefined
				? this.#rows
				: this.#rows.toSorted(
						(a, b) => (a.distance ?? 0) - (b.distance ?? 0) || (a.size ?? 0) - (b.size ?? 0),
					);
		return rows.slice(0, this.#options.limit);
	}

	/** @returns where a row sits relative to `--near`, or `undefined` to drop it */
	#measure(
		bounds: Aabb | null,
		position: readonly number[] | null,
	): Pick<FoundRow, 'distance' | 'size'> | undefined {
		const { near, radius, maxSize } = this.#options;
		const size = bounds === null ? null : 2 * Math.max(...bounds.extents);
		if (maxSize !== undefined && size !== null && size > maxSize) {
			return undefined;
		}
		if (near === undefined || radius === undefined) {
			return { distance: null, size };
		}
		let distance: number;
		if (bounds !== null) {
			distance = boxDistance(near, bounds);
		} else if (position !== null) {
			distance = Math.hypot(position[0] - near[0], position[1] - near[1], position[2] - near[2]);
		} else {
			return undefined;
		}
		return distance <= radius ? { distance, size } : undefined;
	}
}

/** @returns an entity's draws' mesh and material paths, for `--name` */
const drawLabels = (entity: ChunkEntity, { pathOf }: AssetNames): string[] =>
	entity.renderer?.draws.flatMap((draw) => [
		pathOf(draw.meshHash) ?? hashText(draw.meshHash),
		pathOf(draw.materialHash) ?? hashText(draw.materialHash),
	]) ?? [];

/** the scene's chunk entities, from the files `--scene-state`, `--area` and `--near` select */
async function* staticCandidates(
	world: WorldIndex,
	scene: string,
	options: Pick<FindOptions, 'near' | 'radius' | 'sceneState' | 'area'>,
	lookups: FindLookups,
): AsyncGenerator<FoundCandidate> {
	const { near, radius } = options;
	const { names, standIns, partition } = lookups;
	// a cell of margin keeps entities whose bounds reach into the searched cells
	const cell =
		near === undefined ? null : { x: Math.floor(near[0] / CELL_SIZE), z: Math.floor(near[2] / CELL_SIZE) };
	const reach = radius === undefined ? 0 : Math.ceil(radius / CELL_SIZE) + 1;
	for await (const entity of world.sceneEntities(
		scene,
		(file) =>
			(options.sceneState === undefined || file.sceneState === options.sceneState) &&
			(options.area === undefined || file.area === options.area) &&
			(cell === null ||
				file.cell === null ||
				(Math.abs(file.cell.x - cell.x) <= reach && Math.abs(file.cell.z - cell.z) <= reach)),
	)) {
		const position = entity.pivot === null ? null : [entity.pivot.x, entity.pivot.y, entity.pivot.z];
		yield {
			bounds: entity.bounds,
			position,
			labels: [entity.name, ...drawLabels(entity, names)],
			row: (distance) => {
				const visibility = describeAlternatives(sourceVisibility([entity.source])?.alternatives ?? [[]]);
				const reasons = standIns.atEntity(entity.name, position);
				return {
					kind: 'static',
					name: entity.name,
					position: position === null ? null : [position[0], position[1], position[2]],
					level: entity.membership.level?.id ?? entity.membership.bucket,
					visibility,
					source: basename(entity.source.name),
					summary: `${drawSummary(entity, names)}  layer ${layerName(entity.layer)}`,
					standIns: reasons,
					json: {
						kind: 'static',
						...entityJson(entity, partition, names),
						visibility,
						standIns: reasons,
						distance,
					},
				};
			},
		};
	}
}

const prefab = (kind: PlacementKind, model: StructureModel) => ({ kind, model });

/** the requested kinds of the scene's placements outside its chunk files, as the packer finds them */
function* surveyCandidates(
	survey: ScenePlacementSurvey,
	kinds: ReadonlySet<PlacementKind>,
	lookups: FindLookups,
): Generator<FoundCandidate> {
	const { dynamic, interactives, structureModels } = survey;
	const { names, standIns, levelOf } = lookups;
	if (kinds.has('dynamic')) {
		for (const { entity, visibility: gates } of dynamic.entities) {
			const pivot = pivotOf(entity);
			const position = pivot === null ? null : [pivot.x, pivot.y, pivot.z];
			yield {
				bounds: entity.bounds,
				position,
				labels: [entity.name, ...drawLabels(entity, names)],
				row: (distance) => {
					const visibility = describeAlternatives(gates.alternatives);
					const reasons = standIns.atEntity(entity.name, position);
					return {
						kind: 'dynamic',
						name: entity.name,
						position: position === null ? null : [position[0], position[1], position[2]],
						level: levelOf(entity.levelTag),
						visibility,
						source: `entity ${entity.id}`,
						summary: drawSummary(entity, names),
						standIns: reasons,
						json: {
							kind: 'dynamic',
							id: entity.id,
							levelTag: entity.levelTag,
							level: levelOf(entity.levelTag),
							name: entity.name,
							pivot,
							visibility,
							standIns: reasons,
							...chunkEntityJson(entity, names),
							distance,
						},
					};
				},
			};
		}
	}
	const prefabs = [
		// effect rows are keyed `effect:<grid>/<index>`, model rows `<grid>/<index>`
		...structureModels.map((model) => prefab(model.source.startsWith('effect:') ? 'effect' : 'model', model)),
		...interactives.facilityModels.map((model) => prefab('facility', model)),
		...interactives.cabinModels.map((model) => prefab('cabin', model)),
	];
	for (const { kind, model } of prefabs) {
		if (!kinds.has(kind)) {
			continue;
		}
		const { pathHash, position, rotation, scale } = model.model;
		// the manifest's asset path, as the packer names prefabs in its reports
		const path = names.assetPathOf(pathHash) ?? names.pathOf(pathHash) ?? hashText(pathHash);
		yield {
			bounds: null,
			position,
			labels: [path, model.source],
			row: (distance) => {
				const visibility = describeAlternatives(model.visibility.alternatives);
				const bundle = names.bundleOf(pathHash);
				const reasons = standIns.ofPrefab(path);
				return {
					kind,
					name: basename(path),
					position: [...position],
					level: levelOf(model.levelTag),
					visibility,
					source: model.source,
					summary: `${path}  ${bundle ?? '-'}`,
					standIns: reasons,
					json: {
						kind,
						path,
						bundle,
						level: levelOf(model.levelTag),
						position,
						rotation,
						scale,
						source: model.source,
						visibility,
						alternatives: model.visibility.alternatives,
						standIns: reasons,
						distance,
					},
				};
			},
		};
	}
	if (kinds.has('facility')) {
		for (const standIn of interactives.standIns) {
			yield {
				bounds: null,
				position: standIn.position,
				labels: [standIn.template, standIn.source],
				row: (distance) => ({
					kind: 'facility',
					name: standIn.template,
					position: [...standIn.position],
					level: levelOf(standIn.levelTag),
					visibility: 'always',
					source: standIn.source,
					summary: `no model: ${standIn.reason}`,
					standIns: [standIn.reason],
					json: {
						kind: 'facility',
						...standIn,
						level: levelOf(standIn.levelTag),
						model: null,
						distance,
					},
				}),
			};
		}
	}
}

/** stand-ins the scene's package reports, for marking found rows */
interface StandInIndex {
	found: boolean;
	/** reasons for a prefab's renderers, by the prefab's asset path */
	ofPrefab: (path: string) => string[];
	/** reasons for placed stand-ins with this name within a metre or two of the position */
	atEntity: (name: string, position: readonly number[] | null) => string[];
}

const loadStandIns = async (scene: string): Promise<StandInIndex> => {
	const text = await ignoreMissing(
		readFile(new URL(`${scene}/${DEBUG_DIR}/${STAND_INS_FILE}`, DEFAULT_OUT), 'utf8'),
		null,
	);
	if (text === null) {
		return { found: false, ofPrefab: () => [], atEntity: () => [] };
	}
	const reports: StandInReport[] = JSON.parse(text);
	const byPrefab = new Map<string, Set<string>>();
	const byName = new Map<string, { reason: string; position: number[] }[]>();
	for (const { path, name, reason, position } of reports) {
		if (position === null) {
			byPrefab.getOrInsertComputed(path, () => new Set()).add(`${name}: ${reason}`);
		} else {
			byName.getOrInsertComputed(name, () => []).push({ reason, position });
		}
	}
	return {
		found: true,
		ofPrefab: (path) => [...(byPrefab.get(path) ?? [])],
		atEntity: (name, position) =>
			position === null
				? []
				: (byName.get(name) ?? []).flatMap((report) =>
						// stand-in positions are bounds centres rounded to the metre
						Math.hypot(...report.position.map((v, i) => v - position[i])) <= 2 ? [report.reason] : [],
					),
	};
};

const foundLine = (row: FoundRow): string => {
	const distance = row.distance === null ? '' : `${row.distance.toFixed(1).padStart(6)} m  `;
	const size = row.size === null ? '' : `  ${row.size.toFixed(0)} m across`;
	const position = row.position === null ? '-' : row.position.map((v) => v.toFixed(1)).join(',');
	const standIn = row.standIns.length === 0 ? '' : `  STAND-IN: ${row.standIns.join('; ')}`;
	return `${distance}${row.kind.padEnd(8)} ${(row.level ?? '-').padEnd(12)} ${position.padEnd(24)} ${row.name}${size}  [${row.visibility}]  ${row.summary}  @ ${row.source}${standIn}`;
};

/** an entity's draws: the first draw's mesh and material, with the material's bundle for `asset material` */
const drawSummary = (entity: ChunkEntity, { pathOf, bundleOf }: AssetNames): string => {
	const { renderer } = entity;
	if (renderer === null) {
		// the component ids show what else the entity carries, e.g. one the packer doesn't read
		return `${entity.decal === null ? 'no renderer' : 'rect decal'} (components ${entity.components.join(' ')})`;
	}
	const first = renderer.draws[0];
	if (first === undefined) {
		return 'no draws';
	}
	const mesh = (pathOf(first.meshHash) ?? hashText(first.meshHash)).split('##').pop();
	const material = pathOf(first.materialHash) ?? hashText(first.materialHash);
	return `${renderer.draws.length} draws/${renderer.lodCount} lods  ${mesh}  ${material}  ${bundleOf(first.materialHash) ?? '-'}`;
};

const listScenes = async (world: WorldIndex): Promise<void> => {
	const names = await world.names();
	const files = await world.chunkFiles();
	const scenes = await world.scenes();
	const partitions = await Promise.all(scenes.map((scene) => world.partition(scene)));
	for (const [i, scene] of scenes.entries()) {
		const chunks = files.filter((file) => file.scene === scene);
		const partition = partitions[i];
		const levels =
			partition === undefined ? '' : `${partition.levels.length} levels, ${partition.map.sideGridNum}² grid`;
		console.log(
			`${scene.padEnd(20)} ${String(chunks.length).padStart(6)} init chunks  ${levels.padEnd(24)} ${names.get(scene) ?? ''}`,
		);
	}
};

const listDungeons = async (
	context: Context,
	options: {
		/** keeps rows whose category matches */
		category: RegExp | undefined;
		json: boolean;
	},
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
	const rows = uses
		.filter(({ dungeon }) => options.category === undefined || options.category.test(dungeon.category ?? ''))
		.map(({ dungeon, scene, charId, missions }) => ({
			id: dungeon.id,
			name: dungeon.name ?? (dungeon.levelId === null ? null : levelNames.get(dungeon.levelId)) ?? null,
			category: dungeon.category,
			level: dungeon.levelId,
			scene,
			charId,
			operator: charId === null ? null : (operators.get(charId) ?? null),
			missions: missions.map((mission) => ({ id: mission.id, name: missionName(mission.nameKey) })),
		}))
		.toSorted(
			(a, b) =>
				(a.level ?? '').localeCompare(b.level ?? '', 'en', { numeric: true }) || a.id.localeCompare(b.id),
		);
	if (options.json) {
		console.log(JSON.stringify(rows, null, '\t'));
		return;
	}
	console.log(
		'level                  scene                  category                dungeon                         operator          missions',
	);
	for (const row of rows) {
		// a level streaming another scene is the case worth seeing at a glance
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
		// tag votes over always-loaded (scene state 0) scenery: which level's cells hold each tag's pivots
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
				byCell.getOrInsertComputed(key, () => []).push(`${file.sceneState}/${file.area}`);
			}
		}
	}
	const cells = (level.config.levelGrids ?? []).toSorted((a, b) => a.z - b.z || a.x - b.x);
	console.log(`${level.id} (tag ${level.tag}): ${cells.length} cells`);
	console.log('   x    z   world x,z min        chunk files (scene state/area)');
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
	scene: string,
	xArg: string,
	zArg: string | undefined,
	options: { json: boolean; sceneState: number | undefined; area: number | undefined },
): Promise<void> => {
	const cell =
		xArg === 'global' ? 'global' : { x: parseInteger(xArg, 'cell x'), z: parseInteger(zArg ?? '', 'cell z') };
	const partition = await world.partition(scene);
	const files = await world.cellChunkFiles(scene, cell, options);
	if (files.length === 0) {
		throw new Error(`no InitChunkData for ${scene} ${cell === 'global' ? 'Global' : `${cell.x},${cell.z}`}`);
	}

	const perFile = await Promise.all(files.map((file) => world.readChunk(file, partition)));
	if (options.json) {
		const names = await assetNames(world);
		const rows = perFile.flat().map((entity) => entityJson(entity, partition, names));
		console.log(JSON.stringify(rows, null, '\t'));
		return;
	}
	const pathOf = await world.pathLookup();
	for (const [i, file] of files.entries()) {
		console.log(`# ${file.name} (${perFile[i].length} entities)`);
		for (const entity of perFile[i]) {
			console.log(entityLine(entity, pathOf));
		}
	}
};

const listMembers = async (world: WorldIndex, levelId: string, json: boolean): Promise<void> => {
	const { partition, level } = await findLevel(world, levelId);
	const counts = new Map<string, { all: number; renderer: number }>();
	const names = json ? await assetNames(world) : undefined;
	const rows: object[] = [];
	for await (const entity of world.entitiesOfLevel(level, partition)) {
		const where = entity.source.cell === null ? 'global' : entity.membership.placement;
		const count = counts.getOrInsertComputed(where, () => ({ all: 0, renderer: 0 }));
		count.all++;
		if (entity.renderer !== null) {
			count.renderer++;
		}
		if (names !== undefined) {
			rows.push(entityJson(entity, partition, names));
		}
	}
	if (json) {
		console.log(JSON.stringify(rows, null, '\t'));
		return;
	}
	console.log(`${level.id} (tag ${level.tag}) members by placement:`);
	let total = 0;
	let renderers = 0;
	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
	for (const [where, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
		console.log(`  ${where.padEnd(10)} ${String(count.all).padStart(8)}  (${count.renderer} with renderers)`);
		total += count.all;
		renderers += count.renderer;
	}
	console.log(`  ${'total'.padEnd(10)} ${String(total).padStart(8)}  (${renderers} with renderers)`);
};

const percent = (part: number, whole: number): string => `${((part / Math.max(1, whole)) * 100).toFixed(1)}%`;

const showEnvironment = async (context: Context, target: string): Promise<void> => {
	const { world } = context;
	let scene = await world.partition(target);
	let levels = scene?.levels ?? [];
	if (scene === undefined) {
		const found = await findLevel(world, target);
		scene = found.partition;
		levels = [found.level];
	}
	// the volumes placed prefabs carry join the chunk volumes, as in the package
	const survey = await surveyPlacements(context, scene.mapId);
	const [chunkVolumes, placed, pathOf, names, resolver] = await Promise.all([
		loadSceneVolumes(world, scene.mapId),
		surveyPlacedVolumes(context, survey),
		world.pathLookup(),
		world.names(),
		context.resolver(),
	]);
	const volumes = { ...chunkVolumes, environment: [...chunkVolumes.environment, ...placed] };
	const fromPrefabs = new Set(placed.map(({ volume }) => volume));
	const { sceneStates: states, game } = survey.scene;
	const enabled = defaultSceneStates(states, game);
	console.log(
		`scene states (default: ${
			mapDefined(states, ({ index, name }) => (enabled.has(index) ? name : undefined)).join(', ') || 'none'
		})`,
	);
	for (const { index, name, condition } of states) {
		console.log(
			`  ${enabled.has(index) ? 'on ' : 'off'} ${sceneStateControl(index).padEnd(14)} ${name}: ${
				condition === null ? 'no condition: only set by name' : ruleText(game.describe(condition))
			}`,
		);
	}
	const assetName = (hash: bigint | null): string =>
		hash === null
			? '(none)'
			: (pathOf(hash)
					?.split('/')
					.pop()
					?.replace(/\.asset$/, '') ?? hashText(hash));
	const loadPhase = scenePhaseLoader(resolver, pathOf, volumes.environment);
	/** a chunk volume's phase asset, or a prefab volume's phase object, by name */
	const phaseName = async (volume: EnvironmentVolume | null): Promise<string> => {
		if (volume === null || !fromPrefabs.has(volume)) {
			return assetName(volume?.envPhase ?? null);
		}
		const load = loadPhase(volume);
		return load === null
			? '(none)'
			: load.then(
					({ phase }) => phase.name,
					(error: unknown) => `(unreadable: ${errorText(error)})`,
				);
	};

	const choices = levels.map((level) => resolveLevelEnvironment(level, volumes, enabled));
	const phases = await Promise.all(choices.map((choice) => loadLevelPhases(choice, loadPhase)));
	const listed = choices.map((choice) => choice.shares.slice(0, 6));
	/** per level, its listed volumes' phase names, then its base's */
	const listedPhases = await Promise.all(
		choices.map((choice, i) =>
			Promise.all([...listed[i].map(({ volume }) => phaseName(volume)), phaseName(choice.volume)]),
		),
	);
	for (const [i, level] of levels.entries()) {
		const choice = choices[i];
		console.log(`${level.id} (tag ${level.tag}) ${names.get(level.id) ?? ''}`);
		console.log(
			`  ${choice.samples} samples on a ${CELL_SIZE / 4} m grid over the level's cells; its volumes by coverage:`,
		);
		console.log('    covers   shown  priority type  volume → phase');
		for (const [j, { volume, covered, wins }] of listed[i].entries()) {
			const name = fromPrefabs.has(volume) ? `${volume.name} (prefab)` : volume.name;
			console.log(
				`    ${percent(covered, choice.samples).padStart(6)}  ${percent(wins, choice.samples).padStart(6)}  ${String(volume.priority).padStart(8)} ${String(volume.volumeType).padStart(4)}  ${name} → ${listedPhases[i][j]}`,
			);
		}
		if (choice.shares.length > 6) {
			console.log(`    … ${choice.shares.length - 6} more`);
		}
		console.log(`  base: ${listedPhases[i].at(-1)}`);
		const loaded = phases[i];
		if (loaded !== null) {
			const sources = Object.entries(loaded.composed).map(([name, { source }]) =>
				source === 'level' ? name.replace(/Config$/, '') : `${name.replace(/Config$/, '')} (${source})`,
			);
			console.log(`  sections: ${sources.join(', ')}`);
			console.log(
				`  scene global under it: ${choice.global?.name ?? '(none)'} → ${assetName(choice.global?.envPhase ?? null)}`,
			);
		}
		const post = resolveLevelPost(level, volumes, enabled);
		console.log(`  post: ${post === null ? '(none)' : `${post.name} → ${assetName(post.profile)}`}`);
	}
};

const resolve = async (world: WorldIndex, query: string): Promise<void> => {
	const manifest = await world.manifest();
	let hashes: bigint[];
	const parsed = parseHash(query);
	if (parsed !== null) {
		hashes = [parsed];
		const path = await world.pathOf(parsed);
		console.log(`hash ${parsed} (${hashText(parsed)}) → ${path ?? '(not in StringPathHash)'}`);
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
			console.log(`  asset ${manifest.assetPath(asset)} (${asset.assetSize} bytes)`);
			console.log(`  bundle #${bundle.index} ${bundle.name}`);
			console.log(`    direct deps (${bundle.directDependencies.length}):`);
			for (const dep of bundle.directDependencies) {
				console.log(`      ${manifest.bundleName(dep)}`);
			}
			console.log(`    closure: ${bundle.dependencies.length} bundles`);
		}
	}
};

// #endregion

// #region formatting

/** lookups that name an entity's assets */
interface AssetNames {
	pathOf: (hash: bigint) => string | undefined;
	/** the bundle manifest's path for the asset */
	assetPathOf: (hash: bigint) => string | undefined;
	bundleOf: (hash: bigint) => string | null;
}

const assetNames = async (world: WorldIndex): Promise<AssetNames> => {
	const [pathOf, manifest] = await Promise.all([world.pathLookup(), world.manifest()]);
	const assetPathOf = (hash: bigint): string | undefined => {
		const asset = manifest.findAssets(hash)[0];
		return asset === undefined ? undefined : manifest.assetPath(asset);
	};
	const bundleOf = (hash: bigint): string | null => {
		const asset = manifest.findAssets(hash)[0];
		return asset === undefined ? null : manifest.bundleName(asset.bundleIndex);
	};
	return { pathOf, assetPathOf, bundleOf };
};

const entityLine = (entity: IndexedEntity, pathOf: (hash: bigint) => string | undefined): string => {
	const p = entity.pivot;
	const pos = p === null ? '-' : `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`;
	const { membership } = entity;
	const owner = membership.level?.id ?? membership.bucket;
	let draws = '';
	if (entity.renderer !== null) {
		const first = entity.renderer.draws[0];
		const mesh = first === undefined ? '' : (pathOf(first.meshHash) ?? '?').split('##').pop();
		draws = `  ${entity.renderer.draws.length} draws/${entity.renderer.lodCount} lods  ${mesh}`;
	}
	return `${String(entity.id).padStart(10)} t${String(entity.levelTag).padEnd(2)} ${owner.padEnd(12)} ${membership.placement.padEnd(9)} ${pos.padEnd(26)} ${entity.name}${draws}`;
};

const entityJson = (
	entity: IndexedEntity,
	partition: LevelPartition | undefined,
	names: AssetNames,
): object => {
	return {
		id: entity.id,
		levelTag: entity.levelTag,
		level: entity.membership.level?.id ?? (partition && levelOfTag(partition, entity.levelTag)?.id) ?? null,
		bucket: entity.membership.bucket,
		placement: entity.membership.placement,
		cellOwner: entity.membership.cellOwner?.id ?? null,
		name: entity.name,
		layer: layerName(entity.layer),
		source: entity.source.name,
		sceneState: entity.source.sceneState,
		area: entity.source.area,
		pivot: entity.pivot,
		...chunkEntityJson(entity, names),
	};
};

/** @returns a streaming layer's name in the game's `StreamingLayer`, or its number when it has none */
const layerName = (layer: number): string =>
	Object.entries(StreamingLayer).find(([, value]) => value === layer)?.[0] ?? String(layer);

/** the fields every decoded entity has, wherever it was read from */
const chunkEntityJson = (entity: ChunkEntity, { pathOf, bundleOf }: AssetNames): object => {
	return {
		matrix: entity.matrix === null ? null : [...entity.matrix],
		bounds: entity.bounds,
		decal: entity.decal,
		components: entity.components,
		renderer:
			entity.renderer === null
				? null
				: {
						lodCount: entity.renderer.lodCount,
						draws: entity.renderer.draws.map((draw) => ({
							lod: draw.lod,
							mesh: pathOf(draw.meshHash) ?? `0x${draw.meshHash.toString(16)}`,
							meshBundle: bundleOf(draw.meshHash),
							material: pathOf(draw.materialHash) ?? `0x${draw.materialHash.toString(16)}`,
							materialBundle: bundleOf(draw.materialHash),
							submesh: draw.submesh,
							flags: draw.flags,
							lodMaxSquared: draw.lodMaxSquared,
							lodMinSquared: draw.lodMinSquared,
						})),
					},
	};
};

// #endregion
