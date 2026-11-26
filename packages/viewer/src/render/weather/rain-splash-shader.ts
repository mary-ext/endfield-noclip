/**
 * ground rain splashes projected onto exposed surfaces via the vertical occlusion depth map
 * (`HGRP/Rain/RainSplash`).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout } from '../core/frame-core.ts';
import { LUMINANCE_ROUNDED } from '../core/shader-math.ts';

import { weatherLitColor, weatherParamsLayout } from './weather-common.ts';

const SplashOut = {
	position: d.builtin.position,
	rel: d.vec3f,
	uv: d.vec2f,
	info: d.vec2f,
};

/** vertex entrypoint projecting animated flipbook rain splashes onto exposed ground */
export const vsSplash = tgpu.vertexFn({
	in: {
		center: d.location(0, d.vec2f),
		corner: d.location(1, d.vec2f),
		rand: d.location(2, d.vec2f),
	},
	out: SplashOut,
})((input) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const weather = weatherParamsLayout.$.weather;
	if (input.rand.x > weather.params1.w || weather.occMetrics.w < 0.5) {
		return { position: d.vec4f(0, 0, 2, 1), rel: d.vec3f(0), uv: d.vec2f(0), info: d.vec2f(0) };
	}
	const range = weather.params0.x;
	const span = range * 2;
	const t =
		(weather.params0.y + std.fract(input.rand.x * 32)) * (1 + (std.fract(input.rand.y * 128) * 2 - 1) * 0.3);
	const cycle = std.fract(std.floor(t) * 0.1);
	const cycleJitter = std.mul(
		std.sub(
			std.mul(d.vec2f(std.fract(cycle + input.rand.x), std.fract(cycle - input.rand.x)), 2),
			d.vec2f(1),
		),
		0.2,
	);
	const jitterXz = std.mul(
		std.add(std.add(std.mul(input.center, 2), d.vec2f((input.rand.y * 2 - 1) * 0.2)), cycleJitter),
		range,
	);

	const eyeXz = frame.eye.xz;
	const grid = std.mul(std.floor(std.div(eyeXz, span)), span);
	const wrapXz = std.add(
		std.add(jitterXz, std.mul(std.step(std.add(jitterXz, d.vec2f(range)), std.sub(eyeXz, grid)), span)),
		grid,
	);
	const relXz = std.sub(wrapXz, eyeXz);

	const occUv = d.vec2f(
		0.5 + (relXz.x - weather.occOrigin.x) * weather.occOrigin.w,
		0.5 - (relXz.y - weather.occOrigin.z) * weather.occOrigin.w,
	);
	if (std.any(std.le(occUv, d.vec2f(0))) || std.any(std.ge(occUv, d.vec2f(1)))) {
		return { position: d.vec4f(0, 0, 2, 1), rel: d.vec3f(0), uv: d.vec2f(0), info: d.vec2f(0) };
	}
	const rawDepth = std.textureSampleLevel(
		weatherParamsLayout.$.verticalOcclusion,
		weatherParamsLayout.$.verticalOcclusionRaw,
		occUv,
		0,
	);
	if (rawDepth >= 0.9999) {
		return { position: d.vec4f(0, 0, 2, 1), rel: d.vec3f(0), uv: d.vec2f(0), info: d.vec2f(0) };
	}
	const size = std.mix(weather.params0.z, weather.params0.w, input.rand.x);
	const surfaceRelY = weather.occOrigin.y - rawDepth * weather.occMetrics.y + weather.params1.z * size;
	const splashRel = d.vec3f(relXz.x, surfaceRelY, relXz.y);

	const cols = weather.params1.x;
	const invCols = weather.params1.y;
	const totalFrames = cols * cols;
	const frameIdx = std.floor(std.fract(t) * totalFrames);
	const fCol = frameIdx - cols * std.trunc(frameIdx / cols);
	const fRow = cols - 1 - std.floor(frameIdx * invCols);

	const fwdRaw = d.vec3f(frame.viewForward.x, 0, frame.viewForward.z);
	const fwd = std.mul(fwdRaw, std.inverseSqrt(std.max(1e-20, std.dot(fwdRaw, fwdRaw))));
	const right = std.cross(fwd, d.vec3f(0, 1, 0));
	const vertRel = std.add(
		std.add(splashRel, std.mul(right, input.corner.x * size)),
		d.vec3f(0, input.corner.y * size, 0),
	);

	const normD = std.div(splashRel, range);
	const distFade = std.max(1 - std.saturate(std.dot(normD, normD)), 0.5);

	return {
		position: std.mul(frame.viewProj, d.vec4f(vertRel, 1)),
		rel: vertRel,
		uv: std.add(std.mul(std.saturate(input.corner), invCols), d.vec2f(fCol * invCols, fRow * invCols)),
		info: d.vec2f(distFade, std.fract(input.rand.x + cycle)),
	};
});

/** fragment entrypoint shading ground rain splashes */
export const fsSplash = tgpu.fragmentFn({
	in: SplashOut,
	out: d.vec4f,
})((input) => {
	'use gpu';
	const weather = weatherParamsLayout.$.weather;
	const tex = std.textureSampleLevel(
		weatherParamsLayout.$.weatherTex,
		weatherParamsLayout.$.weatherSampler,
		input.uv,
		0,
	);
	const ch = input.info.y * 3;
	const shape = std.mix(std.mix(tex.x, tex.y, std.step(1, ch)), tex.z, std.step(2, ch));
	const baseAlpha = weather.color.w * shape * input.info.x;
	if (baseAlpha <= 0.0005) {
		std.discard();
	}

	const lightingPct = weather.params2.x;
	let rgb = d.vec3f(weather.color.xyz);
	let alpha = baseAlpha;
	if (lightingPct > 0.001) {
		const n = std.neg(std.normalize(input.rel));
		const lit = weatherLitColor(input.rel, n, n, input.position.xy, weather.color.xyz);
		rgb = std.mix(weather.color.xyz, lit, lightingPct * baseAlpha);
		alpha = std.mix(baseAlpha, std.dot(LUMINANCE_ROUNDED.$, lit) * baseAlpha, lightingPct);
	}
	return d.vec4f(rgb, std.saturate(alpha));
});
