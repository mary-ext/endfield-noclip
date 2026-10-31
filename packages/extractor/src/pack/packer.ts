import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { DrawFlags, type RendererDraw } from '@endfield-noclip/formats/endfield/init-chunk-data';
import type { LevelPartition, PartitionLevel } from '@endfield-noclip/formats/endfield/level-partition';
import { CELL_SIZE } from '@endfield-noclip/formats/endfield/map-config';
import {
	TERRAIN_HEIGHT_HOLE,
	TERRAIN_HEIGHT_PAGE_SIZE,
	TERRAIN_PAGE_BORDER,
	TERRAIN_PAGE_SIZE,
	terrainLeafLevel,
	type TerrainSurfacesData,
} from '@endfield-noclip/formats/hg/terrain';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import {
	multiplyMatrices,
	transformBounds,
	trsMatrix,
	unityEulerQuaternion,
} from '@endfield-noclip/formats/unity/transform';
import type { Aabb } from '@endfield-noclip/formats/unity/values';
import { encodeBlobTable } from '@endfield-noclip/package-format/blob-table';
import { BLOB_KIND_NAMES, BlobKind } from '@endfield-noclip/package-format/blobs';
import { resolveSceneValues } from '@endfield-noclip/package-format/conditions';
import type {
	EnvironmentPhaseInfo,
	EnvironmentProfile,
	EnvironmentVolumeInfo,
} from '@endfield-noclip/package-format/environment';
import type { GeometryTable } from '@endfield-noclip/package-format/geometry';
import {
	encodeChains,
	encodeInstanceBlock,
	type ChainDraw,
	DrawRole,
	type InstanceBlock,
} from '@endfield-noclip/package-format/instances';
import { encodeIrradianceTable, type IrradianceTable } from '@endfield-noclip/package-format/irradiance';
import type { LightsTable } from '@endfield-noclip/package-format/lights';
import {
	type ArchiveInfo,
	COORDINATE_CONVENTIONS,
	CORE_ARCHIVE,
	CORE_PATHS,
	type LevelInfo,
	PACKAGE_FORMAT,
	PACKAGE_VERSION,
	type PackageManifest,
	shardStem,
	type SubsetInfo,
} from '@endfield-noclip/package-format/manifest';
import type { MaterialTable } from '@endfield-noclip/package-format/materials';
import type {
	ConditionalSetInfo,
	SceneControl,
	StatesInfo,
	VisibilityGroup,
} from '@endfield-noclip/package-format/states';
import type { StreamAreasInfo } from '@endfield-noclip/package-format/stream-areas';
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
	NodeFlags,
	type Tree,
	type TreeInfo,
} from '@endfield-noclip/package-format/tree';
import type { Bounds, Rect } from '@endfield-noclip/package-format/values';
import type { WaterTable } from '@endfield-noclip/package-format/water';

import { getOrInsert } from '../collections.ts';
import type { Context } from '../context.ts';
import { ignoreMissing } from '../errors.ts';
import { loadDynamicStructures } from '../game/dynamic-structures.ts';
import { GameState } from '../game/game-state.ts';
import { loadInteractiveFacilities } from '../game/interactive-facilities.ts';
import { readPrefabRenderers, type PrefabRenderer } from '../game/prefab.ts';
import {
	defaultSceneStates,
	loadSceneStates,
	sceneStateControl,
	sceneStateControls,
	type SceneStateDefinition,
	unnamedSceneStateControl,
} from '../game/scene-conditions.ts';
import { loadProgressions, progressionControl, progressionId } from '../game/scenery-variants.ts';
import { indexTerrain, loadTerrainSurfacesData, type TerrainSceneIndex } from '../game/terrain-source.ts';
import type { ChunkFile, ChunkSource, WorldIndex } from '../game/world-index.ts';
import { orderedPool } from '../pool.ts';
import { zstd } from '../zstd.ts';

import { AssetArchives, AssetPlacement } from './asset-placement.ts';
import {
	type AssetConversion,
	type AssetDebug,
	AssetIds,
	convertAssets,
	pendingAssets,
	type PlacedTexture,
} from './assets.ts';
import { BlobDir } from './blob-file.ts';
import { BlobStore, type PutOptions } from './blob-store.ts';
import { aabbBounds, growBounds, squareOverlapsRect } from './bounds.ts';
import { ChainTable } from './chains.ts';
import { sourceVisibility } from './chunk-sources.ts';
import { ConvertPool } from './convert-pool.ts';
import {
	type EnvironmentPlan,
	finishEnvironments,
	type LevelEnvironmentDebug,
	planEnvironments,
} from './environments.ts';
import { mayBeClamped, resolveClampedHlodCell } from './hlod-cells.ts';
import { type InstanceInput, InstanceBlockBuilder } from './instances.ts';
import { type IrradianceReport, packIrradiance } from './irradiance.ts';
import { LightCollector } from './lights.ts';
import { type CacheReport, PackCache } from './pack-cache.ts';
import { ParticleTable } from './particles.ts';
import { PhaseTimer } from './phase-timer.ts';
import { packTerrain as packTerrainStep } from './terrain.ts';
import { TileTreeBuilder } from './tile-tree.ts';
import { finishWater, planWater, type WaterDebug, type WaterPlan } from './water.ts';

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
	/** zstd level of instance, terrain and geometry blobs */
	zstdLevel: number;
	/** zstd level of texture blobs */
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
	/** environment profiles, the textures they reference, and what each level resolved to */
	environments: { profiles: number; textures: number; levels: LevelEnvironmentDebug[] };
	/** water surfaces in the scene and packed, configs, the global config's name, sectors and maps */
	water: Pick<WaterDebug, 'surfaces' | 'global' | 'sectors'> & {
		configs: number;
		textures: number;
		/** assets that failed to load, listed in `debug/water.json` */
		errors: number;
	};
	hlod: { clusters: number; tierCounts: number[]; nameMatchesPosition: number };
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

