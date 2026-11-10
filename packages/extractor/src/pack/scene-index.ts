import type { LevelPartition, PartitionLevel } from '@endfield-noclip/formats/endfield/level-partition';
import { CELL_SIZE } from '@endfield-noclip/formats/endfield/map-config';
import { terrainLeafLevel, type TerrainSurfacesData } from '@endfield-noclip/formats/hg/terrain';
import type { PackageManifest, SubsetInfo } from '@endfield-noclip/package-format/manifest';
import type { TerrainInfo } from '@endfield-noclip/package-format/terrain';
import {
	type TileKey,
	tileAncestor,
	tileAt,
	tileFootprint,
	tileId,
} from '@endfield-noclip/package-format/tiles';
import type { TreeInfo } from '@endfield-noclip/package-format/tree';
import { type Rect, rectContains } from '@endfield-noclip/package-format/values';

import { mapDefined } from '@mary-ext/array-fns';

import type { Context } from '../context.ts';
import { GameState, type MapVariables } from '../game/state/game-state.ts';
import {
	loadMapVariables,
	loadSceneStates,
	type SceneStateDefinition,
} from '../game/state/scene-conditions.ts';
import { loadUpgradeLinks } from '../game/state/settlement-upgrades.ts';
import {
	indexTerrain,
	loadTerrainSurfacesData,
	type TerrainSceneIndex,
} from '../game/world/terrain-source.ts';
import type { ChunkFile, WorldIndex } from '../game/world/world-index.ts';

import { squareOverlapsRect } from './instances/bounds.ts';
import { HLOD_NAME, type HlodLayout, type HlodSample, layoutHlodGrid } from './instances/hlod-cells.ts';

/** what to pack; the packer's options that decide the package's content */
export interface SceneSelection {
	/** streaming scene, e.g. `map02` */
	scene: string;
	/** LevelConfig id to restrict content to, or `null` */
	level: string | null;
	/** world rectangle to restrict content to (min inclusive, max exclusive), or `null` */
	bounds: Rect | null;
}

/** the scene's terrain */
export interface SceneTerrain {
	scene: TerrainSceneIndex;
	surface: TerrainSurfacesData;
	/** the manifest's terrain section without its levels */
	info: Omit<TerrainInfo, 'levels' | 'splat'>;
}

/** what setup learns about the scene */
export interface SceneIndex {
	/** streaming scene id */
	id: string;
	/** the LevelConfig id content is restricted to, or `null` */
	level: string | null;
	/** display names by scene and level id */
	names: Map<string, string>;
	partition: LevelPartition | undefined;
	/** the scene's terrain, or `null` without */
	terrain: SceneTerrain | null;
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

/**
 * indexes a scene: its level partition, terrain and tile grid, the subset, scene states and chunk files
 *
 * @param context VFS, world index and asset resolver
 * @param selection what to pack
 * @returns the scene's index
 * @throws {Error} if the level isn't the scene's, or the scene's terrain is incomplete or misaligned
 */
export const indexScene = async (
	context: Pick<Context, 'vfs' | 'world' | 'resolver'>,
	selection: SceneSelection,
): Promise<SceneIndex> => {
	const { world } = context;
	const { scene } = selection;
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
		world.partition(scene),
		indexTerrain(context.vfs),
		loadTerrainSurfacesData(context, scene),
		world.chunkFiles(),
		loadSceneStates(world, scene),
		loadUpgradeLinks(context, scene),
		loadMapVariables(world, scene),
	]);
	const game = new GameState({ links, variables });
	game.note(mapDefined(sceneStates, ({ condition }) => condition ?? undefined));
	const terrainScene = terrainIndex.get(scene);
	if (terrainScene !== undefined && surface === undefined) {
		throw new Error(`${scene} has terrain tiles but no HGTerrainSurfacesData`);
	}
	const files = chunkFiles
		.filter((file) => file.scene === scene)
		// always-loaded files first, then scene states; the default area before stream areas: a fixed order
		// for the first-wins dedupe, in which an entity of an always-loaded file stays unconditional
		.toSorted(
			(a, b) =>
				Number(a.sceneState !== 0) - Number(b.sceneState !== 0) ||
				Number(a.area !== 0) - Number(b.area !== 0) ||
				(a.name < b.name ? -1 : 1),
		);
	const terrainGrid = treeGrid(surface);
	// HLOD clusters sit in Global chunks only, which are small
	const hlod = layoutHlodGrid(
		await hlodSamples(
			world,
			files.filter((file) => file.cell === null),
		),
		terrainGrid,
	);
	const grid: TreeInfo = { ...terrainGrid, hlodLevels: hlod.levels };
	let terrain: SceneTerrain | null = null;
	if (terrainScene !== undefined && surface !== undefined) {
		terrain = {
			scene: terrainScene,
			surface,
			info: { baseHeight: surface.position.y, heightScale: surface.heightScale },
		};
	}
	return {
		id: scene,
		level: selection.level,
		names,
		partition,
		terrain,
		grid,
		hlod,
		subset: buildSubset(selection, partition, grid),
		files,
		sceneStates,
		game,
		variables,
		pathOf,
		source: { buildGuid: bundleManifest.guid, contentHash: bundleManifest.contentHash },
	};
};

