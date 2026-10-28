import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
	readTerrainHeightSamples,
	readTerrainTexture,
	TERRAIN_LEAF_SIZE,
	terrainHeightsToWorld,
	terrainLeafLevel,
	terrainTileFootprint,
	type TerrainSurface,
	type TerrainTileKey,
} from '@endfield-noclip/formats/hg/terrain';
import type { Rect } from '@endfield-noclip/package-format/format';

import { parseBounds, parseInteger, parseNumber, parseNumbers } from '../cli-args.ts';
import { withContext } from '../context.ts';
import { encodePng } from '../export/png.ts';
import {
	buildHeightMosaic,
	coveredCells,
	type CellRange,
	type HeightMosaic,
	type HeightTile,
} from '../export/terrain-mosaic.ts';
import { indexTerrain, loadTerrainSurface, type TerrainSceneIndex } from '../game/terrain-source.ts';
import type { Vfs, VfsFile } from '../hg/vfs.ts';
import { squareOverlapsRect } from '../pack/bounds.ts';

export const summary =
	'inspect terrain: scenes | tiles <scene> | export-heights <scene> -o <dir> [--bounds xmin,xmax,zmin,zmax]';

const USAGE = `usage:
  terrain scenes
  terrain tiles <scene> [--bounds xmin,xmax,zmin,zmax]
  terrain export-heights <scene> -o <dir> [--bounds …] [--height-scale m] [--origin x,y,z] [--size m]
      [--preview-step n]

surface parameters come from the scene's HGTerrainSurfacesData asset; the flags override them. scenes
without the asset fall back to size = 64 m · 2^(finest level), origin = (-size/2, 0, -size/2), and heights
in units of the unknown height scale.`;

export const run = async (args: string[]): Promise<void> => {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			config: { type: 'string' },
			output: { type: 'string', short: 'o' },
			bounds: { type: 'string' },
			'height-scale': { type: 'string' },
			origin: { type: 'string' },
			size: { type: 'string' },
			'preview-step': { type: 'string', default: '4' },
		},
	});
	const [sub, scene] = positionals;
	const bounds = values.bounds === undefined ? undefined : parseBounds(values.bounds);

	await withContext(values.config, async (context) => {
		const { vfs } = context;
		const index = await indexTerrain(vfs);
		switch (sub) {
			case 'scenes': {
				printScenes(index);
				break;
			}
			case 'tiles': {
				const entry = requireScene(index, scene);
				printTiles(entry, await loadTerrainSurface(context, entry.scene), bounds);
				break;
			}
			case 'export-heights': {
				if (values.output === undefined) {
					throw new Error('terrain export-heights needs -o <dir>');
				}
				const entry = requireScene(index, scene);
				const surface = resolveSurface(entry, await loadTerrainSurface(context, entry.scene), {
					heightScale: values['height-scale'],
					origin: values.origin,
					size: values.size,
				});
				await exportHeights(vfs, entry, surface, {
					outDir: values.output,
					bounds,
					previewStep: parseInteger(values['preview-step'], '--preview-step'),
				});
				break;
			}
			default: {
				throw new Error(USAGE);
			}
		}
	});
};

// #region index

const requireScene = (
	index: Map<string, TerrainSceneIndex>,
	scene: string | undefined,
): TerrainSceneIndex => {
	if (scene === undefined) {
		throw new Error(USAGE);
	}
	const entry = index.get(scene);
	if (entry === undefined) {
		throw new Error(`no terrain for scene ${scene}; see \`terrain scenes\``);
	}
	return entry;
};

/** @returns tile counts by level, ascending */
const countLevels = (keys: Iterable<TerrainTileKey>): Map<number, TerrainTileKey[]> => {
	const levels = new Map<number, TerrainTileKey[]>();
	for (const key of keys) {
		let list = levels.get(key.level);
		if (list === undefined) {
			list = [];
			levels.set(key.level, list);
		}
		list.push(key);
	}
	return new Map([...levels].toSorted(([a], [b]) => a - b));
};

// #endregion

// #region surface

/** a surface plus which of its fields were guessed */
interface ResolvedSurface {
	surface: TerrainSurface;
	/** false when heights are in units of the (unknown) height scale */
	heightScaleKnown: boolean;
	inferred: string[];
}