/** HLOD cluster entity names: `HLOD<tier>_<i>_<j>_Cluster_<hash>_<n>…`, `i`/`j` being the tier's grid cell */
const HLOD_NAME = /^HLOD(\d)_(-?\d+)_(-?\d+)_Cluster_/;

/** an HLOD cluster entity waiting for its cell */
interface HlodCluster {
	/** level tag */
	tag: number;
	tier: number;
	/** the cell in its name */
	named: TileKey;
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
export const packScene = async (
	context: Pick<Context, 'config' | 'keys' | 'vfs' | 'world' | 'resolver'>,
	options: PackOptions,
): Promise<PackReport> => {
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
			uses: new AssetPlacement(scene.grid.shardLevel),
			assetArchives: new AssetArchives(),
			shardTiles: new Map(),
		};

		const entities = await collectEntities(context, pack);
		timer.end('entities');

		const terrainPacked = await packTerrain(context, pack);
		timer.end('terrain');

		// independent; only water interns geometries, so ids stay deterministic
		const [environments, water] = await Promise.all([
			planEnvironments(
				context,
				options.scene,
				scene.partition?.levels ?? [],
				defaultSceneStates(scene.sceneStates, scene.game),
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
				placeSector: (rect) =>
					tileAt(scene.grid, scene.grid.shardLevel, (rect.minX + rect.maxX) / 2, (rect.minZ + rect.maxZ) / 2),
			}),
		]);
		timer.end('environments and water');
		const lights = gateByScene(entities.collected, scene, environments, water, entities.lights);
		entities.counts.lights = lights.lights.length;
		for (const [reason, count] of Object.entries(entities.lights.skipped)) {
			entities.counts[`lightsSkipped ${reason}`] = count;
		}

		const irradiance = await packIrradiance(context.vfs, store, cache, {
			scene: options.scene,
			includes: (x, z) =>
				scene.subset.info === null ||
				scene.subset.includesTile(tileAt(scene.grid, scene.grid.cellLevel, x, z)),
		});
		timer.end('irradiance');

		const extraTextures: PlacedTexture[][] = [
			environments.textures.map((ref) => ({ ref, place: null })),
			water.textures,
		];

		// spooled, so a failed pack leaves nothing outside the package's own entries
		const debugLog = await DebugLog.create(join(spool, 'instances.jsonl'));
		const instances = await packInstances(pack, entities.collected, debugLog);
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

		const states = await sceneStates(context.world, scene, entities.collected, environments.levels);
		timer.end('states');

		const [environmentTextureIds, waterTextureIds] = assetTables.extraTextureIds;
		const written = await writePackage(
			pack,
			assetTables,
			{ dir: stage, previous },
			{
				...states,
				...finishEnvironments(environments, environmentTextureIds),
				water: finishWater(water, waterTextureIds),
				lights,
				irradiance: irradiance?.table ?? { keys: new Uint32Array(), blobs: new Uint32Array() },
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
			environments: environments.debug,
			water: water.debug,
			unsupportedInteractives: entities.unsupportedInteractives,
			unsupportedPrefabs: entities.unsupportedPrefabs,
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
				shaders: assetTables.materials.shaders.length,
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
				profiles: environments.profiles.length,
				textures: environments.textures.length,
				levels: environments.debug,
			},
			water: {
				surfaces: water.debug.surfaces,
				configs: water.table.configs.length,
				global: water.debug.global,
				sectors: water.debug.sectors,
				textures: water.textures.length,
				errors: water.debug.errors.length,
			},
			hlod: {
				clusters: instances.hlodClusters,
				tierCounts: instances.tierCounts,
				nameMatchesPosition: entities.hlodNameMatches / Math.max(1, instances.hlodClusters),
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

/** tree parameters before the tree is built */
type TreeGrid = Omit<TreeInfo, 'nodeCount' | 'refCount'>;

/** what setup learns about the scene */
interface SceneIndex {
	options: PackOptions;
	names: Map<string, string>;
	partition: LevelPartition | undefined;
	terrainScene: TerrainSceneIndex | undefined;
	surface: TerrainSurfacesData | undefined;
	/** the manifest's terrain section without its levels, or `null` without terrain */
	terrain: Omit<TerrainInfo, 'levels' | 'splat'> | null;
	grid: TreeGrid;
	subset: Subset;
	/** the scene's chunk files in processing order; debug rows index into it */
	files: ChunkFile[];
	/** the MapConfig's scene states, their conditions noted in {@link game} */
	sceneStates: SceneStateDefinition[];
	/** the quests, missions and variables the scene's conditions read */
	game: GameState;
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
	const [pathOf, bundleManifest, names, partition, terrainIndex, surface, chunkFiles, sceneStates] =
		await Promise.all([
			world.pathLookup(),
			world.manifest(),
			world.names(),
			world.partition(options.scene),
			indexTerrain(context.vfs),
			loadTerrainSurfacesData(context, options.scene),
			world.chunkFiles(),
			loadSceneStates(world, options.scene),
		]);
	const game = new GameState();
	game.note(sceneStates.flatMap(({ condition }) => (condition === null ? [] : [condition])));
	const terrainScene = terrainIndex.get(options.scene);
	if (terrainScene !== undefined && surface === undefined) {
		throw new Error(`${options.scene} has terrain tiles but no HGTerrainSurfacesData`);
	}
	const grid = treeGrid(surface);
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
						position: [surface.position.x, surface.position.y, surface.position.z],
						heightScale: surface.heightScale,
						terrainSize: surface.terrainSize,
						pageSize: TERRAIN_HEIGHT_PAGE_SIZE,
						holeBit: TERRAIN_HEIGHT_HOLE,
						surfaceSize: TERRAIN_PAGE_SIZE,
						surfaceBorder: TERRAIN_PAGE_BORDER,
					},
		grid,
		subset: buildSubset(options, partition, grid),
		files: chunkFiles
			.filter((file) => file.scene === options.scene)
			// always-loaded files first, then scene states; the default area before stream areas: a fixed order
			// for the first-wins dedupe, in which an entity of an always-loaded file stays unconditional
			.toSorted(
				(a, b) =>
					Number(a.sceneState !== 0) - Number(b.sceneState !== 0) ||
					Number(a.area !== 0) - Number(b.area !== 0) ||
					(a.name < b.name ? -1 : 1),
			),
		sceneStates,
		game,
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
}> => {
	const { scene } = pack;
	const { world } = context;
	const { grid, subset } = scene;
	const collected = new Collector();
	const lights = new LightCollector();
	const counts: Record<string, number> = {
		read: 0,
		unique: 0,
		noRenderer: 0,
		decal: 0,
		noMatrix: 0,
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
	/** per geometry id: whether its path names a card mesh */
	const cards: boolean[] = [];
	let hlodNameMatches = 0;
	/** HLOD clusters whose names may have clamped a coordinate */
	const clampedHlod: HlodCluster[] = [];
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
		const condition = visibility === null ? null : collected.condition(visibility);
		if (hlod !== null && !stateGated) {
			const tier = Number(hlod[1]);
			const named = { level: grid.hlodLevels[tier], x: Number(hlod[2]), z: Number(hlod[3]) };
			const cluster = { tag, tier, named, row, name, file, condition };
			if (mayBeClamped(named)) {
				// resolved once every detail instance is known
				clampedHlod.push(cluster);
			} else {
				addHlod(cluster, named);
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
			collected.addConditional(tag, key, row, name, visibility, file);
		} else {
			collected.addDetail(tag, condition, key, row, name, file);
			getOrInsert(detailBounds, `${tileId(key)}/${tag}`, () => []).push(row.bounds);
		}
		pack.uses.note(row.chain, key);
	};

	const chainDraw = (draw: RendererDraw, hlod: boolean): ChainDraw => {
		const geometry = pack.geometries.intern(draw.meshHash, scene.pathOf);
		cards[geometry] ??= pack.geometries.get(geometry).path?.toLowerCase().includes('_cardmesh') ?? false;
		let role: DrawRole = DrawRole.Lit;
		if (hlod) {
			role = DrawRole.Hlod;
		} else if ((draw.flags & DrawFlags.ShadowOnly) !== 0) {
			role = DrawRole.ShadowOnly;
		} else if (cards[geometry]) {
			role = DrawRole.Card;
		}
		return {
			geometry,
			material: pack.materials.intern(draw.materialHash, scene.pathOf),
			submesh: draw.submesh,
			lod: draw.lod,
			role,
			minSquared: draw.lodMinSquared,
			maxSquared: draw.lodMaxSquared,
			sourceFlags: draw.flags,
			particles: null,
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
				if (entity.renderer === null) {
					counts.noRenderer++;
					continue;
				}
				if (entity.decal) {
					counts.decal++;
					continue;
				}
				if (entity.matrix === null) {
					counts.noMatrix++;
					continue;
				}
				const bounds: Aabb = entity.bounds ?? {
					center: [entity.matrix[12], entity.matrix[13], entity.matrix[14]],
					extents: [0, 0, 0],
				};
				const [x, , z] = bounds.center;
				if (!subset.includesEntity(entity.levelTag, x, z)) {
					counts.excluded++;
					continue;
				}
				counts.packed++;

				const hlod = HLOD_NAME.exec(entity.name);
				const draws = entity.renderer.draws.map((draw) => chainDraw(draw, hlod !== null));
				const row: InstanceInput = {
					chain: pack.chains.intern(entity.renderer.lodCount, draws),
					matrix: entity.matrix,
					bounds,
					entityId: entity.id,
				};

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
				collected.noteOwner(entity.levelTag, bounds);
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
					const chain = pack.chains.intern(
						cluster.renderer.lodCount,
						cluster.renderer.draws.map((draw) => chainDraw(draw, false)),
					);
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
		const visibility = collected.sourceVisibility(sources);
		// HLOD clusters stand in for the rows of their own area, so area-only content keeps HLOD refinement;
		// scene-state content has no HLODs and streams as conditional detail
		const stateGated = visibility !== null && sources.some((source) => source.sceneState !== 0);
		for (const row of rows) {
			addRow({ row, tag, name, file, global, hlod, visibility, stateGated });
		}
	}
	for (const cluster of clampedHlod) {
		const key = resolveClampedHlodCell({
			tree: grid,
			leafLevel: grid.leafLevel,
			named: cluster.named,
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
	collected.controls = dynamic.controls;
	for (const index of dynamic.sceneStates) {
		collected.sceneStates.add(index);
	}
	const addStructure = (
		row: InstanceInput,
		tag: number,
		name: string,
		visibility: ConditionalSetInfo,
	): void => {
		const [x, , z] = row.bounds.center;
		const key = tileAt(grid, grid.leafLevel, x, z);
		collected.addConditional(tag, key, row, name, visibility, -1);
		collected.noteOwner(tag, row.bounds);
		pack.uses.note(row.chain, key);
		counts.dynamicRenderers++;
	};
	for (const { entity, visibility } of dynamic.entities) {
		if (
			seen.has(entity.id) ||
			entity.renderer === null ||
			entity.matrix === null ||
			entity.bounds === null ||
			entity.decal
		) {
			continue;
		}
		seen.add(entity.id);
		const [x, , z] = entity.bounds.center;
		if (!subset.includesEntity(entity.levelTag, x, z)) {
			continue;
		}
		addStructure(
			{
				chain: pack.chains.intern(
					entity.renderer.lodCount,
					entity.renderer.draws.map((draw) => chainDraw(draw, false)),
				),
				matrix: entity.matrix,
				bounds: entity.bounds,
				entityId: entity.id,
			},
			entity.levelTag,
			entity.name,
			visibility,
		);
	}
	const facilities = await loadInteractiveFacilities(
		context,
		scene.options.scene,
		scene.options.level,
		scene.partition,
	);
	counts.interactiveFacilities = facilities.progressions.length;
	collected.facilities = facilities.progressions;
	counts.unsupportedInteractiveFiles = facilities.unsupported.length;
	const resolver = await context.resolver();
	const prefabs = new Map<bigint, Promise<PrefabRenderer[]>>();
	const unsupportedPrefabs: { path: string; reason: string }[] = [];
	let modelId = 0;
	for (const placement of [...dynamic.models, ...facilities.models]) {
		const { model, levelTag } = placement;
		// ownership filters can reject a prefab before any of its bundles are read.
		if (
			scene.options.level !== null &&
			!subset.includesEntity(levelTag, model.position[0], model.position[2])
		) {
			continue;
		}
		let prefab = prefabs.get(model.pathHash);
		if (prefab === undefined) {
			const paths = [
				...new Set(
					resolver.manifest.findAssets(model.pathHash).map((asset) => resolver.manifest.assetPath(asset)),
				),
			];
			const label = paths.length === 1 ? paths[0] : `0x${model.pathHash.toString(16)}`;
			// one malformed prefab skips its placements instead of failing the scene
			prefab = (async () => {
				if (paths.length !== 1) {
					throw new FormatError(`prefab has ${paths.length} manifest paths`);
				}
				const root = await resolver.findUnique(
					{ hash: model.pathHash, path: paths[0] },
					UnityClass.GameObject,
				);
				return readPrefabRenderers(resolver, root);
			})().catch((error: unknown) => {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				unsupportedPrefabs.push({ path: label, reason: error.message });
				return [];
			});
			prefabs.set(model.pathHash, prefab);
		}
		const rootMatrix = trsMatrix(model.position, unityEulerQuaternion(model.rotation), model.scale);
		// oxlint-disable-next-line no-await-in-loop -- stable asset ids and bounded bundle cache
		for (const renderer of await prefab) {
			const matrix = multiplyMatrices(rootMatrix, renderer.matrix);
			const bounds = transformBounds(renderer.bounds, matrix);
			if (!subset.includesEntity(levelTag, bounds.center[0], bounds.center[2])) {
				continue;
			}
			const geometry =
				renderer.pose === null
					? pack.geometries.internObject(renderer.mesh)
					: pack.geometries.internPosedObject(renderer.mesh, renderer.pose);
			const draws: ChainDraw[] = renderer.materials.flatMap((material, index): ChainDraw[] => {
				if (material === null) {
					return [];
				}
				return [
					{
						geometry,
						material: pack.materials.internObject(material),
						submesh: Math.min(index, renderer.submeshes - 1),
						lod: 0,
						role: renderer.shadowOnly ? DrawRole.ShadowOnly : DrawRole.Lit,
						minSquared: -1,
						maxSquared: 3.4028234663852886e38,
						sourceFlags: renderer.shadowOnly ? DrawFlags.ShadowOnly : 0,
						particles: renderer.particles === null ? null : pack.particles.intern(renderer.particles),
					},
				];
			});
			if (draws.length === 0) {
				continue;
			}
			addStructure(
				{
					chain: pack.chains.intern(1, draws),
					matrix,
					bounds,
					entityId: syntheticEntityId(levelTag, modelId++),
				},
				levelTag,
				renderer.name,
				placement.visibility,
			);
		}
	}
	counts.unsupportedPrefabs = unsupportedPrefabs.length;
	return {
		collected,
		lights,
		counts,
		hlodNameMatches,
		unsupportedInteractives: facilities.unsupported,
		unsupportedPrefabs,
	};
};

/**
 * gives environment volumes, water surfaces and lights their visibility groups (their level, and the scene
 * states of the files holding them), and adds the scene state controls: one per MapConfig state, derived from
 * its condition, plus any state an expression requires that the MapConfig doesn't name
 *
 * @param collected the entity pass's collector; its conditions, groups and controls are extended
 * @param scene the scene's MapConfig states and game state
 * @param environments planned environments; volume groups are filled in
 * @param water planned water; surface groups are filled in
 * @param lights the entity pass's lights
 * @returns the lights table
 */
const gateByScene = (
	collected: Collector,
	scene: Pick<SceneIndex, 'sceneStates' | 'game'>,
	environments: EnvironmentPlan,
	water: WaterPlan,
	lights: LightCollector,
): LightsTable => {
	for (const [i, volume] of environments.volumes.entries()) {
		const { levelTag, sceneStates } = environments.volumeOwners[i];
		volume.group = collected.groupOfStates(levelTag, sceneStates);
	}
	for (const [i, surface] of water.table.surfaces.entries()) {
		const { levelTag, sources } = water.surfaceOwners[i];
		surface.group = collected.groupOfSources(levelTag, sources);
	}
	const lightsTable = lights.finish((levelTag, sources) => collected.groupOfSources(levelTag, sources));
	const controls = sceneStateControls(scene.sceneStates, scene.game, (formula) =>
		collected.condition(formula),
	);
	const named = new Set(controls.map((control) => control.id));
	const unnamed = [...collected.sceneStates]
		.filter((index) => !named.has(sceneStateControl(index)))
		.toSorted((a, b) => a - b)
		.map(unnamedSceneStateControl);
	collected.controls = [...collected.controls, ...controls, ...unnamed];
	return lightsTable;
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

/**
 * stores the subset's terrain (see `terrain.ts`) and attaches its pages to the tree
 *
 * @returns the levels that have height pages, ascending, and the detail section, `null` when the scene's
 *   layers can't be packed
 */
const packTerrain = async (
	context: Pick<Context, 'vfs' | 'world' | 'resolver'>,
	pack: PackState,
): Promise<{ levels: number[]; splat: TerrainSplatInfo | null }> => {
	const { terrainScene, surface, terrain, subset, grid } = pack.scene;
	if (terrainScene === undefined || surface === undefined || terrain === null) {
		return { levels: [], splat: null };
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
	const whole = { tier: 0, group: SHARED_GROUP, first: 0, count: 1 };
	for (const tile of packed.tiles) {
		const { key } = tile;
		pack.builder.addRef(
			key,
			{ ...whole, kind: ContentKind.TerrainHeights, blob: tile.heights, param: tile.maxHeightError },
			NodeFlags.HasTerrain,
		);
		pack.builder.extend(key, tile.bounds);
		if (tile.surface !== null) {
			pack.builder.addRef(
				key,
				{ ...whole, kind: ContentKind.TerrainSurface, blob: tile.surface, param: 0 },
				0,
			);
		}
		if (tile.splat !== null) {
			pack.builder.addRef(key, { ...whole, kind: ContentKind.TerrainSplat, blob: tile.splat, param: 0 }, 0);
		}
	}
	return { levels: packed.levels, splat: packed.splat };
};

/** the archive holding the terrain layer textures, which every splat page draws from */
const TERRAIN_LAYER_STEM = 'assets/terrain-layers';

/** stores every instance block, attaching detail and HLOD blocks to the tree */
const packInstances = async (
	pack: PackState,
	collected: Collector,
	debugLog: DebugLog,
): Promise<{
	rows: PackReport['instances'];
	global: ContentRef[];
	hlodClusters: number;
	tierCounts: number[];
}> => {
	const { store, builder, scene } = pack;
	const rows = {
		detail: countRows(collected.detail.values()),
		hlod: countRows(collected.hlod.values()),
		global: countRows(collected.global.values()),
	};

	const detailGroups = [...collected.detail.values()].toSorted(
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
				options: placement(BlobKind.Instances, archiveForTile(pack, group.key)),
			})),
		);
		for (const [i, { group, block, order }] of encoded.entries()) {
			builder.addRef(
				group.key,
				{
					kind: group.conditional ? ContentKind.Conditional : ContentKind.Detail,
					tier: 0,
					group: group.visibility,
					blob: blobs[i],
					first: 0,
					count: group.rows.length,
					param: 0,
				},
				NodeFlags.HasDetail,
			);
			builder.extend(group.key, group.bounds!);
			// oxlint-disable-next-line no-await-in-loop -- lines go out in block order
			await debugLog.block(store.hashOf(blobs[i]), group, block, order);
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
				options: placement(BlobKind.Instances, CORE_ARCHIVE),
			})),
		);
		for (const [i, { group, block, order }] of encoded.entries()) {
			// oxlint-disable-next-line no-await-in-loop -- lines go out in block order
			await debugLog.block(store.hashOf(blobs[i]), group, block, order);
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
			builder.addRef(
				node.key,
				{
					kind: ContentKind.Hlod,
					tier: node.tier,
					group: visibility,
					blob,
					first,
					count: end - first,
					param: 0,
				},
				NodeFlags.HasHlod,
			);
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
		param: 0,
	}));
	return { rows, global, hlodClusters, tierCounts };
};

