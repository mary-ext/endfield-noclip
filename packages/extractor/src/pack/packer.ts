import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	DrawFlags,
	type RectDecal,
	type RendererDraw,
} from '@endfield-noclip/formats/endfield/init-chunk-data';
import type { LevelPartition, PartitionLevel } from '@endfield-noclip/formats/endfield/level-partition';
import { CELL_SIZE } from '@endfield-noclip/formats/endfield/map-config';
import { terrainLeafLevel, type TerrainSurfacesData } from '@endfield-noclip/formats/hg/terrain';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import {
	inverseTransformPoint,
	multiplyMatrices,
	transformBounds,
	transformPoint,
	trsMatrix,
	unityEulerQuaternion,
} from '@endfield-noclip/formats/unity/transform';
import type { Aabb } from '@endfield-noclip/formats/unity/values';
import { encodeBlobTable } from '@endfield-noclip/package-format/blob-table';
import { BLOB_KIND_NAMES, BlobKind } from '@endfield-noclip/package-format/blobs';
import {
	EnvironmentBlendMode,
	type EnvironmentTable,
	type EnvironmentVolumeInfo,
} from '@endfield-noclip/package-format/environment';
import type { GeometryTable } from '@endfield-noclip/package-format/geometry';
import {
	encodeChains,
	encodeInstanceBlock,
	type ChainDraw,
	DrawRole,
} from '@endfield-noclip/package-format/instances';
import {
	encodeIrradianceTable,
	type IrradianceRegionInfo,
	type IrradianceTable,
} from '@endfield-noclip/package-format/irradiance';
import type { LightsTable } from '@endfield-noclip/package-format/lights';
import {
	type ArchiveInfo,
	CORE_ARCHIVE,
	CORE_PATHS,
	type LevelEnvironment,
	type LevelInfo,
	PACKAGE_FORMAT,
	PACKAGE_VERSION,
	type PackageManifest,
	shardStem,
	type StreamedArchive,
	type SubsetInfo,
} from '@endfield-noclip/package-format/manifest';
import type { MaterialTable } from '@endfield-noclip/package-format/materials';
import type {
	ConditionalSetInfo,
	ControlDriver,
	SceneControl,
	StatesInfo,
} from '@endfield-noclip/package-format/states';
import { streamAreaControl, type StreamAreasInfo } from '@endfield-noclip/package-format/stream-areas';
import type { TerrainSplatInfo, TerrainInfo } from '@endfield-noclip/package-format/terrain';
import type { TextureTable } from '@endfield-noclip/package-format/textures';
import {
	type TileKey,
	tileAncestor,
	tileAt,
	tileFootprint,
	tileId,
} from '@endfield-noclip/package-format/tiles';
import {
	encodeTree,
	CONTENT_KIND_NAMES,
	ContentKind,
	type ContentRef,
	type Tree,
	type TreeInfo,
} from '@endfield-noclip/package-format/tree';
import type { Bounds, Rect, Vec3 } from '@endfield-noclip/package-format/values';
import type { WaterFloater, WaterTable, WaterVolumeEntry } from '@endfield-noclip/package-format/water';

import { definite, mapDefined, unique } from '@mary-ext/array-fns';

import type { Context } from '../context.ts';
import { ignoreMissing } from '../errors.ts';
import type { AssetResolver, ObjectRef } from '../game/assets.ts';
import { billboardPlacement } from '../game/billboard.ts';
import { RENDER_PIPELINE_QUAD_PATH } from '../game/builtin-resources.ts';
import { cabinDoors, loadCabins } from '../game/cabins.ts';
import { decodeDynamicGrid, dynamicGridReach } from '../game/dynamic-grids.ts';
import { loadDynamicStructures } from '../game/dynamic-structures.ts';
import type { SceneEnvironmentVolume } from '../game/environment.ts';
import { allOf, GameState, type MapVariables } from '../game/game-state.ts';
import { loadInteractiveFacilities } from '../game/interactive-facilities.ts';
import { loadInteractiveVariables, nameInteractiveVariable } from '../game/interactive-variables.ts';
import { Locator } from '../game/map-labels.ts';
import { axisLengths, withAxisLengths } from '../game/particle-mesh.ts';
import { loadPlacedVolumes } from '../game/prefab-environment.ts';
import { placePrefabLight, readPrefabLights, type PrefabLight } from '../game/prefab-lights.ts';
import { readPrefabRenderers, type PrefabRenderer } from '../game/prefab.ts';
import {
	defaultSceneStates,
	loadMapVariables,
	loadSceneStates,
	sceneStateControl,
	sceneStateControls,
	type SceneStateDefinition,
	unnamedSceneStateControl,
} from '../game/scene-conditions.ts';
import { derivedSource, sceneControl, switchValues, SWITCH_VALUES } from '../game/scene-control.ts';
import { loadProgressions, progressionControl, progressionId } from '../game/scenery-variants.ts';
import {
	activationCondition,
	entityVisibilityTargets,
	loadLevelScripts,
	loadScriptDrivers,
} from '../game/script-drivers.ts';
import { loadUpgradeLinks } from '../game/settlement-upgrades.ts';
import { labelStory, mainStoryOrder } from '../game/story.ts';
import { indexTerrain, loadTerrainSurfacesData, type TerrainSceneIndex } from '../game/terrain-source.ts';
import { loadWaterDrains, type WaterDrain } from '../game/water-drains.ts';
import { scriptWaterLevels, type ScriptWaterLevel, waterActionTarget } from '../game/water-volume-scripts.ts';
import { readWaterVolumes } from '../game/water-volumes.ts';
import type { ChunkFile, ChunkSource, WorldIndex } from '../game/world-index.ts';
import { orderedPool } from '../pool.ts';
import { zstd } from '../zstd.ts';

import { AssetArchives, AssetPlacement } from './asset-placement.ts';
import {
	type AssetConversion,
	type AssetDebug,
	AssetIds,
	convertAssets,
	type MaterialOverrides,
	pendingAssets,
	type PlacedTexture,
} from './assets.ts';
import { BlobDir } from './blob-file.ts';
import { BlobStore, type PutOptions, tileLocality } from './blob-store.ts';
import { aabbBounds, growBounds, squareOverlapsRect } from './bounds.ts';
import { CASTS_EVERYWHERE, ChainTable, chainDrawFlagsOf } from './chains.ts';
import { ControlRegistry } from './control-registry.ts';
import { ConvertPool } from './convert-pool.ts';
import {
	type EnvironmentPlan,
	type EnvironmentProblem,
	finishEnvironments,
	type LevelEnvironmentDebug,
	planEnvironments,
} from './environments.ts';
import {
	type HlodCandidates,
	type HlodLayout,
	type HlodSample,
	hlodCandidates,
	layoutHlodGrid,
	pickHlodTile,
} from './hlod-cells.ts';
import { type InstanceInput, InstanceBlockBuilder, rowReach } from './instances.ts';
import {
	type CabinRoomGroup,
	type IrradianceReport,
	packIrradiance,
	packIrradianceRegions,
	sceneStateBakeCondition,
} from './irradiance.ts';
import { LightCollector } from './lights.ts';
import { type CacheReport, PackCache } from './pack-cache.ts';
import { ParticleTable } from './particles.ts';
import { PhaseTimer } from './phase-timer.ts';
import { type SkippedEntityRow, SkippedEntities } from './skipped-entities.ts';
import { packTerrain as packTerrainStep, type TerrainDebug } from './terrain.ts';
import { TileTreeBuilder } from './tile-tree.ts';
import {
	finishWater,
	planWater,
	type WaterDebug,
	type WaterLevelSource,
	type WaterPlan,
	type WaterVolumeInput,
} from './water.ts';

// #region options and report

