/**
 * the game's screen-space sun shafts (`light-shafts.wgsl`), from the environment's `lightShaft` section: a
 * thresholded copy of the composited scene's far, bright pixels near the sun, at half the render size,
 * blurred towards the sun's position on screen in three passes of 12 samples (the game's PC presets) and
 * added onto the scene before temporal antialiasing. see `docs/game-data/post-processing.md#light-shafts`.
 *
 * @module
 */

import { HDR_FORMAT, type SceneTextures } from '../gfx/render-targets.ts';
import type { Camera, Vec3 } from '../scene/camera.ts';

import type { LightShaftLook } from './environment.ts';
import lightShaftsWgsl from './shaders/light-shafts.wgsl?raw';

/** byte size of `Shafts` in light-shafts.wgsl */
const UNIFORM_BYTES = 64;
/** the game's `lightShaftDownSampleFactor` at PC quality tiers 2000 and up */
const DOWNSAMPLE = 2;
/** the game's default `lightShaftSampleNum` */
const SAMPLES = 12;
/** the game's default `lightShaftBlurPassCount` */
const BLUR_PASSES = 3;

/**
 * @param camera the camera
 * @param aspect width / height
 * @param direction unit vector towards the sun
 * @returns the sun's position on screen (uv, 0 at the top-left), or `null` when it's behind the camera
 */
export const sunOnScreen = (camera: Camera, aspect: number, direction: Vec3): [number, number] | null => {
	const dot = (a: Vec3): number => a[0] * direction[0] + a[1] * direction[1] + a[2] * direction[2];
	const w = dot(camera.forward());
	if (w <= 0) {
		return null;
	}
	const f = 1 / Math.tan(camera.fovY / 2);
	const x = ((f / aspect) * dot(camera.right())) / w;
	const y = (f * dot(camera.up())) / w;
	return [x * 0.5 + 0.5, 0.5 - y * 0.5];
};

interface Pass {
	pipeline: GPURenderPipeline;
	groups: GPUBindGroup[];
	target: GPUTextureView;
}

interface Sized {
	width: number;
	height: number;
	textures: GPUTexture[];
	/** the downsample, then the blur passes, ping-ponging */
	passes: Pass[];
	/** adds the last blur onto the scene */
	apply: Pass;
}

