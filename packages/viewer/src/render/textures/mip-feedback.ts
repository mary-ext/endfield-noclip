import type { PipelineCache } from '../../gfx/pipeline-cache.ts';

import feedbackWgsl from './mip-feedback.wgsl?raw';

const KEY = 'mip feedback';
/** the main pass target the meshes report into (`Shaded.mip_feedback` in frame.wgsl) */
export const MIP_FEEDBACK_FORMAT: GPUTextureFormat = 'r32uint';
/** look slots a report can name (its 17 bits) */
export const MIP_FEEDBACK_LOOKS = 1 << 17;
/** one pixel of each block this many pixels a side is read a frame (`STRIDE` in mip-feedback.wgsl) */
const STRIDE = 4;
/** look slots to start with room for */
const INITIAL_LOOKS = 4096;
/** bytes per look slot: a word per UV set */
const LOOK_BYTES = 8;
/** readbacks under way at most; a frame that finds none free reports nothing */
const READBACKS = 3;
/**
 * how long a window of reports is, ms, and the readbacks it holds at least, enough for every pixel to have
 * been read. a material counts as sampled while this window or the one before reported it, so one that goes
 * out of sight stops asking for its textures within two windows
 */
const WINDOW_MS = 400;
const WINDOW_READBACKS = STRIDE * STRIDE;

/** how finely the frames just drawn sampled each material's textures */
export interface MipSteps {
	/**
	 * @param look what the implementation keeps its materials by: {@link MipFeedback} a slot of the look table,
	 *   `MeshRenderer.mips` a material id
	 * @param set UV set 0 or 1
	 * @returns how many quarter mip levels below one UV unit per pixel the finest sample of the set was, over
	 *   the last frames (a texture `t` texels across a UV unit is sampled down to level `log2(t) − steps / 4`),
	 *   or -1 when no pixel of the material was read
	 */
	steps(look: number, set: number): number;
}

/**
 * reads back which mip levels the main pass sampled: the meshes write their material and their UV sets'
 * footprints per pixel, a compute pass keeps the finest per material, and the result comes back a few frames
 * later. textures then stream what's seen, where the on-screen size of an instance's bounds says little about
 * a mesh the camera stands inside or one mostly hidden
 */
export class MipFeedback implements MipSteps {
	#device: GPUDevice;
	#pipelines: PipelineCache;
	/** look slots the buffers have room for */
	#capacity = 0;
	#seen: GPUBuffer | null = null;
	#params: GPUBuffer;
	#paramData = new Uint32Array(4);
	#group: GPUBindGroup | null = null;
	/** the feedback view {@link #group} reads */
	#source: GPUTextureView | null = null;
	#idle: GPUBuffer[] = [];
	/** this frame's readback, mapped once the frame is submitted */
	#pending: { buffer: GPUBuffer; looks: number } | null = null;
	/** per look slot and set: the largest report of the current window, and of the one before, plus 1 */
	#recent = new Uint8Array(0);
	#older = new Uint8Array(0);
	#windowStart = 0;
	#windowReadbacks = 0;
	/** bumped by {@link reset}: readbacks begun before it are dropped */
	#generation = 0;
	#destroyed = false;

	/**
	 * @param device the device
	 * @param pipelines compiles the pass
	 */
	constructor(device: GPUDevice, pipelines: PipelineCache) {
		this.#device = device;
		this.#pipelines = pipelines;
		const module = pipelines.module(KEY, feedbackWgsl);
		void pipelines.prepareCompute(KEY, () => ({
			layout: 'auto',
			compute: { module, entryPoint: 'cs_reduce' },
		}));
		this.#params = device.createBuffer({
			label: 'mip feedback params',
			size: this.#paramData.byteLength,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
	}

	/** @returns bytes of the GPU allocations */
	get bytes(): number {
		return this.#capacity * LOOK_BYTES * (1 + READBACKS) + this.#params.size;
	}

	/** forgets every report, when the look table's slots name other materials */
	reset(): void {
		this.#generation++;
		this.#recent.fill(0);
		this.#older.fill(0);
		this.#windowReadbacks = 0;
	}

	/** frees the buffers; the feedback can't be used after */
	destroy(): void {
		this.#destroyed = true;
		this.#generation++;
		this.#seen?.destroy();
		this.#params.destroy();
		for (const buffer of this.#idle) {
			buffer.destroy();
		}
		this.#idle = [];
	}

