/**
 * fullscreen pass helper for TypeGPU render pipelines, recording into a raw `GPUCommandEncoder` so
 * `GpuProfiler` continues to time passes by label.
 *
 * @module
 */

import type { TgpuBindGroup, TgpuRenderPipeline } from 'typegpu';

import type { AsyncPipeline } from './pipeline-cache.ts';

/** a fullscreen pass backed by an asynchronously compiled TypeGPU render pipeline */
export interface TgpuFullscreenPass {
	/** the render pass's label, which `GpuProfiler` reports it under */
	label: string;
	pipeline: AsyncPipeline<TgpuRenderPipeline>;
	/** bind groups applied to the pipeline */
	groups: readonly TgpuBindGroup[];
	/** single target texture view; may be updated per frame (e.g. swapchain view) */
	target?: GPUTextureView | null;
	/** multiple target texture views for MRT passes (takes precedence over {@link target}) */
	targets?: readonly GPUTextureView[];
	/** cached pipeline with {@link groups} pre-bound once compiled */
	bound?: TgpuRenderPipeline;
}

/**
 * encodes a fullscreen pass into `encoder`, skipping while its pipeline is still compiling.
 *
 * @param encoder the frame's command encoder
 * @param pass the pass to encode
 * @param loadOp `clear` clears the target to transparent black first; `load` draws over it
 * @returns whether the pass was encoded (`false` while the pipeline is still compiling)
 */
export const encodeTgpuFullscreen = (
	encoder: GPUCommandEncoder,
	pass: TgpuFullscreenPass,
	loadOp: GPULoadOp = 'clear',
): boolean => {
	const targets = pass.targets ?? (pass.target !== undefined && pass.target !== null ? [pass.target] : null);
	if (targets === null || targets.length === 0) {
		return false;
	}
	let bound = pass.bound;
	if (bound === undefined) {
		const compiled = pass.pipeline.get();
		if (compiled === undefined) {
			return false;
		}
		bound = compiled;
		for (const group of pass.groups) {
			bound = bound.with(group);
		}
		pass.bound = bound;
	}
	const render = encoder.beginRenderPass({
		label: pass.label,
		colorAttachments: targets.map((view) => ({
			view,
			loadOp,
			storeOp: 'store',
			clearValue: [0, 0, 0, 0],
		})),
	});
	bound.with(render).draw(3);
	render.end();
	return true;
};
