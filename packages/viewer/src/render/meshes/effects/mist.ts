/**
 * `HGRP/FogSimple` mist cards (`fsMistCard`) and `HGRP/Effect/VFXFakeVolumeFog` boxes (`fsMistVolume`).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout } from '../../core/frame-core.ts';

import {
	EffectAccumulatedOut,
	EffectFragmentIn,
	EffectVertexData,
	FX_UV,
	effectMaterialLayout,
	fxAccumulate,
	fxAdditive,
	fxRow,
	fxSceneDepth,
	mistBasis,
	mistOrigin,
} from './common.ts';

const MIST_COLOR = 0;
const MIST_CARD = 8;
const MIST_WIND = 9;
const MIST_LIGHT = 10;
const MIST_INDIRECT = 11;
const MIST_FADE = 12;
const MIST_TOP = 13;
const MIST_VOLUME = 14;
const MIST_FRESNEL = 14;
const MIST_VOLUME_HEIGHT = 15;
const MIST_VOLUME_FADE = 16;
const MIST_MISC = 17;
const MIST_VOLUME_NOISE = 18;
const MIST_VOLUME_NOISE_FLOW = 19;
const MIST_VOLUME_NOISE_MIX = 20;

const mistCardAccumulate = tgpu.fn(
	[d.u32, d.vec3f, d.f32, d.vec3f, d.vec2f],
	d.vec4f,
)((id, premultiplied, alpha, rel, position) => {
	'use gpu';
	if (fxRow(id, d.u32(MIST_INDIRECT)).w !== 0) {
		return fxAdditive(premultiplied);
	}
	return fxAccumulate(premultiplied, alpha, rel, position, 0);
});

const mistFade = tgpu.fn(
	[d.vec2f, d.f32],
	d.f32,
)((range, depth) => {
	'use gpu';
	return std.saturate((depth - range.x) / (range.y - range.x));
});

/** fragment entrypoint for `HGRP/FogSimple` mist cards */
export const fsMistCard = tgpu.fragmentFn({
	in: EffectFragmentIn,
	out: EffectAccumulatedOut,
})((v) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const data = EffectVertexData({
		position: d.vec4f(v.position),
		rel: d.vec3f(v.rel),
		normal: d.vec3f(v.normal),
		uv: d.vec4f(v.uv),
		color: d.vec4f(v.color),
		look: v.look,
		toObject0: d.vec4f(v.toObject0),
		toObject1: d.vec4f(v.toObject1),
		toObject2: d.vec4f(v.toObject2),
		up: d.vec3f(v.up),
		origin: d.vec4f(v.origin),
		placementColor: d.vec4f(v.placementColor),
		placementUv: d.vec4f(v.placementUv),
		custom: d.vec4f(v.custom),
		tangent: d.vec4f(v.tangent),
	});
	const id = data.look;
	const uv = data.uv.xy;
	const dx = std.dpdx(uv);
	const dy = std.dpdy(uv);
	const bias = std.exp2(frame.params.y);
	const card = fxRow(id, d.u32(MIST_CARD));
	const wind = fxRow(id, d.u32(MIST_WIND));
	const light = fxRow(id, d.u32(MIST_LIGHT));
	const mainSt = fxRow(id, d.u32(FX_UV));
	const noiseSt = fxRow(id, d.u32(FX_UV + 1));
	const main = std.textureSampleGrad(
		effectMaterialLayout.$.fxTex0,
		effectMaterialLayout.$.fxSamp0,
		std.add(std.mul(uv, mainSt.xy), mainSt.zw),
		std.mul(std.mul(dx, mainSt.xy), bias),
		std.mul(std.mul(dy, mainSt.xy), bias),
	);
	const noise = std.textureSampleGrad(
		effectMaterialLayout.$.fxTex1,
		effectMaterialLayout.$.fxSamp1,
		std.add(std.mul(uv, noiseSt.xy), noiseSt.zw),
		std.mul(std.mul(dx, noiseSt.xy), bias),
		std.mul(std.mul(dy, noiseSt.xy), bias),
	);
	const windUv = std.add(std.mul(uv, wind.yz), std.mul(d.vec2f(-light.x, light.y), frame.eye.w * wind.w));
	const gust = std.textureSampleGrad(
		effectMaterialLayout.$.fxTex1,
		effectMaterialLayout.$.fxSamp1,
		windUv,
		std.mul(std.mul(dx, wind.yz), bias),
		std.mul(std.mul(dy, wind.yz), bias),
	).x;
	const base = fxRow(id, d.u32(MIST_COLOR));
	let alpha = (1 - card.y + noise.x * card.y) * main.x * base.w;
	let color = d.vec3f(base.xyz);
	if (light.z !== 0) {
		const n = std.mul(
			std.normalize(data.normal),
			std.select(d.f32(-1), d.f32(1), std.dot(data.normal, std.neg(data.rel)) >= 0),
		);
		const lit = 1 - light.w + std.max(std.dot(n, frame.sun.xyz), 0) * light.w;
		const sun = std.mul(frame.sunColor.xyz, frame.sun.w / Math.PI);
		color = std.mix(fxRow(id, d.u32(MIST_INDIRECT)).xyz, std.mul(base.xyz, sun), lit);
	}
	const windy =
		1 - card.z + (1 - card.w + std.saturate(std.mix(-wind.x, wind.x + 1, gust)) * card.w) * card.z;
	color = std.mul(color, windy);
	alpha *= windy;
	const fresnel = fxRow(id, d.u32(MIST_FRESNEL));
	if (fresnel.x !== 0) {
		const facing = std.saturate(
			std.abs(std.dot(std.normalize(std.neg(data.rel)), std.normalize(data.normal))),
		);
		const f = std.mix(
			1,
			std.pow(std.max(std.abs(std.mix(1 - facing, facing, fresnel.w)), 0.00048828125), fresnel.z),
			fresnel.y,
		);
		color = std.mul(color, f);
		alpha *= f;
	}

	const depth = std.dot(data.rel, frame.viewForward.xyz);
	const fade = fxRow(id, d.u32(MIST_FADE));
	const top = fxRow(id, d.u32(MIST_TOP));
	const basis = mistBasis(data);
	const origin = std.neg(std.mul(basis, d.vec3f(data.toObject0.w, data.toObject1.w, data.toObject2.w)));
	const below = (origin.y - data.rel.y) / std.max(std.length(basis.columns[1]), 1e-6);
	let soft = d.f32(1);
	if (top.z > 0) {
		soft = std.saturate((fxSceneDepth(d.vec2i(data.position.xy)) - depth) / top.z);
	}
	alpha = std.saturate(
		alpha *
			mistFade(fade.xy, depth) *
			mistFade(fade.zw, depth) *
			std.saturate(below * top.x + top.y) *
			soft *
			card.x,
	);
	return {
		color: mistCardAccumulate(
			id,
			std.mul(std.max(color, d.vec3f(0)), alpha),
			alpha,
			data.rel,
			data.position.xy,
		),
	};
});

