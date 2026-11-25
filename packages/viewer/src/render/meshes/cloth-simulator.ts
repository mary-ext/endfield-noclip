import type { ClothDataBlob } from '@endfield-noclip/package-format/cloth';

import { type TgpuBindGroup, type TgpuComputePipeline, type TgpuRoot, type TgpuUniform, d } from 'typegpu';

import type { Environment } from '../../environment/environment.ts';
import { createBufferWithData } from '../../gfx/buffers.ts';
import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';
import { LINEAR_REPEAT, sampler } from '../../gfx/samplers.ts';

import { ClothUniformsSchema, clothSimLayout, csClothSim } from './cloth-sim-shader.ts';

const PIPELINE_KEY = 'cloth-sim';

/** `GpuClothManager.UpdateTimer`: fixed substep duration (seconds; `0x3cbf258c` ≈ 1/42.857 s) */
const CLOTH_DT = 0.023333333;
/** maximum substeps per frame */
const MAX_SUBSTEPS = 2;
/** `GpuClothManager.windSpeed` default (`0x41000000` = 8.0) */
const CLOTH_WIND_SPEED = 8.0;
/** bytes of {@link ClothUniformsSchema} */
const UNIFORM_BYTES = d.sizeOf(ClothUniformsSchema);
/** floats per bone in `skeletons` (3 x vec4f row-major 3x4 matrix) */
const BONE_FLOATS = 12;

/**
 * runs the GPU cloth simulation compute pass (`cloth-sim-shader.ts`) for a scene's simulated cloths and owns
 * the skeleton buffer read by `surfaces/common.ts`
 */
export class ClothSimulator {
	#root: TgpuRoot;
	#pipeline: AsyncPipeline<TgpuComputePipeline>;
	#uniforms: TgpuUniform<typeof ClothUniformsSchema>;
	#sampler: GPUSampler;
	#fallbackNoise: GPUTexture;
	#fallbackNoiseView: GPUTextureView;
	#windNoiseView: GPUTextureView;
	#dummySkeletons: GPUBuffer;

	#clothCount = 0;
	#meta: GPUBuffer | null = null;
	#batches: GPUBuffer | null = null;
	#cache: GPUBuffer | null = null;
	#nodes: GPUBuffer | null = null;
	#skeletons: GPUBuffer | null = null;
	#prevSkeletons: GPUBuffer | null = null;
	#skeletonBytes = 0;
	#prevDirty = false;
	#bindGroup: TgpuBindGroup | null = null;
	#version = 0;

