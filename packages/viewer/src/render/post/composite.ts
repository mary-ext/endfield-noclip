import { type TgpuBindGroup, type TgpuRenderPipeline, type TgpuRoot, common } from 'typegpu';

import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';
import { placeholder } from '../../gfx/placeholders.ts';
import { LINEAR_REPEAT, sampler } from '../../gfx/samplers.ts';
import { type TgpuFullscreenPass, encodeTgpuFullscreen } from '../../gfx/tgpu-fullscreen.ts';
import { HDR_FORMAT, type SceneTextures } from '../frame/render-targets.ts';
import { skyReadLayout } from '../sky/atmosphere-shader.ts';
import type { TextureBinding } from '../textures/texture-store.ts';

import { compositeFlowNoiseLayout, compositeSceneLayout, fsComposite } from './composite-shader.ts';
import { postUniformLayout } from './post-schema.ts';

/**
 * the composite (composite-shader.ts): resolves the main pass into the scene at the render size, with the
 * reflections, AO, sky, celestial layers and fogs
 */
export class Composite {
	#root: TgpuRoot;
	#pipeline: AsyncPipeline<TgpuRenderPipeline>;
	#postGroup: TgpuBindGroup;
	#skyGroup: TgpuBindGroup;
	#sceneGroup: TgpuBindGroup | null = null;
	#flowNoiseGroup: TgpuBindGroup;
	#pass: TgpuFullscreenPass | null = null;
	#flowNoise: TextureBinding;
	#noFlowNoise: TextureBinding;
	#repeatSampler: GPUSampler;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 * @param input the post chain's `Post` uniforms, the bilinear clamping sampler, the sky-view LUT and the
	 *   volumetric fog
	 */
	constructor(
		root: TgpuRoot,
		pipelines: PipelineCache,
		input: { postUniforms: GPUBuffer; sampler: GPUSampler; skyView: GPUTextureView; froxels: GPUTextureView },
	) {
		this.#root = root;
		this.#pipeline = pipelines.prepareTgpuRender('composite', () =>
			root.createRenderPipeline({
				vertex: common.fullScreenTriangle,
				fragment: fsComposite,
				targets: { format: HDR_FORMAT },
			}),
		);
		this.#postGroup = root.createBindGroup(postUniformLayout, { post: input.postUniforms });
		this.#skyGroup = root.createBindGroup(skyReadLayout, {
			skyView: input.skyView,
			lutSampler: input.sampler,
			froxels: input.froxels,
		});
		this.#repeatSampler = sampler(root.device, LINEAR_REPEAT);
		this.#noFlowNoise = {
			view: placeholder(root.device, 'black', '3d'),
			sampler: this.#repeatSampler,
			version: -1,
		};
		this.#flowNoise = this.#noFlowNoise;
		this.#flowNoiseGroup = this.#makeFlowNoiseGroup(this.#noFlowNoise.view);
	}

	#makeFlowNoiseGroup(view: GPUTextureView): TgpuBindGroup {
		return this.#root.createBindGroup(compositeFlowNoiseLayout, {
			flowNoise: view,
			flowNoiseSampler: this.#repeatSampler,
		});
	}

	/** @returns whether the flow noise is bound */
	get hasFlowNoise(): boolean {
		return this.#flowNoise !== this.#noFlowNoise;
	}

	/**
	 * binds the height fog's flow noise, once it streams in.
	 *
	 * @param noise the 3D texture's binding, or `null` for none
	 */
	setFlowNoise(noise: TextureBinding | null): void {
		const next = noise ?? this.#noFlowNoise;
		if (next !== this.#flowNoise) {
			this.#flowNoise = next;
			this.#flowNoiseGroup = this.#makeFlowNoiseGroup(next.view);
			if (this.#pass !== null && this.#sceneGroup !== null) {
				this.#pass.groups = [this.#postGroup, this.#skyGroup, this.#sceneGroup, this.#flowNoiseGroup];
				this.#pass.bound = undefined;
			}
		}
	}

	/**
	 * rebinds the inputs after they were recreated.
	 *
	 * @param input the deferred-lit scene (`scene.lit`, holding celestial layers on sky pixels and lit radiance
	 *   on surface pixels), main-pass depth, and the composited target
	 */
	resize(input: { scene: SceneTextures; target: GPUTextureView }): void {
		const { scene, target } = input;
		this.#sceneGroup = this.#root.createBindGroup(compositeSceneLayout, {
			lit: scene.lit,
			depth: scene.depth,
		});
		this.#pass = {
			label: 'composite',
			pipeline: this.#pipeline,
			groups: [this.#postGroup, this.#skyGroup, this.#sceneGroup, this.#flowNoiseGroup],
			target,
		};
	}

	/** @param encoder this frame's encoder, after the reflections and celestial layers */
	encode(encoder: GPUCommandEncoder): void {
		const pass = this.#pass;
		if (pass === null) {
			throw new Error('composite used before resize()');
		}
		encodeTgpuFullscreen(encoder, pass);
	}
}