/** the manifest's levels and scenery states */
interface SceneStateInfo extends StatesInfo {
	levels: LevelInfo[];
}

const sceneStates = async (
	world: WorldIndex,
	scene: SceneIndex,
	collected: Collector,
	/** per partition level: its index into the manifest's environments */
	environments: readonly (number | null)[],
): Promise<SceneStateInfo> => {
	const { partition } = scene;
	const progressions = (await loadProgressions(world, scene.options.scene)).map((progression) =>
		progressionControl(
			progression.kind,
			progressionId(progression.kind, progression.key),
			progression.key,
			progression.levels,
			progression.defaultLevel,
			'the lowest authored level',
		),
	);
	const levels = (partition?.levels ?? []).map((level, i) =>
		levelInfo(level, scene, collected, environments[i] ?? null),
	);
	const states: StatesInfo = {
		// quests, missions and variables first: scene states derive from them
		controls: [...scene.game.controls(), ...progressions, ...collected.facilities, ...collected.controls],
		conditionalSets: collected.conditions,
		groups: collected.groups,
		streamAreas: await streamAreasInfo(world, scene.options.scene, collected.areas),
	};
	return { levels, ...states, controls: finishControls(states) };
};

/**
 * fills in each required control's level tags (those of what it gates) and, for derived controls, the default
 * its formula gives under the other defaults; the controls are modified in place
 *
 * @param states every control the scene defined, inputs before the controls derived from them
 * @returns the controls some visibility group requires, directly or through a derived control
 * @throws {Error} if two controls share an id or a requirement names no control
 */
