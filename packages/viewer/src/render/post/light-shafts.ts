import {
	type TgpuBindGroup,
	type TgpuRenderPipeline,
	type TgpuRoot,
	type TgpuUniform,
	common,
	d,
} from 'typegpu';

import type { LightShaftLook } from '../../environment/environment.ts';
import { ADDITIVE } from '../../gfx/blend.ts';
import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';
import { LINEAR_CLAMP, sampler } from '../../gfx/samplers.ts';
import { TextureSet } from '../../gfx/texture-set.ts';
import { type TgpuFullscreenPass, encodeTgpuFullscreen } from '../../gfx/tgpu-fullscreen.ts';
import type { Camera } from '../../scene/camera.ts';
import { postUniformLayout } from '../core/post-schema.ts';
import { HDR_FORMAT, type SceneTextures } from '../core/render-targets.ts';

import {
	ShaftsSchema,
	fsLightShaftApply,
	fsLightShaftBlur,
	fsLightShaftDownsample,
	lightShaftsBlurLayout,
	lightShaftsDownsampleLayout,
	lightShaftsSharedLayout,
} from './light-shafts-shader.ts';

/** the game's `lightShaftDownSampleFactor` at PC quality tiers 2000 and up */
const DOWNSAMPLE = 2;
/** the game's default `lightShaftSampleNum` */
const SAMPLES = 12;
/** the game's default `lightShaftBlurPassCount` */
const BLUR_PASSES = 3;

interface Sized {
	/** the downsample, then the blur passes, ping-ponging */
	passes: TgpuFullscreenPass[];
	/** adds the last blur onto the scene */
	apply: TgpuFullscreenPass;
}

/** owns the shafts' reduced-size targets and passes */
export class LightShafts {
	#root: TgpuRoot;
	#format: GPUTextureFormat;
	#uniforms: TgpuUniform<typeof ShaftsSchema>;
	/** per blur pass: its index */
	#passUniforms: TgpuUniform<typeof d.vec4f>[];
	#postGroup: TgpuBindGroup;
	#sharedGroup: TgpuBindGroup;
	#pipelines: Record<'downsample' | 'blur' | 'apply', AsyncPipeline<TgpuRenderPipeline>>;
	#targets: TextureSet;
	#sized: Sized | null = null;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 * @param postUniforms the post chain's `Post` uniforms
	 */
	constructor(
		root: TgpuRoot,
		pipelines: PipelineCache,
		postUniforms: GPUBuffer,
		format: GPUTextureFormat = HDR_FORMAT,
	) {
		this.#root = root;
		this.#format = format;
		this.#targets = new TextureSet(root.device);
		this.#uniforms = root.createUniform(ShaftsSchema);
		this.#passUniforms = Array.from({ length: BLUR_PASSES }, (_, i) =>
			root.createUniform(d.vec4f, [i, 0, 0, 0]),
		);
		this.#postGroup = root.createBindGroup(postUniformLayout, { post: postUniforms });
		this.#sharedGroup = root.createBindGroup(lightShaftsSharedLayout, {
			shafts: this.#uniforms,
			bilinear: sampler(root.device, LINEAR_CLAMP),
		});
		const make = (
			label: string,
			fragment: typeof fsLightShaftDownsample,
			target: GPUColorTargetState,
		): AsyncPipeline<TgpuRenderPipeline> =>
			pipelines.prepareTgpuRender(label, () =>
				root.createRenderPipeline({
					vertex: common.fullScreenTriangle,
					fragment,
					targets: target,
				}),
			);
		this.#pipelines = {
			downsample: make('light shaft downsample', fsLightShaftDownsample, { format }),
			blur: make('light shaft blur', fsLightShaftBlur, { format }),
			// the game adds the colour only onto the composited scene (`HDR_FORMAT`)
			apply: make('light shaft apply', fsLightShaftApply, {
				format: HDR_FORMAT,
				blend: ADDITIVE,
				writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE,
			}),
		};
	}

	/** @returns bytes of the targets */
	get bytes(): number {
		return this.#targets.bytes;
	}

	/**
	 * (re)creates the targets for a new render size or inputs.
	 *
	 * @param input the main pass's textures, the composited scene (read, then added onto) and the render size
	 */
	resize(input: { scene: SceneTextures; composited: GPUTextureView; width: number; height: number }): void {
		this.#release();
		const root = this.#root;
		const p = this.#pipelines;
		const width = Math.max(1, Math.ceil(input.width / DOWNSAMPLE));
		const height = Math.max(1, Math.ceil(input.height / DOWNSAMPLE));
		const views = [0, 1].map((i) =>
			this.#targets
				.create({ label: `light shafts ${i}`, size: [width, height], format: this.#format })
				.createView(),
		);
		const downsampleGroup = root.createBindGroup(lightShaftsDownsampleLayout, {
			scene: input.composited,
			depth: input.scene.depth,
		});
		const passes: TgpuFullscreenPass[] = [
			{
				label: 'light shaft downsample',
				pipeline: p.downsample,
				groups: [this.#postGroup, this.#sharedGroup, downsampleGroup],
				target: views[0],
			},
		];
		for (let i = 0; i < BLUR_PASSES; i++) {
			const blurGroup = root.createBindGroup(lightShaftsBlurLayout, {
				blurPass: this.#passUniforms[i],
				blurSource: views[i % 2],
			});
			passes.push({
				label: 'light shaft blur',
				pipeline: p.blur,
				groups: [this.#sharedGroup, blurGroup],
				target: views[(i + 1) % 2],
			});
		}
		const applyGroup = root.createBindGroup(lightShaftsBlurLayout, {
			blurPass: this.#passUniforms[0],
			blurSource: views[BLUR_PASSES % 2],
		});
		const apply: TgpuFullscreenPass = {
			label: 'light shaft apply',
			pipeline: p.apply,
			groups: [this.#sharedGroup, applyGroup],
			target: input.composited,
		};
		this.#sized = { passes, apply };
	}

	/**
	 * adds this frame's shafts onto the composited scene, when the look has them and the sun is in front of the
	 * camera.
	 *
	 * @param encoder this frame's encoder, after compositing and before temporal antialiasing
	 * @param input the camera (unjittered), the render size's aspect and the environment's shafts (`null`:
	 *   none)
	 */
	encode(
		encoder: GPUCommandEncoder,
		input: { camera: Camera; aspect: number; look: LightShaftLook | null },
	): void {
		const sized = this.#sized;
		if (sized === null) {
			throw new Error('light shafts used before resize()');
		}
		const { camera, aspect, look } = input;
		if (look === null) {
			return;
		}
		const sun = camera.projectDirection(look.sunDirection, aspect);
		if (sun === null) {
			return;
		}
		this.#uniforms.write({
			params: [1 / look.occlusionDepthRange, look.bloomScale, 0, look.maxBrightness],
			tint: [look.tint[0], look.tint[1], look.tint[2], look.threshold],
			sun: [sun[0], sun[1], SAMPLES, look.blurIntensity],
		});
		for (const pass of sized.passes) {
			encodeTgpuFullscreen(encoder, pass);
		}
		encodeTgpuFullscreen(encoder, sized.apply, 'load');
	}

	#release(): void {
		this.#targets.destroy();
		this.#sized = null;
	}

	/** frees the targets and the uniforms */
	destroy(): void {
		this.#release();
		this.#uniforms.buffer.destroy();
		for (const uniform of this.#passUniforms) {
			uniform.buffer.destroy();
		}
	}
}
