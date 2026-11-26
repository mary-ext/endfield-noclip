/**
 * full HGRP surface evaluation and opaque / cutout-overlay fragment entrypoints.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import {
	frameLayout,
	GBufferOut,
	Surface,
	defaultSurface,
	packGbuffer,
	packGbufferUnlit,
	dynamicVelocity,
	packMipFeedback,
	fadeDiscard,
} from '../../core/frame-core.ts';
import { LUMINANCE_ROUNDED, unpackNormalXy, normalZ } from '../../core/shader-math.ts';

import {
	meshDrawLayout,
	meshMaterialLayout,
	BASE_MAP,
	NORMAL_MAP,
	MASK_MAP,
	EMISSIVE_MAP,
	NORMAL_RAG,
	NORMAL_ROUGHNESS,
	FOLIAGE,
	METALLIC_BASE_ALPHA,
	NORMAL_OCCLUSION,
	EMISSIVE_MASK,
	UNLIT,
	ALPHA_NORMAL,
	TRI_CHANNEL_MASK,
	DETAIL_MAP,
	PARALLAX_MAP,
	PARALLAX_NOISE_MAP,
	UV1_SHIFT,
	EROSION,
	HAS_COLORS,
	FOLIAGE_LEAF,
	VERTEX_OFFSET,
	TRUNK,
	LAYER_BLEND,
	LAYER_SOURCE_TOP,
	DITHER_SURFACE,
	DITHER_ALPHA_COLOR,
	BASE_SLOT,
	NORMAL_SLOT,
	MASK_SLOT,
	EMISSIVE_SLOT,
	DETAIL_SLOT,
	PARALLAX_SLOT,
	NOISE_SLOT,
	LAYER_SLOT,
	EXTRA_TRI_MASK_MAP,
	EXTRA_OVERLAY_MASK_MAP,
	EXTRA_TRI_MASK_SLOT,
	EXTRA_OVERLAY_MASK_SLOT,
	MeshFragmentIn,
	MeshVertexData,
	lookSlot,
	extraFlags,
	slotUv,
	extraSlotUv,
	sampleSlot,
	isFrontFace,
	surfaceNormal,
	ditherBits,
	ditherAlpha,
	ditherVertexColor,
} from './common.ts';
import { erosionSurface, erosionDynamicSurface, sludgeSurface } from './erosion.ts';
import { trunkSurface, leafSurface, grassSurface, flowGlow } from './foliage.ts';
import {
	blendMaskChannel,
	emissivePulse,
	layerCoverage,
	layerFuzzyEdge,
	layerNormal,
	layerSurface,
	mapChannel,
	maskCoverage,
	parallaxGlow,
	parallaxWorldGlow,
	reorientNormal,
	topCoverage,
	transparentFresnel,
} from './layer-parallax.ts';

/** result of {@link evalSurface}: either a PBR {@link Surface} or an unlit HDR colour */
export const SurfaceEval = d.struct({
	surface: Surface,
	unlit: d.bool,
	unlitColor: d.vec3f,
});

/**
 * evaluates all HGRP surface features for a mesh fragment. must be called in uniform control flow.
 *
 * @param v interpolated vertex data
 * @param transparent whether this is the forward transparent pass (enables `_USE_FRESNEL`)
 * @param front geometric front-face flag
 * @returns evaluated surface or unlit colour
 */
