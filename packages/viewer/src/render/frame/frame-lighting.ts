/**
 * shared TypeGPU lighting helpers (group 0): sun shadows, cloud shadows, ambient probe, irradiance clipmap,
 * reflection probes, environment BRDF, local lights, foliage/subsurface sun, and forward shading.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { IRRADIANCE_TEXELS, irradianceZ, irradianceZClamped } from '../lighting/irradiance-clipmap.ts';
import {
	LIGHT_MASK_WORDS,
	LIGHT_SHADOW_RECORDS,
	LIGHT_SHADOW_VEC4S,
	LIGHT_SLICES,
	LIGHT_TILE_SIZE,
	LIGHT_VEC4S,
} from '../lighting/local-lights.ts';
import { LUMINANCE, LUMINANCE_ROUNDED } from '../shaders/common/luminance.ts';
import { gradientNoise } from '../shaders/common/noise.ts';
import { henyeyGreenstein } from '../shaders/common/phase.ts';

import { fresnelSchlick, ggxDistribution } from './brdf.ts';
import { Surface, frameLayout } from './frame-core.ts';

// #region sun shadow

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
	const size = d.vec2f(std.textureDimensions(frameLayout.$.shadowMap));
	let sum = d.f32(0);
	for (let y = d.i32(-1); y <= d.i32(1); y++) {
		for (let x = d.i32(-1); x <= d.i32(1); x++) {
			sum += std.textureSampleCompareLevel(
				frameLayout.$.shadowMap,
				frameLayout.$.shadowSampler,
				std.add(p.xy, std.div(d.vec2f(d.f32(x), d.f32(y)), size)),
				3,
				p.z,
			);
		}
	}
	const diff = std.sub(rel, frame.shadowSpheres[3].xyz);
	const edge = std.clamp((1 - std.dot(diff, diff) / frame.shadowSpheres[3].w) * 5, 0, 1);
	return std.mix(1, sum / 9, edge);
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

// #region ambient and reflection probes

/**
 * Unity's ShadeSH9: evaluates the level's ambient spherical-harmonics probe.
 *
 * @param n world-space unit normal
 * @returns diffuse irradiance divided by pi
 */
export const ambientProbe = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((n) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const n4 = d.vec4f(n, 1);
	let c = d.vec3f(std.dot(frame.sh[0], n4), std.dot(frame.sh[1], n4), std.dot(frame.sh[2], n4));
	const b = std.mul(n.xyzz, n.yzzx);
	c = std.add(c, d.vec3f(std.dot(frame.sh[3], b), std.dot(frame.sh[4], b), std.dot(frame.sh[5], b)));
	c = std.add(c, std.mul(frame.sh[6].xyz, n.x * n.x - n.y * n.y));
	return std.max(c, d.vec3f(0));
});

const IrradianceSample = d.struct({
	r: d.vec4f,
	g: d.vec4f,
	b: d.vec4f,
	validity: d.f32,
});

const irradianceLevel = tgpu.fn(
	[d.i32, d.vec3f, d.bool, d.f32],
	IrradianceSample,
)((level, uvwIn, clampAll, weight) => {
	'use gpu';
	let uvw = std.sub(uvwIn, std.floor(uvwIn));
	const half = std.div(d.vec3f(0.5), IRRADIANCE_TEXELS.$);
	if (clampAll) {
		uvw = std.clamp(uvw, half, std.sub(d.vec3f(1), half));
	}
	const l0 = std.textureSampleLevel(
		frameLayout.$.irradianceA,
		frameLayout.$.irradianceRepeat,
		d.vec3f(uvw.xy, irradianceZ(level, uvw.z)),
		0,
	).xyz;
	const v = std.clamp(uvw.y, half.y, 1 - half.y) / 3;
	const z = irradianceZClamped(level, uvw.z);
	const br = std.textureSampleLevel(
		frameLayout.$.irradianceB,
		frameLayout.$.irradianceClamp,
		d.vec3f(uvw.x, v, z),
		0,
	);
	const bg = std.textureSampleLevel(
		frameLayout.$.irradianceB,
		frameLayout.$.irradianceClamp,
		d.vec3f(uvw.x, v + 1 / 3, z),
		0,
	);
	const bb = std.textureSampleLevel(
		frameLayout.$.irradianceB,
		frameLayout.$.irradianceClamp,
		d.vec3f(uvw.x, v + 2 / 3, z),
		0,
	);
	return IrradianceSample({
		r: std.mul(d.vec4f(std.mul(std.sub(std.mul(br.xyz, 4), d.vec3f(2)), l0.x), l0.x), weight),
		g: std.mul(d.vec4f(std.mul(std.sub(std.mul(bg.xyz, 4), d.vec3f(2)), l0.y), l0.y), weight),
		b: std.mul(d.vec4f(std.mul(std.sub(std.mul(bb.xyz, 4), d.vec3f(2)), l0.z), l0.z), weight),
		validity: br.w * weight,
	});
});

