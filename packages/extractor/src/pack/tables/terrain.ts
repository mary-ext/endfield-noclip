// terrain: every kept tile's height page, baked surface page and (leaves) close-up splat page, plus the
// scene's layer textures. the whole step is remembered in the pack cache, keyed by this module's code and the
// content md5s of every file it reads, so a warm pack commits the cached blobs without reading the terrain.

import {
	checkTerrainLayerTexture,
	readTerrainBc3Page,
	readTerrainControlPage,
	readTerrainHeightSamples,
	readTerrainTexture,
	readTerrainTintPage,
	TERRAIN_HEIGHT_HOLE,
	TERRAIN_HEIGHT_PAGE_SIZE,
	TERRAIN_LEAF_SIZE,
	TERRAIN_PAGE_BORDER,
	TERRAIN_PAGE_SIZE,
	TERRAIN_SPLAT_CELL,
	terrainLeafLevel,
	type TerrainSurfacesData,
} from '@endfield-noclip/formats/hg/terrain';
import { BlobKind } from '@endfield-noclip/package-format/blobs';
import {
	encodeHeightPage,
	encodeSplatPage,
	encodeSurfacePage,
	isTerrainHole,
	TERRAIN_HOLE_BIT,
	TERRAIN_LEAF_METRES,
	TERRAIN_PAGE_SAMPLES,
	TERRAIN_SPLAT_CELL_METRES,
	TERRAIN_SPLAT_CELLS,
	TERRAIN_SURFACE_BORDER,
	TERRAIN_SURFACE_TEXELS,
	type TerrainInfo,
	terrainHeight,
	type TerrainSplatInfo,
} from '@endfield-noclip/package-format/terrain';
import { type TileKey, tileFootprint } from '@endfield-noclip/package-format/tiles';
import type { TreeInfo } from '@endfield-noclip/package-format/tree';
import type { Bounds } from '@endfield-noclip/package-format/values';

import { unique } from '@mary-ext/array-fns';

import type { Context } from '../../context.ts';
import {
	findTerrainSplatIndex,
	loadTerrainSplatIndex,
	type TerrainSceneIndex,
	type TerrainTileFiles,
} from '../../game/world/terrain-source.ts';
import type { VfsFile } from '../../hg/vfs.ts';
import type { BlobMeta } from '../store/blob-file.ts';
import { type BlobStore, type PutOptions, tileLocality } from '../store/blob-store.ts';
import type { PackCache, StepMemo } from '../store/pack-cache.ts';

/** tiles read and compressed at once; bounds memory */
const TILE_BATCH = 64;

/**
 * the game's terrain layout against the package's, which stores the game's pages as they are
 *
 * @throws {Error} if they differ: the package format would need a new version to carry the game's
 */
const checkTerrainLayout = (): void => {
	const pairs: [name: string, game: number, packaged: number][] = [
		['leaf size', TERRAIN_LEAF_SIZE, TERRAIN_LEAF_METRES],
		['height page side', TERRAIN_HEIGHT_PAGE_SIZE, TERRAIN_PAGE_SAMPLES],
		['hole bit', TERRAIN_HEIGHT_HOLE, TERRAIN_HOLE_BIT],
		['surface page side', TERRAIN_PAGE_SIZE, TERRAIN_SURFACE_TEXELS],
		['surface page border', TERRAIN_PAGE_BORDER, TERRAIN_SURFACE_BORDER],
		['splat cell size', TERRAIN_SPLAT_CELL, TERRAIN_SPLAT_CELL_METRES],
	];
	for (const [name, game, packaged] of pairs) {
		if (game !== packaged) {
			throw new Error(`the game's terrain ${name} is ${game}, but the package format's is ${packaged}`);
		}
	}
};

/**
 * layer texture levels skipped from the top: the game's 1024² textures repeat every 2–9 m, so 512² still
 * gives 57–230 texels per metre, at a quarter of the size
 */
const TERRAIN_LAYER_SKIP = 1;

