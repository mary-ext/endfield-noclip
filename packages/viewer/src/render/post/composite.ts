import { autoBindGroup, encodeFullscreen, fullscreenPipeline } from '../../gfx/fullscreen-pass.ts';
import { placeholder } from '../../gfx/placeholders.ts';
import { LINEAR_REPEAT, sampler } from '../../gfx/samplers.ts';
import { HDR_FORMAT, type SceneTextures } from '../frame/render-targets.ts';
import { SkyBinding } from '../sky/atmosphere-luts.ts';
import atmosphereWgsl from '../sky/atmosphere.wgsl?raw';
import { fogSource } from '../sky/fog-source.ts';
import skyWgsl from '../sky/sky.wgsl?raw';
import type { TextureBinding } from '../textures/texture-store.ts';

import compositeWgsl from './composite.wgsl?raw';
import { postShaderModule } from './shader-source.ts';

/**
 * the composite (composite.wgsl): resolves the main pass into the scene at the render size, with the
 * reflections, AO, sky, celestial layers and fogs
 */
export class Composite {
	#device: GPUDevice;
	#pipeline: GPURenderPipeline;
	/** groups 0 (uniforms) and 1 (the sky-view LUT and the volumetric fog) */
	#skyGroups: [GPUBindGroup, GPUBindGroup];
	#sized: { scene: GPUBindGroup; target: GPUTextureView } | null = null;
	/** the height fog's flow noise and the repeating sampler the game reads it with */
	#flowNoiseGroup: GPUBindGroup;
	#flowNoise: TextureBinding;
	#noFlowNoise: TextureBinding;
	#repeatSampler: GPUSampler;

	/**
	 * @param device the device
	 * @param input the post chain's `Post` uniforms, the bilinear clamping sampler, the sky-view LUT and the
	 *   volumetric fog
	 */
	constructor(
		device: GPUDevice,
		input: { postUniforms: GPUBuffer; sampler: GPUSampler; skyView: GPUTextureView; froxels: GPUTextureView },
	) {
		this.#device = device;
		this.#pipeline = fullscreenPipeline(device, {
			label: 'composite',
			module: postShaderModule(device, 'composite', [
				atmosphereWgsl,
				fogSource({ group: 1, binding: SkyBinding.froxels }),
				skyWgsl,
				compositeWgsl,
			]),
			entryPoint: 'fs_composite',
			targets: [{ format: HDR_FORMAT }],
		});
		this.#skyGroups = [
			autoBindGroup(device, this.#pipeline, 0, { 0: { buffer: input.postUniforms } }),
			autoBindGroup(device, this.#pipeline, 1, {
				[SkyBinding.skyView]: input.skyView,
				[SkyBinding.sampler]: input.sampler,
				[SkyBinding.froxels]: input.froxels,
			}),
		];
		this.#repeatSampler = sampler(device, LINEAR_REPEAT);
		this.#noFlowNoise = {
			view: placeholder(device, 'black', '3d'),
			sampler: this.#repeatSampler,
			version: -1,
		};
		this.#flowNoise = this.#noFlowNoise;
		this.#flowNoiseGroup = this.#makeFlowNoiseGroup();
	}

	#makeFlowNoiseGroup(): GPUBindGroup {
		return autoBindGroup(this.#device, this.#pipeline, 3, {
			0: this.#flowNoise.view,
			1: this.#repeatSampler,
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
			this.#flowNoiseGroup = this.#makeFlowNoiseGroup();
		}
	}

	/**
	 * rebinds the inputs after they were recreated.
	 *
	 * @param input the main pass's outputs, the blurred AO, the reflections' change to the radiance, and the
	 *   scene the composite writes. the celestial pass draws the nebula and planets (and how far they cover the
	 *   sky) into the main pass's sky reflection target, which the composite reads
	 */
	resize(input: {
		scene: SceneTextures;
		ao: GPUTextureView;
		reflections: GPUTextureView;
		target: GPUTextureView;
	}): void {
		const { scene } = input;
		this.#sized = {
			target: input.target,
			scene: autoBindGroup(this.#device, this.#pipeline, 2, {
				0: scene.radiance,
				1: scene.ambient,
				2: input.ao,
				3: scene.depth,
				6: input.reflections,
				9: scene.reflection,
			}),
		};
	}

	/** @param encoder this frame's encoder, after the reflections and celestial layers */
	encode(encoder: GPUCommandEncoder): void {
		const sized = this.#sized;
		if (sized === null) {
			throw new Error('composite used before resize()');
		}
		encodeFullscreen(encoder, {
			label: 'composite',
			pipeline: this.#pipeline,
			groups: [...this.#skyGroups, sized.scene, this.#flowNoiseGroup],
			targets: [sized.target],
		});
	}
}