const irradianceOutside = tgpu.fn(
	[d.vec3f, d.vec2f, d.f32],
	d.f32,
)((diff, h, fade) => {
	'use gpu';
	return std.max(
		std.clamp((std.max(std.abs(diff.x), std.abs(diff.z)) - h.x) * fade, 0, 1),
		std.clamp((std.abs(diff.y) - h.y) * fade, 0, 1),
	);
});

const combineIrradianceChannel = tgpu.fn(
	[d.vec4f, d.vec4f, d.f32, d.f32, d.vec3f],
	d.f32,
)((sh, def, fallback, band, n) => {
	'use gpu';
	const combined = std.add(
		sh,
		d.vec4f(
			def.x * fallback,
			def.y * fallback + def.w * band * 0.5,
			def.z * fallback,
			def.w * fallback + def.y * band * 0.375,
		),
	);
	return std.max(std.dot(combined.xyz, n) + combined.w, 0);
});

/**
 * diffuse ambient irradiance from the 3-level irradiance clipmap, blending to the default L1 SH where outside
 * the clipmap or open to the sky.
 *
 * @param world world-space surface position
 * @param n world-space unit normal
 * @returns diffuse irradiance divided by pi
 */
export const ambientIrradiance = tgpu.fn(
	[d.vec3f, d.vec3f],
	d.vec3f,
)((world, n) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	if (frame.irradiance[2].w < 0.5) {
		return ambientProbe(n);
	}
	const p = std.add(world, std.mul(n, 0.25));
	const outside = irradianceOutside(std.sub(p, frame.irradiance[2].xyz), d.vec2f(464, 208), 0.03125);
	if (outside >= 1) {
		return std.max(
			d.vec3f(
				std.dot(frame.ivDefaultSh[0].xyz, n) + frame.ivDefaultSh[0].w,
				std.dot(frame.ivDefaultSh[1].xyz, n) + frame.ivDefaultSh[1].w,
				std.dot(frame.ivDefaultSh[2].xyz, n) + frame.ivDefaultSh[2].w,
			),
			d.vec3f(0),
		);
	}
	let r = d.vec4f(0);
	let g = d.vec4f(0);
	let b = d.vec4f(0);
	let validity = outside;
	const f0 = std.select(
		d.f32(1),
		irradianceOutside(std.sub(p, frame.irradiance[0].xyz), d.vec2f(29, 13), 0.5),
		frame.irradiance[0].w > 0.5,
	);
	if (f0 < 1) {
		const s = irradianceLevel(
			0,
			std.div(std.add(std.mul(p, 2), d.vec3f(0.5)), IRRADIANCE_TEXELS.$),
			false,
			1 - f0,
		);
		r = std.add(r, s.r);
		g = std.add(g, s.g);
		b = std.add(b, s.b);
		validity += s.validity;
	}
	const f1 = std.select(
		d.f32(1),
		irradianceOutside(std.sub(p, frame.irradiance[1].xyz), d.vec2f(116, 52), 0.125),
		frame.irradiance[1].w > 0.5,
	);
	if (f1 < 1 && f0 > 0) {
		const s = irradianceLevel(
			1,
			std.div(std.add(std.mul(p, 0.5), d.vec3f(0.5)), IRRADIANCE_TEXELS.$),
			false,
			f0 * (1 - f1),
		);
		r = std.add(r, s.r);
		g = std.add(g, s.g);
		b = std.add(b, s.b);
		validity += s.validity;
	}
	if (f1 > 0) {
		const s = irradianceLevel(
			2,
			std.div(std.add(std.mul(p, 0.125), d.vec3f(0.5)), IRRADIANCE_TEXELS.$),
			true,
			f1 * (1 - outside),
		);
		r = std.add(r, s.r);
		g = std.add(g, s.g);
		b = std.add(b, s.b);
		validity += s.validity;
	}
	const valid = std.clamp(validity * 2 - 1, 0, 1);
	const band = valid - outside;
	const fallback = (valid + outside) * 0.5;
	const k = frame.params.z;
	return d.vec3f(
		combineIrradianceChannel(std.mul(r, k), frame.ivDefaultSh[0], fallback, band, n),
		combineIrradianceChannel(std.mul(g, k), frame.ivDefaultSh[1], fallback, band, n),
		combineIrradianceChannel(std.mul(b, k), frame.ivDefaultSh[2], fallback, band, n),
	);
});