/** what to pack and how */
export interface PackOptions {
	/** streaming scene, e.g. `map02` */
	scene: string;
	/** package root; must be empty, absent, or hold a previous package (which is replaced) */
	outDir: string;
	/** LevelConfig id to restrict content to, or `null` */
	level: string | null;
	/** world rectangle to restrict content to (min inclusive, max exclusive), or `null` */
	bounds: Rect | null;
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

/** numbers about a written package */
export interface PackReport {
	outDir: string;
	timings: Record<string, number>;
	entities: Record<string, number>;
	instances: { detail: number; hlod: number; global: number };
	chains: { count: number; draws: number; instancesPerChain: number };
	assets: {
		geometries: number;
		materials: number;
		/** texture-table entries (deduplicated by content) */
		textures: number;
		shaders: number;
		unresolvedPaths: number;
		ready: { geometries: number; materials: number; textures: number };
	};
	/** asset conversion details, or `null` when assets weren't converted */
	conversion: AssetConversion['stats'] | null;
	/**
	 * post profiles, the textures the phases reference, what each level resolved to, and how many inputs were
	 * left out (listed in `debug/environments.json`)
	 */
	environments: { posts: number; textures: number; levels: LevelEnvironmentDebug[]; problems: number };
	/** water surfaces in the scene and packed, configs, the global config's name, sectors and maps */
	water: Pick<WaterDebug, 'surfaces' | 'volumes' | 'global' | 'sectors'> & {
		configs: number;
		textures: number;
		/** assets that failed to load, listed in `debug/water.json` */
		errors: number;
	};
	/**
	 * kept terrain tiles and how many pages were left out (listed in `debug/terrain.json`), `null` without
	 * terrain
	 */
	terrain: {
		tiles: number;
		withoutSurface: number;
		leavesWithoutSplat: number;
		orphanPages: number;
		layerProblem: string | null;
	} | null;
	hlod: {
		clusters: number;
		tierCounts: number[];
		nameMatchesPosition: number;
		/** the grid fitted to cluster names; misaligned tiers' clusters were filed by their detail */
		grid: Omit<HlodLayout, 'levels'>;
	};
	/** the baked irradiance volume's packed cells, or `null` if the scene has none */
	irradiance: IrradianceReport | null;
	tree: { nodes: number; refs: number; byKind: Record<string, number> };
	blobs: Record<string, { count: number; stored: number; raw: number }>;
	/** byte length of each fixed core member (manifest, tree, tables) */
	coreMembers: Record<string, number>;
	/** every archive; `reused` ones were cloned from the package this one replaced */
	archives: { name: string; size: number; headerLength: number; members: number; reused: boolean }[];
	totalBytes: number;
	/** cache hits and sweep, or `null` without a cache */
	cache: CacheReport | null;
	/** peak resident set size of the process, bytes */
	peakRss: number;
}

/**
 * an archive group whose blobs pass this size is split into parts by blob hash. parts land around 0.5–1× the
 * cap, well under the 4 GiB that u32 offsets allow, and sized for HTTP and OPFS
 */
const ARCHIVE_CAP = 1024 ** 3;

/** materials decoded concurrently */
const MATERIAL_CONCURRENCY = 8;

// #endregion

/**
 * the unit box the game's VFXDecal prefabs draw; rect decals have no mesh of their own (the game draws a
 * box), so they take this one
 */
const DECAL_CUBE_PATH =
	'assets/beyond/arts/effects/commonassets/arts/s_model/s_fx_particle_decal_cube.fbx##decalmesh';

/** a rect decal's draw has no LOD range: up to the largest f32 */
const DECAL_MAX_SQUARED = 3.4028234663852886e38;

/**
 * @param decal a rect decal
 * @returns its row's placement (`DECAL_PLACEMENT_FLOATS`): its colour with RGB times its intensity, then its
 *   UV scale and offset
 */
const decalPlacement = (decal: RectDecal): number[] => [
	decal.color[0] * decal.intensity,
	decal.color[1] * decal.intensity,
	decal.color[2] * decal.intensity,
	decal.color[3],
	...decal.uvScale,
	...decal.uvOffset,
];

/** HLOD cluster entity names: `HLOD<tier>_<i>_<j>_Cluster_<hash>_<n>…`, `i`/`j` being the tier's grid cell */
const HLOD_NAME = /^HLOD(\d)_(-?\d+)_(-?\d+)_Cluster_/;

/** an HLOD cluster entity waiting for its cell */
interface HlodCluster {
	/** level tag */
	tag: number;
	tier: number;
	/** the tiles its named cell may be */
	candidates: HlodCandidates;
	row: InstanceInput;
	name: string;
	/** chunk-file index */
	file: number;
	/** index into the collector's conditions for clusters of a stream area, else `null` */
	condition: number | null;
}

/**
 * files and directories a package consists of; only these are removed when replacing a package. macOS Finder
 * drops `.DS_Store` into any folder it shows, so it doesn't make a package directory foreign
 */
const PACKAGE_ENTRIES = new Set([
	CORE_ARCHIVE,
	'shards',
	'assets',
	'irradiance',
	'debug',
	'.spool',
	'.DS_Store',
]);

/**
 * placeholder error model until the game's HLOD switch distances are known: a node's geometric error is this
 * fraction of its edge length (64 m leaf → 4 m). tunable in the viewer through its SSE threshold
 */
const ERROR_PER_EDGE = 1 / 16;

/** reads ahead this many chunk files while decoding the current one */
const READ_AHEAD = 8;

/** terrain tiles and detail blocks encoded and compressed at once; bounds memory, keeps blob order stable */
const BLOB_BATCH = 64;

/**
 * packs one streaming scene into a viewer package
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
	});
	try {
		const scene = await indexScene(context, options);
		timer.end('setup');

		const pack: PackState = {
			scene,
			store,
			cache,
			builder: new TileTreeBuilder(scene.grid),
			chains: new ChainTable(),
			particles: new ParticleTable(),
			geometries: new AssetIds(),
			materials: new AssetIds(),
			materialOverrides: new Map(),
			uses: new AssetPlacement(scene.grid.shardLevel),
			assetArchives: new AssetArchives(),
			shardTiles: new Map(),
		};

		const entities = await collectEntities(context, pack);
		timer.end('entities');

		const terrainPacked = await packTerrain(context, pack);
		timer.end('terrain');

		const { scriptWater } = entities;
		entities.counts.waterScriptActionsComputed = scriptWater.computed;
		// independent; only water interns geometries, so ids stay deterministic
		const [environments, water] = await Promise.all([
			planEnvironments(
				context,
				options.scene,
				scene.partition?.levels ?? [],
				defaultSceneStates(scene.sceneStates, scene.game),
				entities.placedVolumes,
			),
			planWater(context, options.scene, {
				includes: (tag, x, z) => scene.subset.includesEntity(tag, x, z),
				subset: scene.subset.info !== null,
				geometry: (hash) => {
					const id = pack.geometries.intern(hash, scene.pathOf);
					// water is resident, so its meshes go to the common archive
					pack.uses.noteGeometry(id, null);
					return id;
				},
				syntheticGeometry: (mesh) => {
					const id = pack.geometries.internSynthetic(mesh);
					pack.uses.noteGeometry(id, null);
					return id;
				},
				volumes: entities.waterVolumes,
				scriptLevels: scriptWater.levels,
				placeSector: (rect) =>
					tileAt(scene.grid, scene.grid.shardLevel, (rect.minX + rect.maxX) / 2, (rect.minZ + rect.maxZ) / 2),
			}),
		]);
		timer.end('environments and water');
		const lights = gateByScene(entities.collected.states, scene, {
			environments,
			water,
			waterDrivers: entities.waterDrivers,
			waterDrains: await loadWaterDrains(context.world, entities.waterVolumes.volumes),
			lights: entities.lights,
		});
		entities.counts.lights = lights.lights.length;
		for (const [reason, count] of Object.entries(entities.lights.skipped)) {
			entities.counts[`lightsSkipped ${reason}`] = count;
		}

		const stateIndices = new Map(scene.sceneStates.map(({ index, name }) => [name, index]));
		const irradiance = await packIrradiance(context.vfs, store, cache, {
			scene: options.scene,
			includes: (x, z) =>
				scene.subset.info === null ||
				scene.subset.includesTile(tileAt(scene.grid, scene.grid.cellLevel, x, z)),
			groupOf: (names) => {
				if (names.length === 0) {
					return SHARED_GROUP;
				}
				const condition = sceneStateBakeCondition(names, (name) => stateIndices.get(name));
				return condition === null
					? null
					: entities.collected.states.group(0, entities.collected.states.condition(condition));
			},
		});
		const irradianceRegions = await packIrradianceRegions(context.vfs, store, {
			scene: options.scene,
			rooms: entities.cabinRooms,
		});
		timer.end('irradiance');

		const extraTextures: PlacedTexture[][] = [
			environments.textures.map((ref) => ({ ref, place: null })),
			water.textures,
		];

		// spooled, so a failed pack leaves nothing outside the package's own entries
		const debugLog = await DebugLog.create(join(spool, 'instances.jsonl'));
		const instances = await packInstances(
			pack,
			entities.collected,
			debugLog,
			new Set(water.floaterIds.flat()),
		);
		await debugLog.close();
		timer.end('instances');

		let conversion: AssetConversion | null = null;
		let assetTables: AssetTables;
		if (options.convertAssets) {
			const places = pack.uses.resolve(
				pack.chains.chains,
				pack.geometries.assets.length,
				pack.materials.assets.length,
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
					geometries: pack.geometries.assets,
					materials: pack.materials.assets,
					materialOverrides: pack.materialOverrides,
					chains: pack.chains.chains,
					places,
					extraTextures,
					archives: pack.assetArchives,
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
			assetTables = pendingAssets(pack.geometries.assets.length, pack.materials.assets.length, extraTextures);
			timer.end('assets');
		}

		const states = await sceneStates(
			context.world,
			scene,
			entities.collected,
			environments.levels,
			entities.placements,
		);
		timer.end('states');

		const [environmentTextureIds, waterTextureIds] = assetTables.extraTextureIds;
		const written = await writePackage(
			pack,
			assetTables,
			{ dir: stage, previous },
			{
				...states,
				environment: finishEnvironments(environments, environmentTextureIds),
				water: finishWater(water, waterTextureIds, instances.rowsOf),
				lights,
				irradiance: irradiance?.table ?? {
					keys: new Uint32Array(),
					blobs: new Uint32Array(),
					groups: new Uint32Array(),
				},
				irradianceRegions,
				global: instances.global,
				terrainLevels: terrainPacked.levels,
				terrainSplat: terrainPacked.splat,
			},
		);
		timer.end('write');

		await writeDebug(stage, {
			files: scene.files,
			instances: debugLog.path,
			geometries: pack.geometries.assets,
			materials: pack.materials.assets,
			conversion: conversion?.debug ?? null,
			environments: { levels: environments.debug, problems: environments.problems },
			water: water.debug,
			terrain: terrainPacked.debug,
			unsupportedInteractives: entities.unsupportedInteractives,
			unsupportedPrefabs: entities.unsupportedPrefabs,
			standIns: entities.standIns,
			skippedEntities: entities.skipped,
		});
		timer.end('debug');

		await rm(spool, { recursive: true, force: true });
		await swapIn(stage, options.outDir);
		// after the swap: the cache keeps blobs only for roots whose package exists
		const cacheReport = (await cache?.finish(options.outDir, store.hashes())) ?? null;
		if (cacheReport !== null) {
			timer.end('cache sweep');
		}

		const { rows } = instances;
		return {
			outDir: options.outDir,
			timings: timer.timings,
			entities: entities.counts,
			instances: rows,
			chains: {
				count: pack.chains.chains.length,
				draws: pack.chains.chains.reduce((sum, chain) => sum + chain.draws.length, 0),
				instancesPerChain: (rows.detail + rows.hlod + rows.global) / Math.max(1, pack.chains.chains.length),
			},
			assets: {
				geometries: pack.geometries.assets.length,
				materials: pack.materials.assets.length,
				textures: assetTables.textures.length,
				shaders: conversion?.stats.shaders ?? 0,
				unresolvedPaths: [...pack.geometries.assets, ...pack.materials.assets].filter(
					(asset) => asset.path === null,
				).length,
				ready: {
					geometries: ready(assetTables.geometries),
					materials: ready(assetTables.materials.entries),
					textures: ready(assetTables.textures),
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
				terrainPacked.debug === null
					? null
					: {
							tiles: terrainPacked.debug.tiles,
							withoutSurface: terrainPacked.debug.withoutSurface.length,
							leavesWithoutSplat: terrainPacked.debug.leavesWithoutSplat.length,
							orphanPages: terrainPacked.debug.orphanPages.length,
							layerProblem: terrainPacked.debug.layerProblem,
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
			tree: {
				nodes: written.tree.nodes.length,
				refs: written.tree.refs.length,
				byKind: refKinds(written.tree),
			},
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

// #region phases

type AssetTables = Pick<AssetConversion, 'geometries' | 'materials' | 'textures' | 'extraTextureIds'>;

/** what setup learns about the scene */
interface SceneIndex {
	options: PackOptions;
	names: Map<string, string>;
	partition: LevelPartition | undefined;
	terrainScene: TerrainSceneIndex | undefined;
	surface: TerrainSurfacesData | undefined;
	/** the manifest's terrain section without its levels, or `null` without terrain */
	terrain: Omit<TerrainInfo, 'levels' | 'splat'> | null;
	grid: TreeInfo;
	/** how HLOD cluster names map onto the grid */
	hlod: HlodLayout;
	subset: Subset;
	/** the scene's chunk files in processing order; debug rows index into it */
	files: ChunkFile[];
	/** the MapConfig's scene states, their conditions noted in {@link game} */
	sceneStates: SceneStateDefinition[];
	/** the quests, missions and variables the scene's conditions read */
	game: GameState;
	/** how the scene's MapConfig names its map's variables, or `null` without a MapConfig */
	variables: MapVariables | null;
	pathOf: (hash: bigint) => string | undefined;
	source: PackageManifest['source'];
}

/** what the phases build up */
interface PackState {
	scene: SceneIndex;
	store: BlobStore;
	cache: PackCache | null;
	builder: TileTreeBuilder;
	chains: ChainTable;
	particles: ParticleTable;
	geometries: AssetIds;
	materials: AssetIds;
	/** by material id, what a material variant changes (the material values a pose's clips set) */
	materialOverrides: Map<number, MaterialOverrides>;
	uses: AssetPlacement;
	assetArchives: AssetArchives;
	/** shard archive stem → its shard-level tile */
	shardTiles: Map<string, TileKey>;
}

const indexScene = async (
	context: Pick<Context, 'vfs' | 'world' | 'resolver'>,
	options: PackOptions,
): Promise<SceneIndex> => {
	const { world } = context;
	const [
		pathOf,
		bundleManifest,
		names,
		partition,
		terrainIndex,
		surface,
		chunkFiles,
		sceneStates,
		links,
		variables,
	] = await Promise.all([
		world.pathLookup(),
		world.manifest(),
		world.names(),
		world.partition(options.scene),
		indexTerrain(context.vfs),
		loadTerrainSurfacesData(context, options.scene),
		world.chunkFiles(),
		loadSceneStates(world, options.scene),
		loadUpgradeLinks(context, options.scene),
		loadMapVariables(world, options.scene),
	]);
	const game = new GameState({ links, variables });
	game.note(mapDefined(sceneStates, ({ condition }) => condition ?? undefined));
	const terrainScene = terrainIndex.get(options.scene);
	if (terrainScene !== undefined && surface === undefined) {
		throw new Error(`${options.scene} has terrain tiles but no HGTerrainSurfacesData`);
	}
	const files = chunkFiles
		.filter((file) => file.scene === options.scene)
		// always-loaded files first, then scene states; the default area before stream areas: a fixed order
		// for the first-wins dedupe, in which an entity of an always-loaded file stays unconditional
		.toSorted(
			(a, b) =>
				Number(a.sceneState !== 0) - Number(b.sceneState !== 0) ||
				Number(a.area !== 0) - Number(b.area !== 0) ||
				(a.name < b.name ? -1 : 1),
		);
	const terrainGrid = treeGrid(surface);
	// HLOD clusters sit in Global chunks only (every scene of the install), which are small
	const hlod = layoutHlodGrid(
		await hlodSamples(
			world,
			files.filter((file) => file.cell === null),
		),
		terrainGrid,
	);
	const grid: TreeInfo = { ...terrainGrid, hlodLevels: hlod.levels };
	return {
		options,
		names,
		partition,
		terrainScene,
		surface,
		terrain:
			surface === undefined
				? null
				: {
						baseHeight: surface.position.y,
						heightScale: surface.heightScale,
					},
		grid,
		hlod,
		subset: buildSubset(options, partition, grid),
		files,
		sceneStates,
		game,
		variables,
		pathOf,
		source: { buildGuid: bundleManifest.guid, contentHash: bundleManifest.contentHash },
	};
};

/** reads every chunk file of the scene, interning chains and sorting instances into groups */
const collectEntities = async (
	context: Context,
	pack: PackState,
): Promise<{
	collected: Collector;
	lights: LightCollector;
	counts: Record<string, number>;
	hlodNameMatches: number;
	unsupportedInteractives: { path: string; reason: string }[];
	unsupportedPrefabs: { path: string; reason: string }[];
	/** content drawn as stand-ins, once each */
	standIns: StandInReport[];
	/** entities left out, by reason and component set */
	skipped: SkippedEntityRow[];
	/** environment volumes that placed prefabs carry */
	placedVolumes: SceneEnvironmentVolume[];
	/** Dijiang's cabin slots, with the group that shows their built cabin */
	cabinRooms: CabinRoomGroup[];
	/**
	 * gameplay water volumes, the entity ids of the instance rows floating on each (by volume id), and the
	 * LevelData files they couldn't be read from
	 */
	waterVolumes: WaterVolumeInput;
	/** the constant water fills the scene's level scripts set, and how many they compute */
	scriptWater: { levels: ScriptWaterLevel[]; computed: number };
	/** by {@link waterActionTarget}, what runs each script action setting a water fill */
	waterDrivers: ReadonlyMap<string, ControlDriver[]>;
	/** every placed interactive's template and position, by logic id */
	placements: ReadonlyMap<string, { template: string; position: Vec3 }>;
}> => {
	const { scene } = pack;
	const { world } = context;
	const { grid, subset } = scene;
	const collected = new Collector();
	const lights = new LightCollector();
	const skipped = new SkippedEntities();
	const counts: Record<string, number> = {
		read: 0,
		unique: 0,
		noRenderer: 0,
		decal: 0,
		decalSkipped: 0,
		noMatrix: 0,
		noBounds: 0,
		excluded: 0,
		packed: 0,
		foliageGrids: 0,
		foliageInstances: 0,
	};
	// an entity repeats in every file that loads it (cells it overlaps, scene states, stream areas); one row
	// carries it, gated by all of those files
	const seen = new Set<number>();
	// rows of scene-state and stream-area files, by entity or foliage grid id, with every file holding them;
	// added once all files are read
	const gatedRows = new Map<
		number,
		{
			rows: InstanceInput[];
			tag: number;
			name: string;
			file: number;
			global: boolean;
			hlod: RegExpExecArray | null;
			sources: ChunkSource[];
		}
	>();
	let hlodNameMatches = 0;
	/** HLOD clusters whose name leaves more than one tile: clamped coordinates, or a misaligned tier */
	const unresolvedHlod: HlodCluster[] = [];
	/** bounds of always-loaded detail instances by `tileId/levelTag` */
	const detailBounds = new Map<string, Aabb[]>();
	const addHlod = (cluster: HlodCluster, key: TileKey): void => {
		const [x, , z] = cluster.row.bounds.center;
		const at = tileAt(grid, key.level, x, z);
		if (at.x === key.x && at.z === key.z) {
			hlodNameMatches++;
		}
		collected.addHlod(
			cluster.tag,
			cluster.condition,
			cluster.tier,
			key,
			cluster.row,
			cluster.name,
			cluster.file,
		);
		pack.uses.note(cluster.row.chain, key);
	};
	/** sends a static row to its destination: HLOD node, Global block, detail leaf or conditional leaf */
	const addRow = ({
		row,
		tag,
		name,
		file,
		global,
		hlod,
		visibility,
		stateGated,
	}: {
		row: InstanceInput;
		tag: number;
		name: string;
		/** chunk-file index */
		file: number;
		/** from a Global chunk file */
		global: boolean;
		/** the HLOD name match, or `null` for other renderers */
		hlod: RegExpExecArray | null;
		/** when it loads, `null` for always */
		visibility: ConditionalSetInfo | null;
		/** whether a scene state gates it, so no HLOD stands in for it */
		stateGated: boolean;
	}): void => {
		const condition = visibility === null ? null : collected.states.condition(visibility);
		if (hlod !== null && !stateGated) {
			const tier = Number(hlod[1]);
			const candidates = hlodCandidates({
				tree: grid,
				layout: scene.hlod,
				sample: { tier, x: Number(hlod[2]), z: Number(hlod[3]) },
				bounds: row.bounds,
			});
			const cluster = { tag, tier, candidates, row, name, file, condition };
			if (candidates.x[0] === candidates.x[1] && candidates.z[0] === candidates.z[1]) {
				addHlod(cluster, { level: candidates.level, x: candidates.x[0], z: candidates.z[0] });
			} else {
				// resolved once every detail instance is known
				unresolvedHlod.push(cluster);
			}
			return;
		}
		if (global) {
			collected.addGlobal(tag, condition, row, name, file);
			pack.uses.note(row.chain, null);
			return;
		}
		const key = tileAt(grid, grid.leafLevel, row.bounds.center[0], row.bounds.center[2]);
		if (stateGated && visibility !== null) {
			collected.addConditional(tag, key, row, name, { visibility, file, grid: null });
		} else {
			collected.addDetail(tag, condition, key, row, name, file);
			detailBounds.getOrInsertComputed(`${tileId(key)}/${tag}`, () => []).push(row.bounds);
		}
		pack.uses.note(row.chain, key);
	};

	const chainDraw = (draw: RendererDraw): ChainDraw => {
		return {
			geometry: pack.geometries.intern(draw.meshHash, scene.pathOf),
			material: pack.materials.intern(draw.materialHash, scene.pathOf),
			particles: null,
			submesh: draw.submesh,
			lod: draw.lod,
			role: (draw.flags & DrawFlags.ShadowOnly) === 0 ? DrawRole.Lit : DrawRole.ShadowOnly,
			minSquared: draw.lodMinSquared,
			maxSquared: draw.lodMaxSquared,
			flags: chainDrawFlagsOf(draw.flags),
			sortingLayer: 0,
			sortingOrder: 0,
		};
	};

	// rect decals draw the decal cube with their material, their row carrying their placement's colour and UV
	// transform (docs/package-format.md#instance-block-inst-efin; the game's decals: docs/game-data/materials.md#decals)
	const [cubeHash] = await world.hashesOf(DECAL_CUBE_PATH);
	const decalDraw = (decal: RectDecal, materialHash: bigint): ChainDraw | null => {
		if (cubeHash === undefined) {
			return null;
		}
		return {
			geometry: pack.geometries.intern(cubeHash, scene.pathOf),
			material: pack.materials.intern(materialHash, scene.pathOf),
			particles: null,
			submesh: 0,
			lod: 0,
			role: DrawRole.Lit,
			minSquared: 0,
			maxSquared: DECAL_MAX_SQUARED,
			flags: CASTS_EVERYWHERE,
			sortingLayer: 0,
			sortingOrder: 0,
		};
	};

	// files are settled in order, for a deterministic dedupe
	await orderedPool(
		scene.files,
		READ_AHEAD + 1,
		(file) => world.readChunkContent(file, scene.partition),
		(content, file, fileIndex) => {
			if (content instanceof Error) {
				throw content;
			}
			for (const light of content.lights) {
				if (subset.includesEntity(light.levelTag, light.position[0], light.position[2])) {
					lights.add(light, file);
				}
			}
			for (const entity of content.entities) {
				counts.read++;
				if (seen.has(entity.id)) {
					gatedRows.get(entity.id)?.sources.push(file);
					continue;
				}
				seen.add(entity.id);
				counts.unique++;
				let draws: ChainDraw[] | null = null;
				if (entity.decal !== null) {
					const material = content.decalMaterials.get(entity.id);
					const draw = material === undefined ? null : decalDraw(entity.decal, material);
					if (draw === null) {
						counts.decalSkipped++;
						skipped.add(
							'static',
							material === undefined ? 'rect decal without a material' : 'no decal cube mesh',
							entity,
						);
						continue;
					}
					counts.decal++;
					draws = [draw];
				} else if (entity.renderer === null) {
					counts.noRenderer++;
					skipped.add('static', 'no renderer', entity);
					continue;
				}
				if (entity.matrix === null) {
					counts.noMatrix++;
					skipped.add('static', 'no matrix', entity);
					continue;
				}
				// without bounds a row can't be filed, culled or sized for LOD
				if (entity.bounds === null) {
					counts.noBounds++;
					skipped.add('static', 'no bounds', entity);
					continue;
				}
				const { bounds } = entity;
				const [x, , z] = bounds.center;
				if (!subset.includesEntity(entity.levelTag, x, z)) {
					counts.excluded++;
					continue;
				}
				counts.packed++;

				const hlod = HLOD_NAME.exec(entity.name);
				if (entity.renderer !== null) {
					draws = entity.renderer.draws.map(chainDraw);
				}
				if (draws === null) {
					continue;
				}
				const row: InstanceInput = {
					chain: pack.chains.intern(draws),
					matrix: entity.matrix,
					bounds,
					entityId: entity.id,
				};
				if (entity.decal !== null) {
					row.decalPlacement = decalPlacement(entity.decal);
				}
				if (entity.rotator !== null) {
					row.spin = entity.rotator;
				}

				if (file.sceneState !== 0 || file.area !== 0) {
					gatedRows.set(entity.id, {
						rows: [row],
						tag: entity.levelTag,
						name: entity.name,
						file: fileIndex,
						global: file.cell === null,
						hlod,
						sources: [file],
					});
				} else {
					addRow({
						row,
						tag: entity.levelTag,
						name: entity.name,
						file: fileIndex,
						global: file.cell === null,
						hlod,
						visibility: null,
						stateGated: false,
					});
				}
				collected.noteOwner(entity.levelTag, rowReach(row));
			}
			for (const foliage of content.foliage) {
				if (seen.has(foliage.id)) {
					gatedRows.get(foliage.id)?.sources.push(file);
					continue;
				}
				seen.add(foliage.id);
				counts.foliageGrids++;
				// every instance of a cluster carries the cluster's bounds, so a cluster culls and switches LOD as
				// one, the way the game draws it
				const rows: InstanceInput[] = [];
				for (const cluster of foliage.clusters) {
					const [x, , z] = cluster.bounds.center;
					if (!subset.includesEntity(foliage.levelTag, x, z)) {
						continue;
					}
					const chain = pack.chains.intern(cluster.renderer.draws.map(chainDraw));
					for (const matrix of cluster.instances) {
						rows.push({ chain, matrix, bounds: cluster.bounds, entityId: foliage.id });
					}
					collected.noteOwner(foliage.levelTag, cluster.bounds);
				}
				counts.foliageInstances += rows.length;
				const source = {
					tag: foliage.levelTag,
					name: foliage.name,
					file: fileIndex,
					global: false,
					hlod: null,
				};
				if (file.sceneState !== 0 || file.area !== 0) {
					gatedRows.set(foliage.id, { ...source, rows, sources: [file] });
				} else {
					for (const row of rows) {
						addRow({ ...source, row, visibility: null, stateGated: false });
					}
				}
			}
		},
	);
	counts.gatedRenderers = gatedRows.size;
	for (const { rows, tag, name, file, global, hlod, sources } of gatedRows.values()) {
		const visibility = collected.states.sourceVisibility(sources);
		// HLOD clusters stand in for the rows of their own area, so area-only content keeps HLOD refinement;
		// scene-state content has no HLODs and streams as conditional detail
		const stateGated = visibility !== null && sources.some((source) => source.sceneState !== 0);
		for (const row of rows) {
			addRow({ row, tag, name, file, global, hlod, visibility, stateGated });
		}
	}
	for (const cluster of unresolvedHlod) {
		const key = pickHlodTile({
			tree: grid,
			leafLevel: grid.leafLevel,
			candidates: cluster.candidates,
			bounds: cluster.row.bounds,
			detailAt: (leaf) => detailBounds.get(`${tileId(leaf)}/${cluster.tag}`) ?? [],
		});
		addHlod(cluster, key);
	}
	const dynamic = await loadDynamicStructures(context, scene.options.scene, scene.partition, scene.game);
	for (const [key, count] of Object.entries(dynamic.counts)) {
		counts[`dynamic_${key}`] = count;
	}
	counts.dynamicRenderers = 0;
	collected.states.add(...dynamic.controls);
	/** script-controlled dynamic entities' controls by global id */
	const scripted = new Map(
		mapDefined(dynamic.controls, (control): [string, SceneControl] | undefined =>
			control.kind === 'script' ? [control.id.slice('script:'.length), control] : undefined,
		),
	);
	const levelScripts = await loadLevelScripts(context, scene.options.scene, new Set(scripted.keys()));
	const scriptWater = scriptWaterLevels(levelScripts);
	/** by {@link waterActionTarget}, the drivers of the script action setting a water fill */
	const waterDrivers = new Map<string, ControlDriver[]>();
	for (const index of dynamic.sceneStates) {
		collected.states.sceneStates.add(index);
	}
	for (const area of dynamic.areas) {
		collected.states.areas.add(area);
	}
	/**
	 * @param loadGrid the DynamicStreaming grid that loads the row, or `null` to draw it within the detail
	 *   distance
	 */
	const addStructure = (
		row: InstanceInput,
		tag: number,
		name: string,
		{ visibility, loadGrid }: { visibility: ConditionalSetInfo; loadGrid: number | null },
	): void => {
		const [x, , z] = row.bounds.center;
		const key = tileAt(grid, grid.leafLevel, x, z);
		collected.addConditional(tag, key, row, name, { visibility, file: -1, grid: loadGrid });
		collected.noteOwner(tag, rowReach(row));
		pack.uses.note(row.chain, key);
		counts.dynamicRenderers++;
	};
	// content the viewer can't draw as the game does, drawn as stand-ins (`DrawRole.Unsupported`); prefab
	// renderers are listed once per prefab and pose, however many times it's placed
	const standIns: StandInReport[] = [];
	let modelId = 0;
	/** places a unit cube stand-in, transformed by `matrix`, for content without a mesh of its own to show */
	const addStandInCube = (
		{
			matrix,
			tag,
			entityId,
			visibility,
			loadGrid,
		}: {
			matrix: Float32Array;
			tag: number;
			entityId: number;
			visibility: ConditionalSetInfo;
			/** see {@link addStructure} */
			loadGrid: number | null;
		},
		report: Omit<StandInReport, 'position'>,
	): void => {
		const bounds = transformBounds(UNIT_CUBE_BOUNDS, matrix);
		if (!subset.includesEntity(tag, bounds.center[0], bounds.center[2])) {
			return;
		}
		const draw: ChainDraw = {
			geometry: pack.geometries.internSynthetic('cube'),
			material: null,
			particles: null,
			submesh: 0,
			lod: 0,
			role: DrawRole.Unsupported,
			minSquared: -1,
			maxSquared: 3.4028234663852886e38,
			flags: CASTS_EVERYWHERE,
			sortingLayer: 0,
			sortingOrder: 0,
		};
		addStructure({ chain: pack.chains.intern([draw]), matrix, bounds, entityId }, tag, report.name, {
			visibility,
			loadGrid,
		});
		standIns.push({ ...report, position: bounds.center.map((value) => Math.round(value)) });
	};
	for (const { light, visibility } of dynamic.lights) {
		if (subset.includesEntity(light.levelTag, light.position[0], light.position[2])) {
			lights.addConditional(light, visibility);
		}
	}
	for (const { entity, decalMaterial, visibility, grid: loadGrid } of dynamic.entities) {
		if (seen.has(entity.id)) {
			continue;
		}
		if (entity.matrix === null) {
			seen.add(entity.id);
			skipped.add('dynamic', 'no matrix', entity);
			continue;
		}
		if (entity.decal !== null) {
			seen.add(entity.id);
			const draw = decalMaterial === null ? null : decalDraw(entity.decal, decalMaterial);
			if (draw === null) {
				counts.decalSkipped++;
				skipped.add(
					'dynamic',
					decalMaterial === null ? 'rect decal without a material' : 'no decal cube mesh',
					entity,
				);
				continue;
			}
			// the decal cube maps the unit cube, so its matrix gives the bounds when the entity has none
			const bounds = entity.bounds ?? transformBounds(UNIT_CUBE_BOUNDS, entity.matrix);
			if (!subset.includesEntity(entity.levelTag, bounds.center[0], bounds.center[2])) {
				continue;
			}
			counts.decal++;
			addStructure(
				{
					chain: pack.chains.intern([draw]),
					matrix: entity.matrix,
					bounds,
					entityId: entity.id,
					decalPlacement: decalPlacement(entity.decal),
					spin: entity.rotator ?? undefined,
				},
				entity.levelTag,
				entity.name,
				{ visibility, loadGrid },
			);
			continue;
		}
		seen.add(entity.id);
		if (entity.renderer === null || entity.bounds === null) {
			skipped.add('dynamic', entity.renderer === null ? 'no renderer' : 'no bounds', entity);
			continue;
		}
		const [x, , z] = entity.bounds.center;
		if (!subset.includesEntity(entity.levelTag, x, z)) {
			continue;
		}
		addStructure(
			{
				chain: pack.chains.intern(entity.renderer.draws.map(chainDraw)),
				matrix: entity.matrix,
				bounds: entity.bounds,
				entityId: entity.id,
				spin: entity.rotator ?? undefined,
			},
			entity.levelTag,
			entity.name,
			{ visibility, loadGrid },
		);
	}
	const facilities = await loadInteractiveFacilities(
		context,
		scene.options.scene,
		scene.options.level,
		scene.partition,
		entityVisibilityTargets(levelScripts.scripts, levelScripts.ownLevels),
		dynamic.erosionCores,
	);
	counts.interactiveFacilities = facilities.progressions.length;
	/** proximity controls of the trigger volumes script groups follow */
	const volumeProximities: SceneControl[] = [];
	{
		for (const [id, control] of facilities.scriptControls) {
			if (!scripted.has(id)) {
				scripted.set(id, control);
				collected.states.add(control);
			}
		}
		counts.scriptInteractives = facilities.scriptControls.size;
		const found = await loadScriptDrivers(
			context,
			levelScripts,
			new Set(scripted.keys()),
			scriptWater.levels.map((level) => ({
				script: level.script,
				node: level.node,
				target: waterActionTarget(level),
			})),
		);
		for (const [id, drivers] of found.drivers) {
			const control = scripted.get(id);
			if (control !== undefined) {
				control.drivers = drivers;
			} else if (id.startsWith('water:')) {
				waterDrivers.set(id, drivers);
			}
		}
		// a group its scripts set by quest checks whenever they run follows those quests; its default is then the
		// one a finished story gives (see ControlRegistry.finish)
		counts.scriptGroupsDerived = 0;
		for (const [id, rule] of found.rules) {
			const control = scripted.get(id);
			const condition = control && activationCondition(rule, control.default === 1);
			if (!control || !condition) {
				continue;
			}
			control.assumption = 'set by its level scripts’ quest checks when they run';
			control.source = derivedSource(
				collected.states.condition({ alternatives: scene.game.requirements(condition) }),
				scene.game.describe(condition),
			);
			counts.scriptGroupsDerived++;
		}
		// a group one script sets as the player enters and leaves a volume follows the camera through a proximity
		// control per volume
		counts.scriptGroupsByVolume = 0;
		for (const [id, rule] of found.volumes) {
			const control = scripted.get(id);
			if (control === undefined) {
				continue;
			}
			const nearness = `proximity:volume:${rule.volume}`;
			if (!volumeProximities.some((known) => known.id === nearness)) {
				volumeProximities.push(
					sceneControl({
						kind: 'proximity',
						id: nearness,
						name: `Script ${rule.volume.replace(':', ' volume ')}`,
						values: switchValues('outside', 'inside'),
						default: 0,
						assumption: 'follows the camera, as the game follows the player',
						source: {
							kind: 'camera',
							test: {
								kind: 'near',
								reaches: rule.spheres.map(({ position, radius }) => ({ position: [...position], radius })),
							},
						},
					}),
				);
			}
			control.assumption = 'follows the camera, as its level script follows the player';
			control.source = derivedSource(
				collected.states.condition({ alternatives: [[{ control: nearness, mask: rule.inside ? 2 : 1 }]] }),
				[
					rule.inside ? 'shown while ' : 'hidden while ',
					{ control: nearness, text: 'the player is inside its level script’s trigger volume' },
				],
			);
			counts.scriptGroupsByVolume++;
		}
		counts.levelScripts = found.counts.scripts;
		counts.levelScriptsUndecoded = found.counts.undecoded;
		counts.scriptGroupsWithDrivers = found.counts.targeted;
		counts.scriptVisibilityUntraced = found.untraced;
		// event types the driver mapping doesn't classify, which drivers name as `unknown`
		counts.scriptEventTypesUnmapped = found.unmapped.size;
		if (found.unmapped.size > 0) {
			scene.options.log(
				`script events without a driver mapping: ${[...found.unmapped]
					.map(([type, paths]) => `${type} ×${paths}`)
					.join(', ')}`,
			);
		}
	}
	for (const standIn of facilities.standIns) {
		// a metre cube on the interactive's pivot, since its model's size isn't known
		const matrix = multiplyMatrices(
			trsMatrix(standIn.position, unityEulerQuaternion(standIn.rotation), standIn.scale),
			trsMatrix([0, 0.5, 0], [0, 0, 0, 1], [1, 1, 1]),
		);
		addStandInCube(
			{
				matrix,
				tag: standIn.levelTag,
				entityId: syntheticEntityId(standIn.levelTag, modelId++),
				visibility: standIn.visibility,
				loadGrid: null,
			},
			{ path: standIn.source, name: standIn.template, reason: standIn.reason },
		);
	}
	const waterVolumes = await readWaterVolumes(
		context,
		scene.options.scene,
		scene.options.level,
		scene.partition,
	);
	counts.waterVolumes = waterVolumes.volumes.length;
	/** by floating interactive's level logic id, its volume's id */
	const floaterVolume = new Map<string, string>();
	{
		const known = new Set(waterVolumes.volumes.map(({ id }) => id));
		for (const { id, volume } of waterVolumes.floaters) {
			if (known.has(volume)) {
				floaterVolume.set(id, volume);
			}
		}
	}
	/** by volume id, the entity ids of its floaters' instance rows */
	const floaterRows = new Map<string, number[]>();
	const cabins = await loadCabins(context, dynamic.slots, scene.partition);
	counts.cabinSlots = cabins.rooms.length;
	{
		// a Dijiang cabin's door opens once the cabin is built
		const linked = cabinDoors(
			dynamic.slots,
			facilities.doors.map(({ control, position }) => ({ id: control.id, position })),
		);
		for (const { control } of facilities.doors) {
			const cabin = linked.get(control.id);
			if (cabin !== undefined) {
				control.assumption = 'follows its Dijiang cabin slot';
				control.source = derivedSource(
					collected.states.condition({ alternatives: [[{ control: cabin, mask: 2 }]] }),
					['open while ', { control: cabin, text: 'its cabin slot' }, ' is built'],
				);
			}
		}
		counts.doors = facilities.doors.length;
		counts.cabinDoors = linked.size;
	}
	collected.states.add(
		...facilities.progressions,
		...facilities.created,
		...facilities.activities,
		...cabins.controls,
		...facilities.doors.map(({ control }) => control),
		...facilities.bridges,
		...facilities.proximityControls,
		...volumeProximities,
	);
	counts.bridges = facilities.bridges.length;
	counts.unsupportedInteractiveFiles = facilities.unsupported.length;
	const resolver = await context.resolver();
	const particleQuad = await findParticleQuad(context, resolver);
	/** by prefab and pose: its renderers, or why it couldn't be read, and how reports name it */
	const prefabs = new Map<string, Promise<{ label: string; read: PrefabRenderer[] | FormatError }>>();
	const prefabLights = new Map<bigint, Promise<PrefabLight[]>>();
	const unsupportedLights: { path: string; reason: string }[] = [];
	counts.prefabLights = 0;
	const unsupportedPrefabs: { path: string; reason: string }[] = [];
	for (const placement of [...dynamic.models, ...facilities.models, ...cabins.models]) {
		const { model, levelTag } = placement;
		// ownership filters can reject a prefab before any of its bundles are read.
		if (
			scene.options.level !== null &&
			!subset.includesEntity(levelTag, model.position[0], model.position[2])
		) {
			continue;
		}
		const { pose } = placement;
		const locked = placement.locked ?? false;
		/** the rows of an interactive placement that floats on a water volume */
		let floating: number[] | undefined;
		if (placement.source.startsWith('Data/Json/LevelData/')) {
			const volume = floaterVolume.get(placement.source.slice(placement.source.lastIndexOf('#') + 1));
			if (volume !== undefined) {
				floating = floaterRows.getOrInsertComputed(volume, () => []);
			}
		}
		const prefab = prefabs.getOrInsertComputed(`${model.pathHash}:${pose?.key ?? ''}:${locked}`, async () => {
			const paths = unique(
				resolver.manifest.findAssets(model.pathHash).map((asset) => resolver.manifest.assetPath(asset)),
			);
			const label = paths.length === 1 ? paths[0] : `0x${model.pathHash.toString(16)}`;
			// one malformed prefab stands in as a box instead of failing the scene
			const read = await (async (): Promise<PrefabRenderer[] | FormatError> => {
				if (paths.length !== 1) {
					throw new FormatError(`prefab has ${paths.length} manifest paths`);
				}
				const root = await resolver.findUnique(
					{ hash: model.pathHash, path: paths[0] },
					UnityClass.GameObject,
				);
				const renderers = await readPrefabRenderers(resolver, root, { viewPose: pose, particleQuad, locked });
				for (const { name, unsupported } of renderers) {
					if (unsupported !== null) {
						standIns.push({ path: label, name, reason: unsupported, position: null });
					}
				}
				return renderers;
			})().catch((error: unknown): FormatError => {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				unsupportedPrefabs.push({ path: label, reason: error.message });
				return error;
			});
			return { label, read };
		});
		const rotation = unityEulerQuaternion(model.rotation);
		{
			// the prefab's own lights load with the placement too
			const read = prefabLights.getOrInsertComputed(model.pathHash, () => {
				const paths = unique(
					resolver.manifest.findAssets(model.pathHash).map((asset) => resolver.manifest.assetPath(asset)),
				);
				if (paths.length !== 1) {
					// reported with the renderers
					return Promise.resolve([]);
				}
				return (async () => {
					const root = await resolver.findUnique(
						{ hash: model.pathHash, path: paths[0] },
						UnityClass.GameObject,
					);
					return readPrefabLights(resolver, root);
				})().catch((error: unknown): PrefabLight[] => {
					if (!(error instanceof FormatError)) {
						throw error;
					}
					unsupportedLights.push({ path: paths[0], reason: error.message });
					return [];
				});
			});
			// oxlint-disable-next-line no-await-in-loop -- stable synthetic ids
			for (const prefabLight of await read) {
				const light = placePrefabLight(
					prefabLight,
					{ position: model.position, rotation, scale: model.scale },
					syntheticEntityId(levelTag, modelId++),
				);
				if (subset.includesEntity(levelTag, light.position[0], light.position[2])) {
					lights.addConditional(light, placement.visibility);
					counts.prefabLights++;
				}
			}
		}
		const rootMatrix = trsMatrix(model.position, rotation, model.scale);
		// oxlint-disable-next-line no-await-in-loop -- stable asset ids and bounded bundle cache
		const { label, read } = await prefab;
		if (read instanceof FormatError) {
			// its size isn't known, so a metre cube stands on its pivot, scaled with the placement
			addStandInCube(
				{
					matrix: multiplyMatrices(rootMatrix, trsMatrix([0, 0.5, 0], [0, 0, 0, 1], [1, 1, 1])),
					tag: levelTag,
					entityId: syntheticEntityId(levelTag, modelId++),
					visibility: placement.visibility,
					loadGrid: placement.grid ?? null,
				},
				{ path: label, name: label, reason: read.message },
			);
			continue;
		}
		for (const renderer of read) {
			let matrix = multiplyMatrices(rootMatrix, renderer.matrix);
			if (renderer.ownSize) {
				matrix = withAxisLengths(matrix, axisLengths(renderer.matrix));
			}
			let bounds = transformBounds(renderer.bounds, matrix);
			if (renderer.billboard !== null) {
				({ matrix, bounds } = billboardPlacement(
					matrix,
					multiplyMatrices(rootMatrix, renderer.billboard.frame),
					renderer.billboard.offset,
					renderer.bounds,
				));
			}
			if (!subset.includesEntity(levelTag, bounds.center[0], bounds.center[2])) {
				continue;
			}
			let geometry: number;
			if (renderer.motion !== null) {
				geometry = pack.geometries.internAnimatedObject(renderer.mesh, renderer.motion);
			} else if (renderer.pose !== null) {
				geometry = pack.geometries.internPosedObject(renderer.mesh, renderer.pose);
			} else {
				geometry = pack.geometries.internObject(renderer.mesh);
			}
			let role: DrawRole = DrawRole.Lit;
			if (renderer.unsupported !== null) {
				role = DrawRole.Unsupported;
			} else if (renderer.shadowOnly) {
				role = DrawRole.ShadowOnly;
			}
			// an effect's LOD table shows the renderer at some camera distances from the effect's origin, or a
			// LODGroup at some screen-relative heights: one draw per span. distance bands win where both apply
			const spans =
				renderer.distances === null && renderer.sizes !== null
					? renderer.sizes.map(({ lod, min, max }) => squaredSpan(lod, min, max))
					: (renderer.distances?.ranges ?? [{ near: 0, far: Infinity }]).map(({ near, far }) =>
							squaredSpan(0, near, far),
						);
			const draws = mapDefined(renderer.materials, (material, index): ChainDraw[] | undefined => {
				if (material === null) {
					return undefined;
				}
				// a pose's clips can set this renderer's material values, which then need a variant of their own
				const saved = renderer.materialValues[index];
				let id: number;
				if (saved === null) {
					id = pack.materials.internObject(material);
				} else {
					id = pack.materials.internObjectVariant(material, `posed ${JSON.stringify(saved)}`);
					pack.materialOverrides.set(id, { saved });
				}
				const particles = renderer.particles === null ? null : pack.particles.intern(renderer.particles);
				// a prefab renderer has no game flag word; its role says whether it only casts shadows
				return spans.map(({ lod, minSquared, maxSquared }) => ({
					geometry,
					material: id,
					particles,
					submesh: Math.min(index, renderer.submeshes - 1),
					lod,
					role,
					minSquared,
					maxSquared,
					flags: CASTS_EVERYWHERE,
					sortingLayer: renderer.sorting.layer,
					sortingOrder: renderer.sorting.order,
				}));
			}).flat();
			if (draws.length === 0) {
				continue;
			}
			const entityId = syntheticEntityId(levelTag, modelId++);
			floating?.push(entityId);
			addStructure(
				{
					chain: pack.chains.intern(draws, {
						billboard: renderer.billboard?.flag ?? 0,
						distanceOrigin:
							renderer.distances === null
								? null
								: distanceOrigin(matrix, transformPoint(rootMatrix, renderer.distances.origin)),
					}),
					matrix,
					bounds,
					entityId,
				},
				levelTag,
				renderer.name,
				{ visibility: placement.visibility, loadGrid: placement.grid ?? null },
			);
		}
	}
	const placed = await loadPlacedVolumes(
		resolver,
		[...dynamic.models, ...facilities.models, ...cabins.models],
		defaultValues(scene, collected, await progressionControls(world, scene)),
	);
	counts.prefabEnvironmentVolumes = placed.volumes.length;
	{
		// a prefab that fails in several readers is reported once
		const reported = new Set(unsupportedPrefabs.map(({ path }) => path));
		for (const failure of [...unsupportedLights, ...placed.unsupported]) {
			if (!reported.has(failure.path)) {
				reported.add(failure.path);
				unsupportedPrefabs.push(failure);
			}
		}
	}
	counts.unsupportedPrefabs = unsupportedPrefabs.length;
	// placements repeat their prefab's stand-ins
	const reportedStandIns = [...new Map(standIns.map((report) => [JSON.stringify(report), report])).values()];
	counts.standIns = reportedStandIns.length;
	return {
		collected,
		lights,
		counts,
		hlodNameMatches,
		unsupportedInteractives: facilities.unsupported,
		unsupportedPrefabs,
		standIns: reportedStandIns,
		skipped: skipped.rows(),
		placedVolumes: placed.volumes,
		cabinRooms: cabins.rooms.map(({ control, levelTag, position, roomType }) => ({
			group: collected.states.group(
				levelTag,
				collected.states.condition({ alternatives: [[{ control, mask: 2 }]] }),
			),
			position,
			roomType,
		})),
		waterVolumes: { volumes: waterVolumes.volumes, floaterRows, unsupported: waterVolumes.unsupported },
		scriptWater,
		waterDrivers,
		placements: facilities.placements,
	};
};

/**
 * every control's default as the entity pass knows it, resolved like the viewer resolves the package's:
 * quests, missions and variables, MapConfig scene states (at their conditions' defaults, as their derived
 * controls aren't built yet), progressions, and script, logic and facility controls. stream areas aren't
 * included, so content that needs one doesn't count as loaded
 */
const defaultValues = (
	scene: Pick<SceneIndex, 'sceneStates' | 'game'>,
	collected: Collector,
	progressions: readonly SceneControl[],
): Record<string, number> => {
	const enabled = defaultSceneStates(scene.sceneStates, scene.game);
	const states = new Set([...collected.states.sceneStates, ...scene.sceneStates.map(({ index }) => index)]);
	return collected.states.defaults([
		...scene.game.controls(),
		...[...states].map((index) =>
			Object.assign(unnamedSceneStateControl(index), { default: Number(enabled.has(index)) }),
		),
		...progressions,
	]);
};

/**
 * @returns one control per progression of the scene, at its highest authored level as in a finished world,
 *   like quests at completed; an outpost's completed upgrade missions agree with that level
 */
const progressionControls = async (
	world: WorldIndex,
	scene: Pick<SceneIndex, 'options'>,
): Promise<SceneControl[]> =>
	(await loadProgressions(world, scene.options.scene)).map((progression) =>
		progressionControl(
			progression.kind,
			progressionId(progression.kind, progression.key),
			progression.key,
			progression.levels,
			progression.defaultLevel,
			'the highest authored level, as in a finished world',
		),
	);

/**
 * gives environment volumes, water surfaces and lights their visibility groups (their level, and the scene
 * states of the files holding them), and adds the scene state controls: one per MapConfig state, derived from
 * its condition, plus any state an expression requires that the MapConfig doesn't name
 *
 * @param states the entity pass's controls, conditions and groups; extended
 * @param scene the scene's MapConfig states and game state
 * @param inputs planned environments (volume groups and controls are filled in), planned water (surface
 *   groups and volume controls), the drivers of the scripts that set water fills, the quests that need pools
 *   drained, and the entity pass's lights
 * @returns the lights table
 */
const gateByScene = (
	states: ControlRegistry,
	scene: Pick<SceneIndex, 'sceneStates' | 'game'>,
	inputs: {
		environments: EnvironmentPlan;
		water: WaterPlan;
		waterDrivers: ReadonlyMap<string, ControlDriver[]>;
		waterDrains: ReadonlyMap<string, WaterDrain[]>;
		lights: LightCollector;
	},
): LightsTable => {
	const { environments, water, waterDrivers, waterDrains, lights } = inputs;
	for (const [i, volume] of environments.volumes.entries()) {
		const { levelTag, sceneStates, condition } = environments.volumeOwners[i];
		// a prefab volume loads with its placement; chunk volumes with the scene states of their files
		const loads = condition ?? (sceneStates.length === 0 ? null : states.stateVisibility(sceneStates));
		if (volume.phase === null) {
			volume.group = states.groupOf(levelTag, loads);
			continue;
		}
		const control = environmentVolumeControl(i, volume);
		states.add(control);
		volume.control = control.id;
		const on = [[{ control: control.id, mask: 2 }]];
		volume.group = states.groupOf(levelTag, {
			alternatives: loads === null ? on : allOf(loads.alternatives, on),
		});
	}
	for (const [i, surface] of water.table.surfaces.entries()) {
		const { levelTag, sources } = water.surfaceOwners[i];
		surface.group =
			sources === null ? states.group(levelTag, null) : states.groupOfSources(levelTag, sources);
		if (surface.kind === 'volume') {
			const entry = water.table.volumes[surface.volume];
			const { min, max } = surface.bounds;
			const control = waterLevelControlOf(entry, water.levelSources[surface.volume], {
				drivers: waterDrivers,
				drains: waterDrains.get(entry.id) ?? [],
				position: [(min[0] + max[0]) / 2, entry.base, (min[2] + max[2]) / 2],
			});
			if (control !== null) {
				// it moves the volume's surface rather than gating content; a volume may have several surfaces
				if (states.get(control.id) === undefined) {
					states.add(control);
				}
				states.keep(control.id, [levelTag]);
			}
		}
	}
	const lightsTable = lights.finish(
		(levelTag, sources) => states.groupOfSources(levelTag, sources),
		(levelTag, visibility) => states.groupOf(levelTag, visibility),
	);
	const controls = sceneStateControls(scene.sceneStates, scene.game, (formula) => states.condition(formula));
	const named = new Set(controls.map((control) => control.id));
	const unnamed = [...states.sceneStates]
		.filter((index) => !named.has(sceneStateControl(index)))
		.toSorted((a, b) => a - b)
		.map(unnamedSceneStateControl);
	states.add(...controls, ...unnamed);
	return lightsTable;
};

/**
 * @param index the volume's manifest index
 * @param volume an environment volume with a phase
 * @returns the control that switches it: on by default, except a scripted (mode 3) volume, whose script isn't
 *   followed
 */
const environmentVolumeControl = (index: number, volume: EnvironmentVolumeInfo): SceneControl =>
	sceneControl({
		kind: 'environmentVolume',
		id: `environmentVolume:${index}`,
		name: volume.name,
		values: SWITCH_VALUES,
		default: volume.blendMode === EnvironmentBlendMode.Manual ? 0 : 1,
		assumption:
			volume.blendMode === EnvironmentBlendMode.Manual
				? 'off: a level script fades it in, which isn’t followed; on previews it at full strength'
				: 'on: it applies wherever it holds the camera',
	});

/**
 * @param volume a water volume's table entry
 * @param sources where each of its levels comes from
 * @param context.drivers by {@link waterActionTarget}, what runs each script action setting a fill
 * @param context.drains the quests that need the volume drained
 * @param context.position where its surface is
 * @returns its `waterLevel` control, listing what sets each fill: at the authored fill, or drained when a
 *   quest needs it so (a finished story has drained it); `null` when nothing sets another fill
 */
const waterLevelControlOf = (
	volume: WaterVolumeEntry,
	sources: readonly WaterLevelSource[],
	context: {
		drivers: ReadonlyMap<string, ControlDriver[]>;
		drains: readonly WaterDrain[];
		position: Vec3;
	},
): SceneControl | null => {
	if (volume.control === null) {
		return null;
	}
	const found: ControlDriver[] = [];
	const add = (driver: ControlDriver): void => {
		if (!found.some((known) => JSON.stringify(known) === JSON.stringify(driver))) {
			found.push(driver);
		}
	};
	for (const [value, { actions }] of sources.entries()) {
		for (const action of actions) {
			for (const driver of context.drivers.get(waterActionTarget(action)) ?? []) {
				add({ ...driver, value });
			}
		}
	}
	const authored = volume.levels.findIndex(({ fraction }) => fraction === volume.initial);
	const pumped = sources.some((source) => source.pumped);
	const empty = volume.levels.findIndex(({ fraction }) => fraction === 0);
	for (const { quest } of context.drains) {
		add({ kind: 'quest', quests: [quest], value: empty });
	}
	const drained = pumped && context.drains.length > 0;
	let assumption = 'the authored fill, before any script runs';
	if (drained) {
		const needs = context.drains.map(({ quest }) => quest.mission ?? quest.id).join(', ');
		assumption = `drained, as in a finished story: the server keeps the pool’s water, the player pumps it out, and ${needs} needs it drained`;
	} else if (pumped) {
		assumption =
			'the authored fill: the server keeps the pool’s water and the player may pump it out, but nothing needs it drained';
	}
	return sceneControl({
		kind: 'waterLevel',
		id: volume.control,
		name: `${pumped ? 'Pool' : 'Water volume'} ${volume.id}`,
		values: volume.levels.map(({ fraction }, value) => {
			const tags = definite([
				sources[value]?.authored && 'authored',
				sources[value]?.pumped && fraction === 0 && 'drained',
				sources[value]?.pumped && fraction === 1 && 'full',
			]);
			const height = (volume.base + volume.heightMax * fraction).toFixed(1);
			return {
				value,
				label: `${Math.round(fraction * 100)}% (${height} m)${tags.length > 0 ? `, ${tags.join(', ')}` : ''}`,
			};
		}),
		default: drained ? empty : authored,
		assumption,
		drivers: found,
		position: context.position,
	});
};

/** the top of the 27-bit per-level id space, for ids the game doesn't assign */
const SYNTHETIC_ID_TOP = 0x7ffffff;

/**
 * @returns an entity id for a prefab renderer: the owning level's tag, as every entity id carries, over an
 *   index counted down from the top of the level's id space, away from the game's ids
 */
const syntheticEntityId = (levelTag: number, index: number): number => {
	if (index > SYNTHETIC_ID_TOP) {
		throw new Error(`more than ${SYNTHETIC_ID_TOP + 1} prefab renderers`);
	}
	return ((levelTag << 27) | (SYNTHETIC_ID_TOP - index)) >>> 0;
};

/** a stand-in in `debug/stand-ins.json`: what it stands in for and why */
interface StandInReport {
	/** the prefab, structure or entity it belongs to */
	path: string;
	/** the GameObject or entity */
	name: string;
	reason: string;
	/**
	 * where a placed stand-in's centre is, to the metre; `null` for a prefab renderer's, listed once however
	 * often the prefab is placed
	 */
	position: number[] | null;
}

/** the synthetic stand-in cube's bounds */
const UNIT_CUBE_BOUNDS: Aabb = { center: [0, 0, 0], extents: [0.5, 0.5, 0.5] };

/** @returns the quad billboard particles draw, or `null` if the install doesn't have it where expected */
const findParticleQuad = async (context: Context, resolver: AssetResolver): Promise<ObjectRef | null> => {
	const [hash] = await context.world.hashesOf(RENDER_PIPELINE_QUAD_PATH);
	if (hash === undefined) {
		return null;
	}
	try {
		return await resolver.findUnique({ hash, path: RENDER_PIPELINE_QUAD_PATH }, UnityClass.Mesh);
	} catch {
		return null;
	}
};

/**
 * stores the subset's terrain (see `terrain.ts`) and attaches its pages to the tree
 *
 * @returns the levels that have height pages, ascending, the detail section (`null` when the scene's layers
 *   can't be packed) and what was left out (`null` without terrain)
 */
const packTerrain = async (
	context: Pick<Context, 'vfs' | 'world' | 'resolver'>,
	pack: PackState,
): Promise<{ levels: number[]; splat: TerrainSplatInfo | null; debug: TerrainDebug | null }> => {
	const { terrainScene, surface, terrain, subset, grid } = pack.scene;
	if (terrainScene === undefined || surface === undefined || terrain === null) {
		return { levels: [], splat: null, debug: null };
	}
	const packed = await packTerrainStep(context, pack.store, pack.cache, {
		scene: pack.scene.options.scene,
		terrainScene,
		surface,
		terrain,
		grid,
		includesTile: (key) => subset.includesTile(key),
		stemOf: (key) => archiveForTile(pack, key),
		layerStem: TERRAIN_LAYER_STEM,
		zstdLevel: pack.scene.options.zstdLevel,
		textureZstdLevel: pack.scene.options.textureZstdLevel,
		log: pack.scene.options.log,
	});
	const whole = { tier: 0, group: SHARED_GROUP, first: 0, count: 1, reach: null };
	for (const tile of packed.tiles) {
		const { key } = tile;
		pack.builder.addRef(key, { ...whole, kind: ContentKind.TerrainHeights, blob: tile.heights });
		pack.builder.extend(key, tile.bounds);
		if (tile.surface !== null) {
			pack.builder.addRef(key, { ...whole, kind: ContentKind.TerrainSurface, blob: tile.surface });
		}
		if (tile.splat !== null) {
			pack.builder.addRef(key, { ...whole, kind: ContentKind.TerrainSplat, blob: tile.splat });
		}
	}
	return { levels: packed.levels, splat: packed.splat, debug: packed.debug };
};

/** the archive holding the terrain layer textures, which every splat page draws from */
const TERRAIN_LAYER_STEM = 'assets/terrain-layers';

/**
 * stores every instance block, attaching detail and HLOD blocks to the tree
 *
 * @param tracked entity ids whose stored rows the caller needs (water floaters)
 * @returns row counts, the global content refs, HLOD tallies, and by tracked entity id the (blob, row) of
 *   every stored row that carries it
 */
const packInstances = async (
	pack: PackState,
	collected: Collector,
	debugLog: DebugLog,
	tracked: ReadonlySet<number>,
): Promise<{
	rows: PackReport['instances'];
	global: ContentRef[];
	hlodClusters: number;
	tierCounts: number[];
	rowsOf: Map<number, WaterFloater[]>;
}> => {
	const { store, builder, scene } = pack;
	const rowsOf = new Map<number, WaterFloater[]>();
	const track = (blob: number, group: Group, order: Uint32Array): void => {
		if (tracked.size === 0) {
			return;
		}
		for (const [row, id] of group.rows.entityIdsInOrder(order).entries()) {
			if (tracked.has(id)) {
				rowsOf.getOrInsertComputed(id, () => []).push({ blob, row });
			}
		}
	};
	const rows = {
		detail: countRows(collected.detail.values()),
		hlod: countRows(collected.hlod.values()),
		global: countRows(collected.global.values()),
	};

	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
	const detailGroups = [...collected.detail.values()].sort(
		(a, b) => a.key.z - b.key.z || a.key.x - b.key.x || a.visibility - b.visibility,
	);
	for (let start = 0; start < detailGroups.length; start += BLOB_BATCH) {
		const encoded = detailGroups.slice(start, start + BLOB_BATCH).map((group) => {
			const { minX, minZ } = tileFootprint(scene.grid, group.key);
			const { block, order } = group.rows.toBlock([minX, 0, minZ]);
			return { group, block, order };
		});
		// oxlint-disable-next-line no-await-in-loop -- batches bound memory and keep blob order stable
		const blobs = await store.putMany(
			encoded.map(({ group, block }) => ({
				raw: encodeInstanceBlock(block),
				options: placement(BlobKind.Instances, archiveForTile(pack, group.key), tileLocality(group.key)),
			})),
		);
		for (const [i, { group, order }] of encoded.entries()) {
			builder.addRef(group.key, {
				kind: group.conditional ? ContentKind.Conditional : ContentKind.Detail,
				tier: 0,
				group: group.visibility,
				blob: blobs[i],
				first: 0,
				count: group.rows.length,
				reach: group.grid === null ? null : builder.reach(dynamicGridReach(decodeDynamicGrid(group.grid))),
			});
			builder.extend(group.key, group.bounds!);
			track(blobs[i], group, order);
			// oxlint-disable-next-line no-await-in-loop -- lines go out in block order
			await debugLog.block(store.hashOf(blobs[i]), group, order);
		}
	}

	// HLOD and global rows form one block per visibility group, in the core
	const coreBlocks = async (groups: Map<number, Group>) => {
		const encoded = [...groups]
			.toSorted((a, b) => a[0] - b[0])
			.map(([visibility, group]) => {
				const { block, order } = group.rows.toBlock([scene.grid.origin[0], 0, scene.grid.origin[1]]);
				return { visibility, group, block, order };
			});
		const blobs = await store.putMany(
			encoded.map(({ block }) => ({
				raw: encodeInstanceBlock(block),
				options: placement(BlobKind.Instances, CORE_ARCHIVE, null),
			})),
		);
		for (const [i, { group, order }] of encoded.entries()) {
			track(blobs[i], group, order);
			// oxlint-disable-next-line no-await-in-loop -- lines go out in block order
			await debugLog.block(store.hashOf(blobs[i]), group, order);
		}
		return encoded.map(({ visibility, group, order }, i) => ({ visibility, group, order, blob: blobs[i] }));
	};

	let hlodClusters = 0;
	const tierCounts = [0, 0, 0];
	for (const { visibility, group, order, blob } of await coreBlocks(collected.hlod)) {
		// rows are sorted by node, so each node's clusters are one run
		const groups = group.rows.groupsInOrder(order);
		for (let first = 0; first < groups.length;) {
			let end = first + 1;
			while (end < groups.length && groups[end] === groups[first]) {
				end++;
			}
			const node = collected.hlodNodes.get(groups[first])!;
			builder.addRef(node.key, {
				kind: ContentKind.Hlod,
				tier: node.tier,
				group: visibility,
				blob,
				first,
				count: end - first,
				reach: null,
			});
			builder.extend(node.key, node.bounds);
			tierCounts[node.tier] += end - first;
			hlodClusters += end - first;
			first = end;
		}
	}

	const global = (await coreBlocks(collected.global)).map(({ visibility, group, blob }): ContentRef => ({
		kind: ContentKind.Detail,
		tier: 0,
		group: visibility,
		blob,
		first: 0,
		count: group.rows.length,
		reach: null,
	}));
	return { rows, global, hlodClusters, tierCounts, rowsOf };
};

/** the manifest's levels and scenery states */
interface SceneStateInfo extends StatesInfo {
	levels: LevelInfo[];
}

const sceneStates = async (
	world: WorldIndex,
	scene: SceneIndex,
	collected: Collector,
	/** per partition level: its base environment */
	environments: readonly (LevelEnvironment | null)[],
	/** every placed interactive's template and position, by logic id */
	placements: ReadonlyMap<string, { template: string; position: Vec3 }>,
): Promise<SceneStateInfo> => {
	const { partition } = scene;
	const progressions = await progressionControls(world, scene);
	const levels = (partition?.levels ?? []).map((level, i) =>
		levelInfo(level, scene, collected, environments[i] ?? null),
	);
	const areas = [...collected.states.areas]
		.toSorted((a, b) => a - b)
		.map((area) =>
			sceneControl({
				kind: 'area',
				id: streamAreaControl(area),
				name: `Stream area ${area}`,
				values: switchValues('hidden', 'shown'),
				default: 1,
				assumption: 'follows the camera, like the game',
				source: { kind: 'camera', test: { kind: 'area', area } },
			}),
		);
	const { states } = collected;
	states.add(...scene.game.controls(), ...progressions, ...areas);
	if (scene.variables !== null) {
		// a map variable holding an interactive's saved property is named and placed after the interactive
		for (const [id, variable] of await loadInteractiveVariables(world, scene.variables)) {
			const control = states.get(id);
			if (control !== undefined) {
				nameInteractiveVariable(control, variable, placements.get(variable.interactive));
			}
		}
	}
	const locator = await Locator.load(world, partition);
	const { controls, categories } = states.finish({
		groupBounds: collected.groupBounds(),
		locate: (position) => locator.locate(position),
	});
	const missions = await labelStory(world, controls);
	return {
		levels,
		categories,
		controls,
		conditionalSets: states.conditions,
		groups: states.groups,
		streamAreas: await streamAreasInfo(world, scene.options.scene, states.areas),
		missions,
		mainStory: mainStoryOrder(missions),
	};
};

/**
 * @param world world index
 * @param scene streaming scene id
 * @param areas stream areas packed content requires
 * @returns the scene's stream-area table for the viewer, or `null` when no content needs it
 * @throws {Error} if content needs areas but the scene has no stream-area table
 */
const streamAreasInfo = async (
	world: WorldIndex,
	scene: string,
	areas: ReadonlySet<number>,
): Promise<StreamAreasInfo | null> => {
	if (areas.size === 0) {
		return null;
	}
	const table = await world.streamAreas(scene);
	if (table === undefined) {
		throw new Error(`${scene} has stream-area content but no stream-area table`);
	}
	return {
		rootVisible: table.rootVisible,
		shownInside: [...table.visibleWhileInside].map(([zone, shown]) => ({ zone, areas: shown })),
		triggers: table.triggers.map(({ areaId, bounds, polygon }) => ({
			zone: areaId,
			min: [bounds.min.x, bounds.min.z],
			max: [bounds.max.x, bounds.max.z],
			minHeight: bounds.minHeight,
			maxHeight: bounds.maxHeight,
			polygon: polygon.map(({ x, z }): [number, number] => [x, z]),
		})),
	};
};

/** builds the tree and tables, then writes every archive */
const writePackage = async (
	pack: PackState,
	assetTables: AssetTables,
	/** where to write, and the package being replaced (whose unchanged archives are cloned), or `null` */
	{ dir, previous }: { dir: string; previous: string | null },
	states: SceneStateInfo & {
		environment: EnvironmentTable;
		water: WaterTable;
		lights: LightsTable;
		irradiance: IrradianceTable;
		irradianceRegions: IrradianceRegionInfo[];
		global: ContentRef[];
		terrainLevels: number[];
		terrainSplat: TerrainSplatInfo | null;
	},
): Promise<{ tree: Tree; coreMembers: Record<string, number>; archives: PackReport['archives'] }> => {
	const { scene, store } = pack;
	const { options, grid } = scene;
	const tree = pack.builder.build((key) => (grid.rootSize / 2 ** key.level) * ERROR_PER_EDGE, states.global);
	const treeBin = encodeTree(tree);
	const chainsBin = encodeChains(pack.chains.chains);
	const irradianceBin = encodeIrradianceTable(states.irradiance);
	// tables compress on the thread pool while the archives are written
	const tablesReady = Promise.all([
		zstdTable(json({ entries: assetTables.geometries } satisfies GeometryTable)),
		zstdTable(json(assetTables.materials satisfies MaterialTable)),
		zstdTable(json({ entries: assetTables.textures } satisfies TextureTable)),
		zstdTable(json(states.water)),
		zstdTable(json(states.lights)),
		zstdTable(json(pack.particles.table())),
		zstdTable(json(states.environment)),
	]);

	const stems = new Map([
		[CORE_ARCHIVE, CORE_ARCHIVE],
		...store.archives().map(({ name, stem }): [string, string] => [name, stem]),
	]);
	const archiveNames = [...stems.keys()];
	const blobsBin = encodeBlobTable(store.records(archiveNames));
	const [written, [geometries, materials, textures, water, lights, particles, environment]] =
		await Promise.all([store.writeArchives(dir, previous), tablesReady]);
	const tables = { geometries, materials, textures, water, lights, particles, environment };

	const generation = createHash('sha256');
	for (const part of [
		treeBin,
		chainsBin,
		blobsBin,
		tables.geometries,
		tables.materials,
		tables.textures,
		tables.water,
		tables.lights,
		tables.particles,
		tables.environment,
		irradianceBin,
	]) {
		generation.update(part);
	}
	const archives = archiveNames.map((name): ArchiveInfo => {
		if (name === CORE_ARCHIVE) {
			return { role: 'core', name };
		}
		const { size, dataOffset } = written.get(name)!;
		return archiveInfo(pack, stems.get(name)!, { name, size, dataOffset });
	});
	const manifest: PackageManifest = {
		format: PACKAGE_FORMAT,
		version: PACKAGE_VERSION,
		generation: generation.digest('hex').slice(0, 32),
		source: scene.source,
		scene: { id: options.scene, name: scene.names.get(options.scene) ?? null },
		subset: scene.subset.info,
		archives,
		tree: grid,
		terrain:
			scene.terrain === null
				? null
				: { ...scene.terrain, levels: states.terrainLevels, splat: states.terrainSplat },
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
		irradianceRegions: states.irradianceRegions,
	};
	const core = await store.writeCore(dir, [
		{ path: CORE_PATHS.manifest, data: await zstdTable(json(manifest)) },
		{ path: CORE_PATHS.tree, data: treeBin },
		{ path: CORE_PATHS.blobs, data: blobsBin },
		{ path: CORE_PATHS.chains, data: chainsBin },
		{ path: CORE_PATHS.geometries, data: tables.geometries },
		{ path: CORE_PATHS.materials, data: tables.materials },
		{ path: CORE_PATHS.textures, data: tables.textures },
		{ path: CORE_PATHS.water, data: tables.water },
		{ path: CORE_PATHS.lights, data: tables.lights },
		{ path: CORE_PATHS.particles, data: tables.particles },
		{ path: CORE_PATHS.environment, data: tables.environment },
		{ path: CORE_PATHS.irradiance, data: irradianceBin },
	]);

	return {
		tree,
		coreMembers: {
			[CORE_PATHS.tree]: treeBin.length,
			[CORE_PATHS.blobs]: blobsBin.length,
			[CORE_PATHS.chains]: chainsBin.length,
			[CORE_PATHS.geometries]: tables.geometries.length,
			[CORE_PATHS.materials]: tables.materials.length,
			[CORE_PATHS.textures]: tables.textures.length,
			[CORE_PATHS.water]: tables.water.length,
			[CORE_PATHS.lights]: tables.lights.length,
			[CORE_PATHS.particles]: tables.particles.length,
			[CORE_PATHS.environment]: tables.environment.length,
			[CORE_PATHS.irradiance]: irradianceBin.length,
		},
		archives: [core, ...written.values()].map(({ name, size, headerLength, members, reused }) => ({
			name,
			size,
			headerLength,
			members,
			reused,
		})),
	};
};

// #endregion

// #region grid and subset

/**
 * @param surface the scene's terrain parameters, if any
 * @returns tree parameters aligned with the terrain quadtree; scenes without terrain get a 4096 m grid at the
 *   origin
 */
const treeGrid = (surface: TerrainSurfacesData | undefined): TreeInfo => {
	const rootSize = surface?.terrainSize ?? 4096;
	const origin: [number, number] =
		surface === undefined ? [-rootSize / 2, -rootSize / 2] : [surface.position.x, surface.position.z];
	const leafLevel = terrainLeafLevel(rootSize);
	const cellLevel = Math.log2(rootSize / CELL_SIZE);
	if (!Number.isInteger(cellLevel) || cellLevel > leafLevel) {
		throw new Error(`a ${rootSize} m terrain doesn't align with the ${CELL_SIZE} m streaming cells`);
	}
	return {
		origin,
		rootSize,
		leafLevel,
		cellLevel,
		// replaced by the levels the HLOD grid fit finds
		hlodLevels: [leafLevel, leafLevel - 1, leafLevel - 2],
		shardLevel: Math.max(0, leafLevel - 3),
	};
};

/** a threshold span as squared bounds: an empty lower bound never culls, an infinite upper is `FLT_MAX` */
const squaredSpan = (
	lod: number,
	min: number,
	max: number,
): { lod: number; minSquared: number; maxSquared: number } => ({
	lod,
	minSquared: min > 0 ? min * min : -1,
	maxSquared: Number.isFinite(max) ? max * max : 3.4028234663852886e38,
});

/**
 * @param matrix an instance's transform
 * @param origin a world point
 * @returns the point in the instance's frame, to the millimetre so placements of one prefab share chains; the
 *   instance's own origin when its transform has no inverse (a zero scale, so nothing draws)
 */
const distanceOrigin = (matrix: Float32Array, origin: readonly number[]): [number, number, number] => {
	let local: [number, number, number] = [0, 0, 0];
	try {
		local = inverseTransformPoint(matrix, origin);
	} catch (error) {
		if (!(error instanceof RangeError)) {
			throw error;
		}
	}
	return [
		Math.round(local[0] * 1000) / 1000,
		Math.round(local[1] * 1000) / 1000,
		Math.round(local[2] * 1000) / 1000,
	];
};

/**
 * @param world the world index
 * @param files chunk files to read
 * @returns the HLOD clusters among their entities, once each
 */
const hlodSamples = async (world: WorldIndex, files: readonly ChunkFile[]): Promise<HlodSample[]> => {
	const samples: HlodSample[] = [];
	const seen = new Set<number>();
	for (const entities of await Promise.all(files.map((file) => world.readChunk(file, undefined)))) {
		for (const entity of entities) {
			const name = HLOD_NAME.exec(entity.name);
			if (name === null || entity.bounds === null || seen.has(entity.id)) {
				continue;
			}
			seen.add(entity.id);
			samples.push({
				tier: Number(name[1]),
				x: Number(name[2]),
				z: Number(name[3]),
				center: [entity.bounds.center[0], entity.bounds.center[2]],
			});
		}
	}
	return samples;
};

interface Subset {
	info: SubsetInfo | null;
	includesEntity(tag: number, x: number, z: number): boolean;
	includesTile(key: TileKey): boolean;
}

const buildSubset = (options: PackOptions, partition: LevelPartition | undefined, grid: TreeInfo): Subset => {
	let level: PartitionLevel | undefined;
	if (options.level !== null) {
		level = partition?.levels.find((candidate) => candidate.id === options.level);
		if (level === undefined) {
			throw new Error(`${options.level} isn't a level of ${options.scene}`);
		}
	}
	const { bounds } = options;
	const touched = new Set<string>();
	if (level !== undefined) {
		for (const cell of level.config.levelGrids ?? []) {
			const key = cellTile(grid, cell);
			for (let l = 0; l <= grid.cellLevel; l++) {
				touched.add(tileId(tileAncestor(key, l)));
			}
		}
	}
	return {
		info: level === undefined && bounds === null ? null : { level: level?.id ?? null, bounds },
		includesEntity: (tag, x, z) =>
			(level === undefined || tag === level.tag) &&
			(bounds === null || (x >= bounds.minX && x < bounds.maxX && z >= bounds.minZ && z < bounds.maxZ)),
		includesTile: (key) => {
			if (level !== undefined) {
				const probe = key.level > grid.cellLevel ? tileAncestor(key, grid.cellLevel) : key;
				if (!touched.has(tileId(probe))) {
					return false;
				}
			}
			if (bounds !== null) {
				return squareOverlapsRect(tileFootprint(grid, key), bounds);
			}
			return true;
		},
	};
};

/** @returns the cell-level tile of a 128 m streaming cell */
const cellTile = (grid: TreeInfo, cell: { x: number; z: number }): TileKey =>
	tileAt(grid, grid.cellLevel, (cell.x + 0.5) * CELL_SIZE, (cell.z + 0.5) * CELL_SIZE);

/**
 * @returns the archive group for a tile's content: the core for tiles coarser than the 128 m cells (the
 *   always-resident coarse layer), else the shard of its {@link TreeInfo.shardLevel} ancestor
 */
const archiveForTile = (pack: PackState, key: TileKey): string => {
	const { grid } = pack.scene;
	if (key.level < grid.cellLevel) {
		return CORE_ARCHIVE;
	}
	const tile = tileAncestor(key, grid.shardLevel);
	const stem = shardStem(tile);
	pack.shardTiles.set(stem, tile);
	return stem;
};

/**
 * @param pack the pack's state
 * @param stem a written archive's group, other than the core's
 * @param archive the written archive
 * @returns its manifest entry, its role and tile as recorded when its stem was handed out
 */
const archiveInfo = (pack: PackState, stem: string, archive: StreamedArchive): ArchiveInfo => {
	if (stem.startsWith('irradiance/')) {
		return { role: 'irradiance', ...archive };
	}
	const shard = pack.shardTiles.get(stem);
	if (shard !== undefined) {
		return { role: 'shards', ...archive, tile: shard };
	}
	return { role: 'assets', ...archive, tile: pack.assetArchives.tileOf(stem) ?? null };
};

const placement = (kind: BlobKind, stem: string, locality: string | null): PutOptions => ({
	kind,
	compress: true,
	stem,
	locality,
});

// #endregion

// #region collection

/** a run of instances with debug metadata */
interface Group {
	rows: InstanceBlockBuilder;
	/** per row: entity name and chunk-file index, for the debug index */
	names: string[];
	files: number[];
	/** world bounds of the rows; owned, grown in place */
	bounds: Bounds | null;
}

/** sorts HLOD rows by tree order: level, then z, then x */
const nodeSortKey = (key: TileKey): number =>
	key.level * 2 ** 40 + (key.z + 2 ** 19) * 2 ** 20 + (key.x + 2 ** 19);

/**
 * the visibility group of content every level shows and that always loads; the collector interns it first.
 * terrain uses it
 */
const SHARED_GROUP = 0;

/** a block of detail rows: one leaf, one visibility group, one game load grid */
interface DetailGroup extends Group {
	key: TileKey;
	/** index into the visibility groups */
	visibility: number;
	/** whether HLODs don't stand in for the rows (scene-state and dynamic content) */
	conditional: boolean;
	/** the DynamicStreaming grid that loads the rows, or `null` for rows drawn within the detail distance */
	grid: number | null;
}

/** gathers instances by destination while the entity pass runs, and interns visibility */
class Collector {
	/** detail rows by `tileId/visibility` */
	readonly detail = new Map<string, DetailGroup>();
	/** HLOD rows by visibility group */
	readonly hlod = new Map<number, Group>();
	/** HLOD nodes by sort key */
	readonly hlodNodes = new Map<number, { key: TileKey; tier: number; bounds: Bounds }>();
	/** rows of the Global chunk files by visibility group */
	readonly global = new Map<number, Group>();
	/** packed instance count by level tag, without HLOD clusters */
	readonly tagInstances = new Map<number, number>();
	/** world bounds of packed instances by level tag */
	readonly tagBounds = new Map<number, Bounds>();
	/** the scene controls, conditional sets and visibility groups the rows name */
	readonly states = new ControlRegistry();

