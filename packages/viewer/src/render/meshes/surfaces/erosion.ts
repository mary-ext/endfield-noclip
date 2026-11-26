/**
 * erosion and sludge surface helpers: `HGRP/Erosion`, `HGRP/ErosionDynamic`, and `HGRP/SludgeV2`.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { Surface, defaultSurface, frameLayout } from '../../core/frame-core.ts';
import { normalZ } from '../../core/shader-math.ts';

import {
	BASE_MAP,
	BASE_SLOT,
	DETAIL_MAP,
	DETAIL_SLOT,
	EMISSIVE_MAP,
	EMISSIVE_SLOT,
	LookSchema,
	MASK_MAP,
	MASK_SLOT,
	MeshVertexData,
	NORMAL_MAP,
	NORMAL_SLOT,
	PARALLAX_MAP,
	PARALLAX_NOISE_MAP,
	PARALLAX_SLOT,
	meshMaterialLayout,
	surfaceNormal,
} from './common.ts';

/**
 * evaluates `HGRP/Erosion`: base/metal blend, parallax noise layer, height flow band, and summed base+detail
 * normals.
 *
 * @param look material look
 * @param v interpolated vertex data
 * @param flags draw look flags
 * @param faceted screen-space faceted normal
 * @param front geometric front-face flag
 * @param packedIn sampled base normal map
 * @param maskIn sampled metal mask map
 * @param detailIn sampled detail normal map
 * @param uv0Dx pre-scaled dpdx of UV0
 * @param uv0Dy pre-scaled dpdy of UV0
 * @returns shaded surface parameters
 */
