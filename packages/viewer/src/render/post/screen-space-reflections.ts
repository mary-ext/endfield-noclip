import { type TgpuBindGroup, type TgpuRenderPipeline, type TgpuRoot, common, d } from 'typegpu';

import type { PostLook } from '../../environment/environment.ts';
import { createUniformBuffer } from '../../gfx/buffers.ts';
import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';
import { LINEAR_CLAMP, sampler } from '../../gfx/samplers.ts';
import { TextureSet } from '../../gfx/texture-set.ts';
import { type TgpuFullscreenPass, encodeTgpuFullscreen } from '../../gfx/tgpu-fullscreen.ts';
import type { Camera } from '../../scene/camera.ts';
import { CAMERA_HISTORY_FLOATS, CameraHistory } from '../core/camera-history.ts';
import { postUniformLayout } from '../core/post-schema.ts';
import { HDR_FORMAT, type SceneTextures } from '../core/render-targets.ts';

import {
	SsrSchema,
	fsSsrDownsample,
	fsSsrMarch,
	fsSsrResolve,
	fsSsrTemporal,
	ssrDownsampleLayout,
	ssrMarchLayout,
	ssrResolveLayout,
	ssrSharedLayout,
	ssrTemporalLayout,
} from './ssr-shader.ts';

/** byte size of {@link SsrSchema} */
const UNIFORM_BYTES = d.sizeOf(SsrSchema);
/** the render size over the passes' size: the game's PC high quality runs every pass at half size */
const DOWNSCALE = 2;
/** the game's `ssrRayMarchingSampleCount` at PC high quality */
const MARCH_STEPS = 32;
/** the game caps its colour pyramid at this many mips */
const MAX_MIPS = 7;
const COLOR_FORMAT: GPUTextureFormat = 'rgba16float';
const WEIGHT_FORMAT: GPUTextureFormat = 'rg16float';
const FADE_FORMAT: GPUTextureFormat = 'r8unorm';
/** view depth, which the pyramid's weights compare */
const DEPTH_FORMAT: GPUTextureFormat = 'r16float';

/** @returns a view of one mip of `source` */
const mip = (source: GPUTexture, level: number): GPUTextureView =>
	source.createView({ baseMipLevel: level, mipLevelCount: 1 });

interface Sized {
	width: number;
	height: number;
	/** resolved reflection radiance (rgb) and fade (a) at half size */
	output: GPUTexture;
	/** march passes, one per TAA history view */
	march: [TgpuFullscreenPass, TgpuFullscreenPass];
	/** per pyramid: the temporal filter into its finest mip (reading the other's), its coarser mips, the resolve */
	chains: [TgpuFullscreenPass[], TgpuFullscreenPass[]];
	clear: GPUTextureView;
}

