/**
 * the package's tile quadtree as linked nodes, with content refs sorted by kind.
 *
 * @module
 */

import type { PackageManifest } from '@endfield-noclip/package-format/manifest';
import { tileAncestor, tileFootprint, tileId, tileQuadrant } from '@endfield-noclip/package-format/tiles';
import { ContentKind, type ContentRef, type Tree } from '@endfield-noclip/package-format/tree';
import type { Bounds } from '@endfield-noclip/package-format/values';

/** a tree node with its children linked and its refs split by kind */
export interface TileNode {
	index: number;
	level: number;
	x: number;
	z: number;
	/** world x, z of the tile's minimum corner and its edge length */
	minX: number;
	minZ: number;
	size: number;
	/** content bounds of the node and its descendants (may overhang the tile) */
	bounds: Bounds;
	geometricError: number;
	/** children by {@link tileQuadrant}, `null` where absent */
	quadrants: (TileNode | null)[];
	/** the node's height page, if it has one */
	terrain: ContentRef | null;
	/** the node's baked surface page, if it has one */
	surface: ContentRef | null;
	/** the leaf's close-up terrain blend inputs, if it has them */
	terrainSplat: ContentRef | null;
	hlod: ContentRef[];
	detail: ContentRef[];
	conditional: ContentRef[];
	/** {@link tileId} of the cellLevel ancestor (or self), for focus lookups; `null` above cellLevel */
	cellId: string | null;
}

/** the linked tree */
export interface TileTree {
	nodes: TileNode[];
	roots: TileNode[];
	/** nodes by {@link tileId} */
	byId: Map<string, TileNode>;
	/** finest level with terrain pages */
	terrainLeafLevel: number;
	/** coarsest level with terrain pages */
	terrainRootLevel: number;
}

/**
 * @param node a node
 * @returns whether the node has no children
 */
export const isLeaf = (node: TileNode): boolean => node.quadrants.every((child) => child === null);

/**
 * @param manifest the package manifest
 * @param tree decoded tree.bin
 * @returns linked nodes
 */
export const buildTileTree = (manifest: PackageManifest, tree: Tree): TileTree => {
	const info = manifest.tree;
	const byId = new Map<string, TileNode>();
	const nodes = tree.nodes.map((raw, index): TileNode => {
		const footprint = tileFootprint(info, raw);
		let terrain: ContentRef | null = null;
		let surface: ContentRef | null = null;
		let terrainSplat: ContentRef | null = null;
		const hlod: ContentRef[] = [];
		const detail: ContentRef[] = [];
		const conditional: ContentRef[] = [];
		for (let i = raw.refFirst; i < raw.refFirst + raw.refCount; i++) {
			const ref = tree.refs[i];
			switch (ref.kind) {
				case ContentKind.TerrainHeights: {
					terrain = ref;
					break;
				}
				case ContentKind.Hlod: {
					hlod.push(ref);
					break;
				}
				case ContentKind.Detail: {
					detail.push(ref);
					break;
				}
				case ContentKind.Conditional: {
					conditional.push(ref);
					break;
				}
				case ContentKind.TerrainSurface: {
					surface = ref;
					break;
				}
				case ContentKind.TerrainSplat: {
					terrainSplat = ref;
					break;
				}
			}
		}
		const node: TileNode = {
			index,
			level: raw.level,
			x: raw.x,
			z: raw.z,
			minX: footprint.minX,
			minZ: footprint.minZ,
			size: footprint.size,
			bounds: raw.bounds,
			geometricError: raw.geometricError,
			quadrants: [null, null, null, null],
			terrain,
			surface,
			terrainSplat,
			hlod,
			detail,
			conditional,
			cellId: raw.level >= info.cellLevel ? tileId(tileAncestor(raw, info.cellLevel)) : null,
		};
		byId.set(tileId(raw), node);
		return node;
	});

	const roots: TileNode[] = [];
	let terrainLeafLevel = -1;
	let terrainRootLevel = Infinity;
	for (const node of nodes) {
		if (node.terrain !== null) {
			terrainLeafLevel = Math.max(terrainLeafLevel, node.level);
			terrainRootLevel = Math.min(terrainRootLevel, node.level);
		}
		const parent = node.level === 0 ? undefined : byId.get(tileId(tileAncestor(node, node.level - 1)));
		if (parent === undefined) {
			roots.push(node);
			continue;
		}
		parent.quadrants[tileQuadrant(node)] = node;
	}
	return { nodes, roots, byId, terrainLeafLevel, terrainRootLevel };
};