	/**
	 * adds a row HLODs stand in for
	 *
	 * @param condition a conditional set index for rows of a stream area, else `null`
	 */
	addDetail(
		level: number,
		condition: number | null,
		key: TileKey,
		row: InstanceInput,
		name: string,
		file: number,
	): void {
		this.#addDetail(
			{ visibility: this.states.group(level, condition), conditional: false, grid: null },
			key,
			row,
			name,
			file,
		);
		this.#countInstance(level);
	}

	#addDetail(
		{ visibility, conditional, grid }: Pick<DetailGroup, 'visibility' | 'conditional' | 'grid'>,
		key: TileKey,
		row: InstanceInput,
		name: string,
		file: number,
	): void {
		const group = this.detail.getOrInsertComputed(`${tileId(key)}/${visibility}/${grid ?? ''}`, () => ({
			...newGroup(),
			key,
			visibility,
			conditional,
			grid,
		}));
		push(group, row, 0, name, file);
	}

	/**
	 * adds a row no HLOD stands in for
	 *
	 * @param grid the DynamicStreaming grid that loads the row, or `null` to draw it within the detail distance
	 */
	addConditional(
		level: number,
		key: TileKey,
		row: InstanceInput,
		name: string,
		{ visibility, file, grid }: { visibility: ConditionalSetInfo; file: number; grid: number | null },
	): void {
		this.#addDetail(
			{ visibility: this.states.groupOf(level, visibility), conditional: true, grid },
			key,
			row,
			name,
			file,
		);
		this.#countInstance(level);
	}

	/** @param condition a conditional set index for clusters of a stream area, else `null` */
	addHlod(
		level: number,
		condition: number | null,
		tier: number,
		key: TileKey,
		row: InstanceInput,
		name: string,
		file: number,
	): void {
		const group = this.hlod.getOrInsertComputed(this.states.group(level, condition), newGroup);
		const sortKey = nodeSortKey(key);
		push(group, row, sortKey, name, file);
		const node = this.hlodNodes.get(sortKey);
		if (node === undefined) {
			this.hlodNodes.set(sortKey, { key, tier, bounds: aabbBounds(row.bounds) });
		} else {
			growBounds(node.bounds, row.bounds);
		}
	}

	/**
	 * @param level the owning level's tag
	 * @param condition index into {@link conditions} for Global chunks of scene states, else `null`
	 */
	addGlobal(level: number, condition: number | null, row: InstanceInput, name: string, file: number): void {
		push(this.global.getOrInsertComputed(this.states.group(level, condition), newGroup), row, 0, name, file);
		this.#countInstance(level);
	}

	// HLOD clusters stand in for instances that are counted already
	#countInstance(level: number): void {
		this.tagInstances.set(level, (this.tagInstances.get(level) ?? 0) + 1);
	}

	/** @returns by visibility group index, a box around the instances it shows */
	groupBounds(): Map<number, Bounds> {
		const bounds = new Map<number, Bounds>();
		const add = (group: number, { bounds: rows }: Group): void => {
			if (rows === null) {
				return;
			}
			const current = bounds.get(group);
			if (current === undefined) {
				bounds.set(group, structuredClone(rows));
			} else {
				for (let axis = 0; axis < 3; axis++) {
					current.min[axis] = Math.min(current.min[axis], rows.min[axis]);
					current.max[axis] = Math.max(current.max[axis], rows.max[axis]);
				}
			}
		};
		for (const group of this.detail.values()) {
			add(group.visibility, group);
		}
		for (const map of [this.hlod, this.global]) {
			for (const [visibility, group] of map) {
				add(visibility, group);
			}
		}
		return bounds;
	}

	/** grows the bounds of a packed instance's level */
	noteOwner(tag: number, bounds: Aabb): void {
		const current = this.tagBounds.get(tag);
		if (current === undefined) {
			this.tagBounds.set(tag, aabbBounds(bounds));
		} else {
			growBounds(current, bounds);
		}
	}
}

