/**
 * six-way lit smoke shading (`EffectKind.SixWaySmoke`): two directional lightmaps (positive/negative axes)
 * with Unity's per-channel absorption, irradiance clipmap ambient, and cascaded sun shadows.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout } from '../../frame/frame-core.ts';
import { ambientIrradiance, sunVisibility } from '../../frame/frame-lighting.ts';
import { LUMINANCE } from '../../shaders/common/luminance.ts';

import {
	EffectVertexData,
	FX_MISC,
	FX_SOFT,
	FX_TINT,
	FX_UNFOGGED,
	FX_UV,
	FxBases,
	FxSlotBase,
	fxAccumulate,
	fxCustomShift,
	fxNearFade,
	fxRow,
	fxSample,
	fxSceneDepth,
	fxSlotBase,
	fxSlotBits,
	fxSlotCoords,
	fxSlotGradient,
} from './common.ts';
import { wsSample } from './water-sheet.ts';

/** `EffectKind.SixWaySmoke` value in `FX_UNFOGGED.y` */
export const FX_KIND_SIX_WAY = 6;

const SW_FLAGS = 17;
const SW_DISTURB = 18;
const SW_DISTURB_USE = 19;
const SW_DISSOLVE = 20;
const SW_DISSOLVE_COLOR = 21;
const SW_BLEND_TINT = 22;

const SW_DISTURB1 = 1;
const SW_DISTURB2 = 2;
const SW_DISTURB1_NORMAL = 4;
const SW_DISTURB2_NORMAL = 8;
const SW_MASK = 16;
const SW_MASK_RED_ALPHA = 32;
const SW_BLEND = 64;
const SW_DISSOLVE_ON = 128;
const SW_VERTEX_COLOR = 256;

const SW_SLOT_SCREEN_DEPTH = 8;

const swBase = tgpu.fn(
	[d.u32, d.u32, FxBases, d.f32],
	FxSlotBase,
)((id, slot, bases, depth) => {
	'use gpu';
	const bits = fxSlotBits(id, slot);
	const b = fxSlotBase(bases, bits);
	const s = std.select(1, depth, (bits & d.u32(SW_SLOT_SCREEN_DEPTH)) !== d.u32(0));
	return FxSlotBase({ uv: std.mul(b.uv, s), dx: std.mul(b.dx, s), dy: std.mul(b.dy, s) });
});

const swDisturb = tgpu.fn(
	[d.u32, d.u32, FxSlotBase, d.vec2f, d.bool, d.vec4f],
	d.vec2f,
)((id, slot, base, strength, normal, custom) => {
	'use gpu';
	const t = wsSample(id, slot, base.uv, d.vec2f(0), base.dx, base.dy, custom);
	const bias = fxRow(id, d.u32(SW_FLAGS)).y;
	const centred = t.x * (bias + 1) - bias;
	if (normal) {
		return std.mul(std.sub(std.mul(d.vec2f(t.w * centred, t.y), 2), d.vec2f(1)), strength.x);
	}
	return std.mul(strength, centred);
});

const swAbsorb = tgpu.fn(
	[d.f32, d.vec3f, d.f32],
	d.vec3f,
)((t, exponent, range) => {
	'use gpu';
	return std.min(d.vec3f(range), std.mul(std.pow(d.vec3f(std.saturate(t / range)), exponent), range));
});

/**
 * shades a six-way lit smoke particle into transparent-accumulated RGBA.
 *
 * @param data interpolated effect vertex data
 * @param bases precomputed UV sources and gradients
 * @returns accumulated RGBA
 */
