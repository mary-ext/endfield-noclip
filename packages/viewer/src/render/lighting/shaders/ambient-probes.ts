/**
 * ambient probe, irradiance clipmap, reflection probe, and environment BRDF TypeGPU helpers.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout } from '../../core/frame-core.ts';
import { LUMINANCE } from '../../core/shader-math.ts';
import { IRRADIANCE_TEXELS, irradianceZ, irradianceZClamped } from '../irradiance-clipmap.ts';

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
