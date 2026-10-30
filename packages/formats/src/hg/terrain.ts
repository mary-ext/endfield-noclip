/**
 * Endfield terrain (`Data/Terrain/PC/<scene>/…`, VFS group `F84BF5E6`).
 *
 * every file is `u32 clearSize ‖ inverted-LZ4 block`, and the clear bytes are a 20-byte `TRET` header
 * followed by one texture's mip chain. tiles form a quadtree over the scene's terrain square; layers are
 * per-scene material textures that the renderer gathers into texture arrays by index.
 *
 * the layout and the height formula follow An1X3R/Endfield-map-extractor (`extractor_core/terrain.py`, MIT);
 * the property bindings and formats follow Variante/endfield_research_kit (`world_terrain.md`, MIT).
 *
 * @module
 */

import { BinaryReader, FormatError } from '../binary/binary-reader.ts';
import { imageByteLength, ktx2FormatInfo, type Ktx2FormatInfo } from '../binary/ktx2.ts';
import { graphicsFormatInfo } from '../unity/texture.ts';
import type { TypeTreeObject, TypeTreeValue } from '../unity/type-tree.ts';
import { arrayField, isObject, numberField, objectField, vector3Field } from '../unity/values.ts';

import { unpackHgPayload } from './payload.ts';

// #region TRET container

/** the Unity `GraphicsFormat` values that occur in terrain files; layouts come from the GraphicsFormat table */
export const TerrainFormat = {
	/** `LAYER_C` cone maps */
	R8_UNorm: 5,
	/** `_H` heights (read as little-endian u16) and `_C` cliff indices */
	R8G8_UNorm: 6,
	/** `_S` splat control */
	R8G8B8A8_UNorm: 8,
	/** `_T` tint */
	RGBA_DXT5_SRGB: 100,
	/** `_A` albedo and `_N` normal */
	RGBA_DXT5_UNorm: 101,
	/** `LAYER_D` diffuse */
	RGBA_BC7_SRGB: 108,
	/** `LAYER_N` normal */
	RGBA_BC7_UNorm: 109,
} as const;

export type TerrainFormat = (typeof TerrainFormat)[keyof typeof TerrainFormat];

const TERRAIN_FORMATS: ReadonlySet<number> = new Set(Object.values(TerrainFormat));

/** @returns whether `format` is one that occurs in terrain files */
export const isTerrainFormat = (format: number): format is TerrainFormat => {
	return TERRAIN_FORMATS.has(format);
};

/** @returns the texel layout of a terrain format */
const terrainFormatLayout = (format: TerrainFormat): Ktx2FormatInfo => {
	const info = ktx2FormatInfo(graphicsFormatInfo(format)?.vkFormat ?? -1);
	if (info === undefined) {
		throw new Error(`terrain format ${format} is missing from the GraphicsFormat table`);
	}
	return info;
};

/** one mip level, as stored (texels or 4×4 blocks, rows top to bottom as the file has them) */
export interface TerrainMip {
	level: number;
	width: number;
	height: number;
	/** view into the decoded file, not a copy */
	data: Uint8Array;
}

/** a decoded `TRET` file */
export interface TerrainTexture {
	format: TerrainFormat;
	width: number;
	height: number;
	/** mip levels, largest first; their byte ranges exactly tile the payload */
	mips: TerrainMip[];
	/** every mip back to back, as stored */
	payload: Uint8Array;
}

const TRET_MAGIC = 0x54_45_52_54; // 'TRET' read little-endian
const TRET_HEADER_SIZE = 20;

/**
 * strips the VFS envelope: a little-endian u32 clear size, then one inverted-LZ4 block. a few files (e.g.
 * `dung02_dg005/Layers/LAYER_C_3`) are stored without it and are returned as is.
 *
 * @param packed whole logical file as read from the VFS
 * @returns the clear `TRET` file; a view of `packed` when it was stored uncompressed
 * @throws {FormatError} if the envelope or the LZ4 stream is malformed
 */
export const unpackTerrainFile = (packed: Uint8Array): Uint8Array => {
	// a 1.4 GB clear size would be the only other reading of these bytes
	if (
		packed.length >= 4 &&
		new DataView(packed.buffer, packed.byteOffset, 4).getUint32(0, true) === TRET_MAGIC
	) {
		return packed;
	}
	return unpackHgPayload(packed);
};

