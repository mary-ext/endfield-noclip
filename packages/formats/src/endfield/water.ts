import { FormatError } from '../binary/binary-reader.ts';
import { toPlainObject } from '../unity/plain-object.ts';
import type { TypeTreeNode } from '../unity/serialized-file.ts';
import type { TypeTreeObject } from '../unity/type-tree.ts';
import {
	arrayField,
	asPPtr,
	booleanField,
	numberField,
	objectField,
	pptrField,
	stringField,
	type Aabb,
	type PPtr,
} from '../unity/values.ts';

import { groupBounds, groupColumn, groupNames, type InitChunk } from './init-chunk-data.ts';
import { levelTagOf } from './level-partition.ts';
import { assetProperty, type StreamingChunk } from './streaming-chunk-data.ts';

// open-world water (docs/game-data/water.md#game-data). three sources join here:
// - InitChunkData component 30 (104 bytes) places each water surface: `u32 render type mask, i32 runtime mesh
//   id, f32×16 object-to-world, f32×4 param0, f32×4 param1`, beside bounds, name and an unread 24-byte
//   column 7. every surface sits in a Global chunk.
// - the same id's StreamingChunkData record binds the surface mesh (key 0xff000000) and its `WaterConfig`
//   MonoBehaviour asset (key 0xff010000).
// - a kind-1 `Water#<tag>_…` object per level binds the scene's `Global_Water_Config` asset (key 0x20000000,
//   the HGWaterGlobalConfig component); that config holds the flow/caustic/normal textures and the sector grid.
// the component layout is ported from An1X3R/Endfield-map-extractor (MIT, `extractor_core/water.py`).

// #region types

/** InitChunkData descriptor id of the water surface component */
export const WATER_SURFACE_COMPONENT = 30;
const WATER_SURFACE_STRIDE = 104;

/**
 * StreamingChunkData property keys of water bindings. the 0xff keys are only meaningful on water surface
 * entities: other entity archetypes reuse them (rect decals bind their material under 0xff010000)
 */
export const WaterProperty = {
	/** surface mesh: `<container>.fbx##<subasset>` or a `PolygonMeshes/*.asset` Mesh */
	SurfaceMesh: 0xff000000,
	/** surface `WaterConfig` MonoBehaviour asset */
	SurfaceConfig: 0xff010000,
	/** the scene's global water config asset, on the per-level `Water` object */
	GlobalConfig: 0x20000000,
} as const;

/** a placed water surface */
export interface WaterSurface {
	/** full 32-bit entity id */
	id: number;
	/** `id >>> 27`, the owning level's namespace */
	levelTag: number;
	name: string;
	/** non-zero bit mask of the game's `HGWaterRenderType` (1 `Proxy`, 2 `LOD`); 1 or 2 in the data */
	renderTypeMask: number;
	/** always 0: the game fills it in at load */
	runtimeMeshId: number;
	/** 4×4 column-major object-to-world matrix */
	matrix: Float32Array;
	/** world bounds */
	bounds: Aabb;
	/** (material index, 0, 0, 0); the game fills the index in at load, so it's 0 here */
	param0: [number, number, number, number];
	/**
	 * (wetness offset (m), height layer 0–3, 1 to sort by distance, 1 to wet the ground around it); see
	 * `docs/game-data/water.md#placements-initchunkdata-component-30`
	 */
	param1: [number, number, number, number];
	/** StringPathHash key of the surface mesh */
	meshHash: bigint;
	/** StringPathHash key of the surface `WaterConfig` asset */
	configHash: bigint;
}

/** the per-level object that binds the global water config */
export interface WaterGlobalBinding {
	id: number;
	levelTag: number;
	name: string;
	/** StringPathHash key of the `Global_Water_Config` asset */
	configHash: bigint;
}

// #endregion

// #region placements

/**
 * decodes every water surface of a chunk pair
 *
 * @param init parsed InitChunkData
 * @param streaming the parsed StreamingChunkData of the same scene, cell, layer and state
 * @returns the surfaces, in Init group order
 * @throws {FormatError} if a surface column is malformed or a surface lacks its mesh or config binding
 */