const reflectionNormalisation = tgpu.fn(
	[d.vec3f, d.vec3f],
	d.f32,
)((irradiance, n) => {
	'use gpu';
	const lum = std.dot(irradiance, LUMINANCE.$);
	const p = std.max(1e-4, std.max(0, std.dot(frameLayout.$.frame.reflectionProbeSh, d.vec4f(n, 1))));
	return (2 * std.clamp(lum / p, 0, 1) + lum) / (2 + p);
});

/**
 * samples local reflection probes front-to-back over the sky reflection cubemap, normalised against the
 * surface's diffuse irradiance.
 *
 * @param world world-space surface position
 * @param n world-space unit normal
 * @param r world-space reflection direction
 * @param roughness perceptual roughness
 * @param irradiance surface diffuse irradiance
 * @returns indirect specular radiance
 */
export const sampleReflection = tgpu.fn(
	[d.vec3f, d.vec3f, d.vec3f, d.f32, d.vec3f],
	d.vec3f,
)((world, n, r, roughness, irradiance) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const lum = std.dot(irradiance, LUMINANCE.$);
	const count = d.u32(frame.reflectionProbes.x);
	let accum = d.vec3f(0);
	let remaining = d.f32(1);
	const probeMip = roughness * frame.reflectionProbes.y;
	const w4 = d.vec4f(world, 1);
	for (let i = d.u32(0); i < count; i++) {
		if (remaining <= 0.01) {
			break;
		}
		const base = i * d.u32(7);
		const m1 = frameLayout.$.reflectionProbes[base + d.u32(1)];
		const m2 = frameLayout.$.reflectionProbes[base + d.u32(2)];
		const m3 = frameLayout.$.reflectionProbes[base + d.u32(3)];
		const m4 = frameLayout.$.reflectionProbes[base + d.u32(4)];
		const localPos = d.vec3f(std.dot(m2, w4), std.dot(m3, w4), std.dot(m4, w4));
		const absLocal = std.abs(localPos);
		const half = m1.xyz;
		if (std.any(std.gt(absLocal, half))) {
			continue;
		}
		const m5 = frameLayout.$.reflectionProbes[base + d.u32(5)];
		const m6 = frameLayout.$.reflectionProbes[base + d.u32(6)];
		let weight = d.f32(0);
		if (m6.y > 0.5) {
			const fade = std.mul(std.sub(half, absLocal), m5.xyz);
			weight = std.clamp(std.min(fade.x, std.min(fade.y, fade.z)), 0, 1) * m6.w;
		} else {
			weight = std.clamp((half.x - std.length(localPos)) * m5.x, 0, 1) * m6.w;
		}
		if (weight <= 0) {
			continue;
		}
		let dir = d.vec3f(r);
		if (m6.x > 0.5) {
			const localR = d.vec3f(std.dot(m2.xyz, r), std.dot(m3.xyz, r), std.dot(m4.xyz, r));
			const invR = std.select(
				d.vec3f(1e9),
				std.div(d.vec3f(1), localR),
				std.gt(std.abs(localR), d.vec3f(1e-6)),
			);
			const t0 = std.mul(std.sub(std.neg(half), localPos), invR);
			const t1 = std.mul(std.sub(half, localPos), invR);
			const tmax = std.max(t0, t1);
			const t = std.min(tmax.x, std.min(tmax.y, tmax.z));
			dir = std.add(localPos, std.mul(localR, t));
		}
		const m0 = frameLayout.$.reflectionProbes[base];
		const p = std.max(1e-4, std.max(0, std.dot(m0, d.vec4f(n, 1))));
		const norm = (2 * std.clamp(lum / p, 0, 1) + lum) / (2 + p);
		const c = std.textureSampleLevel(
			frameLayout.$.reflectionProbesTex,
			frameLayout.$.reflectionSampler,
			dir,
			d.u32(m1.w),
			probeMip,
		).xyz;
		accum = std.add(accum, std.mul(c, m5.w * norm * weight * remaining));
		remaining *= 1 - weight;
	}
	if (remaining > 0.01) {
		let sky = ambientProbe(r);
		if (frame.ambient.z > 0.5) {
			sky = std.textureSampleLevel(
				frameLayout.$.reflectionMap,
				frameLayout.$.reflectionSampler,
				r,
				roughness * frame.ambient.w,
			).xyz;
		}
		accum = std.add(accum, std.mul(sky, reflectionNormalisation(irradiance, n) * remaining));
	}
	return accum;
});

/**
 * height-correlated Smith visibility (Heitz), `V = G / (4 n·l n·v)`.
 *
 * @param nDotV cosine between normal and view direction
 * @param nDotL cosine between normal and light direction
 * @param a2 roughness to the fourth power
 * @returns visibility term
 */
export const smithVisibility = tgpu.fn(
	[d.f32, d.f32, d.f32],
	d.f32,
)((nDotV, nDotL, a2) => {
	'use gpu';
	const v = nDotL * std.sqrt(nDotV * nDotV * (1 - a2) + a2);
	const l = nDotV * std.sqrt(nDotL * nDotL * (1 - a2) + a2);
	return 0.5 / std.max(v + l, 1e-5);
});

