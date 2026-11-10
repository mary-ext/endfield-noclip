/**
 * the rows a frame leaves for the GPU to cull, as the mesh selection writes them and instance-cull.wgsl reads
 * them. the selection tests each group of rows on the CPU, picks the LODs its rows can reach and requests
 * their geometry; when every one of them is resident, the group's rows go to the GPU as items, each item's
 * rows of one chain, and the GPU tests every row and writes the visible list and the draws' indirect
 * arguments.
 *
 * @module
 */

import { SHADOW_LAYERS, type ShadowLayerVolumes } from '../render/shadows/shadow-map.ts';

import type { MeshBucket } from './mesh-buckets.ts';

/**
 * u32 per item: the first row (global), the row count (bits 0–7) and {@link ItemFlags} (above), and where its
 * slots start (in slots, from the slot region) and how many it has
 */
export const ITEM_WORDS = 4;

/** an item's flags, above its row count */
export const ItemFlags = {
	/** its rows' group is wholly in view, so no row needs the frustum test */
	Inside: 1 << 8,
} as const;

/**
 * u32 per slot: its LOD band (`minSquared`, `maxSquared` as f32), {@link SlotFlags}, then its bucket's GPU
 * index for unmirrored and for mirrored rows ({@link NO_BUCKET} for neither)
 */
export const SLOT_WORDS = 5;

export const SlotFlags = {
	/** it casts into some shadow layer (`ChainSlot.castsShadows`) */
	Casts: 1,
	/** a shadow proxy: rows in view draw only into the shadow layers */
	ShadowOnly: 2,
	/** it casts into the sharp cascades */
	Realtime: 4,
	/** it casts into the far layer */
	Static: 8,
} as const;

/** a slot's bucket where its item has no rows of that handedness */
export const NO_BUCKET = 0xffff_ffff;

/**
 * u32 per bucket, written once the draws are prepared: where its rows in view start in the visible list and
 * how many fit, then the same for each shadow layer's casters, its draw index, then its submesh's index
 * count, first index and base vertex. a bucket that doesn't draw has room for none
 */
export const BUCKET_WORDS = 2 * (1 + SHADOW_LAYERS) + 4;

/** u32 of indirect arguments per bucket: the draw of its rows in view, then each shadow layer's draw */
export const INDIRECT_WORDS = 5 * (1 + SHADOW_LAYERS);

/** u32 of counters per bucket: its rows in view, then each shadow layer's casters */
export const COUNTER_WORDS = 1 + SHADOW_LAYERS;

/** counters before the buckets': the instances and triangles drawn in view */
export const STATS_WORDS = 2;

/** the local lights whose casters outside the view a frame selects at once (`CasterVolume.lights`) */
export const MAX_LIGHT_CASTERS = 8;

/** where the light caster spheres start in `View`, floats */
const LIGHT_CASTERS_AT = 68;

/**
 * floats of `View` in instance-cull.wgsl: the view's planes, the caster volume's planes, the shadow axes and
 * layers and the light caster spheres (vec4 each), then {@link ViewWord}
 */
export const VIEW_FLOATS = 116;

/** words of `View` past its vec4 arrays */
export const ViewWord = {
	planeCount: 100,
	casterPlaneCount: 101,
	itemCount: 102,
	bucketCount: 103,
	pixelFactor: 104,
	viewportHeight: 105,
	minPixels: 106,
	casterMinPixels: 107,
	casterDistance: 108,
	shadowReach: 109,
	/** 1 when shadow layers group the casters */
	shadows: 110,
	/** where the slot region starts in the work buffer, u32 */
	slotsAt: 111,
	/** where the bucket region starts, u32 */
	bucketsAt: 112,
	/** how many light caster spheres are set */
	lightCasterCount: 113,
} as const;

/** what a GPU-culled bucket gathers over a frame */
export interface GpuRows {
	/** its index among the frame's GPU-culled buckets, which slots name it by */
	index: number;
	/** room for its rows in view: every row of every item that may draw into it */
	rows: number;
	/** per shadow layer, room for its casters */
	layerRows: number[];
}

/** a frame's GPU culling work, reused across frames */
export interface GpuCullWork {
	items: Uint32Array<ArrayBuffer>;
	itemCount: number;
	slots: Uint32Array<ArrayBuffer>;
	/** the slots as floats, for their bands */
	slotFloats: Float32Array<ArrayBuffer>;
	slotCount: number;
	/** the buckets by {@link GpuRows.index} */
	buckets: MeshBucket[];
	/** the view, {@link VIEW_FLOATS} floats; the counts and offsets are left for the culler */
	view: Float32Array<ArrayBuffer>;
	viewWords: Uint32Array<ArrayBuffer>;
}

