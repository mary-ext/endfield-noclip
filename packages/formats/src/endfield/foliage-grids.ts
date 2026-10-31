import { FormatError } from '../binary/binary-reader.ts';
import type { Aabb } from '../unity/values.ts';

import { ChunkObjectKind, Component, type RendererDraw, type StaticRenderer } from './init-chunk-data.ts';
import { levelTagOf } from './level-partition.ts';
import { readChunkRows, readPropertyTable, type MonoValue } from './mono-objects.ts';

// scattered foliage: the grass and tree grids among a chunk's proxy objects (tag-3 rows, the game's
// `ProxyEntityType`; docs/game-data/world.md#foliage-grids). each grid is a 64 m cell's worth of ECS entities
// the client creates itself, serialized as whole archetypes into the row's keyed property table
// (`mono-objects.ts` layout):
//
//   row         0 name (`GrassGrid_<x>_<z>#<level tag>_<hex id>`, `TreeGrid_…`)   2 u8 proxy type   3 table
//   Init        0xff000000 archetype count
//               0xff01xxxx archetype bounds   0xff02xxxx entity count
//               0xff03xxxx descriptors, 8 bytes each: u16 component id, u16 stride, u32 0
//               0xff04xxxx component-major blob of count · Σ stride bytes, as an InitChunkData group's
//   Streaming   0xff050000 batch table length n, then per entry i < n:
//               0xff06xxxx u32 batch key   0xff07xxxx material   0xff08xxxx mesh   0xff09xxxx submesh
//
// the archetypes reuse InitChunkData's bounds (0–5) and draw-info (8–14) columns; a draw's 24-byte info names
// its batch entry instead of holding asset keys:
//
//   grass (`GrassRendererInfo`)   0 u16 keywords   2 u16 0   4 u32 batch key   8 f32 sparsity
//                                 12 u32 renderer flags
//   tree (`RendererInfo`)         2 u8 submesh   12 u32 batch index   16 u32 renderer flags
//
// grass entities are clusters of nearby instances: column 37 + k holds `count` then up to 4·2^k 96-byte
// instances (`GrassClusterK{4,8,16,32}Component`). a tree entity is one instance in column 80
// (`HGTreeComponent`). an instance is a column-major object-to-world matrix and two vec4 parameters. layout
// found by census over map01 and map02, with the component names from the IL2CPP metadata.

// #region types

/** `ProxyEntityType` values of the grids decoded here */
export const FoliageGridType = {
	Grass: 7,
	Tree: 9,
} as const;

export type FoliageGridType = (typeof FoliageGridType)[keyof typeof FoliageGridType];

/** entities of one grid that draw the same chain of draws */
export interface FoliageCluster {
	/** world bounds of the instances */
	bounds: Aabb;
	/** draws with mesh and material keys resolved through the batch table; LOD levels follow the thresholds */
	renderer: StaticRenderer;
	/** column-major object-to-world matrices, one per instance */
	instances: Float32Array[];
}

/** a grass or tree grid */
export interface FoliageGrid {
	type: FoliageGridType;
	/** the proxy object's id */
	id: number;
	/** `id >>> 27`: the owning level's namespace */
	levelTag: number;
	name: string;
	clusters: FoliageCluster[];
}

// #endregion

const ARCHETYPE_COUNT_KEY = 0xff000000;
const ENTITY_COUNT_KEY = 0xff020000;
const DESCRIPTORS_KEY = 0xff030000;
const BLOB_KEY = 0xff040000;
const BATCH_COUNT_KEY = 0xff050000;
const BATCH_KEY_KEY = 0xff060000;
const BATCH_MATERIAL_KEY = 0xff070000;
const BATCH_MESH_KEY = 0xff080000;
const BATCH_SUBMESH_KEY = 0xff090000;

/** `GrassClusterK4Component`; ids up to {@link GRASS_CLUSTER_LAST} double the capacity */
const GRASS_CLUSTER_FIRST = 37;
const GRASS_CLUSTER_LAST = 40;
const TREE_INSTANCE = 80;
const INSTANCE_SIZE = 96;
const DRAW_INFO_SIZE = 24;

/**
 * @param init an InitChunkData FlatBuffer (after `unpackHgPayload`)
 * @returns whether the chunk has a grass or tree grid; cheaper than {@link readFoliageGrids}
 * @throws {FormatError} if the root doesn't frame
 */
export const hasFoliageGrids = (init: Uint8Array): boolean => {
	const { fb, rows } = readChunkRows(init);
	return rows.some((row) => gridType(fb, row) !== null);
};

/**
 * reads a chunk's grass and tree grids. a grid that spans files appears in each under the same id; callers
 * dedupe across files.
 *
 * @param init an InitChunkData FlatBuffer (after `unpackHgPayload`)
 * @param streaming its StreamingChunkData sibling, which holds the grids' batch tables
 * @returns the grids in row order, each with its clusters in file order
 * @throws {FormatError} if the two files disagree on the objects, or a grid's tables or columns don't frame
 */