/**
 * Karis' analytic fit of the split-sum environment BRDF: scale on `f0` and bias on `f90`.
 *
 * @param roughness perceptual roughness
 * @param nDotV cosine between normal and view direction
 * @returns `(scale, bias)` terms
 */
export const environmentBrdfTerms = tgpu.fn(
	[d.f32, d.f32],
	d.vec2f,
)((roughness, nDotV) => {
	'use gpu';
	const c0 = d.vec4f(-1, -0.0275, -0.572, 0.022);
	const c1 = d.vec4f(1, 0.0425, 1.04, -0.04);
	const r = std.add(std.mul(roughness, c0), c1);
	const a004 = std.min(r.x * r.x, std.exp2(-9.28 * nDotV)) * r.x + r.y;
	return std.add(std.mul(d.vec2f(-1.04, 1.04), a004), r.zw);
});

/**
 * split-sum environment BRDF with `f90 = 1`.
 *
 * @param f0 reflectance at normal incidence
 * @param roughness perceptual roughness
 * @param nDotV cosine between normal and view direction
 * @returns environment BRDF reflectance
 */
export const environmentBrdf = tgpu.fn(
	[d.vec3f, d.f32, d.f32],
	d.vec3f,
)((f0, roughness, nDotV) => {
	'use gpu';
	const ab = environmentBrdfTerms(roughness, nDotV);
	return std.add(std.mul(f0, ab.x), d.vec3f(ab.y));
});

// #endregion

// #region local lights

const lightBinWords = tgpu.fn(
	[d.vec2f, d.vec3f],
	d.vec2u,
)((px, rel) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const count = d.u32(frame.localLights.x);
	const depth = std.dot(rel, frame.viewForward.xyz) - frame.localLights.w;
	if (count === d.u32(0) || depth < 0 || depth >= LIGHT_SLICES) {
		return d.vec2u(d.u32(0xffffffff), d.u32(0));
	}
	const tiles = d.vec2u(frame.localLights.yz);
	const tile = std.min(
		d.vec2u(std.div(std.max(px, d.vec2f(0)), LIGHT_TILE_SIZE)),
		std.sub(tiles, d.vec2u(1)),
	);
	return d.vec2u(
		(tile.y * tiles.x + tile.x) * d.u32(LIGHT_MASK_WORDS),
		(tiles.x * tiles.y + d.u32(depth)) * d.u32(LIGHT_MASK_WORDS),
	);
});

const LocalLight = d.struct({
	toLight: d.vec3f,
	attenuation: d.f32,
	a: d.vec3f,
	b: d.vec3f,
});

const localLightAt = tgpu.fn(
	[d.u32, d.vec3f],
	LocalLight,
)((i, rel) => {
	'use gpu';
	const base = i * d.u32(LIGHT_VEC4S);
	const p = frameLayout.$.lights[base];
	const dir = frameLayout.$.lights[base + d.u32(2)];
	const e = frameLayout.$.lights[base + d.u32(3)];
	const g = frameLayout.$.lights[base + d.u32(4)];
	const toLight = std.sub(p.xyz, rel);
	let a = d.vec3f(0);
	let b = d.vec3f(0);
	let box = d.f32(1);
	if (g.w > 0.5) {
		const q = d.vec4f(std.neg(toLight), 1);
		const m = std.max(
			std.abs(std.dot(frameLayout.$.lights[base + d.u32(5)], q)),
			std.max(
				std.abs(std.dot(frameLayout.$.lights[base + d.u32(6)], q)),
				std.abs(std.dot(frameLayout.$.lights[base + d.u32(7)], q)),
			),
		);
		const k = g.z * 0.5;
		box = 1 - std.clamp((m - (0.5 + k)) / std.max(0.5 - k, 1e-4), 0, 1);
		box *= box;
		if (box < 0.001) {
			return LocalLight({ toLight, attenuation: 0, a, b });
		}
	}
	const d2 = std.dot(toLight, toLight);
	const x = d2 * p.w * p.w;
	if (x >= 1) {
		return LocalLight({ toLight, attenuation: 0, a, b });
	}
	const spot = frameLayout.$.lights[base + d.u32(1)].w < 0.5;
	let tube = d.f32(1);
	const tubeLength = std.select(e.y, d.f32(0), spot);
	if (tubeLength > 0) {
		const segment = std.mul(dir.xyz, tubeLength);
		a = std.sub(toLight, std.mul(segment, 0.5));
		b = std.add(toLight, std.mul(segment, 0.5));
		tube = 1 / ((std.length(a) * std.length(b) + std.dot(a, b)) * 0.5 + 1);
	}
	let attenuation = d.f32(0);
	if (e.z < 0) {
		const win = std.clamp(1 - x * x, 0, 1);
		attenuation = std.select(1 / (d2 + 1), tube, tubeLength > 0) * win * win;
	} else {
		attenuation = tube * std.pow(1 - x, e.z);
	}
	if (spot) {
		const cone = std.clamp(
			(std.dot(std.mul(toLight, std.inverseSqrt(std.max(d2, 1e-8))), std.neg(dir.xyz)) - dir.w) * e.x,
			0,
			1,
		);
		attenuation *= cone * cone;
	}
	return LocalLight({ toLight, attenuation: attenuation * box, a, b });
});

