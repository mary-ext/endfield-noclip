import { type TgpuBindGroup, type TgpuRenderPipeline, type TgpuRoot, common, d } from 'typegpu';

import { createUniformBuffer } from '../../gfx/buffers.ts';
import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';
import { LINEAR_CLAMP, sampler } from '../../gfx/samplers.ts';
import { TextureSet } from '../../gfx/texture-set.ts';
import { type TgpuFullscreenPass, encodeTgpuFullscreen } from '../../gfx/tgpu-fullscreen.ts';
import { halton } from '../../math/sequence.ts';
import type { Camera } from '../../scene/camera.ts';
import { HDR_FORMAT } from '../frame/render-targets.ts';

import { CAMERA_HISTORY_FLOATS, CameraHistory } from './camera-history.ts';
import { postUniformLayout } from './post-schema.ts';
import { TaaSchema, fsTaa, taaLayout } from './taa-shader.ts';

/** frames rendered after the last change, so the history converges on the still view */
export const SETTLE_FRAMES = 32;
/** the new frame's weight in the blend */
const BLEND = 0.1;
/** jitter positions per cycle without upsampling; the cycle lengthens with the upsampling ratio squared */
const BASE_PHASES = 8;
const MAX_PHASES = 64;
/** byte size of {@link TaaSchema} */
const UNIFORM_BYTES = d.sizeOf(TaaSchema);

interface Sized {
	width: number;
	height: number;
	/** the history pair at the output size; each frame writes one and reads the other */
	history: [GPUTexture, GPUTexture];
	/** views of {@link history} */
	views: [GPUTextureView, GPUTextureView];
	/** resolve pass of the frame that writes `history[i]` */
	passes: [TgpuFullscreenPass, TgpuFullscreenPass];
}

/** owns the jitter sequence, the history and the resolve pass */
export class TemporalAA {
	/** jitter and accumulate; off passes the current frame through (upscaled to the output size) */
	enabled = true;
	#root: TgpuRoot;
	#pipeline: AsyncPipeline<TgpuRenderPipeline>;
	#postGroup: TgpuBindGroup;
	#uniforms: GPUBuffer;
	#data = new Float32Array(UNIFORM_BYTES / 4);
	#sampler: GPUSampler;
	#targets: TextureSet;
	#sized: Sized | null = null;
	#camera = new CameraHistory();
	#phase = 0;
	#jitter: [x: number, y: number] = [0, 0];

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 * @param postUniforms the post chain's `Post` uniforms
	 */
	constructor(root: TgpuRoot, pipelines: PipelineCache, postUniforms: GPUBuffer) {
		this.#root = root;
		this.#postGroup = root.createBindGroup(postUniformLayout, { post: postUniforms });
		this.#pipeline = pipelines.prepareTgpuRender('taa', () =>
			root.createRenderPipeline({
				vertex: common.fullScreenTriangle,
				fragment: fsTaa,
				targets: { format: HDR_FORMAT },
			}),
		);
		this.#uniforms = createUniformBuffer(root.device, 'taa uniforms', UNIFORM_BYTES);
		this.#sampler = sampler(root.device, LINEAR_CLAMP);
		this.#targets = new TextureSet(root.device);
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

	/** @returns this frame's place in the jitter cycle, from 1; 0 while off */
	get phase(): number {
		return this.enabled ? this.#phase : 0;
	}

	/** @returns this frame's jitter in NDC, as {@link nextJitter} returned it */
	get jitter(): readonly [x: number, y: number] {
		return this.#jitter;
	}

	/** drops the history, so the next frame starts afresh (a new package or level, a debug view) */
	reset(): void {
		this.#camera.reset();
	}

	/** @returns bytes of the history pair */
	get bytes(): number {
		return this.#targets.bytes;
	}

	/**
	 * (re)creates the history for new sizes or inputs; the history starts afresh.
	 *
	 * @param input the composited scene and the depth at the render size, and both sizes
	 */
	resize(input: {
		scene: GPUTextureView;
		depth: GPUTextureView;
		velocity: GPUTextureView;
		width: number;
		height: number;
		outputWidth: number;
		outputHeight: number;
	}): void {
		this.#release();
		const { scene, depth, velocity, width, height, outputWidth, outputHeight } = input;
		const history = (i: number): GPUTexture =>
			this.#targets.create({
				label: `taa history ${i}`,
				size: [outputWidth, outputHeight],
				format: HDR_FORMAT,
			});
		const pair: [GPUTexture, GPUTexture] = [history(0), history(1)];
		const views: [GPUTextureView, GPUTextureView] = [pair[0].createView(), pair[1].createView()];
		const makePass = (read: GPUTextureView, target: GPUTextureView): TgpuFullscreenPass => ({
			label: 'taa',
			pipeline: this.#pipeline,
			groups: [
				this.#postGroup,
				this.#root.createBindGroup(taaLayout, {
					taa: this.#uniforms,
					current: scene,
					depth,
					history: read,
					linearSampler: this.#sampler,
					velocity,
				}),
			],
			target,
		});
		this.#sized = {
			width,
			height,
			history: pair,
			views,
			passes: [makePass(views[1], views[0]), makePass(views[0], views[1])],
		};
		this.#camera.reset();
	}

	#ensureSized(): Sized {
		if (this.#sized === null) {
			throw new Error('temporal AA used before resize()');
		}
		return this.#sized;
	}

	/** @returns the two histories; {@link encode} says which one a frame wrote */
	get histories(): readonly GPUTexture[] {
		return this.#ensureSized().history;
	}

	/** @returns index into {@link histories} of last frame's resolved scene, before {@link encode} advances */
	get previousIndex(): number {
		return 1 - this.#camera.index;
	}

	/**
	 * reads last frame's resolved history and its reprojection uniforms, before {@link encode} overwrites the
	 * other buffer.
	 *
	 * @param out target array for {@link CAMERA_HISTORY_FLOATS} reprojection floats
	 * @param eye this frame's camera position
	 * @returns the previous history view, or `null` when no valid history exists yet
	 */
	previous(out: Float32Array, eye: readonly [number, number, number]): GPUTextureView | null {
		const sized = this.#sized;
		this.#camera.readPrevious(out, [eye[0], eye[1], eye[2]]);
		if (sized === null || !this.#camera.valid) {
			return null;
		}
		return sized.views[1 - this.#camera.index];
	}

	/**
	 * resolves this frame into one of the {@link histories}, which the next frame then reads.
	 *
	 * @param encoder this frame's encoder, after the scene is composited
	 * @param camera the camera (unjittered)
	 * @returns the index of the history written, which the passes after it read
	 */
	encode(encoder: GPUCommandEncoder, camera: Camera): number {
		const sized = this.#ensureSized();
		const written = this.#camera.index;
		const f = this.#data;
		this.#camera.write(f, camera, sized.width / sized.height);
		f.set([sized.width, sized.height, 1 / sized.width, 1 / sized.height], CAMERA_HISTORY_FLOATS);
		f.set([BLEND, this.enabled ? 0 : 1, 0, 0], CAMERA_HISTORY_FLOATS + 4);
		this.#root.device.queue.writeBuffer(this.#uniforms, 0, f);
		if (encodeTgpuFullscreen(encoder, sized.passes[written])) {
			this.#camera.advance();
		}
		return written;
	}

	#release(): void {
		this.#targets.destroy();
		this.#sized = null;
	}

	/** frees the history and the uniforms */
	destroy(): void {
		this.#release();
		this.#uniforms.destroy();
	}
}