/**
 * parses a clear `TRET` file.
 *
 * header (little-endian): `'TRET'`, u32 version (1), u16 width, u16 height, u16 mip count, u16
 * GraphicsFormat, u32 payload size. the mip count field is inferred from layer files, whose payloads are
 * exactly the sum of their mip chains.
 *
 * @param clear output of {@link unpackTerrainFile}; mips are views into it
 * @throws {FormatError} on a bad magic, version or format, or if the payload isn't exactly the mip chain
 */
export const parseTerrainTexture = (clear: Uint8Array): TerrainTexture => {
	const reader = new BinaryReader(clear, { littleEndian: true });
	if (clear.length < TRET_HEADER_SIZE || reader.u32() !== TRET_MAGIC) {
		throw new FormatError('not a TRET file');
	}
	const version = reader.u32();
	if (version !== 1) {
		throw new FormatError(`unsupported TRET version ${version}`);
	}
	const width = reader.u16();
	const height = reader.u16();
	const mipCount = reader.u16();
	const format = reader.u16();
	const payloadSize = reader.u32();
	if (!isTerrainFormat(format)) {
		throw new FormatError(`unknown TRET GraphicsFormat ${format}`);
	}
	if (width === 0 || height === 0 || mipCount === 0) {
		throw new FormatError(`empty TRET texture ${width}×${height}, ${mipCount} mips`);
	}
	if (payloadSize !== reader.remaining) {
		throw new FormatError(`TRET payload is ${reader.remaining} bytes, header says ${payloadSize}`);
	}

	const payload = reader.bytesView(payloadSize);
	const layout = terrainFormatLayout(format);
	const mips: TerrainMip[] = [];
	let offset = 0;
	for (let level = 0; level < mipCount; level++) {
		const mipWidth = Math.max(1, width >> level);
		const mipHeight = Math.max(1, height >> level);
		const size = imageByteLength(layout, mipWidth, mipHeight);
		if (offset + size > payloadSize) {
			throw new FormatError(`TRET mip ${level} overruns the ${payloadSize}-byte payload`);
		}
		mips.push({ level, width: mipWidth, height: mipHeight, data: payload.subarray(offset, offset + size) });
		offset += size;
	}
	if (offset !== payloadSize) {
		throw new FormatError(`TRET mip chain is ${offset} bytes, payload is ${payloadSize}`);
	}
	return { format, width, height, mips, payload };
};

/**
 * unpacks and parses one terrain file
 *
 * @param packed whole logical file as read from the VFS
 * @throws {FormatError} see {@link unpackTerrainFile} and {@link parseTerrainTexture}
 */
export const readTerrainTexture = (packed: Uint8Array): TerrainTexture => {
	return parseTerrainTexture(unpackTerrainFile(packed));
};

// #endregion

// #region paths

/**
 * tile channels and the shader property each one binds to:
 *
 * - `H` `_HeightmapAtlas`: 65² u16 heights
 * - `N` `_NormalmapAtlas`: baked normal page, DXT5
 * - `T` `_TintColorAtlas`: tint page, DXT5 sRGB
 * - `A` `_AlbedoAtlas`: baked albedo page, DXT5
 * - `S` `_SplatCtrlAtlas`: splat control page, RGBA8
 * - `C` `_CliffIndexAtlas`: 34² cliff index, R8G8
 *
 * pages are 132² with a 2-texel border around a 128² core covering the tile.
 */
export type TerrainTileChannel = 'H' | 'N' | 'T' | 'A' | 'S' | 'C';

/** layer roles: `D` diffuse → `_Splats`, `N` normal → `_Normals`, `C` cone map → `_ConeMaps` */
export type TerrainLayerRole = 'D' | 'N' | 'C';

/** a parsed terrain path */
export type TerrainPath =
	| {
			kind: 'tile';
			scene: string;
			level: number;
			x: number;
			z: number;
			channel: TerrainTileChannel;
	  }
	| {
			kind: 'layer';
			scene: string;
			role: TerrainLayerRole;
			/** texture-array slot, which `splatST.y` of a surface layer refers to */
			index: number;
	  };

const TILE_PATH = /^Data\/Terrain\/PC\/([^/]+)\/Terrain_(\d+)_(\d+)_(\d+)_([HNTASC])\.bytes$/;
const LAYER_PATH = /^Data\/Terrain\/PC\/([^/]+)\/Layers\/LAYER_([DNC])_(\d+)\.bytes$/;

/**
 * @param name logical VFS path
 * @returns the parsed path, or `undefined` for anything that isn't a terrain tile or layer
 */
