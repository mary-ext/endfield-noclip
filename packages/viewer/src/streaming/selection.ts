/**
 * the per-frame quadtree traversal. it decides what to draw (terrain patches, instance row ranges) from what
 * is resident, and tells the stream manager what it wants next, prioritised by screen-space error. the rules
 * are in `docs/viewer.md#instance-selection` (REPLACE refinement over HLOD) and
 * `docs/viewer.md#terrain-selection` (CDLOD).
 *
 * @module
 */

import type { ContentRef } from '@endfield-noclip/package-format/tree';

import { type Camera, type Plane, boxInFrustum, distanceToBox } from '../scene/camera.ts';
import { type TileNode, type TileTree, isLeaf } from '../scene/tile-tree.ts';
import type { ViewerOptions } from '../viewer.ts';

import type { ContentItem, StreamManager } from './stream-manager.ts';

// #region types

/** what the traversal draws and refines */
export type SelectionOptions = Pick<
	ViewerOptions,
	| 'maxSse'
	| 'terrainPixels'
	| 'terrain'
	| 'terrainSurface'
	| 'terrainSplat'
	| 'instances'
	| 'detail'
	| 'global'
	| 'hlodTiers'
>;

/** a resident surface page and the node it covers */
export interface SurfaceSource {
	item: ContentItem;
	node: TileNode;
}

/** a terrain patch: one page quadrant (or a whole page as four) */
export interface TerrainPatch {
	item: ContentItem;
	node: TileNode;
	/** quadrant `dz·2 + dx`, or -1 for the whole page */
	quadrant: number;
	morphStart: number;
	morphEnd: number;
	/** the finest resident surface page at or above `node`, or `null` for stand-in colours */
	surface: SurfaceSource | null;
	/** the node's resident close-up splat page (leaves near the camera), or `null` */
	detail: ContentItem | null;
}

/** leaves within this distance load their close-up splat page, m; the shader fades detail out before it */
export const DETAIL_DISTANCE = 160;

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

/** where instances outside the view can still cast shadows into it */
export interface CasterVolume {
	/** the view's planes swept towards the sun (`sweepPlanes` in camera.ts) */
	planes: Plane[];
	/** how far from the camera, m */
	distance: number;
}

/** camera state for one traversal */
export interface SelectionView {
	camera: Camera;
	planes: Plane[];
	/** viewport pixel factor, see {@link Camera.pixelFactor} */
	pixelFactor: number;
	/** instance content in this volume is selected too, at off-screen priority; `null` for none */
	casters: CasterVolume | null;
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
	#stream: Pick<StreamManager, 'want' | 'get' | 'markUsed' | 'isReady'>;
	#global: readonly ContentRef[];
	#pageQuads: number;
	#rootSize: number;
	#focusCells: ReadonlySet<string> | null = null;
	#groupsShown: readonly boolean[] = [];

	/**
	 * @param tree the linked tree
	 * @param stream residency
	 * @param global manifest.global refs, always drawn
	 * @param pageSide samples per height page edge
	 * @param rootSize edge length of a level-0 tile
	 */
	constructor(
		tree: TileTree,
		stream: Pick<StreamManager, 'want' | 'get' | 'markUsed' | 'isReady'>,
		global: readonly ContentRef[],
		pageSide: number,
		rootSize: number,
	) {
		this.#tree = tree;
		this.#stream = stream;
		this.#global = global;
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

		if (options.instances && options.global) {
			// global blobs are pinned: drawn once they arrive, never wanted
			for (const ref of this.#global) {
				if (!this.#shows(ref)) {
					continue;
				}
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
				if (options.detail) {
					this.#conditional(root, view, options);
				}
			}
		}
		return selection;
	}

	// #region instances

	/**
	 * limits instances to the shown level's and shared content that the scene values load
	 *
	 * @param shown per visibility group of the package, whether its content shows
	 */
	setGroupsShown(shown: readonly boolean[]): void {
		this.#groupsShown = shown;
	}