export const erosionSurface = tgpu.fn(
	[LookSchema, MeshVertexData, d.u32, d.vec3f, d.bool, d.vec4f, d.vec4f, d.vec4f, d.vec2f, d.vec2f],
	Surface,
)((look, v, flags, faceted, front, packedIn, maskIn, detailIn, uv0Dx, uv0Dy) => {
	'use gpu';
	const flatNormal = d.vec4f(0.5, 0.5, 1, 1);
	const packed = std.select(flatNormal, packedIn, (flags & d.u32(NORMAL_MAP)) !== d.u32(0));
	const metalMap = std.select(d.vec4f(1), maskIn, (flags & d.u32(MASK_MAP)) !== d.u32(0));
	const detail = std.select(flatNormal, detailIn, (flags & d.u32(DETAIL_MAP)) !== d.u32(0));
	const baseColor = look.tint.xyz;
	const roughness = look.surface.x;
	const roughnessCover = look.surface.y;
	const metallic = look.surface.z;
	const normalScale = look.surface.w;
	const occlusionStrength = look.surface2.x;
	const metallicOffset = look.surface2.z;
	const detailScale = look.surface2.w;
	const noiseEmissive = look.emissive.x;
	const flowStrength = look.emissive.y;
	const flowEmissive = look.emissive.z;
	const distanceBlend = look.emissive.w;
	const metalColor = look.maskAlbedo[0].xyz;
	const noiseDepth = look.maskAlbedo[0].w;
	const noiseTint = look.maskAlbedo[1].xyz;
	const noiseMin = look.maskAlbedo[1].w;
	const noiseAlphaTint = look.maskAlbedo[2].xyz;
	const flowOffset = look.maskAlbedo[2].w;
	const flowTop = look.maskRoughness.xyz;
	const flowRoughness = look.maskRoughness.w;
	const flowBottom = look.maskMetallic.xyz;
	const flow = look.maskScale;

	let n = surfaceNormal(v.normal, faceted, !front);
	const viewDir = std.normalize(std.neg(v.rel));
	const metal = std.saturate(1 - metalMap.x);
	const hasTangent = v.tangent.w !== 0;
	let b = d.vec3f(0);
	if (hasTangent) {
		b = std.mul(std.cross(v.normal, v.tangent.xyz), v.tangent.w);
	}

	let noiseOffset = d.vec2f(0);
	if (hasTangent && (flags & d.u32(PARALLAX_NOISE_MAP)) !== d.u32(0)) {
		const vt = std.normalize(
			d.vec3f(std.dot(viewDir, v.tangent.xyz), std.dot(viewDir, b), std.dot(viewDir, v.normal)),
		);
		const delta = std.mul(std.div(vt.xy, (vt.z + 0.42) * std.max(vt.z, 0.001)), -noiseDepth);
		const hit = std.textureSampleGrad(
			meshMaterialLayout.$.parallaxNoiseMap,
			meshMaterialLayout.$.parallaxSampler,
			std.add(v.uv.xy, delta),
			uv0Dx,
			uv0Dy,
		).x;
		noiseOffset = std.div(delta, 1 + std.max(hit, 0));
	}
	let noiseRgb = d.vec3f(1);
	if ((flags & d.u32(PARALLAX_MAP)) !== d.u32(0)) {
		const tiling = look.slotUv[PARALLAX_SLOT].xy;
		noiseRgb = std.textureSampleGrad(
			meshMaterialLayout.$.parallaxMap,
			meshMaterialLayout.$.parallaxSampler,
			std.mul(std.add(v.uv.xy, noiseOffset), tiling),
			std.mul(uv0Dx, tiling),
			std.mul(uv0Dy, tiling),
		).xyz;
	}
	const fade = std.max(0.001, 1 - std.saturate(std.length(v.rel) / distanceBlend));
	const noise = std.mul(
		std.mul(noiseRgb, noiseTint),
		packed.w * std.max(std.dot(n, viewDir), noiseMin) * fade,
	);

	const flowU = v.objectPos.y * flow.x + metalMap.y * flow.y + frameLayout.$.frame.eye.w * flow.z + flow.w;
	let ramp = d.vec3f(0.5, 0.5, 1);
	if ((flags & d.u32(EMISSIVE_MAP)) !== d.u32(0)) {
		ramp = std.textureSampleLevel(
			meshMaterialLayout.$.emissiveMap,
			meshMaterialLayout.$.baseSampler,
			d.vec2f(flowU, 0.5),
			0,
		).xyz;
	}
	let below = std.select(d.f32(0), d.f32(1), flowOffset >= 0);
	if (v.objectPos.y !== 0) {
		below = std.saturate(flowOffset / v.objectPos.y);
	}
	below = below * below * (3 - 2 * below);
	const flowColor = std.mul(ramp, std.mix(flowBottom, flowTop, 1 - below));

	const albedo = std.add(
		std.mix(std.add(std.add(baseColor, noise), std.mul(noiseAlphaTint, metal)), metalColor, metal),
		std.mul(flowColor, flowStrength * metalMap.z),
	);

	if (hasTangent) {
		const baseXy = std.sub(std.mul(packed.xy, 2), d.vec2f(1));
		const detailXy = std.sub(std.mul(d.vec2f(detail.x * detail.w, detail.y), 2), d.vec2f(1));
		const tnRaw = std.normalize(
			std.add(
				d.vec3f(std.mul(baseXy, normalScale), normalZ(baseXy)),
				d.vec3f(std.mul(detailXy, detailScale), normalZ(detailXy)),
			),
		);
		const tn = d.vec3f(tnRaw.x, std.mix(tnRaw.y, 0, metal), tnRaw.z);
		const t = std.normalize(std.sub(v.tangent.xyz, std.mul(n, std.dot(v.tangent.xyz, n))));
		const btRaw = std.select(std.neg(b), b, front);
		const bt = std.normalize(std.sub(btRaw, std.mul(n, std.dot(btRaw, n))));
		n = std.normalize(std.add(std.add(std.mul(t, tn.x), std.mul(bt, tn.y)), std.mul(n, tn.z)));
	}

	const s = defaultSurface(std.clamp(albedo, d.vec3f(0), d.vec3f(1)), n);
	s.roughness = std.saturate(
		std.mix(std.mix(roughness * metalMap.w, detail.w, roughnessCover), 0.01, metal) -
			std.length(flowColor) * flowRoughness,
	);
	s.metallic = std.saturate(metallic * (metal - metallicOffset));
	s.f0 = look.surface2.y;
	s.occlusion = 1 - occlusionStrength + metalMap.y * occlusionStrength;
	s.emission = std.add(
		std.mul(noise, noiseEmissive),
		std.mul(flowColor, flowEmissive * std.saturate(1 - metalMap.z)),
	);
	return Surface(s);
});

