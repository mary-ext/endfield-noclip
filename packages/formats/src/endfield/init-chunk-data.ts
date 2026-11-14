import { FormatError } from '../binary/binary-reader.ts';
import { FlatBuffer } from '../binary/flatbuffer.ts';
import type { Aabb } from '../unity/values.ts';

import { levelTagOf } from './level-partition.ts';

// static scenery placements (docs/game-data/world.md#static-scenery-initchunkdata-and-streamingchunkdata).
// framing ported from An1X3R/Endfield-map-extractor (MIT, `extractor_core/{instances,flatbuffer}.py`,
// `extract_scene_renderer_materials.py`) and the field readings of Variante/endfield_research_kit (MIT,
// `memory/game_data/world_chunk*.md`).
//
// root table, 8 slots:
//   0 u32 version (47, 49)        1 i32×2 chunk origin (x·128, z·128); Global stores (INT32_MAX, INT32_MIN)
//   2 [row]   empty in Init   3 [u32] object ids     4 [u8] object kinds     5 [table] object rows
//   6 [table{[u32]}] per-group entity ids             7 [table] component groups, parallel to 6
// object rows are a union vector: slot 4 is the tag, each row's field 0 is the full object name and field 1
// its streaming layer.
// component group, 5 slots:
//   0 128-bit descriptor-id mask   1 u32 count   2 f32×6 group AABB (centre, extents; zero = unset)
//   3 [(u16 component id, u16 stride, u32 0)]   4 table{[u8]} component-major blob of count·Σstride bytes

// #region types

/** root versions this reader has been checked against (47: endfield_research_kit's corpus, 49: current client) */
export const INIT_CHUNK_VERSIONS: readonly number[] = [47, 49];

/** a root object row */
export interface ChunkObject {
	id: number;
	/** union tag of the row: a {@link ChunkObjectKind} value, or another the game has */
	kind: number;
	name: string;
	/** a {@link StreamingLayer} value: the layer whose grid and radius load the object */
	layer: number;
}

/**
 * the game's `StreamingLayer`: each has its own grid and load radius
 * (docs/game-data/world.md#streaming-layers)
 */
export const StreamingLayer = {
	Default: 0,
	Persistent: 1,
	HLOD0: 2,
	HLOD1: 3,
	HLOD2: 4,
	Collider: 5,
	Tiny: 6,
	Water: 7,
	Lighting: 8,
	Audio: 9,
	RendererWithCollider: 10,
} as const;

/** {@link ChunkObject.kind} values with a decoder; what each holds is by name census */
export const ChunkObjectKind = {
	/**
	 * GameObjects rebuilt as MonoBehaviours (reflection probes, `Env_*`, volumes, wind, terrain root), see
	 * `mono-objects.ts`
	 */
	Mono: 1,
	/** component-group entities (renderers, colliders, decals, lights; the game's `ECSEntityType`) */
	Entity: 2,
	/**
	 * proxy entities (audio, grass and tree grids, surface-type data; the game's `ProxyEntityType`); the grids
	 * are read by `foliage-grids.ts`
	 */
	Proxy: 3,
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
	/** a {@link StreamingLayer} value, from the entity's object row; `Default` without a row */
	layer: number;
	/** 4×4 column-major object-to-world matrix, when the entity has one */
	matrix: Float32Array | null;
	/** world bounds, when present */
	bounds: Aabb | null;
	renderer: StaticRenderer | null;
	/**
	 * a projected rect decal's placement values, or `null` for other entities; its material lives in
	 * StreamingChunkData, not here
	 */
	decal: RectDecal | null;
	/**
	 * a constant spin the entity turns with (component 54, or 52 turned into world space), or `null` for
	 * entities that hold still
	 */
	rotator: Rotator | null;
	/**
	 * the hash of the cloth simulation that moves the entity's vertices (component 60), which a cloth group
	 * proxy of its cell holds; `null` for entities drawn as their mesh stands
	 */
	clothHash: number | null;
	/** descriptor ids present on the entity */
	components: number[];
}

/**
 * a constant spin about a world axis. at time `t` the entity's stored transform is turned by `speed · t`
 * radians about `axis` through `pivot`, as Unity's `Quaternion.AngleAxis` turns
 */
