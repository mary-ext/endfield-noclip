import { FormatError } from '../binary/binary-reader.ts';
import { FlatBuffer } from '../binary/flatbuffer.ts';
import type { Aabb } from '../unity/values.ts';

import { levelTagOf } from './level-partition.ts';

// static scenery placements: `Data/Streaming/PC/<scene>/Streaming/InitChunkData_<x>_<z>_<sceneStateId>_<areaId>.bytes`
// (and `…_Global_<sceneStateId>_<areaId>.bytes`), the game's `GridIdentifier` fields. framing ported from An1X3R/Endfield-map-extractor (MIT,
// `extractor_core/{instances,flatbuffer}.py`, `extract_scene_renderer_materials.py`) and the field readings
// of Variante/endfield_research_kit (MIT, `memory/game_data/world_chunk*.md`).
//
// root table, 8 slots:
//   0 u32 version (47, 49)        1 i32×2 chunk origin (x·128, z·128); Global stores (INT32_MAX, INT32_MIN)
//   2 [row]   empty in Init   3 [u32] object ids     4 [u8] object kinds     5 [table] object rows
//   6 [table{[u32]}] per-group entity ids             7 [table] component groups, parallel to 6
// object rows are a union vector: slot 4 is the tag, and each row's field 0 is the full object name.
// component group, 5 slots:
//   0 128-bit descriptor-id mask   1 u32 count   2 f32×6 group AABB (centre, extents; zero = unset)
//   3 [(u16 component id, u16 stride, u32 0)]   4 table{[u8]} component-major blob of count·Σstride bytes

// #region types

/** root versions this reader has been checked against (47: endfield_research_kit's corpus, 49: current client) */
export const INIT_CHUNK_VERSIONS: readonly number[] = [47, 49];

/** a root object row */
export interface ChunkObject {
	id: number;
	/**
	 * union tag of the row. by name census: 1 = environment (reflection probes, `Env_*`, volumes, wind, terrain
	 * root), 2 = component-group entities (renderers, colliders, decals, lights; the game's `ECSEntityType`), 3
	 * = proxy entities (audio, grass and tree grids, surface-type data; the game's `ProxyEntityType`). see
	 * {@link ChunkObjectKind}
	 */
	kind: number;
	name: string;
}

/** {@link ChunkObject.kind} values with a decoder */
export const ChunkObjectKind = {
	/** GameObjects rebuilt as MonoBehaviours, see `mono-objects.ts` */
	Mono: 1,
	/** component-group entities */
	Entity: 2,
} as const;

/** one component column inside a group's blob */
export interface ComponentColumn {
	/** anonymous descriptor id; see {@link Component} for the ones with known meaning */
	id: number;
	stride: number;
	/** byte offset of the column's first element within the group blob */
	offset: number;
}

/** a set of entities sharing the same components, stored column-major */
export interface ComponentGroup {
	ids: Uint32Array;
	/** union of the members' world bounds, or `null` when unset */
	bounds: Aabb | null;
	columns: ComponentColumn[];
	blob: Uint8Array;
}

/** a parsed InitChunkData FlatBuffer */
export interface InitChunk {
	version: number;
	/** chunk origin in world metres, `null` for Global chunks */
	origin: { x: number; z: number } | null;
	objects: ChunkObject[];
	groups: ComponentGroup[];
}

/** a draw call of a static renderer */
export interface RendererDraw {
	/** StringPathHash key of the mesh (`<container>.fbx##<subasset>`, `.mesh` or `.asset`) */
	meshHash: bigint;
	/** StringPathHash key of the `.mat` */
	materialHash: bigint;
	submesh: number;
	/** renderer flag word; bit {@link DrawFlags.ShadowOnly} marks shadow-caster-only draws */
	flags: number;
	/**
	 * the draw is visible while `minSquared < s² <= maxSquared`, where `s` is the renderer's screen-relative
	 * height as in Unity's LODGroup. `maxSquared` is `FLT_MAX` for the nearest LOD; a negative `minSquared`
	 * means it's never culled by size
	 */
	lodMaxSquared: number;
	lodMinSquared: number;
	/** LOD level of this draw, from {@link Component.LodRanges} */
	lod: number;
}

/** what a static entity draws */
export interface StaticRenderer {
	draws: RendererDraw[];
	/** number of LOD levels */
	lodCount: number;
}