const finishControls = (states: StatesInfo): SceneControl[] => {
	const byId = new Map<string, SceneControl>();
	for (const control of states.controls) {
		if (byId.has(control.id)) {
			throw new Error(`duplicate scene control ${control.id}`);
		}
		byId.set(control.id, control);
	}
	const tags = new Map<string, Set<number>>();
	const note = (set: number, levelTags: Iterable<number>): void => {
		for (const requirements of states.conditionalSets[set].alternatives) {
			for (const { control } of requirements) {
				if (control.startsWith('area:')) {
					continue;
				}
				if (!byId.has(control)) {
					throw new Error(`a visibility expression requires unknown control ${control}`);
				}
				const current = getOrInsert(tags, control, () => new Set<number>());
				for (const tag of levelTags) {
					current.add(tag);
				}
			}
		}
	};
	for (const { levelTag, condition } of states.groups) {
		if (condition !== null) {
			note(condition, [levelTag]);
		}
	}
	// derived controls come after their inputs, so walking backwards reaches a chain's inputs last
	for (const control of states.controls.toReversed()) {
		const gated = tags.get(control.id);
		if (control.derived !== null && gated !== undefined) {
			note(control.derived, gated);
		}
	}
	const used = states.controls.filter((control) => tags.has(control.id));
	for (const control of used) {
		control.levelTags = [...tags.get(control.id)!].toSorted((a, b) => a - b);
	}
	const values = resolveSceneValues({ ...states, controls: used }, {});
	for (const control of used) {
		if (control.derived !== null) {
			control.default = values[control.id];
		}
	}
	return used;
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
		areas: [...areas].toSorted((a, b) => a - b),
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
		environments: EnvironmentProfile[];
		environmentPhases: EnvironmentPhaseInfo[];
		environmentVolumes: EnvironmentVolumeInfo[];
		heightFogFlowNoise: number | null;
		water: WaterTable;
		lights: LightsTable;
		irradiance: IrradianceTable;
		global: ContentRef[];
		terrainLevels: number[];
		terrainSplat: TerrainSplatInfo | null;
	},
): Promise<{ tree: Tree; coreMembers: Record<string, number>; archives: PackReport['archives'] }> => {
	const { scene, store } = pack;
	const { options, grid } = scene;
	const tree = pack.builder.build((key) => (grid.rootSize / 2 ** key.level) * ERROR_PER_EDGE);
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
	]);

	const stems = new Map([
		[CORE_ARCHIVE, CORE_ARCHIVE],
		...store.archives().map(({ name, stem }): [string, string] => [name, stem]),
	]);
	const archiveNames = [...stems.keys()];
	const blobsBin = encodeBlobTable(store.records(archiveNames));
	const [written, [geometries, materials, textures, water, lights, particles]] = await Promise.all([
		store.writeArchives(dir, previous),
		tablesReady,
	]);
	const tables = { geometries, materials, textures, water, lights, particles };

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
		irradianceBin,
	]) {
		generation.update(part);
	}
	const archives = archiveNames.map((name): ArchiveInfo => {
		const archive = written.get(name);
		const { role, tile } = archivePlacement(pack, stems.get(name)!);
		return {
			name,
			role,
			tile,
			size: archive?.size ?? null,
			dataOffset: archive?.dataOffset ?? null,
		};
	});
	const manifest: PackageManifest = {
		format: PACKAGE_FORMAT,
		version: PACKAGE_VERSION,
		generation: generation.digest('hex').slice(0, 32),
		scene: { id: options.scene, name: scene.names.get(options.scene) ?? null },
		coordinates: COORDINATE_CONVENTIONS,
		tree: { ...grid, nodeCount: tree.nodes.length, refCount: tree.refs.length },
		terrain:
			scene.terrain === null
				? null
				: { ...scene.terrain, levels: states.terrainLevels, splat: states.terrainSplat },
		levels: states.levels,
		environments: states.environments,
		environmentPhases: states.environmentPhases,
		environmentVolumes: states.environmentVolumes,
		heightFogFlowNoise: states.heightFogFlowNoise,
		states: {
			controls: states.controls,
			conditionalSets: states.conditionalSets,
			groups: states.groups,
			streamAreas: states.streamAreas,
		},
		archives,
		global: states.global,
		subset: scene.subset.info,
		source: scene.source,
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
const treeGrid = (surface: TerrainSurfacesData | undefined): TreeGrid => {
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
		// HLOD0 cells are 64 m, doubling per tier (checked against cluster positions in the pack report)
		hlodLevels: [leafLevel, leafLevel - 1, leafLevel - 2],
		shardLevel: Math.max(0, leafLevel - 3),
	};
};