/** what {@link packTerrain} needs */
export interface TerrainInput {
	scene: string;
	terrainScene: TerrainSceneIndex;
	surface: TerrainSurfacesData;
	terrain: Pick<TerrainInfo, 'baseHeight' | 'heightScale'>;
	grid: Pick<TreeInfo, 'origin' | 'rootSize'>;
	/** whether the package's subset keeps a tile */
	includesTile: (key: TileKey) => boolean;
	/** the archive group of a tile's pages */
	stemOf: (key: TileKey) => string;
	/** the archive group of the layer textures */
	layerStem: string;
	/** zstd level of height and splat pages */
	zstdLevel: number;
	/** zstd level of block-compressed texels: surface pages and layer textures */
	textureZstdLevel: number;
	log: (line: string) => void;
}

/** one kept tile's blobs */
export interface PackedTerrainTile {
	key: TileKey;
	heights: number;
	/** `null` when the tile misses its albedo or normal page */
	surface: number | null;
	/** `null` off the leaf level, or when the leaf misses its control or tint page, or the layers didn't pack */
	splat: number | null;
	/** the tile's footprint between its lowest and highest non-hole sample */
	bounds: Bounds;
}

/** what {@link packTerrain} stored */
export interface PackedTerrain {
	tiles: PackedTerrainTile[];
	/** levels that have height pages, ascending */
	levels: number[];
	/** the close-up blend's section, `null` when the scene's layers can't be packed */
	splat: TerrainSplatInfo | null;
	debug: TerrainDebug;
}

/** what the terrain step left out, for the pack report and `debug/terrain.json`; tiles are `level/x/z` */
export interface TerrainDebug {
	/** tiles the subset keeps */
	tiles: number;
	/** kept tiles without a surface page, because they miss their albedo or normal page */
	withoutSurface: string[];
	/**
	 * kept leaves without a splat page, because they miss their control or tint page; every leaf when
	 * {@link layerProblem} is set
	 */
	leavesWithoutSplat: string[];
	/** channel pages of the scene's tiles that have no height page, as `level/x/z channel` */
	orphanPages: string[];
	/** why the scene's layer textures, and with them the close-up blend, weren't packed; `null` if they were */
	layerProblem: string | null;
}

/** what the pack cache remembers of this step besides the blobs */
interface TerrainMemo {
	/** in blob order: each tile's heights, then its surface and splat pages when it has them */
	tiles: { key: TileKey; minY: number; maxY: number; surface: boolean; splat: boolean }[];
	/** the splat section without its blob indices; the layer textures' blobs follow the tiles', D then N each */
	splat: Omit<TerrainSplatInfo, 'diffuse' | 'normal'> | null;
	/** why the layers didn't pack, logged again on a cache hit */
	layerProblem: string | null;
}

/**
 * stores the subset's terrain. a tile missing its albedo or normal page gets no surface page; a leaf missing
 * its control or tint page gets no splat page. both are listed in the result's debug section
 *
 * @param context VFS, world index and asset resolver
 * @param store where the blobs go
 * @param cache the pack cache, or `null`; its blob directory must be the store's
 * @param input the scene's terrain and the packer's placement hooks
 * @returns every kept tile's blobs, ordered by level, z, x, and the splat section
 * @throws {Error} if the game's page layout isn't the package format's
 */