export const evalSurface = tgpu.fn(
	[MeshVertexData, d.bool, d.bool],
	SurfaceEval,
)((v, transparent, front) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const draw = meshDrawLayout.$.draws[v.draw];
	const flags = std.bitcast(d.f32, d.u32)(draw.offset.w);
	const extra = extraFlags(draw);
	const id = lookSlot(draw);
	const look = meshDrawLayout.$.looks[id];
	const relDx = std.dpdx(v.rel);
	const relDy = std.dpdy(v.rel);
	const faceted = std.cross(relDx, relDy);
	const bias = frame.params.y;
	const base = std.textureSampleBias(
		meshMaterialLayout.$.baseMap,
		meshMaterialLayout.$.baseSampler,
		slotUv(id, v.uv, flags, d.u32(BASE_SLOT)),
		bias,
	);
	const packed = std.textureSampleBias(
		meshMaterialLayout.$.normalMap,
		meshMaterialLayout.$.detailSampler,
		slotUv(id, v.uv, flags, d.u32(NORMAL_SLOT)),
		bias,
	);
	const mask = std.textureSampleBias(
		meshMaterialLayout.$.maskMap,
		meshMaterialLayout.$.detailSampler,
		slotUv(id, v.uv, flags, d.u32(MASK_SLOT)),
		bias,
	);
	const glow = std.textureSampleBias(
		meshMaterialLayout.$.emissiveMap,
		meshMaterialLayout.$.baseSampler,
		slotUv(id, v.uv, flags, d.u32(EMISSIVE_SLOT)),
		bias,
	);
	const detail = std.textureSampleBias(
		meshMaterialLayout.$.detailMap,
		meshMaterialLayout.$.detailSampler,
		slotUv(id, v.uv, flags, d.u32(DETAIL_SLOT)),
		bias,
	);
	const triMask = std.textureSampleBias(
		meshMaterialLayout.$.triMaskMap,
		meshMaterialLayout.$.detailSampler,
		extraSlotUv(id, v.uv, extra, d.u32(EXTRA_TRI_MASK_SLOT)),
		bias,
	);
	const overlayMask = std.textureSampleBias(
		meshMaterialLayout.$.overlayMaskMap,
		meshMaterialLayout.$.detailSampler,
		extraSlotUv(id, v.uv, extra, d.u32(EXTRA_OVERLAY_MASK_SLOT)),
		bias,
	);
	const gradientScale = std.exp2(bias);
	const uv0Dx = std.mul(std.dpdx(v.uv.xy), gradientScale);
	const uv0Dy = std.mul(std.dpdy(v.uv.xy), gradientScale);
	const uv1Dx = std.mul(std.dpdx(v.uv.zw), gradientScale);
	const uv1Dy = std.mul(std.dpdy(v.uv.zw), gradientScale);

	if (frame.flags.y === d.u32(6) && look.misc.x > 0.5) {
		const world = std.add(v.rel, frame.eye.xyz);
		const stripe = std.fract((world.x + world.y + world.z) * 2) < 0.5;
		const shape = std.select(
			d.f32(1),
			std.dot(base.xyz, LUMINANCE_ROUNDED.$),
			(flags & d.u32(BASE_MAP)) !== d.u32(0),
		);
		return SurfaceEval({
			surface: defaultSurface(d.vec3f(0), d.vec3f(0, 1, 0)),
			unlit: true,
			unlitColor: std.mul(std.select(d.vec3f(0.02), d.vec3f(1, 0.5, 0), stripe), 0.5 + 0.5 * shape),
		});
	}
	if ((flags & d.u32(UNLIT)) !== d.u32(0)) {
		let c = d.vec3f(look.tint.xyz);
		if ((flags & d.u32(BASE_MAP)) !== d.u32(0)) {
			c = std.mul(c, base.xyz);
		}
		c = std.mul(c, ditherVertexColor(look, flags, v.color));
		const bits = ditherBits(look, flags);
		if ((bits & d.u32(DITHER_ALPHA_COLOR)) !== d.u32(0)) {
			const texel = std.select(base, packed, (flags & d.u32(ALPHA_NORMAL)) !== d.u32(0));
			c = std.mul(c, std.saturate(ditherAlpha(look, bits, texel, v.color.w, 1 / v.position.w)));
		}
		if (look.surface.z > 0) {
			const cell = d.vec3i(std.floor(std.div(std.add(v.rel, frame.eye.xyz), look.surface.z)));
			if (((cell.x + cell.y + cell.z) & d.i32(1)) !== d.i32(0)) {
				c = d.vec3f(0);
			}
		}
		c = std.add(c, std.mul(std.max(std.sub(c, d.vec3f(look.surface.x)), d.vec3f(0)), look.surface.y));
		return SurfaceEval({
			surface: defaultSurface(d.vec3f(0), d.vec3f(0, 1, 0)),
			unlit: true,
			unlitColor: std.clamp(
				std.mul(c, std.mix(1, frame.ambient.y, look.emissive2.z)),
				d.vec3f(0),
				d.vec3f(1000),
			),
		});
	}
	if ((flags & d.u32(EROSION)) !== d.u32(0)) {
		let s = defaultSurface(d.vec3f(0), d.vec3f(0, 1, 0));
		if (look.emissive2.w > 1.5) {
			s = sludgeSurface(look, v, flags, faceted, front, uv0Dx, uv0Dy);
		} else if (look.emissive2.w > 0.5) {
			s = erosionDynamicSurface(look, v, flags, faceted, front, packed, mask, uv0Dx, uv0Dy);
		} else {
			s = erosionSurface(look, v, flags, faceted, front, packed, mask, detail, uv0Dx, uv0Dy);
		}
		return SurfaceEval({ surface: Surface(s), unlit: false, unlitColor: d.vec3f(0) });
	}

	let albedo = std.clamp(std.mul(std.mul(base.xyz, look.tint.xyz), look.surface2.w), d.vec3f(0), d.vec3f(1));
	if ((flags & d.u32(BASE_MAP)) === d.u32(0)) {
		albedo = d.vec3f(1);
	}
	albedo = std.mix(albedo, look.tint.xyz, look.emissive.w);
	if ((ditherBits(look, flags) & d.u32(DITHER_SURFACE)) !== d.u32(0)) {
		const texel = std.select(
			d.vec3f(1),
			base.xyz,
			(flags & d.u32(BASE_MAP)) !== d.u32(0) && look.emissive.w < 0.5,
		);
		albedo = std.saturate(std.mul(std.mul(look.tint.xyz, texel), ditherVertexColor(look, flags, v.color)));
	}
	const baseA = std.select(d.f32(0), base.w, (flags & d.u32(BASE_MAP)) !== d.u32(0));
	const hasNormal = (flags & d.u32(NORMAL_MAP)) !== d.u32(0);

	const hasDetail = (flags & d.u32(DETAIL_MAP)) !== d.u32(0);
	let detailWeight = d.f32(0);
	if (hasDetail) {
		const mode = look.detail.y;
		const own = std.mix(std.mix(baseA, packed.z, std.saturate(mode - 2)), packed.w, std.saturate(mode - 3));
		const depth = std.abs(std.dot(v.rel, frame.viewForward.xyz));
		const span = look.detail2.y - look.detail2.x;
		const fade = std.saturate((look.detail2.y - depth) / std.select(span, d.f32(1e-6), span === 0));
		detailWeight = std.mix(std.mix(1, detail.w, std.saturate(mode)), own, std.saturate(mode - 1)) * fade;
		const overlay = std.mix(
			std.clamp(std.mul(std.mul(albedo, look.detailOverlay.xyz), look.detail2.z), d.vec3f(0), d.vec3f(1)),
			look.detailOverlay.xyz,
			look.detailOverlay.w,
		);
		albedo = std.mix(albedo, overlay, detailWeight * (1 - look.detail.x) * (1 - detail.z));
	}
	const detailPbr = look.detail.w * detailWeight;

	const grass = (flags & d.u32(FOLIAGE | FOLIAGE_LEAF)) === d.u32(FOLIAGE);
	const keepBackNormal =
		((flags & d.u32(FOLIAGE_LEAF)) !== d.u32(0) && look.canopyColor.w < 0.5) ||
		(grass && look.foliageAo.w < 0.5);
	const flipBack = !front && !keepBackNormal;
	let n = surfaceNormal(v.normal, faceted, flipBack);

	const layerMaps = d.u32(PARALLAX_MAP | PARALLAX_NOISE_MAP);
	const layered = (flags & d.u32(LAYER_BLEND)) !== d.u32(0) && (flags & layerMaps) === layerMaps;
	const coverSource = look.parallax2.w;
	const topLayer = layered && coverSource === LAYER_SOURCE_TOP;
	let layer = d.vec4f(0);
	let layerBump = d.vec4f(0);
	if (layered) {
		const worldXz = look.parallax.w > 0.5 && look.parallax.w < 1.5;
		const layerSource = std.select(v.uv.xy, std.add(v.rel, frame.eye.xyz).xz, worldXz);
		const layerT = look.slotUv[LAYER_SLOT];
		const layerUv = std.add(std.mul(layerSource, layerT.xy), layerT.zw);
		const layerDx = std.mul(std.select(uv0Dx, std.mul(relDx.xz, gradientScale), worldXz), layerT.xy);
		const layerDy = std.mul(std.select(uv0Dy, std.mul(relDy.xz, gradientScale), worldXz), layerT.xy);
		layer = std.textureSampleGrad(
			meshMaterialLayout.$.parallaxMap,
			meshMaterialLayout.$.parallaxSampler,
			layerUv,
			layerDx,
			layerDy,
		);
		layerBump = std.textureSampleGrad(
			meshMaterialLayout.$.parallaxNoiseMap,
			meshMaterialLayout.$.parallaxSampler,
			layerUv,
			layerDx,
			layerDy,
		);
	}
	let rawCover = d.f32(0);
	let cover = d.f32(0);
	if (layered && !topLayer) {
		const maskR = std.select(d.f32(0), overlayMask.x, (extra & d.u32(EXTRA_OVERLAY_MASK_MAP)) !== d.u32(0));
		const normalA = std.select(d.f32(0), packed.w, hasNormal);
		rawCover = maskCoverage(coverSource, maskR, layerBump.w, baseA, normalA);
		cover = layerCoverage(look, rawCover, layer.w);
	}

	let roughness = look.surface.y;
	if ((hasNormal || layered) && v.tangent.w !== 0) {
		let tn = d.vec3f(0, 0, 1);
		if (hasNormal) {
			let rg = d.vec2f(packed.xy);
			if ((flags & d.u32(NORMAL_RAG)) !== d.u32(0)) {
				rg = d.vec2f(packed.x * packed.w, packed.y);
			}
			let xy = unpackNormalXy(rg);
			if (grass) {
				xy = std.mix(xy, d.vec2f(0, 1), look.foliage.x);
			}
			tn = d.vec3f(std.mul(xy, look.surface.w), normalZ(xy));
			if (hasDetail) {
				const dxy = unpackNormalXy(detail.xy);
				const detN = std.mul(
					d.vec3f(std.mul(dxy, detailWeight * look.detail.z), normalZ(dxy)),
					d.vec3f(-1, -1, 1),
				);
				tn = reorientNormal(tn, detN);
			}
		}
		const t = std.normalize(std.sub(v.tangent.xyz, std.mul(n, std.dot(v.tangent.xyz, n))));
		const bRaw = std.mul(std.cross(v.normal, v.tangent.xyz), v.tangent.w);
		const bFaced = std.select(bRaw, std.neg(bRaw), flipBack && !grass);
		const b = std.normalize(std.sub(bFaced, std.mul(n, std.dot(bFaced, n))));
		if (topLayer) {
			const bumped = std.normalize(std.add(std.add(std.mul(t, tn.x), std.mul(b, tn.y)), std.mul(n, tn.z)));
			rawCover = topCoverage(look, std.mix(n.y, bumped.y, look.parallax.x));
			cover = layerCoverage(look, rawCover, layer.w);
		}
		if (layered) {
			tn = std.mix(tn, layerNormal(look, tn, layerBump), cover);
		}
		n = std.normalize(std.add(std.add(std.mul(t, tn.x), std.mul(b, tn.y)), std.mul(n, tn.z)));
	} else if (topLayer) {
		rawCover = topCoverage(look, n.y);
		cover = layerCoverage(look, rawCover, layer.w);
	}
	if (hasNormal && (flags & d.u32(NORMAL_ROUGHNESS)) !== d.u32(0)) {
		roughness = std.mix(look.surface.x, look.surface.y, packed.z);
	}
	let layerFacing = d.f32(0);
	let layerEdge = d.f32(0);
	if (layered) {
		layerFacing = 1 - std.saturate(std.dot(n, std.normalize(std.neg(v.rel))));
		layerEdge = layerFuzzyEdge(look, rawCover);
		n = std.normalize(std.sub(n, d.vec3f(0, layerEdge * look.foliageAo.w, 0)));
	}

	let s = defaultSurface(albedo, n);
	s.roughness = roughness;
	s.metallic = look.surface.z;
	s.f0 = look.surface2.y;
	if ((flags & d.u32(METALLIC_BASE_ALPHA)) !== d.u32(0)) {
		s.metallic = baseA;
	}
	if ((flags & d.u32(NORMAL_MAP | NORMAL_OCCLUSION)) === d.u32(NORMAL_MAP | NORMAL_OCCLUSION)) {
		s.occlusion = std.mix(1, packed.w, look.surface2.x);
	}
	const mro = (flags & d.u32(MASK_MAP)) !== d.u32(0);
	if (mro) {
		s.metallic = mask.x;
		s.roughness = std.mix(look.surface.x, look.surface.y, mask.y);
		s.occlusion = std.mix(1, mask.z, look.surface2.x);
	}
	if (hasDetail) {
		s.roughness = std.mix(s.roughness, std.mix(detail.w, detail.z, look.detail.x), detailPbr);
		s.occlusion *= std.mix(1, std.mix(1, detail.w, look.detail.x), detailPbr);
	}
	if ((flags & d.u32(TRI_CHANNEL_MASK)) !== d.u32(0) && (extra & d.u32(EXTRA_TRI_MASK_MAP)) !== d.u32(0)) {
		const scale = look.maskScale.xyz;
		const w = std.mul(
			std.saturate(
				std.add(
					std.mul(scale, 0.5),
					std.mix(std.neg(scale), d.vec3f(1), std.add(triMask.xyz, look.maskOffset.xyz)),
				),
			),
			d.vec3f(look.maskAlbedo[0].w, look.maskAlbedo[1].w, look.maskAlbedo[2].w),
		);
		const roughnesses = look.maskRoughness;
		const metallics = look.maskMetallic;
		s = blendMaskChannel(s, w.z, look.maskAlbedo[2].xyz, roughnesses.z, metallics.z);
		s = blendMaskChannel(s, w.y, look.maskAlbedo[1].xyz, roughnesses.y, metallics.y);
		s = blendMaskChannel(s, w.x, look.maskAlbedo[0].xyz, roughnesses.x, metallics.x);
	}
	if (layered) {
		s = layerSurface(s, look, cover, layer, layerBump, layerFacing, layerEdge);
	}

	let emission = d.vec3f(0);
	const hasFresnel = transparent && look.parallaxBright.x > 0.5;
	let emissiveColor = d.vec3f(look.emissive.xyz);
	if (look.emissivePulseStrength.y > 0) {
		emissiveColor = std.mul(
			emissiveColor,
			std.mix(
				1,
				std.cos(frame.eye.w * look.emissivePulseStrength.y * 2 * Math.PI) * 0.5 + 0.5,
				look.emissivePulseStrength.z,
			),
		);
	}
	let strength = d.f32(0);
	if ((flags & d.u32(EMISSIVE_MAP)) !== d.u32(0)) {
		strength = glow.x;
		emission = std.add(
			std.add(
				std.add(std.mul(emissiveColor, glow.x), std.mul(look.emissiveChannels[0].xyz, glow.y)),
				std.mul(look.emissiveChannels[1].xyz, glow.z),
			),
			std.mul(look.emissiveChannels[2].xyz, glow.w),
		);
	}
	if ((flags & d.u32(EMISSIVE_MASK)) !== d.u32(0)) {
		strength = std.saturate((mapChannel(flags, mro, look.emissive2.y, baseA, packed, mask) - 0.05) / 0.9);
		emission = std.mul(emissiveColor, strength);
	}
	if ((flags & d.u32(FOLIAGE_LEAF)) !== d.u32(0) && look.parallaxColor.w > 0.5) {
		let vertexN = d.vec3f(n);
		if (std.dot(v.normal, v.normal) > 1e-6) {
			vertexN = std.normalize(v.normal);
		}
		const fresnelN = std.mix(n, vertexN, look.parallax.z);
		const viewDir = std.normalize(std.neg(v.rel));
		const f =
			1 - std.pow(std.saturate(std.abs(std.dot(viewDir, fresnelN)) + look.parallax.x), look.parallax.y);
		const vg = std.select(d.f32(1), v.color.y, (flags & d.u32(HAS_COLORS)) !== d.u32(0));
		emission = std.add(emission, std.mul(look.parallaxColor.xyz, f * std.mix(1, vg, look.parallax.w)));
	}
	const tinted = look.emissiveAlbedo.w * std.step(0.1, strength);
	s.albedo = std.mul(s.albedo, std.add(d.vec3f(1 - tinted), std.mul(look.emissiveAlbedo.xyz, tinted)));
	const tint = std.mix(s.albedo, d.vec3f(1), look.emissive2.x);
	s.emission = std.mul(std.mul(emission, tint), std.mix(1, frame.ambient.y, look.emissive2.z));
	if (look.emissivePulse.z > 0) {
		s.emission = std.mul(s.emission, std.mix(1, emissivePulse(look), look.emissivePulseStrength.x));
	}

	const parallaxUsers = d.u32(PARALLAX_MAP | PARALLAX_NOISE_MAP | LAYER_BLEND | VERTEX_OFFSET);
	if ((flags & parallaxUsers) === d.u32(PARALLAX_NOISE_MAP)) {
		const noiseUv1 = (flags & (d.u32(1) << d.u32(UV1_SHIFT + NOISE_SLOT))) !== d.u32(0);
		const noiseUv = std.select(v.uv.xy, v.uv.zw, noiseUv1);
		const noiseDx = std.select(uv0Dx, uv1Dx, noiseUv1);
		const noiseDy = std.select(uv0Dy, uv1Dy, noiseUv1);
		s.emission = std.add(s.emission, flowGlow(look, s.albedo, v.color.x, noiseUv, noiseDx, noiseDy));
	}

	if (
		(flags & d.u32(PARALLAX_MAP | LAYER_BLEND | VERTEX_OFFSET | FOLIAGE)) === d.u32(PARALLAX_MAP) &&
		v.tangent.w !== 0
	) {
		const worldParallax = look.parallaxWorld[4].w > 0.5;
		const glowMask = mapChannel(flags, mro, look.parallaxColor.w + 1, baseA, packed, mask);
		if (worldParallax || glowMask > 0.01) {
			const viewDir = std.normalize(std.neg(v.rel));
			const hasNoise = (flags & d.u32(PARALLAX_NOISE_MAP)) !== d.u32(0);
			const pUv1 = (flags & (d.u32(1) << d.u32(UV1_SHIFT + PARALLAX_SLOT))) !== d.u32(0);
			const parallaxUv = std.select(v.uv.xy, v.uv.zw, pUv1);
			const parallaxDx = std.select(uv0Dx, uv1Dx, pUv1);
			const parallaxDy = std.select(uv0Dy, uv1Dy, pUv1);
			if (worldParallax) {
				s.emission = std.add(
					s.emission,
					parallaxWorldGlow(
						look,
						v,
						flags,
						extra,
						viewDir,
						n,
						hasNoise,
						parallaxUv,
						uv0Dx,
						uv0Dy,
						parallaxDx,
						parallaxDy,
						baseA,
						packed,
					),
				);
			} else {
				s.emission = std.add(
					s.emission,
					std.mul(
						parallaxGlow(look, v, viewDir, n, hasNoise, parallaxUv, uv0Dx, uv0Dy, parallaxDx, parallaxDy),
						glowMask * glowMask,
					),
				);
			}
		}
	}

	if ((flags & d.u32(FOLIAGE)) !== d.u32(0)) {
		s.foliage = true;
		s.transmission = look.surface2.z;
		if ((flags & d.u32(FOLIAGE_LEAF)) !== d.u32(0)) {
			s = leafSurface(s, look, v, hasNormal, packed.w);
		} else {
			s = grassSurface(s, look, v, std.select(d.f32(1), packed.w, hasNormal));
		}
	} else if ((flags & d.u32(TRUNK)) !== d.u32(0)) {
		s = trunkSurface(s, look, v, baseA);
	} else if ((flags & d.u32(LAYER_BLEND)) === d.u32(0)) {
		s.scatter = d.vec4f(look.foliage);
		s.scatterIndirect = look.foliageAo.x;
	}
	if (hasFresnel) {
		const f = transparentFresnel(
			look,
			v,
			front,
			faceted,
			s.normal,
			std.select(d.f32(1), base.w, (flags & d.u32(BASE_MAP)) !== d.u32(0)),
			packed,
		);
		const vg = std.select(d.f32(1), v.color.y, (flags & d.u32(HAS_COLORS)) !== d.u32(0));
		const fresnelMask = f.y * std.mix(1, vg, look.parallax2.z);
		s.emission = std.add(
			s.emission,
			std.mul(std.mix(s.albedo, look.parallaxColor.xyz, look.parallaxColor.w * f.x), fresnelMask),
		);
	}
	return SurfaceEval({ surface: Surface(s), unlit: false, unlitColor: d.vec3f(0) });
});

