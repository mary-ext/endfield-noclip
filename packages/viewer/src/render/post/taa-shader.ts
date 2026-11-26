/**
 * temporal antialiasing with upsampling (TAAU): reconstructs the current frame from the 3x3 jittered
 * neighbourhood with a Blackman-Harris-fit Gaussian, reprojects last frame's output through nearest depth
 * plus dynamic velocity, clips history to the neighbourhood's YCoCg variance box, and blends.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { postUniformLayout, viewDepth, viewRayNdc } from '../core/post-schema.ts';
import { fromYcocg, toYcocg, luminanceRounded } from '../core/shader-math.ts';

/** per-frame TAA uniforms */
export const TaaSchema = d.struct({
	/** last frame's camera-relative view-projection, unjittered */
	previousViewProj: d.mat4x4f,
	/** this frame's eye minus last frame's (m); w = 1 to drop the history (first frame, resize, cut) */
	eyeDelta: d.vec4f,
	/** the main pass's size: width, height, 1 / width, 1 / height (px) */
	input: d.vec4f,
	/** x = new frame's weight in blend, y = 1 to pass current frame through without history, zw unused */
	params: d.vec4f,
});

/** group 1 bind group layout for the TAA resolve pass */
export const taaLayout = tgpu.bindGroupLayout({
	taa: { uniform: TaaSchema },
	current: { texture: d.texture2d(d.f32) },
	depth: { texture: d.textureDepth2d() },
	history: { texture: d.texture2d(d.f32) },
	linearSampler: { sampler: 'filtering' },
	velocity: { texture: d.texture2d(d.f32) },
});

/** how far out the reconstruction filter reaches: a Gaussian fit to Blackman-Harris over output pixels */
const FILTER = 2.29;
/** the clipping box's half size in standard deviations of the neighbourhood */
const CLIP_SIGMA = 1.25;

/** HDR samples weighted down by their brightness at the shown exposure (Karis) */
const compress = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((c) => {
	'use gpu';
	return std.div(c, 1 + luminanceRounded(c) * postUniformLayout.$.post.grade.x);
});

const expand = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((c) => {
	'use gpu';
	return std.div(c, std.max(1 - luminanceRounded(c) * postUniformLayout.$.post.grade.x, 1e-4));
});

/** history at `uv` through a Catmull-Rom filter, from five bilinear taps (corners' weights dropped) */
const sampleHistory = tgpu.fn(
	[d.vec2f],
	d.vec3f,
)((uv) => {
	'use gpu';
	const size = d.vec2f(std.textureDimensions(taaLayout.$.history));
	const p = std.mul(uv, size);
	const t1 = std.add(std.floor(std.sub(p, d.vec2f(0.5))), d.vec2f(0.5));
	const f = std.sub(p, t1);
	const w0 = std.mul(f, std.add(d.vec2f(-0.5), std.mul(f, std.sub(d.vec2f(1), std.mul(0.5, f)))));
	const w1 = std.add(d.vec2f(1), std.mul(std.mul(f, f), std.add(d.vec2f(-2.5), std.mul(1.5, f))));
	const w2 = std.mul(f, std.add(d.vec2f(0.5), std.mul(f, std.sub(d.vec2f(2), std.mul(1.5, f)))));
	const w3 = std.mul(std.mul(f, f), std.add(d.vec2f(-0.5), std.mul(0.5, f)));
	const w12 = std.add(w1, w2);
	const t0 = std.div(std.sub(t1, d.vec2f(1)), size);
	const t3 = std.div(std.add(t1, d.vec2f(2)), size);
	const t12 = std.div(std.add(t1, std.div(w2, w12)), size);
	let sum = std.mul(
		std.textureSampleLevel(taaLayout.$.history, taaLayout.$.linearSampler, d.vec2f(t12.x, t0.y), 0).rgb,
		w12.x * w0.y,
	);
	sum = std.add(
		sum,
		std.mul(
			std.textureSampleLevel(taaLayout.$.history, taaLayout.$.linearSampler, d.vec2f(t0.x, t12.y), 0).rgb,
			w0.x * w12.y,
		),
	);
	sum = std.add(
		sum,
		std.mul(
			std.textureSampleLevel(taaLayout.$.history, taaLayout.$.linearSampler, t12, 0).rgb,
			w12.x * w12.y,
		),
	);
	sum = std.add(
		sum,
		std.mul(
			std.textureSampleLevel(taaLayout.$.history, taaLayout.$.linearSampler, d.vec2f(t3.x, t12.y), 0).rgb,
			w3.x * w12.y,
		),
	);
	sum = std.add(
		sum,
		std.mul(
			std.textureSampleLevel(taaLayout.$.history, taaLayout.$.linearSampler, d.vec2f(t12.x, t3.y), 0).rgb,
			w12.x * w3.y,
		),
	);
	const weight = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
	return std.max(std.div(sum, weight), d.vec3f(0));
});

