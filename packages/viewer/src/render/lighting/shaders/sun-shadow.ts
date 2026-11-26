/**
 * sun shadow cascade, far shadow map, and cloud shadow TypeGPU helpers.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout } from '../../core/frame-core.ts';
import { gradientNoise } from '../../core/shader-math.ts';

const POISSON = tgpu.const(d.arrayOf(d.vec2f, 16), [
	d.vec2f(-0.94201624, -0.39906216),
	d.vec2f(0.94558609, -0.76890725),
	d.vec2f(-0.0941841, -0.9293887),
	d.vec2f(0.34495938, 0.2938776),
	d.vec2f(-0.91588581, 0.45771432),
	d.vec2f(-0.81544232, -0.87912464),
	d.vec2f(-0.38277543, 0.27676845),
	d.vec2f(0.97484398, 0.75648379),
	d.vec2f(0.44323325, -0.97511554),
	d.vec2f(0.53742981, -0.4737342),
	d.vec2f(-0.26496911, -0.41893023),
	d.vec2f(0.79197514, 0.19090188),
	d.vec2f(-0.2418884, 0.99706507),
	d.vec2f(-0.81409955, 0.9143759),
	d.vec2f(0.19984126, 0.78641367),
	d.vec2f(0.14383161, -0.1410079),
]);

const shadowReceiver = tgpu.fn(
	[d.vec3f, d.vec3f, d.u32],
	d.vec3f,
)((rel, normal, layer) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const texel =
		(2 * std.sqrt(frame.shadowSpheres[layer].w)) / d.f32(std.textureDimensions(frameLayout.$.shadowMap).x);
	const nDotL = std.dot(normal, frame.sun.xyz);
	return std.add(rel, std.mul(normal, texel * 1.5 * (1 - std.max(nDotL, 0) * 0.5)));
});

const cascadeShadow = tgpu.fn(
	[d.vec3f, d.vec3f, d.u32, d.vec2f],
	d.f32,
)((rel, normal, cascade, px) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const p = std.mul(frame.shadowMatrices[cascade], d.vec4f(shadowReceiver(rel, normal, cascade), 1));
	if (std.any(std.le(p.xyz, d.vec3f(0))) || std.any(std.ge(p.xyz, d.vec3f(1)))) {
		return -1;
	}
	const cell = d.vec2u(d.u32(px.x) % d.u32(4), d.u32(px.y) % d.u32(4));
	const angle = d.f32(cell.x * d.u32(4) + cell.y) * ((2 * Math.PI) / 16);
	const cosA = std.cos(angle);
	const sinA = std.sin(angle);
	const rotation = d.mat2x2f(cosA, sinA, -sinA, cosA);
	const radius = frame.shadowPenumbra[cascade];
	let gap = d.f32(0);
	let blockers = d.f32(0);
	for (let k = d.u32(0); k < d.u32(16); k++) {
		const offset = std.mul(std.mul(rotation, POISSON.$[k]), radius);
		const depths = std.textureGather(
			frameLayout.$.shadowMap,
			frameLayout.$.shadowGatherSampler,
			std.add(p.xy, offset),
			cascade,
		);
		const blocked = std.step(depths, d.vec4f(p.z));
		gap += std.dot(std.sub(d.vec4f(p.z), depths), blocked);
		blockers += std.dot(blocked, d.vec4f(1));
	}
	if (blockers === 0) {
		return 1;
	}
	const t = 2 * std.clamp(blockers / 64, 0, 1) - 1;
	const s = std.sign(t);
	const u = 1 - s * t;
	const k = std.clamp(gap / blockers / std.max(1 - p.z, 1e-5), 0, 1);
	return 0.5 - 0.5 * s * (1 - std.mix(u * u * u, u, k));
});

const farShadow = tgpu.fn(
	[d.vec3f, d.vec3f],
	d.f32,
)((rel, normal) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const p = std.mul(frame.shadowMatrices[3], d.vec4f(shadowReceiver(rel, normal, d.u32(3)), 1));
	if (std.any(std.le(p.xyz, d.vec3f(0))) || std.any(std.ge(p.xyz, d.vec3f(1)))) {
		return 1;
	}
	const halfTexel = std.div(d.vec2f(0.5), d.vec2f(std.textureDimensions(frameLayout.$.shadowMap)));
	// 4 hardware-bilinear comparison taps at (±0.5, ±0.5) texels form a 3×3 tent filter
	const sum =
		std.textureSampleCompareLevel(
			frameLayout.$.shadowMap,
			frameLayout.$.shadowSampler,
			std.add(p.xy, d.vec2f(-halfTexel.x, -halfTexel.y)),
			3,
			p.z,
		) +
		std.textureSampleCompareLevel(
			frameLayout.$.shadowMap,
			frameLayout.$.shadowSampler,
			std.add(p.xy, d.vec2f(halfTexel.x, -halfTexel.y)),
			3,
			p.z,
		) +
		std.textureSampleCompareLevel(
			frameLayout.$.shadowMap,
			frameLayout.$.shadowSampler,
			std.add(p.xy, d.vec2f(-halfTexel.x, halfTexel.y)),
			3,
			p.z,
		) +
		std.textureSampleCompareLevel(
			frameLayout.$.shadowMap,
			frameLayout.$.shadowSampler,
			std.add(p.xy, d.vec2f(halfTexel.x, halfTexel.y)),
			3,
			p.z,
		);
	const diff = std.sub(rel, frame.shadowSpheres[3].xyz);
	const edge = std.clamp((1 - std.dot(diff, diff) / frame.shadowSpheres[3].w) * 5, 0, 1);
	return std.mix(1, sum * 0.25, edge);
});

const sunShadow = tgpu.fn(
	[d.vec3f, d.vec3f, d.vec2f],
	d.f32,
)((rel, normal, px) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	if (frame.shadowFade.w < 0.5) {
		return 1;
	}
	const near = std.clamp((frame.shadowFade.x - std.dot(rel, rel)) * frame.shadowFade.y, 0, 1);
	let sharp = d.f32(-1);
	if (near > 0) {
		let cascade = d.u32(3);
		for (let i = d.u32(0); i < d.u32(3); i++) {
			const diff = std.sub(rel, frame.shadowSpheres[i].xyz);
			if (std.dot(diff, diff) < frame.shadowSpheres[i].w) {
				cascade = i;
				break;
			}
		}
		if (cascade < d.u32(2)) {
			const diff = std.sub(rel, frame.shadowSpheres[cascade].xyz);
			const next = std.sub(rel, frame.shadowSpheres[cascade + d.u32(1)].xyz);
			if (std.dot(next, next) < frame.shadowSpheres[cascade + d.u32(1)].w) {
				const outer = (std.sqrt(std.dot(diff, diff) / frame.shadowSpheres[cascade].w) - 0.9) * 12;
				cascade += d.u32(std.step(gradientNoise(px), outer));
			}
		}
		if (cascade < d.u32(3)) {
			sharp = cascadeShadow(rel, normal, cascade, px);
		}
	}
	if (near >= 1 && sharp >= 0) {
		return sharp;
	}
	const far = farShadow(rel, normal);
	if (sharp < 0) {
		return far;
	}
	return std.mix(far, sharp, near);
});

/**
 * sun visibility under the projected cloud shadow at a camera-relative position.
 *
 * @param rel camera-relative position
 * @returns cloud shadow transmittance in `[0, 1]`
 */