interface Subset {
	info: SubsetInfo | null;
	includesEntity(tag: number, x: number, z: number): boolean;
	includesTile(key: TileKey): boolean;
}

const buildSubset = (options: PackOptions, partition: LevelPartition | undefined, grid: TreeGrid): Subset => {
	let level: PartitionLevel | undefined;
	if (options.level !== null) {
		level = partition?.levels.find((candidate) => candidate.id === options.level);
		if (level === undefined) {
			throw new Error(`${options.level} isn't a level of ${options.scene}`);
		}
	}
	const { bounds } = options;
	// tiles at or above the cell level that touch one of the level's cells
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
const cellTile = (grid: TreeGrid, cell: { x: number; z: number }): TileKey =>
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

/** @returns the role and tile of an archive group, as recorded when its stem was handed out */
const archivePlacement = (pack: PackState, stem: string): Pick<ArchiveInfo, 'role' | 'tile'> => {
	if (stem === CORE_ARCHIVE) {
		return { role: 'core', tile: null };
	}
	if (stem.startsWith('irradiance/')) {
		return { role: 'irradiance', tile: null };
	}
	const shard = pack.shardTiles.get(stem);
	if (shard !== undefined) {
		return { role: 'shards', tile: shard };
	}
	return { role: 'assets', tile: pack.assetArchives.tileOf(stem) ?? null };
};

const placement = (kind: BlobKind, stem: string): PutOptions => ({ kind, compress: true, stem });

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

/** a block of detail rows: one leaf, one visibility group */
interface DetailGroup extends Group {
	key: TileKey;
	/** index into the visibility groups */
	visibility: number;
	/** whether HLODs don't stand in for the rows (scene-state and dynamic content) */
	conditional: boolean;
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

	readonly groups: VisibilityGroup[] = [];
	readonly #groupIds = new Map<string, number>();

	constructor() {
		this.group(0, null);
	}

	/**
	 * @param levelTag the owning level's tag, 0 for shared content
	 * @param condition index into {@link conditions}, or `null` for content that always loads
	 * @returns the visibility group's index, shared by equal owners and conditions
	 */
	group(levelTag: number, condition: number | null): number {
		return getOrInsert(this.#groupIds, `${levelTag}/${condition}`, () => {
			this.groups.push({ levelTag, condition });
			return this.groups.length - 1;
		});
	}

	/**
	 * @param levelTag the owning level's tag
	 * @param states MapConfig scene state indices that load the content; empty when it always loads
	 * @returns the visibility group of content loading with any of them
	 */
	groupOfStates(levelTag: number, states: readonly number[]): number {
		return this.group(levelTag, states.length === 0 ? null : this.condition(this.stateVisibility(states)));
	}

	/**
	 * @param sources the chunk files holding some content
	 * @returns when it loads (see {@link sourceVisibility}), noting the scene states and stream areas it needs
	 */
	sourceVisibility(sources: readonly ChunkSource[]): ConditionalSetInfo | null {
		const visibility = sourceVisibility(sources);
		if (visibility !== null) {
			for (const { sceneState, area } of sources) {
				if (sceneState !== 0) {
					this.sceneStates.add(sceneState - 1);
				}
				if (area !== 0) {
					this.areas.add(area);
				}
			}
		}
		return visibility;
	}

	/**
	 * @param levelTag the owning level's tag
	 * @param sources the chunk files holding the content
	 * @returns the visibility group of content loading with any of those files
	 */
	groupOfSources(levelTag: number, sources: readonly ChunkSource[]): number {
		const visibility = this.sourceVisibility(sources);
		return this.group(levelTag, visibility === null ? null : this.condition(visibility));
	}

	/**
	 * adds a row HLODs stand in for
	 *
	 * @param condition index into {@link conditions} for rows of a stream area, else `null`
	 */
	addDetail(
		level: number,
		condition: number | null,
		key: TileKey,
		row: InstanceInput,
		name: string,
		file: number,
	): void {
		this.#addDetail(this.group(level, condition), false, key, row, name, file);
		this.#countInstance(level);
	}

	#addDetail(
		visibility: number,
		conditional: boolean,
		key: TileKey,
		row: InstanceInput,
		name: string,
		file: number,
	): void {
		const group = getOrInsert(this.detail, `${tileId(key)}/${visibility}`, () => ({
			...newGroup(),
			key,
			visibility,
			conditional,
		}));
		push(group, row, 0, name, file);
	}

	readonly conditions: ConditionalSetInfo[] = [];
	/** script, logic and scene state controls */
	controls: SceneControl[] = [];
	/** facility form and resource node controls */
	facilities: SceneControl[] = [];
	/** MapConfig scene state indices some visibility expression requires */
	readonly sceneStates = new Set<number>();
	/** stream areas some visibility expression requires */
	readonly areas = new Set<number>();
	readonly #conditionIds = new Map<string, number>();

	/**
	 * @param indices MapConfig scene state indices
	 * @returns visibility while any of them is active
	 */
	stateVisibility(indices: readonly number[]): ConditionalSetInfo {
		for (const index of indices) {
			this.sceneStates.add(index);
		}
		return { alternatives: indices.map((index) => [{ control: sceneStateControl(index), mask: 2 }]) };
	}

	addConditional(
		level: number,
		key: TileKey,
		row: InstanceInput,
		name: string,
		visibility: ConditionalSetInfo,
		file: number,
	): void {
		this.#addDetail(this.group(level, this.condition(visibility)), true, key, row, name, file);
		this.#countInstance(level);
	}

	/**
	 * @param visibility a visibility expression
	 * @returns its index in {@link conditions}, shared by equivalent expressions
	 */
	condition(visibility: ConditionalSetInfo): number {
		// canonical order at both levels, so equivalent expressions share one set
		const alternatives = [
			...new Map(
				visibility.alternatives.map((requirements) => {
					const sorted = requirements.toSorted((a, b) => a.control.localeCompare(b.control));
					return [JSON.stringify(sorted), sorted];
				}),
			),
		]
			.toSorted(([a], [b]) => Number(a > b) - Number(a < b))
			.map(([, requirements]) => requirements);
		const serialized = JSON.stringify(alternatives);
		let condition = this.#conditionIds.get(serialized);
		if (condition === undefined) {
			condition = this.conditions.length;
			this.conditions.push({ alternatives });
			this.#conditionIds.set(serialized, condition);
		}
		return condition;
	}

	/** @param condition index into {@link conditions} for clusters of a stream area, else `null` */
	addHlod(
		level: number,
		condition: number | null,
		tier: number,
		key: TileKey,
		row: InstanceInput,
		name: string,
		file: number,
	): void {
		const group = getOrInsert(this.hlod, this.group(level, condition), newGroup);
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
		push(getOrInsert(this.global, this.group(level, condition), newGroup), row, 0, name, file);
		this.#countInstance(level);
	}

	// HLOD clusters stand in for instances that are counted already
	#countInstance(level: number): void {
		this.tagInstances.set(level, (this.tagInstances.get(level) ?? 0) + 1);
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
	if (group.bounds === null) {
		group.bounds = aabbBounds(row.bounds);
	} else {
		growBounds(group.bounds, row.bounds);
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
	environment: number | null,
): LevelInfo => {
	const { config } = level;
	return {
		id: level.id,
		idNum: level.idNum,
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
	 * @param block the encoded block
	 * @param order per block row, its insertion index in `group`
	 */
	async block(blob: string, group: Group, block: InstanceBlock, order: Uint32Array): Promise<void> {
		const rows = Array.from(order, (i, out): [number, string, number] => [
			block.entityIds[out],
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
		environments: LevelEnvironmentDebug[];
		water: WaterDebug;
		unsupportedInteractives: { path: string; reason: string }[];
		unsupportedPrefabs: { path: string; reason: string }[];
	},
): Promise<void> => {
	const dir = join(outDir, 'debug');
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'environments.json'), json(debug.environments));
	await writeFile(join(dir, 'water.json'), json(debug.water));
	await writeFile(join(dir, 'unsupported-interactives.json'), json(debug.unsupportedInteractives));
	await writeFile(join(dir, 'unsupported-prefabs.json'), json(debug.unsupportedPrefabs));
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
