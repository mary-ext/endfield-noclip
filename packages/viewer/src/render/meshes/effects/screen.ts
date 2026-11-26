/**
 * screen-space post-composite effects: `VFXRefract` (`fsRefract`) and `VFXRadialBlur` (`fsRadialBlur`).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout } from '../../core/frame-core.ts';

import {
	EffectFragmentIn,
	FX_CUSTOM_SCROLL,
	FX_SOFT,
	FxBases,
	SLOT_RED_ALPHA,
	effectMaterialLayout,
	fxBases,
	fxCustomShift,
	fxNearFade,
	fxPolar,
	fxRow,
	fxSample,
	fxSceneDepth,
	fxSlotBase,
	fxSlotBits,
	fxSlotCoords,
	fxSlotGradient,
} from './common.ts';

const RF_REFRACT = 17;
const RF_REFRACT2 = 18;
const RF_RB = 19;
const RF_RB_MAIN = 20;
const RF_RB_FIRST = 21;
const RF_RB_SECOND = 22;
const RF_DISSOLVE = 26;
const RF_SPREAD = 28;
const RF_BLEND_COLOR = 32;
const RF_BLEND = 33;

const RB_BLUR = 17;
const RB_OPTIONS = 18;
const RB_CENTER = 19;

const rfSample = tgpu.fn(
	[d.u32, d.u32, FxBases, d.vec4f, d.vec2f],
	d.vec4f,
)((id, slot, bases, custom, shift) => {
	'use gpu';
	const bias = std.exp2(frameLayout.$.frame.params.y);
	const bits = fxSlotBits(id, slot);
	const base = fxSlotBase(bases, bits);
	let t = fxSample(
		slot,
		std.add(fxSlotCoords(id, slot, std.add(base.uv, fxCustomShift(id, slot, custom))), shift),
		std.mul(fxSlotGradient(id, slot, base.dx), bias),
		std.mul(fxSlotGradient(id, slot, base.dy), bias),
	);
	if ((bits & d.u32(SLOT_RED_ALPHA)) !== d.u32(0)) {
		t = d.vec4f(1, 1, 1, t.x);
	}
	return t;
});

/** fragment entrypoint for `VFXRefract` screen-space refraction */
export const fsRefract = tgpu.fragmentFn({
	in: EffectFragmentIn,
	out: d.location(0, d.vec4f),
})((v) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const id = v.look;
	const bases = fxBases(v.uv.xy, v.uv.zw, fxPolar(std.sub(v.uv.xy, d.vec2f(0.5))), d.vec2f(0));
	const bias = std.exp2(frame.params.y);
	const row = fxRow(id, d.u32(RF_REFRACT));
	const row2 = fxRow(id, d.u32(RF_REFRACT2));
	let offset = d.vec2f(0);
	let amount = d.f32(0);
	{
		const bits = fxSlotBits(id, d.u32(0));
		const base = fxSlotBase(bases, bits);
		const t = fxSample(
			d.u32(0),
			fxSlotCoords(id, d.u32(0), std.add(base.uv, fxCustomShift(id, d.u32(0), v.custom))),
			std.mul(fxSlotGradient(id, d.u32(0), base.dx), bias),
			std.mul(fxSlotGradient(id, d.u32(0), base.dy), bias),
		);
		const centred = t.x * (1 + row.w) - row.w;
		const strength = row.z * v.color.w;
		const normal = std.mul(
			std.mul(std.sub(std.mul(d.vec2f(t.w * centred, t.y), 2), d.vec2f(1)), row.xy),
			strength,
		);
		offset = std.select(std.mul(row.xy, centred * strength), normal, row2.x !== 0);
		amount = std.select(centred, std.length(normal), row2.x !== 0);
	}
	const dissolveRow = fxRow(id, d.u32(RF_DISSOLVE));
	let dissolved = d.f32(1);
	if (dissolveRow.w !== 0) {
		const bits = fxSlotBits(id, d.u32(2));
		const base = fxSlotBase(bases, bits);
		const t = fxSample(
			d.u32(2),
			fxSlotCoords(id, d.u32(2), base.uv),
			std.mul(fxSlotGradient(id, d.u32(2), base.dx), bias),
			std.mul(fxSlotGradient(id, d.u32(2), base.dy), bias),
		);
		dissolved = std.saturate((t.x - dissolveRow.x - v.custom.z * 2.02) * dissolveRow.y);
		offset = std.mul(offset, dissolved);
	}
	let cover = d.f32(1);
	const spread = fxRow(id, d.u32(RF_SPREAD));
	if (spread.y > 0) {
		const s = rfSample(id, d.u32(4), bases, v.custom, d.vec2f(0)).x;
		const at = (spread.x + v.custom.w) * (1 + 2 * spread.y) - spread.y;
		const level = spread.z + s - 2 * s * spread.z;
		cover = std.saturate(1 - std.abs(at - level) / spread.y) * spread.w;
	}
	let mask = d.vec4f(1);
	if (row2.z !== 0) {
		mask = rfSample(id, d.u32(1), bases, v.custom, std.mul(offset, row2.y));
	}
	const blendRow = fxRow(id, d.u32(RF_BLEND));
	let tint = d.vec4f(mask);
	if (blendRow.x !== 0) {
		const blend = rfSample(id, d.u32(3), bases, v.custom, std.mul(offset, blendRow.y));
		const blendColor = fxRow(id, d.u32(RF_BLEND_COLOR));
		tint = std.mul(
			tint,
			d.vec4f(
				std.add(d.vec3f(1 - blendColor.w), std.mul(std.mul(blend.xyz, blendColor.xyz), blendColor.w)),
				blend.w,
			),
		);
	}
	const uv = std.add(std.div(v.position.xy, frame.renderSize.xy), offset);
	let behind = std.textureSampleLevel(
		effectMaterialLayout.$.fxBackground,
		effectMaterialLayout.$.fxBackgroundSamp,
		uv,
		0,
	).xyz;
	const main = fxRow(id, d.u32(RF_RB_MAIN));
	if (main.w !== 0) {
		const rb = fxRow(id, d.u32(RF_RB));
		const first = fxRow(id, d.u32(RF_RB_FIRST));
		const second = fxRow(id, d.u32(RF_RB_SECOND));
		const shift = std.mul(rb.xy, v.color.w * std.mix(1, amount, first.w));
		let split = std.max(
			std.mul(behind, main.xyz),
			std.mul(
				std.textureSampleLevel(
					effectMaterialLayout.$.fxBackground,
					effectMaterialLayout.$.fxBackgroundSamp,
					std.add(uv, shift),
					0,
				).xyz,
				first.xyz,
			),
		);
		if (second.w !== 0) {
			split = std.max(
				split,
				std.mul(
					std.textureSampleLevel(
						effectMaterialLayout.$.fxBackground,
						effectMaterialLayout.$.fxBackgroundSamp,
						std.add(uv, std.mul(shift, rb.z)),
						0,
					).xyz,
					second.xyz,
				),
			);
		}
		behind = std.max(std.mix(behind, split, rb.w), d.vec3f(0));
	}
	const depth = std.dot(v.rel, frame.viewForward.xyz);
	const soft = fxRow(id, d.u32(FX_SOFT));
	let softFade = d.f32(1);
	if (soft.x > 0) {
		softFade = std.saturate((fxSceneDepth(d.vec2i(v.position.xy)) - depth) / soft.x);
	}
	const alpha = std.saturate(
		cover * tint.w * softFade * fxNearFade(id, depth) * std.mix(1, dissolved, dissolveRow.z),
	);
	return d.vec4f(std.clamp(std.mul(behind, tint.xyz), d.vec3f(0), d.vec3f(1000)), alpha);
});

