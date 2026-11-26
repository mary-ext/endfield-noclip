/**
 * near-camera falling rain streaks (`HGRP/Rain/SceneEffectRain`).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout } from '../core/frame-core.ts';
import { LUMINANCE_ROUNDED } from '../core/shader-math.ts';

import { weatherExposed, weatherLitColor, weatherParamsLayout } from './weather-common.ts';

const RainOut = {
	position: d.builtin.position,
	rel: d.vec3f,
	uv: d.vec4f,
	fade: d.f32,
	normal: d.vec3f,
	tangent: d.vec3f,
};

/** vertex entrypoint placing and billboarding near-camera falling rain streaks */
export const vsRain = tgpu.vertexFn({
	in: {
		center: d.location(0, d.vec3f),
		corner: d.location(1, d.vec2f),
		rand: d.location(2, d.vec3f),
	},
	out: RainOut,
})((input) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const weather = weatherParamsLayout.$.weather;
	if (input.rand.y > weather.params0.w) {
		return {
			position: d.vec4f(0, 0, 2, 1),
			rel: d.vec3f(0),
			uv: d.vec4f(0),
			fade: 0,
			normal: d.vec3f(0),
			tangent: d.vec3f(0),
		};
	}
	const range = weather.params2.x;
	const span = range * 2;
	const eyeXz = frame.eye.xz;
	const grid = std.mul(std.floor(std.div(eyeXz, span)), span);
	const localXz = std.mul(input.center.xz, range);
	const wrapXz = std.add(
		std.add(localXz, std.mul(std.step(std.add(localXz, d.vec2f(range)), std.sub(eyeXz, grid)), span)),
		grid,
	);
	const baseRel = d.vec3f(wrapXz.x - eyeXz.x, 0, wrapXz.y - eyeXz.y);

	const toTop = std.sub(weather.params1.xyz, baseRel);
	const distTop = std.length(toTop);
	const halfTravel = distTop * 0.8;
	const axis = std.div(toTop, std.max(distTop, 1e-5));
	const refV = std.select(d.vec3f(1, 0, 0), d.vec3f(0, 0, 1), std.abs(axis.x) > 0.99);
	const uAxis = std.normalize(std.cross(refV, axis));
	const vAxis = std.cross(uAxis, axis);

	const tFall = std.fract(input.center.y - weather.params0.x);
	const tPhase = weather.params0.x + input.center.y;
	const r = std.sub(std.mul(input.rand, 2), d.vec3f(1));
	const jitterAmp = weather.params1.w * r.y * range;
	const a1 = 2 * Math.PI * (tPhase * 0.5 + r.x);
	const a2 = 2 * Math.PI * (tPhase * 0.2 + r.z);
	const c1 = std.cos(a1) * r.x;
	const s1 = std.sin(a1) * r.x;
	const c2 = std.cos(a2) * r.z;
	const s2 = std.sin(a2) * r.z;

	const dropRel = std.add(
		std.add(
			std.add(baseRel, std.mul(vAxis, (c1 + s1) * jitterAmp)),
			std.mul(uAxis, (s2 + c2) * jitterAmp * 2),
		),
		std.mul(axis, (tFall * 2 - 1) * halfTravel),
	);

	const vel = std.add(
		std.add(
			std.mul(vAxis, (-Math.PI * s1 + Math.PI * c1) * jitterAmp),
			std.mul(uAxis, (0.4 * Math.PI * c2 - 0.4 * Math.PI * s2) * jitterAmp),
		),
		std.mul(axis, -1.6 * distTop * tFall),
	);
	const velDir = std.mul(vel, std.inverseSqrt(std.max(1e-20, std.dot(vel, vel))));

	const dCam = std.length(dropRel);
	const pxWidth = (dCam / std.max(frame.viewport.z, 1)) * (3 + weather.params2.w) * 0.5;
	const minW = std.max(pxWidth, weather.params0.y);
	const nearK = 1 - std.saturate(dCam);
	const w = std.mix(minW, minW * 15, nearK);
	const h = std.mix(weather.params0.z, weather.params0.z * 7.5, nearK);

	const baseDir = std.mul(baseRel, std.inverseSqrt(std.max(1e-20, std.dot(baseRel, baseRel))));
	const camFwd = d.vec3f(frame.viewForward.x, 0, frame.viewForward.z);
	const faceMixed = std.mix(camFwd, baseDir, std.smoothstep(0.4 * range, range, dCam));
	const faceFlat = d.vec3f(faceMixed.x, 0, faceMixed.z);
	const faceDir = std.mul(faceFlat, std.inverseSqrt(std.max(1e-20, std.dot(faceFlat, faceFlat))));
	const right = std.normalize(std.cross(faceDir, velDir));
	const normal = std.cross(velDir, right);

	const vertRel = std.add(
		std.add(dropRel, std.mul(right, input.corner.x * w)),
		std.mul(velDir, input.corner.y * h),
	);
	const quadUv = std.saturate(input.corner);
	return {
		position: std.mul(frame.viewProj, d.vec4f(vertRel, 1)),
		rel: vertRel,
		uv: d.vec4f(
			quadUv,
			std.sub(std.mul(quadUv, d.vec2f(w * 2, h)), d.vec2f(r.x, (tFall + r.y) * halfTravel)),
		),
		fade: std.smoothstep(0.5, 1.5, dCam),
		normal,
		tangent: std.neg(right),
	};
});

/** fragment entrypoint shading near-camera rain streaks */
export const fsRain = tgpu.fragmentFn({
	in: RainOut,
	out: d.vec4f,
})((input) => {
	'use gpu';
	const weather = weatherParamsLayout.$.weather;
	const tex = std.textureSample(
		weatherParamsLayout.$.weatherTex,
		weatherParamsLayout.$.weatherSampler,
		std.mul(input.uv.zw, weather.params3.xy),
	);
	const edge2 = std.saturate(std.mul(std.sub(d.vec2f(0.5), std.abs(std.sub(d.vec2f(0.5), input.uv.xy))), 2));
	const edge = edge2.x * edge2.y;
	const exposed = weatherExposed(input.rel);
	const mask = (weather.params3.z + weather.params3.w * (tex.x * 2 - 1)) * (exposed * edge * input.fade);
	if (mask <= 0.0005) {
		std.discard();
	}

	const angle = std.abs(input.uv.x - 0.5) * Math.PI;
	const tsN = std.normalize(d.vec3f(std.sin(angle + tex.x), 0.01, std.cos(angle + tex.y)));
	const bitangent = std.cross(input.normal, input.tangent);
	const n = std.normalize(
		std.add(std.add(std.mul(input.tangent, tsN.x), std.mul(bitangent, tsN.y)), std.mul(input.normal, tsN.z)),
	);

	const lightingPct = weather.params2.z;
	let rgb = d.vec3f(weather.color.xyz);
	let alpha = mask;
	if (lightingPct > 0.001) {
		const v = std.neg(std.normalize(input.rel));
		const lit = weatherLitColor(input.rel, n, v, input.position.xy, weather.color.xyz);
		const edgeCube = edge * edge * edge;
		const litAlpha = std.dot(LUMINANCE_ROUNDED.$, lit) * edgeCube * edgeCube * mask;
		rgb = std.mix(weather.color.xyz, lit, lightingPct);
		alpha = std.mix(mask, litAlpha, lightingPct);
	}
	return d.vec4f(rgb, std.saturate(alpha * weather.color.w));
});
