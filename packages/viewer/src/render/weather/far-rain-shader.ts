/**
 * middle rain, far rain curtains, and distant rain waves (`HGRP/Rain/FarRain`).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout } from '../core/frame-core.ts';
import { viewDepth } from '../core/post-schema.ts';
import { fogOver, froxelsAt } from '../sky/fog-shader.ts';

import {
	weatherExposed,
	weatherFogDepthLayout,
	weatherLitColor,
	weatherParamsLayout,
} from './weather-common.ts';

const FarRainOut = {
	position: d.builtin.position,
	rel: d.vec3f,
	uv: d.vec2f,
};

/** vertex entrypoint positioning a tilted rain-curtain cylinder around the camera */
export const vsFarRain = tgpu.vertexFn({
	in: {
		pos: d.location(0, d.vec3f),
		uv: d.location(1, d.vec2f),
	},
	out: FarRainOut,
})((input) => {
	'use gpu';
	const weather = weatherParamsLayout.$.weather;
	const rel = std.add(
		std.add(std.mul(weather.basis0.xyz, input.pos.x), std.mul(weather.basis1.xyz, input.pos.y)),
		std.mul(weather.basis2.xyz, input.pos.z),
	);
	return {
		position: std.mul(frameLayout.$.frame.viewProj, d.vec4f(rel, 1)),
		rel,
		uv: d.vec2f(input.uv),
	};
});

/** fragment entrypoint shading distant rain waves or procedural middle/far rain streaks */
export const fsFarRain = tgpu.fragmentFn({
	in: FarRainOut,
	out: d.vec4f,
})((input) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const weather = weatherParamsLayout.$.weather;
	const dist = std.length(input.rel);
	const dir = std.div(input.rel, std.max(dist, 1e-5));
	const myViewZ = std.dot(input.rel, frame.viewForward.xyz);
	const px = d.vec2i(input.position.xy);
	const sceneD = std.textureLoad(weatherFogDepthLayout.$.sceneDepth, px, 0);
	const sceneViewZ = std.select(d.f32(1e6), viewDepth(sceneD), sceneD > 0);
	const screenUv = std.div(input.position.xy, frame.renderSize.xy);
	const exposed = weatherExposed(input.rel);

	if (weather.params2.x > 0.5) {
		const uv0 = std.add(
			std.add(
				std.mul(
					d.vec2f(std.abs(std.fract(input.uv.x + weather.params0.x) - 0.5) * 2, input.uv.y),
					weather.params3.xy,
				),
				weather.params3.zw,
			),
			d.vec2f(0, weather.params0.y),
		);
		const uv1 = std.add(
			std.add(
				std.mul(
					d.vec2f(std.abs(std.fract(input.uv.x + weather.params0.z) - 0.5) * 2, input.uv.y),
					weather.params4.xy,
				),
				weather.params4.zw,
			),
			d.vec2f(0, weather.params0.w),
		);
		const s0 = std.textureSampleLevel(
			weatherParamsLayout.$.weatherTex,
			weatherParamsLayout.$.weatherSampler,
			uv0,
			0,
		).x;
		const s1 = std.textureSampleLevel(
			weatherParamsLayout.$.weatherTex,
			weatherParamsLayout.$.weatherSampler,
			uv1,
			0,
		).y;
		const topFade = 1 - std.smoothstep(10, 130, std.max(input.rel.y, 0));
		const botEnd = std.mix(129.9, 10, weather.params2.y);
		const botFade = 1 - std.smoothstep(botEnd, 130, std.max(-input.rel.y, 0));
		const wave = s0 * s1 * std.saturate(topFade * botFade);
		if (wave <= 0.0005) {
			std.discard();
		}
		const occRange = std.max(weather.params1.w, 1);
		const xzDist = std.max(std.abs(input.rel.x), std.abs(input.rel.z));
		const occOpen = std.mix(exposed, 1, std.smoothstep(0.7 * occRange, 0.75 * occRange, xzDist));
		const depthFade = std.saturate(std.max(sceneViewZ - myViewZ, 0) * 0.1);
		const alpha = std.saturate(wave * occOpen * depthFade * weather.color.w);
		if (alpha <= 0.0005) {
			std.discard();
		}
		const froxels = froxelsAt(
			weatherFogDepthLayout.$.froxels,
			weatherFogDepthLayout.$.lutSampler,
			screenUv,
			myViewZ,
		);
		const fog = fogOver(dir, dist, froxels);
		return d.vec4f(std.add(std.mul(weather.color.xyz, fog.transmittance), fog.inscatter), alpha);
	}

	const p = std.mul(input.uv, weather.params1.xy);
	const colH = std.fract(std.floor(p.x) * 0.011);
	const colT = colH * (colH + 7.5);
	const colRand = std.fract(colT * (colT + colT));
	const speedVar = 0.5 * colRand;
	const rows = std.floor(weather.params1.y * (1 + speedVar));
	const scrolled = d.vec2f(p.x, p.y + (weather.params0.x + 0.5 + speedVar) * rows);
	const cell = std.floor(scrolled);
	const wrappedCell = std.sub(cell, std.mul(std.trunc(std.div(cell, 1024)), 1024));
	const cellH = std.fract(std.sin(std.dot(wrappedCell, d.vec2f(12.9898, 78.233))) * 43758.546875);
	const jitter = cellH * (std.sin(p.y + colRand * rows) * 0.5 + 0.5);
	const dCenter = std.saturate(
		std.abs(std.sub(d.vec2f(0.5 + (jitter * 2 - 1) * 0.3, 0.5), std.fract(scrolled))),
	);
	const streakLen = std.min(weather.params0.y * 0.4 * (0.4 + colRand * 0.6), 1);
	const densityMask =
		std.step(std.mix(0.65, 1, 1 - weather.params0.z), cellH) * std.smoothstep(0.65, 1, cellH);
	const streakX = 1 - std.smoothstep(0, 0.2, dCenter.x);
	const streakY = 1 - std.smoothstep(std.max(streakLen - 0.2, 0), std.max(streakLen, 0.0005), dCenter.y);
	const topFade = 1 - std.smoothstep(10, 130, std.max(input.rel.y, 0));
	const streak = densityMask * streakX * streakY * topFade;
	if (streak <= 0.0005) {
		std.discard();
	}

	const depthFade = std.saturate(std.max(sceneViewZ - myViewZ - jitter * 7.5, 0) * 0.1);
	const cov = streak * exposed * depthFade;
	const alpha = std.saturate(cov * weather.color.w);
	if (alpha <= 0.0005) {
		std.discard();
	}

	const lightingPct = weather.params1.z;
	let rgb = d.vec3f(weather.color.xyz);
	if (lightingPct > 0.001) {
		const lit = weatherLitColor(input.rel, dir, std.neg(dir), input.position.xy, weather.color.xyz);
		rgb = std.mix(weather.color.xyz, lit, lightingPct * cov);
	}
	const froxels = froxelsAt(
		weatherFogDepthLayout.$.froxels,
		weatherFogDepthLayout.$.lutSampler,
		screenUv,
		myViewZ,
	);
	const fog = fogOver(dir, dist, froxels);
	return d.vec4f(std.add(std.mul(rgb, fog.transmittance), fog.inscatter), alpha);
});
