/**
 * screen-space sun shafts (`HGRP/PostProcessing/LightShaft`): keeps bright far pixels near the sun at reduced
 * size, blurs radially towards the sun over several passes, and adds them back onto the scene.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { viewDepth } from '../core/post-schema.ts';
import { LUMINANCE } from '../core/shader-math.ts';

/** per-frame light shaft uniforms */
export const ShaftsSchema = d.struct({
	/** 1 / occlusion depth range (per m), bloom scale, occlusion mask darkness (unused), bloom max brightness */
	params: d.vec4f,
	/** bloom tint (raw), w = bloom threshold */
	tint: d.vec4f,
	/** sun on screen (uv, 0 at top-left), samples per blur pass, blur intensity */
	sun: d.vec4f,
});

/** shared shafts uniforms and bilinear clamping sampler */
export const lightShaftsSharedLayout = tgpu.bindGroupLayout({
	shafts: { uniform: ShaftsSchema },
	bilinear: { sampler: 'filtering' },
});

/** inputs for the downsample pass */
export const lightShaftsDownsampleLayout = tgpu.bindGroupLayout({
	scene: { texture: d.texture2d(d.f32) },
	depth: { texture: d.textureDepth2d() },
});

/** inputs for each radial blur pass (and apply pass, which only reads `blurSource`) */
export const lightShaftsBlurLayout = tgpu.bindGroupLayout({
	/** x = this blur pass's index; each pass reaches further towards the sun */
	blurPass: { uniform: d.vec4f },
	blurSource: { texture: d.texture2d(d.f32) },
});

/**
 * bloom source at reduced size: pixels brighter than threshold, rescaled to preserve colour, faded toward
 * screen edges and away from the sun, and masked to surfaces beyond half the occlusion depth range.
 */
export const fsLightShaftDownsample = tgpu.fragmentFn({
	in: { uv: d.vec2f },
	out: d.vec4f,
})((input) => {
	'use gpu';
	const shafts = lightShaftsSharedLayout.$.shafts;
	const uv = input.uv;
	const color = std.max(
		std.textureSampleLevel(lightShaftsDownsampleLayout.$.scene, lightShaftsSharedLayout.$.bilinear, uv, 0)
			.rgb,
		d.vec3f(0),
	);
	const edge = 1 - uv.x * (1 - uv.x) * uv.y * (1 - uv.y) * 8;
	const edge2 = edge * edge;
	// the game's own luminance weights, kept off zero
	const luma = std.max(std.dot(color, LUMINANCE.$), 6.1035156e-5);
	const towardSun = 1 - std.clamp(std.length(std.sub(shafts.sun.xy, uv)) * 2, 0, 1);
	const size = d.vec2f(std.textureDimensions(lightShaftsDownsampleLayout.$.depth));
	const texel = d.vec2i(std.clamp(std.mul(uv, size), d.vec2f(0), std.sub(size, d.vec2f(1))));
	const depth = viewDepth(std.textureLoad(lightShaftsDownsampleLayout.$.depth, texel, 0));
	const far = std.clamp((depth - 0.5 / shafts.params.x) * shafts.params.x, 0, 1);
	const bloom = std.mul(
		std.mul(color, (shafts.params.y / luma) * std.clamp(luma - shafts.tint.w, 0, shafts.params.w) * 2),
		shafts.tint.rgb,
	);
	return d.vec4f(std.mul(bloom, far * (1 - edge2 * edge2) * towardSun * towardSun), 1);
});

/** one radial blur pass: mean of evenly spaced samples on the way to the sun */
export const fsLightShaftBlur = tgpu.fragmentFn({
	in: { uv: d.vec2f },
	out: d.vec4f,
})((input) => {
	'use gpu';
	const shafts = lightShaftsSharedLayout.$.shafts;
	const samples = shafts.sun.z;
	const reach = std.min(shafts.sun.w * 0.1 * std.pow(0.4 * samples, lightShaftsBlurLayout.$.blurPass.x), 1);
	const step = std.mul(std.sub(shafts.sun.xy, input.uv), reach / samples);
	let sum = d.vec3f(0);
	for (let i = d.f32(0); i < samples; i += 1) {
		sum = std.add(
			sum,
			std.textureSampleLevel(
				lightShaftsBlurLayout.$.blurSource,
				lightShaftsSharedLayout.$.bilinear,
				std.add(input.uv, std.mul(step, i)),
				0,
			).rgb,
		);
	}
	return d.vec4f(std.div(sum, samples), 1);
});

/** the blurred shafts, added onto the scene by the pipeline's blend */
export const fsLightShaftApply = tgpu.fragmentFn({
	in: { uv: d.vec2f },
	out: d.vec4f,
})((input) => {
	'use gpu';
	return d.vec4f(
		std.textureSampleLevel(
			lightShaftsBlurLayout.$.blurSource,
			lightShaftsSharedLayout.$.bilinear,
			input.uv,
			0,
		).rgb,
		0,
	);
});
