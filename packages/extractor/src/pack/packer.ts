import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { encodeGeometryTable } from '@endfield-noclip/package-format/geometry-table';
import { encodeChains } from '@endfield-noclip/package-format/instances';
import { encodeIrradianceTable } from '@endfield-noclip/package-format/irradiance';
import {
	CORE_ARCHIVE,
	CORE_PATHS,
	PACKAGE_FORMAT,
	PACKAGE_VERSION,
} from '@endfield-noclip/package-format/manifest';
import type { MaterialTable } from '@endfield-noclip/package-format/materials';
import { encodeTextureTable } from '@endfield-noclip/package-format/texture-table';
import { tileAt } from '@endfield-noclip/package-format/tiles';
import { ContentKind, encodeTree } from '@endfield-noclip/package-format/tree';

import type { Context } from '../context.ts';
import { defaultSceneStates } from '../game/state/scene-conditions.ts';
import { loadWaterDrains } from '../game/water/water-drains.ts';

import { ARCHIVE_CAP, ArchiveLayout, TERRAIN_LAYER_STEM } from './archives.ts';
import { collectEntities } from './content/entities.ts';
import { PackContent } from './content/pack-content.ts';
import { SHARED_GROUP } from './control-registry.ts';
import { type AssetConversion, convertAssets, pendingAssets, type PlacedTexture } from './convert/assets.ts';
import { ConvertPool } from './convert/convert-pool.ts';
import { assetRows, DebugLog, type DebugFile, STAND_INS_FILE, writeDebug } from './debug.ts';
import { CHAIN_KEYS_FILE, readChainKeys } from './instances/chains.ts';
import { packInstances } from './instances/instance-blocks.ts';
import { TileTreeBuilder } from './instances/tile-tree.ts';
import { checkOutDir, siblingDir, swapIn } from './output-dir.ts';
import { PhaseTimer } from './phase-timer.ts';
import { blobTotals, type PackReport, ready, treeTotals } from './report.ts';
import { indexScene, type SceneSelection } from './scene-index.ts';
import { addSceneStateControls, buildSceneStates, progressionControls } from './states.ts';
import { BlobDir } from './store/blob-file.ts';
import { BlobStore } from './store/blob-store.ts';
import { PackCache } from './store/pack-cache.ts';
import {
	finishEnvironments,
	gateEnvironments,
	indexEnvironmentControls,
	planEnvironments,
} from './tables/environments.ts';
import { packIrradiance, packIrradianceRegions, sceneStateBakeCondition } from './tables/irradiance.ts';
import { packTerrain } from './tables/terrain.ts';
import { finishWater, gateWater, indexWaterControls, planWater } from './tables/water.ts';
import { binaryTable, type CoreMember, jsonTable, writePackage } from './write.ts';

/** what to pack and how */
export interface PackOptions extends SceneSelection {
	/** package root; must be empty, absent, or hold a previous package (which is replaced) */
	outDir: string;
	/** zstd level of geometry, instance, terrain height and splat blobs */
	zstdLevel: number;
	/** zstd level of textures, terrain surface pages and layer textures */
	textureZstdLevel: number;
	/** convert geometry, materials and textures; without, their table entries stay `pending` */
	convertAssets: boolean;
	/** worker threads converting meshes and textures */
	jobs: number;
	/** the pack cache directory (see `pack-cache.ts`), or `null` to convert everything afresh */
	cacheDir: string | null;
	/** progress output */
	log: (line: string) => void;
}

/** materials decoded concurrently */
const MATERIAL_CONCURRENCY = 8;

/**
 * placeholder error model until the game's HLOD switch distances are known: a node's geometric error is this
 * fraction of its edge length (64 m leaf → 4 m). tunable in the viewer through its SSE threshold
 */
const ERROR_PER_EDGE = 1 / 16;

/**
 * packs one streaming scene into a viewer package. the phases run in a fixed order
 * (docs/extraction.md#phases), each one's results committed in id order, so the same install and options give
 * byte-identical archives
 *
 * @param context VFS, world index and asset resolver
 * @param options what to pack
 * @returns sizes, counts and timings
 * @throws {Error} if the output directory holds something other than a package, or the scene is unknown
 */
