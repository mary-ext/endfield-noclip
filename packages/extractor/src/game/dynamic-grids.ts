/**
 * the game's DynamicStreaming load grids (`docs/game-data/world.md#dynamic-streaming`): level `L` cells are
 * `32 << L` m on a 4096 m frame centred on the origin, and a row loads while the streaming centre's cell at
 * its grid's level is within one cell of the grid's, on both axes
 *
 * @module
 */

import type { Rect } from '@endfield-noclip/package-format/values';

/** half the frame's edge, m: frame coordinates are world x, z plus this */
const HALF_FRAME = 2048;
/** the frame's edge, m */
const FRAME = HALF_FRAME * 2;
/** edge of a level-0 cell, m */
const MIN_CELL = 32;

/** a grid id's level and cell indices */
export interface DynamicGrid {
	level: number;
	/** cell index along x */
	x: number;
	/** cell index along z */
	z: number;
}

/**
 * @param id an `fb_main` grid id, `level << 16 | z << 8 | x`
 * @returns its level and cell
 */
export const decodeDynamicGrid = (id: number): DynamicGrid => ({
	level: (id >>> 16) & 0xff,
	x: id & 0xff,
	z: (id >>> 8) & 0xff,
});

/**
 * the game clamps the streaming centre into the frame, so a centre past its edge loads the edge cells: a
 * reach touching the frame's first or last cell runs on to infinity
 *
 * @param grid a grid's level and cell
 * @returns the world x, z rectangle, `[min, max)`, where a streaming centre loads the grid's rows (ignoring
 *   the ~10 m of unload hysteresis); empty when no centre does
 */
export const dynamicGridReach = (grid: DynamicGrid): Rect => {
	const size = MIN_CELL << grid.level;
	const last = Math.ceil(FRAME / size) - 1;
	const axis = (cell: number): [min: number, max: number] => {
		const lo = Math.max(cell - 1, 0);
		const hi = Math.min(cell + 1, last);
		if (lo > hi) {
			return [0, 0];
		}
		return [
			lo === 0 ? -Infinity : lo * size - HALF_FRAME,
			hi === last ? Infinity : (hi + 1) * size - HALF_FRAME,
		];
	};
	const [minX, maxX] = axis(grid.x);
	const [minZ, maxZ] = axis(grid.z);
	return { minX, minZ, maxX, maxZ };
};