const localLightShadow = tgpu.fn(
	[d.u32, d.vec3f, d.vec3f, d.vec3f],
	d.f32,
)((i, rel, n, toLight) => {
	'use gpu';
	const s = frameLayout.$.lights[i * d.u32(LIGHT_VEC4S) + d.u32(8)];
	if (s.x < 0 || s.y <= 0) {
		return 1;
	}
	const spot = frameLayout.$.lights[i * d.u32(LIGHT_VEC4S) + d.u32(1)].w < 0.5;
	let record = d.u32(s.x);
	if (!spot) {
		const dir = std.neg(toLight);
		const a = std.abs(dir);
		if (a.x >= a.y && a.x >= a.z) {
			record += std.select(d.u32(1), d.u32(0), dir.x > 0);
		} else if (a.y >= a.z) {
			record += std.select(d.u32(3), d.u32(2), dir.y > 0);
		} else {
			record += std.select(d.u32(5), d.u32(4), dir.z > 0);
		}
	}
	const base = d.u32(LIGHT_SHADOW_RECORDS) + record * d.u32(LIGHT_SHADOW_VEC4S);
	const params = frameLayout.$.lights[base + d.u32(5)];
	if (params.w < 0.5) {
		return 1;
	}
	const m = d.mat4x4f(
		frameLayout.$.lights[base],
		frameLayout.$.lights[base + d.u32(1)],
		frameLayout.$.lights[base + d.u32(2)],
		frameLayout.$.lights[base + d.u32(3)],
	);
	const depth = std.mul(m, d.vec4f(rel, 1)).w;
	const side = std.select(d.f32(-1), d.f32(1), std.dot(n, toLight) >= 0);
	const clip = std.mul(m, d.vec4f(std.add(rel, std.mul(n, side * (params.y + params.x * depth * 1.5))), 1));
	if (clip.w <= 0) {
		return 1;
	}
	const p = std.div(clip.xyz, clip.w);
	if (std.any(std.le(p, d.vec3f(0))) || std.any(std.ge(p, d.vec3f(1)))) {
		return 1;
	}
	const rect = frameLayout.$.lights[base + d.u32(4)];
	const texel = std.div(d.vec2f(1), d.vec2f(std.textureDimensions(frameLayout.$.lightShadowMap)));
	const low = std.add(rect.xy, texel);
	const high = std.sub(std.add(rect.xy, rect.zw), texel);
	const uv = std.add(rect.xy, std.mul(p.xy, rect.zw));
	let sum = d.f32(0);
	for (let y = d.i32(-1); y <= d.i32(1); y++) {
		for (let x = d.i32(-1); x <= d.i32(1); x++) {
			const tap = std.clamp(std.add(uv, std.mul(d.vec2f(d.f32(x), d.f32(y)), texel)), low, high);
			sum += std.textureSampleCompareLevel(
				frameLayout.$.lightShadowMap,
				frameLayout.$.shadowSampler,
				tap,
				p.z,
			);
		}
	}
	let strength = s.y;
	if (spot) {
		const edge = std.min(std.min(p.x, p.y), std.min(1 - p.x, 1 - p.y));
		strength = std.min(strength, std.smoothstep(0, 0.05, std.min((params.z - clip.w) * 0.25, edge)));
	}
	return std.mix(1, sum / 9, strength);
});

/**
 * evaluates direct local lights (point, spot, tube, shadowed) on a surface.
 *
 * @param s surface parameters
 * @param v unit vector from surface towards the camera
 * @param rel camera-relative surface position
 * @param px pixel coordinates
 * @param diffuseColor diffuse albedo (`albedo * (1 - metallic)`)
 * @param f0 specular reflectance at normal incidence
 * @param roughness clamped perceptual roughness
 * @returns accumulated direct local-light radiance
 */
