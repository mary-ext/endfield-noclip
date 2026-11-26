/**
 * scene effect vertex entrypoint (`vsEffect`) and vertex displacement helpers (vertex offset, camera pull,
 * soft-body animation, and light beam shaping).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import {
	frameLayout,
	sheetUv,
	rowCustom,
	rowBlock,
	rowPlacement,
	listRow,
	listFade,
	fadeOpacity,
	rowBasis,
} from '../../core/frame-core.ts';
import { octDecode } from '../../core/shader-math.ts';
import { meshInstancesLayout } from '../surfaces/common.ts';

import {
	effectDrawLayout,
	effectMaterialLayout,
	FX_UV,
	FX_ANIM,
	FX_OFFSET_DIR,
	FX_OFFSET,
	FX_OFFSET_MODE,
	FX_UNFOGGED,
	FX_EDGE_ALPHA,
	FX_CAMERA_PULL,
	FX_OFFSET_SLOT,
	FX_MOTION_OFFSET,
	FX_MOTION_SOFT_BODY,
	FX_HAS_TANGENTS,
	FX_HAS_COLORS,
	FX_KIND_WATER_SHEET,
	WS_SOFT_MIN,
	WS_SOFT_RANGE,
	FX_KIND_BEAM,
	BM_CONE,
	BM_DIRECTION,
	BM_FALLOFF,
	EffectIn,
	EffectOut,
	fxRow,
	inverse3,
	fxSampleLevel,
} from './common.ts';

const fxVertexOffset = tgpu.fn(
	[d.u32, d.mat3x3f, d.vec3f, d.vec4f, d.f32],
	d.vec3f,
)((id, m, normal, uv, vertexAlpha) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const dirRow = fxRow(id, d.u32(FX_OFFSET_DIR));
	const params = fxRow(id, d.u32(FX_OFFSET));
	let dir = std.mul(m, dirRow.xyz);
	if (dirRow.w === 1) {
		dir = d.vec3f(dirRow.xyz);
	} else if (dirRow.w === 2) {
		dir = std.mul(m, normal);
	}
	const st = fxRow(id, d.u32(FX_UV + FX_OFFSET_SLOT));
	const speed = fxRow(id, d.u32(FX_ANIM + FX_OFFSET_SLOT)).xy;
	const base = std.select(uv.xy, uv.zw, fxRow(id, d.u32(FX_OFFSET_MODE)).y !== 0);
	const t = std.textureSampleLevel(
		effectMaterialLayout.$.fxTex6,
		effectMaterialLayout.$.fxSamp6,
		std.add(std.add(std.mul(base, st.xy), st.zw), std.mul(speed, frame.eye.w)),
		0,
	).x;
	let weight = 1 - params.z + vertexAlpha * params.z;
	const mask = fxRow(id, d.u32(FX_EDGE_ALPHA)).zw;
	if (mask.y !== 0) {
		const slot = d.u32(mask.x);
		const maskSt = fxRow(id, d.u32(FX_UV) + slot);
		const maskSpeed = fxRow(id, d.u32(FX_ANIM) + slot).xy;
		const r = fxSampleLevel(
			slot,
			std.add(std.add(std.mul(base, maskSt.xy), maskSt.zw), std.mul(maskSpeed, frame.eye.w)),
			0,
		).x;
		weight *= 1 - mask.y * (1 - r);
	}
	return std.mul(dir, params.x * (t * (1 + params.y) - params.y) * weight);
});

const fxCameraPull = tgpu.fn(
	[d.vec3f, d.f32],
	d.vec3f,
)((rel, pull) => {
	'use gpu';
	const cameraDistance = std.length(rel);
	return std.mul(
		std.div(std.neg(rel), std.max(cameraDistance, 1e-6)),
		std.min(std.max(0, cameraDistance - 1), pull) + 0.001,
	);
});

const fxSoftBodyAt = tgpu.fn(
	[d.u32, d.f32, d.vec2f],
	d.vec2f,
)((id, frames, uv1) => {
	'use gpu';
	const scale = fxRow(id, d.u32(FX_UV + FX_OFFSET_SLOT)).xy;
	const play = fxRow(id, d.u32(FX_ANIM + FX_OFFSET_SLOT)).xy;
	const n = std.max(frames, 1);
	const current = std.floor(std.fract(frameLayout.$.frame.eye.w * play.x + play.y) * n);
	return d.vec2f(uv1.x * scale.x, 1 - scale.y * (1 - uv1.y + current / n));
});

const fxSoftBody = tgpu.fn(
	[d.vec3f, d.vec3f, d.vec2f, d.vec3f, d.vec2f],
	d.vec3f,
)((low, range, at, p, uv1) => {
	'use gpu';
	const texel = std.textureSampleLevel(
		effectMaterialLayout.$.fxTex6,
		effectMaterialLayout.$.fxSamp6,
		at,
		0,
	).xyz;
	return std.select(std.add(std.add(p, std.mul(range, texel)), low), d.vec3f(0), uv1.y <= 0.1);
});

const fxSoftBodyNormal = tgpu.fn(
	[d.vec2f, d.f32],
	d.vec3f,
)((at, packing) => {
	'use gpu';
	let q = std.textureSampleLevel(effectMaterialLayout.$.fxTex5, effectMaterialLayout.$.fxSamp5, at, 0);
	if (packing === 1) {
		q = std.sub(std.mul(q, 2), d.vec4f(1));
	}
	const up = d.vec3f(0, 1, 0);
	return std.normalize(
		std.add(up, std.mul(std.cross(q.xyz, std.add(std.mul(up, q.w), std.cross(q.xyz, up))), 2)),
	);
});

/**
 * computes a light beam's scale from its unit cone (largest radius across, length along).
 *
 * @param id look slot index
 * @returns beam scale vector
 */
