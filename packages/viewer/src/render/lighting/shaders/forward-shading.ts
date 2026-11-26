/**
 * foliage sun, subsurface sun, and forward-pass PBR surface shading helpers.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { Surface, frameLayout } from '../../core/frame-core.ts';
import { LUMINANCE_ROUNDED, fresnelSchlick, ggxDistribution } from '../../core/shader-math.ts';

import { ambientIrradiance, environmentBrdf, sampleReflection, smithVisibility } from './ambient-probes.ts';
import { localLighting } from './local-lights.ts';
import { sunVisibility } from './sun-shadow.ts';

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
