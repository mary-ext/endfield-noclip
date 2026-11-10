import type { Vec3 } from '@endfield-noclip/package-format/values';

import type { Environment, VolumetricFog as VolumetricFogLook } from '../../environment/environment.ts';
import { createUniformBuffer, rowWriter } from '../../gfx/buffers.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { LINEAR_CLAMP, sampler } from '../../gfx/samplers.ts';
import { halton } from '../../math/sequence.ts';
import { scale } from '../../math/vec3.ts';
import type { Camera } from '../../scene/camera.ts';
import { FRAME_WGSL } from '../frame/frame-uniforms.ts';

import fogWgsl from './volumetric-fog.wgsl?raw';

/**
 * froxels across, down and in depth: a fixed grid, coarser than the game's, which follows the view in cells
 * of a set pixel size up to a capped source size (240 × 135 × 128 at PC high,
 * docs/game-data/quality-settings.md)
 */
const GRID: readonly [number, number, number] = [160, 90, 64];
/** slices per doubling of depth past the first. the game's value isn't recovered; this is Unreal's default */
const DEPTH_DISTRIBUTION_SCALE = 32;
/** the game starts the first slice this far past the near plane or start distance */
const NEAR_OFFSET = 0.095;
/**
 * the reprojected history's weight in each froxel's lighting. the game's preset value isn't recovered; this
 * is Unreal's default
 */
const HISTORY_WEIGHT = 0.9;
/** sample positions per jitter cycle */
const JITTER_PHASES = 16;
/** byte size of `VolumetricFog` in volumetric-fog.wgsl */
const UNIFORM_BYTES = 17 * 16;
const WORKGROUP = 8;
const PIPELINE_KEY = 'volumetric fog';

/** how a view depth maps onto the grid's slices: `s = log2(z · scale + offset) · perDoubling` */
interface Slices {
	scale: number;
	offset: number;
	near: number;
}

/** the view a frame's grid was laid over, for the next frame to reproject into */
interface GridView {
	eye: Vec3;
	forward: Vec3;
	/**
	 * the camera's right and up axes divided by the view's half extents at unit depth, so `dot(rel, x) / z` is
	 * NDC
	 */
	right: Vec3;
	up: Vec3;
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

const sameSlices = (a: Slices | null, b: Slices | null): boolean =>
	a !== null && b !== null && a.scale === b.scale && a.offset === b.offset;

/** a write-only 3D grid in the froxel pass's group */
const storage = (binding: number): GPUBindGroupLayoutEntry => ({
	binding,
	visibility: GPUShaderStage.COMPUTE,
	storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' },
});

/** owns the froxel grid, its lighting history, its compute pipeline and uniforms */
export class VolumetricFog {
	/** the integrated fog: scattered light (rgb) and transmittance (a) up to each slice */
	readonly view: GPUTextureView;
	#device: GPUDevice;
	#texture: GPUTexture;
	/**
	 * each froxel's lit medium (scattered radiance per metre, extinction); each frame reads one, writes the
	 * other
	 */
	#history: [GPUTexture, GPUTexture];
	#uniforms: GPUBuffer;
	#data = new Float32Array(UNIFORM_BYTES / 4);
	/** group 1 for a frame that writes `#history[i]` and reads the other */
	#groups: [GPUBindGroup, GPUBindGroup];
	#index = 0;
	/** the view the last written history was laid over; `null` when there's no history to reproject */
	#previous: GridView | null = null;
	#pipelines: PipelineCache;
	#look: VolumetricFogLook | null = null;
	#slices: Slices | null = null;

	/**
	 * @param device the device
	 * @param pipelines the pipeline cache, which compiles the froxel pass
	 * @param frameLayout the shared frame layout (group 0), for the sun's shadow and the ambient probe
	 */
	constructor(device: GPUDevice, pipelines: PipelineCache, frameLayout: GPUBindGroupLayout) {
		this.#device = device;
		const grid = (label: string): GPUTexture =>
			device.createTexture({
				label,
				size: [...GRID],
				dimension: '3d',
				format: 'rgba16float',
				usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
			});
		this.#texture = grid('volumetric fog');
		this.view = this.#texture.createView();
		this.#history = [grid('volumetric fog history 0'), grid('volumetric fog history 1')];
		this.#uniforms = createUniformBuffer(device, 'volumetric fog uniforms', UNIFORM_BYTES);
		const layout = device.createBindGroupLayout({
			label: 'volumetric fog',
			entries: [
				{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
				storage(1),
				storage(2),
				{ binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { viewDimension: '3d' } },
				{ binding: 4, visibility: GPUShaderStage.COMPUTE, sampler: {} },
			],
		});
		const history = sampler(device, LINEAR_CLAMP);
		const group = (write: GPUTexture, read: GPUTexture): GPUBindGroup =>
			device.createBindGroup({
				label: 'volumetric fog',
				layout,
				entries: [
					{ binding: 0, resource: { buffer: this.#uniforms } },
					{ binding: 1, resource: this.view },
					{ binding: 2, resource: write.createView() },
					{ binding: 3, resource: read.createView() },
					{ binding: 4, resource: history },
				],
			});
		const [a, b] = this.#history;
		this.#groups = [group(a, b), group(b, a)];
		this.#pipelines = pipelines;
		void pipelines.prepareCompute(PIPELINE_KEY, () => ({
			layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, layout] }),
			compute: {
				module: pipelines.module('volumetric fog', FRAME_WGSL + fogWgsl),
				entryPoint: 'cs_froxels',
			},
		}));
	}