export const readWaterSurfaces = (init: InitChunk, streaming: StreamingChunk): WaterSurface[] => {
	const records = new Map(streaming.records.map((record) => [record.id, record]));
	const names = new Map(init.objects.map((object) => [object.id, object.name]));
	const surfaces: WaterSurface[] = [];
	for (const group of init.groups) {
		const water = groupColumn(group, WATER_SURFACE_COMPONENT);
		if (water === undefined) {
			continue;
		}
		if (water.stride !== WATER_SURFACE_STRIDE) {
			throw new FormatError(
				`water surface column has stride ${water.stride}, expected ${WATER_SURFACE_STRIDE}`,
			);
		}
		const boundsOf = groupBounds(group);
		if (boundsOf === null) {
			throw new FormatError('a water surface group has no bounds columns');
		}
		const nameOf = groupNames(group, names);
		const view = new DataView(group.blob.buffer, group.blob.byteOffset, group.blob.byteLength);

		for (let i = 0; i < group.ids.length; i++) {
			const id = group.ids[i];
			const at = water.offset + i * water.stride;
			const f32 = (offset: number): number => view.getFloat32(at + offset, true);
			const vec4 = (offset: number): [number, number, number, number] => [
				f32(offset),
				f32(offset + 4),
				f32(offset + 8),
				f32(offset + 12),
			];

			const renderTypeMask = view.getUint32(at, true);
			const matrix = new Float32Array(Array.from({ length: 16 }, (_, k) => f32(8 + k * 4)));
			const param0 = vec4(72);
			const param1 = vec4(88);
			if (renderTypeMask === 0 || ![...matrix, ...param0, ...param1].every(Number.isFinite)) {
				throw new FormatError(`water surface ${id} has an empty render mask or non-finite values`);
			}

			const record = records.get(id);
			if (record === undefined) {
				throw new FormatError(`water surface ${id} has no streaming record`);
			}
			const meshHash = assetProperty(record, WaterProperty.SurfaceMesh);
			const configHash = assetProperty(record, WaterProperty.SurfaceConfig);
			if (meshHash === undefined || configHash === undefined) {
				throw new FormatError(`water surface ${id} lacks its mesh or config binding`);
			}

			surfaces.push({
				id,
				levelTag: levelTagOf(id),
				name: nameOf(i),
				renderTypeMask,
				runtimeMeshId: view.getInt32(at + 4, true),
				matrix,
				bounds: boundsOf(i),
				param0,
				param1,
				meshHash,
				configHash,
			});
		}
	}
	return surfaces;
};

/**
 * finds the objects that bind a global water config
 *
 * @param init parsed InitChunkData
 * @param streaming its StreamingChunkData
 * @returns one binding per such object, in streaming record order
 * @throws {FormatError} if an object binds the config twice
 */
export const readWaterGlobalBindings = (init: InitChunk, streaming: StreamingChunk): WaterGlobalBinding[] => {
	const names = new Map(init.objects.map((object) => [object.id, object.name]));
	const bindings: WaterGlobalBinding[] = [];
	for (const record of streaming.records) {
		const configHash = assetProperty(record, WaterProperty.GlobalConfig);
		if (configHash !== undefined) {
			bindings.push({
				id: record.id,
				levelTag: levelTagOf(record.id),
				name: names.get(record.id) ?? '',
				configHash,
			});
		}
	}
	return bindings;
};

// #endregion

// #region config assets

/** a surface `WaterConfig` MonoBehaviour, reduced to its numeric parameters */
export interface WaterSurfaceConfig {
	name: string;
	/**
	 * every top-level numeric field by its serialized name; flags stay 0/1 numbers, Unity's math structs become
	 * arrays (`[x, y(, z, w)]`, `[r, g, b, a]`, see `unity/plain-object.ts`)
	 */
	values: Record<string, number | number[]>;
}

/**
 * @param nodes the MonoBehaviour's flattened TypeTree
 * @param value a decoded surface `WaterConfig` MonoBehaviour
 * @returns its name and numeric fields; `m_*` header fields and other fields are dropped
 * @throws {FormatError} if it has no `m_Name` or doesn't match the tree
 */
export const readWaterSurfaceConfig = (
	nodes: readonly TypeTreeNode[],
	value: TypeTreeObject,
): WaterSurfaceConfig => {
	const plain = toPlainObject(nodes, value, {
		keepPPtr: () => false,
		dropField: (name) => name.startsWith('m_'),
	}).value;
	const values: Record<string, number | number[]> = {};
	for (const [key, field] of Object.entries(plain)) {
		if (typeof field === 'boolean') {
			// a `UInt8` flag; keep its stored number
			values[key] = numberField(value, key);
		} else if (typeof field === 'number' || (Array.isArray(field) && field.length <= 4)) {
			values[key] = field;
		}
	}
	return { name: stringField(value, 'm_Name'), values };
};

