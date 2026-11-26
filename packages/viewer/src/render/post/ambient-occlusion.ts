import { type TgpuBindGroup, type TgpuRenderPipeline, type TgpuRoot, common } from 'typegpu';

import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';
import { sampler } from '../../gfx/samplers.ts';
import { TextureSet } from '../../gfx/texture-set.ts';
import { type TgpuFullscreenPass, encodeTgpuFullscreen } from '../../gfx/tgpu-fullscreen.ts';
import { postUniformLayout } from '../core/post-schema.ts';

import {
	AO_SCALE,
	fsAoDepth,
	fsGtao,
	fsGtaoBlur,
	gtaoBlurLayout,
	gtaoDepthLayout,
	gtaoMarchLayout,
} from './gtao-shader.ts';

const AO_FORMAT: GPUTextureFormat = 'r8unorm';
/** the reduced view depth the AO marches */
const AO_DEPTH_FORMAT: GPUTextureFormat = 'r32float';

interface Sized {
	/** the blurred AO, at full resolution */
	blurred: GPUTextureView;
	/** the reduced depth, the march and the depth-aware blur that upsamples it */
	passes: TgpuFullscreenPass[];
}

/** the ground-truth ambient occlusion (gtao-shader.ts): marched at half resolution, blurred back up */
export class AmbientOcclusion {
	#root: TgpuRoot;
	#postGroup: TgpuBindGroup;
	#gatherSampler: GPUSampler;
	#pipelines: Record<'depth' | 'gtao' | 'blur', AsyncPipeline<TgpuRenderPipeline>>;
	/** half resolution: view depth, and the AO marched over it; full resolution: the blurred AO */
	#targets: TextureSet;
	#sized: Sized | null = null;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 * @param postUniforms the post chain's `Post` uniforms
	 */
	constructor(root: TgpuRoot, pipelines: PipelineCache, postUniforms: GPUBuffer) {
		this.#root = root;
		this.#targets = new TextureSet(root.device);
		this.#gatherSampler = sampler(root.device, {});
		this.#postGroup = root.createBindGroup(postUniformLayout, { post: postUniforms });
		const make = (
			label: string,
			fragment: typeof fsAoDepth,
			format: GPUTextureFormat,
		): AsyncPipeline<TgpuRenderPipeline> =>
			pipelines.prepareTgpuRender(label, () =>
				root.createRenderPipeline({
					vertex: common.fullScreenTriangle,
					fragment,
					targets: { format },
				}),
			);
		this.#pipelines = {
			depth: make('ao depth', fsAoDepth, AO_DEPTH_FORMAT),
			gtao: make('gtao', fsGtao, AO_FORMAT),
			blur: make('gtao blur', fsGtaoBlur, AO_FORMAT),
		};
	}

	#ensureSized(): Sized {
		if (this.#sized === null) {
			throw new Error('ambient occlusion used before resize()');
		}
		return this.#sized;
	}

	/** @returns the blurred occlusion at the render size, which the composite reads; valid after {@link resize} */
	get output(): GPUTextureView {
		return this.#ensureSized().blurred;
	}

	/** @returns bytes of the targets */
	get bytes(): number {
		return this.#targets.bytes;
	}

	/**
	 * (re)creates the targets for a new render size, depth or G-buffer.
	 *
	 * @param input the main pass's depth, G-buffer B (normals) and the render size
	 */
	resize(input: { depth: GPUTextureView; gbufferB: GPUTextureView; width: number; height: number }): void {
		this.#release();
		const { depth, gbufferB, width, height } = input;
		const root = this.#root;
		const p = this.#pipelines;
		const texture = (label: string, w: number, h: number, format: GPUTextureFormat): GPUTexture =>
			this.#targets.create({
				label,
				size: [w, h],
				format,
				usage:
					GPUTextureUsage.RENDER_ATTACHMENT |
					GPUTextureUsage.TEXTURE_BINDING |
					GPUTextureUsage.COPY_SRC |
					GPUTextureUsage.COPY_DST,
			});
		const aoWidth = Math.max(1, Math.ceil(width / AO_SCALE));
		const aoHeight = Math.max(1, Math.ceil(height / AO_SCALE));
		const aoDepth = texture('ao depth', aoWidth, aoHeight, AO_DEPTH_FORMAT);
		const ao = texture('ao', aoWidth, aoHeight, AO_FORMAT);
		const blurred = texture('ao blurred', width, height, AO_FORMAT);
		const aoDepthView = aoDepth.createView();
		const aoView = ao.createView();
		const blurredView = blurred.createView();
		this.#sized = {
			blurred: blurredView,
			passes: [
				{
					label: 'ao depth',
					pipeline: p.depth,
					groups: [this.#postGroup, root.createBindGroup(gtaoDepthLayout, { depth })],
					target: aoDepthView,
				},
				{
					label: 'gtao',
					pipeline: p.gtao,
					groups: [
						this.#postGroup,
						root.createBindGroup(gtaoMarchLayout, { halfDepth: aoDepthView, gbufferB }),
					],
					target: aoView,
				},
				{
					label: 'gtao blur',
					pipeline: p.blur,
					groups: [
						this.#postGroup,
						root.createBindGroup(gtaoBlurLayout, {
							depth,
							halfDepth: aoDepthView,
							ao: aoView,
							gatherSampler: this.#gatherSampler,
						}),
					],
					target: blurredView,
				},
			],
		};
	}

	/** @param encoder this frame's encoder, after the main pass */
	encode(encoder: GPUCommandEncoder): void {
		for (const pass of this.#ensureSized().passes) {
			encodeTgpuFullscreen(encoder, pass);
		}
	}

	#release(): void {
		this.#targets.destroy();
		this.#sized = null;
	}

	/** frees the targets */
	destroy(): void {
		this.#release();
	}
}
