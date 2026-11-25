/**
 * falling snow flakes with wind flutter and vertical-occlusion ground collision (`HGRP/Rain/SceneEffectRain`
 * with `SNOW_FLAKE` + `SNOW_COLLISION`).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout } from '../frame/frame-core.ts';
import { LUMINANCE_ROUNDED } from '../shaders/common/luminance.ts';

import { weatherExposed, weatherLitColor, weatherParamsLayout } from './weather-common.ts';

const SnowOut = {
	position: d.builtin.position,
	rel: d.vec3f,
	uv: d.vec4f,
	fade: d.vec2f,
	normal: d.vec3f,
	tangent: d.vec3f,
};

/** vertex entrypoint placing, fluttering, and colliding falling snowflakes */
export const vsSnow = tgpu.vertexFn({
	in: {
		center: d.location(0, d.vec3f),
		corner: d.location(1, d.vec2f),
		rand: d.location(2, d.vec3f),
	},
	out: SnowOut,
})((input) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const weather = weatherParamsLayout.$.weather;
	if (input.rand.y > weather.params0.w) {
		return {
			position: d.vec4f(0, 0, 2, 1),
			rel: d.vec3f(0),
			uv: d.vec4f(0),
			fade: d.vec2f(0),
			normal: d.vec3f(0),
			tangent: d.vec3f(0),
		};
	}
	const range = weather.params2.x;
	const maxH = weather.params2.y;
	const span = d.vec3f(range * 2, maxH * 2, range * 2);
	const halfSpan = d.vec3f(range, maxH, range);
	const eye = frame.eye.xyz;
	const grid = std.mul(std.floor(std.div(eye, span)), span);
	const eyeInCell = std.sub(eye, grid);

	const r = std.sub(std.mul(input.rand, 2), d.vec3f(1));
	const dirWave = std.sin(std.mul(std.fract(std.add(d.vec3f(weather.params4.y), r)), 2 * Math.PI));
	const dirMod = std.saturate(
		std.sub(d.vec3f(1), std.mul(std.add(std.mul(dirWave, 0.2), d.vec3f(0.6)), 0.5 * weather.params1.w)),
	);
	const snowDir = std.normalize(
		d.vec3f(weather.params1.x * dirMod.x, weather.params1.y, weather.params1.z * dirMod.y),
	);
	const fallAxis = std.neg(snowDir);

	const wrapped = std.mul(
		std.sub(
			std.mul(std.fract(std.add(std.add(std.mul(input.center, 0.5), d.vec3f(0.5)), weather.params4.xyz)), 2),
			d.vec3f(1),
		),
		halfSpan,
	);
	const worldY = wrapped.y + std.step(wrapped.y + maxH, eyeInCell.y) * span.y + grid.y;
	const worldXz = std.add(
		std.add(wrapped.xz, std.mul(std.step(std.add(wrapped.xz, d.vec2f(range)), eyeInCell.xz), span.xz)),
		grid.xz,
	);
	const flakeX = worldXz.x - eye.x;
	const flakeY = worldY - eye.y;
	const flakeZ = worldXz.y - eye.z;

	const occUv = d.vec2f(
		0.5 + (flakeX - weather.occOrigin.x) * weather.occOrigin.w,
		0.5 - (flakeZ - weather.occOrigin.z) * weather.occOrigin.w,
	);
	let surfaceRelY = flakeY - 100;
	if (
		weather.occMetrics.w > 0.5 &&
		std.all(std.gt(occUv, d.vec2f(0))) &&
		std.all(std.lt(occUv, d.vec2f(1)))
	) {
		const rawDepth = std.textureSampleLevel(
			weatherParamsLayout.$.verticalOcclusion,
			weatherParamsLayout.$.verticalOcclusionRaw,
			occUv,
			0,
		);
		if (rawDepth < 0.9999) {
			surfaceRelY = weather.occOrigin.y - rawDepth * weather.occMetrics.y;
		}
	}

	const above = flakeY - surfaceRelY;
	const airK = std.saturate(above * 2);
	const aboveJitter = above * (1 + r.x * 0.2);
	const landed = std.step(aboveJitter, 1);
	const flying = 1 - landed;
	const clampedY = std.max(surfaceRelY + weather.params0.z * 0.5, flakeY);
	const flakeRel = d.vec3f(flakeX, clampedY, flakeZ);

	const upAxis = std.normalize(std.mix(d.vec3f(0, 1, 0), fallAxis, airK));
	const refV = std.select(d.vec3f(1, 0, 0), d.vec3f(0, 0, 1), std.abs(upAxis.x) > 0.99);
	const uAxis = std.normalize(std.cross(refV, upAxis));
	const vAxis = std.cross(uAxis, upAxis);

	const worldH = clampedY + eye.y;
	const ph1 = 2 * Math.PI * std.fract(worldH * 0.0175 + r.x);
	const ph2 = 2 * Math.PI * std.fract(worldH * 0.007 + r.z);
	const amp = weather.params1.w * std.dot(d.vec3f(1), std.abs(r)) * flying;
	const posRel = std.add(
		flakeRel,
		std.mul(
			std.add(std.mul(vAxis, std.cos(ph1) - std.cos(ph2)), std.mul(uAxis, std.sin(ph1) - std.sin(ph2))),
			amp,
		),
	);

	const toCam = std.neg(std.normalize(posRel));
	const size = std.mix(weather.params0.y, weather.params0.z, input.rand.x);
	const right = std.normalize(std.cross(toCam, upAxis));
	const up = std.cross(right, toCam);
	const stretch = std.mix(0, weather.params4.w, airK) * (1 - std.abs(std.dot(toCam, upAxis)));

	const vertRel = std.add(
		std.add(posRel, std.mul(right, input.corner.x * size)),
		std.mul(up, input.corner.y * (size + stretch)),
	);
	const quadUv = std.saturate(input.corner);
	const nearFade = std.smoothstep(0.5, 1.5, std.length(posRel));
	const collisionFade =
		(1 - std.saturate(-above * 0.2 * weather.params2.w)) * std.saturate(std.abs(aboveJitter - 1) * 10 - 0.1);

	return {
		position: std.mul(frame.viewProj, d.vec4f(vertRel, 1)),
		rel: vertRel,
		uv: d.vec4f(quadUv, std.add(quadUv, std.mul(r.xy, 2))),
		fade: d.vec2f(nearFade, collisionFade),
		normal: toCam,
		tangent: std.neg(right),
	};
});

