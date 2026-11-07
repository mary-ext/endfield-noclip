import { dynamicGridLoaded } from '@endfield-noclip/package-format/dynamic-grids';
import { TERRAIN_PAGE_SAMPLES } from '@endfield-noclip/package-format/terrain';
import type { ContentRef } from '@endfield-noclip/package-format/tree';

import { type Camera, type Plane, boxInFrustum, distanceToBox } from '../scene/camera.ts';
import { type TileNode, type TileTree, isLeaf } from '../scene/tile-tree.ts';

import type { ContentItem } from './content-item.ts';
import type { StreamManager } from './stream-manager.ts';

// #region types

/** what the traversal draws and refines (the viewer's options of the same names) */
export interface SelectionOptions {
	terrain: boolean;
	/** want terrain surface pages */
	terrainSurface: boolean;
	/** want terrain splat pages near the camera */
	terrainSplat: boolean;
	instances: boolean;
	/** refine leaves into their detail blocks, and draw conditional content */
	detail: boolean;
	/** draw the manifest's global refs */
	global: boolean;
	/** enabled HLOD tiers 0–2 */
	hlodTiers: readonly [boolean, boolean, boolean];
	/** detail and conditional content draw within this distance of the camera, m ({@link hlodRing}) */
	detailDistance: number;
	/** terrain sample spacing target, px */
	terrainPixels: number;
}

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

/**
 * the game's HLOD0 and HLOD1 load radii on PC at its high scene detail (4000), m: a tier's clusters give way
 * to the next finer tier inside the finer tier's radius (`docs/game-data/world.md#streaming-layers`)
 */
const HLOD_RADII = [512, 1024] as const;

/**
 * @param tier the HLOD tier a node holds, or `null` for a node without HLOD
 * @param detailDistance the detail radius, m
 * @param leaf whether the node is a leaf, whose refinement is its detail
 * @returns how near the camera has to be for the node to refine, m
 */
export const hlodRing = (tier: number | null, detailDistance: number, leaf: boolean): number => {
	if (tier === null) {
		return leaf ? detailDistance : Infinity;
	}
	// tier t refines into tier t − 1, which shows within its own radius; tier 0 refines into detail
	return tier === 0
		? detailDistance
		: Math.max(HLOD_RADII[Math.min(tier, HLOD_RADII.length) - 1], detailDistance);
};

/** start morphing at this fraction of a level's range */
const MORPH_START = 0.7;
/** priority multiplier for content in the focused area */
const FOCUS_BOOST = 8;
/**
 * content within this distance of the camera, m, outranks the focused area's: what's around the camera loads
 * first
 */
const NEAR_DISTANCE = 256;
/** priority multiplier for content within {@link NEAR_DISTANCE}, in place of {@link FOCUS_BOOST} */
const NEAR_BOOST = FOCUS_BOOST * 8;
/** priority multiplier for content outside the frustum (prefetch around the camera) */
const OFFSCREEN_PRIORITY = 0.1;

/** the traversal for one package */
export class Selector {
	readonly selection: Selection = { patches: [], instances: [], visited: 0 };
	#tree: TileTree;
	#stream: Pick<StreamManager, 'want' | 'get' | 'markUsed' | 'isReady'>;
	#global: readonly ContentRef[];
	#rootSize: number;
	#focusCells: ReadonlySet<string> | null = null;
	#groupsShown: readonly boolean[] = [];
	/** the objects of {@link Selection.instances}, by position, reused across frames */
	#rangePool: InstanceRange[] = [];
	/** the objects of {@link Selection.patches}, by position, reused across frames */
	#patchPool: TerrainPatch[] = [];
	/** each node's surface source, reused across frames */
	#surfaces = new Map<TileNode, SurfaceSource>();