export const localLighting = tgpu.fn(
	[Surface, d.vec3f, d.vec3f, d.vec2f, d.vec3f, d.vec3f, d.f32],
	d.vec3f,
)((s, v, rel, px, diffuseColor, f0, roughness) => {
	'use gpu';
	const n = s.normal;
	const words = lightBinWords(px, rel);
	if (words.x === d.u32(0xffffffff)) {
		return d.vec3f(0);
	}
	const count = d.u32(frameLayout.$.frame.localLights.x);
	const nDotV = std.clamp(std.dot(n, v), 0, 1);
	const r = std.reflect(std.neg(v), n);
	let sum = d.vec3f(0);
	for (let w = d.u32(0); w * d.u32(32) < count; w++) {
		let mask = frameLayout.$.lightBins[words.x + w] & frameLayout.$.lightBins[words.y + w];
		while (mask !== d.u32(0)) {
			const i = w * d.u32(32) + std.firstTrailingBit(mask);
			mask &= mask - d.u32(1);
			const light = localLightAt(i, rel);
			if (light.attenuation <= 0) {
				continue;
			}
			const e = frameLayout.$.lights[i * d.u32(LIGHT_VEC4S) + d.u32(3)];
			const tubeLength = std.select(
				e.y,
				d.f32(0),
				frameLayout.$.lights[i * d.u32(LIGHT_VEC4S) + d.u32(1)].w < 0.5,
			);
			const d2 = std.dot(light.toLight, light.toLight);
			const dist = std.sqrt(d2);
			const l = std.div(light.toLight, dist);
			let lSpec = d.vec3f(l);
			let nDotL = d.f32(0);
			let norm = d.f32(1);
			if (tubeLength > 0) {
				nDotL = std.clamp(
					0.5 * (std.dot(n, light.a) / std.length(light.a) + std.dot(n, light.b) / std.length(light.b)),
					0,
					1,
				);
				const segment = std.sub(light.b, light.a);
				const rDotS = std.dot(r, segment);
				const t = std.clamp(
					std.dot(light.a, std.sub(std.mul(r, rDotS), segment)) /
						std.max(tubeLength * tubeLength - rDotS * rDotS, 1e-6),
					0,
					1,
				);
				lSpec = std.normalize(std.add(light.a, std.mul(segment, t)));
				const r2 = roughness * roughness;
				norm = r2 / std.clamp(r2 + 0.5 * std.clamp(tubeLength / dist, 0, 1), 1e-6, 1);
			} else {
				nDotL = std.clamp(std.dot(n, l), 0, 1);
			}
			if (nDotL <= 0 && !s.foliage) {
				continue;
			}
			const h = std.normalize(std.add(lSpec, v));
			const nDotH = std.clamp(std.dot(n, h), 0, 1);
			const vDotH = std.clamp(std.dot(v, h), 0, 1);
			let a = roughness * roughness;
			const soft = std.clamp(e.w / dist, 0, 1);
			if (soft > 0) {
				a = std.clamp(a + (soft * soft) / (3.6 * vDotH + 0.4), 0, 1);
			}
			const a2 = a * a;
			const dd = nDotH * nDotH * (a2 - 1) + 1;
			const distribution = a2 / std.max(dd * dd, 1e-8);
			const visibility =
				0.5 /
				(nDotL * std.sqrt(nDotV * nDotV * (1 - a2) + a2) +
					nDotV * std.sqrt(nDotL * nDotL * (1 - a2) + a2) +
					1e-4);
			const f = fresnelSchlick(f0, vDotH);
			const g = frameLayout.$.lights[i * d.u32(LIGHT_VEC4S) + d.u32(4)];
			let lobe = std.min(std.mul(f, distribution * norm * visibility), d.vec3f(2048));
			let through = d.vec3f(0);
			let diffuse = d.vec3f(diffuseColor);
			if (s.foliage) {
				const vDotL = std.dot(v, lSpec);
				const nDotLSigned = std.dot(n, lSpec);
				lobe = std.mul(
					lobe,
					std.mix(
						std.saturate(std.dot(n, v) + 0.2) * std.saturate(std.saturate(vDotL) + 0.5),
						1,
						std.saturate(vDotL + 1),
					) * s.sunShadow,
				);
				const towardsLight = std.saturate(-vDotL);
				const spread = (towardsLight * 0.36 - towardsLight) * towardsLight + 1;
				const hueCol = std.div(
					diffuseColor,
					std.max(0.01, std.max(diffuseColor.x, std.max(diffuseColor.y, diffuseColor.z))),
				);
				through = std.mul(
					std.add(
						std.mul(hueCol, s.transmission * std.saturate(0.5 - nDotLSigned) * (0.36 / (spread * spread))),
						std.mul(diffuseColor, std.saturate(nDotLSigned + s.subsurface) - nDotL),
					),
					s.sunShadow,
				);
				diffuse = std.mul(diffuse, s.sunShadow);
			}
			const specular = std.clamp(std.mul(lobe, g.x), d.vec3f(0), d.vec3f(1000));
			const shadow = localLightShadow(i, rel, n, light.toLight);
			const contrib = std.add(std.mul(std.add(specular, diffuse), nDotL), through);
			sum = std.add(
				sum,
				std.mul(
					std.mul(contrib, frameLayout.$.lights[i * d.u32(LIGHT_VEC4S) + d.u32(1)].xyz),
					light.attenuation * shadow,
				),
			);
		}
	}
	return std.min(sum, d.vec3f(255));
});

