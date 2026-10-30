import {
	parseTerrainPath,
	readTerrainSurfacesData,
	type TerrainLayerRole,
	type TerrainSurface,
	type TerrainTileChannel,
	type TerrainTileKey,
} from '@endfield-noclip/formats/hg/terrain';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';

import type { Context } from '../context.ts';
import { VfsGroup, type Vfs, type VfsFile } from '../hg/vfs.ts';

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
	layers: Record<TerrainLayerRole, number[]>;
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
			scene = { scene: path.scene, tiles: new Map(), layers: { D: [], N: [], C: [] }, leafLevel: 0 };
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
				scene.layers[path.role].push(path.index);
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

/** @returns the asset path of a scene's `HGTerrainSurfacesData` */
const terrainSurfacesAssetPath = (scene: string): string =>
	`assets/beyond/dynamicassets/scenes/pc/${scene}/terrain/hgterrainsurfacesdata.asset`;

/**
 * reads a scene's terrain parameters (position, height scale, size, node table) from its
 * `HGTerrainSurfacesData` MonoBehaviour. finding the asset's path hash scans the StringPathHash catalogs
 * (about a second)
 *
 * @param context world index and asset resolver
 * @param scene streaming scene
 * @returns the surface, or `undefined` if the scene has no such asset
 * @throws {Error} if the asset's bundle doesn't hold the MonoBehaviour
 */
export const loadTerrainSurface = async (
	context: Pick<Context, 'world' | 'resolver'>,
	scene: string,
): Promise<TerrainSurface | undefined> => {
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
