import { type ChunkLight, readChunkLights } from '@endfield-noclip/formats/endfield/chunk-lights';
import {
	type ClothGroup,
	hasClothGroups,
	readClothGroups,
} from '@endfield-noclip/formats/endfield/cloth-groups';
import { readDynamicScene, type DynamicEntity } from '@endfield-noclip/formats/endfield/dynamic-scene';
import {
	hasFoliageGrids,
	readFoliageGrids,
	type FoliageGrid,
} from '@endfield-noclip/formats/endfield/foliage-grids';
import {
	ChunkObjectKind,
	parseInitChunk,
	readChunkEntities,
	StreamingLayer,
	type ChunkEntity,
	type InitChunk,
} from '@endfield-noclip/formats/endfield/init-chunk-data';
import { parseLevelConfig, type LevelConfig } from '@endfield-noclip/formats/endfield/level-config';
import {
	buildLevelPartition,
	classifyEntity,
	type LevelPartition,
	type Membership,
	type PartitionLevel,
} from '@endfield-noclip/formats/endfield/level-partition';
import { parseMapConfig, type MapConfig } from '@endfield-noclip/formats/endfield/map-config';
import { parseMissionRuntime, type MissionRuntime } from '@endfield-noclip/formats/endfield/mission-runtime';
import {
	hasMonoComponents,
	MonoComponentType,
	type MonoObject,
	readMonoObjects,
} from '@endfield-noclip/formats/endfield/mono-objects';
import { parseStreamAreas, type StreamAreaTable } from '@endfield-noclip/formats/endfield/stream-area';
import {
	parseStreamingChunk,
	DECAL_MATERIAL_KEY,
	WATER_DECAL_MESH_KEY,
	type HlodLink,
	type StreamingChunk,
} from '@endfield-noclip/formats/endfield/streaming-chunk-data';
import {
	readWaterGlobalBindings,
	readWaterSurfaces,
	WATER_SURFACE_COMPONENT,
	type WaterGlobalBinding,
	type WaterSurface,
} from '@endfield-noclip/formats/endfield/water';
import type { BundleManifest } from '@endfield-noclip/formats/hg/bundle-manifest';
import { unpackHgPayload } from '@endfield-noclip/formats/hg/payload';
import { isSparkBean, parseSparkTable, type SparkValue } from '@endfield-noclip/formats/hg/spark-buffer';
import { StringPathHashTable } from '@endfield-noclip/formats/hg/string-path-hash';
import { parseStringPoolBlock, StringPool } from '@endfield-noclip/formats/hg/string-pool';

import { definite, mapDefined } from '@mary-ext/array-fns';

import { loadBundleManifest } from '../../install/bundles.ts';
import { VfsGroup, type Vfs } from '../../install/vfs.ts';
import { compareNatural, compareStrings } from '../../util/compare.ts';
import { mapPool } from '../../util/pool.ts';

// #region file names

const STRING_PATH_HASH = 'Data/ExtendData/Main/StringPathHash.bin';
const INIT_STRING_PATH_HASH = 'Data/ExtendData/Initial/InitStringPathHash.bin';
const STREAMING_ROOT = 'Data/Streaming/PC/';
const DYNAMIC_SCENE_ROOT = 'Data/DynamicStreaming/PC/Scene/';
/** a mission definition; `_meta` files beside them hold accept mode and reward */
const MISSION_PATTERN = /^Data\/Json\/MissionRuntimeAsset\/(.+?)(?<!_meta)\.json$/;
const CHUNK_PATTERN =
	/^Data\/Streaming\/PC\/([^/]+)\/Streaming\/InitChunkData_(?:(-?\d+)_(-?\d+)|Global)_(-?\d+)_(-?\d+)\.bytes$/;

/** small JSON and DynamicStreaming files read at once */
const READ_CONCURRENCY = 16;

// #endregion

// #region types

/** an InitChunkData file located by its name */
export interface ChunkFile {
	/** VFS logical path */
	name: string;
	scene: string;
	/** cell coordinate; `null` for the Global chunk */
	cell: { x: number; z: number } | null;
	/** scene state id: 0 is always loaded, `n` only while MapConfig scene state `n − 1` is active */
	sceneState: number;
	/** stream area id; 0 is the default area */
	area: number;
}

