import {
	TERRAIN_HEIGHT_HOLE,
	TERRAIN_HEIGHT_PAGE_SIZE,
	type TerrainTileKey,
} from '@endfield-noclip/formats/hg/terrain';

/** one decoded `_H` tile */
export interface HeightTile extends TerrainTileKey {
	/** 65² raw samples from `readTerrainHeightSamples` */
	samples: Uint16Array;
}

/** a rectangle of leaf cells, `min` inclusive and `max` exclusive */
export interface CellRange {
	minX: number;
	minZ: number;
	maxX: number;
	maxZ: number;
}

/** leaf-resolution height grid stitched from a scene's tiles */
export interface HeightMosaic {
	leafLevel: number;
	cells: CellRange;
	/** samples per row: 64 per cell plus the shared far edge */
	width: number;
	/** rows, advancing along world +Z */
	height: number;
	/** raw samples; uncovered cells are holes with height 0 */
	samples: Uint16Array;
	/** per cell, row-major: the level of the tile it came from, or -1 when no tile covers it */
	sourceLevels: Int8Array;
}

const QUADS = TERRAIN_HEIGHT_PAGE_SIZE - 1;

/**
 * @param tiles tiles of one scene
 * @param leafLevel finest quadtree level
 * @returns the smallest cell range covering every tile, or `undefined` when there are none
 */
export const coveredCells = (tiles: Iterable<TerrainTileKey>, leafLevel: number): CellRange | undefined => {
	let range: CellRange | undefined;
	for (const { level, x, z } of tiles) {
		const factor = 2 ** (leafLevel - level);
		const minX = x * factor;
		const minZ = z * factor;
		if (range === undefined) {
			range = { minX, minZ, maxX: minX + factor, maxZ: minZ + factor };
		} else {
			range.minX = Math.min(range.minX, minX);
			range.minZ = Math.min(range.minZ, minZ);
			range.maxX = Math.max(range.maxX, minX + factor);
			range.maxZ = Math.max(range.maxZ, minZ + factor);
		}
	}
	return range;
};

/**
 * stitches tiles into one grid at leaf resolution. each cell takes the finest tile covering it; coarser tiles
 * are upsampled bilinearly, falling back to the nearest sample next to holes.
 *
 * the fallback mirrors An1X3R/Endfield-map-extractor's map01 handling (`extractor_core/terrain.py`, MIT), but
 * picks one source tile per cell, as a quadtree renderer would.
 *
 * @param tiles tiles of one scene
 * @param leafLevel finest quadtree level
 * @param cells cells to cover
 */
export const buildHeightMosaic = (
	tiles: Iterable<HeightTile>,
	leafLevel: number,
	cells: CellRange,
): HeightMosaic => {
	const byKey = new Map<string, HeightTile>();
	for (const tile of tiles) {
		byKey.set(`${tile.level}/${tile.x}/${tile.z}`, tile);
	}

	const cellsX = cells.maxX - cells.minX;
	const cellsZ = cells.maxZ - cells.minZ;
	const width = cellsX * QUADS + 1;
	const height = cellsZ * QUADS + 1;
	const samples = new Uint16Array(width * height).fill(TERRAIN_HEIGHT_HOLE);
	const sourceLevels = new Int8Array(cellsX * cellsZ).fill(-1);

	for (let cz = cells.minZ; cz < cells.maxZ; cz++) {
		for (let cx = cells.minX; cx < cells.maxX; cx++) {
			for (let level = leafLevel; level >= 0; level--) {
				const depth = leafLevel - level;
				const tile = byKey.get(`${level}/${cx >> depth}/${cz >> depth}`);
				if (tile === undefined) {
					continue;
				}
				const factor = 2 ** depth;
				const offsetX = (cx & (factor - 1)) * QUADS;
				const offsetZ = (cz & (factor - 1)) * QUADS;
				const originX = (cx - cells.minX) * QUADS;
				const originZ = (cz - cells.minZ) * QUADS;
				for (let j = 0; j <= QUADS; j++) {
					for (let i = 0; i <= QUADS; i++) {
						samples[(originZ + j) * width + originX + i] =
							depth === 0
								? tile.samples[j * TERRAIN_HEIGHT_PAGE_SIZE + i]
								: sampleBilinear(tile.samples, (offsetX + i) / factor, (offsetZ + j) / factor);
					}
				}
				sourceLevels[(cz - cells.minZ) * cellsX + (cx - cells.minX)] = level;
				break;
			}
		}
	}
	return { leafLevel, cells, width, height, samples, sourceLevels };
};

const sampleBilinear = (samples: Uint16Array, u: number, v: number): number => {
	const x0 = Math.min(QUADS - 1, Math.floor(u));
	const z0 = Math.min(QUADS - 1, Math.floor(v));
	const fx = u - x0;
	const fz = v - z0;
	const row0 = z0 * TERRAIN_HEIGHT_PAGE_SIZE + x0;
	const row1 = row0 + TERRAIN_HEIGHT_PAGE_SIZE;
	const a = samples[row0];
	const b = samples[row0 + 1];
	const c = samples[row1];
	const d = samples[row1 + 1];
	if (((a | b | c | d) & TERRAIN_HEIGHT_HOLE) !== 0) {
		return samples[Math.round(v) * TERRAIN_HEIGHT_PAGE_SIZE + Math.round(u)];
	}
	return Math.round((a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz);
};