export const sixWaySmoke = tgpu.fn(
	[EffectVertexData, FxBases],
	d.vec4f,
)((data, bases) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const id = data.look;
	const row = fxRow(id, d.u32(SW_FLAGS));
	const flags = d.u32(row.x);
	const bias = std.exp2(frame.params.y);
	const depthScale = std.max(0, data.origin.w - frame.localLights.w);

	let offset = d.vec2f(0);
	const strength = fxRow(id, d.u32(SW_DISTURB));
	if ((flags & d.u32(SW_DISTURB1)) !== d.u32(0)) {
		const base = swBase(id, d.u32(1), bases, depthScale);
		offset = std.add(
			offset,
			swDisturb(
				id,
				d.u32(1),
				base,
				strength.xy,
				(flags & d.u32(SW_DISTURB1_NORMAL)) !== d.u32(0),
				data.custom,
			),
		);
	}
	if ((flags & d.u32(SW_DISTURB2)) !== d.u32(0)) {
		const base = swBase(id, d.u32(2), bases, depthScale);
		offset = std.add(
			offset,
			swDisturb(
				id,
				d.u32(2),
				base,
				strength.zw,
				(flags & d.u32(SW_DISTURB2_NORMAL)) !== d.u32(0),
				data.custom,
			),
		);
	}
	const useDisturb = fxRow(id, d.u32(SW_DISTURB_USE));

	const lightmap = swBase(id, d.u32(0), bases, depthScale);
	const lightmapUv = std.add(
		fxSlotCoords(id, d.u32(0), std.add(lightmap.uv, fxCustomShift(id, d.u32(0), data.custom))),
		std.mul(offset, useDisturb.x),
	);
	const gx = std.mul(fxSlotGradient(id, d.u32(0), lightmap.dx), bias);
	const gy = std.mul(fxSlotGradient(id, d.u32(0), lightmap.dy), bias);
	const positive = fxSample(d.u32(0), lightmapUv, gx, gy);
	const negative = fxSample(d.u32(6), lightmapUv, gx, gy).xyz;

	let mask = d.vec4f(1);
	if ((flags & d.u32(SW_MASK)) !== d.u32(0)) {
		const base = swBase(id, d.u32(3), bases, depthScale);
		mask = wsSample(id, d.u32(3), base.uv, std.mul(offset, useDisturb.y), base.dx, base.dy, data.custom);
		if ((flags & d.u32(SW_MASK_RED_ALPHA)) !== d.u32(0)) {
			mask = d.vec4f(1, 1, 1, mask.x);
		}
	}
	const tint = std.mul(
		fxRow(id, d.u32(FX_TINT)),
		std.select(d.vec4f(1), data.color, (flags & d.u32(SW_VERTEX_COLOR)) !== d.u32(0)),
	);
	const c = std.mul(tint, mask);
	let color = d.vec3f(c.xyz);
	if ((flags & d.u32(SW_BLEND)) !== d.u32(0)) {
		const st = fxRow(id, d.u32(FX_UV + 4));
		const base = swBase(id, d.u32(4), bases, depthScale);
		const blendUv = std.add(
			std.mul(
				std.add(
					fxSlotCoords(id, d.u32(4), std.add(base.uv, fxCustomShift(id, d.u32(4), data.custom))),
					std.mul(offset, useDisturb.z),
				),
				st.xy,
			),
			st.zw,
		);
		const blend = fxSample(
			d.u32(4),
			blendUv,
			std.mul(std.mul(fxSlotGradient(id, d.u32(4), base.dx), st.xy), bias),
			std.mul(std.mul(fxSlotGradient(id, d.u32(4), base.dy), st.xy), bias),
		);
		const blendTint = std.mul(fxRow(id, d.u32(SW_BLEND_TINT)), data.color);
		color = std.add(
			color,
			std.mul(std.mul(blend.xyz, std.saturate((c.w + blend.w) * blendTint.w)), blendTint.xyz),
		);
	}
	let alpha = c.w;
	if ((flags & d.u32(SW_DISSOLVE_ON)) !== d.u32(0)) {
		const dissolve = fxRow(id, d.u32(SW_DISSOLVE));
		const base = swBase(id, d.u32(5), bases, depthScale);
		const v =
			wsSample(id, d.u32(5), base.uv, std.mul(offset, useDisturb.w), base.dx, base.dy, data.custom).x -
			dissolve.x -
			data.custom.z * 2.02;
		const edge = std.saturate((dissolve.z - v) * dissolve.y);
		alpha *= std.saturate(v * dissolve.y);
		color = std.mix(color, std.mul(fxRow(id, d.u32(SW_DISSOLVE_COLOR)).xyz, edge), edge);
	}
	const depth = std.dot(data.rel, frame.viewForward.xyz);
	const soft = fxRow(id, d.u32(FX_SOFT));
	if (soft.x > 0) {
		alpha *= std.saturate((fxSceneDepth(d.vec2i(data.position.xy)) - depth + soft.y) / soft.x);
	}
	alpha = positive.w * std.saturate(alpha * fxNearFade(id, depth));
	const misc = fxRow(id, d.u32(FX_MISC));
	color = std.clamp(
		std.add(color, std.mul(std.max(std.sub(color, d.vec3f(misc.y)), d.vec3f(0)), misc.z)),
		d.vec3f(0),
		d.vec3f(1000),
	);

	const exponent = std.add(d.vec3f(1), std.mul(std.log2(std.max(color, d.vec3f(1e-5))), -0.43067657));
	const range = row.z;

	let n = std.normalize(data.normal);
	n = std.select(std.neg(n), n, std.dot(n, data.rel) <= 0);
	const away = std.neg(n);
	const xAxis = std.normalize(data.toObject0.xyz);
	const right = std.normalize(std.sub(xAxis, std.mul(away, std.dot(xAxis, away))));
	const up = std.cross(away, right);

	const world = std.add(data.rel, frame.eye.xyz);
	const allAxes = std.add(
		std.add(
			std.add(swAbsorb(positive.x, exponent, range), swAbsorb(positive.y, exponent, range)),
			std.add(swAbsorb(positive.z, exponent, range), swAbsorb(negative.x, exponent, range)),
		),
		std.add(swAbsorb(negative.y, exponent, range), swAbsorb(negative.z, exponent, range)),
	);
	let ambient = std.mul(ambientIrradiance(world, n), allAxes);
	{
		const grey = std.dot(ambient, LUMINANCE.$);
		ambient = std.mix(d.vec3f(grey), ambient, row.w);
	}
	const l = frame.sun.xyz;
	const lt = d.vec3f(std.dot(l, right), std.dot(l, up), std.dot(l, away));
	const through = std.dot(std.mul(lt, lt), std.select(negative, positive.xyz, std.ge(lt, d.vec3f(0))));
	const sun = std.mul(
		std.mul(std.mul(frame.sunColor.xyz, frame.sun.w / Math.PI), swAbsorb(through, exponent, range)),
		sunVisibility(data.rel, n, data.position.xy),
	);
	const shaded = std.add(ambient, sun);
	return fxAccumulate(
		std.mul(shaded, alpha),
		alpha,
		data.rel,
		data.position.xy,
		fxRow(id, d.u32(FX_UNFOGGED)).x,
	);
});
