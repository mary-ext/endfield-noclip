/**
 * vertex displacement helpers for mesh surface shaders: cloth skinning, wind sway, pendulum sway, mushroom
 * sway, vertex offset maps, and sludge surface shaping.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout, InstanceRow, rowBlock, listRow, rowBasis } from '../../core/frame-core.ts';

import {
	DrawSchema,
	LookSchema,
	meshInstancesLayout,
	meshMaterialLayout,
	BASE_MAP,
	NORMAL_MAP,
	FOLIAGE,
	UNLIT,
	ALPHA_NORMAL,
	PARALLAX_MAP,
	PARALLAX_NOISE_MAP,
	EROSION,
	FOLIAGE_LEAF,
	EFFECT,
	VERTEX_OFFSET,
	PARALLAX_SLOT,
	NOISE_SLOT,
	ROW_CLOTH,
	slotSet,
} from './common.ts';

const clothBonePos = tgpu.fn(
	[d.u32, d.vec4f],
	d.vec3f,
)((bone, p) => {
	'use gpu';
	const base = bone * d.u32(3);
	return d.vec3f(
		std.dot(meshInstancesLayout.$.clothSkeletons[base], p),
		std.dot(meshInstancesLayout.$.clothSkeletons[base + d.u32(1)], p),
		std.dot(meshInstancesLayout.$.clothSkeletons[base + d.u32(2)], p),
	);
});

export const clothSkin = tgpu.fn(
	[d.vec3f, d.vec4f, InstanceRow],
	d.vec3f,
)((p, color, row) => {
	'use gpu';
	if ((row.info & d.u32(ROW_CLOTH)) === d.u32(0)) {
		return d.vec3f(p);
	}
	const offset = row.custom.x;
	const p4 = d.vec4f(p, 1);
	const r = d.u32(std.round(color.x * 255));
	const g = d.u32(std.round(color.y * 255));
	if (row.custom.y !== d.u32(0)) {
		return clothBonePos(offset + r * d.u32(256) + g, p4);
	}
	const a = clothBonePos(offset + r, p4);
	const b = clothBonePos(offset + g, p4);
	return std.mix(a, b, color.z);
});

const prevClothBonePos = tgpu.fn(
	[d.u32, d.vec4f],
	d.vec3f,
)((bone, p) => {
	'use gpu';
	const base = bone * d.u32(3);
	return d.vec3f(
		std.dot(meshInstancesLayout.$.prevClothSkeletons[base], p),
		std.dot(meshInstancesLayout.$.prevClothSkeletons[base + d.u32(1)], p),
		std.dot(meshInstancesLayout.$.prevClothSkeletons[base + d.u32(2)], p),
	);
});

export const clothSkinPrev = tgpu.fn(
	[d.vec3f, d.vec4f, InstanceRow],
	d.vec3f,
)((p, color, row) => {
	'use gpu';
	if ((row.info & d.u32(ROW_CLOTH)) === d.u32(0)) {
		return d.vec3f(p);
	}
	const offset = row.custom.x;
	const p4 = d.vec4f(p, 1);
	const r = d.u32(std.round(color.x * 255));
	const g = d.u32(std.round(color.y * 255));
	if (row.custom.y !== d.u32(0)) {
		return prevClothBonePos(offset + r * d.u32(256) + g, p4);
	}
	const a = prevClothBonePos(offset + r, p4);
	const b = prevClothBonePos(offset + g, p4);
	return std.mix(a, b, color.z);
});

const rotateAbout = tgpu.fn(
	[d.vec3f, d.f32, d.vec3f],
	d.vec3f,
)((axis, angle, v) => {
	'use gpu';
	const c = std.cos(angle);
	return std.add(
		std.add(std.mul(v, c), std.mul(std.cross(axis, v), std.sin(angle))),
		std.mul(axis, std.dot(axis, v) * (1 - c)),
	);
});

const pendulumAt = tgpu.fn(
	[LookSchema, d.f32, d.vec3f, d.vec2f, d.f32, d.f32, d.f32],
	d.vec3f,
)((look, weight, v, along, phase, x0, windClock) => {
	'use gpu';
	const intensity = look.sway.x;
	const across = d.vec3f(-along.y, -along.x, along.x);
	let swung = d.vec3f(v);
	if (std.dot(across, across) > 1e-12) {
		swung = rotateAbout(std.normalize(across), std.sin(phase) * intensity * 0.05, v);
	}
	const spin = std.sin(windClock * look.sway.w + x0) * look.swayDirection.x;
	const turned = rotateAbout(d.vec3f(0, 1, 0), spin, swung);
	const follow = std.mix(weight * intensity * 0.5, 1, look.sway.z);
	return std.mul(std.sub(turned, v), follow * weight);
});

const swayAt = tgpu.fn(
	[d.u32, LookSchema, d.vec3f, d.f32, d.vec3f, d.vec3f, d.f32],
	d.vec3f,
)((flags, look, p, weight, rel, origin, windClock) => {
	'use gpu';
	const intensity = look.sway.x;
	if (weight === 0 || intensity === 0 || (flags & d.u32(FOLIAGE | EROSION | UNLIT | EFFECT)) !== d.u32(0)) {
		return d.vec3f(0);
	}
	const frame = frameLayout.$.frame;
	const frequency = look.sway.y;
	const along = std.select(frame.wind.zw, look.swayDirection.zw, look.swayDirection.y > 0.5);
	const x0 = origin.x + frame.eye.x;
	const phase = windClock * frequency + x0;
	if (look.misc.y > 0.5) {
		return pendulumAt(look, weight, std.sub(rel, origin), along, phase, x0, windClock);
	}
	const softness = look.sway.z;
	const kite = look.sway.w;
	const tendency = look.swayDirection.x;
	let s = d.f32(0);
	let amplitude = d.f32(0);
	if (kite !== 0) {
		amplitude = intensity * 0.05;
		s = std.sin(phase + std.mix(0, p.y * softness - weight * Math.PI, kite)) * p.y;
	} else {
		amplitude = intensity * 0.5;
		s = std.sin(phase - (rel.z + frame.eye.z) * softness - weight * 3.14);
	}
	const offset = (s + 1 + tendency) * amplitude * weight;
	return std.mul(d.vec3f(along.x, 0, along.y), offset);
});

const mushroomSwayAt = tgpu.fn(
	[d.u32, LookSchema, d.f32, d.vec3f, d.vec3f, d.f32],
	d.vec3f,
)((flags, look, weight, rel, origin, time) => {
	'use gpu';
	if ((flags & d.u32(PARALLAX_MAP)) === d.u32(0)) {
		return d.vec3f(0);
	}
	const mask = std.max(std.pow(std.abs(weight), look.swayDirection.z), 0.01);
	const worldOrigin = std.add(origin, frameLayout.$.frame.eye.xyz);
	const hash = std.fract(std.dot(worldOrigin.xz, d.vec2f(0.7548776865005493, 0.5698403120040894)));
	const phase = hash * look.swayDirection.x;
	const speedScale = 1 + (std.fract(hash * 1.6180340051651 + 0.3819660246372) * 2 - 1) * look.swayDirection.y;
	const u = std.fract(time * speedScale * look.sway.x + phase);
	const lut = std.textureSampleLevel(
		meshMaterialLayout.$.parallaxMap,
		meshMaterialLayout.$.parallaxSampler,
		d.vec2f(u, 0.5),
		0,
	);
	const v = std.sub(rel, origin);
	const bend = std.mul(lut.xy, look.sway.y * mask);
	const bendDeg = std.length(bend);
	const axis = std.div(d.vec3f(bend.y, 0, -bend.x), std.max(bendDeg, 0.001));
	const baseDelta = std.mul(std.cross(axis, v), std.radians(bendDeg));
	const twistRad = std.radians(lut.w * look.sway.w * mask);
	return d.vec3f(
		baseDelta.x + v.z * twistRad,
		baseDelta.y + v.y * lut.z * look.sway.z,
		baseDelta.z - v.x * twistRad,
	);
});

export const vertexSway = tgpu.fn(
	[d.u32, LookSchema, d.vec3f, d.f32, d.vec3f, d.vec3f, d.f32, d.f32],
	d.vec3f,
)((flags, look, p, weight, rel, origin, time, windClock) => {
	'use gpu';
	if (look.misc.y > 1.5) {
		return mushroomSwayAt(flags, look, weight, rel, origin, time);
	}
	return swayAt(flags, look, p, weight, rel, origin, windClock);
});

const grassLean = tgpu.fn(
	[d.u32, LookSchema, d.f32],
	d.vec3f,
)((flags, look, height) => {
	'use gpu';
	if ((flags & d.u32(FOLIAGE | FOLIAGE_LEAF)) !== d.u32(FOLIAGE)) {
		return d.vec3f(0);
	}
	const viewUp = frameLayout.$.frame.viewUp;
	return std.mul(d.vec3f(viewUp.x, 0, viewUp.z), height * look.foliage.y);
});

export const instanceRel = tgpu.fn(
	[d.vec4f, d.vec4f, d.u32, DrawSchema, LookSchema],
	d.vec3f,
)((position, color, ii, draw, look) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const row = meshInstancesLayout.$.rows[listRow(meshInstancesLayout.$.list[ii])];
	const p = clothSkin(std.add(draw.offset.xyz, std.mul(position.xyz, draw.scale.xyz)), color, row);
	const origin = std.add(
		d.vec3f(row.t0.w, row.t1.w, row.t2.w),
		meshInstancesLayout.$.blocks[rowBlock(row.block)].xyz,
	);
	const rel = std.add(std.mul(rowBasis(row.t0, row.t1, row.t2, row.info), p), origin);
	const flags = std.bitcastF32toU32(draw.offset.w);
	return std.add(
		std.add(rel, grassLean(flags, look, p.y)),
		vertexSway(flags, look, p, position.w, rel, origin, frame.eye.w, frame.wind.x),
	);
});

export const instancePrevRel = tgpu.fn(
	[d.vec4f, d.vec4f, d.u32, DrawSchema, LookSchema],
	d.vec3f,
)((position, color, ii, draw, look) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const row = meshInstancesLayout.$.rows[listRow(meshInstancesLayout.$.list[ii])];
	const p = clothSkinPrev(std.add(draw.offset.xyz, std.mul(position.xyz, draw.scale.xyz)), color, row);
	const origin = std.add(
		d.vec3f(row.t0.w, row.t1.w, row.t2.w),
		meshInstancesLayout.$.blocks[rowBlock(row.block)].xyz,
	);
	const rel = std.add(std.mul(rowBasis(row.t0, row.t1, row.t2, row.info), p), origin);
	const flags = std.bitcastF32toU32(draw.offset.w);
	return std.add(
		std.add(rel, grassLean(flags, look, p.y)),
		vertexSway(flags, look, p, position.w, rel, origin, frame.prevTime.x, frame.prevTime.y),
	);
});

export const vertexOffsetAt = tgpu.fn(
	[d.u32, LookSchema, d.mat3x3f, d.vec4f, d.f32, d.f32],
	d.vec3f,
)((flags, look, basis, uv, weight, time) => {
	'use gpu';
	const alphaMap = std.select(d.u32(BASE_MAP), d.u32(NORMAL_MAP), (flags & d.u32(ALPHA_NORMAL)) !== d.u32(0));
	const needed = d.u32(VERTEX_OFFSET | PARALLAX_MAP) | alphaMap;
	const shape = look.parallaxDark;
	const masked = shape.w !== 0;
	if ((flags & needed) !== needed || (masked && (flags & d.u32(PARALLAX_NOISE_MAP)) === d.u32(0))) {
		return d.vec3f(0);
	}
	const direction = look.parallaxColor;
	const scroll = std.mul(look.parallaxBright, time);
	const source = slotSet(uv, flags, d.u32(PARALLAX_SLOT));
	const noiseT = look.slotUv[PARALLAX_SLOT];
	const maskT = look.slotUv[NOISE_SLOT];
	const noiseUv = std.add(std.add(std.mul(source, noiseT.xy), noiseT.zw), scroll.xy);
	const noise = std.textureSampleLevel(
		meshMaterialLayout.$.parallaxMap,
		meshMaterialLayout.$.parallaxSampler,
		noiseUv,
		0,
	).x;
	let scale = shape.x * (noise * (1 + shape.y) - shape.y);
	if (masked) {
		const maskUv = std.add(std.add(std.mul(source, maskT.xy), maskT.zw), scroll.zw);
		const mask = std.textureSampleLevel(
			meshMaterialLayout.$.parallaxNoiseMap,
			meshMaterialLayout.$.noiseSampler,
			maskUv,
			0,
		).x;
		scale *= 1 - shape.w * (1 - mask);
	}
	if (shape.z > 0.5) {
		scale *= weight;
	}
	return std.mul(std.select(std.mul(basis, direction.xyz), direction.xyz, direction.w > 0.5), scale);
});

const SludgeVertex = d.struct({
	rel: d.vec3f,
	prevRel: d.vec3f,
	normal: d.vec3f,
	tangent: d.vec4f,
	color: d.vec4f,
	discarded: d.bool,
});

export const sludgeVertex = tgpu.fn(
	[d.vec2f, d.vec3f, d.mat3x3f, LookSchema],
	SludgeVertex,
)((uv, origin, m, look) => {
	'use gpu';
	const hm = std.textureSampleLevel(
		meshMaterialLayout.$.parallaxNoiseMap,
		meshMaterialLayout.$.noiseSampler,
		uv,
		0,
	);
	const h = hm.z;
	if (h < 1e-6) {
		return SludgeVertex({
			rel: d.vec3f(0),
			prevRel: d.vec3f(0),
			normal: d.vec3f(0),
			tangent: d.vec4f(0),
			color: d.vec4f(0),
			discarded: true,
		});
	}
	const sludgeSize = std.max(look.emissive2.x, 1e-4);
	const sizeY = std.max(look.emissive2.y, 1e-4);
	let local = d.vec3f(uv.x * sludgeSize, h * sizeY, uv.y * sludgeSize);
	const clip0 = look.maskScale;
	const clip1 = look.maskOffset;
	if (std.dot(clip0, d.vec4f(local, 1)) < 0 || std.dot(clip1, d.vec4f(local, 1)) < 0) {
		return SludgeVertex({
			rel: d.vec3f(0),
			prevRel: d.vec3f(0),
			normal: d.vec3f(0),
			tangent: d.vec4f(0),
			color: d.vec4f(0),
			discarded: true,
		});
	}
	const e = std.sub(std.mul(hm.xy, 2), d.vec2f(1));
	const ny = 1 - std.abs(e.x) - std.abs(e.y);
	let ln = d.vec3f(e.x, ny, e.y);
	if (ny < 0) {
		const folded = std.mul(
			std.sub(d.vec2f(1), std.abs(ln.zx)),
			std.select(d.vec2f(-1), d.vec2f(1), std.ge(ln.xz, d.vec2f(0))),
		);
		ln = d.vec3f(folded.x, ny, folded.y);
	}
	ln = std.normalize(ln);

	const coverage = hm.w;
	const center = d.vec3f(sludgeSize * 0.5, sizeY * 0.5, sludgeSize * 0.5);
	const cov2 = coverage * 2;
	const distCenter = std.distance(local, center);
	const radial = std.normalize(std.add(std.sub(local, center), d.vec3f(1e-6)));
	const waveAmp = std.mul(look.parallax, d.vec4f(std.saturate(cov2 - 1), std.saturate(cov2), 0.1, 0));

	const frame = frameLayout.$.frame;
	const prevPhase = std.sub(
		std.mul(look.parallax2, distCenter),
		std.mul(look.parallaxColor, frame.prevTime.x),
	);
	const prevWaveY = std.dot(std.add(std.sin(prevPhase), d.vec4f(1)), waveAmp);
	const prevWaveXzRaw = std.mul(radial, std.dot(std.add(std.cos(prevPhase), d.vec4f(1)), waveAmp));
	const prevWaveXz = d.vec3f(prevWaveXzRaw.x, 0, prevWaveXzRaw.z);
	let prevLocal = d.vec3f(local.x, local.y + prevWaveY, local.z);
	prevLocal = std.add(prevLocal, std.mul(std.add(ln, prevWaveXz), look.surface2.z));
	prevLocal = std.add(prevLocal, std.mul(clip0.xyz, std.max(-std.dot(clip0, d.vec4f(prevLocal, 1)), 0)));
	prevLocal = std.add(prevLocal, std.mul(clip1.xyz, std.max(-std.dot(clip1, d.vec4f(prevLocal, 1)), 0)));

	const wavePhase = std.sub(std.mul(look.parallax2, distCenter), std.mul(look.parallaxColor, frame.eye.w));
	const waveY = std.dot(std.add(std.sin(wavePhase), d.vec4f(1)), waveAmp);
	const waveXzRaw = std.mul(radial, std.dot(std.add(std.cos(wavePhase), d.vec4f(1)), waveAmp));
	const waveXz = d.vec3f(waveXzRaw.x, 0, waveXzRaw.z);
	local = d.vec3f(local.x, local.y + waveY, local.z);
	const animN = std.add(ln, waveXz);
	local = std.add(local, std.mul(animN, look.surface2.z));
	local = std.add(local, std.mul(clip0.xyz, std.max(-std.dot(clip0, d.vec4f(local, 1)), 0)));
	local = std.add(local, std.mul(clip1.xyz, std.max(-std.dot(clip1, d.vec4f(local, 1)), 0)));

	const rightU = std.div(m.columns[0], sludgeSize);
	const upU = std.div(m.columns[1], sizeY);
	const fwdU = std.div(m.columns[2], sludgeSize);
	const worldN = std.normalize(
		std.add(std.add(std.mul(rightU, animN.x), std.mul(upU, animN.y)), std.mul(fwdU, animN.z)),
	);
	return SludgeVertex({
		rel: std.add(
			std.add(std.add(origin, std.mul(rightU, local.x)), std.mul(upU, local.y)),
			std.mul(fwdU, local.z),
		),
		prevRel: std.add(
			std.add(std.add(origin, std.mul(rightU, prevLocal.x)), std.mul(upU, prevLocal.y)),
			std.mul(fwdU, prevLocal.z),
		),
		normal: worldN,
		tangent: d.vec4f(std.normalize(std.add(std.cross(worldN, fwdU), d.vec3f(1e-6))), 1),
		color: d.vec4f(coverage, 1 - waveY, 0, 1),
		discarded: false,
	});
});

// #endregion