/** owns the shafts' reduced-size targets and passes */
export class LightShafts {
	#device: GPUDevice;
	#uniforms: GPUBuffer;
	/** per blur pass: its index */
	#passUniforms: GPUBuffer[];
	#data = new Float32Array(UNIFORM_BYTES / 4);
	#sampler: GPUSampler;
	#pipelines: Record<'downsample' | 'blur' | 'apply', GPURenderPipeline>;
	#sized: Sized | null = null;

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.#device = device;
		this.#uniforms = device.createBuffer({
			label: 'light shaft uniforms',
			size: UNIFORM_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.#passUniforms = Array.from({ length: BLUR_PASSES }, (_, i) => {
			const buffer = device.createBuffer({
				label: `light shaft blur ${i}`,
				size: 16,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			});
			device.queue.writeBuffer(buffer, 0, new Float32Array([i, 0, 0, 0]));
			return buffer;
		});
		this.#sampler = device.createSampler({
			label: 'light shaft bilinear',
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'clamp-to-edge',
			addressModeV: 'clamp-to-edge',
		});
		const module = device.createShaderModule({ label: 'light shafts', code: lightShaftsWgsl });
		const pipeline = (label: string, entryPoint: string, target: GPUColorTargetState): GPURenderPipeline =>
			device.createRenderPipeline({
				label,
				layout: 'auto',
				vertex: { module, entryPoint: 'vs_fullscreen' },
				fragment: { module, entryPoint, targets: [target] },
				primitive: { topology: 'triangle-list' },
			});
		const add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
		this.#pipelines = {
			downsample: pipeline('light shaft downsample', 'fs_downsample', { format: HDR_FORMAT }),
			blur: pipeline('light shaft blur', 'fs_blur', { format: HDR_FORMAT }),
			// the game adds the colour only
			apply: pipeline('light shaft apply', 'fs_apply', {
				format: HDR_FORMAT,
				blend: { color: add, alpha: add },
				writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE,
			}),
		};
	}

	/** @returns bytes of the targets */
	get bytes(): number {
		const sized = this.#sized;
		return sized === null ? 0 : sized.width * sized.height * 8 * sized.textures.length;
	}

	/**
	 * (re)creates the targets for a new render size or inputs.
	 *
	 * @param input the main pass's textures, the composited scene (read, then added onto) and the render size
	 */
	resize(input: { scene: SceneTextures; composited: GPUTextureView; width: number; height: number }): void {
		this.#release();
		const device = this.#device;
		const p = this.#pipelines;
		const width = Math.max(1, Math.ceil(input.width / DOWNSAMPLE));
		const height = Math.max(1, Math.ceil(input.height / DOWNSAMPLE));
		const textures = [0, 1].map((i) =>
			device.createTexture({
				label: `light shafts ${i}`,
				size: [width, height],
				format: HDR_FORMAT,
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
			}),
		);
		const views = textures.map((texture) => texture.createView());
		const group = (pipeline: GPURenderPipeline, index: number, entries: Record<number, GPUBindingResource>) =>
			device.createBindGroup({
				layout: pipeline.getBindGroupLayout(index),
				entries: Object.entries(entries).map(([binding, resource]) => ({
					binding: Number(binding),
					resource,
				})),
			});
		const shared = (pipeline: GPURenderPipeline): GPUBindGroup =>
			group(pipeline, 0, { 0: { buffer: this.#uniforms }, 1: this.#sampler });
		const passes: Pass[] = [
			{
				pipeline: p.downsample,
				groups: [shared(p.downsample), group(p.downsample, 1, { 0: input.composited, 1: input.scene.depth })],
				target: views[0],
			},
		];
		for (let i = 0; i < BLUR_PASSES; i++) {
			passes.push({
				pipeline: p.blur,
				groups: [shared(p.blur), group(p.blur, 1, { 2: { buffer: this.#passUniforms[i] }, 3: views[i % 2] })],
				target: views[(i + 1) % 2],
			});
		}
		const apply: Pass = {
			pipeline: p.apply,
			// the apply reads no uniforms
			groups: [group(p.apply, 0, { 1: this.#sampler }), group(p.apply, 1, { 3: views[BLUR_PASSES % 2] })],
			target: input.composited,
		};
		this.#sized = { width, height, textures, passes, apply };
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
		const sun = sunOnScreen(camera, aspect, look.sunDirection);
		if (sun === null) {
			return;
		}
		const f = this.#data;
		f.set([1 / look.occlusionDepthRange, look.bloomScale, 0, look.maxBrightness], 0);
		f.set([...look.tint, look.threshold], 4);
		f.set([sun[0], sun[1], SAMPLES, look.blurIntensity], 8);
		f.set([camera.near, 0, 0, 0], 12);
		this.#device.queue.writeBuffer(this.#uniforms, 0, f);
		for (const pass of sized.passes) {
			this.#run(encoder, pass, 'clear');
		}
		this.#run(encoder, sized.apply, 'load');
	}

	#run(encoder: GPUCommandEncoder, pass: Pass, loadOp: GPULoadOp): void {
		const render = encoder.beginRenderPass({
			label: pass.pipeline.label,
			colorAttachments: [{ view: pass.target, loadOp, storeOp: 'store', clearValue: [0, 0, 0, 0] }],
		});
		render.setPipeline(pass.pipeline);
		pass.groups.forEach((group, i) => render.setBindGroup(i, group));
		render.draw(3);
		render.end();
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
		for (const buffer of this.#passUniforms) {
			buffer.destroy();
		}
	}
}
