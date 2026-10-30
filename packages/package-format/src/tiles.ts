import type { TreeInfo } from './tree.ts';

/** a tile address */
export interface TileKey {
	level: number;
	x: number;
	z: number;
}

/**
 * @param tree tree parameters
 * @param key tile address
 * @returns the tile's world x, z footprint
 */
export const tileFootprint = (
	tree: Pick<TreeInfo, 'origin' | 'rootSize'>,
	key: TileKey,
): { minX: number; minZ: number; size: number } => {
	const size = tree.rootSize / 2 ** key.level;
	return { minX: tree.origin[0] + key.x * size, minZ: tree.origin[1] + key.z * size, size };
};

/**
 * @param tree tree parameters
 * @param level tile level
 * @param x world x
 * @param z world z
 * @returns the level's tile containing the point
 */
export const tileAt = (
	tree: Pick<TreeInfo, 'origin' | 'rootSize'>,
	level: number,
	x: number,
	z: number,
): TileKey => {
	const size = tree.rootSize / 2 ** level;
	return {
		level,
		x: Math.floor((x - tree.origin[0]) / size),
		z: Math.floor((z - tree.origin[1]) / size),
	};
};

/**
 * @param key tile address
 * @param level a coarser or equal level
 * @returns the ancestor at `level`
 */
export const tileAncestor = (key: TileKey, level: number): TileKey => {
	const shift = key.level - level;
	if (shift < 0) {
		throw new RangeError(`level ${level} is finer than tile level ${key.level}`);
	}
	// floor division keeps negative coordinates on the right side of the grid
	return { level, x: Math.floor(key.x / 2 ** shift), z: Math.floor(key.z / 2 ** shift) };
};

/** @returns a string key for maps and archive names: `level_x_z` */
export const tileId = (key: TileKey): string => `${key.level}_${key.x}_${key.z}`;

/**
 * @param key a tile below the root
 * @returns which of its parent's four children it is: bit 0 = +x half, bit 1 = +z half
 */
export const tileQuadrant = (key: TileKey): number => {
	const parent = tileAncestor(key, key.level - 1);
	return (key.z - parent.z * 2) * 2 + (key.x - parent.x * 2);
};
