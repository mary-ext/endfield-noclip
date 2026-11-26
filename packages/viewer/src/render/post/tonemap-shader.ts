/**
 * tonemap shader: contrast-adaptive sharpening, exposure, bloom composite, vignette, URP/ACEScg colour
 * grading, modified ACES / PBR Neutral tonemapping, sRGB encoding, and dither.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { postUniformLayout } from '../core/post-schema.ts';
import { hsvToRgb, gradientNoise } from '../core/shader-math.ts';

/** group 1 bind group layout for the tonemap pass */
export const tonemapLayout = tgpu.bindGroupLayout({
	scene: { texture: d.texture2d(d.f32) },
	bloom: { texture: d.texture2d(d.f32) },
	bilinear: { sampler: 'filtering' },
});

const LIN_TO_LMS = tgpu.const(
	d.mat3x3f,
	d.mat3x3f(
		d.vec3f(0.390405, 0.549941, 0.00892632),
		d.vec3f(0.0708416, 0.963172, 0.00135775),
		d.vec3f(0.0231082, 0.128021, 0.936245),
	),
);

const LMS_TO_LIN = tgpu.const(
	d.mat3x3f,
	d.mat3x3f(
		d.vec3f(2.85847, -1.62879, -0.024891),
		d.vec3f(-0.210182, 1.1582, 0.000324281),
		d.vec3f(-0.041812, -0.118169, 1.06867),
	),
);

const SRGB_TO_AP0 = tgpu.const(
	d.mat3x3f,
	d.mat3x3f(
		d.vec3f(0.439701, 0.382978, 0.177335),
		d.vec3f(0.0897923, 0.813423, 0.0967616),
		d.vec3f(0.017544, 0.111544, 0.870704),
	),
);

const AP0_TO_AP1 = tgpu.const(
	d.mat3x3f,
	d.mat3x3f(
		d.vec3f(1.4514393, -0.23651075, -0.21492857),
		d.vec3f(-0.07655377, 1.1762297, -0.09967592),
		d.vec3f(0.00831615, -0.00603245, 0.9977163),
	),
);

const AP1_TO_SRGB = tgpu.const(
	d.mat3x3f,
	d.mat3x3f(
		d.vec3f(1.7050515, -0.6217907, -0.08325868),
		d.vec3f(-0.13025714, 1.1408029, -0.01054819),
		d.vec3f(-0.02400327, -0.12896878, 1.1529716),
	),
);

const AP1_LUMINANCE = tgpu.const(d.vec3f, d.vec3f(0.272229, 0.674082, 0.0536895));
/** the LUT's LogC encoding saturates here (linear) */
const LUT_MAX = 58.85;

/** Adobe's soft light, as URP's split toning blends */
const softLight = tgpu.fn(
	[d.vec3f, d.vec3f],
	d.vec3f,
)((base, blend) => {
	'use gpu';
	const r1 = std.add(
		std.mul(std.mul(2, base), blend),
		std.mul(std.mul(base, base), std.sub(d.vec3f(1), std.mul(2, blend))),
	);
	const r2 = std.add(
		std.mul(std.sqrt(base), std.sub(std.mul(2, blend), d.vec3f(1))),
		std.mul(std.mul(2, base), std.sub(d.vec3f(1), blend)),
	);
	return std.select(r1, r2, std.ge(blend, d.vec3f(0.5)));
});

const rgbToHsv = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((c) => {
	'use gpu';
	const k = d.vec4f(0, -1 / 3, 2 / 3, -1);
	const p = std.mix(d.vec4f(c.bg, k.wz), d.vec4f(c.gb, k.xy), std.step(c.b, c.g));
	const q = std.mix(d.vec4f(p.xyw, c.r), d.vec4f(c.r, p.yzx), std.step(p.x, c.r));
	const diff = q.x - std.min(q.w, q.y);
	const e = 1e-4;
	return d.vec3f(std.abs(q.z + (q.w - q.y) / (6 * diff + e)), diff / (q.x + e), q.x);
});