	steps(look: number, set: number): number {
		const at = look * 2 + set;
		// past the reports' end both read as undefined
		return Math.max(this.#recent[at] ?? 0, this.#older[at] ?? 0) - 1;
	}

	/**
	 * reduces the frame's feedback target; encode after the main pass, then call {@link afterSubmit} once the
	 * frame is submitted. nothing while the pass compiles or every readback is under way
	 *
	 * @param encoder the frame's encoder
	 * @param feedback the main pass's feedback target and its size
	 * @param looks look slots in use, at most {@link MIP_FEEDBACK_LOOKS}
	 * @param frame the frame counter, which picks the pixels read
	 */
	encode(
		encoder: GPUCommandEncoder,
		feedback: { view: GPUTextureView; width: number; height: number },
		looks: number,
		frame: number,
	): void {
		const pipeline = this.#pipelines.getCompute(KEY);
		if (pipeline === undefined || looks === 0) {
			return;
		}
		if (looks > this.#capacity) {
			this.#grow(looks);
		}
		const seen = this.#seen;
		const readback = this.#idle.pop();
		if (seen === null || readback === undefined) {
			return;
		}
		if (this.#group === null || this.#source !== feedback.view) {
			this.#source = feedback.view;
			this.#group = this.#device.createBindGroup({
				label: KEY,
				layout: pipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: feedback.view },
					{ binding: 1, resource: { buffer: seen } },
					{ binding: 2, resource: { buffer: this.#params } },
				],
			});
		}
		const params = this.#paramData;
		params[0] = frame % STRIDE;
		params[1] = Math.floor(frame / STRIDE) % STRIDE;
		params[2] = looks;
		this.#device.queue.writeBuffer(this.#params, 0, params);
		const bytes = looks * LOOK_BYTES;
		encoder.clearBuffer(seen, 0, bytes);
		const pass = encoder.beginComputePass({ label: KEY });
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, this.#group);
		pass.dispatchWorkgroups(
			Math.ceil(feedback.width / (STRIDE * 8)),
			Math.ceil(feedback.height / (STRIDE * 8)),
		);
		pass.end();
		encoder.copyBufferToBuffer(seen, 0, readback, 0, bytes);
		this.#pending = { buffer: readback, looks };
	}

	/** starts reading back what {@link encode} reduced; call after submitting the frame */
	afterSubmit(): void {
		const pending = this.#pending;
		if (pending === null) {
			return;
		}
		this.#pending = null;
		const { buffer, looks } = pending;
		const generation = this.#generation;
		const capacity = this.#capacity;
		buffer
			.mapAsync(GPUMapMode.READ, 0, looks * LOOK_BYTES)
			.then(() => {
				if (generation === this.#generation) {
					this.#merge(new Uint32Array(buffer.getMappedRange(0, looks * LOOK_BYTES)));
				}
				buffer.unmap();
			})
			.catch(() => {})
			.finally(() => {
				// a buffer from before the last growth is too small
				if (capacity === this.#capacity && !this.#destroyed) {
					this.#idle.push(buffer);
				} else {
					buffer.destroy();
				}
			});
	}

	/** folds a readback into the current window, and starts the next once this one is full */
	#merge(reports: Uint32Array): void {
		const now = performance.now();
		if (this.#windowReadbacks === 0) {
			this.#windowStart = now;
		}
		const recent = this.#recent;
		for (let i = 0; i < reports.length; i++) {
			if (reports[i] > recent[i]) {
				recent[i] = reports[i];
			}
		}
		this.#windowReadbacks++;
		if (this.#windowReadbacks >= WINDOW_READBACKS && now - this.#windowStart >= WINDOW_MS) {
			this.#recent = this.#older;
			this.#older = recent;
			this.#recent.fill(0);
			this.#windowReadbacks = 0;
		}
	}

	/** makes room for `looks` look slots, keeping the reports so far */
	#grow(looks: number): void {
		let capacity = Math.max(this.#capacity, INITIAL_LOOKS);
		while (capacity < looks) {
			capacity *= 2;
		}
		capacity = Math.min(capacity, MIP_FEEDBACK_LOOKS);
		this.#seen?.destroy();
		for (const buffer of this.#idle) {
			buffer.destroy();
		}
		this.#capacity = capacity;
		this.#seen = this.#device.createBuffer({
			label: 'mip feedback',
			size: capacity * LOOK_BYTES,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
		});
		this.#idle = Array.from({ length: READBACKS }, () =>
			this.#device.createBuffer({
				label: 'mip feedback readback',
				size: capacity * LOOK_BYTES,
				usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
			}),
		);
		this.#group = null;
		const grown = (reports: Uint8Array): Uint8Array<ArrayBuffer> => {
			const out = new Uint8Array(capacity * 2);
			out.set(reports);
			return out;
		};
		this.#recent = grown(this.#recent);
		this.#older = grown(this.#older);
	}
}