/** where a chunk file sits in the game's load conditions: its scene state and stream area */
export type ChunkSource = Pick<ChunkFile, 'sceneState' | 'area'>;

/** everything the packer reads from one chunk file pair (Init + Streaming) in a single pass */
export interface ChunkContent {
	entities: IndexedEntity[];
	lights: ChunkLight[];
	foliage: FoliageGrid[];
	clothGroups: ClothGroup[];
	decalMaterials: Map<number, bigint>;
	waterDecalMeshes: Map<number, bigint>;
	hlodClusters: Map<number, HlodLink>;
	/** environment and post-processing Mono objects, populated for default-area chunks that carry them */
	monoObjects: MonoObject[];
	/** placed water surfaces, populated for Global chunks */
	waterSurfaces: WaterSurface[];
	/** global water config bindings, populated for Global chunks */
	waterGlobals: WaterGlobalBinding[];
}

const VOLUME_MONO_COMPONENTS = BigInt(
	MonoComponentType.HGEnvironmentVolume | MonoComponentType.Volume | MonoComponentType.ReflectionProbe,
);
/** an entity read from a chunk, with its membership */
export interface IndexedEntity extends ChunkEntity {
	source: ChunkFile;
	membership: Membership;
	/** world pivot: matrix translation, else bounds centre, else `null` */
	pivot: { x: number; y: number; z: number } | null;
}

// #endregion

/**
 * lazily loaded, cached view over everything the world commands need. all methods read through the VFS;
 * nothing is written.
 */
export class WorldIndex {
	readonly vfs: Vfs;
	#pathHash: Promise<StringPathHashTable> | undefined;
	#initPathHash: Promise<StringPathHashTable> | undefined;
	/** both tables once {@link pathLookup} has loaded them, for its synchronous lookups */
	#loadedPathTables: [StringPathHashTable, StringPathHashTable] | undefined;
	/** decoded paths cached by hash while the path tables are loaded */
	readonly #pathCache = new Map<bigint, string | undefined>();
	/** {@link hashesOf} by normalized path */
	readonly #hashes = new Map<string, Promise<bigint[]>>();
	#manifest: Promise<BundleManifest> | undefined;
	#levelConfigs: Promise<Map<string, LevelConfig>> | undefined;
	#stringPool: Promise<StringPool> | undefined;
	#names: Promise<Map<string, string>> | undefined;
	#english: Promise<Map<bigint, string>> | undefined;
	#text: Promise<(key: string) => string | undefined> | undefined;
	readonly #missions = new Map<string, Promise<MissionRuntime | undefined>>();
	#chunkFiles: Promise<ChunkFile[]> | undefined;
	readonly #mapConfigs = new Map<string, Promise<MapConfig | undefined>>();
	readonly #partitions = new Map<string, Promise<LevelPartition | undefined>>();
	readonly #streamAreas = new Map<string, Promise<StreamAreaTable | undefined>>();
	readonly #dynamicEntities = new Map<string, Promise<DynamicEntity[]>>();

	/** @param vfs an open VFS */
	constructor(vfs: Vfs) {
		this.vfs = vfs;
	}

	/** @returns the main StringPathHash table (≈170 MB, loaded once) */
	pathHash(): Promise<StringPathHashTable> {
		this.#pathHash ??= this.vfs
			.read(VfsGroup.ExtendData, STRING_PATH_HASH, { verify: false })
			.then((b) => new StringPathHashTable(b));
		return this.#pathHash;
	}

	/** @returns the initial-package StringPathHash table */
	initPathHash(): Promise<StringPathHashTable> {
		this.#initPathHash ??= this.vfs
			.read(VfsGroup.InitialExtendData, INIT_STRING_PATH_HASH, { verify: false })
			.then((b) => new StringPathHashTable(b));
		return this.#initPathHash;
	}

	/** @returns the bundle manifest */
	manifest(): Promise<BundleManifest> {
		this.#manifest ??= loadBundleManifest(this.vfs);
		return this.#manifest;
	}

	/**
	 * @param hash a StringPathHash key
	 * @returns the path from the main table, falling back to the initial one
	 */
	async pathOf(hash: bigint): Promise<string | undefined> {
		return (await this.pathLookup())(hash);
	}