export const readFoliageGrids = (init: Uint8Array, streaming: Uint8Array): FoliageGrid[] => {
	const initRows = readChunkRows(init);
	const streamRows = readChunkRows(streaming);
	if (streamRows.rows.length !== initRows.rows.length) {
		throw new FormatError('init and streaming chunks list different object counts');
	}
	const grids: FoliageGrid[] = [];
	for (const [i, row] of initRows.rows.entries()) {
		const type = gridType(initRows.fb, row);
		if (type === null) {
			continue;
		}
		const pair = streamRows.rows[i];
		if (pair.id !== row.id) {
			throw new FormatError(`object ${i}: init id ${row.id} pairs with streaming id ${pair.id}`);
		}
		const name = new TextDecoder().decode(initRows.fb.byteVector(row.table, 0));
		const props = propertyMap(initRows, row.table, row.id);
		const batches = readBatches(propertyMap(streamRows, pair.table, row.id), row.id);
		grids.push({
			type,
			id: row.id,
			levelTag: levelTagOf(row.id),
			name,
			clusters: readArchetypes(props, batches, type, row.id),
		});
	}
	return grids;
};

const gridType = (fb: ReturnType<typeof readChunkRows>['fb'], row: { tag: number; table: number }) => {
	if (row.tag !== ChunkObjectKind.Proxy) {
		return null;
	}
	const at = fb.field(row.table, 2);
	const type = at === undefined ? -1 : fb.u8(at);
	switch (type) {
		case FoliageGridType.Grass:
		case FoliageGridType.Tree: {
			return type;
		}
		default: {
			return null;
		}
	}
};

const propertyMap = (
	{ fb }: ReturnType<typeof readChunkRows>,
	table: number,
	id: number,
): Map<number, MonoValue> => {
	const at = fb.field(table, 3);
	if (at === undefined) {
		throw new FormatError(`grid ${id} has no property table`);
	}
	return new Map(readPropertyTable(fb, fb.deref(at)));
};

/** one entry of a grid's batch table */
interface Batch {
	key: number;
	materialHash: bigint;
	meshHash: bigint;
	submesh: number;
}

const readBatches = (props: Map<number, MonoValue>, id: number): Batch[] => {
	const count = intProperty(props, BATCH_COUNT_KEY, id);
	return Array.from({ length: count }, (_, i): Batch => {
		const key = props.get((BATCH_KEY_KEY | i) >>> 0);
		const material = props.get((BATCH_MATERIAL_KEY | i) >>> 0);
		const mesh = props.get((BATCH_MESH_KEY | i) >>> 0);
		if (key?.type !== 'uint' || material?.type !== 'asset' || mesh?.type !== 'asset') {
			throw new FormatError(`grid ${id} batch ${i} is incomplete`);
		}
		return {
			key: key.value,
			materialHash: material.hash,
			meshHash: mesh.hash,
			submesh: intProperty(props, (BATCH_SUBMESH_KEY | i) >>> 0, id),
		};
	});
};

const intProperty = (props: Map<number, MonoValue>, key: number, id: number): number => {
	const value = props.get(key);
	if (value?.type !== 'int') {
		throw new FormatError(`grid ${id} has no int under 0x${key.toString(16)}`);
	}
	return value.value;
};

const blobProperty = (props: Map<number, MonoValue>, key: number, id: number): Uint8Array => {
	const value = props.get(key);
	if (value?.type !== 'blob') {
		throw new FormatError(`grid ${id} has no blob under 0x${key.toString(16)}`);
	}
	return value.value;
};

