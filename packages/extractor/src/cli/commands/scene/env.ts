import type { EnvironmentVolume } from '@endfield-noclip/formats/endfield/environment-volume';
import { cellKey } from '@endfield-noclip/formats/endfield/level-partition';
import { CELL_SIZE } from '@endfield-noclip/formats/endfield/map-config';
import { ruleText } from '@endfield-noclip/package-format/conditions';
import { compareVolumes, distanceInsideVolume } from '@endfield-noclip/package-format/environment-volumes';

import { mapDefined } from '@mary-ext/array-fns';

import {
	environmentBlend,
	environmentVolumeShape,
	loadLevelPhases,
	loadSceneVolumes,
	resolveLevelEnvironment,
	resolveLevelPost,
	scenePhaseLoader,
	type SceneEnvironmentVolume,
} from '../../../game/environment.ts';
import { defaultSceneStates, sceneStateControl } from '../../../game/state/scene-conditions.ts';
import type { ChunkFile } from '../../../game/world/world-index.ts';
import { type Context, withContext } from '../../../install/context.ts';
import { surveyPlacedVolumes, surveyPlacements } from '../../../pipeline/survey.ts';
import { errorText } from '../../../util/errors.ts';
import { hashText } from '../../helpers.ts';

import type { SceneSubArgs } from './parser.ts';
import { findLevel, levelsNear, nearCellFilter } from './shared.ts';

const percent = (part: number, whole: number): string => `${((part / Math.max(1, whole)) * 100).toFixed(1)}%`;

/**
 * runs `endfield-extract scene env`
 *
 * @param args parsed CLI arguments
 */
export const runSceneEnv = async (args: SceneSubArgs<'env'>): Promise<void> => {
	await withContext(args.config, async (context) => {
		await showEnvironment(context, args.target, args.at, args.json);
	});
};

