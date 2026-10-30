/**
 * temporal antialiasing with upsampling (TAAU), which the game uses instead of MSAA. the main pass renders
 * one sample per pixel at the render size, offset by a different subpixel jitter each frame; the resolve pass
 * (`taa.wgsl`) accumulates those frames into a history at the output size, which the rest of the post chain
 * reads. because the history needs a few frames to settle, the viewer keeps rendering for
 * {@link SETTLE_FRAMES} after the view stops changing.
 *
 * @module
 */

import { HDR_FORMAT } from '../gfx/render-targets.ts';
import type { Camera, Vec3 } from '../scene/camera.ts';

/** frames rendered after the last change, so the history converges on the still view */
export const SETTLE_FRAMES = 32;
/** the new frame's weight in the blend */
const BLEND = 0.1;
/** jitter positions per cycle without upsampling; the cycle lengthens with the upsampling ratio squared */
const BASE_PHASES = 8;
const MAX_PHASES = 64;
/** byte size of `Taa` in taa.wgsl */
const UNIFORM_BYTES = 112;

/** @returns element `index` (from 1) of the Halton sequence in `base`, in [0, 1) */
const halton = (index: number, base: number): number => {
	let result = 0;
	let fraction = 1 / base;
	for (let i = index; i > 0; i = Math.floor(i / base)) {
		result += (i % base) * fraction;
		fraction /= base;
	}
	return result;
};

interface Sized {
	width: number;
	height: number;
	outputWidth: number;
	outputHeight: number;
	/** the history pair at the output size; each frame writes one and reads the other */
	history: [GPUTexture, GPUTexture];
	/** groups 1 of the frame that writes `history[i]` */
	groups: [GPUBindGroup, GPUBindGroup];
}

/** owns the jitter sequence, the history and the resolve pass */
export class TemporalAA {
	/** jitter and accumulate; off passes the current frame through (upscaled to the output size) */
	enabled = true;
	readonly pipeline: GPURenderPipeline;
	#device: GPUDevice;
	#uniforms: GPUBuffer;
	#data = new Float32Array(UNIFORM_BYTES / 4);
	#sampler: GPUSampler;
	#sized: Sized | null = null;
	/** which history this frame writes */
	#index = 0;
	/** whether the history holds a frame of the current view and sizes */
	#valid = false;
	#phase = 0;
	#jitter: [x: number, y: number] = [0, 0];
	#viewProj = new Float32Array(16);
	#previousViewProj = new Float32Array(16);
	#previousEye: Vec3 = [0, 0, 0];

