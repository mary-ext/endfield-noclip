/**
 * the game's froxel volumetric fog: a compute pass lights and integrates a grid over the view each frame, and
 * the composite and water passes add it in front of the height fog (see shaders/sky.wgsl).
 *
 * @module
 */

import type { Camera } from '../scene/camera.ts';

import type { Environment, VolumetricFog as VolumetricFogLook } from './environment.ts';
import { FRAME_WGSL } from './frame-uniforms.ts';
import fogWgsl from './shaders/volumetric-fog.wgsl?raw';

/**
 * froxels across, down and in depth. the game sizes its grid from the view in cells of at least a set number
 * of pixels, capped at a source size, so large views get a near-constant grid; these values and the depth
 * distribution are Unreal's defaults, since the game's quality presets aren't recovered
 */
const GRID: readonly [number, number, number] = [160, 90, 64];
/** slices per doubling of depth past the first */
const DEPTH_DISTRIBUTION_SCALE = 32;
/** the game starts the first slice this far past the near plane or start distance */
const NEAR_OFFSET = 0.095;
/** byte size of `VolumetricFog` in volumetric-fog.wgsl */
const UNIFORM_BYTES = 12 * 16;
const WORKGROUP = 8;

/** how a view depth maps onto the grid's slices: `s = log2(z · scale + offset) · perDoubling` */
interface Slices {
	scale: number;
	offset: number;
	near: number;
}

/**
 * @param near view depth (m) of the first slice's near edge
 * @param far view depth (m) of the last slice
 * @returns the slice mapping, as the game's `GetVolumetricFogGridZParams` builds it
 */
const sliceMapping = (near: number, far: number): Slices => {
	const offset = (far - near * 2 ** ((GRID[2] - 1) / DEPTH_DISTRIBUTION_SCALE)) / (far - near);
	return { scale: (1 - offset) / near, offset, near };
};

/** owns the froxel grid, its compute pipeline and uniforms */
export class VolumetricFog {
	/** the integrated fog: scattered light (rgb) and transmittance (a) up to each slice */
	readonly view: GPUTextureView;
	#device: GPUDevice;
	#texture: GPUTexture;
	#uniforms: GPUBuffer;
	#data = new Float32Array(UNIFORM_BYTES / 4);
	#group: GPUBindGroup;
	#pipeline: GPUComputePipeline | null = null;
	#look: VolumetricFogLook | null = null;
	#slices: Slices | null = null;

	/**
	 * @param device the device
	 * @param frameLayout the shared frame layout (group 0), for the sun's shadow and the ambient probe
	 */
	constructor(device: GPUDevice, frameLayout: GPUBindGroupLayout) {
		this.#device = device;
		this.#texture = device.createTexture({
			label: 'volumetric fog',
			size: [...GRID],
			dimension: '3d',
			format: 'rgba16float',
			usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
		});
		this.view = this.#texture.createView();
		this.#uniforms = device.createBuffer({
			label: 'volumetric fog uniforms',
			size: UNIFORM_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		const layout = device.createBindGroupLayout({
			label: 'volumetric fog',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
				{
					binding: 1,
					visibility: GPUShaderStage.COMPUTE,
					storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' },
				},
			],
		});
		this.#group = device.createBindGroup({
			layout,
			entries: [
				{ binding: 0, resource: { buffer: this.#uniforms } },
				{ binding: 1, resource: this.view },
			],
		});
		void device
			.createComputePipelineAsync({
				label: 'volumetric fog',
				layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, layout] }),
				compute: {
					module: device.createShaderModule({ label: 'volumetric fog', code: FRAME_WGSL + fogWgsl }),
					entryPoint: 'cs_froxels',
				},
			})
			.then((pipeline) => {
				this.#pipeline = pipeline;
			});
	}

	/** @returns bytes of the grid */
	get bytes(): number {
		return GRID[0] * GRID[1] * GRID[2] * 8;
	}

	/**
	 * @param environment the environment at the camera
	 * @param near the camera's near plane (m)
	 */
	setEnvironment(environment: Environment, near: number): void {
		const look = environment.volumetricFog;
		this.#look = look;
		this.#slices = null;
		if (look === null) {
			return;
		}
		const first = Math.max(near, look.startDistance) + NEAR_OFFSET;
		if (look.distance <= first) {
			return;
		}
		this.#slices = sliceMapping(first, look.distance);
		const f = this.#data;
		const set = (at: number, values: readonly number[]): void => {
			f.set(values, at * 4);
		};
		const slices = this.#slices;
		set(4, [slices.scale, slices.offset, DEPTH_DISTRIBUTION_SCALE, GRID[2]]);
		set(5, [first, look.nearFadeIn > 0 ? 1 / look.nearFadeIn : 1e6, look.anisotropy, 0]);
		set(6, [...look.albedo, look.extinctionScale]);
		set(7, [...look.emissive, look.skyIntensity]);
		set(8, [...look.sunDirection, 0]);
		set(9, [...look.sun, 0]);
		const [a, b] = environment.fog.layers;
		set(10, [a.density, a.falloff, a.height, 0]);
		set(11, [b.density, b.falloff, b.height, 0]);
	}

	/**
	 * what the post passes need to sample the grid.
	 *
	 * @returns the slice mapping (`log2(z · x + y) · z` gives the texture's w) and the view depth the froxels
	 *   cover, plus the depth nearer than which there's no fog; `null` while the fog is off
	 */
	get sampling(): { slices: [number, number, number, number]; start: number } | null {
		const look = this.#look;
		const slices = this.#slices;
		if (look === null || slices === null) {
			return null;
		}
		return {
			slices: [slices.scale, slices.offset, DEPTH_DISTRIBUTION_SCALE / GRID[2], look.distance],
			start: look.startDistance,
		};
	}

	/**
	 * encodes the froxel pass, when the fog is on and its pipeline is ready.
	 *
	 * @param encoder this frame's encoder, after the shadow passes
	 * @param input the frame group and its dynamic offset, the camera (unjittered), the render aspect and the
	 *   frame number
	 * @returns whether the grid was written this frame
	 */
	encode(
		encoder: GPUCommandEncoder,
		input: { frameGroup: GPUBindGroup; frameOffset: number; camera: Camera; aspect: number; frame: number },
	): boolean {
		const pipeline = this.#pipeline;
		if (pipeline === null || this.#slices === null) {
			return false;
		}
		const { camera, aspect } = input;
		const tanHalf = Math.tan(camera.fovY / 2);
		const right = camera.right();
		const up = camera.up();
		const f = this.#data;
		f.set([...camera.forward(), 0], 0);
		f.set([right[0] * aspect * tanHalf, right[1] * aspect * tanHalf, right[2] * aspect * tanHalf, 0], 4);
		f.set([up[0] * tanHalf, up[1] * tanHalf, up[2] * tanHalf, 0], 8);
		f.set([...camera.position, input.frame % 1024], 12);
		this.#device.queue.writeBuffer(this.#uniforms, 0, f);
		const pass = encoder.beginComputePass({ label: 'volumetric fog' });
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, input.frameGroup, [input.frameOffset]);
		pass.setBindGroup(1, this.#group);
		pass.dispatchWorkgroups(Math.ceil(GRID[0] / WORKGROUP), Math.ceil(GRID[1] / WORKGROUP));
		pass.end();
		return true;
	}

	/** frees the grid and uniforms */
	destroy(): void {
		this.#texture.destroy();
		this.#uniforms.destroy();
	}
}
