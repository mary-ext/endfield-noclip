/**
 * `WaterDecal` foam boxes (`fsWaterFoam`) projected onto the water surface depth buffer.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout } from '../../core/frame-core.ts';

import {
	EffectFragmentIn,
	FX_ANIM,
	FX_TINT,
	FX_UV,
	effectMaterialLayout,
	fxPolar,
	fxRow,
	fxSample,
	fxSampleLevel,
} from './common.ts';

const WF_TINT = 17;
const WF_DISTURB = 18;
const WF_USE = 19;
const WF_SOURCES = 20;
const WF_MASK_MATRIX = 21;
const WF_DISSOLVE = 22;
const WF_DISSOLVE_COLOR = 23;
const WF_BOX_UV = 24;
const WF_FADE = 25;
const WF_MIP = 26;
const WF_EROSION = 27;
const WF_EROSION_EDGE = 28;
const WF_EROSION_LAYERS = 32;
const WF_BUBBLE = 35;
const WF_BUBBLE_COLOR = 36;
const WF_FLOATING = 37;
const WF_FLOATING_COLOR = 38;
const WF_FLOATING_COLOR_DARK = 39;
const WF_BASE2_TINT = 40;
const WF_BASE2 = 41;

const WF_DISTURB_ON = 1;
const WF_MASK_ON = 2;
const WF_DISSOLVE_ON = 4;
const WF_EDGE_FADE = 8;
const WF_CLIP_TO_BOX = 16;
const WF_SOFT = 32;
const WF_EROSION_ON = 64;
const WF_BUBBLE_ON = 128;
const WF_FLOATING0_ON = 256;
const WF_FLOATING1_ON = 512;
const WF_BASE2_ON = 1024;

const WF_SLOT_FLOW = 1;
const WF_SLOT_FLOW_NOISE = 2;
const WF_SLOT_GRADIENT = 3;
const WF_SLOT_LAYERS = 4;
const WF_SLOT_BUBBLE = 4;
const WF_SLOT_BASE2 = 4;
const WF_SLOT_FLOATING0 = 5;
const WF_SLOT_FLOATING1 = 6;

const WF_LAYER_GRADIENT_SCALE = 0.125;

const wfSampleClamped = tgpu.fn(
	[d.u32, d.vec2f, d.vec2f, d.vec2f],
	d.vec4f,
)((slot, uv, dx, dy) => {
	'use gpu';
	let size = d.vec2u(1, 1);
	if (slot === d.u32(WF_SLOT_FLOW)) {
		size = std.textureDimensions(effectMaterialLayout.$.fxTex1);
	} else {
		size = std.textureDimensions(effectMaterialLayout.$.fxTex3);
	}
	const halfTexel = std.div(d.vec2f(0.5), d.vec2f(size));
	return fxSample(slot, std.clamp(uv, halfTexel, std.sub(d.vec2f(1), halfTexel)), dx, dy);
});

const wfErosionLayer = tgpu.fn(
	[d.u32, d.u32, d.vec2f, d.vec2f, d.vec2f, d.f32, d.f32, d.f32],
	d.vec3f,
)((id, index, uv, dx, dy, t, frontChannel, gradientAlpha) => {
	'use gpu';
	const slot = d.u32(WF_SLOT_LAYERS) + index;
	const st = fxRow(id, d.u32(FX_UV) + slot);
	const layerUv = std.add(
		std.add(std.mul(uv, st.xy), st.zw),
		std.mul(fxRow(id, d.u32(FX_ANIM) + slot).xy, t),
	);
	const scale = std.mul(st.xy, WF_LAYER_GRADIENT_SCALE);
	const layerNoise = std.saturate(fxSample(slot, layerUv, std.mul(dx, scale), std.mul(dy, scale)).xyz);
	const layer = fxRow(id, d.u32(WF_EROSION_LAYERS) + index);
	return std.mul(std.mul(layer.xyz, std.saturate(frontChannel - layer.w) * gradientAlpha), layerNoise);
});

const wfErosion = tgpu.fn(
	[d.u32, d.vec3f, d.vec2f, d.vec2f, d.vec2f, d.f32],
	d.vec3f,
)((id, color, uv, dx, dy, t) => {
	'use gpu';
	const row = fxRow(id, d.u32(WF_EROSION));
	const noiseSt = fxRow(id, d.u32(FX_UV + WF_SLOT_FLOW_NOISE));
	const noiseUv = std.add(
		std.add(std.mul(uv, noiseSt.xy), noiseSt.zw),
		std.mul(fxRow(id, d.u32(FX_ANIM + WF_SLOT_FLOW_NOISE)).xy, t),
	);
	const noise =
		fxSample(d.u32(WF_SLOT_FLOW_NOISE), noiseUv, std.mul(dx, noiseSt.xy), std.mul(dy, noiseSt.xy)).x * row.x;
	const flowSt = fxRow(id, d.u32(FX_UV + WF_SLOT_FLOW));
	const flowUv0 = std.add(std.mul(uv, flowSt.xy), flowSt.zw);
	const flowUv = d.vec2f(flowUv0.x + noise * row.y, flowUv0.y);
	const flow = wfSampleClamped(d.u32(WF_SLOT_FLOW), flowUv, std.mul(dx, flowSt.xy), std.mul(dy, flowSt.xy));
	const front = std.saturate(std.add(std.mul(flow, row.z), d.vec4f(noise + row.w)));
	const gradientSt = fxRow(id, d.u32(FX_UV + WF_SLOT_GRADIENT));
	const along = std.saturate(uv.x * row.z + noise + row.w);
	const gradientUv = d.vec2f(std.saturate(along * gradientSt.x + gradientSt.z), uv.y * gradientSt.y);
	const gradientScale = d.vec2f(gradientSt.x * row.z, gradientSt.y);
	const gradient = wfSampleClamped(
		d.u32(WF_SLOT_GRADIENT),
		gradientUv,
		std.mul(dx, gradientScale),
		std.mul(dy, gradientScale),
	);
	const layer0 = wfErosionLayer(id, d.u32(0), uv, dx, dy, t, front.y, gradient.w);
	const layer1 = wfErosionLayer(id, d.u32(1), uv, dx, dy, t, front.z, gradient.w);
	const layer2 = wfErosionLayer(id, d.u32(2), uv, dx, dy, t, front.w, gradient.w);
	let c = std.mul(color, 1 - std.length(flow.xyz));
	c = std.mix(c, layer1, std.saturate(std.length(layer1)));
	c = std.mix(c, layer2, std.saturate(std.length(layer2)));
	c = std.mix(c, layer0, std.saturate(std.length(layer0)));
	return std.add(c, std.mul(std.mul(gradient.xyz, fxRow(id, d.u32(WF_EROSION_EDGE)).xyz), flow.x));
});

const wfPick = tgpu.fn(
	[d.f32, d.vec2f, d.vec2f, d.vec2f, d.vec2f],
	d.vec2f,
)((s, a, b, c, e) => {
	'use gpu';
	return std.mix(std.mix(std.mix(a, b, s), c, std.saturate(s - 1)), e, std.saturate(s - 2));
});

/** fragment entrypoint for `WaterDecal` foam boxes projected onto water depth */
export const fsWaterFoam = tgpu.fragmentFn({
	in: EffectFragmentIn,
	out: d.location(0, d.vec4f),
})((v) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const id = v.look;
	const px = d.vec2i(v.position.xy);
	const waterDevice = std.textureLoad(effectMaterialLayout.$.fxDepth, px, 0);
	const waterDepth = std.select(1e9, frame.localLights.w / waterDevice, waterDevice > 0);
	const rel = std.mul(v.rel, waterDepth / std.dot(v.rel, frame.viewForward.xyz));
	const p = d.vec4f(rel, 1);
	const objectP = d.vec3f(std.dot(v.toObject0, p), std.dot(v.toObject1, p), std.dot(v.toObject2, p));
	const boxUvRow = fxRow(id, d.u32(WF_BOX_UV));
	const box = std.add(std.mul(std.add(objectP.xz, d.vec2f(0.5)), boxUvRow.xy), boxUvRow.zw);
	const centred = std.sub(box, d.vec2f(0.5));
	const polar = fxPolar(centred);
	const world = std.mul(std.add(rel.xz, frame.eye.xz), 0.1);
	const mesh = v.uv.xy;

	const bias = std.exp2(frame.params.y);
	const mip = fxRow(id, d.u32(WF_MIP));
	const baseBias = bias * std.exp2(mip.x);
	const maskBias = bias * std.exp2(mip.y);
	const polarDxRaw = std.dpdx(polar);
	const polarDyRaw = std.dpdy(polar);
	const polarDx = d.vec2f(polarDxRaw.x - std.round(polarDxRaw.x), polarDxRaw.y);
	const polarDy = d.vec2f(polarDyRaw.x - std.round(polarDyRaw.x), polarDyRaw.y);
	const boxDx = std.dpdx(box);
	const boxDy = std.dpdy(box);
	const worldDx = std.dpdx(world);
	const worldDy = std.dpdy(world);
	const meshDx = std.dpdx(mesh);
	const meshDy = std.dpdy(mesh);
	const sources = fxRow(id, d.u32(WF_SOURCES));
	const baseSrc = wfPick(sources.x, box, polar, world, mesh);
	const baseDx = std.mul(wfPick(sources.x, boxDx, polarDx, worldDx, meshDx), baseBias);
	const baseDy = std.mul(wfPick(sources.x, boxDy, polarDy, worldDy, meshDy), baseBias);
	const disturbSrc = wfPick(sources.y, box, polar, world, mesh);
	const disturbDx = std.mul(wfPick(sources.y, boxDx, polarDx, worldDx, meshDx), bias);
	const disturbDy = std.mul(wfPick(sources.y, boxDy, polarDy, worldDy, meshDy), bias);
	const maskSrc = wfPick(sources.z, box, polar, world, mesh);
	const maskDx = std.mul(wfPick(sources.z, boxDx, polarDx, worldDx, meshDx), maskBias);
	const maskDy = std.mul(wfPick(sources.z, boxDy, polarDy, worldDy, meshDy), maskBias);
	const dissolveSrc = wfPick(sources.w, box, polar, world, mesh);

	const tint = fxRow(id, d.u32(WF_TINT));
	const flags = d.u32(tint.w);
	if (
		waterDevice <= 0 ||
		((flags & d.u32(WF_CLIP_TO_BOX)) !== d.u32(0) && std.any(std.ge(std.abs(objectP), d.vec3f(0.5))))
	) {
		return d.vec4f(0);
	}
	const t = frame.eye.w;
	const useDisturb = fxRow(id, d.u32(WF_USE));
	const disturbRow = fxRow(id, d.u32(WF_DISTURB));

	let offset = d.vec2f(0);
	if ((flags & d.u32(WF_DISTURB_ON)) !== d.u32(0)) {
		const st = fxRow(id, d.u32(FX_UV + 1));
		const uv = std.add(
			std.mul(std.add(disturbSrc, std.mul(fxRow(id, d.u32(FX_ANIM + 1)).xy, t)), st.xy),
			st.zw,
		);
		const dVal =
			fxSample(d.u32(1), uv, std.mul(disturbDx, st.xy), std.mul(disturbDy, st.xy)).x * (disturbRow.x + 1) -
			disturbRow.x;
		offset = std.mul(disturbRow.yz, dVal);
	}
	let base = d.vec4f(1);
	{
		const st = fxRow(id, d.u32(FX_UV));
		const uv = std.add(
			std.add(std.mul(std.add(baseSrc, std.mul(offset, useDisturb.x)), st.xy), st.zw),
			std.mul(fxRow(id, d.u32(FX_ANIM)).xy, t),
		);
		base = fxSample(d.u32(0), uv, std.mul(baseDx, st.xy), std.mul(baseDy, st.xy));
	}
	const baseAlpha = std.mix(1, base.w, useDisturb.w);
	let color = std.add(fxRow(id, d.u32(FX_TINT)).xyz, std.mul(std.mul(base.xyz, baseAlpha), tint.xyz));
	let cover = 1 + baseAlpha;
	if ((flags & d.u32(WF_BASE2_ON)) !== d.u32(0)) {
		const b2 = fxRow(id, d.u32(WF_BASE2));
		const b2Tint = fxRow(id, d.u32(WF_BASE2_TINT));
		const st = fxRow(id, d.u32(FX_UV + WF_SLOT_BASE2));
		const b2Bias = bias * std.exp2(b2.z);
		const b2Src = wfPick(b2.x, box, polar, world, mesh);
		const b2Dx = std.mul(wfPick(b2.x, boxDx, polarDx, worldDx, meshDx), b2Bias);
		const b2Dy = std.mul(wfPick(b2.x, boxDy, polarDy, worldDy, meshDy), b2Bias);
		const uv = std.add(
			std.add(std.mul(std.add(b2Src, std.mul(offset, b2.y)), st.xy), st.zw),
			std.mul(fxRow(id, d.u32(FX_ANIM + WF_SLOT_BASE2)).xy, t),
		);
		const sample2 = fxSample(d.u32(WF_SLOT_BASE2), uv, std.mul(b2Dx, st.xy), std.mul(b2Dy, st.xy));
		const alpha2 = std.mix(1, sample2.w, b2Tint.w);
		color = std.add(color, std.mul(std.mul(sample2.xyz, alpha2), b2Tint.xyz));
		cover += alpha2;
	}
	if ((flags & d.u32(WF_DISSOLVE_ON)) !== d.u32(0)) {
		const st = fxRow(id, d.u32(FX_UV + 3));
		const row = fxRow(id, d.u32(WF_DISSOLVE));
		const uv = std.add(
			std.mul(
				std.add(
					std.add(dissolveSrc, std.mul(offset, useDisturb.z)),
					std.mul(fxRow(id, d.u32(FX_ANIM + 3)).xy, t),
				),
				st.xy,
			),
			st.zw,
		);
		const vVal = fxSampleLevel(d.u32(3), uv, mip.z).x - row.x;
		const kept = std.saturate(vVal * row.y);
		const edge = std.saturate((row.z - vVal) * row.y);
		color = std.mul(std.mix(color, std.mul(fxRow(id, d.u32(WF_DISSOLVE_COLOR)).xyz, edge), edge), kept);
		cover *= kept;
	}
	if ((flags & d.u32(WF_MASK_ON)) !== d.u32(0)) {
		const st = fxRow(id, d.u32(FX_UV + 2));
		const m = fxRow(id, d.u32(WF_MASK_MATRIX));
		const turn = d.mat2x2f(m.xy, m.zw);
		const uv = std.add(
			std.add(
				std.mul(
					std.add(
						std.add(std.mul(turn, std.sub(maskSrc, d.vec2f(0.5))), d.vec2f(0.5)),
						std.mul(offset, useDisturb.y),
					),
					st.xy,
				),
				st.zw,
			),
			std.mul(fxRow(id, d.u32(FX_ANIM + 2)).xy, t),
		);
		const mask = fxSample(
			d.u32(2),
			uv,
			std.mul(std.mul(turn, maskDx), st.xy),
			std.mul(std.mul(turn, maskDy), st.xy),
		);
		color = std.mul(color, mask.xyz);
		color = std.mix(color, std.mul(color, mask.w), fxRow(id, d.u32(WF_DISSOLVE)).w);
	}
	if ((flags & d.u32(WF_EROSION_ON)) !== d.u32(0)) {
		color = wfErosion(id, color, mesh, std.mul(meshDx, bias), std.mul(meshDy, bias), t);
	}
	if ((flags & d.u32(WF_BUBBLE_ON)) !== d.u32(0)) {
		const st = fxRow(id, d.u32(FX_UV + WF_SLOT_BUBBLE));
		const b = fxRow(id, d.u32(WF_BUBBLE));
		const bc = fxRow(id, d.u32(WF_BUBBLE_COLOR));
		const acid = fxSample(
			d.u32(WF_SLOT_BUBBLE),
			std.mul(world, st.xy),
			std.mul(worldDx, st.xy),
			std.mul(worldDy, st.xy),
		);
		const phase = std.fract(t * b.y + b.z * acid.y + b.w * acid.x);
		const peak = std.clamp(bc.w, 1e-4, 1 - 1e-4);
		const dist = std.abs(phase - peak);
		const pulse = (std.step(peak, phase) * dist) / (1 - peak) + (std.step(phase, peak) * dist) / peak;
		color = std.add(color, std.mul(bc.xyz, pulse * b.x * acid.x * 10));
	}
	if ((flags & d.u32(WF_FLOATING0_ON | WF_FLOATING1_ON)) !== d.u32(0)) {
		const fl = fxRow(id, d.u32(WF_FLOATING));
		const fc0 = fxRow(id, d.u32(WF_FLOATING_COLOR));
		const fc1 = fxRow(id, d.u32(WF_FLOATING_COLOR_DARK));
		const view = std.normalize(std.neg(rel));
		const n = d.vec3f(0, 1, 0);
		const vtRaw = d.vec3f(view.x, 0, std.dot(view, n));
		const vt = std.mul(vtRaw, std.inverseSqrt(std.max(1.175494e-38, std.dot(vtRaw, vtRaw))));
		const viewOff = std.div(std.div(vt.xy, std.max(0.001, vt.z + 0.42)), std.max(vt.z, 0.001));
		const t0 = t * 0.05;
		const f0 = std.fract(t0 * fl.w);
		const f1 = std.fract((t0 + fl.y) * fl.w);
		const flSrc = wfPick(fl.x, box, polar, world, mesh);
		const flDx = std.mul(wfPick(fl.x, boxDx, polarDx, worldDx, meshDx), bias);
		const flDy = std.mul(wfPick(fl.x, boxDy, polarDy, worldDy, meshDy), bias);
		const du = d.vec2f(offset.x);
		const pUv = std.mix(flSrc, std.add(flSrc, du), fc0.w);
		let layers = d.vec3f(0);
		if ((flags & d.u32(WF_FLOATING0_ON)) !== d.u32(0)) {
			const uv0 = std.add(pUv, std.mul(viewOff, -(1 - f0) * fl.z * 0.5));
			const st0 = fxRow(id, d.u32(FX_UV + WF_SLOT_FLOATING0));
			const s0 = fxSample(
				d.u32(WF_SLOT_FLOATING0),
				std.add(std.mul(std.mix(uv0, std.add(uv0, du), fc0.w), st0.xy), st0.zw),
				std.mul(flDx, st0.xy),
				std.mul(flDy, st0.xy),
			).xyz;
			layers = std.add(layers, std.mul(std.mul(s0, 0.5 - std.abs(0.5 - f0)), fc0.xyz));
		}
		if ((flags & d.u32(WF_FLOATING1_ON)) !== d.u32(0)) {
			const uv1 = std.add(pUv, std.mul(viewOff, -(1 - f1) * fl.z * 0.5));
			const st1 = fxRow(id, d.u32(FX_UV + WF_SLOT_FLOATING1));
			const s1 = fxSample(
				d.u32(WF_SLOT_FLOATING1),
				std.add(std.mul(std.mix(uv1, std.add(uv1, du), fc0.w), st1.xy), st1.zw),
				std.mul(flDx, st1.xy),
				std.mul(flDy, st1.xy),
			).xyz;
			layers = std.add(layers, std.mul(std.mul(s1, 0.5 - std.abs(0.5 - f1)), fc1.xyz));
		}
		color = std.add(color, std.mul(layers, std.saturate(std.dot(view, n))));
	}
	const fade = fxRow(id, d.u32(WF_FADE));
	let edgeFade = d.f32(1);
	if ((flags & d.u32(WF_EDGE_FADE)) !== d.u32(0)) {
		edgeFade = std.saturate(1 - std.length(std.add(std.abs(centred), fade.xy)) * Math.SQRT2);
	}
	let soft = d.f32(1);
	if ((flags & d.u32(WF_SOFT)) !== d.u32(0)) {
		soft = std.saturate((std.saturate(waterDevice - v.position.z) + fade.z) / fade.w);
	}
	const outColor = std.mul(std.max(color, d.vec3f(0)), soft * cover * edgeFade * fxRow(id, d.u32(FX_TINT)).w);
	return d.vec4f(outColor, std.saturate(cover * (1 - disturbRow.w)));
});
