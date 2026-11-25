/**
 * bloom shaders: thresholded prefilter into the first level, separable Gaussian per further level (halving
 * size), then bicubic B-spline upsamples blended towards the coarser level by the scatter factor.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { luminanceRounded } from '../shaders/common/luminance.ts';

import { postUniformLayout } from './post-schema.ts';

/** per-pass sizing uniforms for a bloom downsample or upsample pass */
export const BloomPassSchema = d.struct({
	/** texel size of the source */
	texel: d.vec2f,
	/** upsamples: size of the coarser level in texels */
	lowSize: d.vec2f,
});

/** bind group layout for prefilter, horizontal blur and vertical blur */
export const bloomPassLayout = tgpu.bindGroupLayout({
	source: { texture: d.texture2d(d.f32) },
	bilinear: { sampler: 'filtering' },
	passInfo: { uniform: BloomPassSchema },
});

/** bind group layout for upsample passes (adds the matching downsample level) */
export const bloomUpLayout = tgpu.bindGroupLayout({
	high: { texture: d.texture2d(d.f32) },
});

const PREFILTER_OFFSETS = tgpu.const(d.arrayOf(d.vec2f, 5), [
	d.vec2f(0, 0),
	d.vec2f(0.9, -0.4),
	d.vec2f(-0.9, 0.4),
	d.vec2f(0.4, 0.9),
	d.vec2f(-0.4, -0.9),
]);

const tap = tgpu.fn(
	[d.vec2f, d.vec2f],
	d.vec3f,
)((uv, offset) => {
	'use gpu';
	return std.textureSampleLevel(
		bloomPassLayout.$.source,
		bloomPassLayout.$.bilinear,
		std.add(uv, std.mul(offset, bloomPassLayout.$.passInfo.texel)),
		0,
	).rgb;
});

/** the exposed colour above the threshold, with a quadratic knee */
const thresholded = tgpu.fn(
	[d.vec2f, d.vec2f],
	d.vec3f,
)((uv, offset) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const c = tap(uv, offset);
	const brightness = std.max(c.r, std.max(c.g, c.b));
	const soft = std.clamp(brightness - post.bloom.y, 0, post.bloom.z);
	const multiplier =
		std.max(post.bloom.w * soft * soft, brightness - post.bloom.x) / std.max(brightness, 1e-4);
	return std.mul(c, multiplier * post.grade.x);
});

/** five taps around the centre, each weighted by its inverse luma against fireflies */
export const fsBloomPrefilter = tgpu.fragmentFn({
	in: { uv: d.vec2f },
	out: d.vec4f,
})((input) => {
	'use gpu';
	let sum = d.vec3f(0);
	let weights = d.f32(0);
	for (let i = 0; i < 5; i++) {
		const c = thresholded(input.uv, PREFILTER_OFFSETS.$[i]);
		const w = 1 / (luminanceRounded(c) + 1);
		sum = std.add(sum, std.mul(c, w));
		weights += w;
	}
	return d.vec4f(std.div(sum, weights), 1);
});

/** nine taps two source texels apart, into a target half the source's width */
export const fsBloomBlurH = tgpu.fragmentFn({
	in: { uv: d.vec2f },
	out: d.vec4f,
})((input) => {
	'use gpu';
	let c = std.mul(tap(input.uv, d.vec2f(0, 0)), 0.22702703);
	c = std.add(c, std.mul(std.add(tap(input.uv, d.vec2f(-2, 0)), tap(input.uv, d.vec2f(2, 0))), 0.19459459));
	c = std.add(c, std.mul(std.add(tap(input.uv, d.vec2f(-4, 0)), tap(input.uv, d.vec2f(4, 0))), 0.12162162));
	c = std.add(c, std.mul(std.add(tap(input.uv, d.vec2f(-6, 0)), tap(input.uv, d.vec2f(6, 0))), 0.05405405));
	c = std.add(c, std.mul(std.add(tap(input.uv, d.vec2f(-8, 0)), tap(input.uv, d.vec2f(8, 0))), 0.01621622));
	return d.vec4f(c, 1);
});