export const cloudShadow = tgpu.fn(
	[d.vec3f],
	d.f32,
)((rel) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	if (frame.cloudShadow[0].w < 0.5) {
		return 1;
	}
	const diff = std.sub(std.add(rel, frame.eye.xyz), frame.cloudShadow[0].xyz);
	const proj = std.add(diff, std.mul(frame.cloudShadow[3].xyz, diff.y));
	const uv = std.mul(proj.xz, frame.cloudShadow[1].z);
	const flow = std.mul(frame.cloudShadow[2].xy, frame.eye.w);
	const near = std.textureSampleLevel(
		frameLayout.$.cloudShadowMap,
		frameLayout.$.irradianceRepeat,
		std.add(uv, flow),
		0,
	).x;
	const far = std.textureSampleLevel(
		frameLayout.$.cloudShadowMap,
		frameLayout.$.irradianceRepeat,
		std.add(std.mul(uv, frame.cloudShadow[2].w), flow),
		0,
	).x;
	const range = frame.cloudShadow[1].xy;
	const t = std.clamp((std.length(diff.xz) - range.x) / std.max(range.y - range.x, 1e-4), 0, 1);
	const cloud = std.mix(near, far, t * t * (3 - 2 * t));
	return std.mix(1, cloud, frame.cloudShadow[2].z);
});