	/**
	 * @returns {@link pathOf} as a synchronous function, once both tables are loaded; it reads them through
	 *   this index rather than holding them, so {@link releasePathTables} frees them
	 */
	async pathLookup(): Promise<(hash: bigint) => string | undefined> {
		const [main, initial] = await Promise.all([this.pathHash(), this.initPathHash()]);
		this.#loadedPathTables = [main, initial];
		const cache = this.#pathCache;
		return (hash) => {
			if (this.#loadedPathTables === undefined) {
				throw new Error('the StringPathHash tables were released; call pathLookup again');
			}
			if (cache.has(hash)) {
				return cache.get(hash);
			}
			const [loadedMain, loadedInitial] = this.#loadedPathTables;
			const path = loadedMain.lookup(hash) ?? loadedInitial.lookup(hash);
			cache.set(hash, path);
			return path;
		};
	}

	/**
	 * drops the StringPathHash tables (≈170 MB); {@link hashesOf} keeps its results and later calls read the
	 * tables again, while lookups from an earlier {@link pathLookup} throw
	 */
	releasePathTables(): void {
		this.#pathHash = undefined;
		this.#initPathHash = undefined;
		this.#loadedPathTables = undefined;
		this.#pathCache.clear();
	}

	/**
	 * finds the hashes a path is stored under by scanning both tables for paths of its length, since the hash
	 * function for asset paths isn't ported. the first call indexes the tables by length (about a second)
	 *
	 * @param path asset path; matched case-insensitively, with `\` read as `/`
	 * @returns distinct hashes, main table first
	 */
	hashesOf(path: string): Promise<bigint[]> {
		const wanted = path.toLowerCase().replaceAll('\\', '/');
		return this.#hashes.getOrInsertComputed(wanted, async () => {
			const hashes: bigint[] = [];
			for (const table of [await this.pathHash(), await this.initPathHash()]) {
				for (const hash of table.hashesOf(wanted)) {
					if (!hashes.includes(hash)) {
						hashes.push(hash);
					}
				}
			}
			return hashes;
		});
	}

	/** @returns the install's pooled JsonData strings */
	stringPool(): Promise<StringPool> {
		this.#stringPool ??= (async () => {
			const group = await this.vfs.group(VfsGroup.JsonData);
			const poolFiles = mapDefined(
				[...group.catalog.names()],
				(name) => /^Data\/Json\/StringPool\/StringPool(\d+)\.byte$/.exec(name) ?? undefined,
			);
			poolFiles.sort((a, b) => Number(a[1]) - Number(b[1]));
			const blocks = await Promise.all(
				poolFiles.map(async (match) =>
					parseStringPoolBlock(await this.#read(VfsGroup.JsonData, match[0]), { first: match[1] === '0' }),
				),
			);
			return new StringPool(blocks);
		})();
		return this.#stringPool;
	}

	/** @returns every LevelConfig by id */
	levelConfigs(): Promise<Map<string, LevelConfig>> {
		this.#levelConfigs ??= (async () => {
			const group = await this.vfs.group(VfsGroup.JsonData);
			const pool = await this.stringPool();

			const names = group.catalog
				.names()
				.filter((name) => name.startsWith('Data/Json/LevelConfig/'))
				.toArray();
			const configs = await mapPool(names, READ_CONCURRENCY, async (name) =>
				parseLevelConfig(await this.#read(VfsGroup.JsonData, name), (id) => pool.get(id)),
			);
			return new Map(configs.map((config) => [config.id, config]));
		})();
		return this.#levelConfigs;
	}

	/**
	 * @param mapId e.g. `map02`
	 * @returns its MapConfig, or `undefined` if it has none
	 */
	mapConfig(mapId: string): Promise<MapConfig | undefined> {
		return this.#mapConfigs.getOrInsertComputed(mapId, async () => {
			const data = await this.vfs.tryRead(VfsGroup.JsonData, `Data/Json/MapConfig/${mapId}.json`);
			return data && parseMapConfig(new TextDecoder().decode(data));
		});
	}

	/**
	 * @param mapId a streaming scene
	 * @returns its level partition, or `undefined` if the map has no MapConfig (and so no levels)
	 */
	partition(mapId: string): Promise<LevelPartition | undefined> {
		return this.#partitions.getOrInsertComputed(mapId, async () => {
			const map = await this.mapConfig(mapId);
			return map && buildLevelPartition(map, (await this.levelConfigs()).values());
		});
	}

	/**
	 * English display names of maps and levels, from MapIdTable/LevelDescTable joined with I18nTextTable_EN
	 *
	 * @returns id → name
	 */
	names(): Promise<Map<string, string>> {
		this.#names ??= (async () => {
			const text = await this.englishText();
			const tables = await Promise.all(
				['MapIdTable', 'LevelDescTable'].map((table) =>
					this.#read(VfsGroup.Table, `Data/TableCfg/${table}.bytes`),
				),
			);
			const names = new Map<string, string>();
			for (const table of tables) {
				for (const [key, value] of parseSparkTable(table).entries) {
					const name = i18nText(value, text);
					if (typeof key === 'string' && name) {
						names.set(key, name);
					}
				}
			}
			return names;
		})();
		return this.#names;
	}

	/** @returns I18nTextTable_EN: text id → English string */
	englishText(): Promise<Map<bigint, string>> {
		this.#english ??= (async () => {
			const text = new Map<bigint, string>();
			for (const [key, value] of parseSparkTable(
				await this.#read(VfsGroup.Table, 'Data/TableCfg/I18nTextTable_EN.bytes'),
			).entries) {
				if (typeof key === 'bigint' && typeof value === 'string') {
					text.set(key, value);
				}
			}
			return text;
		})();
		return this.#english;
	}

	/**
	 * English text by text key (TextTable key → text id → I18nTextTable_EN), e.g. `e1m8_name`
	 *
	 * @returns a lookup giving the raw string, rich-text markup included, or `undefined` for an unknown key
	 */
	text(): Promise<(key: string) => string | undefined> {
		this.#text ??= (async () => {
			const english = await this.englishText();
			const ids = new Map<string, bigint>();
			for (const [key, value] of parseSparkTable(
				await this.#read(VfsGroup.Table, 'Data/TableCfg/TextTable.bytes'),
			).entries) {
				if (typeof key === 'string' && isSparkBean(value) && typeof value.id === 'bigint') {
					ids.set(key, value.id);
				}
			}
			return (key: string) => {
				const id = ids.get(key);
				return id === undefined ? undefined : english.get(id);
			};
		})();
		return this.#text;
	}

	/**
	 * @param name a game data JSON path, e.g. `Data/Json/UILevelMapLoadConfig/map01_lv001.json`
	 * @returns the file parsed, or `undefined` if the install has no such file
	 */
	async json(name: string): Promise<unknown> {
		const data = await this.vfs.tryRead(VfsGroup.JsonData, name);
		return data && (JSON.parse(new TextDecoder().decode(data)) as unknown);
	}

	/**
	 * @param id a mission id, e.g. `e1m8`
	 * @returns its definition, or `undefined` if the client has none
	 * @throws {FormatError} if the file is malformed
	 */
	mission(id: string): Promise<MissionRuntime | undefined> {
		return this.#missions.getOrInsertComputed(id, async () => {
			const data = await this.vfs.tryRead(VfsGroup.JsonData, `Data/Json/MissionRuntimeAsset/${id}.json`);
			return data && parseMissionRuntime(new TextDecoder().decode(data));
		});
	}

	/**
	 * @returns every mission the client defines, in id order
	 * @throws {FormatError} if a mission file is malformed
	 */
	async missions(): Promise<MissionRuntime[]> {
		const group = await this.vfs.group(VfsGroup.JsonData);
		const ids = mapDefined([...group.catalog.names()], (name) => MISSION_PATTERN.exec(name)?.[1]);
		const missions = await mapPool(ids, READ_CONCURRENCY, (id) => this.mission(id));
		const loaded = definite(missions);
		loaded.sort((a, b) => compareNatural(a.id, b.id));
		return loaded;
	}

	/** @returns every InitChunkData file of every streaming scene */
	chunkFiles(): Promise<ChunkFile[]> {
		this.#chunkFiles ??= (async () => {
			const files: ChunkFile[] = [];
			for (const name of (await this.vfs.group(VfsGroup.Streaming)).catalog.names()) {
				const match = CHUNK_PATTERN.exec(name);
				if (match) {
					const [, scene, x, z, sceneState, area] = match;
					files.push({
						name,
						scene,
						cell: x === undefined ? null : { x: Number(x), z: Number(z) },
						sceneState: Number(sceneState),
						area: Number(area),
					});
				}
			}
			files.sort((a, b) => compareStrings(a.name, b.name));
			return files;
		})();
		return this.#chunkFiles;
	}

	/**
	 * @param scene streaming scene
	 * @param cell a cell coordinate, or `'global'` for the Global chunks
	 * @param filter optional scene state and stream area to keep
	 * @returns the cell's chunk files, in name order
	 */
	async cellChunkFiles(
		scene: string,
		cell: { x: number; z: number } | 'global',
		filter: { sceneState?: number; area?: number },
	): Promise<ChunkFile[]> {
		return (await this.chunkFiles()).filter(
			(file) =>
				file.scene === scene &&
				(cell === 'global' ? file.cell === null : file.cell?.x === cell.x && file.cell.z === cell.z) &&
				(filter.sceneState === undefined || file.sceneState === filter.sceneState) &&
				(filter.area === undefined || file.area === filter.area),
		);
	}

	/** @returns the streaming scene names (worlds) */
	async scenes(): Promise<string[]> {
		const scenes = new Set<string>();
		for (const name of (await this.vfs.group(VfsGroup.Streaming)).catalog.names()) {
			if (name.startsWith(STREAMING_ROOT)) {
				scenes.add(name.slice(STREAMING_ROOT.length).split('/')[0]);
			}
		}
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
		return [...scenes].sort();
	}

	/**
	 * reads and decodes one chunk file's entities, classified against the map's partition when it has one
	 *
	 * @param file chunk file
	 * @param partition the scene's partition, or `undefined` for scenes without levels
	 * @returns its entities
	 */
	async readChunk(file: ChunkFile, partition: LevelPartition | undefined): Promise<IndexedEntity[]> {
		return indexEntities(parseInitChunk(await this.readInitPayload(file)), file, partition);
	}

	/**
	 * like {@link readChunk}, with the chunk's local lights, foliage grids, decal materials (rect decals' and
	 * WaterDecal boxes') and HLOD clusters too
	 *
	 * @param file chunk file
	 * @param partition the scene's partition, or `undefined` for scenes without levels
	 * @returns its entities, lights, grass and tree grids, each decal's material key and each WaterDecal box's
	 *   mesh key by entity id, and the link of each entity on an HLOD layer that other entities name as their
	 *   parent, by entity id
	 * @throws {Error} if the chunk has foliage grids, decals or HLOD-layer entities but no StreamingChunkData
	 *   sibling
	 */
	async readChunkContent(file: ChunkFile, partition: LevelPartition | undefined): Promise<ChunkContent> {
		const initBytes = await this.readInitPayload(file);
		const chunk = parseInitChunk(initBytes);
		const lights = readChunkLights(chunk);
		const entities = indexEntities(chunk, file, partition);
		const foliaged = hasFoliageGrids(chunk.rows);
		const decalIds: number[] = [];
		const waterDecalIds: number[] = [];
		// clusters load on the HLOD layers; the links of their children, in the cell files, aren't read
		const hlodIds: number[] = [];
		for (const entity of entities) {
			if (entity.decal !== null || entity.waterDecal !== null) {
				decalIds.push(entity.id);
			}
			if (entity.waterDecal !== null) {
				waterDecalIds.push(entity.id);
			}
			if (isHlodLayer(entity.layer)) {
				hlodIds.push(entity.id);
			}
		}
		const hasVolumes = file.area === 0 && hasMonoComponents(initBytes, VOLUME_MONO_COMPONENTS);
		const hasWater =
			file.cell === null &&
			chunk.groups.some((group) => group.columns.some((column) => column.id === WATER_SURFACE_COMPONENT));
		const hasWaterGlobal =
			file.cell === null && chunk.objects.some((object) => object.kind === ChunkObjectKind.Mono);
		const needsStreaming =
			foliaged || decalIds.length > 0 || hlodIds.length > 0 || hasWater || hasWaterGlobal;
		let streamingBytes: Uint8Array | null = null;
		let streaming: StreamingChunk | null = null;
		if (needsStreaming || hasVolumes) {
			streamingBytes = await this.readStreamingPayload(file);
			if (streamingBytes === null && needsStreaming) {
				throw new Error(
					`${file.name} has foliage grids, decals, water or HLOD-layer entities but no StreamingChunkData`,
				);
			}
			if (streamingBytes !== null) {
				streaming = parseStreamingChunk(streamingBytes);
			}
		}
		const foliage = foliaged && streaming !== null ? readFoliageGrids(chunk.rows, streaming.raw) : [];
		const clothGroups = hasClothGroups(chunk.rows) ? readClothGroups(chunk.rows) : [];
		const decalMaterials = new Map<number, bigint>();
		const waterDecalMeshes = new Map<number, bigint>();
		const hlodClusters = new Map<number, HlodLink>();
		if (streaming !== null) {
			for (const id of decalIds) {
				const material = streaming.assetProperty(id, DECAL_MATERIAL_KEY);
				if (material !== undefined) {
					decalMaterials.set(id, material);
				}
			}
			for (const id of waterDecalIds) {
				const mesh = streaming.assetProperty(id, WATER_DECAL_MESH_KEY);
				if (mesh !== undefined) {
					waterDecalMeshes.set(id, mesh);
				}
			}
			for (const id of hlodIds) {
				const link = streaming.hlodLink(id);
				if (link !== null && link.childCount > 0) {
					hlodClusters.set(id, link);
				}
			}
		}
		const monoObjects = hasVolumes ? readMonoObjects(initBytes, streamingBytes) : [];
		const waterSurfaces = hasWater && streaming !== null ? readWaterSurfaces(chunk, streaming) : [];
		const waterGlobals =
			hasWaterGlobal && streaming !== null ? readWaterGlobalBindings(chunk, streaming) : [];
		return {
			entities,
			lights,
			foliage,
			clothGroups,
			decalMaterials,
			waterDecalMeshes,
			hlodClusters,
			monoObjects,
			waterSurfaces,
			waterGlobals,
		};
	}

	/**
	 * @param file chunk file
	 * @returns its InitChunkData FlatBuffer, unpacked
	 * @throws {Error} if the VFS doesn't have it
	 */
	async readInitPayload(file: ChunkFile): Promise<Uint8Array> {
		return unpackHgPayload(await this.vfs.read(VfsGroup.Streaming, file.name, { verify: false }));
	}

	/**
	 * @param file chunk file
	 * @returns its StreamingChunkData sibling's FlatBuffer, unpacked, or `null` if the VFS doesn't have one
	 */
	async readStreamingPayload(file: ChunkFile): Promise<Uint8Array | null> {
		const data = await this.vfs.tryRead(
			VfsGroup.Streaming,
			file.name.replace('/InitChunkData_', '/StreamingChunkData_'),
			{ verify: false },
		);
		return data === undefined ? null : unpackHgPayload(data);
	}

	/**
	 * reads one chunk file's entities and, when the chunk has rect/water decals (or `hlodLinks` is requested),
	 * reads decal materials, water-decal meshes, and/or HLOD links from its StreamingChunkData sibling
	 *
	 * @param file chunk file
	 * @param partition the scene's partition, or `undefined` for scenes without levels
	 * @param options whether to also read every entity's HLOD link
	 * @returns its entities, decal material keys, water-decal mesh keys, and HLOD links by entity id
	 * @throws {Error} if the chunk has decals but no StreamingChunkData sibling
	 */
	async readChunkWithDecals(
		file: ChunkFile,
		partition: LevelPartition | undefined,
		options: { hlodLinks: boolean },
	): Promise<{
		entities: IndexedEntity[];
		decalMaterials: Map<number, bigint>;
		waterDecalMeshes: Map<number, bigint>;
		hlodLinks: Map<number, HlodLink>;
	}> {
		const chunk = parseInitChunk(await this.readInitPayload(file));
		const entities = indexEntities(chunk, file, partition);
		const decalMaterials = new Map<number, bigint>();
		const waterDecalMeshes = new Map<number, bigint>();
		const hlodLinks = new Map<number, HlodLink>();
		const decalIds = mapDefined(entities, (entity) =>
			entity.decal === null && entity.waterDecal === null ? undefined : entity.id,
		);
		const waterDecalIds = mapDefined(entities, (entity) =>
			entity.waterDecal === null ? undefined : entity.id,
		);
		if (decalIds.length > 0 || options.hlodLinks) {
			const data = await this.readStreamingPayload(file);
			if (data === null && decalIds.length > 0) {
				throw new Error(`${file.name} has decals but no StreamingChunkData`);
			}
			if (data !== null) {
				const streaming = parseStreamingChunk(data);
				for (const id of decalIds) {
					const material = streaming.assetProperty(id, DECAL_MATERIAL_KEY);
					if (material !== undefined) {
						decalMaterials.set(id, material);
					}
				}
				for (const id of waterDecalIds) {
					const mesh = streaming.assetProperty(id, WATER_DECAL_MESH_KEY);
					if (mesh !== undefined) {
						waterDecalMeshes.set(id, mesh);
					}
				}
				if (options.hlodLinks) {
					for (const entity of entities) {
						const link = streaming.hlodLink(entity.id);
						if (link !== null) {
							hlodLinks.set(entity.id, link);
						}
					}
				}
			}
		}
		return { entities, decalMaterials, waterDecalMeshes, hlodLinks };
	}

	/**
	 * streams every unique entity of a scene, deduplicated by id (first file wins, files in name order)
	 *
	 * @param scene streaming scene, e.g. `map02`
	 * @param filter optional chunk-file predicate
	 */
	async *sceneEntities(scene: string, filter?: (file: ChunkFile) => boolean): AsyncGenerator<IndexedEntity> {
		const partition = await this.partition(scene);
		const selected = (await this.chunkFiles()).filter(
			(file) => file.scene === scene && (filter === undefined || filter(file)),
		);
		const seen = new Set<number>();
		const pending = new Map<number, Promise<IndexedEntity[]>>();
		const prefetch = (index: number): void => {
			if (index < selected.length) {
				pending.set(index, this.readChunk(selected[index], partition));
			}
		};
		for (let i = 0; i < Math.min(READ_CONCURRENCY, selected.length); i++) {
			prefetch(i);
		}
		try {
			for (let i = 0; i < selected.length; i++) {
				// oxlint-disable-next-line no-await-in-loop -- entities stream out in file order with read-ahead
				const entities = await pending.get(i)!;
				pending.delete(i);
				prefetch(i + READ_CONCURRENCY);
				for (const entity of entities) {
					if (!seen.has(entity.id)) {
						seen.add(entity.id);
						yield entity;
					}
				}
			}
		} finally {
			for (const promise of pending.values()) {
				void promise.catch(() => {});
			}
		}
	}

	/**
	 * {@link sceneEntities} with each rect decal's material and optionally each entity's HLOD link. reads
	 * StreamingChunkData siblings only for selected files that hold rect decals (or all selected files when
	 * `hlodLinks` is true)
	 *
	 * @param scene streaming scene, e.g. `map02`
	 * @param filter optional chunk-file predicate
	 * @param options whether to also read HLOD links
	 * @returns each unique entity with its decal material's path hash and HLOD link
	 * @throws {Error} if such a file has no StreamingChunkData sibling
	 */
	async *sceneEntitiesWithDecals(
		scene: string,
		filter: ((file: ChunkFile) => boolean) | undefined,
		options: { hlodLinks: boolean },
	): AsyncGenerator<{
		entity: IndexedEntity;
		decalMaterial: bigint | null;
		waterDecalMesh: bigint | null;
		hlodLink: HlodLink | null;
	}> {
		const partition = await this.partition(scene);
		const selected = (await this.chunkFiles()).filter(
			(file) => file.scene === scene && (filter === undefined || filter(file)),
		);
		const seen = new Set<number>();
		const pending = new Map<
			number,
			Promise<{
				entities: IndexedEntity[];
				decalMaterials: Map<number, bigint>;
				waterDecalMeshes: Map<number, bigint>;
				hlodLinks: Map<number, HlodLink>;
			}>
		>();
		const prefetch = (index: number): void => {
			if (index < selected.length) {
				pending.set(index, this.readChunkWithDecals(selected[index], partition, options));
			}
		};
		for (let i = 0; i < Math.min(READ_CONCURRENCY, selected.length); i++) {
			prefetch(i);
		}
		try {
			for (let i = 0; i < selected.length; i++) {
				// oxlint-disable-next-line no-await-in-loop -- entities stream out in file order with read-ahead
				const { entities, decalMaterials, waterDecalMeshes, hlodLinks } = await pending.get(i)!;
				pending.delete(i);
				prefetch(i + READ_CONCURRENCY);
				for (const entity of entities) {
					if (!seen.has(entity.id)) {
						seen.add(entity.id);
						yield {
							entity,
							decalMaterial: decalMaterials.get(entity.id) ?? null,
							waterDecalMesh: waterDecalMeshes.get(entity.id) ?? null,
							hlodLink: hlodLinks.get(entity.id) ?? null,
						};
					}
				}
			}
		} finally {
			for (const promise of pending.values()) {
				void promise.catch(() => {});
			}
		}
	}

	/**
	 * every entity a level owns (by tag), wherever it's placed
	 *
	 * @param level a level of the partition
	 * @param partition its map's partition
	 */
	async *entitiesOfLevel(level: PartitionLevel, partition: LevelPartition): AsyncGenerator<IndexedEntity> {
		for await (const entity of this.sceneEntities(partition.mapId)) {
			if (entity.membership.level === level) {
				yield entity;
			}
		}
	}

	/**
	 * @param scene streaming scene
	 * @returns its stream-area table, or `undefined` if the scene has none
	 */
	streamAreas(scene: string): Promise<StreamAreaTable | undefined> {
		return this.#streamAreas.getOrInsertComputed(scene, async () => {
			const data = await this.vfs.tryRead(
				VfsGroup.DynamicStreaming,
				`${DYNAMIC_SCENE_ROOT}${scene}/FBStreamArea.bytes`,
			);
			return data && parseStreamAreas(data);
		});
	}

	/**
	 * @param scene streaming scene
	 * @returns every DynamicStreaming entity of the scene's `fb_main` files, in file-name order
	 */
	dynamicEntities(scene: string): Promise<DynamicEntity[]> {
		return this.#dynamicEntities.getOrInsertComputed(scene, async () => {
			const prefix = `${DYNAMIC_SCENE_ROOT}${scene}/fb_main_`;
			const names = (await this.vfs.group(VfsGroup.DynamicStreaming)).catalog
				.names()
				.filter((name) => name.startsWith(prefix))
				.toArray();
			names.sort();
			const perFile = await mapPool(
				names,
				READ_CONCURRENCY,
				async (name) => readDynamicScene(await this.#read(VfsGroup.DynamicStreaming, name)).entities,
			);
			return perFile.flat();
		});
	}

	#read(group: string, name: string): Promise<Uint8Array> {
		return this.vfs.read(group, name);
	}
}