const erosionRippleRing = tgpu.fn(
	[d.vec3f, d.vec4f, d.f32, d.f32, d.f32, d.f32, d.f32],
	d.vec2f,
)((objPos, cfg, timeSpeed, noise, period, inner, band) => {
	'use gpu';
	if (period <= 1e-5 || cfg.w <= 1e-5) {
		return d.vec2f(0);
	}
	const dist = std.length(std.sub(cfg.xyz, objPos)) * 0.5;
	const normD = dist / cfg.w;
	const fade = 1 - std.saturate(normD);
	const t = timeSpeed + noise * normD;
	const phase = period - (t - std.floor(t / period) * period);
	const wrapped = dist - std.floor((dist - phase) / period) * period;
	const w = std.abs(std.saturate(wrapped - inner) - phase - inner - band * 0.5) / band;
	return d.vec2f(w * w * w, fade);
});

/**
 * evaluates `HGRP/ErosionDynamic`: colour LUT, matcap normal, animated concentric ripples, and flowing bands.
 *
 * @param look material look
 * @param v interpolated vertex data
 * @param flags draw look flags
 * @param faceted screen-space faceted normal
 * @param front geometric front-face flag
 * @param packedIn sampled base normal map
 * @param maskIn sampled metal mask map
 * @param uv0Dx pre-scaled dpdx of UV0
 * @param uv0Dy pre-scaled dpdy of UV0
 * @returns shaded surface parameters
 */