/** the same Gaussian in five bilinear taps */
export const fsBloomBlurV = tgpu.fragmentFn({
	in: { uv: d.vec2f },
	out: d.vec4f,
})((input) => {
	'use gpu';
	let c = std.mul(tap(input.uv, d.vec2f(0, 0)), 0.22702703);
	c = std.add(
		c,
		std.mul(
			std.add(tap(input.uv, d.vec2f(0, -1.38461538)), tap(input.uv, d.vec2f(0, 1.38461538))),
			0.31621622,
		),
	);
	c = std.add(
		c,
		std.mul(
			std.add(tap(input.uv, d.vec2f(0, -3.23076923)), tap(input.uv, d.vec2f(0, 3.23076923))),
			0.07027027,
		),
	);
	return d.vec4f(c, 1);
});

/** cubic B-spline over the coarser level in four bilinear taps */
const bicubic = tgpu.fn(
	[d.vec2f],
	d.vec3f,
)((uv) => {
	'use gpu';
	const lowSize = bloomPassLayout.$.passInfo.lowSize;
	const p = std.add(std.mul(uv, lowSize), d.vec2f(0.5));
	const i = std.floor(p);
	const f = std.fract(p);
	const w0 = std.add(
		d.vec2f(1 / 6),
		std.mul(f, std.add(d.vec2f(-0.5), std.mul(f, std.sub(d.vec2f(0.5), std.mul(f, 1 / 6))))),
	);
	const w1 = std.add(d.vec2f(2 / 3), std.mul(std.mul(f, f), std.add(d.vec2f(-1), std.mul(0.5, f))));
	const w2 = std.add(
		d.vec2f(1 / 6),
		std.mul(f, std.add(d.vec2f(0.5), std.mul(f, std.sub(d.vec2f(0.5), std.mul(0.5, f))))),
	);
	const w3 = std.mul(std.mul(std.mul(f, f), f), 1 / 6);
	const g0 = std.add(w0, w1);
	const g1 = std.add(w2, w3);
	const h0 = std.add(d.vec2f(-1), std.div(w1, g0));
	const h1 = std.add(d.vec2f(1), std.div(w3, g1));
	const texel = std.div(d.vec2f(1), lowSize);
	const uv00 = std.mul(std.sub(std.add(i, d.vec2f(h0.x, h0.y)), d.vec2f(0.5)), texel);
	const uv10 = std.mul(std.sub(std.add(i, d.vec2f(h1.x, h0.y)), d.vec2f(0.5)), texel);
	const uv01 = std.mul(std.sub(std.add(i, d.vec2f(h0.x, h1.y)), d.vec2f(0.5)), texel);
	const uv11 = std.mul(std.sub(std.add(i, d.vec2f(h1.x, h1.y)), d.vec2f(0.5)), texel);
	const s = std.add(
		std.mul(std.textureSampleLevel(bloomPassLayout.$.source, bloomPassLayout.$.bilinear, uv00, 0).rgb, g0.x),
		std.mul(std.textureSampleLevel(bloomPassLayout.$.source, bloomPassLayout.$.bilinear, uv10, 0).rgb, g1.x),
	);
	const t = std.add(
		std.mul(std.textureSampleLevel(bloomPassLayout.$.source, bloomPassLayout.$.bilinear, uv01, 0).rgb, g0.x),
		std.mul(std.textureSampleLevel(bloomPassLayout.$.source, bloomPassLayout.$.bilinear, uv11, 0).rgb, g1.x),
	);
	return std.add(std.mul(s, g0.y), std.mul(t, g1.y));
});

/** bicubic upsample blended towards the coarser level by scatter */
export const fsBloomUp = tgpu.fragmentFn({
	in: { uv: d.vec2f },
	out: d.vec4f,
})((input) => {
	'use gpu';
	const near = std.textureSampleLevel(bloomUpLayout.$.high, bloomPassLayout.$.bilinear, input.uv, 0).rgb;
	return d.vec4f(std.mix(near, bicubic(input.uv), postUniformLayout.$.post.bloomShape.y), 1);
});