/** fragment entrypoint shading falling snowflakes */
export const fsSnow = tgpu.fragmentFn({
	in: SnowOut,
	out: d.vec4f,
})((input) => {
	'use gpu';
	const weather = weatherParamsLayout.$.weather;
	const tex = std.textureSample(
		weatherParamsLayout.$.weatherTex,
		weatherParamsLayout.$.weatherSampler,
		std.mul(input.uv.zw, weather.params3.xy),
	);
	const radial = 1 - std.smoothstep(0, 0.4, std.length(std.sub(d.vec2f(0.5), input.uv.xy)));
	const exposed = weatherExposed(input.rel);
	const mask = (weather.params3.z + weather.params3.w * (tex.x * 2 - 1)) * (exposed * radial * input.fade.x);
	if (mask <= 0.0005 || input.fade.y <= 0.0005) {
		std.discard();
	}

	const lightingPct = weather.params2.z;
	let rgb = d.vec3f(weather.color.xyz);
	let alpha = mask;
	if (lightingPct > 0.001) {
		const angle = std.abs(input.uv.x - 0.5) * Math.PI;
		const tsN = std.normalize(d.vec3f(std.sin(angle + tex.x), 0.01, std.cos(angle + tex.y)));
		const bitangent = std.cross(input.normal, input.tangent);
		const n = std.normalize(
			std.add(
				std.add(std.mul(input.tangent, tsN.x), std.mul(bitangent, tsN.y)),
				std.mul(input.normal, tsN.z),
			),
		);
		const v = std.neg(std.normalize(input.rel));
		const lit = weatherLitColor(input.rel, n, v, input.position.xy, weather.color.xyz);
		const radialCube = radial * radial * radial;
		const litAlpha = std.dot(LUMINANCE_ROUNDED.$, lit) * radialCube * radialCube * mask;
		rgb = std.mix(weather.color.xyz, lit, lightingPct);
		alpha = std.mix(mask, litAlpha, lightingPct);
	}
	return d.vec4f(rgb, std.saturate(alpha * weather.color.w * input.fade.y));
});
