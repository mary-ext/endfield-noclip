/**
 * mesh surface vertex and depth/cutout prepass entrypoints (`vsMain`, `vsDepth`, `fsDepth`, `vsDepthFade`,
 * `fsDepthFade`, `vsCutoutDepth`, `fsCutoutDepth`).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import {
	frameLayout,
	sheetUv,
	rowBlock,
	listRow,
	listFade,
	fadeDiscard,
	rowBasis,
} from '../../core/frame-core.ts';
import { gradientNoise, octDecode } from '../../core/shader-math.ts';

import {
	meshInstancesLayout,
	meshDrawLayout,
	meshMaterialLayout,
	HAS_NORMALS,
	HAS_TANGENTS,
	ALPHA_NORMAL,
	EROSION,
	HAS_COLORS,
	DITHER_MASK,
	DITHER_MASK_RED,
	BASE_SLOT,
	NORMAL_SLOT,
	NOISE_SLOT,
	MeshVertexIn,
	MeshVertexOut,
	DepthIn,
	CutoutDepthIn,
	FadeDepthOut,
	FadeDepthIn,
	CutoutDepthOut,
	CutoutDepthVaryings,
	lookSlot,
	sampleSlot,
	ditherAlpha,
} from './common.ts';
import { instanceRel, instancePrevRel, vertexOffsetAt, sludgeVertex } from './vertex-motion.ts';

/** main vertex entrypoint for opaque, cutout, and transparent surface meshes */
export const vsMain = tgpu.vertexFn({
	in: { ...MeshVertexIn, ii: d.builtin.instanceIndex },
	out: MeshVertexOut,
})((input) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const entry = meshInstancesLayout.$.list[input.ii];
	const row = meshInstancesLayout.$.rows[listRow(entry)];
	const drawId = meshDrawLayout.$.drawIds[input.ii];
	const draw = meshDrawLayout.$.draws[drawId];
	const look = meshDrawLayout.$.looks[lookSlot(draw)];
	const p = std.add(draw.offset.xyz, std.mul(input.position.xyz, draw.scale.xyz));
	const origin = std.add(
		d.vec3f(row.t0.w, row.t1.w, row.t2.w),
		meshInstancesLayout.$.blocks[rowBlock(row.block)].xyz,
	);
	const m = rowBasis(row.t0, row.t1, row.t2, row.info);
	const mirrored = std.determinant(m) < 0;
	const flags = std.bitcastF32toU32(draw.offset.w);
	const uv = d.vec4f(
		std.add(std.mul(input.uv0, draw.uv0.xy), draw.uv0.zw),
		std.add(std.mul(input.uv1, draw.uv1.xy), draw.uv1.zw),
	);
	if ((flags & d.u32(EROSION)) !== d.u32(0) && look.emissive2.w > 1.5) {
		const sv = sludgeVertex(uv.xy, origin, m, look);
		if (sv.discarded) {
			return {
				position: d.vec4f(0),
				rel: d.vec3f(0),
				normal: d.vec3f(0),
				tangent: d.vec4f(0),
				uv: d.vec4f(0),
				draw: d.u32(0),
				phase: 0,
				objectPos: d.vec3f(0),
				color: d.vec4f(0),
				origin: d.vec3f(0),
				fade: d.u32(0),
				mirrored: d.u32(0),
				prevRel: d.vec3f(0),
			};
		}
		return {
			position: std.mul(frame.viewProj, d.vec4f(sv.rel, 1)),
			rel: d.vec3f(sv.rel),
			normal: d.vec3f(sv.normal),
			tangent: d.vec4f(sv.tangent),
			uv,
			draw: drawId,
			phase: 0,
			objectPos: p,
			color: d.vec4f(sv.color),
			origin,
			fade: listFade(entry),
			mirrored: std.select(d.u32(0), d.u32(1), mirrored),
			prevRel: d.vec3f(sv.prevRel),
		};
	}
	const rel = std.add(
		instanceRel(input.position, input.color, input.ii, draw, look),
		vertexOffsetAt(flags, look, m, uv, input.position.w, frame.eye.w),
	);
	const prevRel = std.add(
		instancePrevRel(input.position, input.color, input.ii, draw, look),
		vertexOffsetAt(flags, look, m, uv, input.position.w, frame.prevTime.x),
	);
	let n = d.vec3f(0);
	if ((flags & d.u32(HAS_NORMALS)) !== d.u32(0)) {
		n = std.mul(m, octDecode(input.normal));
	}
	let t = d.vec4f(0);
	if ((flags & d.u32(HAS_TANGENTS)) !== d.u32(0)) {
		const sign =
			std.select(d.f32(-1), d.f32(1), input.tangent.z >= 0) * std.select(d.f32(1), d.f32(-1), mirrored);
		t = d.vec4f(std.mul(m, octDecode(input.tangent.xy)), sign);
	}
	const world = std.add(origin, frame.eye.xyz);
	return {
		position: std.mul(frame.viewProj, d.vec4f(rel, 1)),
		rel,
		normal: n,
		tangent: t,
		uv: sheetUv(row.sheet, uv),
		draw: drawId,
		phase: world.x + world.y + world.z,
		objectPos: p,
		color: std.mul(
			std.select(d.vec4f(1), input.color, (flags & d.u32(HAS_COLORS)) !== d.u32(0)),
			std.unpack4x8unorm(row.color),
		),
		origin,
		fade: listFade(entry),
		mirrored: std.select(d.u32(0), d.u32(1), mirrored),
		prevRel,
	};
});