/**
 * @param value a decoded MonoBehaviour from the water data
 * @returns whether it's a `Global_Water_Config` (rather than a surface `WaterConfig`)
 */
export const isWaterGlobalConfig = (value: TypeTreeObject): boolean => Object.hasOwn(value, 'hgWaterConfigs');

/** one flow-map sector of the global water grid */
export interface WaterSector {
	/** sector coordinates; the sector covers world `[x, x + 1) × [z, z + 1)` sector sizes past the scene centre */
	x: number;
	z: number;
	/** asset path of the sector MonoBehaviour (its `waterSectorTexture0` is a flow-map tile) */
	path: string;
	/** `sectorDataAssetHashes` entry, as an unsigned 64-bit key */
	assetHash: bigint;
}

/** a `Global_Water_Config` MonoBehaviour */
export interface WaterGlobalConfig {
	name: string;
	scenePath: string;
	/** world xz the water grid is centred on */
	sceneCenterOffset: [number, number];
	/** world size of the square grid, metres */
	mapSize: number;
	/** world size of one sector, metres */
	sectorSize: number;
	/** metres per texel of a sector flow map */
	flowmapPrecision: number;
	useSectorData: boolean;
	/** the sectors that have data (`sectorDataExists`), in serialized order */
	sectors: WaterSector[];
	/** water-mesh LOD grid parameters, by serialized name (`lodNum`, `meshNumPerLOD`, `meshSize`, `heightMap*`) */
	grid: Record<string, number>;
	/** the surface configs this scene uses, indexed by their `materialIndex` */
	surfaceConfigs: PPtr[];
	/** RG flow direction, B foam, A amplitude over the whole grid */
	flowMap: PPtr;
	causticMap: PPtr;
	rainMap: PPtr;
	/** Texture2DArray of wave normals */
	normalMapArray: PPtr;
}

const GRID_FIELDS = ['lodNum', 'meshNumPerLOD', 'meshSize', 'heightMapXZ', 'heightMapY', 'heightMapOffset'];
const SECTOR_NAME = /\/T_(-?\d+)_(-?\d+)\.asset$/i;

/**
 * @param value a decoded `Global_Water_Config` MonoBehaviour
 * @returns its fields
 * @throws {FormatError} if a field is missing, the sector arrays disagree in length, or a sector path isn't
 *   `…/T_<x>_<z>.asset`
 */
export const readWaterGlobalConfig = (value: TypeTreeObject): WaterGlobalConfig => {
	const paths = arrayField(value, 'sectorDataPaths');
	const hashes = arrayField(value, 'sectorDataAssetHashes');
	const exists = arrayField(value, 'sectorDataExists');
	if (paths.length !== hashes.length || paths.length !== exists.length) {
		throw new FormatError('water sector arrays differ in length');
	}
	const sectors: WaterSector[] = [];
	for (let i = 0; i < paths.length; i++) {
		if (exists[i] === 0) {
			continue;
		}
		const path = paths[i];
		const hash = hashes[i];
		if (typeof path !== 'string' || (typeof hash !== 'bigint' && typeof hash !== 'number')) {
			throw new FormatError(`water sector ${i} has no path or asset hash`);
		}
		const match = SECTOR_NAME.exec(path);
		if (match === null) {
			throw new FormatError(`water sector ${i} has an unexpected path ${path}`);
		}
		sectors.push({
			x: Number(match[1]),
			z: Number(match[2]),
			path,
			assetHash: BigInt.asUintN(64, BigInt(hash)),
		});
	}
	const center = objectField(value, 'sceneCenterOffset');
	return {
		name: stringField(value, 'm_Name'),
		scenePath: stringField(value, 'scenePath'),
		sceneCenterOffset: [numberField(center, 'x'), numberField(center, 'y')],
		mapSize: numberField(value, 'mapSize'),
		sectorSize: numberField(value, 'sectorSize'),
		flowmapPrecision: numberField(value, 'flowmapPrecision'),
		useSectorData: booleanField(value, 'useSectorData'),
		sectors,
		grid: Object.fromEntries(GRID_FIELDS.map((name) => [name, numberField(value, name)])),
		surfaceConfigs: arrayField(value, 'hgWaterConfigs').map(asPPtr),
		flowMap: pptrField(value, 'flowMap'),
		causticMap: pptrField(value, 'causticMap'),
		rainMap: pptrField(value, 'rainMap'),
		normalMapArray: pptrField(value, 'normalMapArray'),
	};
};

// #endregion
