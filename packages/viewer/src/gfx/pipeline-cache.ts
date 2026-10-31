/**
 * shader-module and pipeline caching. pipelines are created asynchronously up front (`prepare`) so streaming
 * never compiles anything mid-flight.
 *
 * @module
 */

/** caches shader modules by source and render pipelines by a caller-chosen key */
export class PipelineCache {
	#device: GPUDevice;
	#modules = new Map<string, GPUShaderModule>();
	#pipelines = new Map<string, GPURenderPipeline>();
	#pending = new Map<string, Promise<GPURenderPipeline>>();

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
		let module = this.#modules.get(label);
		if (module === undefined) {
			module = this.#device.createShaderModule({ label, code });
			this.#modules.set(label, module);
		}
		return module;
	}

	/**
	 * creates (once) the pipeline for `key`.
	 *
	 * @param key unique key of the pipeline's state, e.g. `terrain/fill`
	 * @param describe builds the descriptor; only called on a miss
	 * @returns the pipeline
	 */
	prepare(key: string, describe: () => GPURenderPipelineDescriptor): Promise<GPURenderPipeline> {
		const ready = this.#pipelines.get(key);
		if (ready !== undefined) {
			return Promise.resolve(ready);
		}
		let pending = this.#pending.get(key);
		if (pending === undefined) {
			pending = this.#device.createRenderPipelineAsync({ label: key, ...describe() }).then((pipeline) => {
				this.#pipelines.set(key, pipeline);
				this.#pending.delete(key);
				return pipeline;
			});
			this.#pending.set(key, pending);
		}
		return pending;
	}

	/**
	 * @param key a key passed to {@link prepare}
	 * @returns the pipeline, or `undefined` while it compiles
	 */
	get(key: string): GPURenderPipeline | undefined {
		return this.#pipelines.get(key);
	}

	/** @returns how many pipelines are still compiling */
	get compiling(): number {
		return this.#pending.size;
	}

	/** @returns compiled pipeline count */
	get size(): number {
		return this.#pipelines.size;
	}
}
