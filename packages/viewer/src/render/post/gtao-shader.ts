/**
 * ground-truth ambient occlusion (XeGTAO): half-resolution depth downsample, 3-slice horizon march with 4x4
 * interleaved rotation, and depth-aware 4x4 upsampling blur.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { gbufferBNormal, gbufferBValid } from '../core/gbuffer.ts';
import { postUniformLayout, viewDepth } from '../core/post-schema.ts';

/** full-resolution pixels per AO pixel along each axis */
export const AO_SCALE = 2;

const SLICES = 3;
const STEPS = 3;
const MAX_RADIUS = 48;

/** bind group layout for `fsAoDepth` */
export const gtaoDepthLayout = tgpu.bindGroupLayout({
	depth: { texture: d.textureDepth2d() },
});

/** bind group layout for `fsGtao` */
export const gtaoMarchLayout = tgpu.bindGroupLayout({
	halfDepth: { texture: d.texture2d(d.f32) },
	gbufferB: { texture: d.texture2d(d.f32) },
});

/** bind group layout for `fsGtaoBlur` */
export const gtaoBlurLayout = tgpu.bindGroupLayout({
	depth: { texture: d.textureDepth2d() },
	halfDepth: { texture: d.texture2d(d.f32), sampleType: 'unfilterable-float' },
	ao: { texture: d.texture2d(d.f32), sampleType: 'unfilterable-float' },
	gatherSampler: { sampler: 'non-filtering' },
});

/** downsamples full-resolution reversed-Z depth to half-resolution linear view depth (0 for sky) */
export const fsAoDepth = tgpu.fragmentFn({
	in: { position: d.builtin.position },
	out: d.vec4f,
})((input) => {
	'use gpu';
	const size = d.vec2i(std.textureDimensions(gtaoDepthLayout.$.depth));
	const px = std.min(std.mul(d.vec2i(input.position.xy), AO_SCALE), std.sub(size, d.vec2i(1)));
	const depth = std.textureLoad(gtaoDepthLayout.$.depth, px, 0);
	return d.vec4f(std.select(viewDepth(depth), 0, depth <= 0), 0, 0, 1);
});

const halfDepthAt = tgpu.fn(
	[d.vec2i],
	d.f32,
)((px) => {
	'use gpu';
	const size = d.vec2i(std.textureDimensions(gtaoMarchLayout.$.halfDepth));
	return std.textureLoad(gtaoMarchLayout.$.halfDepth, std.clamp(px, d.vec2i(0), std.sub(size, d.vec2i(1))), 0)
		.r;
});

/** view space: x right, y up, z forward (m) */
const viewPosition = tgpu.fn(
	[d.vec2i, d.f32],
	d.vec3f,
)((px, z) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const uv = std.div(
		std.add(d.vec2f(px), d.vec2f(0.5)),
		d.vec2f(std.textureDimensions(gtaoMarchLayout.$.halfDepth)),
	);
	const ndc = std.sub(d.vec2f(uv.x * 2 - 1, 1 - uv.y * 2), post.jitter.xy);
	return std.mul(d.vec3f(ndc.x * std.length(post.right.xyz), ndc.y * std.length(post.up.xyz), 1), z);
});

const viewPositionAt = tgpu.fn(
	[d.vec2i],
	d.vec3f,
)((px) => {
	'use gpu';
	return viewPosition(px, halfDepthAt(px));
});

