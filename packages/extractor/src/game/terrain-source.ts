import {
	parseTerrainPath,
	readTerrainSurfacesData,
	type TerrainLayerRole,
	type TerrainSurface,
	type TerrainTileKey,
} from '@endfield-noclip/formats/hg/terrain';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';

import type { Context } from '../context.ts';
import { VfsGroup, type Vfs, type VfsFile } from '../hg/vfs.ts';

/** a scene's terrain files */
export interface TerrainSceneIndex {
	scene: string;
	/** `_H` file of every tile, keyed `level/x/z` */
	tiles: Map<string, { key: TerrainTileKey; file: VfsFile }>;
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
	for (const entry of group.files.values()) {
		const path = parseTerrainPath(entry.name);
		if (path === undefined) {
			continue;
		}
		let scene = scenes.get(path.scene);
		if (scene === undefined) {
			scene = { scene: path.scene, tiles: new Map(), layers: { D: [], N: [], C: [] }, leafLevel: 0 };
			scenes.set(path.scene, scene);
		}
		switch (path.kind) {
			case 'tile': {
				if (path.channel === 'H') {
					const key = { level: path.level, x: path.x, z: path.z };
					scene.tiles.set(`${key.level}/${key.x}/${key.z}`, { key, file: { group, entry } });
					scene.leafLevel = Math.max(scene.leafLevel, key.level);
				}
				break;
			}
			case 'layer': {
				scene.layers[path.role].push(path.index);
				break;
			}
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