/** half render size reflections; resolve outputs radiance (rgb) and fade (a) for the composite */
export class ScreenSpaceReflections {
	#root: TgpuRoot;
	#postGroup: TgpuBindGroup;
	#uniforms: GPUBuffer;
	#data = new Float32Array(UNIFORM_BYTES / 4);
	#sampler: GPUSampler;
	#pipelines: Record<'march' | 'temporal' | 'downsample' | 'resolve', AsyncPipeline<TgpuRenderPipeline>>;
	#targets: TextureSet;
	#sized: Sized | null = null;
	/** the camera of last frame's reflections, which held only if they ran over the current targets */
	#camera = new CameraHistory();

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache
	 * @param postUniforms the post chain's `Post` uniforms
	 */
	constructor(root: TgpuRoot, pipelines: PipelineCache, postUniforms: GPUBuffer) {
		this.#root = root;
		this.#postGroup = root.createBindGroup(postUniformLayout, { post: postUniforms });
		this.#uniforms = createUniformBuffer(root.device, 'ssr uniforms', UNIFORM_BYTES);
		this.#sampler = sampler(root.device, LINEAR_CLAMP);
		this.#targets = new TextureSet(root.device);
		this.#pipelines = {
			march: pipelines.prepareTgpuRender('ssr march', () =>
				root.createRenderPipeline({
					vertex: common.fullScreenTriangle,
					fragment: fsSsrMarch,
					targets: {
						color: { format: COLOR_FORMAT },
						weight: { format: WEIGHT_FORMAT },
						fade: { format: FADE_FORMAT },
						depth: { format: DEPTH_FORMAT },
					},
				}),
			),
			temporal: pipelines.prepareTgpuRender('ssr temporal', () =>
				root.createRenderPipeline({
					vertex: common.fullScreenTriangle,
					fragment: fsSsrTemporal,
					targets: { format: COLOR_FORMAT },
				}),
			),
			downsample: pipelines.prepareTgpuRender('ssr downsample', () =>
				root.createRenderPipeline({
					vertex: common.fullScreenTriangle,
					fragment: fsSsrDownsample,
					targets: {
						color: { format: COLOR_FORMAT },
						depth: { format: DEPTH_FORMAT },
					},
				}),
			),
			resolve: pipelines.prepareTgpuRender('ssr resolve', () =>
				root.createRenderPipeline({
					vertex: common.fullScreenTriangle,
					fragment: fsSsrResolve,
					targets: { format: HDR_FORMAT },
				}),
			),
		};
	}

	#ensureSized(): Sized {
		if (this.#sized === null) {
			throw new Error('screen-space reflections used before resize()');
		}
		return this.#sized;
	}

	/** @returns what the reflections change in the radiance, at half the render size; valid after {@link resize} */
	get output(): GPUTexture {
		return this.#ensureSized().output;
	}

	/** @returns bytes of the targets */
	get bytes(): number {
		return this.#targets.bytes;
	}

	/** drops the history, so the next frame doesn't read the last (a cut) */
	reset(): void {
		this.#camera.reset();
	}

	/**
	 * (re)creates the targets for new sizes or inputs; the history starts afresh.
	 *
	 * @param input the main pass's textures, the two antialiased scene histories hits read, and the render size
	 */
	resize(input: {
		scene: SceneTextures;
		previousScenes: readonly [GPUTextureView, GPUTextureView];
		width: number;
		height: number;
	}): void {
		this.#release();
		const { scene, previousScenes } = input;
		const width = Math.max(1, Math.ceil(input.width / DOWNSCALE));
		const height = Math.max(1, Math.ceil(input.height / DOWNSCALE));
		const root = this.#root;
		const p = this.#pipelines;
		const mips = Math.max(
			2,
			Math.min(MAX_MIPS, Math.floor(Math.log2(Math.max(1, Math.min(width, height)))) + 1),
		);
		const texture = (label: string, format: GPUTextureFormat, mipLevelCount = 1): GPUTexture =>
			this.#targets.create({ label, size: [width, height], format, mipLevelCount });
		const marchColor = texture('ssr march colour', COLOR_FORMAT);
		const marchWeight = texture('ssr march weight', WEIGHT_FORMAT);
		const marchFade = texture('ssr march fade', FADE_FORMAT);
		const depthPyramid = texture('ssr depth pyramid', DEPTH_FORMAT, mips);
		const pyramids = [
			texture('ssr pyramid 0', COLOR_FORMAT, mips),
			texture('ssr pyramid 1', COLOR_FORMAT, mips),
		];
		// the march's colour is done with once the temporal filter has read it, so the resolve writes over it
		const output = marchColor;

		const sharedGroup = root.createBindGroup(ssrSharedLayout, {
			ssr: this.#uniforms,
			depth: scene.depth,
			linearSampler: this.#sampler,
		});

		const makeMarch = (previousScene: GPUTextureView): TgpuFullscreenPass => ({
			label: 'ssr march',
			pipeline: p.march,
			groups: [
				this.#postGroup,
				sharedGroup,
				root.createBindGroup(ssrMarchLayout, {
					gbufferB: scene.gbufferB,
					previousScene,
					velocity: scene.velocity,
				}),
			],
			targets: [
				marchColor.createView(),
				marchWeight.createView(),
				marchFade.createView(),
				mip(depthPyramid, 0),
			],
		});
		const march: [TgpuFullscreenPass, TgpuFullscreenPass] = [
			makeMarch(previousScenes[0]),
			makeMarch(previousScenes[1]),
		];
		const chain = (i: number): TgpuFullscreenPass[] => {
			const pyramid = pyramids[i];
			const marchColorView = marchColor.createView();
			const marchWeightView = marchWeight.createView();
			const marchFadeView = marchFade.createView();
			const prevMip0 = mip(pyramids[1 - i], 0);
			const passes: TgpuFullscreenPass[] = [
				{
					label: 'ssr temporal',
					pipeline: p.temporal,
					groups: [
						this.#postGroup,
						sharedGroup,
						root.createBindGroup(ssrTemporalLayout, {
							marchColor: marchColorView,
							marchWeight: marchWeightView,
							marchFade: marchFadeView,
							history: prevMip0,
							velocity: scene.velocity,
						}),
					],
					target: mip(pyramid, 0),
				},
			];
			for (let level = 1; level < mips; level++) {
				const prevColor = mip(pyramid, level - 1);
				const prevDepth = mip(depthPyramid, level - 1);
				passes.push({
					label: 'ssr downsample',
					pipeline: p.downsample,
					groups: [
						root.createBindGroup(ssrDownsampleLayout, {
							finePyramid: prevColor,
							fineDepth: prevDepth,
						}),
					],
					targets: [mip(pyramid, level), mip(depthPyramid, level)],
				});
			}
			const pyramidView = pyramid.createView();
			const depthPyramidView = depthPyramid.createView();
			passes.push({
				label: 'ssr resolve',
				pipeline: p.resolve,
				groups: [
					this.#postGroup,
					sharedGroup,
					root.createBindGroup(ssrResolveLayout, {
						marchWeight: marchWeightView,
						pyramid: pyramidView,
						depthPyramid: depthPyramidView,
					}),
				],
				target: output.createView(),
			});
			return passes;
		};
		this.#sized = {
			width,
			height,
			output,
			march,
			chains: [chain(0), chain(1)],
			clear: output.createView(),
		};
		// `march.y`: the coarsest mip
		this.#data[25] = mips - 1;
		this.#data.set([width, height, 1 / width, 1 / height], 28);
		this.#camera.reset();
	}

	/**
	 * encodes this frame's reflections into {@link output}, or clears it while they're off.
	 *
	 * @param encoder this frame's encoder, after the main pass and before compositing
	 * @param input the camera (unjittered), the level's reflection look (`null`: the level has none), whether
	 *   the view shows them, and which TAA history holds last frame's scene
	 */
	encode(
		encoder: GPUCommandEncoder,
		input: { camera: Camera; look: PostLook['ssr']; enabled: boolean; previousScene: number },
	): void {
		const sized = this.#ensureSized();
		const { camera, look, enabled, previousScene } = input;
		if (!enabled || look === null) {
			const pass = encoder.beginRenderPass({
				label: 'ssr off',
				colorAttachments: [
					{ view: sized.clear, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
				],
			});
			pass.end();
			this.#camera.reset();
			return;
		}
		const f = this.#data;
		this.#camera.write(f, camera, sized.width / sized.height);
		f.set([look.onScreen, look.mirrorMul, look.mirrorAdd, 0], CAMERA_HISTORY_FLOATS);
		f[CAMERA_HISTORY_FLOATS + 4] = MARCH_STEPS;
		this.#root.device.queue.writeBuffer(this.#uniforms, 0, f);
		encodeTgpuFullscreen(encoder, sized.march[previousScene]);
		for (const pass of sized.chains[this.#camera.index]) {
			encodeTgpuFullscreen(encoder, pass);
		}
		this.#camera.advance();
	}

	#release(): void {
		this.#targets.destroy();
		this.#sized = null;
	}

	/** frees the targets and the uniforms */
	destroy(): void {
		this.#release();
		this.#uniforms.destroy();
	}
}