export const packScene = async (context: Context, options: PackOptions): Promise<PackReport> => {
	const timer = new PhaseTimer(options.log);
	// a package being replaced lends its unchanged archives to the new one
	const previous = (await checkOutDir(options.outDir)) ? options.outDir : null;
	// the package is written here and swapped in when complete, so a viewer never reads a partial one
	const stage = siblingDir(options.outDir, 'staging');
	await rm(stage, { recursive: true, force: true });
	await mkdir(stage, { recursive: true });
	const cache = options.cacheDir === null ? null : await PackCache.open(options.cacheDir);
	// scratch space for the debug log, and for blobs when there's no cache to hold them
	const spool = join(stage, '.spool');
	const store = new BlobStore(cache?.blobs ?? new BlobDir(spool), {
		zstdLevel: options.zstdLevel,
		archiveCap: ARCHIVE_CAP,
		core: CORE_ARCHIVE,
		memo: cache,
	});
	try {
		// #region setup
		const scene = await indexScene(context, options);
		const content = await PackContent.create(context.world, scene, options.log);
		const { controls } = content;
		const layout = new ArchiveLayout(scene.grid);
		const builder = new TileTreeBuilder(scene.grid);
		const progressions = await progressionControls(context.world, scene.id);
		timer.end('setup');
		// #endregion

		const entities = await collectEntities(context, content, progressions);
		// only the entities phase decodes MemoryPack data
		context.releaseMemoryPack();
		timer.end('entities');

		// #region terrain
		let terrain: Awaited<ReturnType<typeof packTerrain>> | null = null;
		if (scene.terrain !== null) {
			terrain = await packTerrain(context, store, cache, {
				scene: scene.id,
				terrainScene: scene.terrain.scene,
				surface: scene.terrain.surface,
				terrain: scene.terrain.info,
				grid: scene.grid,
				includesTile: (key) => scene.subset.includesTile(key),
				stemOf: (key) => layout.stemOf(key),
				layerStem: TERRAIN_LAYER_STEM,
				zstdLevel: options.zstdLevel,
				textureZstdLevel: options.textureZstdLevel,
				log: options.log,
			});
			const whole = { tier: 0, group: SHARED_GROUP, first: 0, count: 1, reach: null };
			for (const tile of terrain.tiles) {
				const { key } = tile;
				builder.addRef(key, { ...whole, kind: ContentKind.TerrainHeights, blob: tile.heights });
				builder.extend(key, tile.bounds);
				if (tile.surface !== null) {
					builder.addRef(key, { ...whole, kind: ContentKind.TerrainSurface, blob: tile.surface });
				}
				if (tile.splat !== null) {
					builder.addRef(key, { ...whole, kind: ContentKind.TerrainSplat, blob: tile.splat });
				}
			}
		}
		timer.end('terrain');
		// #endregion

		// #region environments and water
		// independent; only water interns geometries, so ids stay deterministic
		const [environments, water] = await Promise.all([
			planEnvironments(
				context,
				scene.id,
				scene.partition?.levels ?? [],
				defaultSceneStates(scene.sceneStates, scene.game),
				entities.placedVolumes,
			),
			planWater(context, scene.id, {
				includes: (tag, x, z) => scene.subset.includesEntity(tag, x, z),
				subset: scene.subset.info !== null,
				geometry: (hash) => {
					const id = content.geometries.intern(hash, scene.pathOf);
					// water is resident, so its meshes go to the common archive
					content.uses.noteGeometry(id, null);
					return id;
				},
				syntheticGeometry: (mesh) => {
					const id = content.geometries.internSynthetic(mesh);
					content.uses.noteGeometry(id, null);
					return id;
				},
				volumes: entities.waterVolumes,
				scriptLevels: entities.scriptWater.levels,
				placeSector: (rect) =>
					tileAt(scene.grid, scene.grid.shardLevel, (rect.minX + rect.maxX) / 2, (rect.minZ + rect.maxZ) / 2),
			}),
		]);
		timer.end('environments and water');
		// gating order fixes condition and group ids: environments, water, lights, then the scene states they need
		gateEnvironments(environments, controls);
		gateWater(
			water,
			controls,
			entities.waterDrivers,
			await loadWaterDrains(context.world, entities.waterVolumes.volumes),
		);
		const lights = content.lights.finish(
			(levelTag, sources) => controls.groupOfSources(levelTag, sources),
			(levelTag, visibility) => controls.groupOf(levelTag, visibility),
		);
		content.count('lights', lights.lights.length);
		for (const [reason, count] of Object.entries(content.lights.skipped)) {
			content.count(`lightsSkipped ${reason}`, count);
		}
		addSceneStateControls(controls, scene);
		// #endregion

		// #region irradiance
		const stateIndices = new Map(scene.sceneStates.map(({ index, name }) => [name, index]));
		const irradiance = await packIrradiance(context.vfs, store, cache, {
			scene: scene.id,
			includes: (x, z) =>
				scene.subset.info === null ||
				scene.subset.includesTile(tileAt(scene.grid, scene.grid.cellLevel, x, z)),
			groupOf: (names) => {
				if (names.length === 0) {
					return SHARED_GROUP;
				}
				const condition = sceneStateBakeCondition(names, (name) => stateIndices.get(name));
				return condition === null ? null : controls.group(0, controls.condition(condition));
			},
		});
		const irradianceRegions = await packIrradianceRegions(context.vfs, store, {
			scene: scene.id,
			rooms: entities.cabinRooms,
		});
		timer.end('irradiance');
		// #endregion

		// #region instances
		// spooled, so a failed pack leaves nothing outside the package's own entries
		const debugLog = await DebugLog.create(join(spool, 'instances.jsonl'));
		const chainOrder = content.chains.stableOrder(
			{
				geometry: (id) => content.geometries.keyOf(id),
				material: (id) => content.materials.keyOf(id),
				particles: (id) => content.particles.keyOf(id),
			},
			previous === null ? [] : await readChainKeys(previous),
		);
		const instances = await packInstances({ store, layout, builder, debugLog }, content.collector, {
			grid: scene.grid,
			chainIds: chainOrder.ids,
			volumes: new Map(water.table.volumes.map(({ entityId }, i) => [entityId, i])),
		});
		await debugLog.close();
		timer.end('instances');
		// #endregion

		// #region assets
		/** textures the tables reference outside materials, one list per table */
		const extraTextures: PlacedTexture[][] = [
			environments.textures.map((ref) => ({ ref, place: null })),
			water.textures,
		];
		let conversion: AssetConversion | null = null;
		let assetTables: Pick<AssetConversion, 'geometries' | 'materials' | 'textures' | 'extraTextureIds'>;
		if (options.convertAssets) {
			const places = content.uses.resolve(
				content.chains.chains,
				content.geometries.assets.length,
				content.materials.assets.length,
			);
			const pool = new ConvertPool(options.jobs, {
				gameData: context.config.gameData,
				keys: context.keys,
				blobDir: store.dir.root,
			});
			try {
				conversion = await convertAssets({
					resolver: await context.resolver(),
					store,
					pool,
					cache,
					geometries: content.geometries.assets,
					materials: content.materials.assets,
					materialOverrides: content.materialOverrides,
					chains: content.chains.chains,
					places,
					extraTextures,
					archives: layout.assets,
					geometryZstdLevel: options.zstdLevel,
					textureZstdLevel: options.textureZstdLevel,
					materialConcurrency: MATERIAL_CONCURRENCY,
					log: options.log,
				});
			} finally {
				await pool.close();
			}
			assetTables = conversion;
			timer.adopt(conversion.stats.timings);
		} else {
			assetTables = pendingAssets(
				content.geometries.assets.length,
				content.materials.assets.length,
				extraTextures,
			);
			timer.end('assets');
		}
		// #endregion

		const states = await buildSceneStates(context.world, scene, {
			controls,
			collector: content.collector,
			environments: environments.levels,
			progressions,
			placements: entities.placements,
		});
		timer.end('states');

		// #region write
		const [environmentTextureIds, waterTextureIds] = assetTables.extraTextureIds;
		const environmentTable = finishEnvironments(environments, environmentTextureIds);
		indexEnvironmentControls(environmentTable, states.controlIndex);
		const waterTable = finishWater(water, waterTextureIds);
		indexWaterControls(waterTable, states.controlIndex);
		const tree = builder.build(
			(key) => (scene.grid.rootSize / 2 ** key.level) * ERROR_PER_EDGE,
			instances.global,
		);
		// a new table is one more member here
		const members: CoreMember[] = [
			{ path: CORE_PATHS.tree, data: encodeTree(tree) },
			{ path: CORE_PATHS.chains, data: encodeChains(chainOrder.chains) },
			{ path: CORE_PATHS.geometries, data: binaryTable(encodeGeometryTable(assetTables.geometries)) },
			{ path: CORE_PATHS.materials, data: jsonTable(assetTables.materials satisfies MaterialTable) },
			{
				path: CORE_PATHS.textures,
				data: binaryTable(encodeTextureTable(assetTables.textures.samplers, assetTables.textures.entries)),
			},
			{ path: CORE_PATHS.water, data: jsonTable(waterTable) },
			{ path: CORE_PATHS.lights, data: jsonTable(lights) },
			{ path: CORE_PATHS.particles, data: jsonTable(content.particles.table()) },
			{ path: CORE_PATHS.environment, data: jsonTable(environmentTable) },
			{
				path: CORE_PATHS.irradiance,
				data: encodeIrradianceTable(
					irradiance?.table ?? {
						keys: new Uint32Array(),
						blobs: new Uint32Array(),
						groups: new Uint32Array(),
					},
				),
			},
		];
		const written = await writePackage(
			{ store, layout, dir: stage, previous },
			{
				format: PACKAGE_FORMAT,
				version: PACKAGE_VERSION,
				source: scene.source,
				scene: { id: scene.id, name: scene.names.get(scene.id) ?? null },
				subset: scene.subset.info,
				tree: scene.grid,
				terrain:
					scene.terrain === null || terrain === null
						? null
						: { ...scene.terrain.info, levels: terrain.levels, splat: terrain.splat },
				levels: states.levels,
				states: {
					categories: states.categories,
					controls: states.controls,
					conditionalSets: states.conditionalSets,
					groups: states.groups,
					streamAreas: states.streamAreas,
					missions: states.missions,
					mainStory: states.mainStory,
				},
				irradianceRegions,
			},
			members,
		);
		timer.end('write');
		// #endregion

		// #region debug
		// a new debug output is one more file here
		const debugFiles: DebugFile[] = [
			{ name: 'environments.json', value: { levels: environments.debug, problems: environments.problems } },
			{ name: 'water.json', value: water.debug },
			{ name: 'unsupported-interactives.json', value: entities.unsupported },
			{ name: 'unsupported-prefabs.json', value: content.unsupportedPrefabs },
			{ name: STAND_INS_FILE, value: content.standInReports() },
			{ name: 'skipped-entities.json', value: content.skipped.rows() },
			{
				name: 'assets.json',
				value: {
					geometries: assetRows(content.geometries.assets, conversion?.debug.geometries),
					materials: assetRows(content.materials.assets, conversion?.debug.materials),
					textures: conversion?.debug.textures ?? [],
				},
			},
			{ name: 'chunk-files.json', value: scene.files.map((file) => file.name) },
			{ name: CHAIN_KEYS_FILE, value: chainOrder.keys },
		];
		if (terrain !== null && terrain.debug !== null) {
			debugFiles.push({ name: 'terrain.json', value: terrain.debug });
		}
		await writeDebug(stage, debugFiles, debugLog.path);
		timer.end('debug');
		// #endregion

		await rm(spool, { recursive: true, force: true });
		await swapIn(stage, options.outDir);
		// after the swap: the cache keeps blobs only for roots whose package exists
		const cacheReport = (await cache?.finish(options.outDir, store.hashes())) ?? null;
		if (cacheReport !== null) {
			timer.end('cache sweep');
		}

		const { rows } = instances;
		const { chains } = content.chains;
		return {
			outDir: options.outDir,
			timings: timer.timings,
			entities: content.counts,
			instances: rows,
			chains: {
				count: chains.length,
				draws: chains.reduce((sum, chain) => sum + chain.draws.length, 0),
				instancesPerChain: (rows.detail + rows.hlod + rows.global) / Math.max(1, chains.length),
			},
			assets: {
				geometries: content.geometries.assets.length,
				materials: content.materials.assets.length,
				textures: assetTables.textures.entries.length,
				shaders: conversion?.stats.shaders ?? 0,
				unresolvedPaths: [...content.geometries.assets, ...content.materials.assets].filter(
					(asset) => asset.path === null,
				).length,
				ready: {
					geometries: ready(assetTables.geometries),
					materials: ready(assetTables.materials.entries),
					textures: ready(assetTables.textures.entries),
				},
			},
			conversion: conversion?.stats ?? null,
			environments: {
				posts: environments.posts.length,
				textures: environments.textures.length,
				levels: environments.debug,
				problems: environments.problems.length,
			},
			water: {
				surfaces: water.debug.surfaces,
				volumes: water.debug.volumes,
				configs: water.table.configs.length,
				global: water.debug.global,
				sectors: water.debug.sectors,
				textures: water.textures.length,
				errors: water.debug.errors.length,
			},
			terrain:
				terrain?.debug == null
					? null
					: {
							tiles: terrain.debug.tiles,
							withoutSurface: terrain.debug.withoutSurface.length,
							leavesWithoutSplat: terrain.debug.leavesWithoutSplat.length,
							orphanPages: terrain.debug.orphanPages.length,
							layerProblem: terrain.debug.layerProblem,
						},
			hlod: {
				clusters: instances.hlodClusters,
				tierCounts: instances.tierCounts,
				nameMatchesPosition: entities.hlodNameMatches / Math.max(1, instances.hlodClusters),
				grid: {
					cellSize: scene.hlod.cellSize,
					origin: scene.hlod.origin,
					aligned: scene.hlod.aligned,
					agreement: scene.hlod.agreement,
				},
			},
			irradiance: irradiance?.report ?? null,
			tree: treeTotals(tree),
			blobs: blobTotals(store),
			coreMembers: written.coreMembers,
			cache: cacheReport,
			archives: written.archives,
			totalBytes: written.archives.reduce((sum, archive) => sum + archive.size, 0),
			// maxRSS is in KiB
			peakRss: process.resourceUsage().maxRSS * 1024,
		};
	} finally {
		// gone after a successful swap; a failed pack leaves the previous package untouched
		await rm(stage, { recursive: true, force: true });
		await cache?.close();
	}
};
