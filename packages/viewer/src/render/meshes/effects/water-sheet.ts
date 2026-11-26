/**
 * `VFXWater` falling-water sheet shading (flipbook motion vectors, subsurface lighting, refraction) and
 * shared slot sampling helper used by six-way smoke.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout, hue } from '../../core/frame-core.ts';
import { fresnelSchlick } from '../../core/shader-math.ts';
import { ambientIrradiance, sunVisibility, sunVisibilityFar } from '../../lighting/frame-lighting.ts';
import { fogPremultiplied } from '../../sky/fog-shader.ts';

import {
	EffectVertexData,
	FX_SOFT,
	FX_TINT,
	effectDrawLayout,
	effectMaterialLayout,
	fxAccumulate,
	fxAdditive,
	fxCustomShift,
	fxNearFade,
	fxRow,
	fxSample,
	fxSceneDepth,
	fxSlotCoords,
	fxSlotGradient,
	mistOrigin,
} from './common.ts';

const WS_FLAGS = 17;
const WS_DISTURB = 18;
const WS_DISTURB_USE = 19;
const WS_DISSOLVE = 20;
const WS_DISSOLVE_COLOR = 21;
const WS_SEQUENCE = 22;
const WS_SEQUENCE_SHAPE = 26;
const WS_SEQUENCE_TINT = 27;
const WS_SURFACE = 28;
const WS_SUBSURFACE = 29;
const WS_MISC = 30;
const WS_REFRACT = 32;

const WS_DISTURB_ON = 1;
const WS_DISTURB_NORMAL = 2;
const WS_MASK = 4;
const WS_DISSOLVE_ON = 8;
const WS_SEQUENCE_ON = 16;
const WS_SEQUENCE_MOTION = 32;
const WS_SEQUENCE_NORMAL = 64;
const WS_NORMAL_MAP = 128;
const WS_MAIN_AS_ALPHA = 256;
const WS_MASK_AS_ALPHA = 512;
const WS_VERTEX_OPACITY = 1024;
const WS_FRESNEL_OPACITY = 2048;
const WS_VERTEX_COLOR = 4096;
const WS_REFRACT_ON = 8192;

/**
 * samples a water-sheet or six-way-smoke slot at its scrolled, rotated, scaled UVs shifted by particle custom
 * data plus `offset`.
 *
 * @param id look slot index
 * @param slot texture slot index (`0..6`)
 * @param uv base UV coordinates
 * @param offset distortion UV offset
 * @param dx dpdx of `uv`
 * @param dy dpdy of `uv`
 * @param custom particle custom data
 * @returns sampled texel
 */
export const wsSample = tgpu.fn(
	[d.u32, d.u32, d.vec2f, d.vec2f, d.vec2f, d.vec2f, d.vec4f],
	d.vec4f,
)((id, slot, uv, offset, dx, dy, custom) => {
	'use gpu';
	const bias = std.exp2(frameLayout.$.frame.params.y);
	const at = std.add(fxSlotCoords(id, slot, std.add(uv, fxCustomShift(id, slot, custom))), offset);
	return fxSample(
		slot,
		at,
		std.mul(fxSlotGradient(id, slot, dx), bias),
		std.mul(fxSlotGradient(id, slot, dy), bias),
	);
});

const wsFrameOffset = tgpu.fn(
	[d.f32, d.vec2f],
	d.vec2f,
)((frameNum, size) => {
	'use gpu';
	const count = size.x * size.y;
	const n = frameNum - count * std.trunc(frameNum / count);
	const row = size.y - std.floor(n / size.x);
	return std.fract(d.vec2f((n - row * size.x) / size.x, row / size.y));
});

/**
 * shades a `VFXWater` falling-water sheet into transparent-accumulated RGBA.
 *
 * @param data interpolated effect vertex data
 * @param front hardware front-facing flag
 * @param dx dpdx of UV0
 * @param dy dpdy of UV0
 * @param relDx dpdx of camera-relative position
 * @param relDy dpdy of camera-relative position
 * @returns accumulated RGBA
 */