/**
 * @param surface the scene's terrain parameters, if any
 * @returns tree parameters aligned with the terrain quadtree; scenes without terrain get a 4096 m grid at the
 *   origin
 */
const treeGrid = (surface: TerrainSurfacesData | undefined): TreeInfo => {
	const rootSize = surface?.terrainSize ?? 4096;
	let origin: [number, number] = [-rootSize / 2, -rootSize / 2];
	if (surface !== undefined) {
		origin = [surface.position.x, surface.position.z];
	}
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

// #region subset

/** the part of a scene a pack keeps: one level's content, a world rectangle, or everything */
export interface Subset {
	/** what the manifest records, or `null` for the whole scene */
	info: SubsetInfo | null;
	/**
	 * @param tag the content's level tag
	 * @param x world x of its centre
	 * @param z world z of its centre
	 * @returns whether the subset keeps it
	 */
	includesEntity(tag: number, x: number, z: number): boolean;
	/**
	 * @param tag the content's level tag
	 * @param point its centre or position, in world space
	 * @returns whether the subset keeps it
	 */
	includesPoint(tag: number, point: readonly number[]): boolean;
	/** @returns whether the subset keeps a tile's terrain and irradiance */
	includesTile(key: TileKey): boolean;
}

const buildSubset = (
	selection: SceneSelection,
	partition: LevelPartition | undefined,
	grid: TreeInfo,
): Subset => {
	let level: PartitionLevel | undefined;
	if (selection.level !== null) {
		level = partition?.levels.find((candidate) => candidate.id === selection.level);
		if (level === undefined) {
			throw new Error(`${selection.level} isn't a level of ${selection.scene}`);
		}
	}
	const { bounds } = selection;
	const touched = new Set<string>();
	if (level !== undefined) {
		for (const cell of level.config.levelGrids ?? []) {
			const key = cellTile(grid, cell);
			for (let l = 0; l <= grid.cellLevel; l++) {
				touched.add(tileId(tileAncestor(key, l)));
			}
		}
	}
	const includesEntity = (tag: number, x: number, z: number): boolean =>
		(level === undefined || tag === level.tag) && (bounds === null || rectContains(bounds, x, z));
	return {
		info: level === undefined && bounds === null ? null : { level: level?.id ?? null, bounds },
		includesEntity,
		includesPoint: (tag, point) => includesEntity(tag, point[0], point[2]),
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
export const cellTile = (grid: TreeInfo, cell: { x: number; z: number }): TileKey =>
	tileAt(grid, grid.cellLevel, (cell.x + 0.5) * CELL_SIZE, (cell.z + 0.5) * CELL_SIZE);

// #endregion