/**
 * evaluates local lights scattered towards the camera by volumetric fog at a camera-relative point.
 *
 * @param rel camera-relative froxel position
 * @param px render pixel coordinates
 * @param ray unit ray from camera towards the point
 * @param g Henyey–Greenstein anisotropy
 * @returns accumulated scattered radiance
 */
export const localFogLighting = tgpu.fn(
	[d.vec3f, d.vec2f, d.vec3f, d.f32],
	d.vec3f,
)((rel, px, ray, g) => {
	'use gpu';
	const words = lightBinWords(px, rel);
	if (words.x === d.u32(0xffffffff)) {
		return d.vec3f(0);
	}
	const count = d.u32(frameLayout.$.frame.localLights.x);
	let sum = d.vec3f(0);
	for (let w = d.u32(0); w * d.u32(32) < count; w++) {
		let mask = frameLayout.$.lightBins[words.x + w] & frameLayout.$.lightBins[words.y + w];
		while (mask !== d.u32(0)) {
			const i = w * d.u32(32) + std.firstTrailingBit(mask);
			mask &= mask - d.u32(1);
			const intensity = frameLayout.$.lights[i * d.u32(LIGHT_VEC4S) + d.u32(4)].y;
			if (intensity <= 0) {
				continue;
			}
			const light = localLightAt(i, rel);
			if (light.attenuation <= 0) {
				continue;
			}
			const phase = henyeyGreenstein(g, std.dot(ray, std.normalize(light.toLight)));
			const shadow = localLightShadow(i, rel, d.vec3f(0), light.toLight);
			sum = std.add(
				sum,
				std.mul(
					frameLayout.$.lights[i * d.u32(LIGHT_VEC4S) + d.u32(1)].xyz,
					light.attenuation * phase * intensity * shadow,
				),
			);
		}
	}
	return sum;
});

// #endregion

// #region foliage, subsurface, and forward shading

/**
 * two-sided foliage sun lighting per unit of sun illuminance before shadowing.
 *
 * @param s surface parameters
 * @param n world-space unit normal
 * @param v unit vector towards the camera
 * @param l unit vector towards the sun
 * @param a2 roughness to the fourth power
 * @param f0 specular reflectance at normal incidence
 * @param albedo diffuse albedo
 * @returns unshadowed sun reflectance
 */
export const foliageSun = tgpu.fn(
	[Surface, d.vec3f, d.vec3f, d.vec3f, d.f32, d.vec3f, d.vec3f],
	d.vec3f,
)((s, n, v, l, a2, f0, albedo) => {
	'use gpu';
	const nDotLSigned = std.dot(n, l);
	const nDotL = std.saturate(nDotLSigned);
	const nDotV = std.clamp(std.abs(std.dot(n, v)), 1e-4, 1);
	const vDotL = std.dot(v, l);
	const diffuseNDotL = std.select(nDotL, s.sunNDotL, s.sunNDotL >= 0);
	let color = std.mul(albedo, diffuseNDotL);

	const h = std.normalize(std.add(l, v));
	const f = fresnelSchlick(f0, std.saturate(std.dot(v, h)));
	const backView = std.mix(
		std.saturate(std.dot(n, v) + 0.2) * std.saturate(std.saturate(vDotL) + 0.5),
		1,
		std.saturate(vDotL + 1),
	);
	const specular = std.mul(
		f,
		ggxDistribution(std.saturate(std.dot(n, h)), a2) * smithVisibility(nDotV, nDotL, a2) * backView,
	);
	color = std.add(color, std.mul(specular, Math.PI * frameLayout.$.frame.sunColor.w * nDotL));

	const towardsSun = std.saturate(-vDotL);
	const lobe = (towardsSun * 0.36 - towardsSun) * towardsSun + 1;
	const hueCol = std.div(albedo, std.max(0.01, std.max(albedo.x, std.max(albedo.y, albedo.z))));
	color = std.add(
		color,
		std.mul(hueCol, s.transmission * std.saturate(0.5 - nDotLSigned) * (0.36 / (lobe * lobe))),
	);
	color = std.add(color, std.mul(albedo, std.saturate(nDotLSigned + s.subsurface) - nDotL));
	return std.mul(color, s.sunShadow / Math.PI);
});

/**
 * sun share of the subsurface scattering model per unit of illuminance over pi.
 *
 * @param scatter scatter colour times amount (rgb) and amount (a)
 * @param n world-space unit normal
 * @param v unit vector towards the camera
 * @param l unit vector towards the sun
 * @returns subsurface reflectance
 */