export const parseTerrainPath = (name: string): TerrainPath | undefined => {
	const tile = TILE_PATH.exec(name);
	const channel = tile === null ? undefined : asTileChannel(tile[5]);
	if (tile !== null && channel !== undefined) {
		return {
			kind: 'tile',
			scene: tile[1],
			level: Number(tile[2]),
			x: Number(tile[3]),
			z: Number(tile[4]),
			channel,
		};
	}
	const layer = LAYER_PATH.exec(name);
	const role = layer === null ? undefined : asLayerRole(layer[2]);
	if (layer !== null && role !== undefined) {
		return { kind: 'layer', scene: layer[1], role, index: Number(layer[3]) };
	}
	return undefined;
};

const asTileChannel = (value: string): TerrainTileChannel | undefined => {
	switch (value) {
		case 'H':
		case 'N':
		case 'T':
		case 'A':
		case 'S':
		case 'C': {
			return value;
		}
	}
	return undefined;
};

const asLayerRole = (value: string): TerrainLayerRole | undefined => {
	switch (value) {
		case 'D':
		case 'N':
		case 'C': {
			return value;
		}
	}
	return undefined;
};

// #endregion

// #region surface and placement

/**
 * per-scene terrain parameters: the game's `HGTerrainSurfacesData` MonoBehaviour at
 * `assets/beyond/dynamicassets/scenes/pc/<scene>/terrain/hgterrainsurfacesdata.asset`, not in the tiles.
 */
export interface TerrainSurfacesData {
	/** world position of the terrain square's minimum corner; `y` is the height of a zero sample */
	position: { x: number; y: number; z: number };
	/** metres spanned by the full 15-bit height range */
	heightScale: number;
	/** edge length of the root square in metres; a power-of-two multiple of 64 */
	terrainSize: number;
	/** quadtree node table, when known; see {@link TerrainNode} */
	nodes?: TerrainNode[];
	/** the close-up material layers by ordinal (the splat index map's values), when known */
	layers?: TerrainLayer[];
}

/**
 * one `SplatLayerData` entry: a close-up material layer. four of them blend per 8 m cell; see
 * {@link readTerrainSplatIndex}
 */
export interface TerrainLayer {
	/** index of the layer's `LAYER_D`/`LAYER_N` textures (`splatST.y`) */
	texture: number;
	/** texture repeats across the whole terrain square (`splatST.x`); divide by its size for repeats per metre */
	tiling: number;
	/** uv offset (`splatST.zw`) */
	offset: [u: number, v: number];
	/** the layer's mean albedo, linear; the tint is applied relative to it (`packedSplatInfo.xyz`) */
	meanColor: [r: number, g: number, b: number];
	/** scales the normal map's xy (`packedSplatInfo.w`) */
	normalScale: number;
	/** multiplies the diffuse texture's rgb (`diffuseRemapScale.xyz`) */
	diffuseScale: [r: number, g: number, b: number];
	/** how far below the highest layer a layer still shows in the height blend (`diffuseRemapScale.w`) */
	blendBorder: number;
	/**
	 * `maskMapRemapScale` and `maskMapRemapOffset`: height (diffuse alpha) in z, occlusion (normal alpha) in y,
	 * roughness (normal blue) in w; x of the offset is a surface type id (`· 255`)
	 */
	maskScale: [x: number, y: number, z: number, w: number];
	maskOffset: [x: number, y: number, z: number, w: number];
}

/**
 * one `TerrainNodeData` entry. the table is a complete quadtree in breadth-first order down to the leaf
 * level, indexed by {@link terrainNodeIndex}, whether or not a node has tile files.
 *
 * checked against map02's tiles: `localMaxHeight` is the maximum of the node's samples with the hole bit
 * masked off, and `localMinHeight` counts holes as 0.
 */
export interface TerrainNode {
	/** the node's level; 0 for the root and for levels above the coarsest tiles */
	nodeLevel: number;
	/** index of the parent node */
	parent: number;
	allHole: boolean;
	/** metres above `position.y` */
	localMinHeight: number;
	/** metres above `position.y` */
	localMaxHeight: number;
	/** presumably the error of rendering this node instead of its children, metres; unverified */
	maxHeightError: number;
}

/** edge length of the finest tile, metres; the 65² height page then has 1 m spacing */
export const TERRAIN_LEAF_SIZE = 64;