/** linear sRGB in, graded ACEScg out (>= 0) */
const grade = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((linear) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	// white balance in LMS, then into ACEScg
	let c = std.mul(std.mul(linear, LIN_TO_LMS.$), post.colorBalance.xyz);
	c = std.mul(std.mul(std.mul(c, LMS_TO_LIN.$), SRGB_TO_AP0.$), AP0_TO_AP1.$);
	// HG's contrast: a power of luminance around 0.18
	c = std.mul(c, std.pow(std.max(std.dot(c, AP1_LUMINANCE.$), 1e-6) / 0.18, post.hueSatCon.z - 1));
	c = std.max(d.vec3f(0), std.mul(c, post.colorFilter.xyz));
	// split toning in gamma space
	{
		let g = std.pow(c, d.vec3f(1 / 2.2));
		const t = std.clamp(
			std.dot(std.clamp(g, d.vec3f(0), d.vec3f(1)), AP1_LUMINANCE.$) + post.splitShadows.w,
			0,
			1,
		);
		g = softLight(g, std.mix(d.vec3f(0.5), post.splitShadows.xyz, 1 - t));
		g = softLight(g, std.mix(d.vec3f(0.5), post.splitHighlights.xyz, t));
		c = std.pow(std.abs(g), d.vec3f(2.2));
	}
	c = d.vec3f(std.dot(c, post.mixerRed.xyz), std.dot(c, post.mixerGreen.xyz), std.dot(c, post.mixerBlue.xyz));
	// shadows, midtones, highlights
	{
		const luma = std.dot(c, AP1_LUMINANCE.$);
		const s = std.smoothstep(post.shaHiLimits.x, post.shaHiLimits.y, luma);
		const h = std.smoothstep(post.shaHiLimits.z, post.shaHiLimits.w, luma);
		c = std.add(
			std.add(std.mul(std.mul(c, post.shadows.xyz), 1 - s), std.mul(std.mul(c, post.midtones.xyz), s - h)),
			std.mul(std.mul(c, post.highlights.xyz), h),
		);
	}
	// lift, gamma, gain
	c = std.add(std.mul(c, post.gain.xyz), post.lift.xyz);
	c = std.mul(std.sign(c), std.pow(std.abs(c), post.gamma.xyz));
	// hue shift and saturation
	{
		const hsv = rgbToHsv(c);
		hsv.x = std.fract(hsv.x + post.hueSatCon.x);
		c = hsvToRgb(hsv);
		const luma = std.dot(c, AP1_LUMINANCE.$);
		c = std.add(d.vec3f(luma), std.mul(post.hueSatCon.y, std.sub(c, d.vec3f(luma))));
	}
	// neutral curves pass the colour through, minus negatives
	return std.max(c, d.vec3f(0));
});

/** the game's modified ACES: graded ACEScg in, display-linear sRGB out */
const acesModified = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((x) => {
	'use gpu';
	const num = std.mul(x, std.add(std.mul(x, 2.785085), d.vec3f(0.107772)));
	const den = std.add(std.mul(x, std.add(std.mul(x, 2.936045), d.vec3f(0.887122))), d.vec3f(0.806889));
	const fit = std.mul(num, std.clamp(std.div(d.vec3f(1), den), d.vec3f(1e-4), d.vec3f(1e4)));
	let y = std.clamp(fit, d.vec3f(0), d.vec3f(1));
	y = std.mul(std.mix(d.vec3f(std.dot(y, AP1_LUMINANCE.$)), y, 0.93), AP1_TO_SRGB.$);
	// bright colours blend towards their hue at full brightness
	const peak = std.clamp(std.div(y, std.max(std.max(std.max(y.r, y.g), y.b), 1e-5)), d.vec3f(0), d.vec3f(1));
	const blend = std.clamp((std.dot(x, AP1_LUMINANCE.$) - 0.5) * (2 / 3), 0, 1);
	return std.clamp(std.mix(y, peak, blend), d.vec3f(0), d.vec3f(1));
});

/** Khronos PBR Neutral */
const pbrNeutral = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((color) => {
	'use gpu';
	const start = 0.8 - 0.04;
	const desaturation = 0.15;
	const x = std.min(color.r, std.min(color.g, color.b));
	const offset = std.select(0.04, x - 6.25 * x * x, x < 0.08);
	let c = std.sub(color, d.vec3f(offset));
	const peak = std.max(c.r, std.max(c.g, c.b));
	if (peak < start) {
		return c;
	}
	const diff = 1 - start;
	const newPeak = 1 - (diff * diff) / (peak + diff - start);
	c = std.mul(c, newPeak / peak);
	const g = 1 - 1 / (desaturation * (peak - newPeak) + 1);
	return std.mix(c, d.vec3f(newPeak), g);
});

const srgbEncode = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((c) => {
	'use gpu';
	const low = std.mul(c, 12.92);
	const high = std.sub(std.mul(1.055, std.pow(c, d.vec3f(1 / 2.4))), d.vec3f(0.055));
	return std.select(high, low, std.le(c, d.vec3f(0.0031308)));
});

const casCompress = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((c) => {
	'use gpu';
	return std.div(c, 1 + std.max(c.r, std.max(c.g, c.b)));
});