	/**
	 * conditional content has no HLOD stand-in, so it doesn't follow the HLOD refinement. it's dropped once its
	 * tile spans no more than `maxSse` pixels instead; children are smaller and no nearer, so they're skipped
	 * too
	 */
	#conditional(node: TileNode, view: SelectionView, options: SelectionOptions): void {
		this.selection.visited++;
		const eye = view.camera.position;
		const distance = Math.max(distanceToBox(node.bounds.min, node.bounds.max, eye), 1);
		const inView = this.#inView(node, view, distance);
		if (inView === null) {
			return;
		}
		const sse = (node.size * view.pixelFactor) / distance;
		if (sse <= options.maxSse) {
			return;
		}
		for (const ref of node.conditional) {
			if (!this.#shows(ref)) {
				continue;
			}
			const item = this.#stream.want(ref.blob, this.#priority(node, view.pixelFactor / distance, inView));
			if (item !== null) {
				this.selection.instances.push({ item, first: ref.first, count: ref.count });
			}
		}
		for (const child of node.quadrants) {
			if (child !== null) {
				this.#conditional(child, view, options);
			}
		}
	}

	/**
	 * @param distance from the camera to the node's bounds
	 * @returns `true` for a node in view, `false` for one only in the caster volume, `null` for neither
	 */
	#inView(node: TileNode, view: SelectionView, distance: number): boolean | null {
		const { min, max } = node.bounds;
		const eye = view.camera.position;
		if (boxInFrustum(view.planes, min, max, eye)) {
			return true;
		}
		const casters = view.casters;
		if (casters !== null && distance <= casters.distance && boxInFrustum(casters.planes, min, max, eye)) {
			return false;
		}
		return null;
	}

	#shows(ref: ContentRef): boolean {
		return this.#groupsShown[ref.group] ?? false;
	}

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
			if (!options.hlodTiers[ref.tier] || !this.#shows(ref)) {
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
		return node.hlod.some((ref) => options.hlodTiers[ref.tier] && this.#shows(ref));
	}

	/** @returns whether the node's area is fully covered by what was emitted (or needs nothing) */
	#instances(node: TileNode, view: SelectionView, options: SelectionOptions): boolean {
		this.selection.visited++;
		const distance = Math.max(distanceToBox(node.bounds.min, node.bounds.max, view.camera.position), 1);
		const inView = this.#inView(node, view, distance);
		if (inView === null) {
			return true;
		}
		// content outside the view only casts shadows into it, so its streaming never holds back what's in view
		return this.#refineInstances(node, view, options, { distance, inView }) || !inView;
	}

	/** {@link #instances} for a node in view or in the caster volume */
	#refineInstances(
		node: TileNode,
		view: SelectionView,
		options: SelectionOptions,
		{ distance, inView }: { distance: number; inView: boolean },
	): boolean {
		const out = this.selection.instances;
		const sse = (node.geometricError * view.pixelFactor) / distance;
		const priority = this.#priority(node, sse, inView);
		const hasHlod = this.#hasHlod(node, options);
		const leaf = isLeaf(node);
		// a leaf refines even without detail of its own (`docs/viewer.md#instance-selection`)
		const canRefine = !leaf || options.detail;
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
				if (!this.#shows(ref)) {
					continue;
				}
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
			this.#terrain(node, view, options, null);
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

	/** @param inherited the finest resident surface page above `node` */
	#terrain(
		node: TileNode,
		view: SelectionView,
		options: SelectionOptions,
		inherited: SurfaceSource | null,
	): void {
		const terrain = node.terrain;
		if (terrain === null) {
			return;
		}
		const eye = view.camera.position;
		const inView = boxInFrustum(view.planes, node.bounds.min, node.bounds.max, eye);
		const distance = Math.max(distanceToBox(node.bounds.min, node.bounds.max, eye), 1);
		const sse = (this.#spacing(node.level) * view.pixelFactor) / distance;
		const priority = this.#priority(node, sse, inView);
		const item = this.#stream.want(terrain.blob, priority);
		// until a node's surface page arrives, its patches show the nearest ancestor's, magnified
		let surface = inherited;
		if (options.terrainSurface && node.surface !== null) {
			const page = this.#stream.want(node.surface.blob, priority);
			if (page !== null) {
				surface = { item: page, node };
			}
		}
		let detail: ContentItem | null = null;
		if (options.terrainSplat && node.terrainSplat !== null && distance < DETAIL_DISTANCE) {
			detail = this.#stream.want(node.terrainSplat.blob, priority);
		}
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
			this.selection.patches.push({ item, node, quadrant: -1, morphStart, morphEnd, surface, detail });
			return;
		}
		for (let quadrant = 0; quadrant < 4; quadrant++) {
			const child = node.quadrants[quadrant];
			if (child?.terrain != null && this.#stream.isReady(child.terrain.blob)) {
				this.#terrain(child, view, options, surface);
				continue;
			}
			if (child?.terrain != null) {
				this.#stream.want(child.terrain.blob, this.#priority(child, sse * 2, true));
			}
			this.selection.patches.push({ item, node, quadrant, morphStart, morphEnd, surface, detail: null });
		}
	}

	// #endregion
}
