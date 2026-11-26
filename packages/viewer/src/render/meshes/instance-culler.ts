import type { TgpuBindGroup, TgpuComputePipeline, TgpuRoot } from 'typegpu';

import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';
import { SHADOW_LAYERS } from '../../scene/shadow-volumes.ts';

import {
	BUCKET_WORDS,
	COUNTER_WORDS,
	type GpuCullWork,
	type GpuRows,
	INDIRECT_WORDS,
	ITEM_WORDS,
	SLOT_WORDS,
	STATS_WORDS,
	VIEW_FLOATS,
	ViewWord,
} from './gpu-cull-work.ts';
import {
	BUCKET_DRAW,
	MAX_GROUPS_X,
	csCullArguments,
	csCullWrite,
	instanceCullLayout,
} from './instance-cull-shader.ts';

/** floats of `CullViewSchema` past the selection's part: last frame's camera and the pyramid */
const OCCLUSION_FLOATS = 24;
const KEYS = { write: 'instance cull/write', arguments: 'instance cull/arguments' };

/** the buffers the culler reads and writes besides its own */
export interface CullTargets {
	/** the instance rows; replaced when they grow, which {@link rowsVersion} counts */
	rows: GPUBuffer;
	rowsVersion: number;
	/** the block origins, rebased to the eye */
	blocks: GPUBuffer;
	/** the visible list */
	list: GPUBuffer;
	/** each visible list entry's draw */
	drawIds: GPUBuffer;
}

/** what rows in view are tested against: last frame's depth pyramid and the camera it was drawn with */
export interface Occlusion {
	/** the pyramid, its first level's size and its levels */
	pyramid: { view: GPUTextureView; width: number; height: number; levels: number };
	/** last frame's camera-relative view-projection, column-major */
	previous: Float32Array;
	/** this frame's eye minus last frame's */
	eyeDelta: readonly [number, number, number];
	/** the camera's near plane, m */
	near: number;
}

/** submesh index range needed by {@link InstanceCuller.setBucket} */
export interface CulledSubmesh {
	readonly indexCount: number;
	readonly firstIndex: number;
	readonly baseVertex: number;
}

/**
 * culls the rows the mesh selection leaves to the GPU (gpu-cull-work.ts) and writes their visible list
 * entries and the buckets' indirect draw arguments, {@link INDIRECT_WORDS} per bucket by its GPU index
 */
export class InstanceCuller {
	/** in-view instances and triangles the GPU drew, as last read back */
	instances = 0;
	triangles = 0;

