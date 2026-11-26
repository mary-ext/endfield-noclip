import { TERRAIN_PAGE_SAMPLES } from '@endfield-noclip/package-format/terrain';
import type { ContentRef } from '@endfield-noclip/package-format/tree';

import type { ShadowLayerVolumes } from '../render/shadows/shadow-map.ts';
import { type Camera, type Plane, boxInFrustum, distanceToBox } from '../scene/camera.ts';
import { type TileNode, type TileTree, isLeaf } from '../scene/tile-tree.ts';

import type { ContentItem } from './content-item.ts';
import { boxTouchesShadowLayers, boxTouchesSpheres } from './instance-culling.ts';
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
	/**
	 * 8-bit transition fade code packed into the visible list's top byte (`list_fade` in frame-core.ts): `0` =
	 * opaque, `1..127` = fading in (`code / 128`), `129..255` = fading out (`(code - 128) / 128`)
	 */
	fade: number;
}

/** the traversal's output, reused across frames */
export interface Selection {
	patches: TerrainPatch[];
	instances: InstanceRange[];
	/** nodes visited, for stats */
	visited: number;
	/** whether any HLOD/detail, conditional, or reached transition is still cross-fading */
	fading: boolean;
}

/** where instances outside the view can still cast shadows into it */
export interface CasterVolume {
	/** the view's planes swept towards the sun (`sweepPlanes` in camera.ts) */
	planes: Plane[];
	/** the fitted shadow layers' volumes that bound off-screen sun casters */
	layers: ShadowLayerVolumes;
	/**
	 * world-space spheres (x, y, z, radius) whose instances cast into a local light's shadow map, wherever the
	 * view looks
	 */
	lights: Float64Array;
}

