import {
	type TgpuBindGroup,
	type TgpuRenderPipeline,
	type TgpuRoot,
	type TgpuUniform,
	common,
	d,
} from 'typegpu';

import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';
import { TextureSet } from '../../gfx/texture-set.ts';
import { type TgpuFullscreenPass, encodeTgpuFullscreen } from '../../gfx/tgpu-fullscreen.ts';
import { HDR_FORMAT } from '../frame/render-targets.ts';

import {
	BloomPassSchema,
	bloomPassLayout,
	bloomUpLayout,
	fsBloomBlurH,
	fsBloomBlurV,
	fsBloomPrefilter,
	fsBloomUp,
} from './bloom-shader.ts';
import { postUniformLayout } from './post-schema.ts';

/** the game's cap on bloom levels */
const BLOOM_MAX_LEVELS = 16;
/** the game sizes the bloom chain as if the view were at most this many pixels tall */
const BLOOM_REFERENCE_HEIGHT = 1080;

/**
 * @param width the chain's reference width (px)
 * @param height the chain's reference height (px)
 * @param half whether the profile asks for half-resolution bloom
 * @returns how many levels the game's bloom chain has
 */
const bloomLevelCount = (width: number, height: number, half: boolean): number => {
	const levels = Math.floor(Math.log2(Math.max(width, height)) - 2 - (half ? 0 : 1));
	return Math.min(Math.max(levels, 1), BLOOM_MAX_LEVELS);
};

interface Sized {
	uniforms: TgpuUniform<typeof BloomPassSchema>[];
	/** the last upsample, or the only level, or `null` on a canvas too small for bloom */
	result: GPUTexture | null;
	/** the prefilter from each temporal history, or `null` on a canvas too small for bloom */
	prefilter: [TgpuFullscreenPass, TgpuFullscreenPass] | null;
	/** two blurs per level after the first */
	down: TgpuFullscreenPass[];
	/** upsamples from the coarsest level, for the full chain and for one level fewer */
	up: { full: TgpuFullscreenPass[]; short: TgpuFullscreenPass[] };
}