export const subsurfaceSun = tgpu.fn(
	[d.vec4f, d.vec3f, d.vec3f, d.vec3f],
	d.vec3f,
)((scatter, n, v, l) => {
	'use gpu';
	const k = std.saturate(1 - scatter.w);
	const wrap = std.saturate(std.dot(n, l) * (2 / 3) + 1 / 3);
	const through = std.mix(
		std.mix(1, wrap * std.sqrt(wrap) * (5 / 3), k) / (2 * Math.PI),
		1,
		std.pow(std.saturate(-std.dot(v, l)), 12) * std.mix(3, 0.1, k),
	);
	return std.mul(scatter.xyz, through);
});

/**
 * forward sun (shadowed), local lights, and ambient IBL shading for transparent surfaces.
 *
 * @param s surface parameters
 * @param rel camera-relative surface position
 * @param px pixel coordinates
 * @returns lit HDR radiance (or debug view colour)
 */
export const shadeSurfaceForward = tgpu.fn(
	[Surface, d.vec3f, d.vec2f],
	d.vec3f,
)((s, rel, px) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const n = s.normal;
	const v = std.neg(std.normalize(rel));
	const l = frame.sun.xyz;
	const nDotV = std.clamp(std.abs(std.dot(n, v)), 1e-4, 1);
	const nDotL = std.clamp(std.dot(n, l), 0, 1);
	const roughness = std.clamp(s.roughness, 0.045, 1);
	const a = roughness * roughness;
	const a2 = a * a;
	const diffuseColor = std.mul(s.albedo, 1 - s.metallic);
	const f0 = std.mix(d.vec3f(s.f0), s.albedo, s.metallic);

	let direct = d.vec3f(0);
	if (s.foliage) {
		direct = std.mul(
			std.mul(foliageSun(s, n, v, l, a2, f0, diffuseColor), frame.sunColor.xyz),
			std.mul(sunVisibility(rel, n, px), frame.sun.w),
		);
	} else {
		const h = std.normalize(std.add(l, v));
		const nDotH = std.clamp(std.dot(n, h), 0, 1);
		const vDotH = std.clamp(std.dot(v, h), 0, 1);
		const f = fresnelSchlick(f0, vDotH);
		const specular = std.mul(
			f,
			ggxDistribution(nDotH, a2) * smithVisibility(nDotV, nDotL, a2) * frame.sunColor.w,
		);
		const diffuse = std.mul(std.div(diffuseColor, Math.PI), std.sub(d.vec3f(1), f));
		direct = std.mul(std.add(diffuse, specular), nDotL);
		const scatters = s.scatter.w > 0;
		if (scatters) {
			direct = std.add(direct, std.div(subsurfaceSun(s.scatter, n, v, l), Math.PI));
		}
		let visibility = d.vec3f(0);
		if (nDotL > 0 || scatters) {
			visibility = sunVisibility(rel, n, px);
		}
		direct = std.mul(direct, std.mul(std.mul(frame.sunColor.xyz, visibility), frame.sun.w));
	}
	direct = std.add(direct, localLighting(s, v, rel, px, diffuseColor, f0, roughness));

	const worldPos = std.add(frame.eye.xyz, rel);
	const irradiance = ambientIrradiance(worldPos, n);
	const diffuseAmbient = std.mul(
		std.add(diffuseColor, std.mul(s.scatter.xyz, s.scatterIndirect)),
		irradiance,
	);
	const specularOcclusion = std.clamp(
		std.pow(nDotV + s.occlusion, std.exp2(-16 * roughness - 1)) - 1 + s.occlusion,
		0,
		1,
	);
	const specularWeight = std.mul(environmentBrdf(f0, roughness, nDotV), specularOcclusion * frame.ambient.x);
	const r = std.normalize(std.mix(std.reflect(std.neg(v), n), n, roughness * roughness));
	const specularAmbient = std.mul(sampleReflection(worldPos, n, r, roughness, irradiance), specularWeight);
	const ambient = std.add(std.mul(diffuseAmbient, s.occlusion), specularAmbient);

	const debugView = frame.flags.y;
	if (debugView === d.u32(1)) {
		return d.vec3f(s.albedo);
	}
	if (debugView === d.u32(2)) {
		return std.add(std.mul(n, 0.5), d.vec3f(0.5));
	}
	if (debugView === d.u32(3)) {
		return d.vec3f(roughness);
	}
	if (debugView === d.u32(4)) {
		return ambient;
	}
	if (debugView === d.u32(6)) {
		return d.vec3f(std.dot(s.albedo, LUMINANCE_ROUNDED.$));
	}
	return std.add(std.add(direct, ambient), s.emission);
});

// #endregion