/** fragment entrypoint for `HGRP/Effect/VFXFakeVolumeFog` volume boxes */
export const fsMistVolume = tgpu.fragmentFn({
	in: EffectFragmentIn,
	out: EffectAccumulatedOut,
})((v) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const data = EffectVertexData({
		position: d.vec4f(v.position),
		rel: d.vec3f(v.rel),
		normal: d.vec3f(v.normal),
		uv: d.vec4f(v.uv),
		color: d.vec4f(v.color),
		look: v.look,
		toObject0: d.vec4f(v.toObject0),
		toObject1: d.vec4f(v.toObject1),
		toObject2: d.vec4f(v.toObject2),
		up: d.vec3f(v.up),
		origin: d.vec4f(v.origin),
		placementColor: d.vec4f(v.placementColor),
		placementUv: d.vec4f(v.placementUv),
		custom: d.vec4f(v.custom),
		tangent: d.vec4f(v.tangent),
	});
	const id = data.look;
	const px = d.vec2i(data.position.xy);
	const face = std.dot(data.rel, frame.viewForward.xyz);
	let scene = fxSceneDepth(px);
	const water = std.textureLoad(effectMaterialLayout.$.fxWaterDepth, px, 0);
	if (water > 0) {
		scene = std.min(scene, frame.localLights.w / water);
	}
	const depth = std.min(scene, face);
	const rel = std.mul(data.rel, depth / face);
	const p = d.vec4f(rel, 1);
	const objectP = d.vec3f(std.dot(data.toObject0, p), std.dot(data.toObject1, p), std.dot(data.toObject2, p));
	const negRel = std.neg(rel);
	const toCamera = d.vec3f(
		std.dot(data.toObject0.xyz, negRel),
		std.dot(data.toObject1.xyz, negRel),
		std.dot(data.toObject2.xyz, negRel),
	);
	const reach = std.length(toCamera);
	const dir = std.div(toCamera, reach);
	const exits = std.max(
		std.div(std.sub(d.vec3f(-0.5), objectP), dir),
		std.div(std.sub(d.vec3f(0.5), objectP), dir),
	);
	const objectLength = std.min(std.min(std.min(exits.x, exits.y), exits.z), reach);
	const thickness = objectLength * (std.length(rel) / reach);

	const volume = fxRow(id, d.u32(MIST_VOLUME));
	const height = fxRow(id, d.u32(MIST_VOLUME_HEIGHT));
	const base = fxRow(id, d.u32(MIST_COLOR));
	let alpha = base.w * (1 - std.exp2(-thickness * volume.x)) * volume.y;
	alpha *= std.saturate(1 - std.length(std.cross(objectP, dir)) / volume.z);
	alpha *= 1 - std.saturate((objectP.y - height.x) * height.y);
	if (height.w > height.z) {
		alpha *= 1 - std.smoothstep(height.z - 0.5, height.w - 0.5, objectP.y);
	}
	const noiseMix = fxRow(id, d.u32(MIST_VOLUME_NOISE_MIX));
	if (noiseMix.w !== 0) {
		const noiseAt = fxRow(id, d.u32(MIST_VOLUME_NOISE));
		const at = std.select(objectP, std.add(frame.eye.xyz, rel), noiseAt.w !== 0);
		const uvw = std.add(
			std.mul(at, noiseAt.xyz),
			std.mul(fxRow(id, d.u32(MIST_VOLUME_NOISE_FLOW)).xyz, frame.eye.w),
		);
		const n = std.textureSampleLevel(
			effectMaterialLayout.$.fxVolume,
			effectMaterialLayout.$.fxVolumeSamp,
			uvw,
			0,
		).x;
		const intensity = std.mix(noiseMix.y, noiseMix.x, 1 - std.saturate(std.length(rel) * noiseMix.z));
		alpha *= std.saturate(1 - n + intensity * n);
	}
	if (volume.w > 0) {
		alpha *= std.saturate(thickness / volume.w);
	}
	const fade = fxRow(id, d.u32(MIST_VOLUME_FADE));
	const toPoint = std.length(rel);
	const distance = std.mix(toPoint, std.length(mistOrigin(data)), fade.y);
	alpha = std.saturate(alpha) * (1 - std.saturate(distance / fade.x));
	if (fade.z > 0) {
		alpha *= std.smoothstep(std.min(fade.w, 0.99), 1, std.saturate(toPoint / fade.z));
	}
	const color = std.mul(base.xyz, std.mix(1, frame.ambient.y, fxRow(id, d.u32(MIST_MISC)).x));
	return { color: fxAdditive(std.mul(color, alpha)) };
});
