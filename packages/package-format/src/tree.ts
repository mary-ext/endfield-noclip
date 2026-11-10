import {
	viewOf,
	checkHeader,
	enumGuard,
	checkedEnum,
	checkLength,
	writeHeader,
	type HeaderShape,
} from './binary.ts';
import { PackageFormatError } from './errors.ts';
import type { Bounds, Rect } from './values.ts';

/** what a tile content reference points at */
export const ContentKind = {
	/** the node's terrain height page */
	TerrainHeights: 0,
	/** HLOD cluster rows `[first, first + count)` of an instance block; `tier` is the HLOD tier */
	Hlod: 1,
	/** detail instances the HLODs stand in for: a whole instance block, drawn once its leaf refines */
	Detail: 2,
	/**
	 * instances the HLODs don't stand in for (scene-state and dynamic content): a whole instance block, drawn
	 * regardless of refinement while the camera is within the detail distance of its tile, or, with a `reach`,
	 * while the camera is inside that reach
	 */
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
}

/** a reference from a tree node, or from {@link Tree.global}, to content */
export interface ContentRef {
	kind: ContentKind;
	/** HLOD tier for {@link ContentKind.Hlod}; 0 otherwise */
	tier: number;
	/**
	 * index into `StatesInfo.groups`: who owns the content and when it loads. terrain uses an always-shown
	 * group
	 */
	group: number;
	/** blob index */
	blob: number;
	/** first row, for refs into a shared instance block; 0 otherwise */
	first: number;
	/** row count (instances), or 1 for single-item blobs */
	count: number;
	/**
	 * for {@link ContentKind.Conditional}, index into {@link Tree.reaches}: the content draws while the camera is
	 * inside it, however far its tile. `null` otherwise
	 */
	reach: number | null;
}

/** a tree node */
export interface TreeNode {
	level: number;
	x: number;
	z: number;
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
	/** the nodes' refs, each node's a contiguous slice */
	refs: ContentRef[];
	/**
	 * content drawn regardless of the tree's refinement while its group shows (the game's Global chunk scenery,
	 * conditional where it comes from scene-state chunks)
	 */
	global: ContentRef[];
	/** world x, z rectangles {@link ContentRef.reach} names, `[min, max)` on each axis; a bound may be infinite */
	reaches: Rect[];
}

/** 'EFTR' */
const TREE_HEADER: HeaderShape = {
	magic: 0x52_54_46_45,
	version: 3,
	size: 24,
	label: 'package tree',
};

const NODE_SIZE = 48;
const REF_SIZE = 24;
const REACH_SIZE = 16;
/** a `null` reach, as encoded */
const NONE = 0xff_ff_ff_ff;

const isContentKind = enumGuard(ContentKind);

/**
 * tree.bin; the layout is in docs/package-format.md (binary encodings).
 *
 * @param tree nodes, refs and reaches
 * @returns the encoded file
 * @throws {RangeError} if a node's ref slice runs past `refs`, or a ref's reach past `reaches`
 */