export interface Rotator {
	/** radians per second, non-negative; the axis carries the direction */
	speed: number;
	/** unit axis, world space */
	axis: [x: number, y: number, z: number];
	/** a point on the axis, world space */
	pivot: [x: number, y: number, z: number];
}

/**
 * a rect decal's own values (component 27 after its matrix and inverse). the decal projects down the local y
 * of a unit box, whose matrix is the entity's
 */
export interface RectDecal {
	/** the box's UVs, `local.xz + 0.5`, are scaled by this and then offset */
	uvScale: [u: number, v: number];
	uvOffset: [u: number, v: number];
	/** RGBA8 as stored, 0–1: the colour multiplies the base colour as is, the alpha the opacity */
	color: [r: number, g: number, b: number, a: number];
	/** scales the colour */
	intensity: number;
	/** an angle in degrees the decal's shaders don't read (270 and 90 seen) */
	sectorAngle: number;
	/** flag word, 0 on every decal seen */
	flags: number;
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
	/**
	 * 16-byte spin about the entity's own origin: `f32 speed` (rad/s, non-negative), `f32×3 axis` (unit, local
	 * space)
	 */
	LocalSpin: 52,
	/**
	 * 92-byte spin: `f32 speed` (rad/s), `f32×3 axis`, `f32×3 pivot`, then f32×6 (a local box, unchecked) and
	 * the stored position, rotation quaternion (xyzw) and scale
	 */
	Rotator: 54,
	/** `u32`: the hash of the entity's cloth simulation */
	ClothHash: 60,
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
	/** casts shadows at all */
	CastShadow: 0x8_0000,
	/** one bit per sharp cascade; the game sets all or none */
	Cascades: 0xf0_0000,
	/** casts into the cached far shadow map */
	StaticShadowCaster: 0x100_0000,
	/** casts into the sharp cascades */
	RealtimeShadowCaster: 0x200_0000,
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
			// left out of the row when it's the default, 0
			const layerAt = fb.field(row, 1);
			objects.push({
				id: fb.u32(ids.start + i * 4),
				kind: fb.u8(kinds.start + i),
				name: textDecoder.decode(fb.byteVector(row, 0)),
				layer: layerAt === undefined ? StreamingLayer.Default : fb.u8(layerAt),
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
	const layers = new Map<number, number>();
	for (const object of chunk.objects) {
		names.set(object.id, object.name);
		layers.set(object.id, object.layer);
	}

	const entities: ChunkEntity[] = [];
	for (const group of chunk.groups) {
		const ids = group.columns.map((column) => column.id);
		const blobView = new DataView(group.blob.buffer, group.blob.byteOffset, group.blob.byteLength);
		const column = (id: number): ComponentColumn | undefined => groupColumn(group, id);

		const boundsOf = groupBounds(group);
		const decalColumn = column(Component.RectDecal);
		const matrixColumn = column(Component.InstanceData) ?? decalColumn;
		const rotatorColumn = column(Component.Rotator);
		const localSpinColumn = column(Component.LocalSpin);
		const clothColumn = column(Component.ClothHash);
		if (clothColumn !== undefined && clothColumn.stride !== 4) {
			throw new FormatError(`a group has a ${clothColumn.stride}-byte cloth hash`);
		}
		const nameOf = groupNames(group, names);
		const lodColumn = column(Component.LodRanges);
		const refColumns = group.columns.filter(
			(c) => c.id >= Component.DrawRefFirst && c.id <= Component.DrawRefLast,
		);
		// the group's matrices packed into one buffer rather than a buffer per entity, so they don't pin the
		// chunk's payload either
		let matrices: Float32Array | undefined;
		if (matrixColumn !== undefined) {
			matrices = new Float32Array(group.ids.length * 16);
			const bytes = new Uint8Array(matrices.buffer);
			for (let i = 0; i < group.ids.length; i++) {
				const start = matrixColumn.offset + i * matrixColumn.stride;
				bytes.set(group.blob.subarray(start, start + 64), i * 64);
			}
		}

		for (let i = 0; i < group.ids.length; i++) {
			const id = group.ids[i];
			const name = nameOf(i);
			const bounds = boundsOf?.(i) ?? null;
			const matrix = matrices?.subarray(i * 16, i * 16 + 16) ?? null;

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

			let rotator: Rotator | null = null;
			if (rotatorColumn !== undefined) {
				rotator = readRotator(blobView, rotatorColumn, i, id);
			} else if (localSpinColumn !== undefined && matrix !== null) {
				rotator = readLocalSpin(blobView, localSpinColumn, { index: i, entityId: id, matrix });
			}

			entities.push({
				id,
				levelTag: levelTagOf(id),
				name,
				layer: layers.get(id) ?? StreamingLayer.Default,
				matrix,
				bounds,
				renderer,
				decal: decalColumn === undefined ? null : readRectDecal(blobView, decalColumn, i, id),
				rotator,
				clothHash: clothColumn === undefined ? null : blobView.getUint32(clothColumn.offset + i * 4, true),
				components: ids,
			});
		}
	}
	return entities;
};

const ROTATOR_SIZE = 92;

const readRotator = (view: DataView, column: ComponentColumn, index: number, entityId: number): Rotator => {
	if (column.stride !== ROTATOR_SIZE) {
		throw new FormatError(`entity ${entityId} has a ${column.stride}-byte rotator`);
	}
	const at = column.offset + index * column.stride;
	const f = (k: number): number => view.getFloat32(at + k * 4, true);
	const axis: Rotator['axis'] = [f(1), f(2), f(3)];
	const speed = f(0);
	if (!(speed >= 0) || Math.abs(Math.hypot(...axis) - 1) > 1e-3) {
		throw new FormatError(`entity ${entityId} has a rotator of speed ${speed} about [${axis.join(', ')}]`);
	}
	return { speed, axis, pivot: [f(4), f(5), f(6)] };
};

const LOCAL_SPIN_SIZE = 16;

/**
 * reads component 52 as a world-space spin: the local axis through the matrix, pivoting on its translation.
 * turning the world transform about that axis equals turning the local one only under uniform scale, which
 * every entity with the component has
 */
const readLocalSpin = (
	view: DataView,
	column: ComponentColumn,
	{ index, entityId, matrix }: { index: number; entityId: number; matrix: Float32Array },
): Rotator => {
	if (column.stride !== LOCAL_SPIN_SIZE) {
		throw new FormatError(`entity ${entityId} has a ${column.stride}-byte local spin`);
	}
	const at = column.offset + index * column.stride;
	const f = (k: number): number => view.getFloat32(at + k * 4, true);
	const speed = f(0);
	const local = [f(1), f(2), f(3)];
	if (!(speed >= 0) || Math.abs(Math.hypot(...local) - 1) > 1e-3) {
		throw new FormatError(
			`entity ${entityId} has a local spin of speed ${speed} about [${local.join(', ')}]`,
		);
	}
	const scales = [0, 4, 8].map((c) => Math.hypot(matrix[c], matrix[c + 1], matrix[c + 2]));
	if (Math.max(...scales) - Math.min(...scales) > 1e-3 * Math.max(...scales)) {
		throw new FormatError(
			`entity ${entityId} has a local spin under non-uniform scale [${scales.join(', ')}]`,
		);
	}
	const world = [0, 1, 2].map(
		(r) => matrix[r] * local[0] + matrix[4 + r] * local[1] + matrix[8 + r] * local[2],
	);
	const length = Math.hypot(...world);
	return {
		speed,
		axis: [world[0] / length, world[1] / length, world[2] / length],
		pivot: [matrix[12], matrix[13], matrix[14]],
	};
};

const RECT_DECAL_SIZE = 160;

/** component 27 after the matrix and its inverse: UV scale, UV offset, RGBA8 colour, intensity, angle, flags */
const readRectDecal = (
	view: DataView,
	column: ComponentColumn,
	index: number,
	entityId: number,
): RectDecal => {
	if (column.stride !== RECT_DECAL_SIZE) {
		throw new FormatError(`entity ${entityId} has a ${column.stride}-byte rect decal`);
	}
	const at = column.offset + index * column.stride + 128;
	const f = (k: number): number => view.getFloat32(at + k * 4, true);
	const rgba = view.getUint32(at + 16, true);
	const byte = (shift: number): number => ((rgba >>> shift) & 0xff) / 255;
	return {
		uvScale: [f(0), f(1)],
		uvOffset: [f(2), f(3)],
		color: [byte(0), byte(8), byte(16), byte(24)],
		intensity: f(5),
		sectorAngle: f(6),
		flags: view.getUint32(at + 28, true),
	};
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