	#accumulator = 0;
	#windTime = 0;
	#windNoiseU = 0;
	#windNoiseV = 0;
	#stepped = false;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines pipeline cache
	 */
	constructor(root: TgpuRoot, pipelines: PipelineCache) {
		const device = root.device;
		this.#root = root;
		this.#pipeline = pipelines.prepareTgpuCompute(PIPELINE_KEY, () =>
			root.createComputePipeline({ compute: csClothSim }),
		);
		this.#uniforms = root.createUniform(ClothUniformsSchema);
		this.#sampler = sampler(device, LINEAR_REPEAT);
		this.#fallbackNoise = device.createTexture({
			label: 'cloth fallback wind noise',
			size: [1, 1],
			format: 'rgba8unorm',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		device.queue.writeTexture(
			{ texture: this.#fallbackNoise },
			new Uint8Array([128, 128, 128, 255]),
			{ bytesPerRow: 4 },
			[1, 1],
		);
		this.#fallbackNoiseView = this.#fallbackNoise.createView();
		this.#windNoiseView = this.#fallbackNoiseView;
		this.#dummySkeletons = createBufferWithData(device, {
			label: 'cloth dummy skeletons',
			usage: GPUBufferUsage.STORAGE,
			data: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]),
		});
	}

	/** the current skeleton buffer bound by `InstanceRenderer` at `@group(1) @binding(4)` */
	get skeletonBuffer(): GPUBuffer {
		return this.#skeletons ?? this.#dummySkeletons;
	}

	/** the previous frame's skeleton buffer bound at `@group(1) @binding(5)`, for dynamic motion vectors */
	get prevSkeletonBuffer(): GPUBuffer {
		return this.#prevSkeletons ?? this.#dummySkeletons;
	}

	/** increments whenever {@link skeletonBuffer} changes */
	get version(): number {
		return this.#version;
	}

	/** whether a scene's cloth simulation data is loaded */
	get active(): boolean {
		return this.#clothCount > 0 && this.#bindGroup !== null;
	}

	/** @returns bytes of the cloth simulation GPU buffers */
	get bytes(): number {
		return (
			UNIFORM_BYTES +
			this.#dummySkeletons.size +
			(this.#meta?.size ?? 0) +
			(this.#batches?.size ?? 0) +
			(this.#cache?.size ?? 0) +
			(this.#nodes?.size ?? 0) +
			(this.#skeletons?.size ?? 0) +
			(this.#prevSkeletons?.size ?? 0)
		);
	}

	/**
	 * uploads a scene's cloth simulation buffers and initializes all bones to identity
	 *
	 * @param data decoded `.clth` blob, or `null` to clear
	 */
	load(data: ClothDataBlob | null): void {
		this.#releaseScene();
		if (data === null || data.clothCount === 0 || data.nodeCount === 0) {
			return;
		}
		const device = this.#root.device;
		this.#clothCount = data.clothCount;
		this.#meta = createBufferWithData(device, {
			label: 'cloth meta',
			usage: GPUBufferUsage.STORAGE,
			data: data.meta,
			minSize: 16,
		});
		this.#batches = createBufferWithData(device, {
			label: 'cloth batches',
			usage: GPUBufferUsage.STORAGE,
			data: data.batches,
			minSize: 16,
		});
		this.#cache = createBufferWithData(device, {
			label: 'cloth cache',
			usage: GPUBufferUsage.STORAGE,
			data: data.cache,
			minSize: 16,
		});
		this.#nodes = createBufferWithData(device, {
			label: 'cloth nodes',
			usage: GPUBufferUsage.STORAGE,
			data: data.nodes,
			minSize: 16,
		});
		const initSkel = new Float32Array(data.nodeCount * BONE_FLOATS);
		for (let i = 0; i < data.nodeCount; i++) {
			const base = i * BONE_FLOATS;
			initSkel[base] = 1;
			initSkel[base + 5] = 1;
			initSkel[base + 10] = 1;
		}
		this.#skeletons = createBufferWithData(device, {
			label: 'cloth skeletons',
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
			data: initSkel,
			minSize: 48,
		});
		this.#prevSkeletons = createBufferWithData(device, {
			label: 'cloth prev skeletons',
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			data: initSkel,
			minSize: 48,
		});
		this.#skeletonBytes = Math.max(initSkel.byteLength, 48);
		this.#prevDirty = false;
		this.#accumulator = 0;
		this.#windTime = 0;
		this.#windNoiseU = 0;
		this.#windNoiseV = 0;
		this.#stepped = false;
		this.#version++;
		this.#rebuildBindGroup();
	}

	/**
	 * updates the wind noise texture (`_WindGlobalNoiseTex`) sampled by the simulation
	 *
	 * @param view texture view, or `null` for the neutral fallback
	 */
	setWindNoise(view: GPUTextureView | null): void {
		const next = view ?? this.#fallbackNoiseView;
		if (next === this.#windNoiseView) {
			return;
		}
		this.#windNoiseView = next;
		if (this.#clothCount > 0) {
			this.#rebuildBindGroup();
		}
	}

	/**
	 * advances the cloth simulation when enough time has elapsed (fixed `CLOTH_DT` substeps, up to 2 per frame)
	 *
	 * @param encoder command encoder
	 * @param dt frame delta in seconds (0 when animation is paused)
	 * @param wind current derived environment wind
	 * @returns whether a simulation step was dispatched
	 */
	step(encoder: GPUCommandEncoder, dt: number, wind: Environment['wind']): boolean {
		if (this.#clothCount === 0 || this.#bindGroup === null) {
			return false;
		}
		const pipeline = this.#pipeline.get();
		if (pipeline === undefined) {
			return false;
		}
		// `GpuClothManager._UpdateWindParams`: step = windSpeed * 0.25 * 0.08 * dt
		if (dt > 0) {
			const windStep = CLOTH_WIND_SPEED * 0.25 * 0.08 * dt;
			this.#windTime += windStep;
			this.#windNoiseU -= wind.direction[0] * windStep;
			this.#windNoiseV -= wind.direction[1] * windStep;
			this.#accumulator += dt;
		}

		let loopNum = 0;
		if (!this.#stepped) {
			loopNum = 1;
			this.#stepped = true;
		} else if (this.#accumulator >= CLOTH_DT) {
			loopNum = Math.min(Math.floor(this.#accumulator / CLOTH_DT), MAX_SUBSTEPS);
			this.#accumulator -= loopNum * CLOTH_DT;
		}
		if (loopNum === 0) {
			if (this.#prevDirty && this.#skeletons !== null && this.#prevSkeletons !== null) {
				encoder.copyBufferToBuffer(this.#skeletons, 0, this.#prevSkeletons, 0, this.#skeletonBytes);
				this.#prevDirty = false;
			}
			return false;
		}
		if (this.#skeletons !== null && this.#prevSkeletons !== null) {
			encoder.copyBufferToBuffer(this.#skeletons, 0, this.#prevSkeletons, 0, this.#skeletonBytes);
			this.#prevDirty = true;
		}

		this.#uniforms.write({
			dtInfo: [CLOTH_DT, 1 / CLOTH_DT, loopNum, 0],
			windParams: [this.#windTime, this.#windNoiseU, this.#windNoiseV, 0],
			windGlobal: [wind.intensity, 0, wind.direction[0], wind.direction[1]],
		});

		const pass = encoder.beginComputePass({ label: 'cloth sim' });
		pipeline.with(this.#bindGroup).with(pass).dispatchWorkgroups(this.#clothCount, 1, 1);
		pass.end();
		return true;
	}

	/** releases all GPU resources */
	destroy(): void {
		this.#releaseScene();
		this.#uniforms.buffer.destroy();
		this.#fallbackNoise.destroy();
		this.#dummySkeletons.destroy();
	}

	#releaseScene(): void {
		this.#meta?.destroy();
		this.#batches?.destroy();
		this.#cache?.destroy();
		this.#nodes?.destroy();
		this.#skeletons?.destroy();
		this.#prevSkeletons?.destroy();
		this.#meta = null;
		this.#batches = null;
		this.#cache = null;
		this.#nodes = null;
		this.#skeletons = null;
		this.#prevSkeletons = null;
		this.#skeletonBytes = 0;
		this.#prevDirty = false;
		this.#bindGroup = null;
		if (this.#clothCount > 0) {
			this.#clothCount = 0;
			this.#version++;
		}
	}

	#rebuildBindGroup(): void {
		if (
			this.#meta === null ||
			this.#batches === null ||
			this.#cache === null ||
			this.#nodes === null ||
			this.#skeletons === null
		) {
			this.#bindGroup = null;
			return;
		}
		this.#bindGroup = this.#root.createBindGroup(clothSimLayout, {
			params: this.#uniforms,
			clothMeta: this.#meta,
			batchMeta: this.#batches,
			cacheMap: this.#cache,
			clothNodes: this.#nodes,
			skeletons: this.#skeletons,
			windNoise: this.#windNoiseView,
			windSampler: this.#sampler,
		});
	}
}
