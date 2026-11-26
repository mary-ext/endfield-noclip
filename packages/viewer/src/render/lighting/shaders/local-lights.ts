/**
 * clustered local-light shading, local shadow atlas sampling, and volumetric fog local lighting helpers.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { Surface, frameLayout } from '../../core/frame-core.ts';
import { fresnelSchlick, henyeyGreenstein } from '../../core/shader-math.ts';
import {
	LIGHT_MASK_WORDS,
	LIGHT_SHADOW_RECORDS,
	LIGHT_SHADOW_VEC4S,
	LIGHT_SLICES,
	LIGHT_TILE_SIZE,
	LIGHT_VEC4S,
} from '../local-lights.ts';

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

/** 1-tap local-light shadow lookup for volumetric fog froxels (temporally filtered, so 3×3 PCF is redundant) */
const localLightShadowSingle = tgpu.fn(
	[d.u32, d.vec3f, d.vec3f],
	d.f32,
)((i, rel, toLight) => {
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
	const clip = std.mul(m, d.vec4f(rel, 1));
	if (clip.w <= 0) {
		return 1;
	}
	const p = std.div(clip.xyz, clip.w);
	if (std.any(std.le(p, d.vec3f(0))) || std.any(std.ge(p, d.vec3f(1)))) {
		return 1;
	}
	const rect = frameLayout.$.lights[base + d.u32(4)];
	const uv = std.add(rect.xy, std.mul(p.xy, rect.zw));
	const vis = std.textureSampleCompareLevel(
		frameLayout.$.lightShadowMap,
		frameLayout.$.shadowSampler,
		uv,
		p.z,
	);
	let strength = s.y;
	if (spot) {
		const edge = std.min(std.min(p.x, p.y), std.min(1 - p.x, 1 - p.y));
		strength = std.min(strength, std.smoothstep(0, 0.05, std.min((params.z - clip.w) * 0.25, edge)));
	}
	return std.mix(1, vis, strength);
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
			const shadow = localLightShadowSingle(i, rel, light.toLight);
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
