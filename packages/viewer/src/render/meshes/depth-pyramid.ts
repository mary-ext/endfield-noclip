import type { PipelineCache } from '../../gfx/pipeline-cache.ts';

import pyramidWgsl from './depth-pyramid.wgsl?raw';

const KEYS = { first: 'depth pyramid/first', down: 'depth pyramid/down' };

/**
 * the farthest depth under each texel of a pyramid built from the main pass's depth, half its size at the
 * first level (reversed-Z: the smallest value). the instance culler tests last frame's view against it
 */
export class DepthPyramid {
	#device: GPUDevice;
	#pipelines: PipelineCache;
	#texture: GPUTexture | null = null;
	/** the whole pyramid, sampled */
	#view: GPUTextureView | null = null;
	/** each level's dispatch: its bind group and size */
	#levels: { group: GPUBindGroup; width: number; height: number }[] = [];
	/** the depth view the groups read */
	#source: GPUTextureView | null = null;

	/**
	 * @param device the device
	 * @param pipelines compiles the passes
	 */
	constructor(device: GPUDevice, pipelines: PipelineCache) {
		this.#device = device;
		this.#pipelines = pipelines;
		const module = pipelines.module('depth pyramid', pyramidWgsl);
		void pipelines.prepareCompute(KEYS.first, () => ({
			layout: 'auto',
			compute: { module, entryPoint: 'cs_first' },
		}));
		void pipelines.prepareCompute(KEYS.down, () => ({
			layout: 'auto',
			compute: { module, entryPoint: 'cs_down' },
		}));
	}

	/** @returns whether the passes compiled */
	get ready(): boolean {
		return (
			this.#pipelines.getCompute(KEYS.first) !== undefined &&
			this.#pipelines.getCompute(KEYS.down) !== undefined
		);
	}

	/**
	 * @returns the pyramid's view, its size at its first level and its level count, or `null` before the first
	 *   build
	 */
	get extent(): { width: number; height: number; levels: number; view: GPUTextureView } | null {
		const first = this.#levels[0];
		if (this.#view === null || first === undefined) {
			return null;
		}
		return { width: first.width, height: first.height, levels: this.#levels.length, view: this.#view };
	}

	/** @returns bytes of the pyramid */
	get bytes(): number {
		const first = this.#levels[0];
		// the levels past the first add a third
		return first === undefined ? 0 : Math.round((first.width * first.height * 4 * 4) / 3);
	}

	/** frees the pyramid */
	destroy(): void {
		this.#texture?.destroy();
		this.#texture = null;
		this.#view = null;
		this.#levels = [];
		this.#source = null;
	}

	/**
	 * builds the pyramid from a depth buffer; nothing while the passes compile
	 *
	 * @param encoder the frame's encoder
	 * @param depth the depth aspect of the depth buffer, and its size
	 * @returns whether it was built
	 */
	encode(
		encoder: GPUCommandEncoder,
		depth: { view: GPUTextureView; width: number; height: number },
	): boolean {
		const first = this.#pipelines.getCompute(KEYS.first);
		const down = this.#pipelines.getCompute(KEYS.down);
		if (first === undefined || down === undefined) {
			return false;
		}
		if (this.#source !== depth.view) {
			this.#build(depth, { first, down });
		}
		const pass = encoder.beginComputePass({ label: 'depth pyramid' });
		this.#levels.forEach((level, i) => {
			pass.setPipeline(i === 0 ? first : down);
			pass.setBindGroup(0, level.group);
			pass.dispatchWorkgroups(Math.ceil(level.width / 8), Math.ceil(level.height / 8));
		});
		pass.end();
		return true;
	}

	/** (re)creates the texture and the levels' groups for a depth buffer */
	#build(
		depth: { view: GPUTextureView; width: number; height: number },
		pipelines: { first: GPUComputePipeline; down: GPUComputePipeline },
	): void {
		this.#texture?.destroy();
		const width = Math.max(1, Math.ceil(depth.width / 2));
		const height = Math.max(1, Math.ceil(depth.height / 2));
		const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
		const texture = this.#device.createTexture({
			label: 'depth pyramid',
			size: [width, height],
			format: 'r32float',
			mipLevelCount: levels,
			usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
		});
		const level = (mip: number): GPUTextureView =>
			texture.createView({ baseMipLevel: mip, mipLevelCount: 1 });
		this.#levels = Array.from({ length: levels }, (_, mip) => {
			const pipeline = mip === 0 ? pipelines.first : pipelines.down;
			return {
				group: this.#device.createBindGroup({
					label: `depth pyramid ${mip}`,
					layout: pipeline.getBindGroupLayout(0),
					entries: [
						mip === 0 ? { binding: 0, resource: depth.view } : { binding: 1, resource: level(mip - 1) },
						{ binding: 2, resource: level(mip) },
					],
				}),
				width: Math.max(1, width >> mip),
				height: Math.max(1, height >> mip),
			};
		});
		this.#texture = texture;
		this.#view = texture.createView();
		this.#source = depth.view;
	}
}