export const packTerrain = async (
	context: Pick<Context, 'vfs' | 'world' | 'resolver'>,
	store: BlobStore,
	cache: PackCache | null,
	input: TerrainInput,
): Promise<PackedTerrain> => {
	checkTerrainLayout();
	const { terrainScene, surface } = input;
	const tiles = [...terrainScene.tiles.values()]
		.filter(({ key }) => input.includesTile(key))
		.toSorted((a, b) => a.key.level - b.key.level || a.key.z - b.key.z || a.key.x - b.key.x);
	const splatIndex = await findTerrainSplatIndex(context, input.scene);
	const layerFiles = layerTextureFiles(terrainScene, surface);

	const key =
		cache === null
			? null
			: await cache.stepKey(new URL(import.meta.url), {
					scene: input.scene,
					zstdLevel: input.zstdLevel,
					textureZstdLevel: input.textureZstdLevel,
					surface,
					splatIndex: splatIndex?.bundleMd5 ?? null,
					layers: Array.isArray(layerFiles) ? layerFiles.map(({ D, N }) => [md5(D), md5(N)]) : layerFiles,
					tiles: tiles.map(tileSources),
				});
	let memo = key === null ? undefined : await cache?.recallStep<TerrainMemo>(key);
	if (memo === undefined) {
		memo = await convertTerrain(context, store, input, tiles, layerFiles, splatIndex);
		if (key !== null) {
			await cache?.rememberStep(key, memo);
		}
	}
	if (memo.value.layerProblem !== null) {
		input.log(`terrain splat: ${input.scene} ${memo.value.layerProblem}`);
	}

	// commit in memo order: tiles, then layer textures
	let next = 0;
	const commit = (kind: BlobKind, stem: string, locality: string | null): number =>
		store.commit({ meta: memo.blobs[next++], options: { kind, stem, locality } });
	const packed = memo.value.tiles.map(({ key: tile, minY, maxY, surface: hasSurface, splat: hasSplat }) => {
		const stem = input.stemOf(tile);
		const locality = tileLocality(tile);
		const { minX, minZ, size } = tileFootprint(input.grid, tile);
		return {
			key: tile,
			heights: commit(BlobKind.TerrainHeights, stem, locality),
			surface: hasSurface ? commit(BlobKind.TerrainSurface, stem, locality) : null,
			splat: hasSplat ? commit(BlobKind.TerrainSplat, stem, locality) : null,
			bounds: { min: [minX, minY, minZ], max: [minX + size, maxY, minZ + size] },
		} satisfies PackedTerrainTile;
	});
	let splat: TerrainSplatInfo | null = null;
	if (memo.value.splat !== null) {
		const diffuse: number[] = [];
		const normal: number[] = [];
		while (next < memo.blobs.length) {
			diffuse.push(commit(BlobKind.TerrainLayer, input.layerStem, null));
			normal.push(commit(BlobKind.TerrainLayer, input.layerStem, null));
		}
		splat = { ...memo.value.splat, diffuse, normal };
	}
	const leafLevel = terrainLeafLevel(surface.terrainSize);
	const debug: TerrainDebug = {
		tiles: memo.value.tiles.length,
		withoutSurface: memo.value.tiles.filter((tile) => !tile.surface).map((tile) => tileId(tile.key)),
		leavesWithoutSplat: memo.value.tiles
			.filter((tile) => tile.key.level === leafLevel && !tile.splat)
			.map((tile) => tileId(tile.key)),
		orphanPages: terrainScene.orphanPages,
		layerProblem: memo.value.layerProblem,
	};
	return { tiles: packed, levels: unique(tiles.map(({ key: tile }) => tile.level)), splat, debug };
};

/** @returns a tile key as `level/x/z`, the form the terrain index keys tiles by */
const tileId = ({ level, x, z }: TileKey): string => `${level}/${x}/${z}`;

/** @returns a VFS file's content md5 */
const md5 = (file: VfsFile): string => file.entry.dataMd5;

/** @returns what a tile's pages are made from, for the cache key */
const tileSources = ({ key, file, channels }: TerrainTileFiles): (string | number | null)[] => [
	key.level,
	key.x,
	key.z,
	md5(file),
	...(['A', 'N', 'S', 'T'] as const).map((channel) => {
		const source = channels[channel];
		return source === undefined ? null : md5(source);
	}),
];

/**
 * @returns the diffuse and normal file of each layer texture the layer table names, or why they can't be
 *   packed
 */
const layerTextureFiles = (
	terrainScene: TerrainSceneIndex,
	surface: TerrainSurfacesData,
): { D: VfsFile; N: VfsFile }[] | string => {
	const { layers } = surface;
	if (layers === undefined || layers.length === 0) {
		return 'has no terrain layers';
	}
	const textureCount = Math.max(...layers.map((layer) => layer.texture)) + 1;
	const files: { D: VfsFile; N: VfsFile }[] = [];
	for (let texture = 0; texture < textureCount; texture++) {
		const diffuse = terrainScene.layers.D.get(texture);
		const normal = terrainScene.layers.N.get(texture);
		if (diffuse === undefined || normal === undefined) {
			return `is missing layer texture ${texture}`;
		}
		files.push({ D: diffuse, N: normal });
	}
	return files;
};

