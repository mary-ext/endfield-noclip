import {
	type TileKey,
	tileAncestor,
	tileFootprint,
	tileId,
	tileQuadrant,
} from '@endfield-noclip/package-format/tiles';
import type { ContentRef, Tree, TreeInfo, TreeNode } from '@endfield-noclip/package-format/tree';
import { type Bounds, unionBounds } from '@endfield-noclip/package-format/values';

/** a node under construction */
interface BuildNode {
	key: TileKey;
	flags: number;
	refs: ContentRef[];
	/** bounds of the node's own content; descendants are merged in by {@link TileTreeBuilder.build} */
	bounds: Bounds | null;
}

/** grows a sparse tile forest; adding to a node creates its ancestors up to level 0 */
export class TileTreeBuilder {
	readonly #tree: Pick<TreeInfo, 'origin' | 'rootSize'>;
	readonly #nodes = new Map<string, BuildNode>();

	/** @param tree grid parameters */
	constructor(tree: Pick<TreeInfo, 'origin' | 'rootSize'>) {
		this.#tree = tree;
	}

	/**
	 * @param key tile address
	 * @param ref content to attach
	 * @param flags {@link NodeFlags} bits to set
	 */
	addRef(key: TileKey, ref: ContentRef, flags: number): void {
		const node = this.#node(key);
		node.refs.push(ref);
		node.flags |= flags;
	}

	/**
	 * @param key tile address
	 * @param bounds world bounds of content drawn by this node
	 */
	extend(key: TileKey, bounds: Bounds): void {
		const node = this.#node(key);
		node.bounds = node.bounds === null ? cloneBounds(bounds) : unionBounds(node.bounds, bounds);
	}

	/**
	 * finishes the tree: merges bounds upwards, sets child masks and orders nodes by level, then z, then x
	 *
	 * @param geometricError error for each node, metres
	 * @returns the encodable tree
	 */
	build(geometricError: (key: TileKey) => number): Tree {
		const ordered = [...this.#nodes.values()].toSorted(
			(a, b) => a.key.level - b.key.level || a.key.z - b.key.z || a.key.x - b.key.x,
		);
		const childMasks = new Map<string, number>();
		// deepest first, so each node's bounds are complete before they reach its parent
		for (let i = ordered.length - 1; i >= 0; i--) {
			const node = ordered[i];
			if (node.bounds === null) {
				const { minX, minZ, size } = tileFootprint(this.#tree, node.key);
				node.bounds = { min: [minX, 0, minZ], max: [minX + size, 0, minZ + size] };
			}
			if (node.key.level === 0) {
				continue;
			}
			const parentId = tileId(tileAncestor(node.key, node.key.level - 1));
			const parent = this.#nodes.get(parentId)!;
			parent.bounds =
				parent.bounds === null ? cloneBounds(node.bounds) : unionBounds(parent.bounds, node.bounds);
			childMasks.set(parentId, (childMasks.get(parentId) ?? 0) | (1 << tileQuadrant(node.key)));
		}

		const nodes: TreeNode[] = [];
		const refs: ContentRef[] = [];
		for (const node of ordered) {
			nodes.push({
				...node.key,
				childMask: childMasks.get(tileId(node.key)) ?? 0,
				flags: node.flags,
				bounds: node.bounds!,
				geometricError: geometricError(node.key),
				refFirst: refs.length,
				refCount: node.refs.length,
			});
			for (const ref of node.refs) {
				refs.push(ref);
			}
		}
		return { nodes, refs };
	}

	#node(key: TileKey): BuildNode {
		let node = this.#nodes.get(tileId(key));
		if (node === undefined) {
			node = { key: { ...key }, flags: 0, refs: [], bounds: null };
			this.#nodes.set(tileId(key), node);
			if (key.level > 0) {
				this.#node(tileAncestor(key, key.level - 1));
			}
		}
		return node;
	}
}

const cloneBounds = (bounds: Bounds): Bounds => ({ min: [...bounds.min], max: [...bounds.max] });
