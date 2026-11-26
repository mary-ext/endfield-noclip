/**
 * alpha-blended surface shader (`transparent` / `transparentDepthWrite` in `look.ts`): evaluates the surface
 * forward with sun, local lights, and IBL, applies opacity/Fresnel/fade, and fogs the premultiplied colour at
 * its own depth.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { fadeOpacity, frameLayout } from '../../core/frame-core.ts';
import { shadeSurfaceForward } from '../../lighting/frame-lighting.ts';
import { fogPremultiplied } from '../../sky/fog-shader.ts';

import {
	ALPHA_NORMAL,
	BASE_MAP,
	BASE_SLOT,
	HAS_COLORS,
	MeshFragmentIn,
	MeshVertexData,
	NORMAL_MAP,
	NORMAL_SLOT,
	isFrontFace,
	lookSlot,
	meshDrawLayout,
	meshMaterialLayout,
	sampleSlot,
	surfaceNormal,
} from './common.ts';
import { evalSurface, transparentFresnel } from './surface.ts';

/** fragment entrypoint shading alpha-blended meshes forward over the composited HDR scene */
export const fsTransparent = tgpu.fragmentFn({
	in: {
		...MeshFragmentIn,
		frontFacing: d.builtin.frontFacing,
	},
	out: d.vec4f,
})((input) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const draw = meshDrawLayout.$.draws[input.draw];
	const flags = std.bitcastF32toU32(draw.offset.w);
	const id = lookSlot(draw);
	const look = meshDrawLayout.$.looks[id];
	const gradientScale = std.exp2(frame.params.y);
	const uv0Dx = std.mul(std.dpdx(input.uv.xy), gradientScale);
	const uv0Dy = std.mul(std.dpdy(input.uv.xy), gradientScale);
	const uv1Dx = std.mul(std.dpdx(input.uv.zw), gradientScale);
	const uv1Dy = std.mul(std.dpdy(input.uv.zw), gradientScale);
	const front = isFrontFace(input.frontFacing, input.mirrored);
	const faceted = std.cross(std.dpdx(input.rel), std.dpdy(input.rel));
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
	const ev = evalSurface(v, true, front);
	const radiance = std.select(
		shadeSurfaceForward(ev.surface, input.rel, input.position.xy),
		ev.unlitColor,
		ev.unlit,
	);
	let alpha = d.f32(1);
	if ((flags & d.u32(ALPHA_NORMAL)) !== d.u32(0)) {
		if ((flags & d.u32(NORMAL_MAP)) !== d.u32(0)) {
			alpha = sampleSlot(
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
			).w;
		}
	} else if ((flags & d.u32(BASE_MAP)) !== d.u32(0)) {
		alpha = sampleSlot(
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
		).w;
	}
	alpha = std.saturate(alpha * look.emissive2.w);
	if (look.parallaxBright.y > 0.5 && (flags & d.u32(HAS_COLORS)) !== d.u32(0)) {
		alpha *= input.color.x;
	}
	const premul = look.misc.z > 0.5;
	if (!premul && alpha < 0.01) {
		std.discard();
	}
	if (look.parallaxBright.x > 0.5) {
		const meshN = surfaceNormal(input.normal, faceted, !front);
		const f = transparentFresnel(look, v, front, faceted, meshN, 1, d.vec4f(0));
		alpha *= 1 - look.parallax.w + f.x * look.parallax.w;
	}
	alpha *= fadeOpacity(input.fade);
	const color = std.mul(radiance, std.select(alpha, d.f32(1), premul));
	const uv = std.div(input.position.xy, frame.renderSize.xy);
	const fogged = fogPremultiplied(
		meshDrawLayout.$.post,
		meshDrawLayout.$.froxels,
		meshDrawLayout.$.lutSampler,
		color,
		alpha,
		input.rel,
		uv,
	);
	return d.vec4f(fogged, alpha);
});