/** position-only vertex entrypoint for opaque depth prepass and shadow passes */
export const vsDepth = tgpu.vertexFn({
	in: { ...DepthIn, ii: d.builtin.instanceIndex },
	out: { position: d.builtin.position },
})((input) => {
	'use gpu';
	const draw = meshDrawLayout.$.draws[meshDrawLayout.$.drawIds[input.ii]];
	const look = meshDrawLayout.$.looks[lookSlot(draw)];
	return {
		position: std.mul(
			frameLayout.$.frame.viewProj,
			d.vec4f(instanceRel(input.position, input.color, input.ii, draw, look), 1),
		),
	};
});

/** empty fragment entrypoint for opaque depth prepass (writeMask = 0) */
export const fsDepth = tgpu.fragmentFn({
	in: {},
	out: d.Void,
})(() => {
	'use gpu';
});

/** vertex entrypoint for opaque depth prepass with transition fade */
export const vsDepthFade = tgpu.vertexFn({
	in: { ...DepthIn, ii: d.builtin.instanceIndex },
	out: FadeDepthOut,
})((input) => {
	'use gpu';
	const draw = meshDrawLayout.$.draws[meshDrawLayout.$.drawIds[input.ii]];
	const look = meshDrawLayout.$.looks[lookSlot(draw)];
	return {
		position: std.mul(
			frameLayout.$.frame.viewProj,
			d.vec4f(instanceRel(input.position, input.color, input.ii, draw, look), 1),
		),
		fade: listFade(meshInstancesLayout.$.list[input.ii]),
	};
});

/** fragment entrypoint discarding transitioning opaque instances in depth prepass */
export const fsDepthFade = tgpu.fragmentFn({
	in: FadeDepthIn,
	out: d.Void,
})((input) => {
	'use gpu';
	if (fadeDiscard(input.fade, input.position.xy)) {
		std.discard();
	}
});

/** vertex entrypoint for alpha-tested depth prepass and cutout shadow passes */
export const vsCutoutDepth = tgpu.vertexFn({
	in: { ...CutoutDepthIn, ii: d.builtin.instanceIndex },
	out: CutoutDepthOut,
})((input) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const drawId = meshDrawLayout.$.drawIds[input.ii];
	const draw = meshDrawLayout.$.draws[drawId];
	const look = meshDrawLayout.$.looks[lookSlot(draw)];
	const entry = meshInstancesLayout.$.list[input.ii];
	const row = meshInstancesLayout.$.rows[listRow(entry)];
	const m = rowBasis(row.t0, row.t1, row.t2, row.info);
	const flags = std.bitcastF32toU32(draw.offset.w);
	const uv = d.vec4f(
		std.add(std.mul(input.uv0, draw.uv0.xy), draw.uv0.zw),
		std.add(std.mul(input.uv1, draw.uv1.xy), draw.uv1.zw),
	);
	if ((flags & d.u32(EROSION)) !== d.u32(0) && look.emissive2.w > 1.5) {
		const origin = std.add(
			d.vec3f(row.t0.w, row.t1.w, row.t2.w),
			meshInstancesLayout.$.blocks[rowBlock(row.block)].xyz,
		);
		const sv = sludgeVertex(uv.xy, origin, m, look);
		return {
			position: std.select(std.mul(frame.viewProj, d.vec4f(sv.rel, 1)), d.vec4f(0), sv.discarded),
			uv,
			draw: drawId,
			color: d.vec4f(1),
			fade: listFade(entry),
		};
	}
	const rel = std.add(
		instanceRel(input.position, input.color, input.ii, draw, look),
		vertexOffsetAt(flags, look, m, uv, input.position.w, frame.eye.w),
	);
	return {
		position: std.mul(frame.viewProj, d.vec4f(rel, 1)),
		uv: sheetUv(row.sheet, uv),
		draw: drawId,
		color: std.unpack4x8unorm(row.color),
		fade: listFade(entry),
	};
});

/** fragment entrypoint discarding alpha-tested and dithered cutout pixels in depth/shadow passes */
export const fsCutoutDepth = tgpu.fragmentFn({
	in: CutoutDepthVaryings,
	out: d.Void,
})((input) => {
	'use gpu';
	if (fadeDiscard(input.fade, input.position.xy)) {
		std.discard();
	}
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
	if ((flags & d.u32(EROSION)) !== d.u32(0) && look.emissive2.w > 1.5) {
		return;
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
	if (look.tint.w < 0) {
		const dither = look.canopy;
		const bits = d.u32(dither.w);
		let scaled = ditherAlpha(look, bits, texel, input.color.w, 1 / input.position.w);
		if ((bits & d.u32(DITHER_MASK)) !== d.u32(0)) {
			const masking = sampleSlot(
				meshMaterialLayout.$.parallaxNoiseMap,
				meshMaterialLayout.$.noiseSampler,
				id,
				input.uv,
				uv0Dx,
				uv0Dy,
				uv1Dx,
				uv1Dy,
				flags,
				d.u32(NOISE_SLOT),
			);
			scaled *= std.select(masking.w, masking.x, (bits & d.u32(DITHER_MASK_RED)) !== d.u32(0));
		}
		const alpha = std.pow(std.saturate(scaled), dither.y);
		if (
			alpha - gradientNoise(std.add(std.mul(input.position.xy, dither.z), d.vec2f(frame.params.w))) <
			1e-5
		) {
			std.discard();
		}
	} else if (texel.w < look.tint.w) {
		std.discard();
	}
});

// #endregion