const newGroup = (): Group => ({ rows: new InstanceBlockBuilder(), names: [], files: [], bounds: null });

const push = (group: Group, row: InstanceInput, sortKey: number, name: string, file: number): void => {
	group.rows.add(row, sortKey);
	group.names.push(name);
	group.files.push(file);
	const reach = rowReach(row);
	if (group.bounds === null) {
		group.bounds = aabbBounds(reach);
	} else {
		growBounds(group.bounds, reach);
	}
};

const countRows = (groups: Iterable<Group>): number => {
	let count = 0;
	for (const group of groups) {
		count += group.rows.length;
	}
	return count;
};

const levelInfo = (
	level: PartitionLevel,
	scene: SceneIndex,
	collected: Collector,
	environment: LevelEnvironment | null,
): LevelInfo => {
	const { config } = level;
	return {
		id: level.id,
		tag: level.tag,
		name: scene.names.get(level.id) ?? null,
		rect: {
			minX: config.rectLeftBottom[0],
			minZ: config.rectLeftBottom[1],
			maxX: config.rectRightTop[0],
			maxZ: config.rectRightTop[1],
		},
		playerInitPos: config.playerInitPos,
		cells: (config.levelGrids ?? [])
			.map((cell) => cellTile(scene.grid, cell))
			.map((key): [number, number] => [key.x, key.z])
			.toSorted((a, b) => a[1] - b[1] || a[0] - b[0]),
		instances: collected.tagInstances.get(level.tag) ?? 0,
		contentBounds: collected.tagBounds.get(level.tag) ?? null,
		environment,
	};
};