const sunLook = tgpu.fn(
	[d.f32],
	d.vec3f,
)((shadow) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const sh = std.mix(1, std.min(1, shadow), frame.shadowLook.x);
	if (frame.shadowLook.w < 0.5) {
		return d.vec3f(sh);
	}
	const ramp = std.textureSampleLevel(
		frameLayout.$.shadowRamp,
		frameLayout.$.irradianceClamp,
		d.vec2f(sh, 0.5),
		0,
	).xyz;
	return std.sub(d.vec3f(1), std.mul(std.sub(d.vec3f(1), ramp), 1 - sh));
});

/**
 * per-channel sun visibility combining cascaded shadows, cloud shadows, fixed attenuation, and penumbra ramp.
 *
 * @param rel camera-relative position
 * @param normal world-space surface normal
 * @param px pixel coordinates (for cascade dithering and Poisson rotation)
 * @returns per-channel sun visibility
 */
export const sunVisibility = tgpu.fn(
	[d.vec3f, d.vec3f, d.vec2f],
	d.vec3f,
)((rel, normal, px) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	if (frame.shadowFade.w < 0.5) {
		return d.vec3f(cloudShadow(rel));
	}
	let shadow = frame.shadowLook.z;
	if (frame.shadowLook.y < 0.99) {
		shadow = std.mix(sunShadow(rel, normal, px) * cloudShadow(rel), frame.shadowLook.z, frame.shadowLook.y);
	}
	return sunLook(shadow);
});

const farVisibility = tgpu.fn(
	[d.vec3f, d.vec3f, d.f32],
	d.vec3f,
)((rel, normal, cloud) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	if (frame.shadowFade.w < 0.5) {
		return d.vec3f(cloud);
	}
	let shadow = frame.shadowLook.z;
	if (frame.shadowLook.y < 0.99) {
		shadow = std.mix(farShadow(rel, normal) * cloud, frame.shadowLook.z, frame.shadowLook.y);
	}
	return sunLook(shadow);
});

/**
 * sun visibility using only the coarse far shadow layer plus cloud shadow.
 *
 * @param rel camera-relative position
 * @param normal world-space surface normal
 * @returns per-channel sun visibility
 */
export const sunVisibilityFar = tgpu.fn(
	[d.vec3f, d.vec3f],
	d.vec3f,
)((rel, normal) => {
	'use gpu';
	return farVisibility(rel, normal, cloudShadow(rel));
});

/**
 * sun visibility using only the coarse far shadow layer without cloud shadows.
 *
 * @param rel camera-relative position
 * @param normal world-space surface normal
 * @returns per-channel sun visibility
 */
export const sunVisibilityFarCloudless = tgpu.fn(
	[d.vec3f, d.vec3f],
	d.vec3f,
)((rel, normal) => {
	'use gpu';
	return farVisibility(rel, normal, 1);
});

// #endregion