/**
 * flags win over the scene's HGTerrainSurfacesData, which wins over guesses from the tile set
 *
 * @param entry the scene's tiles
 * @param loaded the scene's surface asset, if it has one
 * @param flags command-line overrides
 */
const resolveSurface = (
	entry: TerrainSceneIndex,
	loaded: TerrainSurface | undefined,
	flags: { heightScale: string | undefined; origin: string | undefined; size: string | undefined },
): ResolvedSurface => {
	const inferred: string[] = [];
	let terrainSize: number;
	if (flags.size !== undefined) {
		terrainSize = parseNumber(flags.size, '--size');
		terrainLeafLevel(terrainSize);
	} else if (loaded !== undefined) {
		terrainSize = loaded.terrainSize;
	} else {
		terrainSize = TERRAIN_LEAF_SIZE * 2 ** entry.leafLevel;
		inferred.push('terrainSize');
	}

	let position: TerrainSurface['position'];
	if (flags.origin !== undefined) {
		const [x, y, z] = parseNumbers(flags.origin, 3, '--origin');
		position = { x, y, z };
	} else if (loaded !== undefined) {
		position = loaded.position;
	} else {
		position = { x: -terrainSize / 2, y: 0, z: -terrainSize / 2 };
		inferred.push('position');
	}

	let heightScale = 1;
	if (flags.heightScale !== undefined) {
		heightScale = parseNumber(flags.heightScale, '--height-scale');
	} else if (loaded !== undefined) {
		heightScale = loaded.heightScale;
	} else {
		inferred.push('heightScale');
	}
	return {
		surface: { position, heightScale, terrainSize },
		heightScaleKnown: !inferred.includes('heightScale'),
		inferred,
	};
};

// #endregion

// #region scenes / tiles

const printScenes = (index: Map<string, TerrainSceneIndex>): void => {
	console.log('scene                 tiles  levels      leaf grid   layers D/N/C');
	for (const entry of index.values()) {
		const levels = [...countLevels([...entry.tiles.values()].map(({ key }) => key)).keys()];
		const side = 2 ** entry.leafLevel;
		console.log(
			[
				entry.scene.padEnd(20),
				String(entry.tiles.size).padStart(6),
				(levels.length === 0 ? '  -' : `  L${levels[0]}–L${levels.at(-1)}`).padEnd(12),
				(levels.length === 0 ? '-' : `${side}×${side}`).padEnd(11),
				`${entry.layers.D.length}/${entry.layers.N.length}/${entry.layers.C.length}`,
			].join(' '),
		);
	}
};

const printTiles = (
	entry: TerrainSceneIndex,
	loaded: TerrainSurface | undefined,
	bounds: Rect | undefined,
): void => {
	// placement only needs the size and origin, which don't depend on the height scale
	const { surface, inferred } = resolveSurface(entry, loaded, {
		heightScale: '1',
		origin: undefined,
		size: undefined,
	});
	const keys = selectTiles(entry, surface, bounds).map(({ key }) => key);
	console.log(
		`${entry.scene}: ${keys.length} tiles, leaf level ${entry.leafLevel} (${TERRAIN_LEAF_SIZE} m), ` +
			`terrain ${surface.terrainSize} m at (${surface.position.x}, ${surface.position.z})` +
			(inferred.length > 0 ? ` [inferred]` : ''),
	);
	console.log('level  tiles  size m   x range   z range   world x            world z');
	for (const [level, list] of countLevels(keys)) {
		const xs = list.map((key) => key.x);
		const zs = list.map((key) => key.z);
		const min = terrainTileFootprint(surface, { level, x: Math.min(...xs), z: Math.min(...zs) });
		const max = terrainTileFootprint(surface, { level, x: Math.max(...xs), z: Math.max(...zs) });
		console.log(
			[
				`L${level}`.padEnd(5),
				String(list.length).padStart(6),
				String(min.size).padStart(7),
				`  ${Math.min(...xs)}–${Math.max(...xs)}`.padEnd(10),
				`${Math.min(...zs)}–${Math.max(...zs)}`.padEnd(9),
				`${min.minX}..${max.minX + max.size}`.padEnd(18),
				`${min.minZ}..${max.minZ + max.size}`,
			].join(' '),
		);
	}
	const leaves = keys.filter((key) => key.level === entry.leafLevel);
	const cells = coveredCells(leaves, entry.leafLevel);
	if (cells !== undefined) {
		const area = (cells.maxX - cells.minX) * (cells.maxZ - cells.minZ);
		console.log(`leaf tiles fill ${leaves.length} of the ${area} cells in their bounding box`);
	}
};

