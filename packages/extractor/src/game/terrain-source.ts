import {
	parseTerrainPath,
	readTerrainSplatIndex,
	readTerrainSurfacesData,
	TERRAIN_SPLAT_CELL,
	type TerrainLayer,
	type TerrainLayerRole,
	type TerrainSurfacesData,
	type TerrainTileChannel,
	type TerrainTileKey,
} from '@endfield-noclip/formats/hg/terrain';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';

import type { Context } from '../context.ts';
import { VfsGroup, type Vfs, type VfsFile } from '../hg/vfs.ts';

import { loadTexture } from './asset-decode.ts';

/** one terrain tile's files */
export interface TerrainTileFiles {
	key: TerrainTileKey;
	/** the `_H` height page */
	file: VfsFile;
	/** the other channels the tile has */
	channels: Partial<Record<Exclude<TerrainTileChannel, 'H'>, VfsFile>>;
}

/** a scene's terrain files */
export interface TerrainSceneIndex {
	scene: string;
	/** every tile with a height page, keyed `level/x/z` */
	tiles: Map<string, TerrainTileFiles>;
	/** layer texture files by role and texture index */
	layers: Record<TerrainLayerRole, Map<number, VfsFile>>;
	/** finest level present */
	leafLevel: number;
}

/**
 * @param vfs mounted VFS
 * @returns every scene with terrain, by name
 */
export const indexTerrain = async (vfs: Vfs): Promise<Map<string, TerrainSceneIndex>> => {
	const group = await vfs.group(VfsGroup.Terrain);
	const scenes = new Map<string, TerrainSceneIndex>();
	// a tile's channels arrive in any order, so they're gathered before tiles without heights are dropped
	const channels = new Map<TerrainSceneIndex, Map<string, TerrainTileFiles['channels']>>();
	for (const entry of group.files.values()) {
		const path = parseTerrainPath(entry.name);
		if (path === undefined) {
			continue;
		}
		let scene = scenes.get(path.scene);
		if (scene === undefined) {
			scene = {
				scene: path.scene,
				tiles: new Map(),
				layers: { D: new Map(), N: new Map(), C: new Map() },
				leafLevel: 0,
			};
			scenes.set(path.scene, scene);
			channels.set(scene, new Map());
		}
		switch (path.kind) {
			case 'tile': {
				const key = { level: path.level, x: path.x, z: path.z };
				const id = `${key.level}/${key.x}/${key.z}`;
				const file = { group, entry };
				if (path.channel === 'H') {
					scene.tiles.set(id, { key, file, channels: {} });
					scene.leafLevel = Math.max(scene.leafLevel, key.level);
					break;
				}
				const sceneChannels = channels.get(scene)!;
				let tile = sceneChannels.get(id);
				if (tile === undefined) {
					tile = {};
					sceneChannels.set(id, tile);
				}
				tile[path.channel] = file;
				break;
			}
			case 'layer': {
				scene.layers[path.role].set(path.index, { group, entry });
				break;
			}
		}
	}
	for (const [scene, sceneChannels] of channels) {
		for (const [id, tile] of scene.tiles) {
			tile.channels = sceneChannels.get(id) ?? {};
		}
	}
	return new Map([...scenes].toSorted(([a], [b]) => a.localeCompare(b)));
};

/** @returns the asset folder of a scene's terrain */
const terrainAssetDir = (scene: string): string => `assets/beyond/dynamicassets/scenes/pc/${scene}/terrain/`;

/** @returns the asset path of a scene's `HGTerrainSurfacesData` */
const terrainSurfacesAssetPath = (scene: string): string =>
	`${terrainAssetDir(scene)}hgterrainsurfacesdata.asset`;

/**
 * reads a scene's splat index map (`terrain/splatindexmap.tga`). finding its path hash scans the
 * StringPathHash tables (about a second)
 *
 * @param context world index and asset resolver
 * @param surface the scene's terrain, with its layers
 * @param scene streaming scene
 * @returns 4 layer ordinals per 8 m cell (see `readTerrainSplatIndex`), or `undefined` if the scene has no
 *   map
 * @throws {Error} if the map can't be decoded or doesn't fit the terrain
 */
export const loadTerrainSplatIndex = async (
	context: Pick<Context, 'world' | 'resolver'>,
	surface: TerrainSurfacesData & { layers: TerrainLayer[] },
	scene: string,
): Promise<Uint8Array | undefined> => {
	const wanted = `${terrainAssetDir(scene)}splatindexmap.tga`;
	const [hash] = await context.world.hashesOf(wanted);
	if (hash === undefined) {
		return undefined;
	}
	const resolver = await context.resolver();
	const asset = resolver.manifest.findAssets(hash)[0];
	if (asset === undefined) {
		return undefined;
	}
	const [ref] = await resolver.findInBundle(
		asset.bundleIndex,
		`${wanted}##splatindexmap`,
		UnityClass.Texture2D,
	);
	if (ref === undefined) {
		throw new Error(`${wanted}'s bundle has no splat index Texture2D`);
	}
	const texture = await loadTexture(resolver, ref);
	const side = surface.terrainSize / TERRAIN_SPLAT_CELL;
	if (texture.format.name !== 'RGBA32' || texture.width !== side || texture.height !== side) {
		throw new Error(
			`${wanted} is ${texture.width}×${texture.height} ${texture.format.name}, expected ${side}² RGBA32`,
		);
	}
	return readTerrainSplatIndex(texture.levels[0], side, surface.layers.length);
};

/**
 * reads a scene's terrain parameters (position, height scale, size, node table) from its
 * `HGTerrainSurfacesData` MonoBehaviour. finding the asset's path hash scans the StringPathHash tables (about
 * a second)
 *
 * @param context world index and asset resolver
 * @param scene streaming scene
 * @returns the surface, or `undefined` if the scene has no such asset
 * @throws {Error} if the asset's bundle doesn't hold the MonoBehaviour
 */
export const loadTerrainSurfacesData = async (
	context: Pick<Context, 'world' | 'resolver'>,
	scene: string,
): Promise<TerrainSurfacesData | undefined> => {
	const wanted = terrainSurfacesAssetPath(scene);
	const [hash] = await context.world.hashesOf(wanted);
	if (hash === undefined) {
		return undefined;
	}
	const resolver = await context.resolver();
	const asset = resolver.manifest.findAssets(hash)[0];
	if (asset === undefined) {
		return undefined;
	}
	const [ref] = await resolver.findInBundle(
		asset.bundleIndex,
		`${wanted}##hgterrainsurfacesdata`,
		UnityClass.MonoBehaviour,
	);
	if (ref === undefined) {
		throw new Error(`${wanted}'s bundle has no HGTerrainSurfacesData MonoBehaviour`);
	}
	return readTerrainSurfacesData(await resolver.read(ref));
};