// #endregion

// #region output

/**
 * @returns whether `outDir` holds a package (to be replaced)
 * @throws {Error} unless `outDir` is absent, empty, or holds only a package
 */
const checkOutDir = async (outDir: string): Promise<boolean> => {
	const entries = (await ignoreMissing(readdir(outDir), null)) ?? [];
	if (entries.length === 0) {
		return false;
	}
	if (!entries.includes(CORE_ARCHIVE)) {
		throw new Error(`${outDir} isn't empty and doesn't hold a package; refusing to replace it`);
	}
	const foreign = entries.filter((entry) => !PACKAGE_ENTRIES.has(entry));
	if (foreign.length > 0) {
		throw new Error(`${outDir} holds files that aren't part of a package: ${foreign.join(', ')}`);
	}
	return true;
};

/** @returns a hidden directory next to `dir`, on the same file system so it can be renamed into place */
const siblingDir = (dir: string, suffix: string): string => {
	const resolved = resolvePath(dir);
	return join(dirname(resolved), `.${basename(resolved)}.${suffix}`);
};

/**
 * replaces `outDir` with the finished package in `stage`. each step is a rename, so readers see the old
 * package, briefly nothing, or the new package, never a mix
 */
const swapIn = async (stage: string, outDir: string): Promise<void> => {
	const old = siblingDir(outDir, 'old');
	await rm(old, { recursive: true, force: true });
	const hadPackage = await ignoreMissing(
		rename(outDir, old).then(() => true),
		false,
	);
	await rename(stage, outDir);
	if (hadPackage) {
		await rm(old, { recursive: true, force: true });
	}
};