	/** @returns bytes of the grid and its history */
	get bytes(): number {
		return GRID[0] * GRID[1] * GRID[2] * 8 * 3;
	}

	/**
	 * @param environment the environment at the camera
	 * @param near the camera's near plane (m)
	 */
	setEnvironment(environment: Environment, near: number): void {
		const look = environment.volumetricFog;
		const before = this.#slices;
		this.#look = look;
		this.#slices = null;
		if (look !== null) {
			const first = Math.max(near, look.startDistance) + NEAR_OFFSET;
			if (look.distance > first) {
				this.#slices = sliceMapping(first, look.distance);
			}
		}
		// a history laid over other slices doesn't reproject; one lit by another environment fades over
		if (!sameSlices(before, this.#slices)) {
			this.#previous = null;
		}
		const slices = this.#slices;
		if (look === null || slices === null) {
			return;
		}
		const f = this.#data;
		const set = rowWriter(f);
		set(4, [slices.scale, slices.offset, DEPTH_DISTRIBUTION_SCALE, GRID[2]]);
		set(5, [slices.near, look.nearFadeIn > 0 ? 1 / look.nearFadeIn : 1e6, look.anisotropy, 0]);
		set(6, [...look.albedo, look.extinctionScale]);
		set(7, [...look.emissive, look.skyIntensity]);
		set(8, [...look.sunDirection, 0]);
		set(9, [...look.sun, 0]);
		const [a, b] = environment.heightFog.layers;
		set(10, [a.density, a.falloff, a.height, 0]);
		set(11, [b.density, b.falloff, b.height, 0]);
	}

	/** drops the history, after a cut to somewhere else */
	reset(): void {
		this.#previous = null;
	}

	/**
	 * what the post passes need to sample the grid.
	 *
	 * @returns the slice mapping (`log2(depth · x + y) · z` gives the texture's w) with the view depth the
	 *   froxels cover in w, plus the depth nearer than which there's no fog; `null` while the fog is off
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
		const pipeline = this.#pipelines.getCompute(PIPELINE_KEY);
		if (pipeline === undefined || this.#slices === null) {
			return false;
		}
		const { camera, aspect } = input;
		const basis = camera.viewBasis(aspect);
		const eye = camera.position;
		const f = this.#data;
		f.set([...basis.forward, 0], 0);
		f.set([...basis.right, 0], 4);
		f.set([...basis.up, 0], 8);
		f.set([...eye, 0], 12);
		{
			// the point each froxel is lit at this frame, as a fraction of its cell: across and down in
			// [-0.5, 0.5), in depth in [0, 1)
			const phase = (input.frame % JITTER_PHASES) + 1;
			f.set([halton(phase, 2) - 0.5, halton(phase, 3) - 0.5, halton(phase, 5), 0], 48);
		}
		const previous = this.#previous;
		if (previous === null) {
			f.fill(0, 52, 68);
		} else {
			f.set([...previous.forward, HISTORY_WEIGHT], 52);
			f.set([...previous.right, 0], 56);
			f.set([...previous.up, 0], 60);
			f.set([eye[0] - previous.eye[0], eye[1] - previous.eye[1], eye[2] - previous.eye[2], 0], 64);
		}
		this.#device.queue.writeBuffer(this.#uniforms, 0, f);
		const pass = encoder.beginComputePass({ label: 'volumetric fog' });
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, input.frameGroup, [input.frameOffset]);
		pass.setBindGroup(1, this.#groups[this.#index]);
		pass.dispatchWorkgroups(Math.ceil(GRID[0] / WORKGROUP), Math.ceil(GRID[1] / WORKGROUP));
		pass.end();

		{
			const tanHalf = Math.tan(camera.fovY / 2);
			this.#previous = {
				eye: [eye[0], eye[1], eye[2]],
				forward: basis.forward,
				right: scale(camera.right(), 1 / (aspect * tanHalf)),
				up: scale(camera.up(), 1 / tanHalf),
			};
		}
		this.#index = 1 - this.#index;
		return true;
	}

	/** frees the grid, its history and the uniforms */
	destroy(): void {
		this.#texture.destroy();
		for (const texture of this.#history) {
			texture.destroy();
		}
		this.#uniforms.destroy();
	}
}
