import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { DrawFlags, type RendererDraw } from '@endfield-noclip/formats/endfield/init-chunk-data';
import type { LevelPartition, PartitionLevel } from '@endfield-noclip/formats/endfield/level-partition';
import { CELL_SIZE } from '@endfield-noclip/formats/endfield/map-config';
import {
	checkTerrainLayerTexture,
	readTerrainBc3Page,
	readTerrainControlPage,
	readTerrainHeightSamples,
	readTerrainTexture,
	readTerrainTintPage,
	TERRAIN_HEIGHT_HOLE,
	TERRAIN_HEIGHT_PAGE_SIZE,
	TERRAIN_LEAF_SIZE,
	TERRAIN_PAGE_BORDER,
	TERRAIN_PAGE_SIZE,
	TERRAIN_SPLAT_CELL,
	terrainLeafLevel,
	terrainNodeIndex,
	type TerrainSurface,
} from '@endfield-noclip/formats/hg/terrain';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import {
	multiplyMatrices,
	transformBounds,
	trsMatrix,
	unityEulerQuaternion,
} from '@endfield-noclip/formats/unity/transform';
import type { Aabb } from '@endfield-noclip/formats/unity/values';
import {
	encodeBlobTable,
	encodeChains,
	encodeDetailPage,
	encodeHeightPage,
	encodeInstanceBlock,
	encodeIrradianceTable,
	encodeSurfacePage,
	encodeTree,
} from '@endfield-noclip/package-format/codec';
import {
	type ArchiveInfo,
	BLOB_KIND_NAMES,
	BlobKind,
	type Bounds,
	type ChainDraw,
	CONTENT_KIND_NAMES,
	ContentKind,
	type ContentRef,
	type ConditionalSetInfo,
	type SceneToggleInfo,
	COORDINATE_CONVENTIONS,
	CORE_ARCHIVE,
	CORE_PATHS,
	DrawRole,
	type EnvironmentPhaseInfo,
	type EnvironmentProfile,
	type EnvironmentVolumeInfo,
	type GeometryTable,
	type InstanceBlock,
	type IrradianceTable,
	isTerrainHole,
	type LevelInfo,
	type LightsTable,
	type MaterialTable,
	NodeFlags,
	PACKAGE_FORMAT,
	PACKAGE_VERSION,
	type PackageManifest,
	type ProgressionInfo,
	type Rect,
	shardArchiveName,
	type SubsetInfo,
	type TerrainDetailInfo,
	type TerrainInfo,
	terrainHeight,
	type TextureTable,
	type TileKey,
	tileAncestor,
	tileAt,
	tileFootprint,
	tileId,
	type Tree,
	type TreeInfo,
	type WaterTable,
} from '@endfield-noclip/package-format/format';

import { getOrInsert } from '../collections.ts';
import type { Context } from '../context.ts';
import { ignoreMissing } from '../errors.ts';
import { loadDynamicStructures } from '../game/dynamic-structures.ts';
import { loadInteractiveFacilities } from '../game/interactive-facilities.ts';
import { readPrefabRenderers, type PrefabRenderer } from '../game/prefab.ts';
import {
	defaultSceneStates,
	loadSceneStateControls,
	sceneStateControl,
	unnamedSceneStateControl,
} from '../game/scene-conditions.ts';
import { loadProgressions, progressionId } from '../game/scenery-variants.ts';
import {
	indexTerrain,
	loadTerrainSplatIndex,
	loadTerrainSurface,
	type TerrainSceneIndex,
} from '../game/terrain-source.ts';
import type { ChunkFile, WorldIndex } from '../game/world-index.ts';
import type { VfsFile } from '../hg/vfs.ts';
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
import { PhaseTimer } from './phase-timer.ts';
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
	instances: { detail: number; hlod: number; resident: number };
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
	archives: { name: string; size: number; headerLength: number; members: number }[];
	totalBytes: number;
	/** cache hits and sweep, or `null` without a cache */
	cache: CacheReport | null;
	/** peak resident set size of the process, bytes */
	peakRss: number;
}

/** asset archives stop growing at this size and continue in a next part */
const ASSET_ARCHIVE_CAP = 1024 ** 3;

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
}