export const beamScale = tgpu.fn(
	[d.u32],
	d.vec3f,
)((id) => {
	'use gpu';
	const cone = fxRow(id, d.u32(BM_CONE));
	const radius = std.max(std.max(cone.x, cone.y), 1e-6);
	return d.vec3f(radius, radius, fxRow(id, d.u32(BM_FALLOFF)).z);
});

const beamVertex = tgpu.fn(
	[d.u32, d.vec3f],
	d.vec3f,
)((id, p) => {
	'use gpu';
	const cone = fxRow(id, d.u32(BM_CONE));
	const dir = fxRow(id, d.u32(BM_DIRECTION));
	const scale = beamScale(id);
	const z = p.z * p.z;
	let xy = std.div(std.mul(p.xy, std.mix(cone.x, cone.y, z)), scale.x);
	xy = std.add(xy, std.div(std.mul(dir.xy, z * scale.z), std.mul(scale.xy, dir.z)));
	return d.vec3f(xy, z);
});

/** shared vertex entrypoint for all scene effect phases */
export const vsEffect = tgpu.vertexFn({
	in: {
		...EffectIn,
		ii: d.builtin.instanceIndex,
	},
	out: EffectOut,
})((v) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const entry = meshInstancesLayout.$.list[v.ii];
	const row = meshInstancesLayout.$.rows[listRow(entry)];
	const drawId = effectDrawLayout.$.drawIds[v.ii];
	const draw = effectDrawLayout.$.draws[drawId];
	const id = std.bitcastF32toU32(draw.scale.w) & d.u32(0xffff);
	let p = std.add(draw.offset.xyz, std.mul(v.position.xyz, draw.scale.xyz));
	if (fxRow(id, d.u32(FX_UNFOGGED)).y === FX_KIND_BEAM) {
		p = beamVertex(id, p);
	}
	const origin = std.add(
		d.vec3f(row.t0.w, row.t1.w, row.t2.w),
		meshInstancesLayout.$.blocks[rowBlock(row.block)].xyz,
	);
	const m = rowBasis(row.t0, row.t1, row.t2, row.info);
	const inv = std.transpose(inverse3(m));
	const flags = std.bitcastF32toU32(draw.offset.w);
	const uv = sheetUv(
		row.sheet,
		d.vec4f(
			std.add(std.mul(v.uv0, draw.uv0.xy), draw.uv0.zw),
			std.add(std.mul(v.uv1, draw.uv1.xy), draw.uv1.zw),
		),
	);
	const unpackedColor = std.unpack4x8unorm(row.color);
	const baseColor = std.mul(
		std.select(d.vec4f(1), v.color, (flags & d.u32(FX_HAS_COLORS)) !== d.u32(0)),
		unpackedColor,
	);
	const color = d.vec4f(baseColor.xyz, baseColor.w * fadeOpacity(listFade(entry)));
	let normal = octDecode(v.normal);
	const motion = fxRow(id, d.u32(FX_OFFSET_MODE)).x;
	if (motion === FX_MOTION_SOFT_BODY) {
		const sheet = fxRow(id, d.u32(FX_UNFOGGED)).y === FX_KIND_WATER_SHEET;
		const low = fxRow(id, std.select(d.u32(FX_OFFSET_DIR), d.u32(WS_SOFT_MIN), sheet));
		const range = fxRow(id, std.select(d.u32(FX_OFFSET), d.u32(WS_SOFT_RANGE), sheet));
		const bodyUv = std.add(std.mul(v.uv1, draw.uv1.xy), draw.uv1.zw);
		const at = fxSoftBodyAt(id, low.w, bodyUv);
		p = fxSoftBody(low.xyz, range.xyz, at, p, bodyUv);
		if (sheet) {
			normal = fxSoftBodyNormal(at, range.w);
		}
	}
	let rel = std.add(std.mul(m, p), origin);
	const pull = fxRow(id, d.u32(FX_CAMERA_PULL)).xy;
	const pulled = std.select(d.vec3f(0), fxCameraPull(rel, pull.x), pull.y !== 0);
	if (motion === FX_MOTION_OFFSET) {
		rel = std.add(rel, fxVertexOffset(id, m, normal, uv, color.w));
	}
	rel = std.add(rel, pulled);

	let tangent = d.vec4f(0);
	if ((flags & d.u32(FX_HAS_TANGENTS)) !== d.u32(0)) {
		const det = std.dot(m.columns[0], std.cross(m.columns[1], m.columns[2]));
		const sign = std.select(-1, 1, v.tangent.z >= 0) * std.select(-1, 1, det >= 0);
		tangent = d.vec4f(std.mul(m, octDecode(v.tangent.xy)), sign);
	}

	let placementColor = d.vec4f(1);
	let placementUv = d.vec4f(1, 1, 0, 0);
	const placement = rowPlacement(row.block);
	if (placement !== d.u32(0)) {
		const at = d.u32(d.i32(meshInstancesLayout.$.blocks[rowBlock(row.block)].w) + d.i32(placement));
		placementColor = d.vec4f(meshInstancesLayout.$.placements[at * d.u32(2)]);
		placementUv = d.vec4f(meshInstancesLayout.$.placements[at * d.u32(2) + d.u32(1)]);
	}

	return {
		position: std.mul(frame.viewProj, d.vec4f(rel, 1)),
		rel,
		normal: std.mul(m, normal),
		uv,
		color,
		look: id,
		toObject0: d.vec4f(inv.columns[0], -std.dot(inv.columns[0], origin)),
		toObject1: d.vec4f(inv.columns[1], -std.dot(inv.columns[1], origin)),
		toObject2: d.vec4f(inv.columns[2], -std.dot(inv.columns[2], origin)),
		up: std.normalize(m.columns[1]),
		origin: d.vec4f(origin, std.dot(origin, frame.viewForward.xyz)),
		placementColor,
		placementUv,
		custom: rowCustom(row),
		tangent,
	};
});

// #endregion