/**
 * the debug instance index, written as blocks are stored: one line per instance block with its blob hash and,
 * per row, [entity id, entity name, chunk-files index]
 */
class DebugLog {
	readonly path: string;
	readonly #stream: WriteStream;

	private constructor(path: string, stream: WriteStream) {
		this.path = path;
		this.#stream = stream;
	}

	/** @param path file to write; its directory is created */
	static async create(path: string): Promise<DebugLog> {
		await mkdir(dirname(path), { recursive: true });
		return new DebugLog(path, createWriteStream(path));
	}

	/**
	 * appends a block's line, waiting while the stream is backed up
	 *
	 * @param blob the block's blob hash
	 * @param group the rows it was encoded from
	 * @param order per block row, its insertion index in `group`
	 */
	async block(blob: string, group: Group, order: Uint32Array): Promise<void> {
		const ids = group.rows.entityIdsInOrder(order);
		const rows = Array.from(order, (i, out): [number, string, number] => [
			ids[out],
			group.names[i],
			group.files[i],
		]);
		if (!this.#stream.write(`${JSON.stringify({ blob, rows })}\n`)) {
			await new Promise((resolve) => this.#stream.once('drain', resolve));
		}
	}

	/** flushes and closes the file */
	close(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.#stream.once('error', reject);
			this.#stream.end(resolve);
		});
	}
}