/** @returns empty work */
export const gpuCullWork = (): GpuCullWork => {
	const slots = new Uint32Array(1024 * SLOT_WORDS);
	const view = new Float32Array(VIEW_FLOATS);
	return {
		items: new Uint32Array(1024 * ITEM_WORDS),
		itemCount: 0,
		slots,
		slotFloats: new Float32Array(slots.buffer),
		slotCount: 0,
		buckets: [],
		view,
		viewWords: new Uint32Array(view.buffer),
	};
};

/** @returns `array` with room for `words`, grown by doubling and copied if it lacks it */
const withRoom = (array: Uint32Array<ArrayBuffer>, words: number): Uint32Array<ArrayBuffer> => {
	if (words <= array.length) {
		return array;
	}
	const grown = new Uint32Array(Math.max(words, array.length * 2));
	grown.set(array);
	return grown;
};

/**
 * appends an item; its slots follow with {@link addSlot}
 *
 * @param work the frame's work, grown in place
 * @param row the first row, global
 * @param count rows, at most 255
 * @param flags {@link ItemFlags}
 */
export const addItem = (work: GpuCullWork, row: number, count: number, flags: number): void => {
	work.items = withRoom(work.items, (work.itemCount + 1) * ITEM_WORDS);
	const at = work.itemCount * ITEM_WORDS;
	work.items[at] = row;
	work.items[at + 1] = count | flags;
	work.items[at + 2] = work.slotCount;
	work.items[at + 3] = 0;
	work.itemCount++;
};

/**
 * appends a slot to the last item
 *
 * @param work the frame's work, grown in place
 * @param band the slot's LOD band, squared
 * @param flags {@link SlotFlags}
 * @param buckets its bucket's GPU index for unmirrored and mirrored rows
 */
export const addSlot = (
	work: GpuCullWork,
	band: { minSquared: number; maxSquared: number },
	flags: number,
	buckets: readonly [number, number],
): void => {
	if (work.slots.length < (work.slotCount + 1) * SLOT_WORDS) {
		work.slots = withRoom(work.slots, (work.slotCount + 1) * SLOT_WORDS);
		work.slotFloats = new Float32Array(work.slots.buffer);
	}
	const at = work.slotCount * SLOT_WORDS;
	// the bands are f32 on the GPU; an infinite band edge stays infinite
	work.slotFloats[at] = band.minSquared;
	work.slotFloats[at + 1] = band.maxSquared;
	work.slots[at + 2] = flags;
	work.slots[at + 3] = buckets[0];
	work.slots[at + 4] = buckets[1];
	work.slotCount++;
	work.items[(work.itemCount - 1) * ITEM_WORDS + 3]++;
};

/**
 * writes the view's planes, caster volume and shadow layers into the work's view
 *
 * @param work the frame's work
 * @param view camera-relative planes (4 floats each), the caster volume's (none without casters), and the
 *   sizes and thresholds rows are tested with
 */
export const writeCullView = (
	work: GpuCullWork,
	view: {
		planes: Float64Array;
		planeFloats: number;
		casterPlanes: Float64Array;
		casterFloats: number;
		casterDistance: number;
		/** camera-relative spheres (x, y, z, radius), at most {@link MAX_LIGHT_CASTERS} */
		lightCasters: Float64Array;
		casterMinPixels: number;
		pixelFactor: number;
		viewportHeight: number;
		minPixels: number;
		shadowLayers: ShadowLayerVolumes | null;
	},
): void => {
	const out = work.view;
	const words = work.viewWords;
	out.fill(0);
	for (let p = 0; p < view.planeFloats; p++) {
		out[p] = view.planes[p];
	}
	for (let p = 0; p < view.casterFloats; p++) {
		out[20 + p] = view.casterPlanes[p];
	}
	const layers = view.shadowLayers;
	if (layers !== null) {
		for (let axis = 0; axis < 3; axis++) {
			for (let i = 0; i < 3; i++) {
				out[40 + axis * 4 + i] = layers.axes[axis * 3 + i];
			}
		}
		for (let i = 0; i < SHADOW_LAYERS * 4; i++) {
			out[52 + i] = layers.layers[i];
		}
		out[ViewWord.shadowReach] = layers.reach;
	}
	for (let s = 0; s < view.lightCasters.length; s++) {
		out[LIGHT_CASTERS_AT + s] = view.lightCasters[s];
	}
	words[ViewWord.lightCasterCount] = view.lightCasters.length / 4;
	words[ViewWord.planeCount] = view.planeFloats / 4;
	words[ViewWord.casterPlaneCount] = view.casterFloats / 4;
	out[ViewWord.pixelFactor] = view.pixelFactor;
	out[ViewWord.viewportHeight] = view.viewportHeight;
	out[ViewWord.minPixels] = view.minPixels;
	out[ViewWord.casterMinPixels] = view.casterMinPixels;
	out[ViewWord.casterDistance] = view.casterDistance;
	words[ViewWord.shadows] = layers === null ? 0 : 1;
};