/** fragment entrypoint for `VFXRadialBlur` 5-tap screen-space radial blur */
export const fsRadialBlur = tgpu.fragmentFn({
	in: EffectFragmentIn,
	out: d.location(0, d.vec4f),
})((v) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const id = v.look;
	const bases = fxBases(v.uv.xy, v.uv.zw, fxPolar(std.sub(v.uv.xy, d.vec2f(0.5))), d.vec2f(0));
	const blur = fxRow(id, d.u32(RB_BLUR));
	const opts = fxRow(id, d.u32(RB_OPTIONS));
	const centerDir = fxRow(id, d.u32(RB_CENTER));
	const screenUv = std.div(v.position.xy, frame.renderSize.xy);
	let dir = d.vec2f(centerDir.zw);
	if (opts.z === 0) {
		const clip = std.mul(frame.viewProj, d.vec4f(v.origin.xyz, 1));
		const w = std.select(clip.w, 1e-6, std.abs(clip.w) < 1e-6);
		const ndc = std.div(clip.xy, w);
		const centerUv = d.vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
		const vec = std.sub(std.mul(centerUv, 2), d.vec2f(1));
		const unitV = std.normalize(std.select(vec, d.vec2f(1, 0), std.dot(vec, vec) < 1e-12));
		const clamped = std.select(
			std.clamp(centerUv, d.vec2f(0), d.vec2f(1)),
			std.mul(std.add(d.vec2f(1), unitV), 0.5),
			vec.x * vec.x + vec.y + vec.y > 1.999396,
		);
		dir = std.sub(screenUv, std.add(clamped, centerDir.xy));
	}
	const denom = std.select(1, std.max(0.01, v.origin.w - frame.localLights.w), opts.x !== 0);
	const step = std.mul(dir, std.pow(std.max(std.abs(dir), d.vec2f(1e-6)), d.vec2f(blur.y / denom)));
	const intensity = blur.x * std.select(1, v.color.w, blur.w !== 0);
	let accum = std.textureSampleLevel(
		effectMaterialLayout.$.fxBackground,
		effectMaterialLayout.$.fxBackgroundSamp,
		screenUv,
		0,
	).xyz;
	for (let i = d.i32(1); i < d.i32(3); i++) {
		const fi = d.f32(i);
		const a = std.textureSampleLevel(
			effectMaterialLayout.$.fxBackground,
			effectMaterialLayout.$.fxBackgroundSamp,
			std.sub(screenUv, std.mul(step, fi * intensity)),
			0,
		).xyz;
		const b = std.textureSampleLevel(
			effectMaterialLayout.$.fxBackground,
			effectMaterialLayout.$.fxBackgroundSamp,
			std.sub(screenUv, std.mul(step, (fi - 0.5) * intensity)),
			0,
		).xyz;
		accum = std.add(accum, std.mul(std.add(a, b), 0.5));
	}
	let color = std.mul(accum, 1 / 3);
	let alpha = blur.z;
	if (opts.y !== 0) {
		const bias = std.exp2(frame.params.y);
		const bits = fxSlotBits(id, d.u32(0));
		const base = fxSlotBase(bases, bits);
		const customShift = std.mul(fxRow(id, d.u32(FX_CUSTOM_SCROLL)).xy, v.custom.w);
		let mask = fxSample(
			d.u32(0),
			fxSlotCoords(id, d.u32(0), std.add(base.uv, customShift)),
			std.mul(fxSlotGradient(id, d.u32(0), base.dx), bias),
			std.mul(fxSlotGradient(id, d.u32(0), base.dy), bias),
		);
		if ((bits & d.u32(SLOT_RED_ALPHA)) !== d.u32(0)) {
			mask = d.vec4f(1, 1, 1, mask.x);
		}
		color = std.mul(color, mask.xyz);
		alpha *= mask.w;
	}
	const depth = std.dot(v.rel, frame.viewForward.xyz);
	const soft = fxRow(id, d.u32(FX_SOFT));
	let softFade = d.f32(1);
	if (soft.x > 0) {
		softFade = std.saturate((fxSceneDepth(d.vec2i(v.position.xy)) - depth) / soft.x);
	}
	alpha = std.saturate(alpha * softFade * fxNearFade(id, depth));
	return d.vec4f(std.clamp(color, d.vec3f(0), d.vec3f(1000)), alpha);
});
