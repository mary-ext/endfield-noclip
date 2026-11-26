import {
	type TgpuBindGroup,
	type TgpuComputePipeline,
	type TgpuRenderPipeline,
	type TgpuRoot,
	common,
} from 'typegpu';

import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';
import { type TgpuFullscreenPass, encodeTgpuFullscreen } from '../../gfx/tgpu-fullscreen.ts';
import { postUniformLayout } from '../core/post-schema.ts';
import type { Tonemapper } from '../core/settings.ts';

import {
	TONEMAP_LUT_SIZE,
	csBakeTonemapLut,
	fsTonemap,
	tonemapLayout,
	tonemapLutLayout,
} from './tonemap-shader.ts';

const LUT_WORKGROUP = 4;

/**
 * the final pass (tonemap-shader.ts): exposure, bloom, vignette, 3D LUT grading and tonemapping into the
 * swapchain
 */
export class Tonemap {
	#root: TgpuRoot;
	#sampler: GPUSampler;
	#pipeline: AsyncPipeline<TgpuRenderPipeline>;
	#lutPipeline: AsyncPipeline<TgpuComputePipeline>;
	#postGroup: TgpuBindGroup;
	#lutTexture: GPUTexture;
	#lutView: GPUTextureView;
	#lutGroup: TgpuBindGroup;
	#lutDirty = true;
	#lastTonemapper: Tonemapper | null = null;
	/** per temporal history: the pass reading it */
	#passes: [TgpuFullscreenPass, TgpuFullscreenPass] | null = null;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 * @param postUniforms the post chain's `Post` uniforms
	 * @param sampler the bilinear clamping sampler the bloom and 3D LUT are read with
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
		this.#lutTexture = root.device.createTexture({
			label: 'tonemap grading lut',
			size: [TONEMAP_LUT_SIZE, TONEMAP_LUT_SIZE, TONEMAP_LUT_SIZE],
			dimension: '3d',
			format: 'rgba16float',
			usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
		});
		this.#lutView = this.#lutTexture.createView();
		this.#lutGroup = root.createBindGroup(tonemapLutLayout, { lut: this.#lutView });
		this.#lutPipeline = pipelines.prepareTgpuCompute('tonemap lut', () =>
			root.createComputePipeline({ compute: csBakeTonemapLut }),
		);
		this.#pipeline = pipelines.prepareTgpuRender('tonemap', () =>
			root.createRenderPipeline({
				vertex: common.fullScreenTriangle,
				fragment: fsTonemap,
				targets: { format: swapchainFormat },
			}),
		);
	}

	/** marks the 3D grading LUT dirty so it re-bakes on the next frame (when environment grading changes) */
	invalidateLut(): void {
		this.#lutDirty = true;
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
				lut: this.#lutView,
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
	 * @param input the swapchain's current view, which history this frame's resolve wrote, and active
	 *   tonemapper
	 */
	encode(
		encoder: GPUCommandEncoder,
		input: { swapchain: GPUTextureView; history: number; tonemap: Tonemapper },
	): void {
		if (this.#passes === null) {
			throw new Error('tonemap used before resize()');
		}
		if (input.tonemap !== 'none' && (this.#lutDirty || this.#lastTonemapper !== input.tonemap)) {
			const lutPipeline = this.#lutPipeline.get();
			if (lutPipeline === undefined) {
				return;
			}
			const pass = encoder.beginComputePass({ label: 'tonemap lut' });
			lutPipeline
				.with(this.#postGroup)
				.with(this.#lutGroup)
				.with(pass)
				.dispatchWorkgroups(
					TONEMAP_LUT_SIZE / LUT_WORKGROUP,
					TONEMAP_LUT_SIZE / LUT_WORKGROUP,
					TONEMAP_LUT_SIZE / LUT_WORKGROUP,
				);
			pass.end();
			this.#lutDirty = false;
			this.#lastTonemapper = input.tonemap;
		}
		const pass = this.#passes[input.history];
		pass.target = input.swapchain;
		encodeTgpuFullscreen(encoder, pass);
	}

	/** frees the 3D grading LUT */
	destroy(): void {
		this.#lutTexture.destroy();
	}
}