/** compression for a page; placement is decided when the page is committed */
const pageOptions = (kind: BlobKind, zstdLevel: number): PutOptions => ({
	kind,
	compress: true,
	zstdLevel,
	stem: '',
	locality: null,
});

/** reads, encodes and compresses the terrain into the store's directory, without committing anything */
const convertTerrain = async (
	context: Pick<Context, 'vfs' | 'resolver'>,
	store: BlobStore,
	input: TerrainInput,
	tiles: readonly TerrainTileFiles[],
	layerFiles: { D: VfsFile; N: VfsFile }[] | string,
	splatIndex: Awaited<ReturnType<typeof findTerrainSplatIndex>>,
): Promise<StepMemo<TerrainMemo>> => {
	const { surface, terrain } = input;
	const memo: StepMemo<TerrainMemo> = { blobs: [], value: { tiles: [], splat: null, layerProblem: null } };
	const readTexture = async (file: VfsFile) => readTerrainTexture(await context.vfs.readVerified(file));
	const readPage = async (file: VfsFile): Promise<Uint8Array> => readTerrainBc3Page(await readTexture(file));

	const layers = await convertLayers(context, store, input, layerFiles, splatIndex);
	if (typeof layers === 'string') {
		memo.value.layerProblem = layers;
	}
	const leafLevel = terrainLeafLevel(surface.terrainSize);
	const indexSide = surface.terrainSize / TERRAIN_SPLAT_CELL_METRES;
	const cells = TERRAIN_SPLAT_CELLS;
	/** the 4 ordinals of a leaf's cells, cut from the scene's index map */
	const leafIndex = (index: Uint8Array, key: TileKey): Uint8Array => {
		const out = new Uint8Array(cells * cells * 4);
		for (let row = 0; row < cells; row++) {
			const from = ((key.z * cells + row) * indexSide + key.x * cells) * 4;
			out.set(index.subarray(from, from + cells * 4), row * cells * 4);
		}
		return out;
	};
	for (let start = 0; start < tiles.length; start += TILE_BATCH) {
		// oxlint-disable-next-line no-await-in-loop -- batches bound memory
		const batch = await Promise.all(
			tiles.slice(start, start + TILE_BATCH).map(async ({ key, file, channels }) => {
				const samples = readTerrainHeightSamples(await readTexture(file));
				const heights = store.prepare(
					encodeHeightPage(samples, TERRAIN_PAGE_SAMPLES),
					pageOptions(BlobKind.TerrainHeights, input.zstdLevel),
				);
				let page: Promise<{ meta: BlobMeta }> | null = null;
				if (channels.A !== undefined && channels.N !== undefined) {
					const [albedo, normal] = await Promise.all([readPage(channels.A), readPage(channels.N)]);
					page = store.prepare(
						encodeSurfacePage({ side: TERRAIN_SURFACE_TEXELS, albedo, normal }),
						// block-compressed texels, so the texture level: higher levels barely shrink them
						pageOptions(BlobKind.TerrainSurface, input.textureZstdLevel),
					);
				}
				let splat: Promise<{ meta: BlobMeta }> | null = null;
				if (
					typeof layers !== 'string' &&
					key.level === leafLevel &&
					channels.S !== undefined &&
					channels.T !== undefined
				) {
					const [control, tint] = await Promise.all([readTexture(channels.S), readTexture(channels.T)]);
					splat = store.prepare(
						encodeSplatPage({
							side: TERRAIN_SURFACE_TEXELS,
							cells,
							control: readTerrainControlPage(control),
							tint: readTerrainTintPage(tint),
							index: leafIndex(layers.index, key),
						}),
						pageOptions(BlobKind.TerrainSplat, input.zstdLevel),
					);
				}
				const [y0, y1] = heightRange(terrain, samples);
				return { key, y0, y1, heights: await heights, page: await page, splat: await splat };
			}),
		);
		for (const { key, y0, y1, heights, page, splat } of batch) {
			memo.blobs.push(heights.meta);
			if (page !== null) {
				memo.blobs.push(page.meta);
			}
			if (splat !== null) {
				memo.blobs.push(splat.meta);
			}
			memo.value.tiles.push({ key, minY: y0, maxY: y1, surface: page !== null, splat: splat !== null });
		}
	}
	if (typeof layers !== 'string') {
		memo.blobs.push(...layers.blobs);
		memo.value.splat = layers.info;
	}
	return memo;
};