const isHlodLayer = (layer: number): boolean =>
	layer === StreamingLayer.HLOD0 || layer === StreamingLayer.HLOD1 || layer === StreamingLayer.HLOD2;

/** decodes a chunk's entities, classified against the map's partition when it has one */
const indexEntities = (
	chunk: InitChunk,
	file: ChunkFile,
	partition: LevelPartition | undefined,
): IndexedEntity[] =>
	readChunkEntities(chunk).map((entity) => {
		const pivot = pivotOf(entity);
		const membership: Membership =
			partition === undefined
				? { bucket: 'unassigned', level: null, placement: 'unplaced', cellOwner: null }
				: classifyEntity(partition, entity.id, pivot);
		// the decoded rows are fresh objects owned here, so extend them in place
		return Object.assign(entity, { source: file, membership, pivot });
	});

/**
 * @param entity decoded entity
 * @returns its world pivot: matrix translation, else bounds centre
 */
export const pivotOf = (entity: ChunkEntity): { x: number; y: number; z: number } | null => {
	if (entity.matrix !== null) {
		return { x: entity.matrix[12], y: entity.matrix[13], z: entity.matrix[14] };
	}
	if (entity.bounds !== null) {
		const [x, y, z] = entity.bounds.center;
		return { x, y, z };
	}
	return null;
};

const i18nText = (value: SparkValue, text: Map<bigint, string>): string | undefined => {
	if (!isSparkBean(value)) {
		return undefined;
	}
	const showName = value.showName;
	if (!isSparkBean(showName) || typeof showName.id !== 'bigint') {
		return undefined;
	}
	return text.get(showName.id);
};