/** fragment entrypoint for the final tonemapping pass */
export const fsTonemap = tgpu.fragmentFn({
	in: {
		position: d.builtin.position,
		uv: d.vec2f,
	},
	out: d.vec4f,
})((input) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const px = d.vec2i(input.position.xy);
	let color = std.textureLoad(tonemapLayout.$.scene, px, 0).rgb;
	// contrast-adaptive sharpening after TAA (game uses 0.3), evaluated in Reinhard-compressed space so HDR
	// highlights do not ring
	if (post.jitter.z > 0) {
		const maxPx = std.sub(d.vec2i(std.textureDimensions(tonemapLayout.$.scene, 0)), d.vec2i(1));
		const tc = casCompress(color);
		const tn = casCompress(
			std.textureLoad(tonemapLayout.$.scene, std.clamp(std.add(px, d.vec2i(0, -1)), d.vec2i(0), maxPx), 0)
				.rgb,
		);
		const ts = casCompress(
			std.textureLoad(tonemapLayout.$.scene, std.clamp(std.add(px, d.vec2i(0, 1)), d.vec2i(0), maxPx), 0).rgb,
		);
		const tw = casCompress(
			std.textureLoad(tonemapLayout.$.scene, std.clamp(std.add(px, d.vec2i(-1, 0)), d.vec2i(0), maxPx), 0)
				.rgb,
		);
		const te = casCompress(
			std.textureLoad(tonemapLayout.$.scene, std.clamp(std.add(px, d.vec2i(1, 0)), d.vec2i(0), maxPx), 0).rgb,
		);
		const mn = std.min(tc, std.min(std.min(tn, ts), std.min(tw, te)));
		const mx = std.max(tc, std.max(std.max(tn, ts), std.max(tw, te)));
		const amp = std.sqrt(
			std.clamp(
				std.div(std.min(mn, std.sub(d.vec3f(1), mx)), std.max(mx, d.vec3f(1e-4))),
				d.vec3f(0),
				d.vec3f(1),
			),
		);
		const w = std.mul(amp, -post.jitter.z * 0.25);
		const neighbours = std.add(std.add(tn, ts), std.add(tw, te));
		const sharp = std.clamp(
			std.div(std.add(tc, std.mul(neighbours, w)), std.add(d.vec3f(1), std.mul(4, w))),
			d.vec3f(0),
			d.vec3f(0.9999),
		);
		color = std.div(sharp, std.max(1 - std.max(sharp.r, std.max(sharp.g, sharp.b)), 1e-4));
	}
	color = std.mul(color, post.grade.x);
	// the game's composite: adds the bloom scaled by its intensity; blend modes other than add take the
	// scene's above-threshold part out by the same factor, add mode compresses bloom past 0.3 instead
	if (post.flags.w !== 0) {
		const subtract = post.bloomShape.x;
		const brightness = std.max(color.r, std.max(color.g, color.b));
		const soft = std.clamp(brightness - post.bloom.y, 0, post.bloom.z);
		const above = std.mul(
			color,
			std.max(post.bloom.w * soft * soft, brightness - post.bloom.x) / std.max(brightness, 1e-4),
		);
		let bloom = std.textureSampleLevel(tonemapLayout.$.bloom, tonemapLayout.$.bilinear, input.uv, 0).rgb;
		const compressed = std.sub(std.mul(std.pow(bloom, d.vec3f(0.33)), 1.4938), d.vec3f(0.7));
		bloom = std.select(bloom, compressed, std.gt(std.mul(bloom, 1 - subtract), d.vec3f(0.3)));
		color = std.add(
			color,
			std.mul(std.sub(std.mul(bloom, post.bloomTint.rgb), std.mul(above, subtract)), post.bloomTint.w),
		);
	}
	// URP's vignette, in HDR before grading as the game's uber pass applies it
	if (post.grade.y > 0) {
		let dist = std.mul(std.abs(std.sub(input.uv, post.vignetteCenter.xy)), post.grade.y * 3);
		if (post.vignetteCenter.z > 0.5) {
			dist.x *= post.viewport.x * post.viewport.w;
		}
		const roundness = (1 - post.vignetteColor.w) * 6 + post.vignetteColor.w;
		dist = std.pow(std.clamp(dist, d.vec2f(0), d.vec2f(1)), d.vec2f(roundness));
		const factor = std.pow(std.clamp(1 - std.dot(dist, dist), 0, 1), post.grade.z * 5);
		color = std.mul(color, std.mix(post.vignetteColor.rgb, d.vec3f(1), factor));
	}
	switch (d.u32(post.grade.w)) {
		case 0: {
			color = acesModified(
				grade(std.clamp(std.mul(color, post.colorBalance.w), d.vec3f(0), d.vec3f(LUT_MAX))),
			);
			break;
		}
		case 1: {
			const graded = grade(std.clamp(std.mul(color, post.colorBalance.w), d.vec3f(0), d.vec3f(LUT_MAX)));
			color = pbrNeutral(std.max(std.mul(graded, AP1_TO_SRGB.$), d.vec3f(0)));
			break;
		}
		default: {
			color = std.clamp(color, d.vec3f(0), d.vec3f(1));
			break;
		}
	}
	// +-half a step of dither against banding in the sky
	const noise = (gradientNoise(std.add(input.position.xy, d.vec2f(post.eye.w * 5.588238))) - 0.5) / 255;
	return d.vec4f(std.add(srgbEncode(color), d.vec3f(noise)), 1);
});