/** files and directories a package consists of; only these are removed when replacing a package */
const PACKAGE_ENTRIES = new Set([CORE_ARCHIVE, 'shards', 'assets', 'irradiance', 'debug', '.spool']);

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
	await checkOutDir(options.outDir);
	// the package is written here and swapped in when complete, so a viewer never reads a partial one
	const stage = siblingDir(options.outDir, 'staging');
	await rm(stage, { recursive: true, force: true });
	await mkdir(stage, { recursive: true });
	const cache = options.cacheDir === null ? null : await PackCache.open(options.cacheDir);
	// scratch space for the debug log, and for blobs when there's no cache to hold them
	const spool = join(stage, '.spool');
	const store = new BlobStore(cache?.blobs ?? new BlobDir(spool), { zstdLevel: options.zstdLevel });
	try {
		const scene = await indexScene(context, options);
		timer.end('setup');

		const pack: PackState = {
			scene,
			store,
			builder: new TileTreeBuilder(scene.grid),
			chains: new ChainTable(),
			geometries: new AssetIds(),
			materials: new AssetIds(),
			uses: new AssetPlacement(scene.grid.shardLevel),
			assetArchives: new AssetArchives(ASSET_ARCHIVE_CAP),
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
				defaultSceneStates(scene.sceneStates),
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
		const lights = gateByScene(entities.collected, scene.sceneStates, environments, water, entities.lights);
		entities.counts.lights = lights.lights.length;
		for (const [reason, count] of Object.entries(entities.lights.skipped)) {
			entities.counts[`lightsSkipped ${reason}`] = count;
		}

		const irradiance = await packIrradiance(context.vfs, store, {
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
		const written = await writePackage(pack, assetTables, stage, {
			...states,
			...finishEnvironments(environments, environmentTextureIds),
			water: finishWater(water, waterTextureIds),
			lights,
			irradiance: irradiance?.table ?? { keys: new Uint32Array(), blobs: new Uint32Array() },
			resident: instances.resident,
			terrainLevels: terrainPacked.levels,
			terrainDetail: terrainPacked.detail,
		});
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
				instancesPerChain: (rows.detail + rows.hlod + rows.resident) / Math.max(1, pack.chains.chains.length),
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
	surface: TerrainSurface | undefined;
	/** the manifest's terrain section without its levels, or `null` without terrain */
	terrain: Omit<TerrainInfo, 'levels' | 'detail'> | null;
	grid: TreeGrid;
	subset: Subset;
	/** the scene's chunk files in processing order; debug rows index into it */
	files: ChunkFile[];
	/** one control per MapConfig scene state, with its story-completed default */
	sceneStates: SceneToggleInfo[];
	pathOf: (hash: bigint) => string | undefined;
	source: PackageManifest['source'];
}

/** what the phases build up */
interface PackState {
	scene: SceneIndex;
	store: BlobStore;
	builder: TileTreeBuilder;
	chains: ChainTable;
	geometries: AssetIds;
	materials: AssetIds;
	uses: AssetPlacement;
	assetArchives: AssetArchives;
	/** shard archive name → its shard-level tile */
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
			loadTerrainSurface(context, options.scene),
			world.chunkFiles(),
			loadSceneStateControls(world, options.scene),
		]);
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
	};
	// stream areas share some entities, and a level is drawn with all of its areas, so one copy is enough
	const seen = new Set<number>();
	// rows of scene-state files, by entity id, with the state ids of every file holding them; added as
	// conditional instances once all files are read
	const stateRows = new Map<
		number,
		{ row: InstanceInput; tag: number; name: string; file: number; states: Set<number> }
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
		collected.addHlod(cluster.tag, cluster.tier, key, cluster.row, cluster.name, cluster.file);
		pack.uses.note(cluster.row.chain, key);
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
					lights.add(light, file.sceneState);
				}
			}
			for (const entity of content.entities) {
				counts.read++;
				if (seen.has(entity.id)) {
					stateRows.get(entity.id)?.states.add(file.sceneState);
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
					sceneState: file.sceneState,
				};

				// HLOD clusters only occur in always-loaded files; scene-state content streams as detail
				if (file.sceneState !== 0) {
					stateRows.set(entity.id, {
						row,
						tag: entity.levelTag,
						name: entity.name,
						file: fileIndex,
						states: new Set([file.sceneState]),
					});
				} else if (hlod !== null) {
					const tier = Number(hlod[1]);
					const named = { level: grid.hlodLevels[tier], x: Number(hlod[2]), z: Number(hlod[3]) };
					const cluster = { tag: entity.levelTag, tier, named, row, name: entity.name, file: fileIndex };
					if (mayBeClamped(named)) {
						// resolved once every detail instance is known
						clampedHlod.push(cluster);
					} else {
						addHlod(cluster, named);
					}
				} else if (file.cell === null) {
					collected.addResident(entity.levelTag, row, entity.name, fileIndex);
					pack.uses.note(row.chain, null);
				} else {
					const key = tileAt(grid, grid.leafLevel, x, z);
					collected.addDetail(entity.levelTag, key, row, entity.name, fileIndex);
					pack.uses.note(row.chain, key);
					getOrInsert(detailBounds, `${tileId(key)}/${entity.levelTag}`, () => []).push(bounds);
				}
				collected.noteOwner(entity.levelTag, bounds);
			}
		},
	);
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
	counts.sceneStateRenderers = stateRows.size;
	for (const { row, tag, name, file, states } of stateRows.values()) {
		const key = tileAt(grid, grid.leafLevel, row.bounds.center[0], row.bounds.center[2]);
		collected.addConditional(
			tag,
			key,
			row,
			name,
			collected.stateVisibility([...states].map((id) => id - 1)),
			file,
		);
		pack.uses.note(row.chain, key);
	}
	const dynamic = await loadDynamicStructures(context, scene.options.scene, scene.partition);
	for (const [key, count] of Object.entries(dynamic.counts)) {
		counts[`dynamic_${key}`] = count;
	}
	counts.dynamicRenderers = 0;
	collected.toggles = dynamic.toggles;
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
				sceneState: 0,
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
					sceneState: 0,
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
 * gives environment volumes, water surfaces and lights of scene-state files their conditions, and puts the
 * scene state controls (one per MapConfig state, plus any state an expression requires that the MapConfig
 * doesn't name) ahead of the other toggles
 *
 * @param collected the entity pass's collector; its conditions and toggles are extended
 * @param controls the MapConfig scene state controls
 * @param environments planned environments; volume conditions are filled in
 * @param water planned water; surface conditions are filled in
 * @param lights the entity pass's lights
 * @returns the lights table
 */
const gateByScene = (
	collected: Collector,
	controls: readonly SceneToggleInfo[],
	environments: EnvironmentPlan,
	water: WaterPlan,
	lights: LightCollector,
): LightsTable => {
	const conditionOf = (states: readonly number[]): number | null =>
		states.length === 0 ? null : collected.condition(collected.stateVisibility(states));
	for (const [i, volume] of environments.volumes.entries()) {
		volume.condition = conditionOf(environments.volumeStates[i]);
	}
	for (const [i, surface] of water.table.surfaces.entries()) {
		surface.condition = conditionOf(water.surfaceStates[i]);
	}
	const lightsTable = lights.finish(conditionOf);
	const named = new Set(controls.map((control) => control.id));
	const unnamed = [...collected.sceneStates]
		.filter((index) => !named.has(sceneStateControl(index)))
		.toSorted((a, b) => a - b)
		.map(unnamedSceneStateControl);
	collected.toggles = [...controls, ...unnamed, ...collected.toggles];
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
 * stores the subset's terrain height pages, baked surface pages and close-up detail and attaches them to the
 * tree. a tile missing its albedo or normal page gets no surface page; a leaf missing its control or tint
 * page gets no detail page
 *
 * @returns the levels that have height pages, ascending, and the detail section, `null` when the scene's
 *   layers can't be packed
 */
const packTerrain = async (
	context: Pick<Context, 'vfs' | 'world' | 'resolver'>,
	pack: PackState,
): Promise<{ levels: number[]; detail: TerrainDetailInfo | null }> => {
	const { terrainScene, surface, terrain, subset, grid } = pack.scene;
	if (terrainScene === undefined || surface === undefined || terrain === null) {
		return { levels: [], detail: null };
	}
	const readTexture = async (file: VfsFile) => readTerrainTexture(await context.vfs.readVerified(file));
	const readPage = async (file: VfsFile): Promise<Uint8Array> => readTerrainBc3Page(await readTexture(file));
	const layers = await packTerrainLayers(context, pack, terrainScene, surface);
	const leafLevel = terrainLeafLevel(surface.terrainSize);
	const indexSide = surface.terrainSize / TERRAIN_SPLAT_CELL;
	const cells = TERRAIN_LEAF_SIZE / TERRAIN_SPLAT_CELL;
	/** the 4 ordinals of a leaf's cells, cut from the scene's index map */
	const leafIndex = (index: Uint8Array, key: TileKey): Uint8Array => {
		const out = new Uint8Array(cells * cells * 4);
		for (let row = 0; row < cells; row++) {
			const from = ((key.z * cells + row) * indexSide + key.x * cells) * 4;
			out.set(index.subarray(from, from + cells * 4), row * cells * 4);
		}
		return out;
	};
	const tiles = [...terrainScene.tiles.values()]
		.filter(({ key }) => subset.includesTile(key))
		.toSorted((a, b) => a.key.level - b.key.level || a.key.z - b.key.z || a.key.x - b.key.x);
	for (let start = 0; start < tiles.length; start += BLOB_BATCH) {
		const batch = tiles.slice(start, start + BLOB_BATCH);
		// oxlint-disable-next-line no-await-in-loop -- batches bound memory and keep blob order stable
		const read = await Promise.all(
			batch.map(async ({ key, file, channels }) => {
				const samples = readTerrainHeightSamples(await readTexture(file));
				let page: Uint8Array | null = null;
				if (channels.A !== undefined && channels.N !== undefined) {
					const [albedo, normal] = await Promise.all([readPage(channels.A), readPage(channels.N)]);
					page = encodeSurfacePage({ side: TERRAIN_PAGE_SIZE, albedo, normal });
				}
				let detail: Uint8Array | null = null;
				if (
					layers !== null &&
					key.level === leafLevel &&
					channels.S !== undefined &&
					channels.T !== undefined
				) {
					const [control, tint] = await Promise.all([readTexture(channels.S), readTexture(channels.T)]);
					detail = encodeDetailPage({
						side: TERRAIN_PAGE_SIZE,
						cells,
						control: readTerrainControlPage(control),
						tint: readTerrainTintPage(tint),
						index: leafIndex(layers.index, key),
					});
				}
				return { samples, page, detail };
			}),
		);
		// oxlint-disable-next-line no-await-in-loop
		const heights = await pack.store.putMany(
			batch.map(({ key }, i) => ({
				raw: encodeHeightPage(read[i].samples, TERRAIN_HEIGHT_PAGE_SIZE),
				options: placement(BlobKind.TerrainHeights, archiveForTile(pack, key)),
			})),
		);
		const withPages = batch.flatMap(({ key }, i) => {
			const page = read[i].page;
			return page === null ? [] : [{ key, page }];
		});
		// oxlint-disable-next-line no-await-in-loop
		const pages = await pack.store.putMany(
			withPages.map(({ key, page }) => ({
				raw: page,
				// block-compressed texels, so the texture level: higher levels barely shrink them
				options: {
					...placement(BlobKind.TerrainSurface, archiveForTile(pack, key)),
					zstdLevel: pack.scene.options.textureZstdLevel,
				},
			})),
		);
		const withDetail = batch.flatMap(({ key }, i) => {
			const detail = read[i].detail;
			return detail === null ? [] : [{ key, detail }];
		});
		// oxlint-disable-next-line no-await-in-loop
		const details = await pack.store.putMany(
			withDetail.map(({ key, detail }) => ({
				raw: detail,
				options: placement(BlobKind.TerrainDetail, archiveForTile(pack, key)),
			})),
		);
		const whole = { tier: 0, level: 0, first: 0, count: 1 };
		for (const [i, { key }] of batch.entries()) {
			const node = surface.nodes?.[terrainNodeIndex(key)];
			pack.builder.addRef(
				key,
				{ ...whole, kind: ContentKind.TerrainHeights, blob: heights[i], param: node?.maxHeightError ?? 0 },
				NodeFlags.HasTerrain,
			);
			pack.builder.extend(key, terrainBounds(grid, terrain, key, read[i].samples));
		}
		for (const [i, { key }] of withPages.entries()) {
			pack.builder.addRef(key, { ...whole, kind: ContentKind.TerrainSurface, blob: pages[i], param: 0 }, 0);
		}
		for (const [i, { key }] of withDetail.entries()) {
			pack.builder.addRef(key, { ...whole, kind: ContentKind.TerrainDetail, blob: details[i], param: 0 }, 0);
		}
	}
	return { levels: [...new Set(tiles.map(({ key }) => key.level))], detail: layers?.info ?? null };
};

/** the archive holding the terrain layer textures, which every detail page draws from */
const TERRAIN_LAYER_ARCHIVE = 'assets/terrain-layers.czar';

/**
 * layer texture levels skipped from the top: the game's 1024² textures repeat every 2–9 m, so 512² still
 * gives 57–230 texels per metre, at a quarter of the size
 */
const TERRAIN_LAYER_SKIP = 1;

/**
 * stores the scene's terrain layer textures and reads its splat index map
 *
 * @returns the manifest's detail section and the index map, or `null` (logged) when the scene's layer table,
 *   index map or textures are missing or disagree
 */
const packTerrainLayers = async (
	context: Pick<Context, 'vfs' | 'world' | 'resolver'>,
	pack: PackState,
	terrainScene: TerrainSceneIndex,
	surface: TerrainSurface,
): Promise<{ info: TerrainDetailInfo; index: Uint8Array } | null> => {
	const log = pack.scene.options.log;
	const scene = pack.scene.options.scene;
	const { layers } = surface;
	if (layers === undefined || layers.length === 0) {
		log(`terrain detail: ${scene} has no terrain layers`);
		return null;
	}
	const index = await loadTerrainSplatIndex(context, { ...surface, layers }, scene);
	if (index === undefined) {
		log(`terrain detail: ${scene} has no splat index map`);
		return null;
	}
	const textureCount = Math.max(...layers.map((layer) => layer.texture)) + 1;
	const files: { D: VfsFile; N: VfsFile }[] = [];
	for (let texture = 0; texture < textureCount; texture++) {
		const diffuse = terrainScene.layers.D.get(texture);
		const normal = terrainScene.layers.N.get(texture);
		if (diffuse === undefined || normal === undefined) {
			log(`terrain detail: ${scene} is missing layer texture ${texture}`);
			return null;
		}
		files.push({ D: diffuse, N: normal });
	}

	let size = 0;
	let levels = 0;
	/** @returns the texture's levels from the first packed one, concatenated */
	const levelsOf = async (file: VfsFile, role: 'D' | 'N'): Promise<Uint8Array | string> => {
		const texture = readTerrainTexture(await context.vfs.readVerified(file));
		checkTerrainLayerTexture(texture, role);
		const kept = texture.mips.slice(TERRAIN_LAYER_SKIP);
		if (kept.length === 0) {
			return `has ${texture.mips.length} levels`;
		}
		if (size === 0) {
			size = kept[0].width;
			levels = kept.length;
		} else if (kept[0].width !== size || kept.length !== levels) {
			return `is ${kept[0].width}² with ${kept.length} levels, unlike the others' ${size}² with ${levels}`;
		}
		const out = new Uint8Array(kept.reduce((sum, mip) => sum + mip.data.length, 0));
		let at = 0;
		for (const mip of kept) {
			out.set(mip.data, at);
			at += mip.data.length;
		}
		return out;
	};
	const raws: Uint8Array[] = [];
	for (const [texture, pair] of files.entries()) {
		for (const role of ['D', 'N'] as const) {
			// oxlint-disable-next-line no-await-in-loop -- one texture's levels at a time bounds memory
			const raw = await levelsOf(pair[role], role);
			if (typeof raw === 'string') {
				log(`terrain detail: ${scene} layer texture ${role} ${texture} ${raw}`);
				return null;
			}
			raws.push(raw);
		}
	}
	const blobs = await pack.store.putMany(
		raws.map((raw) => ({
			raw,
			options: {
				...placement(BlobKind.TerrainLayer, TERRAIN_LAYER_ARCHIVE),
				zstdLevel: pack.scene.options.textureZstdLevel,
			},
		})),
	);
	return {
		index,
		info: {
			cellSize: TERRAIN_SPLAT_CELL,
			layers: layers.map((layer) => ({
				texture: layer.texture,
				tiling: layer.tiling / surface.terrainSize,
				offset: layer.offset,
				meanColour: layer.meanColour,
				normalScale: layer.normalScale,
				diffuseScale: layer.diffuseScale,
				blendBorder: layer.blendBorder,
				height: [layer.maskScale[2], layer.maskOffset[2]],
				occlusion: [layer.maskScale[1], layer.maskOffset[1]],
				roughness: [layer.maskScale[3], layer.maskOffset[3]],
			})),
			textureSize: size,
			textureLevels: levels,
			diffuse: files.map((_, texture) => blobs[texture * 2]),
			normal: files.map((_, texture) => blobs[texture * 2 + 1]),
		},
	};
};

/** stores every instance block, attaching detail and HLOD blocks to the tree */
const packInstances = async (
	pack: PackState,
	collected: Collector,
	debugLog: DebugLog,
): Promise<{
	rows: PackReport['instances'];
	resident: ContentRef[];
	hlodClusters: number;
	tierCounts: number[];
}> => {
	const { store, builder, scene } = pack;
	const rows = {
		detail: countRows(collected.detail.values()),
		hlod: countRows(collected.hlod.values()),
		resident: countRows(collected.resident.values()),
	};

	const detailGroups = [...collected.detail.values()].toSorted(
		(a, b) => a.key.z - b.key.z || a.key.x - b.key.x || a.level - b.level,
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
					kind: group.condition === null ? ContentKind.Detail : ContentKind.Conditional,
					tier: 0,
					level: group.level,
					blob: blobs[i],
					first: 0,
					count: group.rows.length,
					param: group.condition ?? 0,
				},
				NodeFlags.HasDetail,
			);
			builder.extend(group.key, group.bounds!);
			// oxlint-disable-next-line no-await-in-loop -- lines go out in block order
			await debugLog.block(store.hashOf(blobs[i]), group, block, order);
		}
	}

	// HLOD and resident rows form one block per level, in the core
	const coreBlocks = async (groups: Map<number, Group>) => {
		const encoded = [...groups]
			.toSorted((a, b) => a[0] - b[0])
			.map(([level, group]) => {
				const { block, order } = group.rows.toBlock([scene.grid.origin[0], 0, scene.grid.origin[1]]);
				return { level, group, block, order };
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
		return encoded.map(({ level, group, order }, i) => ({ level, group, order, blob: blobs[i] }));
	};

	let hlodClusters = 0;
	const tierCounts = [0, 0, 0];
	for (const { level, group, order, blob } of await coreBlocks(collected.hlod)) {
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
				{ kind: ContentKind.Hlod, tier: node.tier, level, blob, first, count: end - first, param: 0 },
				NodeFlags.HasHlod,
			);
			builder.extend(node.key, node.bounds);
			tierCounts[node.tier] += end - first;
			hlodClusters += end - first;
			first = end;
		}
	}

	const resident = (await coreBlocks(collected.resident)).map(({ level, group, blob }): ContentRef => ({
		kind: ContentKind.Detail,
		tier: 0,
		level,
		blob,
		first: 0,
		count: group.rows.length,
		param: 0,
	}));
	return { rows, resident, hlodClusters, tierCounts };
};