/**
 * the hole flag of a height sample, which also makes the full 15-bit range: world Y is `position.y + (h &
 * 0x7fff) · heightScale / 32768`. holes keep a plausible height in their low bits, which suits skirts and
 * morphing but not rendering.
 */
export const TERRAIN_HEIGHT_HOLE = 0x80_00;

/**
 * a tile's address in the game's terrain quadtree. same shape as package-format's `TileKey`, but rooted at
 * the scene's terrain square rather than the package's tile tree (formats can't depend on package-format)
 */
export interface TerrainTileKey {
	level: number;
	x: number;
	z: number;
}

/** a tile's footprint in world space */
export interface TerrainTileFootprint {
	/** world X of the tile's minimum corner */
	minX: number;
	/** world Z of the tile's minimum corner */
	minZ: number;
	/** edge length, metres */
	size: number;
}

/**
 * level `l` splits the root square into `2^l × 2^l` tiles, `x` along world +X and `z` along world +Z.
 *
 * @param surface scene terrain parameters
 * @param tile quadtree address
 * @returns the tile's world footprint
 * @throws {RangeError} if the address lies outside the root square
 */
export const terrainTileFootprint = (
	surface: TerrainSurfacesData,
	tile: TerrainTileKey,
): TerrainTileFootprint => {
	const count = 2 ** tile.level;
	if (tile.x < 0 || tile.z < 0 || tile.x >= count || tile.z >= count) {
		throw new RangeError(`tile ${tile.level}/${tile.x}/${tile.z} is outside the ${count}² grid`);
	}
	const size = surface.terrainSize / count;
	return { minX: surface.position.x + tile.x * size, minZ: surface.position.z + tile.z * size, size };
};

/**
 * @param terrainSize root edge length, metres
 * @returns the level whose tiles are {@link TERRAIN_LEAF_SIZE} across
 * @throws {RangeError} if `terrainSize` isn't a power-of-two multiple of the leaf size
 */
export const terrainLeafLevel = (terrainSize: number): number => {
	const level = Math.log2(terrainSize / TERRAIN_LEAF_SIZE);
	if (!Number.isInteger(level) || level < 0) {
		throw new RangeError(`terrain size ${terrainSize} isn't a power-of-two multiple of ${TERRAIN_LEAF_SIZE}`);
	}
	return level;
};

/**
 * @returns the breadth-first index of a node in `TerrainNodeData`: all nodes of shallower levels, then
 *   row-major (`z` rows of `x`) within the level
 */
export const terrainNodeIndex = (tile: TerrainTileKey): number => {
	const side = 2 ** tile.level;
	return (side * side - 1) / 3 + tile.z * side + tile.x;
};

/** type-tree readers may or may not unwrap Unity's `Array` wrapper */
const listField = (object: TypeTreeObject, name: string): TypeTreeValue[] => {
	const value = object[name];
	return isObject(value) ? arrayField(value, 'Array') : arrayField(object, name);
};

const vector4Field = (parent: TypeTreeObject, name: string): [number, number, number, number] => {
	const value = objectField(parent, name);
	return [numberField(value, 'x'), numberField(value, 'y'), numberField(value, 'z'), numberField(value, 'w')];
};

/**
 * reads the fields this module needs from a type-tree-decoded `HGTerrainSurfacesData` object
 *
 * @param object the MonoBehaviour (`terrainPosition`, `heightScale`, `terrainSize`, optionally `nodeData` and
 *   `layerData`)
 * @throws {FormatError} if a required field is missing or has the wrong type
 */