	/**
	 * @param device the device
	 * @param module the resolve shader built with the post chain's shared sources around `taa.wgsl`
	 */
	constructor(device: GPUDevice, module: GPUShaderModule) {
		this.#device = device;
		this.pipeline = device.createRenderPipeline({
			label: 'taa',
			layout: 'auto',
			vertex: { module, entryPoint: 'vs_fullscreen' },
			fragment: { module, entryPoint: 'fs_taa', targets: [{ format: HDR_FORMAT }] },
			primitive: { topology: 'triangle-list' },
		});
		this.#uniforms = device.createBuffer({
			label: 'taa uniforms',
			size: UNIFORM_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.#sampler = device.createSampler({
			label: 'taa bilinear',
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge',
		});
	}

	/**
	 * advances the jitter sequence. call once per rendered frame, before writing the main pass's uniforms.
	 *
	 * @param width the main pass's width, px
	 * @param height the main pass's height, px
	 * @param outputHeight the output height, px
	 * @returns this frame's jitter in NDC, to add to the projection (zero while off)
	 */
	nextJitter(width: number, height: number, outputHeight: number): readonly [x: number, y: number] {
		if (!this.enabled) {
			this.#jitter = [0, 0];
			return this.#jitter;
		}
		const ratio = outputHeight / height;
		const phases = Math.min(MAX_PHASES, Math.ceil(BASE_PHASES * ratio * ratio));
		this.#phase = (this.#phase % phases) + 1;
		this.#jitter = [
			((halton(this.#phase, 2) - 0.5) * 2) / width,
			((halton(this.#phase, 3) - 0.5) * 2) / height,
		];
		return this.#jitter;
	}

	/** @returns this frame's jitter in NDC, as {@link nextJitter} returned it */
	get jitter(): readonly [x: number, y: number] {
		return this.#jitter;
	}

	/** drops the history, so the next frame starts afresh (a new package or level, a debug view) */
	reset(): void {
		this.#valid = false;
	}

	/** @returns bytes of the history pair */
	get bytes(): number {
		const sized = this.#sized;
		return sized === null ? 0 : sized.outputWidth * sized.outputHeight * 8 * 2;
	}

	/**
	 * (re)creates the history for new sizes or inputs; the history starts afresh.
	 *
	 * @param input the composited scene and the depth at the render size, and both sizes
	 */
	resize(input: {
		scene: GPUTextureView;
		depth: GPUTextureView;
		width: number;
		height: number;
		outputWidth: number;
		outputHeight: number;
	}): void {
		this.#release();
		const { scene, depth, width, height, outputWidth, outputHeight } = input;
		const history = (i: number): GPUTexture =>
			this.#device.createTexture({
				label: `taa history ${i}`,
				size: [outputWidth, outputHeight],
				format: HDR_FORMAT,
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			});
		const pair: [GPUTexture, GPUTexture] = [history(0), history(1)];
		const group = (read: GPUTexture): GPUBindGroup =>
			this.#device.createBindGroup({
				label: 'taa',
				layout: this.pipeline.getBindGroupLayout(1),
				entries: [
					{ binding: 0, resource: { buffer: this.#uniforms } },
					{ binding: 1, resource: scene },
					{ binding: 2, resource: depth },
					{ binding: 3, resource: read.createView() },
					{ binding: 4, resource: this.#sampler },
				],
			});
		this.#sized = {
			width,
			height,
			outputWidth,
			outputHeight,
			history: pair,
			groups: [group(pair[1]), group(pair[0])],
		};
		this.#valid = false;
	}

	/** @returns the two histories; {@link encode} says which one a frame wrote */
	get histories(): readonly GPUTexture[] {
		if (this.#sized === null) {
			throw new Error('temporal AA used before resize()');
		}
		return this.#sized.history;
	}

	/**
	 * resolves this frame into one of the {@link histories}, which the next frame then reads.
	 *
	 * @param encoder this frame's encoder, after the scene is composited
	 * @param input the camera (unjittered) and the pass's group 0 (the post uniforms)
	 * @returns the index of the history written, which the passes after it read
	 */
	encode(encoder: GPUCommandEncoder, input: { camera: Camera; postGroup: GPUBindGroup }): number {
		const sized = this.#sized;
		if (sized === null) {
			throw new Error('temporal AA used before resize()');
		}
		const { camera, postGroup } = input;
		camera.writeViewProjection(sized.width / sized.height, this.#viewProj);
		const eye = camera.position;
		const f = this.#data;
		f.set(this.#previousViewProj, 0);
		f[16] = eye[0] - this.#previousEye[0];
		f[17] = eye[1] - this.#previousEye[1];
		f[18] = eye[2] - this.#previousEye[2];
		f[19] = this.#valid ? 0 : 1;
		f.set([sized.width, sized.height, 1 / sized.width, 1 / sized.height], 20);
		f.set([BLEND, this.enabled ? 0 : 1, 0, 0], 24);
		this.#device.queue.writeBuffer(this.#uniforms, 0, f);

		const pass = encoder.beginRenderPass({
			label: 'taa',
			colorAttachments: [
				{ view: sized.history[this.#index].createView(), loadOp: 'clear', storeOp: 'store' },
			],
		});
		pass.setPipeline(this.pipeline);
		pass.setBindGroup(0, postGroup);
		pass.setBindGroup(1, sized.groups[this.#index]);
		pass.draw(3);
		pass.end();

		this.#previousViewProj.set(this.#viewProj);
		this.#previousEye = [eye[0], eye[1], eye[2]];
		this.#valid = true;
		const written = this.#index;
		this.#index = 1 - written;
		return written;
	}

	#release(): void {
		for (const texture of this.#sized?.history ?? []) {
			texture.destroy();
		}
		this.#sized = null;
	}

	/** frees the history and the uniforms */
	destroy(): void {
		this.#release();
		this.#uniforms.destroy();
	}
}