const writeDebug = async (
	outDir: string,
	debug: {
		files: ChunkFile[];
		/** the closed {@link DebugLog}'s file, moved into place */
		instances: string;
		geometries: { hash: bigint; path: string | null }[];
		materials: { hash: bigint; path: string | null }[];
		conversion: AssetConversion['debug'] | null;
		environments: { levels: LevelEnvironmentDebug[]; problems: EnvironmentProblem[] };
		water: WaterDebug;
		/** `null` without terrain, which writes no file */
		terrain: TerrainDebug | null;
		unsupportedInteractives: { path: string; reason: string }[];
		unsupportedPrefabs: { path: string; reason: string }[];
		standIns: StandInReport[];
		skippedEntities: SkippedEntityRow[];
	},
): Promise<void> => {
	const dir = join(outDir, 'debug');
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'environments.json'), json(debug.environments));
	await writeFile(join(dir, 'water.json'), json(debug.water));
	if (debug.terrain !== null) {
		await writeFile(join(dir, 'terrain.json'), json(debug.terrain));
	}
	await writeFile(join(dir, 'unsupported-interactives.json'), json(debug.unsupportedInteractives));
	await writeFile(join(dir, 'unsupported-prefabs.json'), json(debug.unsupportedPrefabs));
	await writeFile(join(dir, 'stand-ins.json'), json(debug.standIns));
	await writeFile(join(dir, 'skipped-entities.json'), json(debug.skippedEntities));
	await writeFile(
		join(dir, 'assets.json'),
		json({
			geometries: rows(debug.geometries, debug.conversion?.geometries),
			materials: rows(debug.materials, debug.conversion?.materials),
			textures: debug.conversion?.textures ?? [],
		}),
	);
	await writeFile(join(dir, 'chunk-files.json'), json(debug.files.map((file) => file.name)));
	await rename(debug.instances, join(dir, 'instances.jsonl'));
};