export const readTerrainSurfacesData = (object: TypeTreeObject): TerrainSurfacesData => {
	const [x, y, z] = vector3Field(object, 'terrainPosition');
	const surface: TerrainSurfacesData = {
		position: { x, y, z },
		heightScale: numberField(object, 'heightScale'),
		terrainSize: numberField(object, 'terrainSize'),
	};
	terrainLeafLevel(surface.terrainSize);

	if (Object.hasOwn(object, 'layerData')) {
		surface.layers = listField(object, 'layerData').map((row, index): TerrainLayer => {
			if (!isObject(row)) {
				throw new FormatError(`HGTerrainSurfacesData.layerData[${index}] isn't an object`);
			}
			const st = vector4Field(row, 'splatST');
			const info = vector4Field(row, 'packedSplatInfo');
			const diffuse = vector4Field(row, 'diffuseRemapScale');
			if (!Number.isInteger(st[1]) || st[1] < 0) {
				throw new FormatError(`HGTerrainSurfacesData.layerData[${index}] has texture index ${st[1]}`);
			}
			return {
				texture: st[1],
				tiling: st[0],
				offset: [st[2], st[3]],
				meanColor: [info[0], info[1], info[2]],
				normalScale: info[3],
				diffuseScale: [diffuse[0], diffuse[1], diffuse[2]],
				blendBorder: diffuse[3],
				maskScale: vector4Field(row, 'maskMapRemapScale'),
				maskOffset: vector4Field(row, 'maskMapRemapOffset'),
			};
		});
	}

	if (Object.hasOwn(object, 'nodeData')) {
		const rows = listField(object, 'nodeData');
		surface.nodes = rows.map((row, index): TerrainNode => {
			if (!isObject(row)) {
				throw new FormatError(`HGTerrainSurfacesData.nodeData[${index}] isn't an object`);
			}
			return {
				nodeLevel: numberField(row, 'nodeLevel'),
				parent: numberField(row, 'parent'),
				allHole: numberField(row, 'allHole') !== 0,
				localMinHeight: numberField(row, 'localMinHeight'),
				localMaxHeight: numberField(row, 'localMaxHeight'),
				maxHeightError: numberField(row, 'maxHeightError'),
			};
		});
	}
	return surface;
};

// #endregion

// #region heights

/** edge length of a height page in samples */
export const TERRAIN_HEIGHT_PAGE_SIZE = 65;

/**
 * reads a `_H` tile's samples. each R8G8 texel is one little-endian u16; rows advance along world +Z, columns
 * along +X, and the outer samples lie on the tile's edges (shared with neighbours).
 *
 * @param texture a decoded `_H` file
 * @returns 65² raw samples; see {@link TERRAIN_HEIGHT_HOLE}
 * @throws {FormatError} if the texture isn't a 65² R8G8 page
 */
export const readTerrainHeightSamples = (texture: TerrainTexture): Uint16Array => {
	if (
		texture.format !== TerrainFormat.R8G8_UNorm ||
		texture.width !== TERRAIN_HEIGHT_PAGE_SIZE ||
		texture.height !== TERRAIN_HEIGHT_PAGE_SIZE
	) {
		throw new FormatError(
			`expected a 65² R8G8 height page, got ${texture.width}×${texture.height} format ${texture.format}`,
		);
	}
	const data = texture.mips[0].data;
	const samples = new Uint16Array(TERRAIN_HEIGHT_PAGE_SIZE * TERRAIN_HEIGHT_PAGE_SIZE);
	for (let i = 0; i < samples.length; i++) {
		samples[i] = data[i * 2] | (data[i * 2 + 1] << 8);
	}
	return samples;
};

/**
 * converts raw height samples to world-space Y: `position.y + h · heightScale / 32768`
 *
 * @param samples output of {@link readTerrainHeightSamples}
 * @param surface scene terrain parameters
 * @returns world Y per sample, `NaN` for holes
 */
export const terrainHeightsToWorld = (samples: Uint16Array, surface: TerrainSurfacesData): Float32Array => {
	const scale = surface.heightScale / TERRAIN_HEIGHT_HOLE;
	const out = new Float32Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		const h = samples[i];
		out[i] = (h & TERRAIN_HEIGHT_HOLE) !== 0 ? Number.NaN : surface.position.y + h * scale;
	}
	return out;
};

// #endregion

// #region baked pages

/** edge length of a baked page (`N`, `T`, `A`, `S`) in texels, border included */
export const TERRAIN_PAGE_SIZE = 132;

/** texels of each page edge outside the tile; the other 128 cover it edge to edge */
export const TERRAIN_PAGE_BORDER = 2;

/**
 * reads a baked `A` or `N` page's BC3 blocks.
 *
 * - `A`: rgb albedo, stored linear despite the format's name; a feeds the game's subsurface curvature, which
 *   the viewer doesn't use
 * - `N`: rg world-space normal x and z as `· 2 − 1`, y reconstructed as `√(1 − x² − z²)`; b perceptual
 *   roughness; a occlusion
 *
 * rows advance along world +Z like the height page's.
 *
 * @param texture a decoded `_A` or `_N` file
 * @returns the page's single level of BC3 blocks; a view into the texture
 * @throws {FormatError} if the texture isn't a one-level 132² DXT5 page
 */
