import {
	viewOf,
	checkHeader,
	enumGuard,
	checkedEnum,
	checkLength,
	TABLE_HEADER_SIZE,
	writeHeader,
	type HeaderShape,
} from './binary.ts';
import type { Bounds } from './values.ts';

/** what a tile content reference points at */
export const ContentKind = {
	/** the node's terrain height page; `param` is the game's `maxHeightError` (m) */
	TerrainHeights: 0,
	/** HLOD cluster rows `[first, first + count)` of an instance block; `tier` is the HLOD tier */
	Hlod: 1,
	/** detail instances of one level: a whole instance block */
	Detail: 2,
	/** independently streamed dynamic instances; `param` indexes {@link StatesInfo.conditionalSets} */
	Conditional: 3,
	/** the node's baked terrain surface page (albedo and normal); covers the same tile as its height page */
	TerrainSurface: 4,
	/** a leaf node's close-up blend inputs (splat control, tint, layer index) */
	TerrainSplat: 5,
} as const;

export type ContentKind = (typeof ContentKind)[keyof typeof ContentKind];

/** readable names of content kinds, for reports and debugging */
export const CONTENT_KIND_NAMES: Record<ContentKind, string> = {
	[ContentKind.TerrainHeights]: 'terrainHeights',
	[ContentKind.Hlod]: 'hlod',
	[ContentKind.Detail]: 'detail',
	[ContentKind.Conditional]: 'conditional',
	[ContentKind.TerrainSurface]: 'terrainSurface',
	[ContentKind.TerrainSplat]: 'terrainSplat',
};

/** tree node flag bits */
export const NodeFlags = {
	HasTerrain: 1 << 0,
	HasHlod: 1 << 1,
	HasDetail: 1 << 2,
} as const;

/**
 * the tile hierarchy: a forest of quadtrees on one unbounded grid. level `l` tiles are `rootSize / 2^l`
 * across and tile `(l, x, z)` covers `[origin.x + x·size, +size) × [origin.z + z·size, +size)`; `x`, `z` may
 * be negative or exceed `2^l - 1` for content off the terrain square. children of `(l, x, z)` are `(l + 1, 2x +
 * dx, 2z + dz)`. the grid coincides with the game's terrain quadtree (same origin, same levels)
 */
export interface TreeInfo {
	/** world x, z of tile `(0, 0, 0)`'s minimum corner */
	origin: [x: number, z: number];
	/** edge length of a level-0 tile, metres */
	rootSize: number;
	/** deepest level; its 64 m tiles carry detail instances and HLOD0 */
	leafLevel: number;
	/** level whose tiles are the game's 128 m streaming and level-ownership cells */
	cellLevel: number;
	/** the level each HLOD tier attaches to, by tier */
	hlodLevels: number[];
	/** level whose tiles group shard archives (see {@link ArchiveInfo.tile}) */
	shardLevel: number;
	/** tree.bin record counts, for preallocation */
	nodeCount: number;
	refCount: number;
}

/**
 * a reference from a tree node (or {@link PackageManifest.global}) to content. stored as 24-byte records in
 * tree.bin and as JSON in the manifest
 */
export interface ContentRef {
	kind: ContentKind;
	/** HLOD tier for {@link ContentKind.Hlod}; 0 otherwise */
	tier: number;
	/**
	 * the instances' level tag (`entityId >>> 27`, matching {@link LevelInfo.tag}) for instance content; 0 for
	 * terrain
	 */
	levelTag: number;
	/** blob index */
	blob: number;
	/** first row, for refs into a shared instance block; 0 otherwise */
	first: number;
	/** row count (instances), or 1 for single-item blobs */
	count: number;
	/** kind-specific scalar; see {@link ContentKind} */
	param: number;
}

/** a tree node */
export interface TreeNode {
	level: number;
	x: number;
	z: number;
	/** bit `dz·2 + dx` set when child `(2x + dx, 2z + dz)` exists */
	childMask: number;
	/** {@link NodeFlags} */
	flags: number;
	/** bounds of everything the node and its descendants draw, including overhang past the tile */
	bounds: Bounds;
	/**
	 * world-space error, metres, of drawing this node's coarse content (HLOD, terrain page) instead of
	 * refining. screen-space error = `geometricError · viewportHeight / (2 · distance · tan(fovY / 2))`
	 */
	geometricError: number;
	/** this node's slice of {@link Tree.refs} */
	refFirst: number;
	refCount: number;
}

/** decoded tree.bin */
export interface Tree {
	/** coarse to fine: by level, then z, then x */
	nodes: TreeNode[];
	refs: ContentRef[];
}