/** half-resolution XeGTAO horizon march */
export const fsGtao = tgpu.fragmentFn({
	in: { position: d.builtin.position },
	out: d.vec4f,
})((input) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const px = d.vec2i(input.position.xy);
	const z = halfDepthAt(px);
	if (z <= 0) {
		return d.vec4f(1);
	}
	const p = viewPosition(px, z);
	const fullSize = d.vec2i(std.textureDimensions(gtaoMarchLayout.$.gbufferB));
	const gb = std.textureLoad(
		gtaoMarchLayout.$.gbufferB,
		std.min(std.mul(px, AO_SCALE), std.sub(fullSize, d.vec2i(1))),
		0,
	);
	let n = d.vec3f(0);
	if (gbufferBValid(gb)) {
		const wn = gbufferBNormal(gb);
		n = std.normalize(
			d.vec3f(
				std.dot(wn, std.normalize(post.right.xyz)),
				std.dot(wn, std.normalize(post.up.xyz)),
				std.dot(wn, post.forward.xyz),
			),
		);
	} else {
		// fallback to depth-derived normal for unlit surfaces
		const left = viewPositionAt(std.sub(px, d.vec2i(1, 0)));
		const right = viewPositionAt(std.add(px, d.vec2i(1, 0)));
		const top = viewPositionAt(std.sub(px, d.vec2i(0, 1)));
		const bottom = viewPositionAt(std.add(px, d.vec2i(0, 1)));
		let dx = std.sub(right, p);
		if (std.abs(left.z - p.z) < std.abs(right.z - p.z)) {
			dx = std.sub(p, left);
		}
		let dy = std.sub(p, top);
		if (std.abs(bottom.z - p.z) < std.abs(top.z - p.z)) {
			dy = std.sub(bottom, p);
		}
		n = std.normalize(std.cross(dx, dy));
	}
	const v = std.normalize(std.neg(p));

	const radiusPx = std.min((post.ao.x * post.right.w) / (AO_SCALE * p.z), MAX_RADIUS);
	const radius = (radiusPx * AO_SCALE * p.z) / post.right.w;
	const range = std.max(post.aoShape.x * radius, 1e-3);
	const thin = post.aoShape.z;
	// 4x4 interleaved slice rotations, and a per-pixel step offset
	const cell = d.vec2f(d.f32(px.x & 3), d.f32(px.y & 3));
	const rotation = (cell.x * 4 + cell.y) / 16;
	const jitter = std.fract(rotation * 7 + 0.5 / 16);
	const minStep = 1.3 / radiusPx;

	// XeGTAO's fade for small radii, before the division by the slice count
	let visibility = std.clamp((10 - radiusPx) * 0.01, 0, 1) * 0.5;
	for (let s = 0; s < SLICES; s++) {
		const phi = ((d.f32(s) + rotation) * Math.PI) / SLICES;
		const omega = d.vec2f(std.cos(phi), std.sin(phi));
		const direction = d.vec3f(omega, 0);
		const ortho = std.sub(direction, std.mul(std.dot(direction, v), v));
		const axis = std.normalize(std.cross(direction, v));
		const projected = std.sub(n, std.mul(axis, std.dot(n, axis)));
		const lengthRaw = std.max(std.length(projected), 1e-4);
		const signN = std.sign(std.dot(ortho, projected));
		const cosN = std.clamp(std.dot(projected, v) / lengthRaw, 0, 1);
		const angleN = signN * std.acos(cosN);
		const projectedLength = std.mix(lengthRaw, 1, 0.05);

		const horizons = d.vec2f(-1);
		for (let side = 0; side < 2; side++) {
			const sideSign = std.select(d.f32(-1), d.f32(1), side === 1);
			const low = std.cos(angleN + sideSign * Math.PI * 0.5);
			let best = low;
			for (let i = 0; i < STEPS; i++) {
				const noise = std.fract(jitter + d.f32(s + i * STEPS) * 0.6180339887);
				const t = std.pow((d.f32(i) + noise) / STEPS, post.aoShape.y) + minStep;
				const offset = std.mul(d.vec2f(omega.x, -omega.y), sideSign * t * radiusPx);
				const q = viewPositionAt(std.add(px, d.vec2i(std.round(offset))));
				const delta = std.sub(q, p);
				const dist = std.length(delta);
				const cosH = std.dot(std.div(delta, std.max(dist, 1e-4)), v);
				const weighted = std.length(d.vec3f(delta.xy, delta.z * (1 + thin)));
				const falloff = std.clamp((radius - weighted) / range, 0, 1);
				best = std.max(best, std.mix(low, cosH, falloff));
			}
			if (side === 0) {
				horizons.x = best;
			} else {
				horizons.y = best;
			}
		}
		const h0 = -std.acos(horizons.x);
		const h1 = std.acos(horizons.y);
		const arc0 = (cosN + 2 * h0 * std.sin(angleN) - std.cos(2 * h0 - angleN)) * 0.25;
		const arc1 = (cosN + 2 * h1 * std.sin(angleN) - std.cos(2 * h1 - angleN)) * 0.25;
		visibility += projectedLength * (arc0 + arc1);
	}
	visibility = std.clamp(visibility / SLICES, 0, 1);
	const ao = std.max(std.pow(visibility, post.ao.z), 0.03);
	return d.vec4f(std.mix(1, ao, post.ao.y), 0, 0, 1);
});

/** 4x4 depth-aware box blur upsampling half-resolution AO to full resolution via 4x textureGather */
export const fsGtaoBlur = tgpu.fragmentFn({
	in: { position: d.builtin.position },
	out: d.vec4f,
})((input) => {
	'use gpu';
	const px = d.vec2i(input.position.xy);
	const depth = std.textureLoad(gtaoBlurLayout.$.depth, px, 0);
	if (depth <= 0) {
		return d.vec4f(1);
	}
	const z = viewDepth(depth);
	const thresh = 0.05 * z + 0.1;
	const invSize = std.div(d.vec2f(1), d.vec2f(std.textureDimensions(gtaoBlurLayout.$.ao)));
	const center = d.vec2f(d.f32(std.intdiv(px.x, AO_SCALE)), d.f32(std.intdiv(px.y, AO_SCALE)));
	const uv0 = std.mul(std.sub(center, d.vec2f(1)), invSize);
	const uv1 = std.mul(std.add(center, d.vec2f(1)), invSize);
	const zVec = d.vec4f(z);
	const tVec = d.vec4f(thresh);
	const ones = d.vec4f(1);
	const zeros = d.vec4f(0);
	let sum = d.f32(0);
	let weight = d.f32(0);
	for (let q = 0; q < 4; q++) {
		const qUv = d.vec2f(std.select(uv0.x, uv1.x, (q & 1) !== 0), std.select(uv0.y, uv1.y, q >= 2));
		const qz = std.textureGather(0, gtaoBlurLayout.$.halfDepth, gtaoBlurLayout.$.gatherSampler, qUv);
		const qa = std.textureGather(0, gtaoBlurLayout.$.ao, gtaoBlurLayout.$.gatherSampler, qUv);
		const w = std.select(zeros, ones, std.lt(std.abs(std.sub(qz, zVec)), tVec));
		sum += std.dot(qa, w);
		weight += std.dot(w, ones);
	}
	// no tap at this depth (a thin edge the half-resolution march missed): leave it unoccluded
	return d.vec4f(std.select(1, sum / weight, weight > 0), 0, 0, 1);
});