/** the game's bloom chain (bloom-shader.ts) at the output size */
export class Bloom {
	#root: TgpuRoot;
	#sampler: GPUSampler;
	#postGroup: TgpuBindGroup;
	#pipelines: Record<'prefilter' | 'blurH' | 'blurV' | 'up', AsyncPipeline<TgpuRenderPipeline>>;
	#targets: TextureSet;
	#sized: Sized | null = null;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 * @param postUniforms the post chain's `Post` uniforms
	 * @param sampler the bilinear clamping sampler the levels are read with
	 */
	constructor(root: TgpuRoot, pipelines: PipelineCache, postUniforms: GPUBuffer, sampler: GPUSampler) {
		this.#root = root;
		this.#targets = new TextureSet(root.device);
		this.#sampler = sampler;
		this.#postGroup = root.createBindGroup(postUniformLayout, {
			post: postUniforms,
		});
		const make = (label: string, fragment: typeof fsBloomPrefilter): AsyncPipeline<TgpuRenderPipeline> =>
			pipelines.prepareTgpuRender(label, () =>
				root.createRenderPipeline({
					vertex: common.fullScreenTriangle,
					fragment,
					targets: { format: HDR_FORMAT },
				}),
			);
		this.#pipelines = {
			prefilter: make('bloom prefilter', fsBloomPrefilter),
			blurH: make('bloom blur h', fsBloomBlurH),
			blurV: make('bloom blur v', fsBloomBlurV),
			up: make('bloom up', fsBloomUp),
		};
	}

	#ensureSized(): Sized {
		if (this.#sized === null) {
			throw new Error('bloom used before resize()');
		}
		return this.#sized;
	}

	/** @returns the bloom the tonemap adds, or `null` on a canvas too small for it; valid after {@link resize} */
	get result(): GPUTexture | null {
		return this.#ensureSized().result;
	}

	/** @returns bytes of the levels */
	get bytes(): number {
		return this.#targets.bytes;
	}

	/**
	 * (re)creates the levels for a new output size or histories. the game's chain is sized as if the view were
	 * at most 1080 px tall, its first level at half that size, with as many levels as half-resolution bloom
	 * gets (quarter resolution runs one fewer)
	 *
	 * @param input the temporal histories the prefilter reads, and the output size
	 */
	resize(input: { histories: readonly GPUTexture[]; outputWidth: number; outputHeight: number }): void {
		this.#release();
		const { histories, outputWidth, outputHeight } = input;
		const root = this.#root;
		const p = this.#pipelines;
		const texture = (label: string, w: number, h: number): GPUTexture =>
			this.#targets.create({
				label,
				size: [w, h],
				format: HDR_FORMAT,
				usage:
					GPUTextureUsage.RENDER_ATTACHMENT |
					GPUTextureUsage.TEXTURE_BINDING |
					GPUTextureUsage.COPY_SRC |
					GPUTextureUsage.COPY_DST,
			});
		const down: GPUTexture[] = [];
		const blurred: GPUTexture[] = [];
		const up: GPUTexture[] = [];
		{
			const scale = outputHeight > BLOOM_REFERENCE_HEIGHT ? BLOOM_REFERENCE_HEIGHT / outputHeight : 1;
			const count = bloomLevelCount(outputWidth * scale, outputHeight * scale, true);
			for (let i = 0; i < count; i++) {
				const w = Math.max(1, Math.round((outputWidth * scale) / 2 ** (i + 1)));
				const h = Math.max(1, Math.round((outputHeight * scale) / 2 ** (i + 1)));
				down.push(texture(`bloom down ${i}`, w, h));
				up.push(texture(`bloom up ${i}`, w, h));
				if (i > 0) {
					blurred.push(texture(`bloom blurred ${i}`, w, h));
				}
			}
		}
		const uniforms: TgpuUniform<typeof BloomPassSchema>[] = [];
		const pass = (descriptor: {
			label: string;
			pipeline: AsyncPipeline<TgpuRenderPipeline>;
			source: GPUTexture;
			/** upsamples: the matching level of the downsample chain */
			high: GPUTexture | null;
			target: GPUTexture;
		}): TgpuFullscreenPass => {
			const { label, pipeline, source, high, target } = descriptor;
			const passInfo = root.createUniform(BloomPassSchema, {
				texel: d.vec2f(1 / source.width, 1 / source.height),
				lowSize: d.vec2f(source.width, source.height),
			});
			uniforms.push(passInfo);
			const passGroup = root.createBindGroup(bloomPassLayout, {
				source: source.createView(),
				bilinear: this.#sampler,
				passInfo,
			});
			const groups: TgpuBindGroup[] = [passGroup];
			if (pipeline === p.prefilter || pipeline === p.up) {
				groups.push(this.#postGroup);
			}
			if (high !== null) {
				groups.push(root.createBindGroup(bloomUpLayout, { high: high.createView() }));
			}
			return {
				label,
				pipeline,
				groups,
				target: target.createView(),
			};
		};
		let prefilter: [TgpuFullscreenPass, TgpuFullscreenPass] | null = null;
		if (down.length > 0) {
			const from = (history: GPUTexture): TgpuFullscreenPass =>
				pass({ label: 'bloom down', pipeline: p.prefilter, source: history, high: null, target: down[0] });
			prefilter = [from(histories[0]), from(histories[1])];
		}
		const downPasses: TgpuFullscreenPass[] = [];
		for (let i = 1; i < down.length; i++) {
			const temp = blurred[i - 1];
			downPasses.push(
				pass({ label: 'bloom down', pipeline: p.blurH, source: down[i - 1], high: null, target: temp }),
				pass({ label: 'bloom down', pipeline: p.blurV, source: temp, high: null, target: down[i] }),
			);
		}
		const upPasses = (count: number): TgpuFullscreenPass[] => {
			const passes: TgpuFullscreenPass[] = [];
			for (let i = count - 2; i >= 0; i--) {
				const low = i === count - 2 ? down[i + 1] : up[i + 1];
				passes.push(pass({ label: 'bloom up', pipeline: p.up, source: low, high: down[i], target: up[i] }));
			}
			return passes;
		};
		const full = upPasses(down.length);
		let result: GPUTexture | null = null;
		if (down.length > 1) {
			result = up[0];
		} else if (down.length === 1) {
			result = down[0];
		}
		this.#sized = {
			uniforms,
			result,
			prefilter,
			down: downPasses,
			up: { full, short: down.length > 2 ? upPasses(down.length - 1) : full },
		};
	}

	/**
	 * encodes the chain from one temporal history into {@link result}; nothing on a canvas too small for it.
	 *
	 * @param encoder this frame's encoder, after the temporal resolve
	 * @param input which history this frame's resolve wrote, and whether the profile asks for half-resolution
	 *   bloom (quarter resolution upsamples one level fewer)
	 */
	encode(encoder: GPUCommandEncoder, input: { history: number; half: boolean }): void {
		const sized = this.#ensureSized();
		if (sized.prefilter === null) {
			return;
		}
		encodeTgpuFullscreen(encoder, sized.prefilter[input.history]);
		for (const pass of sized.down) {
			encodeTgpuFullscreen(encoder, pass);
		}
		for (const pass of input.half ? sized.up.full : sized.up.short) {
			encodeTgpuFullscreen(encoder, pass);
		}
	}

	#release(): void {
		this.#targets.destroy();
		for (const uniform of this.#sized?.uniforms ?? []) {
			uniform.buffer.destroy();
		}
		this.#sized = null;
	}

	/** frees the levels */
	destroy(): void {
		this.#release();
	}
}