export const waterSheet = tgpu.fn(
	[EffectVertexData, d.bool, d.vec2f, d.vec2f, d.vec3f, d.vec3f],
	d.vec4f,
)((data, front, dx, dy, relDx, relDy) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const id = data.look;
	const ws = fxRow(id, d.u32(WS_FLAGS));
	const flags = d.u32(ws.x);
	const uv = data.uv.xy;
	const random = std.fract(std.dot(std.add(mistOrigin(data), frame.eye.xyz), d.vec3f(1)));
	const stretch = random * ws.w;

	let offset = d.vec2f(0);
	if ((flags & d.u32(WS_DISTURB_ON)) !== d.u32(0)) {
		const s = wsSample(id, d.u32(1), uv, d.vec2f(0), dx, dy, data.custom);
		const row = fxRow(id, d.u32(WS_DISTURB));
		const centred = s.x * (row.x + 1) - row.x;
		if ((flags & d.u32(WS_DISTURB_NORMAL)) !== d.u32(0)) {
			offset = std.mul(std.sub(std.mul(d.vec2f(s.w * centred, s.y), 2), d.vec2f(1)), row.y);
		} else {
			offset = std.mul(row.yz, centred);
		}
	}
	const useDisturb = fxRow(id, d.u32(WS_DISTURB_USE));
	const mainUv0 = fxSlotCoords(id, d.u32(0), std.add(uv, fxCustomShift(id, d.u32(0), data.custom)));
	const mainUv = std.add(
		std.add(d.vec2f(mainUv0.x, mainUv0.y * (1 + std.min(stretch, 0.5))), d.vec2f(stretch)),
		std.mul(offset, useDisturb.x),
	);
	const bias = std.exp2(frame.params.y);
	let mainTex = fxSample(
		d.u32(0),
		mainUv,
		std.mul(fxSlotGradient(id, d.u32(0), dx), bias),
		std.mul(fxSlotGradient(id, d.u32(0), dy), bias),
	);
	if ((flags & d.u32(WS_MAIN_AS_ALPHA)) !== d.u32(0)) {
		mainTex = d.vec4f(1, 1, 1, mainTex.x);
	}
	let mask = d.vec4f(1);
	if ((flags & d.u32(WS_MASK)) !== d.u32(0)) {
		mask = wsSample(id, d.u32(2), uv, std.mul(offset, useDisturb.y), dx, dy, data.custom);
		if ((flags & d.u32(WS_MASK_AS_ALPHA)) !== d.u32(0)) {
			mask = d.vec4f(1, 1, 1, mask.x);
		}
	}
	const vertex = std.select(d.vec4f(1), data.color, (flags & d.u32(WS_VERTEX_COLOR)) !== d.u32(0));
	const base = std.mul(std.mul(std.mul(fxRow(id, d.u32(FX_TINT)), vertex), mainTex), mask);
	let color = d.vec3f(base.xyz);
	let dissolved = d.f32(1);
	if ((flags & d.u32(WS_DISSOLVE_ON)) !== d.u32(0)) {
		const row = fxRow(id, d.u32(WS_DISSOLVE));
		const v =
			wsSample(id, d.u32(3), uv, std.mul(offset, useDisturb.w), dx, dy, data.custom).x -
			row.x -
			data.custom.z * 2.02;
		dissolved = std.saturate(v * row.y);
		const edge = std.saturate((row.z - v) * row.y);
		color = std.mix(color, std.mul(fxRow(id, d.u32(WS_DISSOLVE_COLOR)).xyz, edge), edge);
	}

	const shape = fxRow(id, d.u32(WS_SEQUENCE_SHAPE));
	const sequencing = (flags & d.u32(WS_SEQUENCE_ON)) !== d.u32(0);
	let frameA = d.vec2f(uv);
	let frameB = d.vec2f(uv);
	let blend = d.f32(0);
	let sequence = d.vec4f(0);
	if (sequencing) {
		const row = fxRow(id, d.u32(WS_SEQUENCE));
		const f = (frame.eye.w + random * row.w) * row.z;
		const tile = std.div(d.vec2f(1), row.xy);
		frameA = std.add(std.mul(uv, tile), wsFrameOffset(std.floor(f), row.xy));
		frameB = std.add(std.mul(uv, tile), wsFrameOffset(std.floor(f + 1), row.xy));
		blend = std.fract(f);
		const gx = std.mul(std.mul(dx, tile), bias);
		const gy = std.mul(std.mul(dy, tile), bias);
		if ((flags & d.u32(WS_SEQUENCE_MOTION)) !== d.u32(0)) {
			const mvA = std.sub(std.mul(fxSample(d.u32(5), frameA, gx, gy).xy, 2), d.vec2f(1));
			const mvB = std.sub(std.mul(fxSample(d.u32(5), frameB, gx, gy).xy, 2), d.vec2f(1));
			frameA = std.sub(frameA, std.mul(mvA, blend * shape.x));
			frameB = std.add(frameB, std.mul(mvB, (1 - blend) * shape.x));
		}
		sequence = std.saturate(
			std.sub(
				std.mix(fxSample(d.u32(4), frameA, gx, gy), fxSample(d.u32(4), frameB, gx, gy), blend),
				d.vec4f(shape.w),
			),
		);
		color = std.add(
			color,
			std.mul(std.mul(sequence.xyz, fxRow(id, d.u32(WS_SEQUENCE_TINT)).xyz), sequence.w),
		);
	}

	const depth = std.dot(data.rel, frame.viewForward.xyz);
	const soft = fxRow(id, d.u32(FX_SOFT));
	let alpha = base.w * dissolved * fxNearFade(id, depth);
	if (sequencing) {
		alpha = std.saturate(alpha * sequence.w * shape.y - shape.z) * shape.y;
	}
	if (soft.x > 0) {
		alpha *= std.saturate((fxSceneDepth(d.vec2i(data.position.xy)) - depth + soft.y) / soft.x);
	}
	if ((flags & d.u32(WS_VERTEX_OPACITY)) !== d.u32(0)) {
		alpha *= data.color.w;
	}
	const view = std.neg(std.normalize(data.rel));
	const nGeo = std.normalize(data.normal);
	const surface = fxRow(id, d.u32(WS_SURFACE));
	if ((flags & d.u32(WS_FRESNEL_OPACITY)) !== d.u32(0)) {
		alpha *= std.pow(std.abs(std.dot(nGeo, view)), surface.w);
	}
	alpha = std.saturate(alpha);
	color = std.clamp(color, d.vec3f(0), d.vec3f(1000));

	let n = d.vec3f(nGeo);
	if ((flags & d.u32(WS_SEQUENCE_NORMAL | WS_NORMAL_MAP)) !== d.u32(0)) {
		let s = d.vec4f(0);
		if ((flags & d.u32(WS_SEQUENCE_NORMAL)) !== d.u32(0)) {
			const tile = std.div(d.vec2f(1), fxRow(id, d.u32(WS_SEQUENCE)).xy);
			const gx = std.mul(std.mul(dx, tile), bias);
			const gy = std.mul(std.mul(dy, tile), bias);
			s = std.mix(fxSample(d.u32(6), frameA, gx, gy), fxSample(d.u32(6), frameB, gx, gy), blend);
		} else {
			s = wsSample(id, d.u32(6), uv, std.mul(offset, useDisturb.z), dx, dy, data.custom);
		}
		const xy = std.sub(std.mul(d.vec2f(s.w * s.x, s.y), 2), d.vec2f(1));
		const z = std.max(1e-16, std.sqrt(1 - std.saturate(std.dot(xy, xy))));
		const scaled = std.mul(xy, fxRow(id, d.u32(WS_SEQUENCE_TINT)).w);
		const dp1 = std.cross(relDy, nGeo);
		const dp2 = std.cross(nGeo, relDx);
		const t = std.add(std.mul(dp1, dx.x), std.mul(dp2, dy.x));
		const b = std.add(std.mul(dp1, dx.y), std.mul(dp2, dy.y));
		const scale = std.inverseSqrt(std.max(std.max(std.dot(t, t), std.dot(b, b)), 1e-20));
		n = std.normalize(
			std.add(std.add(std.mul(t, scale * scaled.x), std.mul(b, scale * scaled.y)), std.mul(nGeo, z)),
		);
	}
	n = std.select(std.neg(n), n, front);

	const lit = std.mul(color, ws.z);
	const unlit = std.mul(color, (1 - ws.z) * std.mix(1, frame.ambient.y, soft.z));
	const sssRow = fxRow(id, d.u32(WS_SUBSURFACE));
	let thickness = d.f32(1);
	if (sequencing) {
		thickness = sequence.w * shape.y;
	}
	if ((flags & d.u32(WS_VERTEX_OPACITY)) !== d.u32(0)) {
		thickness *= data.color.x;
	}
	const value = sssRow.z * thickness * lit.x;
	const subsurface = std.mul(std.mix(d.vec3f(1), hue(sssRow.x), sssRow.y), value);
	let indirect = std.mul(
		ambientIrradiance(std.add(data.rel, frame.eye.xyz), n),
		std.add(lit, std.mul(subsurface, sssRow.w)),
	);
	{
		const mean = (indirect.x + indirect.y + indirect.z) / 3;
		indirect = std.add(d.vec3f(mean), std.mul(std.sub(indirect, d.vec3f(mean)), fxRow(id, d.u32(WS_MISC)).y));
	}
	const l = frame.sun.xyz;
	const h = std.normalize(std.add(l, view));
	const nDotL = std.saturate(std.dot(n, l));
	const nDotH = std.saturate(std.dot(n, h));
	const nDotV = std.saturate(std.dot(n, view));
	const a = surface.x * surface.x;
	const a2 = a * a;
	const denom = (nDotH * a2 - nDotH) * nDotH + 1;
	const fresnel = fresnelSchlick(d.vec3f(0.08 * surface.y), std.saturate(std.dot(view, h)));
	const visible =
		0.5 /
		(nDotL * std.sqrt((-nDotV * a2 + nDotV) * nDotV + a2) +
			nDotV * std.sqrt((-nDotL * a2 + nDotL) * nDotL + a2) +
			1e-4);
	const specular = std.mul(
		std.clamp(
			std.div(
				std.clamp(
					std.mul(
						std.min(std.mul(fresnel, (a2 / (denom * denom)) * visible), d.vec3f(2048)),
						frame.sunColor.w,
					),
					d.vec3f(0),
					d.vec3f(1000),
				),
				std.max(alpha, 0.01),
			),
			d.vec3f(0),
			d.vec3f(1000),
		),
		surface.z,
	);
	const k = std.saturate(1 - value);
	const wrap = std.saturate(std.dot(n, l) * (2 / 3) + 1 / 3);
	const through = std.mix(
		std.mix(1, wrap * std.sqrt(wrap) * (5 / 3), k) / (2 * Math.PI),
		1,
		std.pow(std.saturate(-std.dot(view, l)), 12) * std.mix(3, 0.1, k),
	);
	let visibility = d.vec3f(1);
	if (fxRow(id, d.u32(WS_MISC)).z > 0.5) {
		visibility = sunVisibilityFar(data.rel, n);
	} else {
		visibility = sunVisibility(data.rel, n, data.position.xy);
	}
	const sun = std.mul(
		std.mul(
			std.add(std.add(std.mul(specular, nDotL), std.mul(subsurface, through)), std.mul(lit, nDotL)),
			std.mul(frame.sunColor.xyz, frame.sun.w / Math.PI),
		),
		visibility,
	);
	const shaded = std.add(std.add(indirect, unlit), sun);

	if ((flags & d.u32(WS_REFRACT_ON)) !== d.u32(0)) {
		const screenUv = std.div(data.position.xy, frame.renderSize.xy);
		const refractRow = fxRow(id, d.u32(WS_REFRACT));
		const shift = std.mul(std.refract(std.neg(view), n, fxRow(id, d.u32(WS_MISC)).w), refractRow.w * alpha);
		const refractUv = std.add(
			screenUv,
			d.vec2f(std.dot(shift, frame.viewRight.xyz), std.dot(shift, frame.viewUp.xyz)),
		);
		const behind = std.textureSampleLevel(
			effectMaterialLayout.$.fxBackground,
			effectMaterialLayout.$.fxBackgroundSamp,
			refractUv,
			0,
		).xyz;
		const tinted = std.mul(behind, std.mix(d.vec3f(1), refractRow.xyz, alpha));
		const surfaceCol = fogPremultiplied(
			effectDrawLayout.$.post,
			effectDrawLayout.$.froxels,
			effectDrawLayout.$.lutSampler,
			std.mul(shaded, alpha),
			std.select(alpha, 0, ws.y >= 0.5),
			data.rel,
			screenUv,
		);
		return d.vec4f(std.mix(tinted, surfaceCol, alpha), 1);
	}

	if (ws.y >= 0.5) {
		return fxAdditive(std.mul(shaded, alpha));
	}
	return fxAccumulate(std.mul(shaded, alpha), alpha, data.rel, data.position.xy, 0);
});
