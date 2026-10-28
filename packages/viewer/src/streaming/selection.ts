/**
 * the per-frame quadtree traversal. it decides what to draw (terrain patches, instance row ranges) from what
 * is resident, and tells the stream manager what it wants next, prioritised by screen-space error.
 *
 * - instances: REPLACE refinement. a node draws its HLOD while `SSE(geometricError) ≤ maxSse`, otherwise its
 *   children; a leaf refines into its detail blocks. until everything a refinement needs is resident the node
 *   keeps drawing its own HLOD, so there are no holes while streaming. disabled HLOD tiers are refined past.
 * - terrain: CDLOD. each level has a distance range derived from its sample spacing and the pixel-error target;
 *   a node subdivides while the next finer range reaches it, quadrants whose child page isn't resident are
 *   drawn from the parent page, and vertices morph to the coarser grid towards the end of their range.
 *
 * @module
 */

import type { ContentRef } from '@endfield-noclip/package-format/format';

import { type Camera, type Plane, boxInFrustum, distanceToBox } from '../scene/camera.ts';
import { type TileNode, type TileTree, isLeaf } from '../scene/tile-tree.ts';
import type { ViewerOptions } from '../viewer.ts';

import type { ContentItem, StreamManager } from './stream-manager.ts';

// #region types

/** what the traversal draws and refines */
export type SelectionOptions = Pick<
	ViewerOptions,
	'maxSse' | 'terrainPixels' | 'terrain' | 'instances' | 'detail' | 'resident' | 'hlodTiers'
>;

/** a terrain patch: one page quadrant (or a whole page as four) */
export interface TerrainPatch {
	item: ContentItem;
	node: TileNode;
	/** quadrant `dz·2 + dx`, or -1 for the whole page */
	quadrant: number;
	morphStart: number;
	morphEnd: number;
}

/** a range of rows of one resident instance block */
export interface InstanceRange {
	item: ContentItem;
	first: number;
	count: number;
}

/** the traversal's output, reused across frames */
export interface Selection {
	patches: TerrainPatch[];
	instances: InstanceRange[];
	/** nodes visited, for stats */
	visited: number;
}

/** camera state for one traversal */
export interface SelectionView {
	camera: Camera;
	planes: Plane[];
	/** viewport pixel factor, see {@link Camera.pixelFactor} */
	pixelFactor: number;
}

// #endregion

/** start morphing at this fraction of a level's range */
const MORPH_START = 0.7;
/** priority multiplier for content in the focused area */
const FOCUS_BOOST = 8;
/** priority multiplier for content outside the frustum (prefetch around the camera) */
const OFFSCREEN_PRIORITY = 0.1;

/** the traversal for one package */
export class Selector {
	readonly selection: Selection = { patches: [], instances: [], visited: 0 };
	#tree: TileTree;
	#stream: StreamManager;
	#resident: readonly ContentRef[];
	#pageQuads: number;
	#rootSize: number;
	#focusCells: ReadonlySet<string> | null = null;

	/**
	 * @param tree the linked tree
	 * @param stream residency
	 * @param resident manifest.resident refs, always drawn
	 * @param pageSide samples per height page edge
	 * @param rootSize edge length of a level-0 tile
	 */
	constructor(
		tree: TileTree,
		stream: StreamManager,
		resident: readonly ContentRef[],
		pageSide: number,
		rootSize: number,
	) {
		this.#tree = tree;
		this.#stream = stream;
		this.#resident = resident;
		this.#pageQuads = pageSide - 1;
		this.#rootSize = rootSize;
	}

	/**
	 * @param view camera and frustum
	 * @param options toggles and thresholds
	 * @param focusCells {@link TileNode.cellId}s whose content loads first, or `null`
	 * @returns this frame's selection (the same object every frame)
	 */
	run(view: SelectionView, options: SelectionOptions, focusCells: ReadonlySet<string> | null): Selection {
		const selection = this.selection;
		selection.patches.length = 0;
		selection.instances.length = 0;
		selection.visited = 0;
		this.#focusCells = focusCells;

		if (options.instances && options.resident) {
			// resident blobs are pinned: drawn once they arrive, never wanted
			for (const ref of this.#resident) {
				const item = this.#stream.markUsed(ref.blob) ? this.#stream.get(ref.blob) : undefined;
				if (item !== undefined) {
					selection.instances.push({ item, first: ref.first, count: ref.count });
				}
			}
		}
		for (const root of this.#tree.roots) {
			if (options.terrain) {
				this.#terrainRoot(root, view, options);
			}
			if (options.instances) {
				this.#instances(root, view, options);
			}
		}
		return selection;
	}

	// #region instances

