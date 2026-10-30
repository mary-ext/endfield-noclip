/**
 * the game's screen-space reflections (`ssr.wgsl`): each lit pixel marches its mirror ray into last frame's
 * composited scene, the hits are filtered over frames, built into a depth-aware pyramid and resolved at the
 * mip the reflected cone covers. the result is what the reflections change in the radiance, which the
 * composite adds. it all runs at the render size, before compositing.
 *
 * @module
 */

import { HDR_FORMAT, type SceneTextures } from '../gfx/render-targets.ts';
import type { Camera, Vec3 } from '../scene/camera.ts';

import type { PostLook } from './environment.ts';

/** byte size of `Ssr` in ssr.wgsl */
const UNIFORM_BYTES = 112;
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

interface Pass {
	pipeline: GPURenderPipeline;
	groups: GPUBindGroup[];
	targets: GPUTextureView[];
}

interface Sized {
	width: number;
	height: number;
	textures: GPUTexture[];
	/** what the reflections change in the radiance */
	output: GPUTexture;
	march: Pass;
	/** per pyramid: the temporal filter into its finest mip (reading the other's), its coarser mips, the resolve */
	chains: [Pass[], Pass[]];
	clear: GPUTextureView;
}

/** owns the reflections' targets, history and passes */
export class ScreenSpaceReflections {
	#device: GPUDevice;
	#postUniforms: GPUBuffer;
	#uniforms: GPUBuffer;
	#data = new Float32Array(UNIFORM_BYTES / 4);
	#sampler: GPUSampler;
	#pipelines: Record<'march' | 'temporal' | 'downsample' | 'resolve', GPURenderPipeline>;
	#sized: Sized | null = null;
	/** which pyramid this frame writes */
	#index = 0;
	/** whether last frame ran the reflections over the current targets, so its history and camera hold */
	#valid = false;
	#viewProj = new Float32Array(16);
	#previousViewProj = new Float32Array(16);
	#previousEye: Vec3 = [0, 0, 0];