/**
 * @returns the world heights of a page's lowest and highest non-hole samples (the base height if all are
 *   holes)
 */
const heightRange = (
	terrain: Pick<TerrainInfo, 'baseHeight' | 'heightScale'>,
	samples: Uint16Array,
): [min: number, max: number] => {
	let min = Infinity;
	let max = -Infinity;
	for (const sample of samples) {
		if (!isTerrainHole(sample)) {
			min = Math.min(min, sample);
			max = Math.max(max, sample);
		}
	}
	const base = terrain.baseHeight;
	return [
		min === Infinity ? base : terrainHeight(terrain, min),
		max === -Infinity ? base : terrainHeight(terrain, max),
	];
};

/**
 * stores the scene's layer textures (uncommitted) and reads its splat index map
 *
 * @returns the splat section without blob indices, the index map and the texture blobs (D then N per
 *   texture), or why the layers can't be packed
 */
const convertLayers = async (
	context: Pick<Context, 'vfs' | 'resolver'>,
	store: BlobStore,
	input: TerrainInput,
	files: { D: VfsFile; N: VfsFile }[] | string,
	splatIndex: Awaited<ReturnType<typeof findTerrainSplatIndex>>,
): Promise<{ info: NonNullable<TerrainMemo['splat']>; index: Uint8Array; blobs: BlobMeta[] } | string> => {
	const { surface } = input;
	const { layers } = surface;
	if (typeof files === 'string') {
		return files;
	}
	if (layers === undefined || splatIndex === undefined) {
		return 'has no splat index map';
	}
	const index = await loadTerrainSplatIndex(context, { ...surface, layers }, splatIndex);

	let size = 0;
	let levels = 0;
	/** @returns the texture's levels from the first packed one, concatenated */
	const levelsOf = async (file: VfsFile, role: 'D' | 'N'): Promise<Uint8Array | string> => {
		const texture = readTerrainTexture(await context.vfs.readVerified(file));
		checkTerrainLayerTexture(texture, role);
		const kept = texture.mips.slice(TERRAIN_LAYER_SKIP);
		if (kept.length === 0) {
			return `has ${texture.mips.length} levels`;
		}
		if (size === 0) {
			size = kept[0].width;
			levels = kept.length;
		} else if (kept[0].width !== size || kept.length !== levels) {
			return `is ${kept[0].width}² with ${kept.length} levels, unlike the others' ${size}² with ${levels}`;
		}
		const out = new Uint8Array(kept.reduce((sum, mip) => sum + mip.data.length, 0));
		let at = 0;
		for (const mip of kept) {
			out.set(mip.data, at);
			at += mip.data.length;
		}
		return out;
	};
	const blobs: BlobMeta[] = [];
	for (const [texture, pair] of files.entries()) {
		for (const role of ['D', 'N'] as const) {
			// oxlint-disable-next-line no-await-in-loop -- one texture's levels at a time bounds memory
			const raw = await levelsOf(pair[role], role);
			if (typeof raw === 'string') {
				return `layer texture ${role} ${texture} ${raw}`;
			}
			// oxlint-disable-next-line no-await-in-loop
			const prepared = await store.prepare(raw, {
				kind: BlobKind.TerrainLayer,
				compress: true,
				zstdLevel: input.textureZstdLevel,
				stem: input.layerStem,
				locality: null,
			});
			blobs.push(prepared.meta);
		}
	}
	return {
		index,
		blobs,
		info: {
			layers: layers.map((layer) => ({
				texture: layer.texture,
				tiling: layer.tiling / surface.terrainSize,
				offset: layer.offset,
				meanColor: layer.meanColor,
				normalScale: layer.normalScale,
				diffuseScale: layer.diffuseScale,
				blendBorder: layer.blendBorder,
				height: [layer.maskScale[2], layer.maskOffset[2]],
				occlusion: [layer.maskScale[1], layer.maskOffset[1]],
				roughness: [layer.maskScale[3], layer.maskOffset[3]],
			})),
			textureSize: size,
			textureLevels: levels,
		},
	};
};
