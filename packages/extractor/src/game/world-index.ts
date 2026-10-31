import { type ChunkLight, readChunkLights } from '@endfield-noclip/formats/endfield/chunk-lights';
import { readDynamicEntities, type DynamicEntity } from '@endfield-noclip/formats/endfield/dynamic-scene';
import {
	hasFoliageGrids,
	readFoliageGrids,
	type FoliageGrid,
} from '@endfield-noclip/formats/endfield/foliage-grids';
import {
	parseInitChunk,
	readChunkEntities,
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
import { parseStreamAreas, type StreamAreaTable } from '@endfield-noclip/formats/endfield/stream-area';
import type { BundleManifest } from '@endfield-noclip/formats/hg/bundle-manifest';
import { unpackHgPayload } from '@endfield-noclip/formats/hg/payload';
import { parseSparkTable, type SparkValue } from '@endfield-noclip/formats/hg/spark-buffer';
import { StringPathHashTable } from '@endfield-noclip/formats/hg/string-path-hash';
import { parseStringPoolBlock, StringPool } from '@endfield-noclip/formats/hg/string-pool';

import { getOrInsert } from '../collections.ts';
import { loadBundleManifest } from '../hg/bundles.ts';
import { VfsGroup, type Vfs } from '../hg/vfs.ts';
import { mapPool } from '../pool.ts';

// #region file names

const STRING_PATH_HASH = 'Data/ExtendData/Main/StringPathHash.bin';
const INIT_STRING_PATH_HASH = 'Data/ExtendData/Initial/InitStringPathHash.bin';
const STREAMING_ROOT = 'Data/Streaming/PC/';
const DYNAMIC_SCENE_ROOT = 'Data/DynamicStreaming/PC/Scene/';
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
	/**
	 * scene state id: 0 is always loaded, `n` only while MapConfig scene state `n − 1` is active
	 * (`BaseGameScene.FlushStreamingSceneState`)
	 */
	sceneState: number;
	/** stream area id; 0 is the default area */
	area: number;
}

