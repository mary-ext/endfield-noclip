import { readFile } from 'node:fs/promises';
import { basename } from 'node:path/posix';

import { LightType, readChunkLights, type ChunkLight } from '@endfield-noclip/formats/endfield/chunk-lights';
import {
	parseInitChunk,
	StreamingLayer,
	type ChunkEntity,
} from '@endfield-noclip/formats/endfield/init-chunk-data';
import { levelOfTag, type LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import type { Aabb } from '@endfield-noclip/formats/unity/values';
import { distanceInsideVolume } from '@endfield-noclip/package-format/environment-volumes';

import { definite, mapDefined } from '@mary-ext/array-fns';

import type { StructureModel } from '../../../game/dynamic/dynamic-structures.ts';
import { environmentVolumeShape, loadSceneVolumes } from '../../../game/environment.ts';
import {
	boxDistance,
	describeAlternatives,
	PLACEMENT_KINDS,
	type PlacementKind,
} from '../../../game/placements.ts';
import { sourceVisibility } from '../../../game/state/chunk-sources.ts';
import { sceneStateControl } from '../../../game/state/scene-conditions.ts';
import { readSceneWater } from '../../../game/water/water-source.ts';
import { readWaterVolumes } from '../../../game/water/water-volumes.ts';
import { pivotOf, type WorldIndex } from '../../../game/world/world-index.ts';
import { DEFAULT_OUT } from '../../../install/config.ts';
import { type Context, withContext } from '../../../install/context.ts';
import { DEBUG_DIR, STAND_INS_FILE, type StandInReport } from '../../../pipeline/debug.ts';
import { type ScenePlacementSurvey, surveyPlacements } from '../../../pipeline/survey.ts';
import { errorText, ignoreMissing } from '../../../util/errors.ts';
import { mapPool } from '../../../util/pool.ts';
import { hashText, jsonReplacer } from '../../helpers.ts';

import type { SceneSubArgs } from './parser.ts';
import {
	type AssetNames,
	chunkEntityJson,
	entityJson,
	formatHlodLink,
	layerName,
	levelsNear,
	nearCellFilter,
} from './shared.ts';

/**
 * runs `endfield-extract scene find`
 *
 * @param args parsed CLI arguments
 */
export const runSceneFind = async (args: SceneSubArgs<'find'>): Promise<void> => {
	await withContext(args.config, async (context) => {
		await findPlacements(context, args.scene, {
			pattern: args.name,
			near: args.spatial?.near,
			radius: args.spatial?.radius,
			kinds: args.kinds.length === 0 ? new Set(PLACEMENT_KINDS) : new Set(args.kinds),
			maxSize: args.maxSize,
			noHlod: args.noHlod,
			hlodLinks: args.hlodLinks,
			limit: args.limit,
			json: args.json,
			sceneState: args.sceneState,
			area: args.area,
		});
	});
};

interface FoundRow {
	kind: PlacementKind;
	name: string;
	position: [number, number, number] | null;
	distance: number | null;
	size: number | null;
	level: string | null;
	visibility: string;
	source: string;
	summary: string;
	standIns: string[];
	json: object;
}

interface FindOptions {
	pattern: RegExp | undefined;
	near: number[] | undefined;
	radius: number | undefined;
	kinds: Set<PlacementKind>;
	maxSize: number | undefined;
	noHlod: boolean;
	hlodLinks: boolean;
	limit: number;
	json: boolean;
	sceneState: number | undefined;
	area: number | undefined;
}

interface FoundCandidate {
	bounds: Aabb | null;
	position: readonly number[] | null;
	/** optional override for distance/size (used for non-AABB environment volumes) */
	customMeasure?: () => { distance: number | null; size: number | null } | undefined;
	labels: () => readonly string[];
	row: (distance: number | null) => Omit<FoundRow, 'distance' | 'size'>;
}

interface FindLookups {
	partition: LevelPartition | undefined;
	names: AssetNames;
	standIns: StandInIndex;
	levelOf: (tag: number) => string | null;
}

class FoundRows {
	readonly #options: Pick<FindOptions, 'pattern' | 'near' | 'radius' | 'maxSize' | 'limit'>;
	readonly #rows: FoundRow[] = [];

	constructor(options: FindOptions) {
		this.#options = options;
	}

	get length(): number {
		return this.#rows.length;
	}

	get full(): boolean {
		return this.#options.near === undefined && this.#rows.length >= this.#options.limit;
	}

	accepts(candidate: FoundCandidate): boolean {
		const { pattern } = this.#options;
		const place = this.#measure(candidate);
		return (
			place !== undefined &&
			(pattern === undefined || candidate.labels().some((label) => pattern.test(label)))
		);
	}

	add(candidate: FoundCandidate): void {
		const { pattern } = this.#options;
		const place = this.#measure(candidate);
		if (
			place === undefined ||
			(pattern !== undefined && !candidate.labels().some((label) => pattern.test(label)))
		) {
			return;
		}
		this.#rows.push({ ...candidate.row(place.distance), ...place });
	}

	shown(): FoundRow[] {
		const rows =
			this.#options.near === undefined
				? this.#rows
				: this.#rows.toSorted(
						(a, b) => (a.distance ?? 0) - (b.distance ?? 0) || (a.size ?? 0) - (b.size ?? 0),
					);
		return rows.slice(0, this.#options.limit);
	}

	#measure(candidate: FoundCandidate): Pick<FoundRow, 'distance' | 'size'> | undefined {
		if (candidate.customMeasure !== undefined) {
			return candidate.customMeasure();
		}
		const { near, radius, maxSize } = this.#options;
		const { bounds, position } = candidate;
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

const SURVEY_KINDS: readonly PlacementKind[] = ['dynamic', 'model', 'effect', 'facility', 'cabin'];
const HLOD_LAYERS = new Set<number>([StreamingLayer.HLOD0, StreamingLayer.HLOD1, StreamingLayer.HLOD2]);

const findPlacements = async (context: Context, scene: string, options: FindOptions): Promise<void> => {
	const { world } = context;
	if (!(await world.scenes()).includes(scene)) {
		throw new Error(`unknown streaming scene ${scene}`);
	}
	const { kinds, limit } = options;
	const needsSurvey = SURVEY_KINDS.some((k) => kinds.has(k));
	const [partition, pathOf, standIns, manifest] = await Promise.all([
		world.partition(scene),
		world.pathLookup(),
		loadStandIns(scene),
		needsSurvey ? world.manifest() : undefined,
	]);
	const nearLevels =
		options.near === undefined || partition === undefined
			? null
			: levelsNear(partition, options.near, options.radius);
	const scopedLevel = nearLevels !== null && nearLevels.length === 1 ? nearLevels[0].id : null;
	const surveyOptions = { includeEcs: kinds.has('dynamic') };
	const surveyPromise =
		needsSurvey && (options.near !== undefined || !kinds.has('static'))
			? surveyPlacements(context, scene, scopedLevel, surveyOptions).catch(errorText)
			: null;
	let loadedManifest = manifest;
	const names: AssetNames = {
		pathOf,
		assetPathOf: (hash) => {
			const asset = loadedManifest?.findAssets(hash)[0];
			return asset === undefined ? undefined : loadedManifest?.assetPath(asset);
		},
		bundleOf: (hash) => {
			const asset = loadedManifest?.findAssets(hash)[0];
			return asset === undefined ? null : (loadedManifest?.bundleName(asset.bundleIndex) ?? null);
		},
	};
	const lookups: FindLookups = {
		partition,
		names,
		standIns,
		levelOf: (tag) => (partition && levelOfTag(partition, tag)?.id) ?? (tag === 0 ? 'shared' : `tag ${tag}`),
	};
	const rows = new FoundRows(options);
	const scanAll = options.near !== undefined;
	const lightPromise = scanAll && kinds.has('light') ? lightCandidates(world, scene, options, lookups) : null;
	const waterPromise =
		scanAll && kinds.has('water') ? waterCandidates(context, scene, scopedLevel, options, lookups) : null;
	const envPromise = scanAll && kinds.has('env') ? envCandidates(context, scene, options, lookups) : null;

	if (kinds.has('static')) {
		for await (const candidate of staticCandidates(world, scene, options, lookups)) {
			if (loadedManifest === undefined && rows.accepts(candidate)) {
				loadedManifest = await world.manifest();
			}
			rows.add(candidate);
			if (rows.full) {
				break;
			}
		}
	}

	let survey = null;
	if (!rows.full && needsSurvey) {
		survey = await (surveyPromise ??
			surveyPlacements(context, scene, scopedLevel, surveyOptions).catch(errorText));
	}
	if (typeof survey === 'string') {
		console.error(`${SURVEY_KINDS.filter((k) => kinds.has(k)).join(', ')}: not searched: ${survey}`);
	} else if (survey !== null) {
		for (const candidate of surveyCandidates(survey, kinds, lookups)) {
			rows.add(candidate);
			if (rows.full) {
				break;
			}
		}
	}

	if (!rows.full && kinds.has('light')) {
		for (const candidate of await (lightPromise ?? lightCandidates(world, scene, options, lookups))) {
			rows.add(candidate);
			if (rows.full) {
				break;
			}
		}
	}

	if (!rows.full && kinds.has('water')) {
		for (const candidate of await (waterPromise ??
			waterCandidates(context, scene, scopedLevel, options, lookups))) {
			rows.add(candidate);
			if (rows.full) {
				break;
			}
		}
	}

	if (!rows.full && kinds.has('env')) {
		for (const candidate of await (envPromise ?? envCandidates(context, scene, options, lookups))) {
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
				jsonReplacer,
				'\t',
			),
		);
	} else {
		for (const row of shown) {
			console.log(foundLine(row));
		}
	}
	const counts = mapDefined(PLACEMENT_KINDS, (kind) => {
		const n = shown.filter((row) => row.kind === kind).length;
		return n === 0 ? undefined : `${n} ${kind}`;
	});
	console.error(
		`${shown.length} matches${counts.length === 0 ? '' : ` (${counts.join(', ')})`}${rows.length >= limit ? '; limit reached, raise --limit for more' : ''}${lookups.standIns.found ? '' : `; no out/${scene}/debug/stand-ins.json, so stand-ins aren't marked`}`,
	);
};

const drawLabels = (entity: ChunkEntity, { pathOf }: AssetNames): string[] =>
	entity.renderer?.draws.flatMap((draw) => [
		pathOf(draw.meshHash) ?? hashText(draw.meshHash),
		pathOf(draw.materialHash) ?? hashText(draw.materialHash),
	]) ?? [];

async function* staticCandidates(
	world: WorldIndex,
	scene: string,
	options: Pick<FindOptions, 'near' | 'radius' | 'sceneState' | 'area' | 'noHlod' | 'hlodLinks'>,
	lookups: FindLookups,
): AsyncGenerator<FoundCandidate> {
	const { names, standIns, partition } = lookups;
	const cellFilter = nearCellFilter(options.near, options.radius);
	for await (const { entity, decalMaterial, waterDecalMesh, hlodLink } of world.sceneEntitiesWithDecals(
		scene,
		(file) =>
			(options.sceneState === undefined || file.sceneState === options.sceneState) &&
			(options.area === undefined || file.area === options.area) &&
			(cellFilter === undefined || cellFilter(file)),
		{ hlodLinks: options.hlodLinks },
	)) {
		if (options.noHlod && HLOD_LAYERS.has(entity.layer)) {
			continue;
		}
		const position = entity.pivot === null ? null : [entity.pivot.x, entity.pivot.y, entity.pivot.z];
		const decal = decalMaterial === null ? null : (names.pathOf(decalMaterial) ?? hashText(decalMaterial));
		const decalBundle = decalMaterial === null ? null : names.bundleOf(decalMaterial);
		const waterMesh =
			waterDecalMesh === null ? null : (names.pathOf(waterDecalMesh) ?? hashText(waterDecalMesh));
		const hlodNote = options.hlodLinks ? `  ${formatHlodLink(hlodLink)}` : '';
		yield {
			bounds: entity.bounds,
			position,
			labels: () => [
				entity.name,
				...drawLabels(entity, names),
				...(decal === null ? [] : [decal]),
				...(waterMesh === null ? [] : [waterMesh]),
			],
			row: (distance) => {
				const visibility = describeAlternatives(sourceVisibility([entity.source])?.alternatives ?? [[]]);
				const reasons = standIns.atEntity(entity.name, position);
				const decalNote = decal === null ? '' : `  ${decal}${decalBundle === null ? '' : `  ${decalBundle}`}`;
				const waterMeshNote = waterMesh === null ? '' : `  mesh=${waterMesh.split('##').pop()}`;
				return {
					kind: 'static',
					name: entity.name,
					position: position === null ? null : [position[0], position[1], position[2]],
					level: entity.membership.level?.id ?? entity.membership.bucket,
					visibility,
					source: basename(entity.source.name),
					summary: `${drawSummary(entity, names)}${decalNote}${waterMeshNote}  layer ${layerName(entity.layer)}${hlodNote}`,
					standIns: reasons,
					json: {
						kind: 'static',
						...entityJson(entity, partition, names),
						...(decal === null ? {} : { decalMaterial: decal, decalMaterialBundle: decalBundle }),
						...(waterMesh === null ? {} : { waterDecalMesh: waterMesh }),
						...(options.hlodLinks ? { hlodLink } : {}),
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
				labels: () => [entity.name, ...drawLabels(entity, names)],
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
		...structureModels.map((model) => prefab(model.source.startsWith('effect:') ? 'effect' : 'model', model)),
		...interactives.facilityModels.map((model) => prefab('facility', model)),
		...interactives.cabinModels.map((model) => prefab('cabin', model)),
	];
	for (const { kind, model } of prefabs) {
		if (!kinds.has(kind)) {
			continue;
		}
		const { pathHash, position, rotation, scale } = model.model;
		let resolvedPath: string | undefined;
		const prefabPath = (): string => {
			resolvedPath ??= names.assetPathOf(pathHash) ?? names.pathOf(pathHash) ?? hashText(pathHash);
			return resolvedPath;
		};
		yield {
			bounds: null,
			position,
			labels: () => [prefabPath(), model.source],
			row: (distance) => {
				const path = prefabPath();
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
						...(model.grid !== undefined && { grid: model.grid }),
						...(model.lodGrids !== undefined && { lodGrids: model.lodGrids }),
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
				labels: () => [standIn.template, standIn.source],
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

const LIGHT_TYPE_NAME: Record<number, string> = {
	[LightType.Spot]: 'spot',
	[LightType.Directional]: 'dir',
	[LightType.Point]: 'point',
};

const lightCandidates = async (
	world: WorldIndex,
	scene: string,
	options: Pick<FindOptions, 'near' | 'radius' | 'sceneState' | 'area'>,
	lookups: FindLookups,
): Promise<FoundCandidate[]> => {
	const cellFilter = nearCellFilter(options.near, options.radius);
	const files = (await world.chunkFiles()).filter(
		(file) =>
			file.scene === scene &&
			(options.sceneState === undefined || file.sceneState === options.sceneState) &&
			(options.area === undefined || file.area === options.area) &&
			(cellFilter === undefined || cellFilter(file)),
	);
	const perFile = await mapPool(files, 16, async (file) => {
		return { file, lights: readChunkLights(parseInitChunk(await world.readInitPayload(file))) };
	});
	const seen = new Map<number, { light: ChunkLight; file: (typeof files)[number] }>();
	for (const { file, lights } of perFile) {
		for (const light of lights) {
			if (!seen.has(light.id)) {
				seen.set(light.id, { light, file });
			}
		}
	}
	const out: FoundCandidate[] = [];
	for (const { light, file } of seen.values()) {
		const typeLabel = LIGHT_TYPE_NAME[light.type] ?? `type:${light.type}`;
		out.push({
			bounds: null,
			position: light.position,
			labels: () => [light.name, typeLabel, String(light.id)],
			row: (distance) => {
				const visibility = describeAlternatives(sourceVisibility([file])?.alternatives ?? [[]]);
				const color = light.color.map((c) => +c.toFixed(1)).join(',');
				const flags = definite([
					light.shadows !== null ? 'shadows' : '',
					light.shadowOnly ? 'shadow-only' : '',
					light.characterOnly ? 'char-only' : '',
				]).join(' ');
				return {
					kind: 'light',
					name: light.name,
					position: [...light.position],
					level: lookups.levelOf(light.levelTag),
					visibility,
					source: basename(file.name),
					summary: `${typeLabel}  range=${light.range.toFixed(1)}  color=(${color})  int=${light.intensity.toFixed(1)}${flags ? `  [${flags}]` : ''}`,
					standIns: [],
					json: {
						kind: 'light',
						...light,
						level: lookups.levelOf(light.levelTag),
						visibility,
						source: basename(file.name),
						distance,
					},
				};
			},
		});
	}
	return out;
};

const waterCandidates = async (
	context: Context,
	scene: string,
	level: string | null,
	options: Pick<FindOptions, 'near' | 'radius'>,
	lookups: FindLookups,
): Promise<FoundCandidate[]> => {
	const { world } = context;
	const { names, partition } = lookups;
	const [{ surfaces }, { volumes }] = await Promise.all([
		readSceneWater(world, scene, nearCellFilter(options.near, options.radius), { includeGlobals: false }),
		readWaterVolumes(context, scene, level, partition).catch(() => ({ volumes: [], unsupported: [] })),
	]);
	const out: FoundCandidate[] = [];
	for (const surface of surfaces) {
		const m = surface.matrix;
		const pos: [number, number, number] = [m[12], m[13], m[14]];
		const configPath = names.pathOf(surface.configHash) ?? hashText(surface.configHash);
		const meshPath = names.pathOf(surface.meshHash) ?? hashText(surface.meshHash);
		out.push({
			bounds: surface.bounds,
			position: pos,
			labels: () => [surface.name, configPath, meshPath],
			row: (distance) => ({
				kind: 'water',
				name: surface.name,
				position: pos,
				level: lookups.levelOf(surface.levelTag),
				visibility: 'always',
				source: basename(surface.source.name),
				summary: `surface mask=${surface.renderTypeMask}  ${basename(meshPath)} / ${basename(configPath)}`,
				standIns: [],
				json: {
					kind: 'water',
					waterKind: 'surface',
					id: surface.id,
					name: surface.name,
					level: lookups.levelOf(surface.levelTag),
					position: pos,
					bounds: surface.bounds,
					renderTypeMask: surface.renderTypeMask,
					mesh: meshPath,
					config: configPath,
					distance,
				},
			}),
		});
	}
	for (const volume of volumes) {
		const xs = volume.points.map(([x]) => x);
		const zs = volume.points.map(([, z]) => z);
		const minX = Math.min(...xs);
		const maxX = Math.max(...xs);
		const minZ = Math.min(...zs);
		const maxZ = Math.max(...zs);
		const minY = volume.pivot[1];
		const maxY = volume.pivot[1] + Math.max(volume.heightMax, 0.1);
		const bounds: Aabb = {
			center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
			extents: [(maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2],
		};
		const configPath =
			volume.configHash === null ? null : (names.pathOf(volume.configHash) ?? hashText(volume.configHash));
		out.push({
			bounds,
			position: volume.pivot,
			labels: () => [volume.id, volume.itemType, ...(configPath === null ? [] : [configPath])],
			row: (distance) => ({
				kind: 'water',
				name: `${volume.itemType} (${volume.id})`,
				position: [...volume.pivot],
				level: volume.levelId,
				visibility: 'always',
				source: `volume ${volume.id}`,
				summary: `volume depth=${volume.heightMax.toFixed(1)} fill=${volume.fraction.toFixed(2)} y=${(volume.pivot[1] + volume.heightMax * volume.fraction).toFixed(1)}${configPath ? `  ${basename(configPath)}` : ''}`,
				standIns: [],
				json: {
					kind: 'water',
					waterKind: 'volume',
					...volume,
					config: configPath,
					distance,
				},
			}),
		});
	}
	return out;
};

const envCandidates = async (
	context: Context,
	scene: string,
	options: Pick<FindOptions, 'near' | 'radius' | 'maxSize'>,
	lookups: FindLookups,
): Promise<FoundCandidate[]> => {
	const { world } = context;
	// with `--near`, envCandidates tests containment at `near` itself, so only covering cells + Global matter
	const chunkVolumes = await loadSceneVolumes(world, scene, nearCellFilter(options.near, undefined));
	const out: FoundCandidate[] = [];
	for (const entry of chunkVolumes.environment) {
		const { volume } = entry;
		const shape = environmentVolumeShape(volume);
		const phasePath =
			volume.envPhase === null
				? '(none)'
				: (lookups.names.pathOf(volume.envPhase) ?? hashText(volume.envPhase));
		const isGlobal = typeof shape !== 'string' && shape.kind === 'global';
		out.push({
			bounds: null,
			position: null,
			customMeasure: () => {
				if (options.maxSize !== undefined && isGlobal) {
					return undefined;
				}
				if (options.near === undefined || options.radius === undefined) {
					return { distance: null, size: isGlobal ? Infinity : null };
				}
				if (typeof shape === 'string') {
					return undefined;
				}
				const inside = distanceInsideVolume(shape, [options.near[0], options.near[1], options.near[2]]);
				if (inside <= 0) {
					return undefined;
				}
				return { distance: 0, size: isGlobal ? Infinity : null };
			},
			labels: () => [volume.name, phasePath],
			row: (distance) => ({
				kind: 'env',
				name: volume.name,
				position: null,
				level: lookups.levelOf(entry.tag),
				visibility:
					entry.sceneStates.length === 0
						? 'always'
						: entry.sceneStates.map((s) => `${sceneStateControl(s)}=1`).join(' | '),
				source: `priority ${volume.priority}`,
				summary: `type=${volume.volumeType}  phase=${basename(phasePath).replace(/\.asset$/, '')}`,
				standIns: [],
				json: {
					kind: 'env',
					name: volume.name,
					level: lookups.levelOf(entry.tag),
					priority: volume.priority,
					volumeType: volume.volumeType,
					blendMode: volume.blendMode,
					phase: phasePath,
					sceneStates: entry.sceneStates,
					distance,
				},
			}),
		});
	}
	return out;
};

interface StandInIndex {
	found: boolean;
	ofPrefab: (path: string) => string[];
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
		atEntity: (name, position) => {
			if (position === null) {
				return [];
			}
			return mapDefined(byName.get(name) ?? [], (report) =>
				Math.hypot(...report.position.map((v, i) => v - position[i])) <= 2 ? report.reason : undefined,
			);
		},
	};
};

const foundLine = (row: FoundRow): string => {
	const distance = row.distance === null ? '' : `${row.distance.toFixed(1).padStart(6)} m  `;
	const size = row.size === null || !Number.isFinite(row.size) ? '' : `  ${row.size.toFixed(0)} m across`;
	const position = row.position === null ? '-' : row.position.map((v) => v.toFixed(1)).join(',');
	const standIn = row.standIns.length === 0 ? '' : `  STAND-IN: ${row.standIns.join('; ')}`;
	return `${distance}${row.kind.padEnd(8)} ${(row.level ?? '-').padEnd(12)} ${position.padEnd(24)} ${row.name}${size}  [${row.visibility}]  ${row.summary}  @ ${row.source}${standIn}`;
};

const drawSummary = (entity: ChunkEntity, { pathOf, bundleOf }: AssetNames): string => {
	const { renderer } = entity;
	if (renderer === null) {
		let label = 'no renderer';
		if (entity.waterDecal !== null) {
			label = 'water decal';
		} else if (entity.decal !== null) {
			label = 'rect decal';
		}
		return `${label} (components ${entity.components.join(' ')})`;
	}
	const first = renderer.draws[0];
	if (first === undefined) {
		return 'no draws';
	}
	const mesh = (pathOf(first.meshHash) ?? hashText(first.meshHash)).split('##').pop();
	const material = pathOf(first.materialHash) ?? hashText(first.materialHash);
	return `${renderer.draws.length} draws/${renderer.lodCount} lods  ${mesh}  ${material}  ${bundleOf(first.materialHash) ?? '-'}`;
};

// #endregion