const showEnvironment = async (
	context: Context,
	target: string,
	at: number[] | undefined,
	json: boolean,
): Promise<void> => {
	const { world } = context;
	let scene = await world.partition(target);
	let levels = scene?.levels ?? [];
	if (scene === undefined) {
		const found = await findLevel(world, target);
		scene = found.partition;
		levels = [found.level];
	}
	const singleLevel = levels.length === 1 && scene.levels.length > 1 ? levels[0] : null;
	const nearLevels = at !== undefined && singleLevel === null ? levelsNear(scene, at, undefined) : [];
	let levelTags: Set<number> | null = null;
	let surveyLevel: string | null = singleLevel?.id ?? null;
	if (singleLevel !== null) {
		levelTags = new Set([0, singleLevel.tag]);
	} else if (nearLevels.length > 0) {
		levelTags = new Set([0, ...nearLevels.map((level) => level.tag)]);
		if (nearLevels.length === 1) {
			surveyLevel = nearLevels[0].id;
		}
	}
	let chunkFilter: ((file: ChunkFile) => boolean) | undefined;
	if (at !== undefined) {
		chunkFilter = nearCellFilter(at, undefined);
	} else if (singleLevel !== null) {
		chunkFilter = (file) => file.cell === null || singleLevel.cells.has(cellKey(file.cell.x, file.cell.z));
	}
	const [survey, chunkVolumes, pathOf, names, resolver] = await Promise.all([
		surveyPlacements(context, scene.mapId, surveyLevel, { includeEcs: false }),
		loadSceneVolumes(world, scene.mapId, chunkFilter),
		world.pathLookup(),
		world.names(),
		context.resolver(),
	]);
	const placed = await surveyPlacedVolumes(
		context,
		levelTags === null
			? survey
			: { ...survey, placements: survey.placements.filter(({ levelTag }) => levelTags.has(levelTag)) },
	);
	const volumes = { ...chunkVolumes, environment: [...chunkVolumes.environment, ...placed] };
	const fromPrefabs = new Set(placed.map(({ volume }) => volume));
	const { sceneStates: states, game } = survey.scene;
	const enabled = defaultSceneStates(states, game);
	const assetName = (hash: bigint | null): string =>
		hash === null
			? '(none)'
			: (pathOf(hash)
					?.split('/')
					.pop()
					?.replace(/\.asset$/, '') ?? hashText(hash));
	const loadPhase = scenePhaseLoader(resolver, pathOf, volumes.environment);
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

	if (at !== undefined) {
		await showEnvironmentAt(
			volumes.environment,
			fromPrefabs,
			enabled,
			[at[0], at[1], at[2]],
			phaseName,
			json,
		);
		return;
	}

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

	const choices = levels.map((level) => resolveLevelEnvironment(level, volumes, enabled));
	const phases = await Promise.all(choices.map((choice) => loadLevelPhases(choice, loadPhase)));
	const listed = choices.map((choice) => choice.shares.slice(0, 6));
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

const showEnvironmentAt = async (
	entries: readonly SceneEnvironmentVolume[],
	fromPrefabs: ReadonlySet<EnvironmentVolume>,
	enabledStates: ReadonlySet<number>,
	point: [number, number, number],
	phaseName: (volume: EnvironmentVolume | null) => Promise<string>,
	json: boolean,
): Promise<void> => {
	const hits: {
		entry: SceneEnvironmentVolume;
		shape: Exclude<ReturnType<typeof environmentVolumeShape>, string>;
		inside: number;
		blend: ReturnType<typeof environmentBlend>;
		activeByDefault: boolean;
	}[] = [];
	for (const entry of entries) {
		const shape = environmentVolumeShape(entry.volume);
		if (typeof shape === 'string') {
			continue;
		}
		const inside = distanceInsideVolume(shape, point);
		if (inside <= 0) {
			continue;
		}
		const activeByDefault =
			entry.loadedByDefault &&
			(entry.sceneStates.length === 0 || entry.sceneStates.some((s) => enabledStates.has(s)));
		hits.push({
			entry,
			shape,
			inside,
			blend: environmentBlend(entry.volume),
			activeByDefault,
		});
	}
	hits.sort((a, b) =>
		compareVolumes(
			{ priority: a.entry.volume.priority, shape: a.shape },
			{ priority: b.entry.volume.priority, shape: b.shape },
		),
	);
	const rows = await Promise.all(
		hits.map(async (hit) => {
			const { volume } = hit.entry;
			let weight = 1;
			if (typeof hit.blend !== 'string' && hit.blend.kind === 'depth' && hit.blend.distance > 0) {
				weight = Math.min(1, hit.inside / hit.blend.distance);
			}
			return {
				name: fromPrefabs.has(volume) ? `${volume.name} (prefab)` : volume.name,
				priority: volume.priority,
				shape: hit.shape.kind,
				inside: Number.isFinite(hit.inside) ? +hit.inside.toFixed(2) : null,
				weight: +weight.toFixed(3),
				blend: typeof hit.blend === 'string' ? hit.blend : hit.blend.kind,
				activeByDefault: hit.activeByDefault,
				phase: await phaseName(volume),
			};
		}),
	);
	if (json) {
		console.log(JSON.stringify({ point, volumes: rows }, null, '\t'));
		return;
	}
	console.log(`environment volumes at (${point.join(', ')}): ${rows.length} covering (bottom → top)`);
	console.log('  on   priority  shape   inside     weight  blend      volume → phase');
	for (const row of rows) {
		const inside = row.inside === null ? 'global' : `${row.inside.toFixed(1)} m`;
		console.log(
			`  ${row.activeByDefault ? 'yes' : 'no '}  ${String(row.priority).padStart(8)}  ${row.shape.padEnd(6)}  ${inside.padStart(8)}  ${row.weight.toFixed(2).padStart(6)}  ${row.blend.padEnd(9)}  ${row.name} → ${row.phase}`,
		);
	}
};
