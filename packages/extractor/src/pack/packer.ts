import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { DrawFlags, type RendererDraw } from '@endfield-noclip/formats/endfield/init-chunk-data';
import type { LevelPartition, PartitionLevel } from '@endfield-noclip/formats/endfield/level-partition';
import { CELL_SIZE } from '@endfield-noclip/formats/endfield/map-config';
import {
	readTerrainHeightSamples,
	readTerrainTexture,
	TERRAIN_HEIGHT_HOLE,
	TERRAIN_HEIGHT_PAGE_SIZE,
	terrainLeafLevel,
	terrainNodeIndex,
	type TerrainSurface,
} from '@endfield-noclip/formats/hg/terrain';
import type { Aabb } from '@endfield-noclip/formats/unity/values';
import {
	encodeBlobTable,
	encodeChains,
	encodeHeightPage,
	encodeInstanceBlock,
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
	COORDINATE_CONVENTIONS,
	CORE_ARCHIVE,
	CORE_PATHS,
	DrawRole,
	type EnvironmentProfile,
	type GeometryTable,
	type InstanceBlock,
	isTerrainHole,
	type LevelInfo,
	type MaterialTable,
	NodeFlags,
	PACKAGE_FORMAT,
	PACKAGE_VERSION,
	type PackageManifest,
	type ProgressionInfo,
	type Rect,
	shardArchiveName,
	type SubsetInfo,
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
import { loadProgressions, progressionId } from '../game/scene-states.ts';
import { indexTerrain, loadTerrainSurface, type TerrainSceneIndex } from '../game/terrain-source.ts';
import type { ChunkFile, WorldIndex } from '../game/world-index.ts';
import { orderedPool } from '../pool.ts';
import { zstdSync } from '../zstd.ts';

import { AssetArchives, AssetPlacement } from './asset-placement.ts';
import {
	type AssetConversion,
	type AssetDebug,
	AssetIds,
	convertAssets,
	pendingAssets,
	type PlacedTexture,
} from './assets.ts';
import { BlobStore, type PutOptions } from './blob-store.ts';
import { aabbBounds, growBounds, squareOverlapsRect } from './bounds.ts';
import { ChainTable } from './chains.ts';
import { finishEnvironments, type LevelEnvironmentDebug, planEnvironments } from './environments.ts';
import { type InstanceInput, InstanceBlockBuilder } from './instances.ts';
import { PhaseTimer } from './phase-timer.ts';
import { TileTreeBuilder } from './tile-tree.ts';
import { finishWater, planWater, type WaterDebug } from './water.ts';

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
	tree: { nodes: number; refs: number; byKind: Record<string, number> };
	blobs: Record<string, { count: number; stored: number; raw: number }>;
	/** byte length of each fixed core member (manifest, tree, tables) */
	coreMembers: Record<string, number>;
	archives: { name: string; size: number; headerLength: number; members: number }[];
	totalBytes: number;
	/** peak resident set size of the process, bytes */
	peakRss: number;
}

/** asset archives stop growing at this size and continue in a next part */
const ASSET_ARCHIVE_CAP = 1024 ** 3;

/** assets decoded concurrently per conversion phase */
const ASSET_CONCURRENCY = 8;

// #endregion

/** HLOD cluster entity names: `HLOD<tier>_<i>_<j>_Cluster_<hash>_<n>…`, `i`/`j` being the tier's grid cell */
const HLOD_NAME = /^HLOD(\d)_(-?\d+)_(-?\d+)_Cluster_/;