/** a placed entity with its decoded components */
export interface ChunkEntity {
	/** full 32-bit entity id */
	id: number;
	/** `id >>> 27`: the owning level's namespace; 0 is the map-wide shared set */
	levelTag: number;
	name: string;
	/** 4×4 column-major object-to-world matrix, when the entity has one */
	matrix: Float32Array | null;
	/** world bounds, when present */
	bounds: Aabb | null;
	renderer: StaticRenderer | null;
	/** the entity is a projected rect decal; its material lives in StreamingChunkData, not here */
	decal: boolean;
	/** descriptor ids present on the entity */
	components: number[];
}

// #endregion

// #region component ids

/**
 * descriptor ids whose meaning is established. ids are anonymous column selectors in the native reader; these
 * labels come from layout + cross-checks against named data (paths, matrices, names).
 */
export const Component = {
	/** f32 world AABB centre x; ids 0–5 are centre xyz then extents xyz */
	BoundsCenterX: 0,
	/** 4 + 32·2ⁿ bytes for n = id − 8: `u32 count`, 2ⁿ × 24-byte draw infos, 2ⁿ × `(f32 max², f32 min²)` */
	DrawInfoFirst: 8,
	DrawInfoLast: 14,
	/** 256-byte instance constants; begins with the object-to-world matrix */
	InstanceData: 18,
	/** 64-byte NUL-padded name prefix */
	Name: 21,
	/** 160-byte rect decal constants: matrix, inverse, params, packed color + flags */
	RectDecal: 27,
	/** 24 bytes: `u8 lodCount`, …, at 16 `u8[8]` cumulative draw count per LOD */
	LodRanges: 67,
	/** 8 + 40·2ⁿ bytes for n = id − 68: `u64 count`, 2ⁿ × `(u64 material, u64 mesh, 24 bytes)` */
	DrawRefFirst: 68,
	DrawRefLast: 74,
} as const;

/** known renderer flag bits */
export const DrawFlags = {
	/** set on draws that only cast shadows (shadow proxies) */
	ShadowOnly: 1 << 10,
} as const;

// #endregion

/**
 * parses a decoded InitChunkData FlatBuffer
 *
 * @param data the file after `unpackHgPayload` (`hg/payload.ts`)
 * @returns the chunk's objects and component groups
 * @throws {FormatError} on any framing mismatch
 */
export const parseInitChunk = (data: Uint8Array): InitChunk => {
	const fb = new FlatBuffer(data);
	return parseChunk(fb, fb);
};

/**
 * reads dynamic ECS renderer columns with the ids from their paired streaming payload
 *
 * @param init decompressed `fb_init` payload
 * @param streaming decompressed matching `fb_streaming` payload
 * @returns the paired chunk, with groups in ECS index order
 * @throws {FormatError} if either root or the paired group counts are invalid
 */
export const parseDynamicChunk = (init: Uint8Array, streaming: Uint8Array): InitChunk => {
	return parseChunk(new FlatBuffer(init), new FlatBuffer(streaming));
};