export const readTerrainBc3Page = (texture: TerrainTexture): Uint8Array => {
	if (
		texture.format !== TerrainFormat.RGBA_DXT5_UNorm ||
		texture.width !== TERRAIN_PAGE_SIZE ||
		texture.height !== TERRAIN_PAGE_SIZE ||
		texture.mips.length !== 1
	) {
		throw new FormatError(
			`expected a one-level 132² DXT5 page, got ${texture.width}×${texture.height} format ${texture.format} with ${texture.mips.length} levels`,
		);
	}
	return texture.mips[0].data;
};

/**
 * reads a baked `S` page: splat control, the blend weights of the 4 layers its 8 m cell's index names. rgb
 * weight layers 0–2, layer 3 gets `1 − r − g − b`; a feeds the game's wetness. rows along +Z.
 *
 * @param texture a decoded `_S` file
 * @returns the page's 132² RGBA8 texels; a view into the texture
 * @throws {FormatError} if the texture isn't a one-level 132² RGBA8 page
 */
export const readTerrainControlPage = (texture: TerrainTexture): Uint8Array => {
	checkPage(texture, TerrainFormat.R8G8B8A8_UNorm, 'RGBA8');
	return texture.mips[0].data;
};

/**
 * reads a baked `T` page: rgb tint, applied to the layer blend as `(tint − mean) · a⁴`, `mean` being the
 * layers' blended {@link TerrainLayer.meanColor}. rows along +Z.
 *
 * @param texture a decoded `_T` file
 * @returns the page's BC3 sRGB blocks; a view into the texture
 * @throws {FormatError} if the texture isn't a one-level 132² sRGB DXT5 page
 */
export const readTerrainTintPage = (texture: TerrainTexture): Uint8Array => {
	checkPage(texture, TerrainFormat.RGBA_DXT5_SRGB, 'sRGB DXT5');
	return texture.mips[0].data;
};

const checkPage = (texture: TerrainTexture, format: TerrainFormat, label: string): void => {
	if (
		texture.format !== format ||
		texture.width !== TERRAIN_PAGE_SIZE ||
		texture.height !== TERRAIN_PAGE_SIZE ||
		texture.mips.length !== 1
	) {
		throw new FormatError(
			`expected a one-level 132² ${label} page, got ${texture.width}×${texture.height} format ${texture.format} with ${texture.mips.length} levels`,
		);
	}
};

/**
 * checks a `LAYER_D` or `LAYER_N` texture: a square BC7 mip chain. `D` is sRGB albedo with height in a; `N`
 * is linear, rg tangent-space normal xy (`· 2 − 1`), b roughness, a occlusion. rows advance along +v.
 *
 * @param texture a decoded layer file
 * @param role which layer texture it is
 * @throws {FormatError} if the texture isn't a square BC7 mip chain of the role's colour space
 */
export const checkTerrainLayerTexture = (texture: TerrainTexture, role: 'D' | 'N'): void => {
	const format = role === 'D' ? TerrainFormat.RGBA_BC7_SRGB : TerrainFormat.RGBA_BC7_UNorm;
	if (texture.format !== format || texture.width !== texture.height) {
		throw new FormatError(
			`expected a square ${role === 'D' ? 'sRGB ' : ''}BC7 layer texture, got ${texture.width}×${texture.height} format ${texture.format}`,
		);
	}
};

// #endregion

// #region splat index

/** metres per splat index cell; a leaf tile holds 8 × 8 cells */
export const TERRAIN_SPLAT_CELL = 8;

/**
 * reads the scene's splat index map (`terrain/splatindexmap.tga`, an RGBA32 Texture2D), which names the 4
 * layers each 8 m cell blends. each channel stores a layer ordinal times 4; row 0 is the terrain square's
 * minimum z.
 *
 * @param data the texture's level 0, RGBA8 texels
 * @param side texels per edge, `terrainSize / 8`
 * @param layerCount layers the scene has
 * @returns 4 ordinals per cell, row-major from the minimum corner
 * @throws {FormatError} if the size disagrees or a value isn't a multiple of 4 naming a known layer
 */
export const readTerrainSplatIndex = (data: Uint8Array, side: number, layerCount: number): Uint8Array => {
	if (data.length !== side * side * 4) {
		throw new FormatError(`splat index has ${data.length} bytes, expected ${side}² RGBA8 texels`);
	}
	const out = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i++) {
		const value = data[i];
		if (value % 4 !== 0 || value / 4 >= layerCount) {
			throw new FormatError(`splat index value ${value} at ${i} doesn't name one of ${layerCount} layers`);
		}
		out[i] = value / 4;
	}
	return out;
};

// #endregion