export const erosionDynamicSurface = tgpu.fn(
	[LookSchema, MeshVertexData, d.u32, d.vec3f, d.bool, d.vec4f, d.vec4f, d.vec2f, d.vec2f],
	Surface,
)((look, v, flags, faceted, front, packedIn, maskIn, uv0Dx, uv0Dy) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const flatNormal = d.vec4f(0.5, 0.5, 1, 1);
	const packed = std.select(flatNormal, packedIn, (flags & d.u32(NORMAL_MAP)) !== d.u32(0));
	const metalMap = std.select(d.vec4f(1), maskIn, (flags & d.u32(MASK_MAP)) !== d.u32(0));
	const baseColor = look.tint.xyz;
	const roughness = look.surface.x;
	const roughnessCover = look.surface.y;
	const metallic = look.surface.z;
	const normalScale = look.surface.w;
	const occlusionStrength = look.surface2.x;
	const metallicOffset = look.surface2.z;
	const detailScale = look.surface2.w;
	const noiseEmissive = look.emissive.x;
	const flowStrength = look.emissive.y;
	const detailScroll = look.emissive.z;
	const distanceBlend = look.emissive.w;
	const noiseColorMode = look.emissive2.x;
	const flowRoughnessOffset = look.emissive2.y;
	const matcapAreaOffset = look.emissive2.z;
	const noiseTint = look.maskAlbedo[0].xyz;
	const noiseMin = look.maskAlbedo[0].w;
	const noiseDepth = look.maskAlbedo[1].x;
	const matcapTiling = look.maskAlbedo[1].y;
	const matcapStrength = look.maskAlbedo[1].z;
	const flowOffset = look.maskAlbedo[1].w;
	const flowTop = look.maskRoughness.xyz;
	const flowRoughness = look.maskRoughness.w;
	const flowBottom = look.maskMetallic.xyz;
	const flow = look.maskScale;
	const rippleTop = look.parallax.xyz;
	const rippleWidth = look.parallax.w;
	const rippleBottom = look.parallax2.xyz;
	const ringRatio = look.parallax2.w;
	const rippleSpeed = look.parallaxColor.x;
	const rippleNoiseStrength = look.parallaxColor.y;
	const rippleColorOffset = look.parallaxColor.z;

	const time = frame.eye.w;
	let n = surfaceNormal(v.normal, faceted, !front);
	const viewDir = std.normalize(std.neg(v.rel));
	const rock = metalMap.x;
	const metal = std.saturate(1 - rock);
	const hasTangent = v.tangent.w !== 0;
	let b = d.vec3f(0);
	if (hasTangent) {
		b = std.mul(std.cross(v.normal, v.tangent.xyz), v.tangent.w);
	}

	let noiseOffset = d.vec2f(0);
	if (hasTangent && (flags & d.u32(PARALLAX_MAP)) !== d.u32(0)) {
		const vt = std.normalize(
			d.vec3f(std.dot(viewDir, v.tangent.xyz), std.dot(viewDir, b), std.dot(viewDir, v.normal)),
		);
		const delta = std.mul(std.div(vt.xy, (vt.z + 0.42) * std.max(vt.z, 0.001)), -noiseDepth);
		const hit = std.textureSampleGrad(
			meshMaterialLayout.$.parallaxMap,
			meshMaterialLayout.$.parallaxSampler,
			std.add(v.uv.xy, delta),
			uv0Dx,
			uv0Dy,
		).x;
		noiseOffset = std.div(delta, 1 + std.max(hit, 0));
	}
	let noiseRgb = d.vec3f(1);
	if ((flags & d.u32(PARALLAX_MAP)) !== d.u32(0)) {
		const tiling = look.slotUv[PARALLAX_SLOT].xy;
		noiseRgb = std.textureSampleGrad(
			meshMaterialLayout.$.parallaxMap,
			meshMaterialLayout.$.parallaxSampler,
			std.mul(std.add(v.uv.xy, noiseOffset), tiling),
			std.mul(uv0Dx, tiling),
			std.mul(uv0Dy, tiling),
		).xyz;
	}
	const noiseGrey = d.vec3f((noiseRgb.x + noiseRgb.y + noiseRgb.z) * (1 / 3));
	const noiseC = std.mix(
		noiseRgb,
		std.add(noiseGrey, std.mul(std.sub(noiseRgb, noiseGrey), metal)),
		noiseColorMode,
	);
	const fade = std.max(0.001, 1 - std.saturate(std.length(v.rel) / distanceBlend));
	const noise = std.mul(
		std.mix(std.mul(noiseC, noiseTint), noiseC, metal),
		std.max(std.dot(n, viewDir), noiseMin) * fade,
	);
	const nm = rock - 0.2;
	const noiseMask = std.saturate(nm * nm * nm);

	const rippleNoise = metalMap.y * rippleNoiseStrength;
	const period = rippleWidth * 2;
	const inner = rippleWidth * (1 - ringRatio);
	const band = std.max(0.01, period - inner);
	const r0 = erosionRippleRing(
		v.objectPos,
		look.detail,
		time * rippleSpeed,
		rippleNoise,
		period,
		inner,
		band,
	);
	const r1 = erosionRippleRing(
		v.objectPos,
		look.detail2,
		time * rippleSpeed,
		rippleNoise,
		period,
		inner,
		band,
	);
	const r2 = erosionRippleRing(
		v.objectPos,
		look.detailOverlay,
		time * rippleSpeed,
		rippleNoise,
		period,
		inner,
		band,
	);
	const rippleColor = std.add(
		std.add(
			std.mul(std.mix(rippleTop, rippleBottom, r0.y + rippleColorOffset), r0.x * r0.y),
			std.mul(std.mix(rippleTop, rippleBottom, r1.y + rippleColorOffset), r1.x * r1.y),
		),
		std.mul(std.mix(rippleTop, rippleBottom, r2.y + rippleColorOffset), r2.x * r2.y),
	);
	const nEps = std.mul(n, 0.01);
	const d0 = std.sub(look.detail.xyz, v.objectPos);
	const d1 = std.sub(look.detail2.xyz, v.objectPos);
	const d2 = std.sub(look.detailOverlay.xyz, v.objectPos);
	const rippleN = std.normalize(
		std.add(
			std.add(
				std.mix(
					n,
					std.normalize(std.add(std.mul(std.sub(d0, std.mul(n, std.dot(d0, n))), r0.x), nEps)),
					r0.y,
				),
				std.mix(
					n,
					std.normalize(std.add(std.mul(std.sub(d1, std.mul(n, std.dot(d1, n))), r1.x), nEps)),
					r1.y,
				),
			),
			std.mix(n, std.normalize(std.add(std.mul(std.sub(d2, std.mul(n, std.dot(d2, n))), r2.x), nEps)), r2.y),
		),
	);

	const h = v.objectPos.y + rippleColor.x * 0.2;
	const flowU = h * flow.x + metalMap.w * flow.y - time * flow.z + flow.w;
	let ramp = d.vec3f(0.5, 0.5, 1);
	if ((flags & d.u32(EMISSIVE_MAP)) !== d.u32(0)) {
		ramp = std.textureSampleLevel(
			meshMaterialLayout.$.emissiveMap,
			meshMaterialLayout.$.baseSampler,
			d.vec2f(flowU, 0.5),
			0,
		).xyz;
	}
	let below = std.select(d.f32(0), d.f32(1), flowOffset >= 0);
	if (h !== 0) {
		below = std.saturate(flowOffset / h);
	}
	below = below * below * (3 - 2 * below);
	const rampGrey = d.vec3f((ramp.x + ramp.y + ramp.z) * (1 / 3));
	const flowColor = std.mul(std.mix(rampGrey, ramp, below), std.mix(flowBottom, flowTop, 1 - below));

	let lut = d.vec3f(1);
	if ((flags & d.u32(BASE_MAP)) !== d.u32(0)) {
		lut = std.textureSampleLevel(
			meshMaterialLayout.$.baseMap,
			meshMaterialLayout.$.baseSampler,
			d.vec2f(metal, 0.5),
			0,
		).xyz;
	}
	const rippleMask = metalMap.z;
	const rippleScale = std.max(0.1, rippleMask);
	const albedo = std.add(
		std.add(
			std.add(std.mul(lut, baseColor), std.mul(noise, noiseMask)),
			std.mul(std.clamp(std.mul(rippleColor, rippleScale), d.vec3f(0), d.vec3f(1)), rippleMask),
		),
		std.mul(flowColor, flowStrength * packed.w),
	);

	let matcap = d.vec4f(flatNormal);
	if ((flags & d.u32(PARALLAX_NOISE_MAP)) !== d.u32(0)) {
		const viewN = d.vec2f(std.dot(rippleN, frame.viewRight.xyz), std.dot(rippleN, frame.viewUp.xyz));
		const matcapUv = std.mul(std.add(std.mul(viewN, 0.5), d.vec2f(0.5)), matcapTiling);
		matcap = std.textureSampleLevel(
			meshMaterialLayout.$.parallaxNoiseMap,
			meshMaterialLayout.$.noiseSampler,
			matcapUv,
			0,
		);
	}
	let detail = d.vec4f(flatNormal);
	if ((flags & d.u32(DETAIL_MAP)) !== d.u32(0)) {
		const tiling = look.slotUv[DETAIL_SLOT].xy;
		const detailUv = std.add(
			std.add(std.add(std.mul(v.uv.xy, tiling), d.vec2f(detailScroll * time)), rippleColor.xz),
			std.mul(rippleN.xz, 0.1),
		);
		detail = std.textureSampleGrad(
			meshMaterialLayout.$.detailMap,
			meshMaterialLayout.$.detailSampler,
			detailUv,
			std.mul(uv0Dx, tiling),
			std.mul(uv0Dy, tiling),
		);
	}

	if (hasTangent) {
		const baseN = std.sub(std.mul(packed.xyz, 2), d.vec3f(1));
		const baseTn = d.vec3f(std.mul(baseN.xy, normalScale * rock), baseN.z);
		const matcapXy = std.sub(std.mul(d.vec2f(matcap.x * matcap.w, matcap.y), 2), d.vec2f(1));
		const matcapW =
			std.saturate(metal + matcapAreaOffset) * matcapStrength * (rock + 0.1) * std.saturate(metal - 0.1);
		const matcapTn = d.vec3f(std.mul(matcapXy, matcapW), normalZ(matcapXy));
		const detailXy = std.sub(std.mul(d.vec2f(detail.x * detail.w, detail.y), 2), d.vec2f(1));
		const detailW = std.saturate(1 - metal - matcapAreaOffset) * detailScale * 5;
		const detailTn = d.vec3f(std.mul(detailXy, detailW), normalZ(detailXy));
		const tn = std.normalize(std.add(std.add(baseTn, matcapTn), detailTn));
		const t = std.normalize(std.sub(v.tangent.xyz, std.mul(n, std.dot(v.tangent.xyz, n))));
		const btRaw = std.select(std.neg(b), b, front);
		const bt = std.normalize(std.sub(btRaw, std.mul(n, std.dot(btRaw, n))));
		n = std.normalize(std.add(std.add(std.mul(t, tn.x), std.mul(bt, tn.y)), std.mul(n, tn.z)));
	}

	const s = defaultSurface(std.clamp(albedo, d.vec3f(0), d.vec3f(1)), n);
	const rough0 = std.saturate(
		roughness +
			rock * (1 - roughness) +
			rippleColor.x * rippleScale * rippleMask -
			std.length(flowColor) * flowRoughness * std.saturate(packed.w + flowRoughnessOffset),
	);
	s.roughness = std.mix(rough0, rough0 * detail.w, roughnessCover);
	s.metallic = std.mix(0, metallic, std.saturate(metal + metallicOffset));
	s.f0 = look.surface2.y;
	s.occlusion = 1 - occlusionStrength + metalMap.y * occlusionStrength;
	s.emission = std.mul(noise, noiseEmissive * noiseMask * 10);
	return Surface(s);
});