	/**
	 * @param device the device
	 * @param module ssr.wgsl, built with the post chain's shared sources
	 * @param postUniforms the post chain's `Post` uniforms
	 */
	constructor(device: GPUDevice, module: GPUShaderModule, postUniforms: GPUBuffer) {
		this.#device = device;
		this.#postUniforms = postUniforms;
		this.#uniforms = device.createBuffer({
			label: 'ssr uniforms',
			size: UNIFORM_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.#sampler = device.createSampler({
			label: 'ssr bilinear',
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge',
		});
		const pipeline = (label: string, entryPoint: string, formats: GPUTextureFormat[]): GPURenderPipeline =>
			device.createRenderPipeline({
				label,
				layout: 'auto',
				vertex: { module, entryPoint: 'vs_fullscreen' },
				fragment: { module, entryPoint, targets: formats.map((format) => ({ format })) },
				primitive: { topology: 'triangle-list' },
			});
		this.#pipelines = {
			march: pipeline('ssr march', 'fs_march', [COLOR_FORMAT, WEIGHT_FORMAT, FADE_FORMAT, DEPTH_FORMAT]),
			temporal: pipeline('ssr temporal', 'fs_temporal', [COLOR_FORMAT]),
			downsample: pipeline('ssr downsample', 'fs_downsample', [COLOR_FORMAT, DEPTH_FORMAT]),
			resolve: pipeline('ssr resolve', 'fs_resolve', [HDR_FORMAT]),
		};
	}

	/** @returns what the reflections change in the radiance, at the render size; valid after {@link resize} */
	get output(): GPUTexture {
		if (this.#sized === null) {
			throw new Error('screen-space reflections used before resize()');
		}
		return this.#sized.output;
	}

	/** @returns bytes of the targets */
	get bytes(): number {
		const sized = this.#sized;
		if (sized === null) {
			return 0;
		}
		// march colour, weight and fade, two colour pyramids and a depth pyramid (a third more for their mips), output
		return sized.width * sized.height * (8 + 4 + 1 + (8 * 2 + 2) * (4 / 3) + 8);
	}

	/** drops the history, so the next frame doesn't read the last (a cut) */
	reset(): void {
		this.#valid = false;
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
		const { scene, previousScene, width, height } = input;
		const device = this.#device;
		const p = this.#pipelines;
		const mips = Math.max(
			2,
			Math.min(MAX_MIPS, Math.floor(Math.log2(Math.max(1, Math.min(width, height)))) + 1),
		);
		const textures: GPUTexture[] = [];
		const texture = (label: string, format: GPUTextureFormat, mipLevelCount = 1): GPUTexture => {
			const created = device.createTexture({
				label,
				size: [width, height],
				format,
				mipLevelCount,
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			});
			textures.push(created);
			return created;
		};
		const marchColor = texture('ssr march colour', COLOR_FORMAT);
		const marchWeight = texture('ssr march weight', WEIGHT_FORMAT);
		const marchFade = texture('ssr march fade', FADE_FORMAT);
		const depthPyramid = texture('ssr depth pyramid', DEPTH_FORMAT, mips);
		const pyramids = [
			texture('ssr pyramid 0', COLOR_FORMAT, mips),
			texture('ssr pyramid 1', COLOR_FORMAT, mips),
		];
		const output = texture('ssr', HDR_FORMAT);

		const group = (pipeline: GPURenderPipeline, index: number, entries: Record<number, GPUBindingResource>) =>
			device.createBindGroup({
				layout: pipeline.getBindGroupLayout(index),
				entries: Object.entries(entries).map(([binding, resource]) => ({
					binding: Number(binding),
					resource,
				})),
			});
		const postGroup = (pipeline: GPURenderPipeline) =>
			group(pipeline, 0, { 0: { buffer: this.#postUniforms } });
		const ssr = { buffer: this.#uniforms };

		const march: Pass = {
			pipeline: p.march,
			groups: [
				postGroup(p.march),
				group(p.march, 1, {
					0: ssr,
					1: scene.depth,
					2: scene.reflectionSurface,
					3: previousScene,
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
		const chain = (i: number): Pass[] => {
			const pyramid = pyramids[i];
			const passes: Pass[] = [
				{
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
					}),
				],
				targets: [output.createView()],
			});
			return passes;
		};
		this.#sized = {
			width,
			height,
			textures,
			output,
			march,
			chains: [chain(0), chain(1)],
			clear: output.createView(),
		};
		// `march.y`: the coarsest mip
		this.#data[25] = mips - 1;
		this.#valid = false;
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
		const sized = this.#sized;
		if (sized === null) {
			throw new Error('screen-space reflections used before resize()');
		}
		const { camera, look, enabled } = input;
		if (!enabled || look === null) {
			const pass = encoder.beginRenderPass({
				label: 'ssr off',
				colorAttachments: [
					{ view: sized.clear, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
				],
			});
			pass.end();
			this.#valid = false;
			return;
		}
		camera.writeViewProjection(sized.width / sized.height, this.#viewProj);
		const eye = camera.position;
		const f = this.#data;
		f.set(this.#previousViewProj, 0);
		f.set([eye[0] - this.#previousEye[0], eye[1] - this.#previousEye[1], eye[2] - this.#previousEye[2]], 16);
		f[19] = this.#valid ? 0 : 1;
		f.set([look.onScreen, look.mirrorMul, look.mirrorAdd, 0], 20);
		f[24] = MARCH_STEPS;
		this.#device.queue.writeBuffer(this.#uniforms, 0, f);

		for (const pass of [sized.march, ...sized.chains[this.#index]]) {
			const render = encoder.beginRenderPass({
				label: pass.pipeline.label,
				colorAttachments: pass.targets.map((view) => ({
					view,
					loadOp: 'clear',
					storeOp: 'store',
					clearValue: [0, 0, 0, 0],
				})),
			});
			render.setPipeline(pass.pipeline);
			pass.groups.forEach((group, i) => render.setBindGroup(i, group));
			render.draw(3);
			render.end();
		}

		this.#previousViewProj.set(this.#viewProj);
		this.#previousEye = [eye[0], eye[1], eye[2]];
		this.#valid = true;
		this.#index = 1 - this.#index;
	}

	#release(): void {
		for (const texture of this.#sized?.textures ?? []) {
			texture.destroy();
		}
		this.#sized = null;
	}

	/** frees the targets and the uniforms */
	destroy(): void {
		this.#release();
		this.#uniforms.destroy();
	}
}