/** where a chunk file sits in the game's load conditions: its scene state and stream area */
export type ChunkSource = Pick<ChunkFile, 'sceneState' | 'area'>;

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
		this.#pathHash ??= this.#read(VfsGroup.ExtendData, STRING_PATH_HASH).then(
			(b) => new StringPathHashTable(b),
		);
		return this.#pathHash;
	}

	/** @returns the initial-package StringPathHash table */
	initPathHash(): Promise<StringPathHashTable> {
		this.#initPathHash ??= this.#read(VfsGroup.InitialExtendData, INIT_STRING_PATH_HASH).then(
			(b) => new StringPathHashTable(b),
		);
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

	/** @returns {@link pathOf} as a synchronous function, once both tables are loaded */
	async pathLookup(): Promise<(hash: bigint) => string | undefined> {
		const [main, initial] = await Promise.all([this.pathHash(), this.initPathHash()]);
		return (hash) => main.lookup(hash) ?? initial.lookup(hash);
	}

	/**
	 * finds the hashes a path is stored under by scanning both tables (about a second), since the hash function
	 * for asset paths isn't ported
	 *
	 * @param path asset path; matched case-insensitively, with `\` read as `/`
	 * @returns distinct hashes, main table first
	 */
	async hashesOf(path: string): Promise<bigint[]> {
		const wanted = path.toLowerCase().replaceAll('\\', '/');
		const hashes: bigint[] = [];
		for (const table of [await this.pathHash(), await this.initPathHash()]) {
			// only strings of the right length are decoded; the tables keep the authoring case
			for (const [hash, candidate] of table.entriesWithByteLength(wanted.length * 2)) {
				if (candidate.toLowerCase() === wanted && !hashes.includes(hash)) {
					hashes.push(hash);
				}
			}
		}
		return hashes;
	}

	/** @returns the install's pooled JsonData strings */
	stringPool(): Promise<StringPool> {
		this.#stringPool ??= (async () => {
			const group = await this.vfs.group(VfsGroup.JsonData);
			const poolFiles = [...group.files.keys()]
				.map((name) => /^Data\/Json\/StringPool\/StringPool(\d+)\.byte$/.exec(name))
				.filter((match) => match !== null)
				.toSorted((a, b) => Number(a[1]) - Number(b[1]));
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

			const names = [...group.files.keys()].filter((name) => name.startsWith('Data/Json/LevelConfig/'));
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
		return getOrInsert(this.#mapConfigs, mapId, async () => {
			const file = await this.vfs.find(VfsGroup.JsonData, `Data/Json/MapConfig/${mapId}.json`);
			return file && parseMapConfig(new TextDecoder().decode(await this.vfs.readVerified(file)));
		});
	}

	/**
	 * @param mapId a streaming scene
	 * @returns its level partition, or `undefined` if the map has no MapConfig (and so no levels)
	 */
	partition(mapId: string): Promise<LevelPartition | undefined> {
		return getOrInsert(this.#partitions, mapId, async () => {
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
			const text = await this.#englishText();
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
	#englishText(): Promise<Map<bigint, string>> {
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
			const english = await this.#englishText();
			const ids = new Map<string, bigint>();
			for (const [key, value] of parseSparkTable(
				await this.#read(VfsGroup.Table, 'Data/TableCfg/TextTable.bytes'),
			).entries) {
				if (
					typeof key === 'string' &&
					value !== null &&
					typeof value === 'object' &&
					typeof value.id === 'bigint'
				) {
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
	 * @param id a mission id, e.g. `e1m8`
	 * @returns its definition, or `undefined` if the client has none
	 * @throws {FormatError} if the file is malformed
	 */
	mission(id: string): Promise<MissionRuntime | undefined> {
		return getOrInsert(this.#missions, id, async () => {
			const file = await this.vfs.find(VfsGroup.JsonData, `Data/Json/MissionRuntimeAsset/${id}.json`);
			return file && parseMissionRuntime(new TextDecoder().decode(await this.vfs.readVerified(file)));
		});
	}

	/** @returns every InitChunkData file of every streaming scene */
	chunkFiles(): Promise<ChunkFile[]> {
		this.#chunkFiles ??= (async () => {
			const files: ChunkFile[] = [];
			for (const name of (await this.vfs.group(VfsGroup.Streaming)).files.keys()) {
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
			return files.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
		for (const name of (await this.vfs.group(VfsGroup.Streaming)).files.keys()) {
			if (name.startsWith(STREAMING_ROOT)) {
				scenes.add(name.slice(STREAMING_ROOT.length).split('/')[0]);
			}
		}
		return [...scenes].toSorted();
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
	 * like {@link readChunk}, with the chunk's local lights and foliage grids too
	 *
	 * @param file chunk file
	 * @param partition the scene's partition, or `undefined` for scenes without levels
	 * @returns its entities, lights and grass and tree grids
	 * @throws {Error} if the chunk has foliage grids but no StreamingChunkData sibling
	 */
	async readChunkContent(
		file: ChunkFile,
		partition: LevelPartition | undefined,
	): Promise<{ entities: IndexedEntity[]; lights: ChunkLight[]; foliage: FoliageGrid[] }> {
		const data = await this.readInitPayload(file);
		const chunk = parseInitChunk(data);
		const lights = readChunkLights(data, chunk);
		let foliage: FoliageGrid[] = [];
		if (hasFoliageGrids(data)) {
			const streaming = await this.readStreamingPayload(file);
			if (streaming === null) {
				throw new Error(`${file.name} has foliage grids but no StreamingChunkData`);
			}
			foliage = readFoliageGrids(data, streaming);
		}
		return { entities: indexEntities(chunk, file, partition), lights, foliage };
	}

	/**
	 * @param file chunk file
	 * @returns its InitChunkData FlatBuffer, unpacked
	 * @throws {Error} if the VFS doesn't have it
	 */
	async readInitPayload(file: ChunkFile): Promise<Uint8Array> {
		return unpackHgPayload(await this.#read(VfsGroup.Streaming, file.name));
	}

	/**
	 * @param file chunk file
	 * @returns its StreamingChunkData sibling's FlatBuffer, unpacked, or `null` if the VFS doesn't have one
	 */
	async readStreamingPayload(file: ChunkFile): Promise<Uint8Array | null> {
		const entry = await this.vfs.find(
			VfsGroup.Streaming,
			file.name.replace('/InitChunkData_', '/StreamingChunkData_'),
		);
		return entry === undefined ? null : unpackHgPayload(await this.vfs.readVerified(entry));
	}

	/**
	 * streams every unique entity of a scene, deduplicated by id (first file wins, files in name order)
	 *
	 * @param scene streaming scene, e.g. `map02`
	 * @param filter optional chunk-file predicate
	 */
	async *sceneEntities(scene: string, filter?: (file: ChunkFile) => boolean): AsyncGenerator<IndexedEntity> {
		const partition = await this.partition(scene);
		const seen = new Set<number>();
		for (const file of await this.chunkFiles()) {
			if (file.scene !== scene || (filter && !filter(file))) {
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop -- entities stream out a file at a time
			for (const entity of await this.readChunk(file, partition)) {
				if (!seen.has(entity.id)) {
					seen.add(entity.id);
					yield entity;
				}
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
		return getOrInsert(this.#streamAreas, scene, async () => {
			const file = await this.vfs.find(
				VfsGroup.DynamicStreaming,
				`${DYNAMIC_SCENE_ROOT}${scene}/FBStreamArea.bytes`,
			);
			return file && parseStreamAreas(await this.vfs.readVerified(file));
		});
	}

	/**
	 * @param scene streaming scene
	 * @returns every DynamicStreaming entity of the scene's `fb_main` files, in file-name order
	 */
	dynamicEntities(scene: string): Promise<DynamicEntity[]> {
		return getOrInsert(this.#dynamicEntities, scene, async () => {
			const prefix = `${DYNAMIC_SCENE_ROOT}${scene}/fb_main_`;
			const names = [...(await this.vfs.group(VfsGroup.DynamicStreaming)).files.keys()]
				.filter((name) => name.startsWith(prefix))
				.toSorted();
			const perFile = await mapPool(names, READ_CONCURRENCY, async (name) =>
				readDynamicEntities(await this.#read(VfsGroup.DynamicStreaming, name)),
			);
			return perFile.flat();
		});
	}

	async #read(group: string, name: string): Promise<Uint8Array> {
		const file = await this.vfs.find(group, name);
		if (file === undefined) {
			throw new Error(`${name} not found in vfs group ${group}`);
		}
		return this.vfs.readVerified(file);
	}
}

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
const pivotOf = (entity: ChunkEntity): { x: number; y: number; z: number } | null => {
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
	if (value === null || typeof value !== 'object') {
		return undefined;
	}
	const showName = value.showName;
	if (showName === null || typeof showName !== 'object' || typeof showName.id !== 'bigint') {
		return undefined;
	}
	return text.get(showName.id);
};