const evalToGbuffer = tgpu.fn(
	[SurfaceEval, d.bool, d.u32, d.vec2f],
	GBufferOut,
)((ev, noLitDecals, feedback, velocity) => {
	'use gpu';
	let out = packGbufferUnlit(ev.unlitColor, feedback);
	if (!ev.unlit) {
		out = packGbuffer(ev.surface, noLitDecals, feedback);
	}
	out.velocity = d.vec4f(velocity, 0, 0);
	return GBufferOut(out);
});

/** fragment entrypoint for full-featured opaque and cutout-shade meshes */
export const fsOpaque = tgpu.fragmentFn({
	in: {
		...MeshFragmentIn,
		frontFacing: d.builtin.frontFacing,
	},
	out: GBufferOut.propTypes,
})((input) => {
	'use gpu';
	const v = MeshVertexData({
		position: d.vec4f(input.position),
		rel: d.vec3f(input.rel),
		normal: d.vec3f(input.normal),
		tangent: d.vec4f(input.tangent),
		uv: d.vec4f(input.uv),
		draw: input.draw,
		phase: input.phase,
		objectPos: d.vec3f(input.objectPos),
		color: d.vec4f(input.color),
		origin: d.vec3f(input.origin),
		fade: input.fade,
		mirrored: input.mirrored,
		prevRel: d.vec3f(input.prevRel),
	});
	const lookId = lookSlot(meshDrawLayout.$.draws[input.draw]);
	const feedback = packMipFeedback(lookId, input.uv, input.rel, frameLayout.$.frame.params.y);
	const ev = evalSurface(v, false, isFrontFace(input.frontFacing, input.mirrored));
	const out = evalToGbuffer(
		ev,
		meshDrawLayout.$.looks[lookId].detail2.w > 0.5,
		feedback,
		dynamicVelocity(input.rel, input.prevRel),
	);
	return {
		emission: d.vec4f(out.emission),
		gbufferA: d.vec4f(out.gbufferA),
		gbufferB: d.vec4f(out.gbufferB),
		gbufferC: d.vec4f(out.gbufferC),
		mipFeedback: d.vec4u(out.mipFeedback),
		velocity: d.vec4f(out.velocity),
	};
});