const asset = ({ hash, path }: { hash: bigint; path: string | null }) => ({
	hash: `0x${hash.toString(16)}`,
	path,
});

/** per id: StringPathHash key and path, plus the located object, its name and any failure */
const rows = (assets: { hash: bigint; path: string | null }[], converted: AssetDebug[] | undefined) =>
	assets.map((entry, id) => ({ ...asset(entry), ...converted?.[id] }));

const ready = (entries: readonly { status: string }[]): number =>
	entries.filter((entry) => entry.status === 'ready').length;

const refKinds = (tree: Tree): Record<string, number> => {
	const byKind: Record<string, number> = {};
	for (const ref of tree.refs) {
		byKind[CONTENT_KIND_NAMES[ref.kind]] = (byKind[CONTENT_KIND_NAMES[ref.kind]] ?? 0) + 1;
	}
	return byKind;
};

const blobTotals = (store: BlobStore): PackReport['blobs'] => {
	const totals: PackReport['blobs'] = {};
	for (const [kind, total] of store.totals()) {
		totals[BLOB_KIND_NAMES[kind]] = total;
	}
	return totals;
};

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/**
 * a `.zst` core member: one zstd frame. level 9 is within ~15 % of level 19 on these tables at a fortieth of
 * the time (2.5 s per table on map02)
 */
const zstdTable = (data: Uint8Array): Promise<Uint8Array> => zstd(data, 9);

// #endregion
