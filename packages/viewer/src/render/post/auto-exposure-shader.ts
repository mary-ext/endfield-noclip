/**
 * auto exposure luminance histogram compute shader: 16 bins of log2 luminance over the metering range from
 * every `stride`-th pixel, split linearly between adjacent bins and optionally centre-weighted.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { BINS } from '../../environment/exposure.ts';
import { LUMINANCE } from '../core/shader-math.ts';

/** fixed-point scale of the weights accumulated in each histogram bin */
export const WEIGHT_SCALE = 1024;

/** uniform parameters for {@link csHistogram} */
export const AutoExposureParams = d.struct({
	size: d.vec2u,
	stride: d.u32,
	/** 0 for average metering */
	centerWeight: d.f32,
	/** log2 luminance of the first bin's start and the last bin's end */
	evRange: d.vec2f,
});

/** bind group layout for the auto-exposure histogram compute pass */
export const autoExposureLayout = tgpu.bindGroupLayout({
	scene: { texture: d.texture2d(d.f32) },
	params: { uniform: AutoExposureParams },
	bins: { storage: d.arrayOf(d.atomic(d.u32), BINS), access: 'mutable' },
});

const localBins = tgpu.workgroupVar(d.arrayOf(d.atomic(d.u32), BINS));

/** compute entrypoint that accumulates the scene's log2 luminance histogram */
export const csHistogram = tgpu.computeFn({
	workgroupSize: [8, 8],
	in: {
		id: d.builtin.globalInvocationId,
		index: d.builtin.localInvocationIndex,
	},
})((input) => {
	'use gpu';
	if (input.index < BINS) {
		std.atomicStore(localBins.$[input.index], 0);
	}
	std.workgroupBarrier();
	const params = autoExposureLayout.$.params;
	const p = std.mul(input.id.xy, params.stride);
	if (std.all(std.lt(p, params.size))) {
		const color = std.textureLoad(autoExposureLayout.$.scene, p, 0).rgb;
		const luminance = std.max(std.dot(color, LUMINANCE.$), 0.01);
		const ev = std.clamp(std.log2(luminance), params.evRange.x, params.evRange.y);
		const x = ((ev - params.evRange.x) / (params.evRange.y - params.evRange.x)) * (BINS - 0.0002);
		const bin = std.min(d.u32(x), BINS - 1);
		const next = std.min(bin + 1, BINS - 1);
		const f = std.fract(x);
		const uv = std.sub(std.div(d.vec2f(p), d.vec2f(params.size)), d.vec2f(0.5));
		const weight = params.centerWeight * (std.exp2(-170.56233 * std.dot(uv, uv)) - 1) + 1;
		std.atomicAdd(localBins.$[bin], d.u32((1 - f) * weight * WEIGHT_SCALE + 0.5));
		std.atomicAdd(localBins.$[next], d.u32(f * weight * WEIGHT_SCALE + 0.5));
	}
	std.workgroupBarrier();
	if (input.index < BINS) {
		std.atomicAdd(autoExposureLayout.$.bins[input.index], std.atomicLoad(localBins.$[input.index]));
	}
});
