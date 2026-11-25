/**
 * `HGRP/DecalLit` G-buffer decal blending (`fsDecalGbuffer`) and `HGRP/WetnessDecal` max-blended wetness mask
 * (`fsWetnessDecal`).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout } from '../../frame/frame-core.ts';
import {
	SHADING_LIT,
	gbufferBFlags,
	gbufferBNoLitDecals,
	gbufferBNormal,
	gbufferBValid,
	gbufferShadingModel,
	packGbufferB,
} from '../../shaders/common/gbuffer.ts';
import { normalZ, unpackNormalXy } from '../../shaders/common/normal-map.ts';

import {
	EffectFragmentIn,
	EffectVertexData,
	FX_TINT,
	FX_UV,
	effectMaterialLayout,
	fxRow,
	fxSceneDepth,
} from './common.ts';

const LD_SURFACE = 17;
const LD_WRITES = 18;
const LD_PBR = 19;
const LD_CHANNELS = 20;
const LD_WATER = 21;
const LD_FLOW = 22;
const LD_FLOW_FADE = 23;
const LD_EMISSIVE = 24;
const LD_EMISSIVE_MASK = 25;
const LD_PBR_PLACED = 26;
const LD_WET_MASK = 27;
const LD_SLUDGE = 32;
const LD_SLUDGE_SLOT = 2;

const ldChannel = tgpu.fn(
	[d.vec4f, d.f32, d.f32],
	d.f32,
)((p, channel, offset) => {
	'use gpu';
	const c = channel + offset;
	return std.mix(
		std.mix(p.x, p.y, std.saturate(c - 2)),
		std.mix(p.z, p.w, std.saturate(c - 4)),
		std.saturate(c - 3),
	);
});

const ldTangentNormal = tgpu.fn(
	[d.vec2f],
	d.vec3f,
)((rg) => {
	'use gpu';
	const xy = unpackNormalXy(rg);
	return d.vec3f(xy, normalZ(xy));
});

const LitDecal = d.struct({
	alpha: d.f32,
	albedo: d.vec3f,
	normal: d.vec3f,
	roughness: d.f32,
	metallic: d.f32,
	occlusion: d.f32,
	writesMetallic: d.bool,
	writesOcclusion: d.bool,
	emission: d.vec3f,
});

const ldDecal = tgpu.fn(
	[EffectVertexData, d.vec3f, d.vec3f, d.vec3f, d.vec3f, d.vec2f, d.vec2f, d.vec2f, d.vec3f, d.f32],
	LitDecal,
)((data, rel, relDx, relDy, local, uv, dx, dy, n, roughness) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const id = data.look;
	const baseT = data.placementUv;
	const base = std.textureSampleGrad(
		effectMaterialLayout.$.fxTex0,
		effectMaterialLayout.$.fxSamp0,
		std.add(std.mul(uv, baseT.xy), baseT.zw),
		std.mul(dx, baseT.xy),
		std.mul(dy, baseT.xy),
	);
	const pbrT = std.select(
		fxRow(id, d.u32(FX_UV + 1)),
		data.placementUv,
		fxRow(id, d.u32(LD_PBR_PLACED)).x > 0.5,
	);
	const tint = std.mul(data.placementColor, fxRow(id, d.u32(FX_TINT)));
	const surfaceRow = fxRow(id, d.u32(LD_SURFACE));
	const writes = fxRow(id, d.u32(LD_WRITES));
	const pbrRow = fxRow(id, d.u32(LD_PBR));
	const channels = fxRow(id, d.u32(LD_CHANNELS));
	const water = fxRow(id, d.u32(LD_WATER));
	const pbrBase = channels.x > 0.5;

	let albedo = std.mul(tint.xyz, std.select(base.xyz, d.vec3f(1), pbrBase));
	let outNormal = d.vec3f(n);
	let outRoughness = roughness;
	let metallic = d.f32(0);
	let occlusion = d.f32(1);
	let writesMetallic = false;
	let writesOcclusion = false;
	let emission = d.vec3f(0);
	let alpha = base.w * tint.w;
	if (surfaceRow.w > 0) {
		alpha *= std.pow(std.max(std.saturate(std.dot(data.up, n)), 5.96e-8), surfaceRow.w);
	}
	const sludge = fxRow(id, d.u32(LD_SLUDGE));
	if (sludge.x > 0.5) {
		const st = fxRow(id, d.u32(FX_UV + LD_SLUDGE_SLOT)).xy;
		const localDx = d.vec3f(
			std.dot(data.toObject0.xyz, relDx),
			std.dot(data.toObject1.xyz, relDx),
			std.dot(data.toObject2.xyz, relDx),
		);
		const localDy = d.vec3f(
			std.dot(data.toObject0.xyz, relDy),
			std.dot(data.toObject1.xyz, relDy),
			std.dot(data.toObject2.xyz, relDy),
		);
		const sideX = std.textureSampleGrad(
			effectMaterialLayout.$.fxTex2,
			effectMaterialLayout.$.fxSamp2,
			std.mul(local.zy, st),
			std.mul(localDx.zy, st),
			std.mul(localDy.zy, st),
		);
		const sideZ = std.textureSampleGrad(
			effectMaterialLayout.$.fxTex2,
			effectMaterialLayout.$.fxSamp2,
			std.mul(local.xy, st),
			std.mul(localDx.xy, st),
			std.mul(localDy.xy, st),
		);
		const w = std.mul(n, n);
		albedo = std.add(std.add(std.mul(albedo, w.y), std.mul(sideX.xyz, w.x)), std.mul(sideZ.xyz, w.z));
		alpha *= sludge.y * std.saturate(1 - local.y * sludge.z);
	}

	let tangentN = d.vec3f(0, 0, 1);
	let pbr = d.vec4f(0);
	if (water.x > 0.5) {
		const flow = fxRow(id, d.u32(LD_FLOW));
		const steep = std.pow(std.max(std.abs(1 - std.abs(n.y)), 5.96e-8), fxRow(id, d.u32(LD_FLOW_FADE)).x);
		alpha *= steep;
		const n2 = std.mul(n, n);
		const w = std.div(n2.xz, std.max(n2.x + n2.z, 1e-5));
		const push = d.vec2f(0, steep * water.w);
		const world = std.add(frame.eye.xyz, rel);
		const scroll = d.vec2f(0, frame.eye.w);
		const zy = std.mul(world.zy, pbrT.xy);
		const xy = std.mul(world.xy, pbrT.xy);
		const zyDx = std.mul(relDx.zy, pbrT.xy);
		const zyDy = std.mul(relDy.zy, pbrT.xy);
		const xyDx = std.mul(relDx.xy, pbrT.xy);
		const xyDy = std.mul(relDy.xy, pbrT.xy);
		const aZy = std.textureSampleGrad(
			effectMaterialLayout.$.fxTex1,
			effectMaterialLayout.$.fxSamp1,
			std.add(std.add(std.mul(zy, flow.z), std.mul(scroll, flow.x)), push),
			std.mul(zyDx, flow.z),
			std.mul(zyDy, flow.z),
		);
		const aXy = std.textureSampleGrad(
			effectMaterialLayout.$.fxTex1,
			effectMaterialLayout.$.fxSamp1,
			std.add(std.add(std.mul(xy, flow.z), std.mul(scroll, flow.x)), push),
			std.mul(xyDx, flow.z),
			std.mul(xyDy, flow.z),
		);
		const bZy = std.textureSampleGrad(
			effectMaterialLayout.$.fxTex1,
			effectMaterialLayout.$.fxSamp1,
			std.add(std.add(std.mul(zy, flow.w), std.mul(scroll, flow.y)), push),
			std.mul(zyDx, flow.w),
			std.mul(zyDy, flow.w),
		);
		const bXy = std.textureSampleGrad(
			effectMaterialLayout.$.fxTex1,
			effectMaterialLayout.$.fxSamp1,
			std.add(std.add(std.mul(xy, flow.w), std.mul(scroll, flow.y)), push),
			std.mul(xyDx, flow.w),
			std.mul(xyDy, flow.w),
		);
		const t = std.add(
			std.mul(std.add(ldTangentNormal(aZy.xy), ldTangentNormal(bZy.xy)), w.x),
			std.mul(std.add(ldTangentNormal(aXy.xy), ldTangentNormal(bXy.xy)), w.y),
		);
		tangentN = d.vec3f(std.mul(t.xy, water.y), t.z);
		pbr = d.vec4f(0, 0, (aZy.z + aXy.z) * 0.5, 0);
		if (writes.y > 0.5) {
			outRoughness = water.z * pbr.z;
		}
	} else {
		const sampled = std.textureSampleGrad(
			effectMaterialLayout.$.fxTex1,
			effectMaterialLayout.$.fxSamp1,
			std.add(std.mul(uv, pbrT.xy), pbrT.zw),
			std.mul(dx, pbrT.xy),
			std.mul(dy, pbrT.xy),
		);
		pbr = std.select(sampled, base, pbrBase);
		const t = ldTangentNormal(pbr.xy);
		tangentN = d.vec3f(std.mul(t.xy, surfaceRow.z), t.z);
		if (writes.y > 0.5) {
			outRoughness = std.mix(surfaceRow.x, surfaceRow.y, pbr.z);
		}
		const emissive = fxRow(id, d.u32(LD_EMISSIVE));
		if (emissive.w > 0.5) {
			const mask = fxRow(id, d.u32(LD_EMISSIVE_MASK));
			const c = mask.x;
			const rgba = std.mix(
				std.mix(sampled.x, sampled.y, std.saturate(c)),
				std.mix(sampled.z, sampled.w, std.saturate(c - 2)),
				std.saturate(c - 1),
			);
			const strength = std.mix(rgba, base.w, std.saturate(c - 3));
			emission = std.mul(
				std.mul(emissive.xyz, strength * std.mix(1, frame.ambient.y, mask.z)),
				std.mix(albedo, d.vec3f(1), mask.y),
			);
		}
	}
	const outAlpha = std.saturate(alpha);
	if (writes.x > 0.5) {
		const t = std.normalize(data.toObject0.xyz);
		const frameN = std.normalize(std.mix(data.up, n, writes.z));
		const b = std.neg(std.mix(std.cross(data.up, t), std.cross(n, t), writes.z));
		const decalN = std.normalize(
			std.add(std.add(std.mul(t, tangentN.x), std.mul(b, tangentN.y)), std.mul(frameN, tangentN.z)),
		);
		outNormal = std.normalize(std.mix(n, decalN, channels.w));
	}
	if (pbrRow.x > 0.5) {
		writesMetallic = true;
		metallic = std.mix(
			pbrRow.z * std.saturate(channels.y),
			ldChannel(pbr, channels.y, 0),
			std.saturate(channels.y - 1),
		);
	}
	if (pbrRow.y > 0.5) {
		writesOcclusion = true;
		const occ = std.mix(1, ldChannel(pbr, channels.z, 1), std.saturate(channels.z));
		occlusion = 1 - pbrRow.w + occ * pbrRow.w;
	}
	return LitDecal({
		alpha: outAlpha,
		albedo,
		normal: outNormal,
		roughness: outRoughness,
		metallic,
		occlusion,
		writesMetallic,
		writesOcclusion,
		emission,
	});
});

const wdWetness = tgpu.fn(
	[EffectVertexData, d.vec3f, d.vec3f, d.vec3f, d.vec3f, d.vec3f, d.vec3f, d.vec4f],
	d.f32,
)((data, rel, relDx, relDy, local, localDx, localDy, row) => {
	'use gpu';
	const wet =
		data.placementColor.w * fxRow(data.look, d.u32(FX_TINT)).w * (1 - std.saturate(std.length(rel) * row.w));
	if (row.y < 0.5) {
		return wet;
	}
	const geometric = std.cross(relDy, relDx);
	const axisN = std.abs(
		d.vec3f(
			std.dot(data.toObject0.xyz, geometric) / std.dot(data.toObject0.xyz, data.toObject0.xyz),
			std.dot(data.toObject1.xyz, geometric) / std.dot(data.toObject1.xyz, data.toObject1.xyz),
			std.dot(data.toObject2.xyz, geometric) / std.dot(data.toObject2.xyz, data.toObject2.xyz),
		),
	);
	const lead = std.sub(axisN.xy, std.max(axisN.yz, axisN.zx));
	let p = d.vec3f(local.xzy);
	let pDx = d.vec3f(localDx.xzy);
	let pDy = d.vec3f(localDy.xzy);
	if (lead.x > 0) {
		p = d.vec3f(local.yzx);
		pDx = d.vec3f(localDx.yzx);
		pDy = d.vec3f(localDy.yzx);
	} else if (lead.y <= 0) {
		p = d.vec3f(local);
		pDx = d.vec3f(localDx);
		pDy = d.vec3f(localDy);
	}
	const placed = data.placementUv;
	const st = fxRow(data.look, d.u32(FX_UV));
	const scale = std.mul(placed.xy, st.xy);
	const uv = std.add(
		std.mul(std.add(std.mul(std.add(p.xy, d.vec2f(0.5)), placed.xy), placed.zw), st.xy),
		st.zw,
	);
	const mask = std.textureSampleGrad(
		effectMaterialLayout.$.fxTex0,
		effectMaterialLayout.$.fxSamp0,
		uv,
		std.mul(pDx.xy, scale),
		std.mul(pDy.xy, scale),
	).x;
	return wet * mask * std.saturate(1 - std.abs(p.z) * 2 + row.z);
});

/** fragment entrypoint for `HGRP/DecalLit` blended directly into the G-buffer */
export const fsDecalGbuffer = tgpu.fragmentFn({
	in: EffectFragmentIn,
	out: {
		emission: d.location(0, d.vec4f),
		gbufferA: d.location(1, d.vec4f),
		gbufferB: d.location(2, d.vec4f),
		gbufferC: d.location(3, d.vec4f),
	},
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
	const px = d.vec2i(data.position.xy);
	const sceneDepth = fxSceneDepth(px);
	const rel = std.mul(data.rel, sceneDepth / std.dot(data.rel, frame.viewForward.xyz));
	const p = d.vec4f(rel, 1);
	const objectP = d.vec3f(std.dot(data.toObject0, p), std.dot(data.toObject1, p), std.dot(data.toObject2, p));
	const uv = std.add(objectP.xz, d.vec2f(0.5));
	const objectDx = std.dpdx(objectP);
	const objectDy = std.dpdy(objectP);
	const relDx = std.dpdx(rel);
	const relDy = std.dpdy(rel);
	const prevGb = std.textureLoad(effectMaterialLayout.$.fxSurface, px, 0);
	if (
		std.any(std.ge(std.abs(objectP), d.vec3f(0.5))) ||
		sceneDepth >= 1e9 ||
		!gbufferBValid(prevGb) ||
		gbufferBNoLitDecals(prevGb)
	) {
		std.discard();
	}
	const prevN = gbufferBNormal(prevGb);
	const prevR = prevGb.z;
	const dec = ldDecal(data, rel, relDx, relDy, objectP, uv, objectDx.xz, objectDy.xz, prevN, prevR);
	if (dec.alpha <= 0) {
		std.discard();
	}
	const prevGa = std.textureLoad(effectMaterialLayout.$.fxGbufferA, px, 0);
	const writesAlbedo = fxRow(data.look, d.u32(LD_WRITES)).w > 0.5;
	const wet = fxRow(data.look, d.u32(LD_PBR_PLACED));
	const emission = d.vec4f(std.mul(dec.emission, dec.alpha), 0);
	const blendedN = std.normalize(std.mix(prevN, dec.normal, dec.alpha));
	const blendedR = std.mix(prevR, dec.roughness, dec.alpha);
	const gbufferB = packGbufferB(blendedN, blendedR, gbufferBFlags(prevGb));
	let gaX = prevGa.x;
	let gaY = prevGa.y;
	let gbufferC = d.vec4f(0);
	if (wet.y > 0.5) {
		const covered = dec.alpha * wet.w;
		if (dec.writesOcclusion && gbufferShadingModel(prevGa) === d.u32(SHADING_LIT)) {
			gaY = std.mix(prevGa.y, dec.occlusion, covered);
		}
		const keep = (1 - wet.z * dec.alpha) * (1 - covered);
		gbufferC = d.vec4f(std.mul(std.saturate(dec.albedo), covered), 1 - keep);
	} else {
		if (gbufferShadingModel(prevGa) === d.u32(SHADING_LIT)) {
			if (dec.writesMetallic) {
				gaX = std.mix(prevGa.x, dec.metallic, dec.alpha);
			}
			if (dec.writesOcclusion) {
				gaY = std.mix(prevGa.y, dec.occlusion, dec.alpha);
			}
		}
		if (writesAlbedo) {
			gbufferC = d.vec4f(std.mul(std.saturate(dec.albedo), dec.alpha), dec.alpha);
		}
	}
	return {
		emission,
		gbufferA: d.vec4f(gaX, gaY, prevGa.z, prevGa.w),
		gbufferB,
		gbufferC,
	};
});

