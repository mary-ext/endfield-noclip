/**
 * lean G-buffer path for plain opaque Lit looks (base + normal only, no mask/emissive/detail/layer/parallax/
 * foliage/erosion/unlit/dither/gaps); keeps VGPRs low for the ~86% of opaque materials that need nothing
 * else.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import {
	GBufferOut,
	defaultSurface,
	dynamicVelocity,
	frameLayout,
	packGbuffer,
	packMipFeedback,
} from '../../frame/frame-core.ts';
import { normalZ, unpackNormalXy } from '../../shaders/common/normal-map.ts';

import {
	BASE_MAP,
	BASE_SLOT,
	METALLIC_BASE_ALPHA,
	MeshFragmentIn,
	NORMAL_MAP,
	NORMAL_OCCLUSION,
	NORMAL_RAG,
	NORMAL_ROUGHNESS,
	NORMAL_SLOT,
	isFrontFace,
	lookSlot,
	meshDrawLayout,
	meshMaterialLayout,
	slotUv,
	surfaceNormal,
} from './common.ts';

/** fragment entrypoint for plain opaque Lit meshes writing directly to the G-buffer */
export const fsOpaqueLit = tgpu.fragmentFn({
	in: {
		...MeshFragmentIn,
		frontFacing: d.builtin.frontFacing,
	},
	out: GBufferOut.propTypes,
})((input) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const draw = meshDrawLayout.$.draws[input.draw];
	const flags = std.bitcastF32toU32(draw.offset.w);
	const id = lookSlot(draw);
	const look = meshDrawLayout.$.looks[id];
	const feedback = packMipFeedback(id, input.uv, input.rel, frame.params.y);
	const faceted = std.cross(std.dpdx(input.rel), std.dpdy(input.rel));
	const bias = frame.params.y;
	const base = std.textureSampleBias(
		meshMaterialLayout.$.baseMap,
		meshMaterialLayout.$.baseSampler,
		slotUv(id, input.uv, flags, d.u32(BASE_SLOT)),
		bias,
	);
	const packed = std.textureSampleBias(
		meshMaterialLayout.$.normalMap,
		meshMaterialLayout.$.detailSampler,
		slotUv(id, input.uv, flags, d.u32(NORMAL_SLOT)),
		bias,
	);

	let albedo = std.clamp(std.mul(std.mul(base.xyz, look.tint.xyz), look.surface2.w), d.vec3f(0), d.vec3f(1));
	if ((flags & d.u32(BASE_MAP)) === d.u32(0)) {
		albedo = d.vec3f(1);
	}
	albedo = std.mix(albedo, look.tint.xyz, look.emissive.w);
	const hasNormal = (flags & d.u32(NORMAL_MAP)) !== d.u32(0);

	const front = isFrontFace(input.frontFacing, input.mirrored);
	let n = surfaceNormal(input.normal, faceted, !front);
	if (hasNormal && input.tangent.w !== 0) {
		let rg = d.vec2f(packed.xy);
		if ((flags & d.u32(NORMAL_RAG)) !== d.u32(0)) {
			rg = d.vec2f(packed.x * packed.w, packed.y);
		}
		const xy = unpackNormalXy(rg);
		const tn = d.vec3f(std.mul(xy, look.surface.w), normalZ(xy));
		const t = std.normalize(std.sub(input.tangent.xyz, std.mul(n, std.dot(input.tangent.xyz, n))));
		const bRaw = std.mul(std.cross(input.normal, input.tangent.xyz), input.tangent.w);
		const bFaced = std.select(std.neg(bRaw), bRaw, front);
		const b = std.normalize(std.sub(bFaced, std.mul(n, std.dot(bFaced, n))));
		n = std.normalize(std.add(std.add(std.mul(t, tn.x), std.mul(b, tn.y)), std.mul(n, tn.z)));
	}

	const s = defaultSurface(albedo, n);
	s.roughness = look.surface.y;
	if (hasNormal && (flags & d.u32(NORMAL_ROUGHNESS)) !== d.u32(0)) {
		s.roughness = std.mix(look.surface.x, look.surface.y, packed.z);
	}
	s.metallic = look.surface.z;
	if ((flags & d.u32(METALLIC_BASE_ALPHA)) !== d.u32(0)) {
		s.metallic = std.select(d.f32(0), base.w, (flags & d.u32(BASE_MAP)) !== d.u32(0));
	}
	s.f0 = look.surface2.y;
	if ((flags & d.u32(NORMAL_MAP | NORMAL_OCCLUSION)) === d.u32(NORMAL_MAP | NORMAL_OCCLUSION)) {
		s.occlusion = std.mix(1, packed.w, look.surface2.x);
	}
	const out = packGbuffer(s, look.detail2.w > 0.5, feedback);
	const vel = dynamicVelocity(input.rel, input.prevRel);
	return {
		emission: d.vec4f(out.emission),
		gbufferA: d.vec4f(out.gbufferA),
		gbufferB: d.vec4f(out.gbufferB),
		gbufferC: d.vec4f(out.gbufferC),
		mipFeedback: d.vec4u(out.mipFeedback),
		velocity: d.vec4f(vel, 0, 0),
	};
});