const selectTiles = (
	entry: TerrainSceneIndex,
	surface: TerrainSurface,
	bounds: Rect | undefined,
): { key: TerrainTileKey; file: VfsFile }[] => {
	const tiles = [...entry.tiles.values()];
	if (bounds === undefined) {
		return tiles;
	}
	return tiles.filter(({ key }) => squareOverlapsRect(terrainTileFootprint(surface, key), bounds));
};

// #endregion

// #region export-heights

const exportHeights = async (
	vfs: Vfs,
	entry: TerrainSceneIndex,
	resolved: ResolvedSurface,
	options: { outDir: string; bounds: Rect | undefined; previewStep: number },
): Promise<void> => {
	const { surface } = resolved;
	const selected = selectTiles(entry, surface, options.bounds);
	const tiles: HeightTile[] = [];
	for (const { key, file } of selected) {
		// sequential reads share one chunk handle; the whole map02 set takes a few seconds
		// oxlint-disable-next-line no-await-in-loop
		const samples = readTerrainHeightSamples(readTerrainTexture(await vfs.readVerified(file)));
		tiles.push({ ...key, samples });
	}

	let cells = coveredCells(tiles, entry.leafLevel);
	if (cells === undefined) {
		throw new Error(`no ${entry.scene} tiles overlap the requested bounds`);
	}
	if (options.bounds !== undefined) {
		cells = clipCells(cells, surface, entry.leafLevel, options.bounds);
	}
	const mosaic = buildHeightMosaic(tiles, entry.leafLevel, cells);
	const world = terrainHeightsToWorld(mosaic.samples, surface);

	let minY = Infinity;
	let maxY = -Infinity;
	for (const y of world) {
		if (!Number.isNaN(y)) {
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
	}

	await mkdir(options.outDir, { recursive: true });
	await writeFile(join(options.outDir, 'heights.f32'), new Uint8Array(world.buffer));
	await writeFile(join(options.outDir, 'heights.png'), encodePng(normalizedPng(world, mosaic, minY, maxY)));
	await writeFile(
		join(options.outDir, 'preview.png'),
		encodePng(
			previewPng(world, mosaic, { minY, maxY, step: options.previewStep, heightScale: surface.heightScale }),
		),
	);

	const origin = terrainTileFootprint(surface, { level: entry.leafLevel, x: cells.minX, z: cells.minZ });
	const sourceCounts: Record<string, number> = {};
	for (const level of mosaic.sourceLevels) {
		const key = level < 0 ? 'none' : `L${level}`;
		sourceCounts[key] = (sourceCounts[key] ?? 0) + 1;
	}
	const metadata = {
		scene: entry.scene,
		surface: {
			...surface,
			inferred: resolved.inferred,
		},
		heightFormula: resolved.heightScaleKnown
			? 'y = position.y + h * heightScale / 32768; bit 15 = hole'
			: 'y = h / 32768, in units of the unknown heightScale; bit 15 = hole',
		files: {
			'heights.f32': 'little-endian float32 world Y per sample, NaN = hole or uncovered',
			'heights.png': '16-bit gray, minY..maxY → 1..65535, 0 = hole or uncovered',
			'preview.png': `8-bit RGB hillshade, 1 px per ${options.previewStep} samples; red = hole, blue = uncovered, green tint = cell from a coarser tile`,
		},
		grid: {
			width: mosaic.width,
			height: mosaic.height,
			metresPerSample: TERRAIN_LEAF_SIZE / 64,
			// sample (0, 0) sits on the minimum corner; rows advance along +Z, so north is down in the images
			firstSample: { x: origin.minX, z: origin.minZ },
			rowDirection: '+Z',
		},
		bounds: {
			minX: origin.minX,
			maxX: origin.minX + (cells.maxX - cells.minX) * TERRAIN_LEAF_SIZE,
			minZ: origin.minZ,
			maxZ: origin.minZ + (cells.maxZ - cells.minZ) * TERRAIN_LEAF_SIZE,
			minY,
			maxY,
		},
		leafCells: cells,
		tiles: Object.fromEntries(
			[...countLevels(tiles)].map(([level, list]) => [`L${level}`, list.length] as const),
		),
		cellSources: sourceCounts,
	};
	await writeFile(join(options.outDir, 'heights.json'), `${JSON.stringify(metadata, null, '\t')}\n`);
	console.log(JSON.stringify({ ...metadata, files: undefined }, null, 2));
	console.log(`wrote ${mosaic.width}×${mosaic.height} heights to ${options.outDir}`);
};

const clipCells = (cells: CellRange, surface: TerrainSurface, leafLevel: number, bounds: Rect): CellRange => {
	const size = surface.terrainSize / 2 ** leafLevel;
	return {
		minX: Math.max(cells.minX, Math.floor((bounds.minX - surface.position.x) / size)),
		minZ: Math.max(cells.minZ, Math.floor((bounds.minZ - surface.position.z) / size)),
		maxX: Math.min(cells.maxX, Math.ceil((bounds.maxX - surface.position.x) / size)),
		maxZ: Math.min(cells.maxZ, Math.ceil((bounds.maxZ - surface.position.z) / size)),
	};
};

const normalizedPng = (world: Float32Array, mosaic: HeightMosaic, minY: number, maxY: number) => {
	const data = new Uint16Array(world.length);
	const range = maxY - minY || 1;
	for (let i = 0; i < world.length; i++) {
		const y = world[i];
		data[i] = Number.isNaN(y) ? 0 : 1 + Math.round(((y - minY) / range) * 65_534);
	}
	return { width: mosaic.width, height: mosaic.height, color: 'gray', bitDepth: 16, data } as const;
};

const previewPng = (
	world: Float32Array,
	mosaic: HeightMosaic,
	options: { minY: number; maxY: number; step: number; heightScale: number },
) => {
	const { step } = options;
	const width = Math.ceil(mosaic.width / step);
	const height = Math.ceil(mosaic.height / step);
	const cellsX = mosaic.cells.maxX - mosaic.cells.minX;
	const data = new Uint8Array(width * height * 3);
	const range = options.maxY - options.minY || 1;
	// exaggerate relief when heights are only known up to scale
	const zScale = options.heightScale === 1 ? 500 : 1;
	const at = (x: number, z: number): number => {
		return world[Math.min(mosaic.height - 1, z) * mosaic.width + Math.min(mosaic.width - 1, x)];
	};

	for (let py = 0; py < height; py++) {
		for (let px = 0; px < width; px++) {
			const x = px * step;
			const z = py * step;
			const out = (py * width + px) * 3;
			const y = at(x, z);
			const cell =
				Math.floor(Math.min(z, mosaic.height - 2) / 64) * cellsX +
				Math.floor(Math.min(x, mosaic.width - 2) / 64);
			const source = mosaic.sourceLevels[cell];
			if (source < 0) {
				data.set([20, 30, 70], out);
				continue;
			}
			if (Number.isNaN(y)) {
				data.set([110, 20, 20], out);
				continue;
			}
			// lambert with light from (-X, +Y, -Z), i.e. the image's top left; NaN neighbours count as flat
			const dx = ((at(x + step, z) || y) - y) * zScale;
			const dz = ((at(x, z + step) || y) - y) * zScale;
			const length = Math.hypot(dx, dz, step);
			const shade = Math.max(0, (dx + dz + step) / (length * Math.sqrt(3)));
			const elevation = (y - options.minY) / range;
			const value = 255 * Math.min(1, 0.1 + 0.5 * elevation + 0.4 * shade);
			const coarse = source < mosaic.leafLevel;
			data.set([coarse ? value * 0.8 : value, value, coarse ? value * 0.8 : value], out);
		}
	}
	return { width, height, color: 'rgb', bitDepth: 8, data } as const;
};

// #endregion