	/**
	 * @param tree the linked tree
	 * @param stream residency
	 * @param global manifest.global refs, always drawn
	 * @param rootSize edge length of a level-0 tile
	 */
	constructor(
		tree: TileTree,
		stream: Pick<StreamManager, 'want' | 'get' | 'markUsed' | 'isReady'>,
		global: readonly ContentRef[],
		rootSize: number,
	) {
		this.#tree = tree;
		this.#stream = stream;
		this.#global = global;
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
					this.#emitRange(item, ref);
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
		if (options.instances && options.detail) {
			this.#gridded(view);
		}
		return selection;
	}

	// #region instances

	/**
	 * limits instances to the content that the scene values load
	 *
	 * @param shown per visibility group of the package, whether its content shows
	 */
	setGroupsShown(shown: readonly boolean[]): void {
		this.#groupsShown = shown;
	}

	/**
	 * conditional content has no HLOD stand-in, so it doesn't follow the HLOD refinement. it draws within the
	 * detail distance, as the game's detail layers load; children are no nearer, so they're skipped too
	 */
	#conditional(node: TileNode, view: SelectionView, options: SelectionOptions): void {
		this.selection.visited++;
		const eye = view.camera.position;
		const distance = Math.max(distanceToBox(node.bounds.min, node.bounds.max, eye), 1);
		if (distance >= options.detailDistance) {
			return;
		}
		const inView = this.#inView(node, view, distance);
		if (inView === null) {
			return;
		}
		for (const ref of node.conditional) {
			if (!this.#shows(ref)) {
				continue;
			}
			const item = this.#stream.want(
				ref.blob,
				this.#priority(node, view.pixelFactor / distance, inView, distance),
			);
			if (item !== null) {
				this.#emitRange(item, ref);
			}
		}
		for (const child of node.quadrants) {
			if (child !== null) {
				this.#conditional(child, view, options);
			}
		}
	}

	/**
	 * dynamic content draws while the game would have its DynamicStreaming grid loaded, the camera standing in
	 * for the game's streaming centre, so a grid's level sets how far its rows reach
	 * (`docs/viewer/streaming.md#instance-selection`)
	 */
	#gridded(view: SelectionView): void {
		const eye = view.camera.position;
		for (const { grid, refs } of this.#tree.gridded) {
			if (!dynamicGridLoaded(grid, eye[0], eye[2])) {
				continue;
			}
			for (const { node, ref } of refs) {
				if (!this.#shows(ref)) {
					continue;
				}
				const distance = Math.max(distanceToBox(node.bounds.min, node.bounds.max, eye), 1);
				const inView = this.#inView(node, view, distance);
				if (inView === null) {
					continue;
				}
				const item = this.#stream.want(
					ref.blob,
					this.#priority(node, view.pixelFactor / distance, inView, distance),
				);
				if (item !== null) {
					this.#emitRange(item, ref);
				}
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

	/** @param distance from the camera to the node's bounds */
	#priority(node: TileNode, sse: number, inView: boolean, distance: number): number {
		let priority = sse * (inView ? 1 : OFFSCREEN_PRIORITY);
		if (distance < NEAR_DISTANCE) {
			priority *= NEAR_BOOST;
		} else if (this.#focusCells !== null && node.cellId !== null && this.#focusCells.has(node.cellId)) {
			priority *= FOCUS_BOOST;
		}
		return priority;
	}

	/** appends a row range of a resident block to the selection, in a pooled object */
	#emitRange(item: ContentItem, ref: ContentRef): void {
		const out = this.selection.instances;
		const pool = this.#rangePool;
		let range = pool[out.length];
		if (range === undefined) {
			range = { item, first: ref.first, count: ref.count };
			pool.push(range);
		} else {
			range.item = item;
			range.first = ref.first;
			range.count = ref.count;
		}
		out.push(range);
	}

	/**
	 * wants the node's HLOD refs and, if all are resident (or it has none), appends them to the selection
	 *
	 * @returns whether they were appended
	 */
	#emitHlod(node: TileNode, options: SelectionOptions, priority: number): boolean {
		const out = this.selection.instances;
		const start = out.length;
		let ready = true;
		for (const ref of node.hlod) {
			if (!options.hlodTiers[ref.tier] || !this.#shows(ref)) {
				continue;
			}
			const item = this.#stream.want(ref.blob, priority);
			if (item === null) {
				ready = false;
			} else {
				this.#emitRange(item, ref);
			}
		}
		if (!ready) {
			out.length = start;
		}
		return ready;
	}

	/** @returns the finest HLOD tier the node shows, or `null` when it shows none */
	#hlodTier(node: TileNode, options: SelectionOptions): number | null {
		let tier: number | null = null;
		for (const ref of node.hlod) {
			if (options.hlodTiers[ref.tier] && this.#shows(ref)) {
				tier = tier === null ? ref.tier : Math.min(tier, ref.tier);
			}
		}
		return tier;
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
		const priority = this.#priority(node, sse, inView, distance);
		const tier = this.#hlodTier(node, options);
		const hasHlod = tier !== null;
		const leaf = isLeaf(node);
		// a leaf refines even without detail of its own (`docs/viewer/streaming.md#instance-selection`)
		const canRefine = !leaf || options.detail;
		const refine = canRefine && distance < hlodRing(tier, options.detailDistance, leaf);

		if (!refine) {
			return !hasHlod || this.#emitHlod(node, options, priority);
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
					this.#emitRange(item, ref);
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
		// the refinement isn't resident yet: keep showing this node's HLOD meanwhile, in its place
		const end = out.length;
		if (!this.#emitHlod(node, options, priority)) {
			return false;
		}
		// the pooled objects stay at their positions, so the HLOD's values move down into them
		for (let from = end, to = mark; from < out.length; from++, to++) {
			out[to].item = out[from].item;
			out[to].first = out[from].first;
			out[to].count = out[from].count;
		}
		out.length = mark + (out.length - end);
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
		return this.#rootSize / 2 ** level / (TERRAIN_PAGE_SAMPLES - 1);
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
		const priority = this.#priority(node, sse, inView, distance);
		const item = this.#stream.want(terrain.blob, priority);
		// until a node's surface page arrives, its patches show the nearest ancestor's, magnified
		let surface = inherited;
		if (options.terrainSurface && node.surface !== null) {
			const page = this.#stream.want(node.surface.blob, priority);
			if (page !== null) {
				surface = this.#surfaces.getOrInsertComputed(node, () => ({ item: page, node }));
				surface.item = page;
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
			const patch = this.#nextPatch(item, node);
			patch.quadrant = -1;
			patch.morphStart = morphStart;
			patch.morphEnd = morphEnd;
			patch.surface = surface;
			patch.detail = detail;
			return;
		}
		for (let quadrant = 0; quadrant < 4; quadrant++) {
			const child = node.quadrants[quadrant];
			if (child?.terrain != null && this.#stream.isReady(child.terrain.blob)) {
				this.#terrain(child, view, options, surface);
				continue;
			}
			if (child?.terrain != null) {
				this.#stream.want(child.terrain.blob, this.#priority(child, sse * 2, true, distance));
			}
			const patch = this.#nextPatch(item, node);
			patch.quadrant = quadrant;
			patch.morphStart = morphStart;
			patch.morphEnd = morphEnd;
			patch.surface = surface;
			patch.detail = null;
		}
	}

	/** @returns a pooled patch of `item`'s page, appended to the selection; the caller sets the rest */
	#nextPatch(item: ContentItem, node: TileNode): TerrainPatch {
		const out = this.selection.patches;
		const pool = this.#patchPool;
		let patch = pool[out.length];
		if (patch === undefined) {
			patch = { item, node, quadrant: -1, morphStart: 0, morphEnd: 0, surface: null, detail: null };
			pool.push(patch);
		}
		patch.item = item;
		patch.node = node;
		out.push(patch);
		return patch;
	}

	// #endregion
}