export const encodeTree = (tree: Tree): Uint8Array => {
	const refCount = tree.refs.length + tree.global.length;
	const out = new Uint8Array(
		TREE_HEADER.size + tree.nodes.length * NODE_SIZE + refCount * REF_SIZE + tree.reaches.length * REACH_SIZE,
	);
	const view = viewOf(out);
	writeHeader(view, TREE_HEADER);
	view.setUint32(8, tree.nodes.length, true);
	view.setUint32(12, tree.refs.length, true);
	view.setUint32(16, tree.global.length, true);
	view.setUint32(20, tree.reaches.length, true);

	let at = TREE_HEADER.size;
	for (const node of tree.nodes) {
		if (node.refFirst + node.refCount > tree.refs.length) {
			throw new RangeError(`node ${node.level}/${node.x}/${node.z} refs run past the ref table`);
		}
		view.setInt32(at, node.x, true);
		view.setInt32(at + 4, node.z, true);
		view.setUint8(at + 8, node.level);
		for (let i = 0; i < 3; i++) {
			view.setFloat32(at + 12 + i * 4, node.bounds.min[i], true);
			view.setFloat32(at + 24 + i * 4, node.bounds.max[i], true);
		}
		view.setFloat32(at + 36, node.geometricError, true);
		view.setUint32(at + 40, node.refFirst, true);
		view.setUint32(at + 44, node.refCount, true);
		at += NODE_SIZE;
	}
	for (const ref of [...tree.refs, ...tree.global]) {
		if (ref.reach !== null && ref.reach >= tree.reaches.length) {
			throw new RangeError(`a ref's reach ${ref.reach} runs past the reach table`);
		}
		view.setUint8(at, ref.kind);
		view.setUint8(at + 1, ref.tier);
		view.setUint32(at + 4, ref.group, true);
		view.setUint32(at + 8, ref.blob, true);
		view.setUint32(at + 12, ref.first, true);
		view.setUint32(at + 16, ref.count, true);
		view.setUint32(at + 20, ref.reach ?? NONE, true);
		at += REF_SIZE;
	}
	for (const reach of tree.reaches) {
		view.setFloat32(at, reach.minX, true);
		view.setFloat32(at + 4, reach.minZ, true);
		view.setFloat32(at + 8, reach.maxX, true);
		view.setFloat32(at + 12, reach.maxZ, true);
		at += REACH_SIZE;
	}
	return out;
};

/**
 * @param data tree.bin
 * @returns its nodes, refs and reaches
 * @throws {PackageFormatError} on a bad header, length or reach index
 */
export const decodeTree = (data: Uint8Array): Tree => {
	const view = viewOf(data);
	checkHeader(view, TREE_HEADER);
	const nodeCount = view.getUint32(8, true);
	const refCount = view.getUint32(12, true);
	const globalCount = view.getUint32(16, true);
	const reachCount = view.getUint32(20, true);
	checkLength(
		data,
		TREE_HEADER.size + nodeCount * NODE_SIZE + (refCount + globalCount) * REF_SIZE + reachCount * REACH_SIZE,
		'package tree',
	);

	const nodes: TreeNode[] = [];
	let at = TREE_HEADER.size;
	for (let i = 0; i < nodeCount; i++) {
		const f = (offset: number): number => view.getFloat32(at + offset, true);
		nodes.push({
			level: view.getUint8(at + 8),
			x: view.getInt32(at, true),
			z: view.getInt32(at + 4, true),
			bounds: { min: [f(12), f(16), f(20)], max: [f(24), f(28), f(32)] },
			geometricError: f(36),
			refFirst: view.getUint32(at + 40, true),
			refCount: view.getUint32(at + 44, true),
		});
		at += NODE_SIZE;
	}
	const readRefs = (count: number): ContentRef[] => {
		const refs: ContentRef[] = [];
		for (let i = 0; i < count; i++) {
			const reach = view.getUint32(at + 20, true);
			if (reach !== NONE && reach >= reachCount) {
				throw new PackageFormatError(`a ref's reach ${reach} runs past the reach table`);
			}
			refs.push({
				kind: checkedEnum(isContentKind, view.getUint8(at), 'content kind'),
				tier: view.getUint8(at + 1),
				group: view.getUint32(at + 4, true),
				blob: view.getUint32(at + 8, true),
				first: view.getUint32(at + 12, true),
				count: view.getUint32(at + 16, true),
				reach: reach === NONE ? null : reach,
			});
			at += REF_SIZE;
		}
		return refs;
	};
	const refs = readRefs(refCount);
	const global = readRefs(globalCount);
	const reaches: Rect[] = [];
	for (let i = 0; i < reachCount; i++) {
		const f = (offset: number): number => view.getFloat32(at + offset, true);
		reaches.push({ minX: f(0), minZ: f(4), maxX: f(8), maxZ: f(12) });
		at += REACH_SIZE;
	}
	return { nodes, refs, global, reaches };
};
