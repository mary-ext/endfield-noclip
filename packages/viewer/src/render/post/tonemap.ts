import { type TgpuBindGroup, type TgpuRenderPipeline, type TgpuRoot, common } from 'typegpu';

import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';
import { type TgpuFullscreenPass, encodeTgpuFullscreen } from '../../gfx/tgpu-fullscreen.ts';
import { postUniformLayout } from '../core/post-schema.ts';

import { fsTonemap, tonemapLayout } from './tonemap-shader.ts';

/** the final pass (tonemap-shader.ts): exposure, bloom, vignette, grading and tonemapping into the swapchain */
export class Tonemap {
	#root: TgpuRoot;
	#sampler: GPUSampler;
	#pipeline: AsyncPipeline<TgpuRenderPipeline>;
	#postGroup: TgpuBindGroup;
	/** per temporal history: the pass reading it */
	#passes: [TgpuFullscreenPass, TgpuFullscreenPass] | null = null;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 * @param postUniforms the post chain's `Post` uniforms
	 * @param sampler the bilinear clamping sampler the bloom is read with
	 * @param swapchainFormat the canvas format
	 */
	constructor(
		root: TgpuRoot,
		pipelines: PipelineCache,
		postUniforms: GPUBuffer,
		sampler: GPUSampler,
		swapchainFormat: GPUTextureFormat,
	) {
		this.#root = root;
		this.#sampler = sampler;
		this.#postGroup = root.createBindGroup(postUniformLayout, {
			post: postUniforms,
		});
		this.#pipeline = pipelines.prepareTgpuRender('tonemap', () =>
			root.createRenderPipeline({
				vertex: common.fullScreenTriangle,
				fragment: fsTonemap,
				targets: { format: swapchainFormat },
			}),
		);
	}

	/**
	 * rebinds the inputs after they were recreated.
	 *
	 * @param input the temporal histories, and the bloom (`null` without any)
	 */
	resize(input: { histories: readonly GPUTexture[]; bloom: GPUTexture | null }): void {
		const makePass = (history: GPUTexture): TgpuFullscreenPass => {
			const group = this.#root.createBindGroup(tonemapLayout, {
				scene: history.createView(),
				bloom: (input.bloom ?? history).createView(),
				bilinear: this.#sampler,
			});
			return {
				label: 'tonemap',
				pipeline: this.#pipeline,
				groups: [this.#postGroup, group],
				target: null,
			};
		};
		this.#passes = [makePass(input.histories[0]), makePass(input.histories[1])];
	}

	/**
	 * @param encoder this frame's encoder, after the bloom
	 * @param input the swapchain's current view and which history this frame's resolve wrote
	 */
	encode(encoder: GPUCommandEncoder, input: { swapchain: GPUTextureView; history: number }): void {
		if (this.#passes === null) {
			throw new Error('tonemap used before resize()');
		}
		const pass = this.#passes[input.history];
		pass.target = input.swapchain;
		encodeTgpuFullscreen(encoder, pass);
	}
}