/** fragment entrypoint for alpha-tested overlay surfaces that skip the prepass (`_ZWRITE_OFF`) */
export const fsCutoutOverlay = tgpu.fragmentFn({
	in: {
		...MeshFragmentIn,
		frontFacing: d.builtin.frontFacing,
	},
	out: GBufferOut.propTypes,
})((input) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const draw = meshDrawLayout.$.draws[input.draw];
	const flags = std.bitcast(d.f32, d.u32)(draw.offset.w);
	const id = lookSlot(draw);
	const look = meshDrawLayout.$.looks[id];
	const gradientScale = std.exp2(frame.params.y);
	const uv0Dx = std.mul(std.dpdx(input.uv.xy), gradientScale);
	const uv0Dy = std.mul(std.dpdy(input.uv.xy), gradientScale);
	const uv1Dx = std.mul(std.dpdx(input.uv.zw), gradientScale);
	const uv1Dy = std.mul(std.dpdy(input.uv.zw), gradientScale);
	const v = MeshVertexData({
		position: d.vec4f(input.position),
		rel: d.vec3f(input.rel),
		normal: d.vec3f(input.normal),
		tangent: d.vec4f(input.tangent),
		uv: d.vec4f(input.uv),
		draw: input.draw,
		phase: input.phase,
		objectPos: d.vec3f(input.objectPos),
		color: d.vec4f(input.color),
		origin: d.vec3f(input.origin),
		fade: input.fade,
		mirrored: input.mirrored,
		prevRel: d.vec3f(input.prevRel),
	});
	const feedback = packMipFeedback(id, input.uv, input.rel, frame.params.y);
	const ev = evalSurface(v, false, isFrontFace(input.frontFacing, input.mirrored));
	if (fadeDiscard(input.fade, input.position.xy)) {
		std.discard();
	}
	let texel = d.vec4f(0);
	if ((flags & d.u32(ALPHA_NORMAL)) !== d.u32(0)) {
		texel = sampleSlot(
			meshMaterialLayout.$.normalMap,
			meshMaterialLayout.$.detailSampler,
			id,
			input.uv,
			uv0Dx,
			uv0Dy,
			uv1Dx,
			uv1Dy,
			flags,
			d.u32(NORMAL_SLOT),
		);
	} else {
		texel = sampleSlot(
			meshMaterialLayout.$.baseMap,
			meshMaterialLayout.$.baseSampler,
			id,
			input.uv,
			uv0Dx,
			uv0Dy,
			uv1Dx,
			uv1Dy,
			flags,
			d.u32(BASE_SLOT),
		);
	}
	if (texel.w < look.tint.w) {
		std.discard();
	}
	const out = evalToGbuffer(ev, look.detail2.w > 0.5, feedback, dynamicVelocity(input.rel, input.prevRel));
	return {
		emission: d.vec4f(out.emission),
		gbufferA: d.vec4f(out.gbufferA),
		gbufferB: d.vec4f(out.gbufferB),
		gbufferC: d.vec4f(out.gbufferC),
		mipFeedback: d.vec4u(out.mipFeedback),
		velocity: d.vec4f(out.velocity),
	};
});

// #endregion