/** moves `c` towards the box's centre until it lies inside (Playdead's clip) */
const clipToBox = tgpu.fn(
	[d.vec3f, d.vec3f, d.vec3f],
	d.vec3f,
)((c, lo, hi) => {
	'use gpu';
	const center = std.mul(0.5, std.add(lo, hi));
	const extent = std.add(std.mul(0.5, std.sub(hi, lo)), d.vec3f(1e-5));
	const offset = std.sub(c, center);
	const units = std.abs(std.div(offset, extent));
	const reach = std.max(units.x, std.max(units.y, units.z));
	return std.select(c, std.add(center, std.div(offset, reach)), reach > 1);
});

/** fragment entrypoint for temporal antialiasing resolve */
export const fsTaa = tgpu.fragmentFn({
	in: { uv: d.vec2f },
	out: d.vec4f,
})((input) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const taa = taaLayout.$.taa;
	if (taa.params.y > 0.5) {
		return d.vec4f(
			std.textureSampleLevel(taaLayout.$.current, taaLayout.$.linearSampler, input.uv, 0).rgb,
			1,
		);
	}
	// this output pixel's centre in the jittered main-pass image, in its pixels
	const p = std.mul(std.add(input.uv, std.mul(d.vec2f(post.jitter.x, -post.jitter.y), 0.5)), taa.input.xy);
	const size = d.vec2i(taa.input.xy);
	const maxPx = std.sub(size, d.vec2i(1));
	const center = d.vec2i(std.floor(p));
	// output pixels per main-pass pixel
	const ratio = std.mul(d.vec2f(std.textureDimensions(taaLayout.$.history)), taa.input.zw);

	let sum = d.vec3f(0);
	let weight = d.f32(0);
	let nearestWeight = d.f32(0);
	let m1 = d.vec3f(0);
	let m2 = d.vec3f(0);
	let lo = d.vec3f(1e9);
	let hi = d.vec3f(-1e9);
	let nearestDepth = d.f32(0);
	let nearestPx = d.vec2i(center);
	for (let y = -1; y <= 1; y++) {
		for (let x = -1; x <= 1; x++) {
			const px = std.clamp(std.add(center, d.vec2i(x, y)), d.vec2i(0), maxPx);
			const c = compress(std.max(std.textureLoad(taaLayout.$.current, px, 0).rgb, d.vec3f(0)));
			const delta = std.mul(std.sub(std.add(d.vec2f(px), d.vec2f(0.5)), p), ratio);
			const w = std.exp(-FILTER * std.dot(delta, delta));
			sum = std.add(sum, std.mul(c, w));
			weight += w;
			nearestWeight = std.max(nearestWeight, w);
			const ycocg = toYcocg(c);
			m1 = std.add(m1, ycocg);
			m2 = std.add(m2, std.mul(ycocg, ycocg));
			lo = std.min(lo, ycocg);
			hi = std.max(hi, ycocg);
			// reversed-Z: the largest depth is the nearest surface
			const sampleDepth = std.textureLoad(taaLayout.$.depth, px, 0);
			if (sampleDepth > nearestDepth) {
				nearestDepth = sampleDepth;
				nearestPx = d.vec2i(px);
			}
		}
	}
	const current = std.div(sum, std.max(weight, 1e-6));

	// reproject through the nearest depth around the pixel, adding any dynamic object velocity delta
	const ndc = d.vec2f(input.uv.x * 2 - 1, 1 - input.uv.y * 2);
	let previousClip = d.vec4f(0);
	if (nearestDepth <= 0) {
		// the sky: a direction, which the camera's translation doesn't move
		previousClip = std.mul(taa.previousViewProj, d.vec4f(viewRayNdc(ndc), 0));
	} else {
		const rel = std.mul(viewRayNdc(ndc), viewDepth(nearestDepth));
		previousClip = std.mul(taa.previousViewProj, d.vec4f(std.add(rel, taa.eyeDelta.xyz), 1));
	}
	const previousNdc = std.div(previousClip.xy, previousClip.w);
	const staticPrevUv = d.vec2f(previousNdc.x * 0.5 + 0.5, 0.5 - previousNdc.y * 0.5);
	const dynDelta = std.select(
		d.vec2f(0),
		std.textureLoad(taaLayout.$.velocity, nearestPx, 0).rg,
		nearestDepth > 0,
	);
	const previousUv = std.add(staticPrevUv, dynDelta);
	const offscreen = std.any(std.lt(previousUv, d.vec2f(0))) || std.any(std.gt(previousUv, d.vec2f(1)));
	if (taa.eyeDelta.w > 0.5 || previousClip.w <= 0 || offscreen) {
		return d.vec4f(expand(current), 1);
	}

	const mean = std.div(m1, 9);
	const sigma = std.sqrt(std.max(std.sub(std.div(m2, 9), std.mul(mean, mean)), d.vec3f(0)));
	const boxLo = std.max(lo, std.sub(mean, std.mul(CLIP_SIGMA, sigma)));
	const boxHi = std.min(hi, std.add(mean, std.mul(CLIP_SIGMA, sigma)));
	const history = fromYcocg(clipToBox(toYcocg(compress(sampleHistory(previousUv))), boxLo, boxHi));
	// when upsampling, the frame counts for less where none of its samples lands near the pixel
	const confidence = std.saturate(nearestWeight / std.exp(-FILTER * 0.5));
	const blend = taa.params.x * confidence;
	return d.vec4f(expand(std.mix(history, current, blend)), 1);
});
