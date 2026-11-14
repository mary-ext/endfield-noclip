import type { PostLook } from '../../environment/environment.ts';
import { createUniformBuffer } from '../../gfx/buffers.ts';
import {
	type FullscreenPass,
	autoBindGroup,
	encodeFullscreen,
	fullscreenPipeline,
} from '../../gfx/fullscreen-pass.ts';
import { LINEAR_CLAMP, sampler } from '../../gfx/samplers.ts';
import { TextureSet } from '../../gfx/texture-set.ts';
import type { Camera } from '../../scene/camera.ts';
import { HDR_FORMAT, type SceneTextures } from '../frame/render-targets.ts';
import colorWgsl from '../shaders/common/color.wgsl?raw';
import octahedralWgsl from '../shaders/common/octahedral.wgsl?raw';
import reflectionSurfaceWgsl from '../shaders/common/reflection-surface.wgsl?raw';
import screenSpaceWgsl from '../shaders/common/screen-space.wgsl?raw';

import { CAMERA_HISTORY_FLOATS, CameraHistory } from './camera-history.ts';
import { postShaderModule } from './shader-source.ts';
import ssrWgsl from './ssr.wgsl?raw';

/** byte size of `Ssr` in ssr.wgsl */
const UNIFORM_BYTES = 128;
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
	/** what the reflections change in the radiance */
	output: GPUTexture;
	march: FullscreenPass;
	/** per pyramid: the temporal filter into its finest mip (reading the other's), its coarser mips, the resolve */
	chains: [FullscreenPass[], FullscreenPass[]];
	clear: GPUTextureView;
}

/** half render size reflections; resolve outputs a radiance delta the composite upsamples and adds */
export class ScreenSpaceReflections {
	#device: GPUDevice;
	#postUniforms: GPUBuffer;
	#uniforms: GPUBuffer;
	#data = new Float32Array(UNIFORM_BYTES / 4);
	#sampler: GPUSampler;
	#pipelines: Record<'march' | 'temporal' | 'downsample' | 'resolve', GPURenderPipeline>;
	#targets: TextureSet;
	#sized: Sized | null = null;
	/** the camera of last frame's reflections, which held only if they ran over the current targets */
	#camera = new CameraHistory();

	/**
	 * @param device the device
	 * @param postUniforms the post chain's `Post` uniforms
	 */
	constructor(device: GPUDevice, postUniforms: GPUBuffer) {
		this.#device = device;
		this.#postUniforms = postUniforms;
		this.#uniforms = createUniformBuffer(device, 'ssr uniforms', UNIFORM_BYTES);
		this.#sampler = sampler(device, LINEAR_CLAMP);
		this.#targets = new TextureSet(device);
		const module = postShaderModule(device, 'ssr', [
			colorWgsl,
			screenSpaceWgsl,
			octahedralWgsl,
			reflectionSurfaceWgsl,
			ssrWgsl,
		]);
		const pipeline = (label: string, entryPoint: string, formats: GPUTextureFormat[]): GPURenderPipeline =>
			fullscreenPipeline(device, {
				label,
				module,
				entryPoint,
				targets: formats.map((format) => ({ format })),
			});
		this.#pipelines = {
			march: pipeline('ssr march', 'fs_march', [COLOR_FORMAT, WEIGHT_FORMAT, FADE_FORMAT, DEPTH_FORMAT]),
			temporal: pipeline('ssr temporal', 'fs_temporal', [COLOR_FORMAT]),
			downsample: pipeline('ssr downsample', 'fs_downsample', [COLOR_FORMAT, DEPTH_FORMAT]),
			resolve: pipeline('ssr resolve', 'fs_resolve', [HDR_FORMAT]),
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
	 * @param input the main pass's textures, the composited scene the next frame's hits read, and the render
	 *   size
	 */
	resize(input: {
		scene: SceneTextures;
		previousScene: GPUTextureView;
		width: number;
		height: number;
	}): void {
		this.#release();
		const { scene, previousScene } = input;
		const width = Math.max(1, Math.ceil(input.width / DOWNSCALE));
		const height = Math.max(1, Math.ceil(input.height / DOWNSCALE));
		const device = this.#device;
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

		const group = (pipeline: GPURenderPipeline, index: number, entries: Record<number, GPUBindingResource>) =>
			autoBindGroup(device, pipeline, index, entries);
		const postGroup = (pipeline: GPURenderPipeline) =>
			group(pipeline, 0, { 0: { buffer: this.#postUniforms } });
		const ssr = { buffer: this.#uniforms };

		const march: FullscreenPass = {
			label: 'ssr march',
			pipeline: p.march,
			groups: [
				postGroup(p.march),
				group(p.march, 1, {
					0: ssr,
					1: scene.depth,
					2: scene.reflectionSurface,
					3: previousScene,
					14: scene.decalSurface,
					4: this.#sampler,
				}),
			],
			targets: [
				marchColor.createView(),
				marchWeight.createView(),
				marchFade.createView(),
				mip(depthPyramid, 0),
			],
		};
		const chain = (i: number): FullscreenPass[] => {
			const pyramid = pyramids[i];
			const passes: FullscreenPass[] = [
				{
					label: 'ssr temporal',
					pipeline: p.temporal,
					groups: [
						postGroup(p.temporal),
						group(p.temporal, 1, {
							0: ssr,
							1: scene.depth,
							4: this.#sampler,
							5: marchColor.createView(),
							6: marchWeight.createView(),
							7: marchFade.createView(),
							8: mip(pyramids[1 - i], 0),
						}),
					],
					targets: [mip(pyramid, 0)],
				},
			];
			for (let level = 1; level < mips; level++) {
				passes.push({
					label: 'ssr downsample',
					pipeline: p.downsample,
					// the downsample reads no uniforms, so its group 0 is empty
					groups: [
						group(p.downsample, 0, {}),
						group(p.downsample, 1, { 9: mip(pyramid, level - 1), 10: mip(depthPyramid, level - 1) }),
					],
					targets: [mip(pyramid, level), mip(depthPyramid, level)],
				});
			}
			passes.push({
				label: 'ssr resolve',
				pipeline: p.resolve,
				groups: [
					postGroup(p.resolve),
					group(p.resolve, 1, {
						0: ssr,
						1: scene.depth,
						2: scene.reflectionSurface,
						4: this.#sampler,
						6: marchWeight.createView(),
						11: pyramid.createView(),
						12: depthPyramid.createView(),
						13: scene.reflection,
						14: scene.decalSurface,
					}),
				],
				targets: [output.createView()],
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
	 * @param input the camera (unjittered), the level's reflection look (`null`: the level has none) and
	 *   whether the view shows them
	 */
	encode(
		encoder: GPUCommandEncoder,
		input: { camera: Camera; look: PostLook['ssr']; enabled: boolean },
	): void {
		const sized = this.#ensureSized();
		const { camera, look, enabled } = input;
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
		this.#device.queue.writeBuffer(this.#uniforms, 0, f);
		for (const pass of [sized.march, ...sized.chains[this.#camera.index]]) {
			encodeFullscreen(encoder, pass);
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
