import type { TgpuBindGroup, TgpuComputePipeline, TgpuRoot } from 'typegpu';

import type { AsyncPipeline, PipelineCache } from '../../gfx/pipeline-cache.ts';

import {
	csDepthPyramidDown,
	csDepthPyramidFirst,
	depthPyramidDownLayout,
	depthPyramidFirstLayout,
} from './depth-pyramid-shader.ts';

const KEYS = { first: 'depth pyramid/first', down: 'depth pyramid/down' };

/**
 * the farthest depth under each texel of a pyramid built from the main pass's depth, half its size at the
 * first level (reversed-Z: the smallest value). the instance culler tests last frame's view against it
 */
export class DepthPyramid {
	#root: TgpuRoot;
	#first: AsyncPipeline<TgpuComputePipeline>;
	#down: AsyncPipeline<TgpuComputePipeline>;
	#texture: GPUTexture | null = null;
	/** the whole pyramid, sampled */
	#view: GPUTextureView | null = null;
	/** each level's dispatch: its bind group and size */
	#levels: { group: TgpuBindGroup; width: number; height: number }[] = [];
	/** the depth view the groups read */
	#source: GPUTextureView | null = null;

	/**
	 * @param root the TypeGPU root
	 * @param pipelines compiles the passes
	 */
	constructor(root: TgpuRoot, pipelines: PipelineCache) {
		this.#root = root;
		this.#first = pipelines.prepareTgpuCompute(KEYS.first, () =>
			root.createComputePipeline({ compute: csDepthPyramidFirst }),
		);
		this.#down = pipelines.prepareTgpuCompute(KEYS.down, () =>
			root.createComputePipeline({ compute: csDepthPyramidDown }),
		);
	}

	/** @returns whether the passes compiled */
	get ready(): boolean {
		return this.#first.get() !== undefined && this.#down.get() !== undefined;
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
		const first = this.#first.get();
		const down = this.#down.get();
		if (first === undefined || down === undefined) {
			return false;
		}
		if (this.#source !== depth.view) {
			this.#build(depth);
		}
		const pass = encoder.beginComputePass({ label: 'depth pyramid' });
		this.#levels.forEach((level, i) => {
			(i === 0 ? first : down)
				.with(level.group)
				.with(pass)
				.dispatchWorkgroups(Math.ceil(level.width / 8), Math.ceil(level.height / 8));
		});
		pass.end();
		return true;
	}

	/** (re)creates the texture and the levels' groups for a depth buffer */
	#build(depth: { view: GPUTextureView; width: number; height: number }): void {
		this.#texture?.destroy();
		const width = Math.max(1, Math.ceil(depth.width / 2));
		const height = Math.max(1, Math.ceil(depth.height / 2));
		const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
		const texture = this.#root.device.createTexture({
			label: 'depth pyramid',
			size: [width, height],
			format: 'r32float',
			mipLevelCount: levels,
			usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
		});
		const level = (mip: number): GPUTextureView =>
			texture.createView({ baseMipLevel: mip, mipLevelCount: 1 });
		this.#levels = Array.from({ length: levels }, (_, mip) => {
			let group: TgpuBindGroup;
			if (mip === 0) {
				group = this.#root.createBindGroup(depthPyramidFirstLayout, {
					sourceDepth: depth.view,
					output: level(0),
				});
			} else {
				group = this.#root.createBindGroup(depthPyramidDownLayout, {
					source: level(mip - 1),
					output: level(mip),
				});
			}
			return {
				group,
				width: Math.max(1, width >> mip),
				height: Math.max(1, height >> mip),
			};
		});
		this.#texture = texture;
		this.#view = texture.createView();
		this.#source = depth.view;
	}
}