/** the manifest's levels and scenery states */
interface SceneStateInfo {
	levels: LevelInfo[];
	progressions: ProgressionInfo[];
	conditionalSets: ConditionalSetInfo[];
	toggles: SceneToggleInfo[];
}

const sceneStates = async (
	world: WorldIndex,
	scene: SceneIndex,
	collected: Collector,
	/** per partition level: its index into the manifest's environments */
	environments: readonly (number | null)[],
): Promise<SceneStateInfo> => {
	const { partition } = scene;
	const progressions = (await loadProgressions(world, scene.options.scene)).map(
		(progression): ProgressionInfo => ({
			id: progressionId(progression.kind, progression.key),
			kind: progression.kind,
			key: progression.key,
			levelId: progression.levelId,
			levels: progression.levels,
			defaultLevel: progression.defaultLevel,
		}),
	);
	const levels = (partition?.levels ?? []).map((level, i) =>
		levelInfo(level, scene, collected, environments[i] ?? null),
	);
	return {
		levels,
		progressions: [...progressions, ...collected.facilities],
		conditionalSets: collected.conditions,
		toggles: collected.toggles,
	};
};

/** builds the tree and tables, then writes every archive */
const writePackage = async (
	pack: PackState,
	assetTables: AssetTables,
	dir: string,
	states: SceneStateInfo & {
		environments: EnvironmentProfile[];
		environmentPhases: EnvironmentPhaseInfo[];
		environmentVolumes: EnvironmentVolumeInfo[];
		water: WaterTable;
		lights: LightsTable;
		irradiance: IrradianceTable;
		resident: ContentRef[];
		terrainLevels: number[];
		terrainDetail: TerrainDetailInfo | null;
	},
): Promise<{ tree: Tree; coreMembers: Record<string, number>; archives: PackReport['archives'] }> => {
	const { scene, store } = pack;
	const { options, grid } = scene;
	const tree = pack.builder.build((key) => (grid.rootSize / 2 ** key.level) * ERROR_PER_EDGE);
	const treeBin = encodeTree(tree);
	const chainsBin = encodeChains(pack.chains.chains);
	const irradianceBin = encodeIrradianceTable(states.irradiance);
	// zstd-19 takes seconds per table, so they compress on the thread pool while the shards are written
	const tablesReady = Promise.all([
		zstdTable(json({ entries: assetTables.geometries } satisfies GeometryTable)),
		zstdTable(json(assetTables.materials satisfies MaterialTable)),
		zstdTable(json({ entries: assetTables.textures } satisfies TextureTable)),
		zstdTable(json(states.water)),
		zstdTable(json(states.lights)),
	]);

	const shardNames = store
		.archiveNames()
		.filter((name) => name !== CORE_ARCHIVE)
		.toSorted();
	const archiveNames = [CORE_ARCHIVE, ...shardNames];
	const blobsBin = encodeBlobTable(store.records(archiveNames));
	const [written, [geometries, materials, textures, water, lights]] = await Promise.all([
		store.writeShards(dir, CORE_ARCHIVE),
		tablesReady,
	]);
	const tables = { geometries, materials, textures, water, lights };

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
		irradianceBin,
	]) {
		generation.update(part);
	}
	const archives = archiveNames.map((name): ArchiveInfo => {
		const archive = written.get(name);
		const { role, tile } = archivePlacement(pack, name);
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
				: { ...scene.terrain, levels: states.terrainLevels, detail: states.terrainDetail },
		levels: states.levels,
		environments: states.environments,
		environmentPhases: states.environmentPhases,
		environmentVolumes: states.environmentVolumes,
		states: {
			progressions: states.progressions,
			conditionalSets: states.conditionalSets,
			toggles: states.toggles,
		},
		archives,
		resident: states.resident,
		subset: scene.subset.info,
		source: scene.source,
	};
	const core = await store.writeCore(dir, CORE_ARCHIVE, [
		{ path: CORE_PATHS.manifest, data: json(manifest) },
		{ path: CORE_PATHS.tree, data: treeBin },
		{ path: CORE_PATHS.blobs, data: blobsBin },
		{ path: CORE_PATHS.chains, data: chainsBin },
		{ path: CORE_PATHS.geometries, data: tables.geometries },
		{ path: CORE_PATHS.materials, data: tables.materials },
		{ path: CORE_PATHS.textures, data: tables.textures },
		{ path: CORE_PATHS.water, data: tables.water },
		{ path: CORE_PATHS.lights, data: tables.lights },
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
			[CORE_PATHS.irradiance]: irradianceBin.length,
		},
		archives: [core, ...written.values()].map(({ name, size, headerLength, members }) => ({
			name,
			size,
			headerLength,
			members,
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
const treeGrid = (surface: TerrainSurface | undefined): TreeGrid => {
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
 * @returns the archive for a tile's content: the core for tiles coarser than the 128 m cells (the
 *   always-resident coarse layer), else the shard of its {@link TreeInfo.shardLevel} ancestor
 */
const archiveForTile = (pack: PackState, key: TileKey): string => {
	const { grid } = pack.scene;
	if (key.level < grid.cellLevel) {
		return CORE_ARCHIVE;
	}
	const tile = tileAncestor(key, grid.shardLevel);
	const name = shardArchiveName(tile);
	pack.shardTiles.set(name, tile);
	return name;
};

/** @returns an archive's role and tile, as recorded when its name was handed out */
const archivePlacement = (pack: PackState, name: string): Pick<ArchiveInfo, 'role' | 'tile'> => {
	if (name === CORE_ARCHIVE) {
		return { role: 'core', tile: null };
	}
	if (name.startsWith('irradiance/')) {
		return { role: 'irradiance', tile: null };
	}
	const shard = pack.shardTiles.get(name);
	if (shard !== undefined) {
		return { role: 'tiles', tile: shard };
	}
	return { role: 'assets', tile: pack.assetArchives.tileOf(name) ?? null };
};

const placement = (kind: BlobKind, archive: string): PutOptions => ({
	kind,
	compress: true,
	archive: () => archive,
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

/** gathers instances by destination while the entity pass runs */
class Collector {
	/** detail rows by `tileId/levelTag` */
	readonly detail = new Map<string, Group & { key: TileKey; level: number; condition: number | null }>();
	/** HLOD rows by level tag */
	readonly hlod = new Map<number, Group>();
	/** HLOD nodes by sort key */
	readonly hlodNodes = new Map<number, { key: TileKey; tier: number; bounds: Bounds }>();
	/** resident rows by level tag */
	readonly resident = new Map<number, Group>();
	/** packed instance count by level tag, without HLOD clusters */
	readonly tagInstances = new Map<number, number>();
	/** world bounds of packed instances by level tag */
	readonly tagBounds = new Map<number, Bounds>();

	addDetail(level: number, key: TileKey, row: InstanceInput, name: string, file: number): void {
		const id = `${tileId(key)}/${level}`;
		let group = this.detail.get(id);
		if (group === undefined) {
			group = { ...newGroup(), key, level, condition: null };
			this.detail.set(id, group);
		}
		push(group, row, 0, name, file);
		this.#countInstance(level);
	}

	readonly conditions: ConditionalSetInfo[] = [];
	toggles: SceneToggleInfo[] = [];
	facilities: ProgressionInfo[] = [];
	/** MapConfig scene state indices some visibility expression requires */
	readonly sceneStates = new Set<number>();
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
		const condition = this.condition(visibility);
		const id = `${tileId(key)}/${level}/${condition}`;
		let group = this.detail.get(id);
		if (!group) {
			group = { ...newGroup(), key, level, condition };
			this.detail.set(id, group);
		}
		push(group, row, 0, name, file);
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

	addHlod(level: number, tier: number, key: TileKey, row: InstanceInput, name: string, file: number): void {
		const group = getOrInsert(this.hlod, level, newGroup);
		const sortKey = nodeSortKey(key);
		push(group, row, sortKey, name, file);
		const node = this.hlodNodes.get(sortKey);
		if (node === undefined) {
			this.hlodNodes.set(sortKey, { key, tier, bounds: aabbBounds(row.bounds) });
		} else {
			growBounds(node.bounds, row.bounds);
		}
	}

	addResident(level: number, row: InstanceInput, name: string, file: number): void {
		push(getOrInsert(this.resident, level, newGroup), row, 0, name, file);
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

// #region terrain

const terrainBounds = (
	grid: TreeGrid,
	terrain: Omit<TerrainInfo, 'levels' | 'detail'>,
	key: TileKey,
	samples: Uint16Array,
): Bounds => {
	let min = Infinity;
	let max = -Infinity;
	for (const sample of samples) {
		if (!isTerrainHole(terrain, sample)) {
			min = Math.min(min, sample);
			max = Math.max(max, sample);
		}
	}
	const base = terrain.position[1];
	const minY = min === Infinity ? base : terrainHeight(terrain, min);
	const maxY = max === -Infinity ? base : terrainHeight(terrain, max);
	const { minX, minZ, size } = tileFootprint(grid, key);
	return { min: [minX, minY, minZ], max: [minX + size, maxY, minZ + size] };
};

// #endregion

// #region output

/** @throws {Error} unless `outDir` is absent, empty, or holds only a package */
const checkOutDir = async (outDir: string): Promise<void> => {
	const entries = (await ignoreMissing(readdir(outDir), null)) ?? [];
	if (entries.length === 0) {
		return;
	}
	if (!entries.includes(CORE_ARCHIVE)) {
		throw new Error(`${outDir} isn't empty and doesn't hold a package; refusing to replace it`);
	}
	const foreign = entries.filter((entry) => !PACKAGE_ENTRIES.has(entry));
	if (foreign.length > 0) {
		throw new Error(`${outDir} holds files that aren't part of a package: ${foreign.join(', ')}`);
	}
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

/** a `.zst` core member: one zstd frame */
const zstdTable = (data: Uint8Array): Promise<Uint8Array> => zstd(data, 19);

// #endregion