/** 'EFTR' */
const TREE_HEADER: HeaderShape = {
	magic: 0x52_54_46_45,
	version: 1,
	size: TABLE_HEADER_SIZE,
	label: 'package tree',
};

const NODE_SIZE = 48;

const REF_SIZE = 24;

const isContentKind = enumGuard(ContentKind);

/**
 * tree.bin: 16-byte header (`'EFTR'`, u16 version, u16 0, u32 nodeCount, u32 refCount), then 48-byte nodes,
 * then 24-byte content refs.
 *
 * node: u8 level, u8 childMask, u16 flags, i32 x, i32 z, f32×3 min, f32×3 max, f32 geometricError, u32
 * refFirst, u32 refCount. ref: u8 kind, u8 tier, u16 0, u32 level, u32 blob, u32 first, u32 count, f32
 * param.
 *
 * @param tree nodes and refs; node ref slices must lie inside `refs`
 * @returns the encoded file
 */
export const encodeTree = (tree: Tree): Uint8Array => {
	const out = new Uint8Array(TABLE_HEADER_SIZE + tree.nodes.length * NODE_SIZE + tree.refs.length * REF_SIZE);
	const view = viewOf(out);
	writeHeader(view, TREE_HEADER);
	view.setUint32(8, tree.nodes.length, true);
	view.setUint32(12, tree.refs.length, true);

	let at = TABLE_HEADER_SIZE;
	for (const node of tree.nodes) {
		if (node.refFirst + node.refCount > tree.refs.length) {
			throw new RangeError(`node ${node.level}/${node.x}/${node.z} refs run past the ref table`);
		}
		view.setUint8(at, node.level);
		view.setUint8(at + 1, node.childMask);
		view.setUint16(at + 2, node.flags, true);
		view.setInt32(at + 4, node.x, true);
		view.setInt32(at + 8, node.z, true);
		for (let i = 0; i < 3; i++) {
			view.setFloat32(at + 12 + i * 4, node.bounds.min[i], true);
			view.setFloat32(at + 24 + i * 4, node.bounds.max[i], true);
		}
		view.setFloat32(at + 36, node.geometricError, true);
		view.setUint32(at + 40, node.refFirst, true);
		view.setUint32(at + 44, node.refCount, true);
		at += NODE_SIZE;
	}
	for (const ref of tree.refs) {
		writeRef(view, at, ref);
		at += REF_SIZE;
	}
	return out;
};

const writeRef = (view: DataView, at: number, ref: ContentRef): void => {
	view.setUint8(at, ref.kind);
	view.setUint8(at + 1, ref.tier);
	view.setUint16(at + 2, 0, true);
	view.setUint32(at + 4, ref.levelTag, true);
	view.setUint32(at + 8, ref.blob, true);
	view.setUint32(at + 12, ref.first, true);
	view.setUint32(at + 16, ref.count, true);
	view.setFloat32(at + 20, ref.param, true);
};

/**
 * @param data tree.bin
 * @returns its nodes and refs
 * @throws {PackageFormatError} on a bad header or length
 */
export const decodeTree = (data: Uint8Array): Tree => {
	const view = viewOf(data);
	checkHeader(view, TREE_HEADER);
	const nodeCount = view.getUint32(8, true);
	const refCount = view.getUint32(12, true);
	checkLength(data, TABLE_HEADER_SIZE + nodeCount * NODE_SIZE + refCount * REF_SIZE, 'package tree');

	const nodes: TreeNode[] = [];
	let at = TABLE_HEADER_SIZE;
	for (let i = 0; i < nodeCount; i++) {
		const f = (offset: number): number => view.getFloat32(at + offset, true);
		nodes.push({
			level: view.getUint8(at),
			x: view.getInt32(at + 4, true),
			z: view.getInt32(at + 8, true),
			childMask: view.getUint8(at + 1),
			flags: view.getUint16(at + 2, true),
			bounds: { min: [f(12), f(16), f(20)], max: [f(24), f(28), f(32)] },
			geometricError: f(36),
			refFirst: view.getUint32(at + 40, true),
			refCount: view.getUint32(at + 44, true),
		});
		at += NODE_SIZE;
	}
	const refs: ContentRef[] = [];
	for (let i = 0; i < refCount; i++) {
		refs.push({
			kind: checkedEnum(isContentKind, view.getUint8(at), 'content kind'),
			tier: view.getUint8(at + 1),
			levelTag: view.getUint32(at + 4, true),
			blob: view.getUint32(at + 8, true),
			first: view.getUint32(at + 12, true),
			count: view.getUint32(at + 16, true),
			param: view.getFloat32(at + 20, true),
		});
		at += REF_SIZE;
	}
	return { nodes, refs };
};
