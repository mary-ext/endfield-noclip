/**
 * the game's DynamicStreaming load grids (`docs/game-data/world.md#dynamic-streaming`): level `L` cells are
 * `32 << L` m on a 4096 m frame centred on the origin, and a row loads while the streaming centre's cell at
 * its grid's level is within one cell of the grid's, on both axes
 */

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
 * @param grid a grid's level and cell
 * @param x world x of the streaming centre, m
 * @param z world z of the streaming centre, m
 * @returns whether the game loads the grid's rows with the streaming centre there (ignoring the ~10 m of
 *   unload hysteresis)
 */
export const dynamicGridLoaded = (grid: DynamicGrid, x: number, z: number): boolean => {
	const size = MIN_CELL << grid.level;
	// the game clamps the centre into the frame, so a centre past its edge loads the edge cells
	const cell = (world: number): number =>
		Math.floor(Math.min(Math.max(world + HALF_FRAME, 0.001), FRAME - 0.001) / size);
	return Math.abs(cell(x) - grid.x) <= 1 && Math.abs(cell(z) - grid.z) <= 1;
};
