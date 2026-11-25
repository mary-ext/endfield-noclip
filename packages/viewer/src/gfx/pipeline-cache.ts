import type { TgpuComputePipeline, TgpuRenderPipeline } from 'typegpu';

/** a handle to an asynchronously compiled TypeGPU pipeline */
export interface AsyncPipeline<P> {
	readonly key: string;
	/** @returns the compiled pipeline, or `undefined` while it compiles */
	get(): P | undefined;
}

/** shader labels and pipeline keys identify immutable descriptors for the lifetime of the cache */
export class PipelineCache {
	#device: GPUDevice;
	#modules = new Map<string, GPUShaderModule>();
	#render = new Compiled<GPURenderPipeline>();
	#compute = new Compiled<GPUComputePipeline>();
	#tgpuRender = new Compiled<TgpuRenderPipeline>();
	#tgpuCompute = new Compiled<TgpuComputePipeline>();

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.#device = device;
	}

	/**
	 * @param label module label, also the cache key
	 * @param code WGSL source
	 * @returns the compiled module
	 */
	module(label: string, code: string): GPUShaderModule {
		return this.#modules.getOrInsertComputed(label, () => this.#device.createShaderModule({ label, code }));
	}

	/**
	 * concurrent requests for a key share one compilation; a rejected compilation remains cached.
	 *
	 * @param key unique key of the pipeline's state, e.g. `terrain/fill`
	 * @param describe builds the descriptor; only called on a miss
	 * @returns the pipeline
	 */
	prepare(key: string, describe: () => GPURenderPipelineDescriptor): Promise<GPURenderPipeline> {
		return this.#render.prepare(key, () =>
			this.#device.createRenderPipelineAsync({ label: key, ...describe() }),
		);
	}

	/**
	 * {@link prepare} for a compute pipeline.
	 *
	 * @param key unique key of the pipeline's state, e.g. `volumetric fog`
	 * @param describe builds the descriptor; only called on a miss
	 * @returns the pipeline
	 */
	prepareCompute(key: string, describe: () => GPUComputePipelineDescriptor): Promise<GPUComputePipeline> {
		return this.#compute.prepare(key, () =>
			this.#device.createComputePipelineAsync({ label: key, ...describe() }),
		);
	}

	/**
	 * @param key a key passed to {@link prepare}
	 * @returns the pipeline, or `undefined` while it compiles
	 */
	get(key: string): GPURenderPipeline | undefined {
		return this.#render.ready.get(key);
	}

	/**
	 * @param key a key passed to {@link prepareCompute}
	 * @returns the pipeline, or `undefined` while it compiles
	 */
	getCompute(key: string): GPUComputePipeline | undefined {
		return this.#compute.ready.get(key);
	}

	/**
	 * starts async compilation of a TypeGPU render pipeline and tracks it in {@link compiling} / {@link size}.
	 *
	 * @param key unique key of the pipeline's state, e.g. `tonemap`
	 * @param create builds the TypeGPU render pipeline; only called on a miss
	 * @returns a handle whose `get()` returns the pipeline once `initAsync()` completes
	 */
	prepareTgpuRender<P extends TgpuRenderPipeline>(key: string, create: () => P): AsyncPipeline<P> {
		let ready: P | undefined;
		void this.#tgpuRender.prepare(key, async () => {
			const pipeline = create();
			await pipeline.initAsync();
			ready = pipeline;
			return pipeline;
		});
		return {
			key,
			get: () => ready,
		};
	}

	/**
	 * {@link prepareTgpuRender} for a TypeGPU compute pipeline.
	 *
	 * @param key unique key of the pipeline's state, e.g. `auto exposure histogram`
	 * @param create builds the TypeGPU compute pipeline; only called on a miss
	 * @returns a handle whose `get()` returns the pipeline once `initAsync()` completes
	 */
	prepareTgpuCompute<P extends TgpuComputePipeline>(key: string, create: () => P): AsyncPipeline<P> {
		let ready: P | undefined;
		void this.#tgpuCompute.prepare(key, async () => {
			const pipeline = create();
			await pipeline.initAsync();
			ready = pipeline;
			return pipeline;
		});
		return {
			key,
			get: () => ready,
		};
	}

	/** @returns how many pipelines are still compiling */
	get compiling(): number {
		return (
			this.#render.pending.size +
			this.#compute.pending.size +
			this.#tgpuRender.pending.size +
			this.#tgpuCompute.pending.size
		);
	}

	/** @returns compiled pipeline count */
	get size(): number {
		return (
			this.#render.ready.size +
			this.#compute.ready.size +
			this.#tgpuRender.ready.size +
			this.#tgpuCompute.ready.size
		);
	}
}

/** one kind of pipeline: those compiled, and those compiling */
class Compiled<P> {
	readonly ready = new Map<string, P>();
	readonly pending = new Map<string, Promise<P>>();

	prepare(key: string, compile: () => Promise<P>): Promise<P> {
		const pipeline = this.ready.get(key);
		if (pipeline !== undefined) {
			return Promise.resolve(pipeline);
		}
		return this.pending.getOrInsertComputed(key, () =>
			compile().then((compiled) => {
				this.ready.set(key, compiled);
				this.pending.delete(key);
				return compiled;
			}),
		);
	}
}