/** files and directories a package consists of; only these are removed when replacing a package */
const PACKAGE_ENTRIES = new Set([CORE_ARCHIVE, 'shards', 'assets', 'debug', '.spool']);

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
	context: Pick<Context, 'vfs' | 'world' | 'resolver'>,
	options: PackOptions,
): Promise<PackReport> => {
	const timer = new PhaseTimer(options.log);
	await prepareOutDir(options.outDir);
	const scene = await indexScene(context, options);
	timer.end('setup');

	const spool = join(options.outDir, '.spool');
	const store = new BlobStore(spool, { zstdLevel: options.zstdLevel });
	try {
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

		const entities = await collectEntities(context.world, pack);
		timer.end('entities');

		const terrainLevels = await packTerrain(context, pack);
		timer.end('terrain');

		// independent; only water interns geometries, so ids stay deterministic
		const [environments, water] = await Promise.all([
			planEnvironments(context, options.scene, scene.partition?.levels ?? []),
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
			conversion = await convertAssets({
				resolver: await context.resolver(),
				store,
				geometries: pack.geometries.assets,
				materials: pack.materials.assets,
				chains: pack.chains.chains,
				places,
				extraTextures,
				archives: pack.assetArchives,
				textureZstdLevel: options.textureZstdLevel,
				concurrency: ASSET_CONCURRENCY,
				log: options.log,
			});
			assetTables = conversion;
			timer.adopt(conversion.stats.timings);
		} else {
			assetTables = pendingAssets(pack.geometries.assets.length, pack.materials.assets.length, extraTextures);
			timer.end('assets');
		}

		const states = await sceneStates(context.world, scene, entities.collected, environments.levels);
		timer.end('states');

		const [environmentTextureIds, waterTextureIds] = assetTables.extraTextureIds;
		const written = await writePackage(pack, assetTables, {
			...states,
			environments: finishEnvironments(environments, environmentTextureIds),
			water: finishWater(water, waterTextureIds),
			resident: instances.resident,
			terrainLevels,
		});
		timer.end('write');

		await writeDebug(options.outDir, {
			files: scene.files,
			instances: debugLog.path,
			geometries: pack.geometries.assets,
			materials: pack.materials.assets,
			conversion: conversion?.debug ?? null,
			environments: environments.debug,
			water: water.debug,
		});
		timer.end('debug');

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
			tree: {
				nodes: written.tree.nodes.length,
				refs: written.tree.refs.length,
				byKind: refKinds(written.tree),
			},
			blobs: blobTotals(store),
			coreMembers: written.coreMembers,
			archives: written.archives,
			totalBytes: written.archives.reduce((sum, archive) => sum + archive.size, 0),
			// maxRSS is in KiB
			peakRss: process.resourceUsage().maxRSS * 1024,
		};
	} finally {
		await store.dispose();
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
	terrain: Omit<TerrainInfo, 'levels'> | null;
	grid: TreeGrid;
	subset: Subset;
	/** the scene's chunk files in processing order; debug rows index into it */
	files: ChunkFile[];
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
	const [pathOf, bundleManifest, names, partition, terrainIndex, surface, chunkFiles] = await Promise.all([
		world.pathLookup(),
		world.manifest(),
		world.names(),
		world.partition(options.scene),
		indexTerrain(context.vfs),
		loadTerrainSurface(context, options.scene),
		world.chunkFiles(),
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
					},
		grid,
		subset: buildSubset(options, partition, grid),
		files: chunkFiles
			.filter((file) => file.scene === options.scene)
			// base-state files first, then stream areas: a fixed order for the first-wins dedupe
			.toSorted((a, b) => Number(a.state !== 0) - Number(b.state !== 0) || (a.name < b.name ? -1 : 1)),
		pathOf,
		source: { buildGuid: bundleManifest.guid, contentHash: bundleManifest.contentHash },
	};
};

/** reads every chunk file of the scene, interning chains and sorting instances into groups */
const collectEntities = async (
	world: WorldIndex,
	pack: PackState,
): Promise<{ collected: Collector; counts: Record<string, number>; hlodNameMatches: number }> => {
	const { scene } = pack;
	const { grid, subset } = scene;
	const collected = new Collector();
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
	/** per geometry id: whether its path names a card mesh */
	const cards: boolean[] = [];
	let hlodNameMatches = 0;

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
		(file) => world.readChunk(file, scene.partition),
		(entities, file, fileIndex) => {
			if (entities instanceof Error) {
				throw entities;
			}
			for (const entity of entities) {
				counts.read++;
				if (seen.has(entity.id)) {
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
					layer: file.layer,
				};

				if (hlod !== null) {
					const tier = Number(hlod[1]);
					const key = { level: grid.hlodLevels[tier], x: Number(hlod[2]), z: Number(hlod[3]) };
					const at = tileAt(grid, key.level, x, z);
					if (at.x === key.x && at.z === key.z) {
						hlodNameMatches++;
					}
					collected.addHlod(entity.levelTag, tier, key, row, entity.name, fileIndex);
					pack.uses.note(row.chain, key);
				} else if (file.cell === null) {
					collected.addResident(entity.levelTag, row, entity.name, fileIndex);
					pack.uses.note(row.chain, null);
				} else {
					const key = tileAt(grid, grid.leafLevel, x, z);
					collected.addDetail(entity.levelTag, key, row, entity.name, fileIndex);
					pack.uses.note(row.chain, key);
				}
				collected.noteOwner(entity.levelTag, bounds);
			}
		},
	);
	return { collected, counts, hlodNameMatches };
};

/**
 * stores the subset's terrain height pages and attaches them to the tree
 *
 * @returns the levels that have pages, ascending
 */