/** fragment entrypoint for `HGRP/WetnessDecal` writing max-blended wetness into the wetness mask */
export const fsWetnessDecal = tgpu.fragmentFn({
	in: EffectFragmentIn,
	out: d.location(0, d.vec4f),
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
	const px = d.vec2i(data.position.xy);
	const sceneDepth = fxSceneDepth(px);
	const rel = std.mul(data.rel, sceneDepth / std.dot(data.rel, frame.viewForward.xyz));
	const p = d.vec4f(rel, 1);
	const objectP = d.vec3f(std.dot(data.toObject0, p), std.dot(data.toObject1, p), std.dot(data.toObject2, p));
	const objectDx = std.dpdx(objectP);
	const objectDy = std.dpdy(objectP);
	const relDx = std.dpdx(rel);
	const relDy = std.dpdy(rel);
	const prevGb = std.textureLoad(effectMaterialLayout.$.fxSurface, px, 0);
	if (
		std.any(std.ge(std.abs(objectP), d.vec3f(0.5))) ||
		sceneDepth >= 1e9 ||
		!gbufferBValid(prevGb) ||
		gbufferBNoLitDecals(prevGb)
	) {
		std.discard();
	}
	const w = wdWetness(
		data,
		rel,
		relDx,
		relDy,
		objectP,
		objectDx,
		objectDy,
		fxRow(data.look, d.u32(LD_WET_MASK)),
	);
	if (w <= 0) {
		std.discard();
	}
	return d.vec4f(w, w, 0, 0);
});