const readArchetypes = (
	props: Map<number, MonoValue>,
	batches: Batch[],
	type: FoliageGridType,
	id: number,
): FoliageCluster[] => {
	const byKey = new Map(batches.map((batch) => [batch.key, batch]));
	const clusters: FoliageCluster[] = [];
	const archetypes = intProperty(props, ARCHETYPE_COUNT_KEY, id);
	for (let a = 0; a < archetypes; a++) {
		const count = intProperty(props, (ENTITY_COUNT_KEY | a) >>> 0, id);
		const descriptors = blobProperty(props, (DESCRIPTORS_KEY | a) >>> 0, id);
		const blob = blobProperty(props, (BLOB_KEY | a) >>> 0, id);
		const dd = new DataView(descriptors.buffer, descriptors.byteOffset, descriptors.byteLength);
		const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
		const columns = new Map<number, { stride: number; offset: number }>();
		let cursor = 0;
		for (let o = 0; o + 8 <= descriptors.length; o += 8) {
			const stride = dd.getUint16(o + 2, true);
			columns.set(dd.getUint16(o, true), { stride, offset: cursor });
			cursor += stride * count;
		}
		if (cursor !== blob.length) {
			throw new FormatError(
				`grid ${id} archetype ${a} blob is ${blob.length} bytes, descriptors need ${cursor}`,
			);
		}

		const boundsColumns = Array.from({ length: 6 }, (_, c) => columns.get(Component.BoundsCenterX + c));
		let drawColumn: { id: number; stride: number; offset: number } | undefined;
		let instanceColumn: { id: number; stride: number; offset: number } | undefined;
		for (const [column, layout] of columns) {
			if (column >= Component.DrawInfoFirst && column <= Component.DrawInfoLast) {
				drawColumn = { id: column, ...layout };
			}
			const isInstances =
				type === FoliageGridType.Grass
					? column >= GRASS_CLUSTER_FIRST && column <= GRASS_CLUSTER_LAST
					: column === TREE_INSTANCE;
			if (isInstances) {
				instanceColumn = { id: column, ...layout };
			}
		}
		if (boundsColumns.some((column) => column?.stride !== 4) || drawColumn === undefined) {
			throw new FormatError(`grid ${id} archetype ${a} lacks bounds or draw columns`);
		}
		if (instanceColumn === undefined) {
			throw new FormatError(`grid ${id} archetype ${a} has no instance column`);
		}
		const capacity = 1 << (drawColumn.id - Component.DrawInfoFirst);
		if (drawColumn.stride !== 4 + 32 * capacity) {
			throw new FormatError(`grid ${id} archetype ${a} has draw stride ${drawColumn.stride}`);
		}
		// a tree entity holds one instance; a grass cluster a count and room for its capacity
		let grassCapacity = 0;
		let instanceStride = INSTANCE_SIZE;
		if (type === FoliageGridType.Grass) {
			grassCapacity = 4 << (instanceColumn.id - GRASS_CLUSTER_FIRST);
			instanceStride = 4 + INSTANCE_SIZE * grassCapacity;
		}
		if (instanceColumn.stride !== instanceStride) {
			throw new FormatError(`grid ${id} archetype ${a} has instance stride ${instanceColumn.stride}`);
		}

		for (let e = 0; e < count; e++) {
			const f = (column: { offset: number } | undefined) => view.getFloat32(column!.offset + e * 4, true);
			const bounds: Aabb = {
				center: [f(boundsColumns[0]), f(boundsColumns[1]), f(boundsColumns[2])],
				extents: [f(boundsColumns[3]), f(boundsColumns[4]), f(boundsColumns[5])],
			};
			const draws = readDraws(view, drawColumn.offset + e * drawColumn.stride, capacity, {
				type,
				batches,
				byKey,
				id,
			});
			const base = instanceColumn.offset + e * instanceColumn.stride;
			let instanceCount = 1;
			let first = base;
			if (type === FoliageGridType.Grass) {
				instanceCount = view.getUint32(base, true);
				first = base + 4;
				if (instanceCount > grassCapacity) {
					throw new FormatError(`grid ${id} cluster holds ${instanceCount} of ${grassCapacity} instances`);
				}
			}
			const instances = Array.from({ length: instanceCount }, (_, k) => {
				const start = blob.byteOffset + first + k * INSTANCE_SIZE;
				return new Float32Array(blob.buffer.slice(start, start + 64));
			});
			const lodCount = new Set(draws.map((draw) => draw.lod)).size;
			clusters.push({ bounds, renderer: { draws, lodCount }, instances });
		}
	}
	return clusters;
};

const readDraws = (
	view: DataView,
	at: number,
	capacity: number,
	grid: { type: FoliageGridType; batches: Batch[]; byKey: Map<number, Batch>; id: number },
): RendererDraw[] => {
	const count = view.getUint32(at, true);
	if (count > capacity) {
		throw new FormatError(`grid ${grid.id} has ${count} draws in room for ${capacity}`);
	}
	const draws: RendererDraw[] = [];
	for (let d = 0; d < count; d++) {
		const info = at + 4 + d * DRAW_INFO_SIZE;
		const lod = at + 4 + capacity * DRAW_INFO_SIZE + d * 8;
		let batch: Batch | undefined;
		let flags: number;
		if (grid.type === FoliageGridType.Grass) {
			batch = grid.byKey.get(view.getUint32(info + 4, true));
			flags = view.getUint32(info + 12, true);
		} else {
			batch = grid.batches[view.getUint32(info + 12, true)];
			flags = view.getUint32(info + 16, true);
		}
		if (batch === undefined) {
			throw new FormatError(`grid ${grid.id} draw ${d} names no batch entry`);
		}
		draws.push({
			meshHash: batch.meshHash,
			materialHash: batch.materialHash,
			submesh: batch.submesh,
			flags,
			lodMaxSquared: view.getFloat32(lod, true),
			lodMinSquared: view.getFloat32(lod + 4, true),
			lod: 0,
		});
	}
	// grids carry no LOD-range column; a draw's LOD is the rank of its upper threshold
	const uppers = [...new Set(draws.map((draw) => draw.lodMaxSquared))].toSorted((a, b) => b - a);
	for (const draw of draws) {
		draw.lod = uppers.indexOf(draw.lodMaxSquared);
	}
	return draws;
};