	#priority(node: TileNode, sse: number, inView: boolean): number {
		let priority = sse * (inView ? 1 : OFFSCREEN_PRIORITY);
		if (this.#focusCells !== null && node.cellId !== null && this.#focusCells.has(node.cellId)) {
			priority *= FOCUS_BOOST;
		}
		return priority;
	}

	/** @returns the node's HLOD refs if all are resident (marking them used), `[]` if it has none, else `null` */
	#readyHlod(node: TileNode, options: SelectionOptions, priority: number): InstanceRange[] | null {
		const ranges: InstanceRange[] = [];
		let ready = true;
		for (const ref of node.hlod) {
			if (!options.hlodTiers[ref.tier]) {
				continue;
			}
			const item = this.#stream.want(ref.blob, priority);
			if (item === null) {
				ready = false;
			} else {
				ranges.push({ item, first: ref.first, count: ref.count });
			}
		}
		return ready ? ranges : null;
	}

	#hasHlod(node: TileNode, options: SelectionOptions): boolean {
		return node.hlod.some((ref) => options.hlodTiers[ref.tier]);
	}

	/** @returns whether the node's area is fully covered by what was emitted (or needs nothing) */
	#instances(node: TileNode, view: SelectionView, options: SelectionOptions): boolean {
		const out = this.selection.instances;
		this.selection.visited++;
		const eye = view.camera.position;
		if (!boxInFrustum(view.planes, node.bounds.min, node.bounds.max, eye)) {
			return true;
		}
		const distance = Math.max(distanceToBox(node.bounds.min, node.bounds.max, eye), 1);
		const sse = (node.geometricError * view.pixelFactor) / distance;
		const priority = this.#priority(node, sse, true);
		const hasHlod = this.#hasHlod(node, options);
		const leaf = isLeaf(node);
		const canRefine = !leaf || (options.detail && node.detail.length > 0);
		const refine = canRefine && (sse > options.maxSse || !hasHlod);

		if (!refine) {
			if (!hasHlod) {
				return true;
			}
			const hlod = this.#readyHlod(node, options, priority);
			if (hlod !== null) {
				out.push(...hlod);
				return true;
			}
			return false;
		}

		const mark = out.length;
		let complete = true;
		if (leaf) {
			for (const ref of node.detail) {
				const item = this.#stream.want(ref.blob, priority);
				if (item === null) {
					complete = false;
				} else {
					out.push({ item, first: ref.first, count: ref.count });
				}
			}
		} else {
			for (const child of node.quadrants) {
				if (child !== null) {
					complete = this.#instances(child, view, options) && complete;
				}
			}
		}
		if (complete || !hasHlod) {
			return complete;
		}
		// the refinement isn't resident yet: keep showing this node's HLOD meanwhile
		const hlod = this.#readyHlod(node, options, priority);
		if (hlod === null) {
			return false;
		}
		out.length = mark;
		out.push(...hlod);
		return true;
	}

	// #endregion

	// #region terrain

	#terrainRoot(node: TileNode, view: SelectionView, options: SelectionOptions): void {
		if (node.terrain !== null) {
			this.#terrain(node, view, options);
			return;
		}
		for (const child of node.quadrants) {
			if (child !== null) {
				this.#terrainRoot(child, view, options);
			}
		}
	}

	/** distance up to which `level`'s pages are fine enough */
	#range(level: number, view: SelectionView, options: SelectionOptions): number {
		return (this.#spacing(level) * view.pixelFactor) / options.terrainPixels;
	}

	/** metres between height samples at `level` */
	#spacing(level: number): number {
		return this.#rootSize / 2 ** level / this.#pageQuads;
	}

	#terrain(node: TileNode, view: SelectionView, options: SelectionOptions): void {
		const terrain = node.terrain;
		if (terrain === null) {
			return;
		}
		const eye = view.camera.position;
		const inView = boxInFrustum(view.planes, node.bounds.min, node.bounds.max, eye);
		const distance = Math.max(distanceToBox(node.bounds.min, node.bounds.max, eye), 1);
		const sse = (this.#spacing(node.level) * view.pixelFactor) / distance;
		const item = this.#stream.want(terrain.blob, this.#priority(node, sse, inView));
		if (!inView || item === null) {
			// a missing page is covered from its parent's
			return;
		}

		const level = node.level;
		const isCoarsest = level === this.#tree.terrainRootLevel;
		const morphEnd = isCoarsest ? Infinity : this.#range(level, view, options);
		const morphStart = isCoarsest ? Infinity : morphEnd * MORPH_START;
		const finerRange = this.#range(level + 1, view, options);
		const subdivide = level < this.#tree.terrainLeafLevel && distance < finerRange;
		if (!subdivide) {
			this.selection.patches.push({ item, node, quadrant: -1, morphStart, morphEnd });
			return;
		}
		for (let quadrant = 0; quadrant < 4; quadrant++) {
			const child = node.quadrants[quadrant];
			if (child?.terrain != null && this.#stream.isReady(child.terrain.blob)) {
				this.#terrain(child, view, options);
				continue;
			}
			if (child?.terrain != null) {
				this.#stream.want(child.terrain.blob, this.#priority(child, sse * 2, true));
			}
			this.selection.patches.push({ item, node, quadrant, morphStart, morphEnd });
		}
	}

	// #endregion
}