/** camera state for one traversal */
export interface SelectionView {
	camera: Camera;
	planes: Plane[];
	/** viewport pixel factor, see {@link Camera.pixelFactor} */
	pixelFactor: number;
	/** instance content in this volume is selected too, at off-screen priority; `null` for none */
	casters: CasterVolume | null;
	/** elapsed time since the previous traversal, s (`0` snaps transitions without fading) */
	dt: number;
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

/**
 * a node refined or conditional tile shown last frame stays active until the camera is this far past its load
 * radius, m: the game runs its static unload pass only after the streaming centre moved 20 m
 * (`unloadDirtyDistance` in `docs/game-data/world.md#streaming-layers`), and without it a camera hovering at
 * a ring swaps and refetches every frame
 */
const UNREFINE_SLACK = 20;
/**
 * maximum per-side unload hysteresis of a dynamic `fb_main` reach rectangle, m: the game unloads a cell once
 * the centre leaves a square of side `min(3 · cell + 20, 3.2 · cell)` around the cell centre, which is
 * `min(10, 0.1 · cell)` m past each edge of its `3 · cell` load rectangle
 * (`docs/game-data/world.md#dynamic-load-grids`)
 */
const REACH_UNLOAD_MARGIN = 10;

/**
 * @param span width or depth of a load reach rectangle, m
 * @returns per-side unload hysteresis along that axis, m
 */
export const reachUnloadMargin = (span: number): number => Math.min(REACH_UNLOAD_MARGIN, span / 30);

/** duration of a dithered HLOD/detail, conditional, or dynamic-reach cross-fade, s */
const FADE_DURATION = 0.35;
/** camera move larger than this in one frame snaps active fades instead of dissolving stale content, m */
const JUMP_DISTANCE = 64;

/**
 * encodes fade-in progress in `(0, 1)` as `1..127` (`0` when fully opaque)
 *
 * @param progress transition progress in `[0, 1]`
 * @returns 8-bit fade code
 */
export const encodeFadeIn = (progress: number): number =>
	progress >= 1 ? 0 : Math.max(1, Math.min(127, Math.round(progress * 128)));

/**
 * encodes fade-out opacity in `(0, 1)` as `129..255` (`0` when fully opaque); exact pixel-mask complement of
 * {@link encodeFadeIn} so cross-fading HLOD and detail leave no holes
 *
 * @param opacity remaining opacity in `[0, 1]`
 * @returns 8-bit fade code
 */
export const encodeFadeOut = (opacity: number): number => {
	if (opacity >= 1) {
		return 0;
	}
	const complement = 128 - Math.max(1, Math.min(127, Math.round((1 - opacity) * 128)));
	return 128 + complement;
};

/** an active cross-fade transition */
interface FadeState {
	/** `true` when fading in (or HLOD → detail), `false` when fading out (or detail → HLOD) */
	toShown: boolean;
	/** progress in `(0, 1)` */
	progress: number;
}

/** advances every active transition by `step`, dropping finished ones */
const advanceFades = (fades: Map<number, FadeState>, step: number): void => {
	for (const [key, state] of fades) {
		state.progress += step;
		if (state.progress >= 1) {
			fades.delete(key);
		}
	}
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

/**
 * updates an active fade entry (reversing if direction flipped, or starting a fade in/out when eligible) and
 * returns the encoded 8-bit fade code (`0` = opaque, `-1` = hidden and not fading)
 */
const stepFade = (
	fades: Map<number, FadeState>,
	key: number,
	shown: boolean,
	options: {
		wasShown: boolean;
		canStartIn: boolean;
		canStartOut: boolean;
		jumped: boolean;
		fadeStep: number;
	},
): number => {
	let state = fades.get(key);
	if (shown) {
		if (state !== undefined && !state.toShown) {
			state.toShown = true;
			state.progress = Math.max(options.fadeStep, 1 - state.progress);
		} else if (state === undefined && !options.jumped && !options.wasShown && options.canStartIn) {
			if (options.fadeStep < 1) {
				state = { toShown: true, progress: options.fadeStep };
				fades.set(key, state);
			}
		}
	} else if (state === undefined) {
		if (!options.jumped && options.wasShown && options.canStartOut && options.fadeStep < 1) {
			state = { toShown: false, progress: options.fadeStep };
			fades.set(key, state);
		} else {
			return -1;
		}
	}
	if (state === undefined) {
		return 0;
	}
	return state.toShown ? encodeFadeIn(state.progress) : encodeFadeOut(1 - state.progress);
};

/** the traversal for one package */
export class Selector {
	readonly selection: Selection = { patches: [], instances: [], visited: 0, fading: false };
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
	#frame = 0;
	/** by node index: the last frame its instances refined */
	#refinedFrame: Int32Array;
	/** by node index: the last frame `#refineInstances` saw it in view (prevents fading on camera turns) */
	#seenFrame: Int32Array;
	/** by node index: the last frame its conditional subtree was within the detail radius */
	#conditionalFrame: Int32Array;
	/** by `TileTree.reached` index: the last frame the camera was inside its reach */
	#reachedFrame: Int32Array;
	/** active HLOD ↔ detail cross-fades by node index */
	readonly #hlodFades = new Map<number, FadeState>();
	/** active conditional tile fades by node index */
	readonly #conditionalFades = new Map<number, FadeState>();
	/** active reached dynamic-block fades by `TileTree.reached` index */
	readonly #reachedFades = new Map<number, FadeState>();
	/** eye position of the previous traversal, for jump detection */
	readonly #lastEye = [Number.NaN, Number.NaN, Number.NaN];
	/** whether this frame jumped or has `dt <= 0`, snapping transitions instead of starting new fades */
	#jumped = true;
	/** fade progress increment for this frame */
	#fadeStep = 1;
	/** coarsest nodes that hold a terrain page, collected once from the tree */
	readonly #terrainRoots: TileNode[] = [];

	/**
	 * @param tree the linked tree
	 * @param stream residency
	 * @param global the tree's global refs, always drawn
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
		this.#refinedFrame = new Int32Array(tree.nodes.length).fill(-2);
		this.#seenFrame = new Int32Array(tree.nodes.length).fill(-2);
		this.#conditionalFrame = new Int32Array(tree.nodes.length).fill(-2);
		this.#reachedFrame = new Int32Array(tree.reached.length).fill(-2);
		const collect = (node: TileNode): void => {
			if (node.terrain !== null) {
				this.#terrainRoots.push(node);
				return;
			}
			for (const child of node.quadrants) {
				if (child !== null) {
					collect(child);
				}
			}
		};
		for (const root of tree.roots) {
			collect(root);
		}
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
		this.#frame++;

		const eye = view.camera.position;
		const dx = eye[0] - this.#lastEye[0];
		const dy = eye[1] - this.#lastEye[1];
		const dz = eye[2] - this.#lastEye[2];
		const jumped =
			this.#frame === 1 ||
			view.dt <= 0 ||
			Number.isNaN(dx) ||
			dx * dx + dy * dy + dz * dz > JUMP_DISTANCE * JUMP_DISTANCE;
		this.#lastEye[0] = eye[0];
		this.#lastEye[1] = eye[1];
		this.#lastEye[2] = eye[2];
		const fadeStep = view.dt > 0 ? Math.min(view.dt, 0.1) / FADE_DURATION : 1;
		this.#jumped = jumped;
		this.#fadeStep = fadeStep;
		if (jumped) {
			this.#hlodFades.clear();
			this.#conditionalFades.clear();
			this.#reachedFades.clear();
		} else {
			advanceFades(this.#hlodFades, fadeStep);
			advanceFades(this.#conditionalFades, fadeStep);
			advanceFades(this.#reachedFades, fadeStep);
		}

		if (options.instances && options.global) {
			// global blobs are pinned: drawn once they arrive, never wanted
			for (const ref of this.#global) {
				if (!this.#shows(ref)) {
					continue;
				}
				const item = this.#stream.markUsed(ref.blob) ? this.#stream.get(ref.blob) : undefined;
				if (item !== undefined) {
					this.#emitRange(item, ref, 0);
				}
			}
		}
		if (options.terrain) {
			for (let i = 0; i < this.#terrainRoots.length; i++) {
				this.#terrain(this.#terrainRoots[i], view, options, null);
			}
		}
		if (options.instances) {
			for (const root of this.#tree.roots) {
				this.#instances(root, view, options, 0);
				if (options.detail) {
					this.#conditional(root, view, options);
				}
			}
		}
		if (options.instances && options.detail) {
			this.#reached(view);
		}
		selection.fading =
			this.#hlodFades.size > 0 || this.#conditionalFades.size > 0 || this.#reachedFades.size > 0;
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
		const wasShown = this.#conditionalFrame[node.index] === this.#frame - 1;
		const slack = wasShown ? UNREFINE_SLACK : 0;
		const within = distance < options.detailDistance + slack;
		const fade = stepFade(this.#conditionalFades, node.index, within, {
			wasShown,
			canStartIn: node.conditional.length > 0 && distance > options.detailDistance - 32,
			canStartOut: node.conditional.length > 0,
			jumped: this.#jumped,
			fadeStep: this.#fadeStep,
		});
		// keep descending past the ring only while a descendant may still be fading out
		if (fade < 0) {
			if (
				this.#conditionalFades.size === 0 ||
				distance >= options.detailDistance + UNREFINE_SLACK + JUMP_DISTANCE
			) {
				return;
			}
			const inView = this.#inView(node, view);
			if (inView === null) {
				return;
			}
			for (const child of node.quadrants) {
				if (child !== null) {
					this.#conditional(child, view, options);
				}
			}
			return;
		}
		const inView = this.#inView(node, view);
		if (inView === null) {
			return;
		}
		if (within) {
			this.#conditionalFrame[node.index] = this.#frame;
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
				this.#emitRange(item, ref, fade);
			}
		}
		for (const child of node.quadrants) {
			if (child !== null) {
				this.#conditional(child, view, options);
			}
		}
	}

	/**
	 * conditional content with a reach draws while the camera, standing in for the game's streaming centre, is
	 * inside it, however far its tile (`docs/viewer/streaming.md#instance-selection`)
	 */
	#reached(view: SelectionView): void {
		const eye = view.camera.position;
		const ex = eye[0];
		const ez = eye[2];
		const groupsShown = this.#groupsShown;
		const reached = this.#tree.reached;
		let lastNode: TileNode | null = null;
		let lastDistance = 0;
		let lastInView: boolean | null = null;
		for (let i = 0; i < reached.length; i++) {
			const entry = reached[i];
			const r = entry.reach;
			const wasShown = this.#reachedFrame[i] === this.#frame - 1;
			const mx = wasShown ? reachUnloadMargin(r.maxX - r.minX) : 0;
			const mz = wasShown ? reachUnloadMargin(r.maxZ - r.minZ) : 0;
			const inside = ex >= r.minX - mx && ex <= r.maxX + mx && ez >= r.minZ - mz && ez <= r.maxZ + mz;
			if (inside) {
				this.#reachedFrame[i] = this.#frame;
			}
			const fade = stepFade(this.#reachedFades, i, inside, {
				wasShown,
				canStartIn: true,
				canStartOut: true,
				jumped: this.#jumped,
				fadeStep: this.#fadeStep,
			});
			if (fade < 0) {
				continue;
			}
			const refs = entry.refs;
			for (let j = 0; j < refs.length; j++) {
				const { node, ref } = refs[j];
				if (!(groupsShown[ref.group] ?? false)) {
					continue;
				}
				if (node !== lastNode) {
					lastNode = node;
					lastDistance = Math.max(distanceToBox(node.bounds.min, node.bounds.max, eye), 1);
					lastInView = this.#inView(node, view);
				}
				if (lastInView === null) {
					continue;
				}
				const item = this.#stream.want(
					ref.blob,
					this.#priority(node, view.pixelFactor / lastDistance, lastInView, lastDistance),
				);
				if (item !== null) {
					this.#emitRange(item, ref, fade);
				}
			}
		}
	}

	/** @returns `true` for a node in view, `false` for one only in the caster volume, `null` for neither */
	#inView(node: TileNode, view: SelectionView): boolean | null {
		const { min, max } = node.bounds;
		const eye = view.camera.position;
		if (boxInFrustum(view.planes, min, max, eye)) {
			return true;
		}
		const casters = view.casters;
		if (casters === null) {
			return null;
		}
		if (
			boxInFrustum(casters.planes, min, max, eye) &&
			boxTouchesShadowLayers(casters.layers, min, max, eye)
		) {
			return false;
		}
		return boxTouchesSpheres(casters.lights, min, max) ? false : null;
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
	#emitRange(item: ContentItem, ref: ContentRef, fade: number): void {
		const out = this.selection.instances;
		const pool = this.#rangePool;
		let range = pool[out.length];
		if (range === undefined) {
			range = { item, first: ref.first, count: ref.count, fade };
			pool.push(range);
		} else {
			range.item = item;
			range.first = ref.first;
			range.count = ref.count;
			range.fade = fade;
		}
		out.push(range);
	}

	/**
	 * wants the node's HLOD refs and, if all are resident (or it has none), appends them to the selection
	 *
	 * @returns whether they were appended
	 */
	#emitHlod(node: TileNode, options: SelectionOptions, priority: number, fade: number): boolean {
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
				this.#emitRange(item, ref, fade);
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
	#instances(node: TileNode, view: SelectionView, options: SelectionOptions, parentFade: number): boolean {
		this.selection.visited++;
		const inView = this.#inView(node, view);
		if (inView === null) {
			return true;
		}
		const distance = Math.max(distanceToBox(node.bounds.min, node.bounds.max, view.camera.position), 1);
		// content outside the view only casts shadows into it, so its streaming never holds back what's in view
		return this.#refineInstances(node, view, options, { distance, inView, parentFade }) || !inView;
	}

	/** emits a node's detail refs (leaf) or recurses into its children, with `fade` */
	#emitRefined(
		node: TileNode,
		view: SelectionView,
		options: SelectionOptions,
		{ leaf, priority, fade }: { leaf: boolean; priority: number; fade: number },
	): boolean {
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
					this.#emitRange(item, ref, fade);
				}
			}
		} else {
			for (const child of node.quadrants) {
				if (child !== null) {
					complete = this.#instances(child, view, options, fade) && complete;
				}
			}
		}
		return complete;
	}

	/** {@link #instances} for a node in view or in the caster volume */
	#refineInstances(
		node: TileNode,
		view: SelectionView,
		options: SelectionOptions,
		{ distance, inView, parentFade }: { distance: number; inView: boolean; parentFade: number },
	): boolean {
		const out = this.selection.instances;
		const sse = (node.geometricError * view.pixelFactor) / distance;
		const priority = this.#priority(node, sse, inView, distance);
		const tier = this.#hlodTier(node, options);
		const hasHlod = tier !== null;
		const leaf = isLeaf(node);
		const seen = this.#seenFrame[node.index] === this.#frame - 1;
		this.#seenFrame[node.index] = this.#frame;
		const wasRefined = this.#refinedFrame[node.index] === this.#frame - 1;
		// a leaf refines even without detail of its own (`docs/viewer/streaming.md#instance-selection`)
		const canRefine = !leaf || options.detail;
		const slack = wasRefined ? UNREFINE_SLACK : 0;
		const refine = canRefine && distance < hlodRing(tier, options.detailDistance, leaf) + slack;
		const canFade = !this.#jumped && seen && (hasHlod || leaf);

		let fadeState = this.#hlodFades.get(node.index);
		if (fadeState !== undefined && fadeState.toShown !== refine) {
			fadeState.toShown = refine;
			fadeState.progress = Math.max(this.#fadeStep, 1 - fadeState.progress);
		}
		if (fadeState !== undefined) {
			if (fadeState.toShown) {
				this.#refinedFrame[node.index] = this.#frame;
			}
			let refinedFade: number;
			let hlodFade: number;
			if (parentFade !== 0) {
				refinedFade = parentFade;
				hlodFade = parentFade;
			} else if (fadeState.toShown) {
				refinedFade = encodeFadeIn(fadeState.progress);
				hlodFade = encodeFadeOut(1 - fadeState.progress);
			} else {
				refinedFade = encodeFadeOut(1 - fadeState.progress);
				hlodFade = encodeFadeIn(fadeState.progress);
			}
			this.#emitRefined(node, view, options, { leaf, priority, fade: refinedFade });
			if (hasHlod) {
				this.#emitHlod(node, options, priority, hlodFade);
			}
			return true;
		}

		if (!refine) {
			if (canFade && wasRefined && this.#fadeStep < 1) {
				const hlodFade = parentFade !== 0 ? parentFade : encodeFadeIn(this.#fadeStep);
				if (!hasHlod || this.#emitHlod(node, options, priority, hlodFade)) {
					this.#hlodFades.set(node.index, { toShown: false, progress: this.#fadeStep });
					const refinedFade = parentFade !== 0 ? parentFade : encodeFadeOut(1 - this.#fadeStep);
					this.#emitRefined(node, view, options, { leaf, priority, fade: refinedFade });
					return true;
				}
			}
			return !hasHlod || this.#emitHlod(node, options, priority, parentFade);
		}

		const startFadeIn = canFade && !wasRefined && this.#fadeStep < 1;
		const refinedFade = startFadeIn && parentFade === 0 ? encodeFadeIn(this.#fadeStep) : parentFade;
		const mark = out.length;
		const complete = this.#emitRefined(node, view, options, { leaf, priority, fade: refinedFade });
		if (complete) {
			this.#refinedFrame[node.index] = this.#frame;
			if (startFadeIn) {
				this.#hlodFades.set(node.index, { toShown: true, progress: this.#fadeStep });
				if (hasHlod) {
					const hlodFade = parentFade !== 0 ? parentFade : encodeFadeOut(1 - this.#fadeStep);
					this.#emitHlod(node, options, priority, hlodFade);
				}
			}
			return true;
		}
		if (!hasHlod) {
			return false;
		}
		// the refinement isn't resident yet: keep showing this node's HLOD meanwhile, in its place
		const end = out.length;
		if (!this.#emitHlod(node, options, priority, parentFade)) {
			return false;
		}
		// the pooled objects stay at their positions, so the HLOD's values move down into them
		for (let from = end, to = mark; from < out.length; from++, to++) {
			out[to].item = out[from].item;
			out[to].first = out[from].first;
			out[to].count = out[from].count;
			out[to].fade = out[from].fade;
		}
		out.length = mark + (out.length - end);
		return true;
	}

	// #endregion

	// #region terrain

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