/**
 * evaluates `HGRP/SludgeV2` fragment shading.
 *
 * @param look material look
 * @param v interpolated vertex data
 * @param flags draw look flags
 * @param faceted screen-space faceted normal
 * @param front geometric front-face flag
 * @param uv0Dx pre-scaled dpdx of UV0
 * @param uv0Dy pre-scaled dpdy of UV0
 * @returns shaded surface parameters
 */
export const sludgeSurface = tgpu.fn(
	[LookSchema, MeshVertexData, d.u32, d.vec3f, d.bool, d.vec2f, d.vec2f],
	Surface,
)((look, v, flags, faceted, front, uv0Dx, uv0Dy) => {
	'use gpu';
	const time = frameLayout.$.frame.eye.w;
	const uv = v.uv.xy;
	const delta = std.sub(uv, d.vec2f(0.5));
	const rad = std.length(delta) * 2;
	const ang = std.atan2(delta.x, delta.y) + Math.PI;
	const polarUv = d.vec2f(ang / (2 * Math.PI), rad);

	const cov2 = v.color.x * 2;
	const t1 = std.saturate(cov2);
	const t2 = std.saturate(cov2 - 1);
	const waveAo = v.color.y;

	const st0 = look.slotUv[BASE_SLOT];
	const st1 = look.slotUv[NORMAL_SLOT];
	const st2 = look.slotUv[MASK_SLOT];
	const st3 = look.slotUv[EMISSIVE_SLOT];
	const st4 = look.slotUv[DETAIL_SLOT];
	const sp0 = look.detail.xy;
	const sp1 = look.detail.zw;
	const sp2 = look.detail2.xy;
	const sp3 = look.detail2.zw;
	const sp4 = look.detailOverlay.xy;

	const uvM1 = std.add(std.mul(std.add(uv, std.mul(sp0, time)), st0.xy), st0.zw);
	const uvM2 = std.add(std.mul(std.add(uv, std.mul(sp1, time)), st1.xy), st1.zw);
	const m1 = std.select(
		d.vec4f(1),
		std.textureSampleGrad(
			meshMaterialLayout.$.baseMap,
			meshMaterialLayout.$.baseSampler,
			uvM1,
			std.mul(uv0Dx, st0.xy),
			std.mul(uv0Dy, st0.xy),
		),
		(flags & d.u32(BASE_MAP)) !== d.u32(0),
	);
	const m2 = std.select(
		d.vec4f(1),
		std.textureSampleGrad(
			meshMaterialLayout.$.normalMap,
			meshMaterialLayout.$.detailSampler,
			uvM2,
			std.mul(uv0Dx, st1.xy),
			std.mul(uv0Dy, st1.xy),
		),
		(flags & d.u32(NORMAL_MAP)) !== d.u32(0),
	);
	const uvM3 = std.add(
		std.add(std.mul(std.add(uv, std.mul(sp2, time)), st2.xy), st2.zw),
		std.mul(m1.xy, 0.1 * look.surface2.w),
	);
	const m3 = std.select(
		d.vec4f(1),
		std.textureSampleGrad(
			meshMaterialLayout.$.maskMap,
			meshMaterialLayout.$.detailSampler,
			uvM3,
			std.mul(uv0Dx, st2.xy),
			std.mul(uv0Dy, st2.xy),
		),
		(flags & d.u32(MASK_MAP)) !== d.u32(0),
	);
	const uvLine = std.add(
		std.add(std.mul(std.add(polarUv, std.mul(sp3, time)), st3.xy), st3.zw),
		std.mul(m1.xx, 0.1),
	);
	const lineTex = std.select(
		d.vec4f(1),
		std.textureSampleLevel(meshMaterialLayout.$.emissiveMap, meshMaterialLayout.$.baseSampler, uvLine, 0),
		(flags & d.u32(EMISSIVE_MAP)) !== d.u32(0),
	);
	const uvEdge = std.add(
		std.add(std.mul(std.add(polarUv, std.mul(sp4, time)), st4.xy), st4.zw),
		std.mul(m3.xy, 0.1),
	);
	const edgeTex = std.select(
		d.vec4f(1),
		std.textureSampleLevel(meshMaterialLayout.$.detailMap, meshMaterialLayout.$.detailSampler, uvEdge, 0),
		(flags & d.u32(DETAIL_MAP)) !== d.u32(0),
	);

	const baseC = std.mix(look.tint.xyz, look.maskAlbedo[0].xyz, t1);
	const lineCol = look.maskAlbedo[1];
	const edgeCol = look.maskAlbedo[2];
	const lineRange = look.maskRoughness.x * (std.sin(ang * 4.7746482 + time) * 0.2 + 0.8);
	const ld = std.saturate(lineRange - t1) / std.max(lineRange, 1e-4);
	const ld2 = ld * ld;
	const lineOut = look.maskRoughness.y * (std.sin(ang * 19.098593 + time * 1.5) * 0.11 + 0.9);
	const lineW =
		lineTex.w *
		lineCol.w *
		(ld2 * ld2 * std.saturate(t1 - lineOut) * std.saturate((rad - look.maskRoughness.z) * 5) * 5);
	const c1 = std.mix(std.mul(baseC, m3.xyz), std.mul(std.mul(lineTex.xyz, lineCol.xyz), m3.xyz), lineW);

	const edgeRange = std.max(look.maskRoughness.w, 1e-4);
	const ed = std.saturate(edgeRange - t1) / edgeRange;
	const ew = t1 * ed * ed * look.maskMetallic.x;
	const edgeC = std.saturate(std.mul(std.mul(edgeCol.xyz, edgeTex.xyz), (m2.x + 0.3) * ew * (m2.x + 0.1)));
	const c2 = std.mix(c1, edgeC, std.saturate(ew * edgeCol.w));
	const c3 = std.mix(c2, std.mul(std.mul(look.emissive.xyz, m3.xyz), waveAo), t2 * t2);

	let n = surfaceNormal(v.normal, faceted, !front);
	if (v.tangent.w !== 0) {
		const tnXy = std.add(
			std.sub(std.add(std.mul(m1.xy, 0.2), std.mul(m2.xy, 0.2)), std.mul(m3.xy, 0.4)),
			std.mul(lineTex.xy, 0.1),
		);
		const tn = std.normalize(d.vec3f(tnXy, 1));
		const t = std.normalize(std.sub(v.tangent.xyz, std.mul(n, std.dot(v.tangent.xyz, n))));
		const bRaw = std.mul(std.cross(v.normal, v.tangent.xyz), v.tangent.w);
		const bFaced = std.select(std.neg(bRaw), bRaw, front);
		const b = std.normalize(std.sub(bFaced, std.mul(n, std.dot(bFaced, n))));
		n = std.normalize(std.add(std.add(std.mul(t, tn.x), std.mul(b, tn.y)), std.mul(n, tn.z)));
	}

	const rough = std.mix(look.surface.x, look.surface.y, m3.x);
	const s = defaultSurface(std.clamp(std.mul(c3, look.surface2.x), d.vec3f(0), d.vec3f(1)), n);
	s.roughness = rough;
	s.metallic = std.saturate(rough + look.surface.z);
	s.f0 = 0.04;
	s.occlusion = look.surface.w;
	s.emission = std.mul(c3, look.surface2.y);
	return Surface(s);
});