	#root: TgpuRoot;
	#writePipeline: AsyncPipeline<TgpuComputePipeline>;
	#argsPipeline: AsyncPipeline<TgpuComputePipeline>;
	#view: GPUBuffer;
	#viewData = new Float32Array(VIEW_FLOATS + OCCLUSION_FLOATS);
	#viewWords = new Uint32Array(this.#viewData.buffer);
	#work: GPUBuffer;
	#counters: GPUBuffer;
	#indirect: GPUBuffer;
	#statsRead: GPUBuffer;
	/** the stats were copied for reading in an encoded frame, not yet mapped */
	#statsCopied = false;
	#statsMapping = false;
	#buckets = new Uint32Array(1024 * BUCKET_WORDS);
	#bucketCount = 0;
	#itemCount = 0;
	/** whether work was committed since the last encode */
	#pending = false;
	#group: TgpuBindGroup | null = null;
	/** bound in place of a pyramid while rows aren't tested against one */
	#noPyramid: GPUTexture;
	#noPyramidView: GPUTextureView;
	/** what {@link #group} binds */
	#bound: {
		rowsVersion: number;
		rows: GPUBuffer | null;
		work: GPUBuffer | null;
		counters: GPUBuffer | null;
		pyramid: GPUTextureView | null;
	} = { rowsVersion: -1, rows: null, work: null, counters: null, pyramid: null };
	#targets: () => CullTargets;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines compiles the culling passes
	 * @param targets the buffers it reads and writes, asked for on every encode
	 */
	constructor(root: TgpuRoot, pipelines: PipelineCache, targets: () => CullTargets) {
		const device = root.device;
		this.#root = root;
		this.#targets = targets;
		this.#noPyramid = device.createTexture({
			label: 'no depth pyramid',
			size: [1, 1],
			format: 'r32float',
			usage: GPUTextureUsage.TEXTURE_BINDING,
		});
		this.#noPyramidView = this.#noPyramid.createView();
		this.#view = device.createBuffer({
			label: 'instance cull view',
			size: this.#viewData.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.#work = this.#workBuffer(64 * 1024);
		this.#counters = this.#counterBuffer(1024);
		this.#indirect = this.#indirectBuffer(1024);
		this.#statsRead = device.createBuffer({
			label: 'instance cull stats',
			size: STATS_WORDS * 4,
			usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
		});
		this.#writePipeline = pipelines.prepareTgpuCompute(KEYS.write, () =>
			root.createComputePipeline({ compute: csCullWrite }),
		);
		this.#argsPipeline = pipelines.prepareTgpuCompute(KEYS.arguments, () =>
			root.createComputePipeline({ compute: csCullArguments }),
		);
	}

	/** @returns whether the passes compiled; until they have, the GPU culls nothing */
	get ready(): boolean {
		return this.#writePipeline.get() !== undefined && this.#argsPipeline.get() !== undefined;
	}

	/** @returns the buckets' indirect draw arguments, {@link INDIRECT_WORDS} each by GPU index */
	get indirect(): GPUBuffer {
		return this.#indirect;
	}

	/** @returns bytes of the GPU allocations */
	get bytes(): number {
		return (
			this.#view.size + this.#work.size + this.#counters.size + this.#indirect.size + this.#statsRead.size
		);
	}

	/** destroys the GPU allocations; the culler can't be used after */
	destroy(): void {
		for (const buffer of [this.#view, this.#work, this.#counters, this.#indirect, this.#statsRead]) {
			buffer.destroy();
		}
		this.#noPyramid.destroy();
	}

	/**
	 * starts a frame's buckets: each draws nothing until {@link setBucket} gives it room
	 *
	 * @param count the frame's GPU-culled buckets
	 */
	begin(count: number): void {
		if (this.#buckets.length < count * BUCKET_WORDS) {
			this.#buckets = new Uint32Array(
				Math.max(count, (this.#buckets.length / BUCKET_WORDS) * 2) * BUCKET_WORDS,
			);
		}
		this.#buckets.fill(0, 0, count * BUCKET_WORDS);
		this.#bucketCount = count;
	}

	/**
	 * places a GPU-culled bucket's in-view and per-shadow-layer row spans and writes its draw arguments,
	 * copying the allocated per-layer rooms into `outLayerRooms`
	 *
	 * @param index the bucket's GPU index
	 * @param first start of the bucket's span in the visible list
	 * @param spanCount total rows reserved in the visible list
	 * @param gpu the bucket's requested in-view and per-layer row counts
	 * @param draw its draw's index into the draw parameters
	 * @param submesh the submesh's index count, first index, and base vertex
	 * @param outLayerRooms destination array receiving each layer's allocated room
	 * @returns allocated room for rows in view
	 */
	setBucket(
		index: number,
		first: number,
		spanCount: number,
		gpu: GpuRows,
		draw: number,
		submesh: CulledSubmesh,
		outLayerRooms: number[],
	): number {
		const data = this.#buckets;
		const at = index * BUCKET_WORDS;
		const end = first + spanCount;
		const room = gpu.rows < spanCount ? gpu.rows : spanCount;
		data[at] = first;
		data[at + 1] = room;
		let next = first + room;
		const layerRows = gpu.layerRows;
		for (let layer = 0; layer < SHADOW_LAYERS; layer++) {
			const avail = end - next;
			const req = layerRows[layer];
			const layerRoom = req < avail ? req : avail;
			data[at + 2 + layer * 2] = next;
			data[at + 3 + layer * 2] = layerRoom;
			outLayerRooms[layer] = layerRoom;
			next += layerRoom;
		}
		data[at + BUCKET_DRAW] = draw;
		data[at + BUCKET_DRAW + 1] = submesh.indexCount;
		data[at + BUCKET_DRAW + 2] = submesh.firstIndex;
		data[at + BUCKET_DRAW + 3] = submesh.baseVertex;
		return room;
	}

	/**
	 * uploads the frame's work and buckets, culled at the next {@link encode}
	 *
	 * @param work the selection's work; its buckets were {@link begin}-counted and {@link setBucket}-placed
	 */
	commit(work: GpuCullWork): void {
		this.#itemCount = work.itemCount;
		if (work.itemCount === 0 || this.#bucketCount === 0) {
			this.#pending = false;
			return;
		}
		const itemWords = work.itemCount * ITEM_WORDS;
		const slotWords = work.slotCount * SLOT_WORDS;
		const bucketWords = this.#bucketCount * BUCKET_WORDS;
		const words = itemWords + slotWords + bucketWords;
		if (this.#work.size < words * 4) {
			this.#work.destroy();
			this.#work = this.#workBuffer(Math.max(words, (this.#work.size / 4) * 2));
		}
		const room = this.#indirect.size / 4 / INDIRECT_WORDS;
		if (room < this.#bucketCount) {
			const buckets = Math.max(this.#bucketCount, room * 2);
			this.#counters.destroy();
			this.#counters = this.#counterBuffer(buckets);
			this.#indirect.destroy();
			this.#indirect = this.#indirectBuffer(buckets);
		}
		const queue = this.#root.device.queue;
		queue.writeBuffer(this.#work, 0, work.items, 0, itemWords);
		queue.writeBuffer(this.#work, itemWords * 4, work.slots, 0, slotWords);
		queue.writeBuffer(this.#work, (itemWords + slotWords) * 4, this.#buckets, 0, bucketWords);
		this.#viewData.set(work.view);
		const viewWords = this.#viewWords;
		viewWords[ViewWord.itemCount] = work.itemCount;
		viewWords[ViewWord.bucketCount] = this.#bucketCount;
		viewWords[ViewWord.slotsAt] = itemWords;
		viewWords[ViewWord.bucketsAt] = itemWords + slotWords;
		queue.writeBuffer(this.#view, 0, this.#viewData);
		this.#pending = true;
	}

	/** @returns whether work was committed since the last {@link encode} */
	get pending(): boolean {
		return this.#pending;
	}

	/**
	 * culls the committed work, if any; encode before anything draws meshes
	 *
	 * @param encoder the frame's encoder
	 * @param occlusion what rows in view are tested against, or `null` to draw every row in view
	 */
	encode(encoder: GPUCommandEncoder, occlusion: Occlusion | null): void {
		this.#readStats();
		const write = this.#writePipeline.get();
		const args = this.#argsPipeline.get();
		if (!this.#pending || write === undefined || args === undefined) {
			return;
		}
		this.#pending = false;
		{
			const data = this.#viewData;
			const words = this.#viewWords;
			const at = VIEW_FLOATS;
			data.fill(0, at);
			if (occlusion !== null) {
				data.set(occlusion.previous, at);
				data.set(occlusion.eyeDelta, at + 16);
				words[at + 19] = 1;
				data[at + 20] = occlusion.pyramid.width;
				data[at + 21] = occlusion.pyramid.height;
				words[at + 22] = occlusion.pyramid.levels;
				data[at + 23] = occlusion.near;
			}
			this.#root.device.queue.writeBuffer(this.#view, at * 4, data, at, OCCLUSION_FLOATS);
		}
		encoder.clearBuffer(this.#counters, 0, (STATS_WORDS + this.#bucketCount * COUNTER_WORDS) * 4);
		const group = this.#bindGroup(occlusion?.pyramid.view ?? this.#noPyramidView);
		const pass = encoder.beginComputePass({ label: 'instance cull' });
		const x = Math.min(this.#itemCount, MAX_GROUPS_X);
		const y = Math.ceil(this.#itemCount / MAX_GROUPS_X);
		write.with(group).with(pass).dispatchWorkgroups(x, y);
		args
			.with(group)
			.with(pass)
			.dispatchWorkgroups(Math.ceil(this.#bucketCount / 64));
		pass.end();
		if (!this.#statsCopied && !this.#statsMapping) {
			encoder.copyBufferToBuffer(this.#counters, 0, this.#statsRead, 0, STATS_WORDS * 4);
			this.#statsCopied = true;
		}
	}

	/** maps the stats copied in an earlier frame, which has been submitted since */
	#readStats(): void {
		if (!this.#statsCopied || this.#statsMapping) {
			return;
		}
		this.#statsCopied = false;
		this.#statsMapping = true;
		const buffer = this.#statsRead;
		buffer
			.mapAsync(GPUMapMode.READ)
			.then(() => {
				const stats = new Uint32Array(buffer.getMappedRange());
				this.instances = stats[0];
				this.triangles = stats[1];
				buffer.unmap();
			})
			.catch(() => {})
			.finally(() => {
				this.#statsMapping = false;
			});
	}

	#bindGroup(pyramid: GPUTextureView): TgpuBindGroup {
		const targets = this.#targets();
		const bound = this.#bound;
		if (
			this.#group === null ||
			bound.pyramid !== pyramid ||
			bound.rowsVersion !== targets.rowsVersion ||
			bound.rows !== targets.rows ||
			bound.work !== this.#work ||
			bound.counters !== this.#counters
		) {
			bound.rowsVersion = targets.rowsVersion;
			bound.rows = targets.rows;
			bound.work = this.#work;
			bound.counters = this.#counters;
			bound.pyramid = pyramid;
			this.#group = this.#root.createBindGroup(instanceCullLayout, {
				view: this.#view,
				rows: targets.rows,
				blocks: targets.blocks,
				work: this.#work,
				counters: this.#counters,
				list: targets.list,
				drawIds: targets.drawIds,
				indirect: this.#indirect,
				pyramid,
			});
		}
		return this.#group;
	}

	#workBuffer(words: number): GPUBuffer {
		return this.#root.device.createBuffer({
			label: 'instance cull work',
			size: words * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
	}

	#counterBuffer(buckets: number): GPUBuffer {
		return this.#root.device.createBuffer({
			label: 'instance cull counters',
			size: (STATS_WORDS + buckets * COUNTER_WORDS) * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
		});
	}

	#indirectBuffer(buckets: number): GPUBuffer {
		return this.#root.device.createBuffer({
			label: 'mesh indirect draws',
			size: buckets * INDIRECT_WORDS * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
		});
	}
}