const parseChunk = (fb: FlatBuffer, idsFb: FlatBuffer): InitChunk => {
	const root = fb.root();
	const idsRoot = idsFb.root();
	if (idsFb.fieldCount(idsRoot) !== 8) {
		throw new FormatError('chunk ids root must have 8 fields');
	}
	if (fb.fieldCount(root) !== 8) {
		throw new FormatError(`init chunk root has ${fb.fieldCount(root)} fields, expected 8`);
	}

	const versionAt = fb.field(root, 0);
	const version = versionAt === undefined ? 0 : fb.u32(versionAt);
	if (!INIT_CHUNK_VERSIONS.includes(version)) {
		throw new FormatError(`unsupported init chunk version ${version}`);
	}

	let origin: InitChunk['origin'] = null;
	{
		const at = fb.field(root, 1);
		if (at !== undefined) {
			const x = fb.i32(at);
			const z = fb.i32(at + 4);
			if (!(x === 0x7fffffff && z === -0x80000000)) {
				origin = { x, z };
			}
		}
	}

	const objects: ChunkObject[] = [];
	{
		const ids = fb.vector(root, 3);
		const kinds = fb.vector(root, 4);
		const rows = fb.vector(root, 5);
		if (ids.length !== kinds.length || ids.length !== rows.length) {
			throw new FormatError('init chunk object vectors differ in length');
		}
		for (let i = 0; i < ids.length; i++) {
			const row = fb.tableAt(rows.start, i);
			objects.push({
				id: fb.u32(ids.start + i * 4),
				kind: fb.u8(kinds.start + i),
				name: textDecoder.decode(fb.byteVector(row, 0)),
			});
		}
	}

	const groups: ComponentGroup[] = [];
	{
		const idWrappers = idsFb.vector(idsRoot, 6);
		const tables = fb.vector(root, 7);
		if (idWrappers.length !== tables.length) {
			throw new FormatError('init chunk group vectors differ in length');
		}
		for (let g = 0; g < tables.length; g++) {
			const group = fb.tableAt(tables.start, g);
			const idVector = idsFb.vector(idsFb.tableAt(idWrappers.start, g), 0);

			const countAt = fb.field(group, 1);
			const count = countAt === undefined ? 0 : fb.u32(countAt);
			if (count !== idVector.length) {
				throw new FormatError(`group ${g} counts ${count} entities but lists ${idVector.length} ids`);
			}
			const ids = new Uint32Array(count);
			for (let i = 0; i < count; i++) {
				ids[i] = idsFb.u32(idVector.start + i * 4);
			}

			let bounds: Aabb | null = null;
			{
				const at = fb.field(group, 2);
				if (at !== undefined) {
					const v = Array.from({ length: 6 }, (_, i) => fb.f32(at + i * 4));
					if (v.some((value) => value !== 0)) {
						bounds = { center: [v[0], v[1], v[2]], extents: [v[3], v[4], v[5]] };
					}
				}
			}

			const columns: ComponentColumn[] = [];
			let cursor = 0;
			{
				const descriptors = fb.vector(group, 3);
				for (let i = 0; i < descriptors.length; i++) {
					const at = descriptors.start + i * 8;
					if (fb.u32(at + 4) !== 0) {
						throw new FormatError(`group ${g} descriptor ${i} has non-zero reserved bits`);
					}
					const stride = fb.u16(at + 2);
					columns.push({ id: fb.u16(at), stride, offset: cursor });
					cursor += stride * count;
				}
			}

			const blobAt = fb.field(group, 4);
			if (blobAt === undefined) {
				throw new FormatError(`group ${g} has no component blob`);
			}
			const blob = fb.byteVector(fb.deref(blobAt), 0);
			if (blob.length !== cursor) {
				throw new FormatError(`group ${g} blob is ${blob.length} bytes, descriptors need ${cursor}`);
			}

			groups.push({ ids, bounds, columns, blob });
		}
	}

	return { version, origin, objects, groups };
};

/**
 * decodes every group entity of a chunk. entities that span cells appear in each cell's chunk under the same
 * id; callers dedupe across files.
 *
 * @param chunk parsed chunk
 * @returns one row per group entity, in file order
 * @throws {FormatError} if a renderer's draw columns disagree
 */
export const readChunkEntities = (chunk: InitChunk): ChunkEntity[] => {
	const names = new Map<number, string>();
	for (const object of chunk.objects) {
		names.set(object.id, object.name);
	}

	const entities: ChunkEntity[] = [];
	for (const group of chunk.groups) {
		const ids = group.columns.map((column) => column.id);
		const blobView = new DataView(group.blob.buffer, group.blob.byteOffset, group.blob.byteLength);
		const column = (id: number): ComponentColumn | undefined => groupColumn(group, id);

		const boundsOf = groupBounds(group);
		const matrixColumn = column(Component.InstanceData) ?? column(Component.RectDecal);
		const nameOf = groupNames(group, names);
		const lodColumn = column(Component.LodRanges);
		const refColumns = group.columns.filter(
			(c) => c.id >= Component.DrawRefFirst && c.id <= Component.DrawRefLast,
		);

		for (let i = 0; i < group.ids.length; i++) {
			const id = group.ids[i];
			const name = nameOf(i);
			const bounds = boundsOf?.(i) ?? null;

			let matrix: Float32Array | null = null;
			if (matrixColumn !== undefined) {
				const start = group.blob.byteOffset + matrixColumn.offset + i * matrixColumn.stride;
				matrix = new Float32Array(group.blob.buffer.slice(start, start + 64));
			}

			let renderer: StaticRenderer | null = null;
			if (refColumns.length > 0) {
				const lodEnds =
					lodColumn === undefined ? undefined : group.blob.subarray(lodColumn.offset + i * lodColumn.stride);
				const draws: RendererDraw[] = [];
				for (const refs of refColumns) {
					const infos = column(refs.id - (Component.DrawRefFirst - Component.DrawInfoFirst));
					if (infos === undefined) {
						throw new FormatError(`entity ${id} has draw refs ${refs.id} without draw infos`);
					}
					draws.push(...decodeDraws(blobView, { refs, infos, index: i, entityId: id }));
				}
				let lodCount = 1;
				if (lodEnds !== undefined) {
					lodCount = lodEnds[0];
					assignLods(draws, lodEnds.subarray(16, 24), id);
				}
				renderer = { draws, lodCount };
			}

			entities.push({
				id,
				levelTag: levelTagOf(id),
				name,
				matrix,
				bounds,
				renderer,
				decal: ids.includes(Component.RectDecal),
				components: ids,
			});
		}
	}
	return entities;
};