const packTerrain = async (context: Pick<Context, 'vfs'>, pack: PackState): Promise<number[]> => {
	const { terrainScene, surface, terrain, subset, grid } = pack.scene;
	if (terrainScene === undefined || surface === undefined || terrain === null) {
		return [];
	}
	const tiles = [...terrainScene.tiles.values()]
		.filter(({ key }) => subset.includesTile(key))
		.toSorted((a, b) => a.key.level - b.key.level || a.key.z - b.key.z || a.key.x - b.key.x);
	for (let start = 0; start < tiles.length; start += BLOB_BATCH) {
		const batch = tiles.slice(start, start + BLOB_BATCH);
		// oxlint-disable-next-line no-await-in-loop -- batches bound memory and keep blob order stable
		const samples = await Promise.all(
			batch.map(async ({ file }) =>
				readTerrainHeightSamples(readTerrainTexture(await context.vfs.readVerified(file))),
			),
		);
		// oxlint-disable-next-line no-await-in-loop
		const blobs = await pack.store.putMany(
			batch.map(({ key }, i) => ({
				raw: encodeHeightPage(samples[i], TERRAIN_HEIGHT_PAGE_SIZE),
				options: placement(BlobKind.TerrainHeights, archiveForTile(pack, key)),
			})),
		);
		for (const [i, { key }] of batch.entries()) {
			const node = surface.nodes?.[terrainNodeIndex(key)];
			pack.builder.addRef(
				key,
				{
					kind: ContentKind.TerrainHeights,
					tier: 0,
					level: 0,
					blob: blobs[i],
					first: 0,
					count: 1,
					param: node?.maxHeightError ?? 0,
				},
				NodeFlags.HasTerrain,
			);
			pack.builder.extend(key, terrainBounds(grid, terrain, key, samples[i]));
		}
	}
	return [...new Set(tiles.map(({ key }) => key.level))];
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
					kind: ContentKind.Detail,
					tier: 0,
					level: group.level,
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
	return { levels, progressions };
};

/** builds the tree and tables, then writes every archive */
const writePackage = async (
	pack: PackState,
	assetTables: AssetTables,
	states: SceneStateInfo & {
		environments: EnvironmentProfile[];
		water: WaterTable;
		resident: ContentRef[];
		terrainLevels: number[];
	},
): Promise<{ tree: Tree; coreMembers: Record<string, number>; archives: PackReport['archives'] }> => {
	const { scene, store } = pack;
	const { options, grid } = scene;
	const tree = pack.builder.build((key) => (grid.rootSize / 2 ** key.level) * ERROR_PER_EDGE);
	const treeBin = encodeTree(tree);
	const chainsBin = encodeChains(pack.chains.chains);
	const tables = {
		geometries: zstdTable(json({ entries: assetTables.geometries } satisfies GeometryTable)),
		materials: zstdTable(json(assetTables.materials satisfies MaterialTable)),
		textures: zstdTable(json({ entries: assetTables.textures } satisfies TextureTable)),
		water: zstdTable(json(states.water)),
	};

	const shardNames = store
		.archiveNames()
		.filter((name) => name !== CORE_ARCHIVE)
		.toSorted();
	const archiveNames = [CORE_ARCHIVE, ...shardNames];
	const blobsBin = encodeBlobTable(store.records(archiveNames));
	const written = await store.writeShards(options.outDir, CORE_ARCHIVE);

	const generation = createHash('sha256');
	for (const part of [
		treeBin,
		chainsBin,
		blobsBin,
		tables.geometries,
		tables.materials,
		tables.textures,
		tables.water,
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
		terrain: scene.terrain === null ? null : { ...scene.terrain, levels: states.terrainLevels },
		levels: states.levels,
		environments: states.environments,
		states: {
			progressions: states.progressions,
			conditionalSets: [],
		},
		archives,
		resident: states.resident,
		subset: scene.subset.info,
		source: scene.source,
	};
	const core = await store.writeCore(options.outDir, CORE_ARCHIVE, [
		{ path: CORE_PATHS.manifest, data: json(manifest) },
		{ path: CORE_PATHS.tree, data: treeBin },
		{ path: CORE_PATHS.blobs, data: blobsBin },
		{ path: CORE_PATHS.chains, data: chainsBin },
		{ path: CORE_PATHS.geometries, data: tables.geometries },
		{ path: CORE_PATHS.materials, data: tables.materials },
		{ path: CORE_PATHS.textures, data: tables.textures },
		{ path: CORE_PATHS.water, data: tables.water },
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
	readonly detail = new Map<string, Group & { key: TileKey; level: number }>();
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
			group = { ...newGroup(), key, level };
			this.detail.set(id, group);
		}
		push(group, row, 0, name, file);
		this.#countInstance(level);
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
	terrain: Omit<TerrainInfo, 'levels'>,
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

const prepareOutDir = async (outDir: string): Promise<void> => {
	let entries: string[];
	try {
		entries = await readdir(outDir);
	} catch {
		await mkdir(outDir, { recursive: true });
		return;
	}
	if (entries.length === 0) {
		return;
	}
	if (!entries.includes(CORE_ARCHIVE)) {
		throw new Error(`${outDir} isn't empty and doesn't hold a package; refusing to write into it`);
	}
	const foreign = entries.filter((entry) => !PACKAGE_ENTRIES.has(entry));
	if (foreign.length > 0) {
		throw new Error(`${outDir} holds files that aren't part of a package: ${foreign.join(', ')}`);
	}
	await Promise.all(entries.map((entry) => rm(join(outDir, entry), { recursive: true, force: true })));
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
	},
): Promise<void> => {
	const dir = join(outDir, 'debug');
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'environments.json'), json(debug.environments));
	await writeFile(join(dir, 'water.json'), json(debug.water));
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
const zstdTable = (data: Uint8Array): Uint8Array => zstdSync(data, 19);

// #endregion
