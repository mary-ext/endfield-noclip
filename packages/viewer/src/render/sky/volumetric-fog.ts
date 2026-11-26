import type { Vec3 } from '@endfield-noclip/package-format/values';

import tgpu, { type TgpuRoot } from 'typegpu';

import type { Environment, VolumetricFog as VolumetricFogLook } from '../../environment/environment.ts';
import { createUniformBuffer, rowWriter } from '../../gfx/buffers.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { LINEAR_CLAMP, sampler } from '../../gfx/samplers.ts';
import { halton } from '../../math/scalar.ts';
import { scale } from '../../math/vec3.ts';
import type { Camera } from '../../scene/camera.ts';

import {
	VOLUMETRIC_FOG_BYTES,
	csFroxelInject,
	csFroxelIntegrate,
	volumetricFogInjectLayout,
	volumetricFogIntegrateLayout,
} from './volumetric-fog-shader.ts';

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
const INJECT_WORKGROUP = 4;
const INTEGRATE_WORKGROUP = 8;
const INJECT_KEY = 'volumetric fog inject';
const INTEGRATE_KEY = 'volumetric fog integrate';

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
	#data = new Float32Array(VOLUMETRIC_FOG_BYTES / 4);
	/** group 1 for the 3D injection pass: writes `#history[i]` and reads the other */
	#injectGroups: [GPUBindGroup, GPUBindGroup];
	/** group 0 for the 2D integration pass: reads `#history[i]` and writes `#texture` */
	#integrateGroups: [GPUBindGroup, GPUBindGroup];
	#index = 0;
	/** the view the last written history was laid over; `null` when there's no history to reproject */
	#previous: GridView | null = null;
	#pipelines: PipelineCache;
	#look: VolumetricFogLook | null = null;
	#slices: Slices | null = null;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines the pipeline cache, which compiles the froxel pass
	 * @param frameLayout the shared frame layout (group 0), for the sun's shadow and the ambient probe
	 */
	constructor(root: TgpuRoot, pipelines: PipelineCache, frameLayout: GPUBindGroupLayout) {
		const device = root.device;
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
		this.#uniforms = createUniformBuffer(device, 'volumetric fog uniforms', VOLUMETRIC_FOG_BYTES);
		const historySampler = sampler(device, LINEAR_CLAMP);
		const injectGroup = (write: GPUTexture, read: GPUTexture): GPUBindGroup =>
			root.unwrap(
				root.createBindGroup(volumetricFogInjectLayout, {
					fog: this.#uniforms,
					historyOut: write.createView(),
					historyIn: read.createView(),
					historySampler,
				}),
			);
		const integrateGroup = (medium: GPUTexture): GPUBindGroup =>
			root.unwrap(
				root.createBindGroup(volumetricFogIntegrateLayout, {
					fog: this.#uniforms,
					medium: medium.createView(),
					froxels: this.view,
				}),
			);
		const [a, b] = this.#history;
		this.#injectGroups = [injectGroup(a, b), injectGroup(b, a)];
		this.#integrateGroups = [integrateGroup(a), integrateGroup(b)];
		this.#pipelines = pipelines;
		void pipelines.prepareCompute(INJECT_KEY, () => ({
			layout: device.createPipelineLayout({
				bindGroupLayouts: [frameLayout, root.unwrap(volumetricFogInjectLayout)],
			}),
			compute: {
				module: pipelines.module(INJECT_KEY, tgpu.resolve([csFroxelInject])),
				entryPoint: 'csFroxelInject',
			},
		}));
		void pipelines.prepareCompute(INTEGRATE_KEY, () => ({
			layout: device.createPipelineLayout({
				bindGroupLayouts: [root.unwrap(volumetricFogIntegrateLayout)],
			}),
			compute: {
				module: pipelines.module(INTEGRATE_KEY, tgpu.resolve([csFroxelIntegrate])),
				entryPoint: 'csFroxelIntegrate',
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
		const inject = this.#pipelines.getCompute(INJECT_KEY);
		const integrate = this.#pipelines.getCompute(INTEGRATE_KEY);
		if (inject === undefined || integrate === undefined || this.#slices === null) {
			return false;
		}
		const { camera, aspect } = input;
		const basis = camera.viewBasis(aspect);
		const eye = camera.position;
		const f = this.#data;
		f[0] = basis.forward[0];
		f[1] = basis.forward[1];
		f[2] = basis.forward[2];
		f[3] = 0;
		f[4] = basis.right[0];
		f[5] = basis.right[1];
		f[6] = basis.right[2];
		f[7] = 0;
		f[8] = basis.up[0];
		f[9] = basis.up[1];
		f[10] = basis.up[2];
		f[11] = 0;
		f[12] = eye[0];
		f[13] = eye[1];
		f[14] = eye[2];
		f[15] = 0;
		{
			// the point each froxel is lit at this frame, as a fraction of its cell: across and down in
			// [-0.5, 0.5), in depth in [0, 1)
			const phase = (input.frame % JITTER_PHASES) + 1;
			f[48] = halton(phase, 2) - 0.5;
			f[49] = halton(phase, 3) - 0.5;
			f[50] = halton(phase, 5);
			f[51] = 0;
		}
		const previous = this.#previous;
		if (previous === null) {
			f.fill(0, 52, 68);
		} else {
			f[52] = previous.forward[0];
			f[53] = previous.forward[1];
			f[54] = previous.forward[2];
			f[55] = HISTORY_WEIGHT;
			f[56] = previous.right[0];
			f[57] = previous.right[1];
			f[58] = previous.right[2];
			f[59] = 0;
			f[60] = previous.up[0];
			f[61] = previous.up[1];
			f[62] = previous.up[2];
			f[63] = 0;
			f[64] = eye[0] - previous.eye[0];
			f[65] = eye[1] - previous.eye[1];
			f[66] = eye[2] - previous.eye[2];
			f[67] = 0;
		}
		this.#device.queue.writeBuffer(this.#uniforms, 0, f);
		{
			const pass = encoder.beginComputePass({ label: INJECT_KEY });
			pass.setPipeline(inject);
			pass.setBindGroup(0, input.frameGroup, [input.frameOffset]);
			pass.setBindGroup(1, this.#injectGroups[this.#index]);
			pass.dispatchWorkgroups(
				Math.ceil(GRID[0] / INJECT_WORKGROUP),
				Math.ceil(GRID[1] / INJECT_WORKGROUP),
				Math.ceil(GRID[2] / INJECT_WORKGROUP),
			);
			pass.end();
		}
		{
			const pass = encoder.beginComputePass({ label: INTEGRATE_KEY });
			pass.setPipeline(integrate);
			pass.setBindGroup(0, this.#integrateGroups[this.#index]);
			pass.dispatchWorkgroups(
				Math.ceil(GRID[0] / INTEGRATE_WORKGROUP),
				Math.ceil(GRID[1] / INTEGRATE_WORKGROUP),
			);
			pass.end();
		}

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