/**
 * @param group a component group
 * @param id a descriptor id
 * @returns the group's column with that id, if any
 */
export const groupColumn = (group: ComponentGroup, id: number): ComponentColumn | undefined =>
	group.columns.find((column) => column.id === id);

/**
 * @param group a component group
 * @returns a reader of each member's world bounds (by index in the group), or `null` if the group has no
 *   bounds columns
 */
export const groupBounds = (group: ComponentGroup): ((index: number) => Aabb) | null => {
	const columns: ComponentColumn[] = [];
	for (let id = Component.BoundsCenterX; id < Component.BoundsCenterX + 6; id++) {
		const column = groupColumn(group, id);
		if (column === undefined || column.stride !== 4) {
			return null;
		}
		columns.push(column);
	}
	const view = new DataView(group.blob.buffer, group.blob.byteOffset, group.blob.byteLength);
	return (index) => {
		const v = columns.map((column) => view.getFloat32(column.offset + index * 4, true));
		return { center: [v[0], v[1], v[2]], extents: [v[3], v[4], v[5]] };
	};
};

/**
 * @param group a component group
 * @param names object names by id (the root rows'), which win over the group's truncated name column
 * @returns a reader of each member's name (by index in the group); `''` where neither has one
 */
export const groupNames = (
	group: ComponentGroup,
	names: ReadonlyMap<number, string>,
): ((index: number) => string) => {
	const column = groupColumn(group, Component.Name);
	return (index) => {
		const name = names.get(group.ids[index]);
		if (name !== undefined || column === undefined) {
			return name ?? '';
		}
		const start = column.offset + index * column.stride;
		const raw = group.blob.subarray(start, start + column.stride);
		const end = raw.indexOf(0);
		return textDecoder.decode(end < 0 ? raw : raw.subarray(0, end));
	};
};

/** one entity's draw-ref and draw-info columns */
interface DrawColumns {
	refs: ComponentColumn;
	infos: ComponentColumn;
	/** entity index within the group */
	index: number;
	/** for error messages */
	entityId: number;
}

const decodeDraws = (view: DataView, columns: DrawColumns): RendererDraw[] => {
	const { refs, infos, index, entityId } = columns;
	const capacity = 1 << (refs.id - Component.DrawRefFirst);
	if (refs.stride !== 8 + 40 * capacity || infos.stride !== 4 + 32 * capacity) {
		throw new FormatError(`entity ${entityId} has unexpected draw strides ${refs.stride}/${infos.stride}`);
	}
	const refAt = refs.offset + index * refs.stride;
	const infoAt = infos.offset + index * infos.stride;
	const count = Number(view.getBigUint64(refAt, true));
	if (count > capacity || view.getUint32(infoAt, true) !== count) {
		throw new FormatError(`entity ${entityId} draw counts disagree`);
	}
	const out: RendererDraw[] = [];
	for (let d = 0; d < count; d++) {
		const ref = refAt + 8 + d * 40;
		const info = infoAt + 4 + d * 24;
		const lod = infoAt + 4 + capacity * 24 + d * 8;
		out.push({
			materialHash: view.getBigUint64(ref, true),
			meshHash: view.getBigUint64(ref + 8, true),
			submesh: view.getUint8(info + 2),
			flags: view.getUint32(info + 16, true),
			lodMaxSquared: view.getFloat32(lod, true),
			lodMinSquared: view.getFloat32(lod + 4, true),
			lod: 0,
		});
	}
	return out;
};

/** spreads LOD levels over draws from the cumulative per-LOD draw counts */
const assignLods = (draws: RendererDraw[], ends: Uint8Array, id: number): void => {
	let lod = 0;
	for (let d = 0; d < draws.length; d++) {
		while (lod < ends.length && d >= ends[lod]) {
			lod++;
		}
		if (lod >= ends.length) {
			throw new FormatError(`entity ${id} has more draws than its LOD ranges cover`);
		}
		draws[d].lod = lod;
	}
};

const textDecoder = new TextDecoder('utf-8');
