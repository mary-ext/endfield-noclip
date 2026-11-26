/**
 * texture-stack effect fragment entrypoints: `VFXBaseV2` transparent (`fsEffect`), opaque (`fsEffectOpaque`),
 * multiply (`fsEffectMultiply`), and `VFXDecal` (`fsEffectDecal`), plus dispatch to water sheets, light
 * beams, and six-way smoke.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout, hermite, packGbufferUnlit } from '../../core/frame-core.ts';
import { ambientIrradiance, sunVisibilityFarCloudless } from '../../lighting/frame-lighting.ts';

import {
	EffectAccumulatedOut,
	EffectFragmentIn,
	EffectVertexData,
	FX_APPEAR,
	FX_APPEAR_BRIGHT,
	FX_APPEAR_NOISE,
	FX_BLEND_TINT,
	FX_CAMERA_PULL,
	FX_CRACK,
	FX_CRACK_NOISE,
	FX_DECAL,
	FX_DECAL_FADE,
	FX_DISSOLVE,
	FX_DISSOLVE_COLOR,
	FX_DISTURB,
	FX_EDGE,
	FX_EDGE_ALPHA,
	FX_EDGE_COLOR,
	FX_EMISSION,
	FX_FRESNEL,
	FX_FRESNEL_COLOR,
	FX_KIND_BEAM,
	FX_KIND_WATER_SHEET,
	FX_MAIN2,
	FX_MISC,
	FX_NORMAL_MAP,
	FX_OFFSET_MODE,
	FX_PARALLAX,
	FX_SOFT,
	FX_STACK_FLAGS,
	FX_TINT,
	FX_UNFOGGED,
	FX_WEIGHT,
	FxBases,
	ROLE_BLEND,
	ROLE_DISSOLVE,
	ROLE_DISTURB1,
	ROLE_DISTURB2,
	ROLE_MASK,
	ROLE_NONE,
	ROLE_WEIGHT,
	SLOT_RED_ALPHA,
	fxAccumulate,
	fxAdditive,
	fxBases,
	fxCustomShift,
	fxKeepsLitDecalsOff,
	fxNearFade,
	fxNothing,
	fxPolar,
	fxRow,
	fxSample,
	fxSceneDepth,
	fxSlotBase,
	fxSlotBits,
	fxSlotCoords,
	fxSlotGradient,
	fxSurfaceNormal,
	slotDisturb,
} from './common.ts';
import { lightBeam } from './light-beam.ts';
import { FX_KIND_SIX_WAY, sixWaySmoke } from './six-way-smoke.ts';
import { waterSheet } from './water-sheet.ts';

const FxCombineResult = d.struct({
	color: d.vec4f,
	unmasked: d.f32,
});

const fxDecalCracks = tgpu.fn(
	[d.u32, FxBases, d.vec2f, d.vec2f, d.vec2f, d.vec2f, d.vec2f],
	d.vec3f,
)((id, bases, uv, dx, dy, offset, parallax) => {
	'use gpu';
	const row = fxRow(id, d.u32(FX_PARALLAX));
	const crackRow = fxRow(id, d.u32(FX_CRACK));
	const crack = fxSample(d.u32(row.z), uv, dx, dy).x;
	const noiseSlot = d.u32(row.w);
	const bits = fxSlotBits(id, noiseSlot);
	const base = fxSlotBase(bases, bits);
	const bias = std.exp2(frameLayout.$.frame.params.y);
	const noiseUv = std.add(
		std.add(fxSlotCoords(id, noiseSlot, base.uv), std.mul(offset, crackRow.w)),
		parallax,
	);
	const noise = fxSample(
		noiseSlot,
		noiseUv,
		std.mul(fxSlotGradient(id, noiseSlot, base.dx), bias),
		std.mul(fxSlotGradient(id, noiseSlot, base.dy), bias),
	);
	return std.mix(
		std.mul(crackRow.xyz, crack),
		std.mul(noise.xyz, fxRow(id, d.u32(FX_CRACK_NOISE)).xyz),
		crack,
	);
});

const fxCombine = tgpu.fn(
	[d.u32, FxBases, d.vec4f, d.vec4f, d.vec4f, d.bool, d.vec2f],
	FxCombineResult,
)((id, bases, tint, custom, vertexColor, cracked, parallax) => {
	'use gpu';
	const weightRow = fxRow(id, d.u32(FX_WEIGHT));
	const disturb = fxRow(id, d.u32(FX_DISTURB));
	const flags = fxRow(id, d.u32(FX_STACK_FLAGS));
	const distorting = fxRow(id, d.u32(FX_MISC)).w !== 0;
	const dissolve = fxRow(id, d.u32(FX_DISSOLVE));
	const dissolveColor = fxRow(id, d.u32(FX_DISSOLVE_COLOR));
	const bias = std.exp2(frameLayout.$.frame.params.y);
	const disturbScale = std.select(1, custom.w, fxRow(id, d.u32(FX_EDGE_ALPHA)).y !== 0);
	let offset = d.vec2f(0);
	let weight = d.vec4f(1 - weightRow.w);
	let mask = d.vec4f(1 - dissolveColor.w);
	let blend = d.vec4f(0);
	let dissolved = d.f32(0);
	for (let slot = d.u32(1); slot < d.u32(7); slot++) {
		const bits = fxSlotBits(id, slot);
		const role = bits & d.u32(7);
		if (role === d.u32(ROLE_NONE)) {
			continue;
		}
		const base = fxSlotBase(bases, bits);
		const uv = std.add(
			fxSlotCoords(id, slot, std.add(base.uv, fxCustomShift(id, slot, custom))),
			std.mul(offset, slotDisturb(bits)),
		);
		let t = fxSample(
			slot,
			uv,
			std.mul(fxSlotGradient(id, slot, base.dx), bias),
			std.mul(fxSlotGradient(id, slot, base.dy), bias),
		);
		if ((bits & d.u32(SLOT_RED_ALPHA)) !== d.u32(0)) {
			t = d.vec4f(1, 1, 1, t.x);
		}
		const centred = t.x * (weightRow.x + 1) - weightRow.x;
		if (role === d.u32(ROLE_DISTURB1)) {
			let shift = std.mul(disturb.xy, centred);
			if (flags.z !== 0) {
				shift = std.mul(std.sub(std.mul(d.vec2f(t.w * centred, t.y), 2), d.vec2f(1)), disturb.x);
			}
			offset = std.add(offset, std.select(d.vec2f(0), std.mul(shift, disturbScale), distorting));
		} else if (role === d.u32(ROLE_DISTURB2)) {
			offset = std.add(
				offset,
				std.select(d.vec2f(0), std.mul(disturb.zw, centred * disturbScale), distorting),
			);
		} else if (role === d.u32(ROLE_WEIGHT)) {
			weight = std.add(weight, t);
			offset = std.mul(offset, 1 - weightRow.y + weight.x * weightRow.y);
		} else if (role === d.u32(ROLE_MASK)) {
			mask = std.add(mask, t);
		} else if (role === d.u32(ROLE_BLEND)) {
			blend = std.add(blend, t);
		} else if (role === d.u32(ROLE_DISSOLVE)) {
			dissolved = t.x;
		}
	}
	const bits = fxSlotBits(id, d.u32(0));
	const base = fxSlotBase(bases, bits);
	const mainUv = fxSlotCoords(id, d.u32(0), std.add(base.uv, fxCustomShift(id, d.u32(0), custom)));
	const mainDx = std.mul(fxSlotGradient(id, d.u32(0), base.dx), bias);
	const mainDy = std.mul(fxSlotGradient(id, d.u32(0), base.dy), bias);
	let mainSample = fxSample(
		d.u32(0),
		std.add(std.add(mainUv, std.mul(offset, slotDisturb(bits))), parallax),
		mainDx,
		mainDy,
	);
	if ((bits & d.u32(SLOT_RED_ALPHA)) !== d.u32(0)) {
		mainSample = d.vec4f(1, 1, 1, mainSample.x);
	}
	if (fxRow(id, d.u32(FX_CAMERA_PULL)).z !== 0) {
		mask = d.vec4f(1, 1, 1, mask.w);
	}
	const unmasked = tint.w * mainSample.w;
	const c = std.mul(std.mul(tint, mainSample), mask);
	const blendTint = std.mul(
		fxRow(id, d.u32(FX_BLEND_TINT)),
		std.select(d.vec4f(1), vertexColor, flags.w !== 0),
	);
	let color = std.add(
		std.mul(std.mul(blend.xyz, std.saturate((c.w + blend.w) * blendTint.w)), blendTint.xyz),
		c.xyz,
	);
	let alpha = c.w;
	const main2Slot = d.u32(fxRow(id, d.u32(FX_NORMAL_MAP)).w);
	if (main2Slot !== d.u32(0)) {
		const m2Bits = fxSlotBits(id, main2Slot);
		const m2Base = fxSlotBase(bases, m2Bits);
		const m2Uv = std.add(
			fxSlotCoords(id, main2Slot, std.add(m2Base.uv, fxCustomShift(id, main2Slot, custom))),
			std.mul(offset, slotDisturb(m2Bits)),
		);
		let m2 = fxSample(
			main2Slot,
			m2Uv,
			std.mul(fxSlotGradient(id, main2Slot, m2Base.dx), bias),
			std.mul(fxSlotGradient(id, main2Slot, m2Base.dy), bias),
		);
		if ((m2Bits & d.u32(SLOT_RED_ALPHA)) !== d.u32(0)) {
			m2 = d.vec4f(1, 1, 1, m2.x);
		}
		const main2 = fxRow(id, d.u32(FX_MAIN2));
		const m2Rgb = std.mul(m2.xyz, main2.xyz);
		color = std.mix(std.mul(color, m2Rgb), std.add(color, m2Rgb), main2.w);
	}
	if (cracked) {
		color = std.add(
			color,
			fxDecalCracks(id, bases, std.add(mainUv, parallax), mainDx, mainDy, offset, parallax),
		);
	}
	if (dissolve.w !== 0) {
		const threshold = std.mix(-1, dissolve.x + custom.z * 2.02, 1 - weightRow.z + weight.x * weightRow.z);
		const v = dissolved - threshold;
		const edge = std.saturate((dissolve.z - v) * dissolve.y);
		alpha *= std.saturate(v * dissolve.y);
		color = std.mix(color, std.mul(dissolveColor.xyz, edge), edge);
	}
	return FxCombineResult({ color: d.vec4f(color, alpha), unmasked });
});

const fxLayerBases = tgpu.fn(
	[EffectVertexData],
	FxBases,
)((data) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const kind = fxRow(data.look, d.u32(FX_UNFOGGED));
	const size = frame.renderSize.xy;
	const q = std.floor(data.position.xy);
	const screenFlags = d.u32(kind.w);
	let screen = d.vec2f((2 * q.x) / size.x - 1, (((2 * q.y) / size.y - 1) * size.y) / size.x);
	if ((screenFlags & d.u32(4)) !== d.u32(0)) {
		const fromOrigin = std.sub(data.rel, data.origin.xyz);
		screen = d.vec2f(std.dot(fromOrigin, frame.viewRight.xyz), std.dot(fromOrigin, frame.viewUp.xyz));
	}
	const screenY = std.select(screen.y, frame.eye.y + data.rel.y, (screenFlags & d.u32(2)) !== d.u32(0));
	const scale = std.select(
		1,
		std.max(1, data.origin.w - frame.localLights.w),
		(screenFlags & d.u32(1)) !== d.u32(0),
	);
	screen = std.mul(d.vec2f(screen.x, screenY), scale);
	return fxBases(data.uv.xy, data.uv.zw, fxPolar(std.sub(data.uv.xy, d.vec2f(0.5))), screen);
});

const fxBelowWaterBlend = tgpu.fn(
	[EffectVertexData],
	d.bool,
)((data) => {
	'use gpu';
	return data.rel.y + frameLayout.$.frame.eye.y < fxRow(data.look, d.u32(FX_DECAL)).z;
});

const fxUnsupportedChecker = tgpu.fn(
	[EffectVertexData],
	d.vec3f,
)((data) => {
	'use gpu';
	const cell = d.vec3i(std.floor(std.div(std.add(data.rel, frameLayout.$.frame.eye.xyz), 0.5)));
	return std.select(d.vec3f(1, 0, 1), d.vec3f(0), ((cell.x + cell.y + cell.z) & d.i32(1)) !== d.i32(0));
});

const fxAppearHash = tgpu.fn(
	[d.vec2f],
	d.f32,
)((p) => {
	'use gpu';
	const q = std.sub(p, std.mul(std.trunc(std.div(p, 1024)), 1024));
	return std.fract(std.sin(std.dot(q, d.vec2f(12.9898, 78.233))) * 43758.5453);
});

const fxAppearNoise = tgpu.fn(
	[d.vec2f],
	d.f32,
)((p) => {
	'use gpu';
	const i = std.floor(p);
	const f = std.fract(p);
	const a = fxAppearHash(i);
	const b = fxAppearHash(std.add(i, d.vec2f(1, 0)));
	const c = fxAppearHash(std.add(i, d.vec2f(0, 1)));
	const e = fxAppearHash(std.add(i, d.vec2f(1)));
	const u = std.mul(std.mul(f, f), std.sub(d.vec2f(3), std.mul(f, 2)));
	return std.mix(a, b, u.x) + (c - a) * u.y * (1 - u.x) + (e - b) * u.x * u.y;
});

const fxAppear = tgpu.fn(
	[EffectVertexData, FxBases, d.vec4f],
	d.vec4f,
)((data, bases, tint) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const id = data.look;
	const appear = fxRow(id, d.u32(FX_APPEAR));
	const noise = fxRow(id, d.u32(FX_APPEAR_NOISE));
	const flags = fxRow(id, d.u32(FX_STACK_FLAGS));
	const global = std.select(d.vec2f(0), frame.renderSize.zw, flags.y !== 0);
	const inner = appear.x + global.x;
	const outer = appear.y + global.y;
	const dist = std.length(std.sub(data.rel, d.vec3f(0, noise.z, 0)));
	const brightRaw = std.mul(fxRow(id, d.u32(FX_APPEAR_BRIGHT)), hermite(outer, inner, dist));
	const bright = d.vec4f(brightRaw.xyz, brightRaw.w * std.select(1, data.color.w, flags.x !== 0));
	const revealed = std.add(tint, bright);
	const base = fxSlotBase(bases, fxSlotBits(id, d.u32(0)));
	const uv = fxSlotCoords(id, d.u32(0), std.add(base.uv, fxCustomShift(id, d.u32(0), data.custom)));
	const n = fxAppearNoise(std.add(std.mul(uv, noise.x), d.vec2f(frame.eye.w * noise.y))) * 2 - 1;
	const fade = hermite(outer, inner, dist + appear.w * n);
	return d.vec4f(revealed.xyz, std.saturate(std.mix(revealed.w, revealed.w * appear.z, fade)));
});

const fxSlotSample = tgpu.fn(
	[d.u32, d.u32, FxBases],
	d.vec4f,
)((id, slot, bases) => {
	'use gpu';
	const base = fxSlotBase(bases, fxSlotBits(id, slot));
	const bias = std.exp2(frameLayout.$.frame.params.y);
	return fxSample(
		slot,
		fxSlotCoords(id, slot, base.uv),
		std.mul(fxSlotGradient(id, slot, base.dx), bias),
		std.mul(fxSlotGradient(id, slot, base.dy), bias),
	);
});

const fxFresnelNormal = tgpu.fn(
	[EffectVertexData, FxBases, d.bool],
	d.vec3f,
)((data, bases, front) => {
	'use gpu';
	const id = data.look;
	const row = fxRow(id, d.u32(FX_NORMAL_MAP));
	let n = std.normalize(data.normal);
	if (row.x > 0 && data.tangent.w !== 0) {
		const texel = fxSlotSample(id, d.u32(row.x), bases);
		const xy = std.sub(std.mul(d.vec2f(texel.w * texel.x, texel.y), 2), d.vec2f(1));
		const z = std.max(1e-16, std.sqrt(1 - std.saturate(std.dot(xy, xy))));
		const tangentN = std.normalize(d.vec3f(std.mul(xy, row.y), z));
		const t = std.normalize(std.sub(data.tangent.xyz, std.mul(n, std.dot(data.tangent.xyz, n))));
		const b = std.mul(std.cross(n, t), data.tangent.w);
		n = std.normalize(
			std.add(std.add(std.mul(t, tangentN.x), std.mul(b, tangentN.y)), std.mul(n, tangentN.z)),
		);
	}
	return std.select(n, std.select(std.neg(n), n, front), row.z !== 0);
});

const fxStackLayer = tgpu.fn(
	[EffectVertexData, FxBases, d.bool],
	d.vec4f,
)((data, bases, front) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const id = data.look;
	const soft = fxRow(id, d.u32(FX_SOFT));
	const misc = fxRow(id, d.u32(FX_MISC));
	let tint = std.mul(fxRow(id, d.u32(FX_TINT)), std.select(d.vec4f(1), data.color, soft.w !== 0));
	const breathing = fxRow(id, d.u32(FX_DECAL_FADE));
	if (breathing.w > 0) {
		const wave = std.saturate(std.pow(std.cos(frame.eye.w * breathing.y) * 0.5 + 0.5, breathing.z));
		tint = d.vec4f(tint.xyz, tint.w * std.mix(breathing.x, 1, wave));
	}
	if (fxRow(id, d.u32(FX_APPEAR_NOISE)).w > 0) {
		tint = fxAppear(data, bases, tint);
	}
	const result = fxCombine(id, bases, tint, data.custom, data.color, false, d.vec2f(0));
	let combined = d.vec4f(result.color);
	const unmasked = result.unmasked;
	const depth = std.dot(data.rel, frame.viewForward.xyz);
	const fresnelRow = fxRow(id, d.u32(FX_FRESNEL));
	if (fresnelRow.x > 0) {
		const n = fxFresnelNormal(data, bases, front);
		const f = std.pow(
			std.saturate(std.dot(std.normalize(std.neg(data.rel)), n) + fresnelRow.y),
			fresnelRow.x,
		);
		const fresnel = std.mix(1 - f, f, fresnelRow.z);
		const fresnelColor = fxRow(id, d.u32(FX_FRESNEL_COLOR));
		combined = d.vec4f(
			std.mix(combined.xyz, fresnelColor.xyz, fresnelColor.w * fresnel),
			std.saturate(combined.w) * std.mix(1, fresnel, fresnelRow.w),
		);
	}
	const edgeRow = fxRow(id, d.u32(FX_EDGE));
	if (edgeRow.w > 0) {
		const edgeColor = fxRow(id, d.u32(FX_EDGE_COLOR));
		const gap = std.max(fxSceneDepth(d.vec2i(data.position.xy)) - depth, 0.001);
		const e = edgeColor.w * std.saturate(edgeRow.x / gap - edgeRow.y);
		const added = std.add(combined, std.mul(d.vec4f(edgeColor.xyz, fxRow(id, d.u32(FX_EDGE_ALPHA)).x), e));
		const multiplied = std.mul(combined, d.vec4f(edgeColor.xyz, e));
		combined = std.mix(multiplied, added, edgeRow.z);
	}
	let color = d.vec3f(combined.xyz);
	color = std.add(color, std.mul(std.max(std.sub(color, d.vec3f(misc.y)), d.vec3f(0)), misc.z));
	const emission = fxRow(id, d.u32(FX_EMISSION));
	if (emission.w > 0) {
		color = std.add(color, std.mul(fxSlotSample(id, d.u32(emission.w), bases).xyz, emission.xyz));
	}
	color = std.clamp(std.mul(color, std.mix(1, frame.ambient.y, soft.z)), d.vec3f(0), d.vec3f(1000));
	const lighting = fxRow(id, d.u32(FX_OFFSET_MODE));
	if (lighting.z > 0) {
		let n = std.normalize(data.normal);
		n = std.select(std.neg(n), n, std.dot(n, data.rel) <= 0);
		n = std.select(n, d.vec3f(0, 1, 0), lighting.w > 0);
		const sun = std.mul(
			std.mul(frame.sunColor.xyz, (frame.sun.w / Math.PI) * std.saturate(std.dot(n, frame.sun.xyz))),
			sunVisibilityFarCloudless(data.rel, n),
		);
		color = std.mul(color, std.add(ambientIrradiance(std.add(data.rel, frame.eye.xyz), n), sun));
	}
	if (fxRow(id, d.u32(FX_CAMERA_PULL)).w !== 0) {
		color = std.mul(color, std.saturate(unmasked * fxNearFade(id, depth)));
	}
	let softFade = d.f32(1);
	if (soft.x > 0) {
		softFade = std.saturate((fxSceneDepth(d.vec2i(data.position.xy)) - depth + soft.y) / soft.x);
	}
	const alpha = std.saturate(std.saturate(combined.w) * softFade * fxNearFade(id, depth));
	return d.vec4f(color, std.pow(alpha, fxRow(id, d.u32(FX_DECAL)).w));
});

const fxDecalParallax = tgpu.fn(
	[d.u32, EffectVertexData, FxBases, d.vec3f],
	d.vec2f,
)((id, data, bases, view) => {
	'use gpu';
	const row = fxRow(id, d.u32(FX_PARALLAX));
	const depthSlot = d.u32(row.y);
	const v = d.vec3f(
		std.dot(view, std.normalize(data.toObject0.xyz)),
		std.dot(view, std.normalize(data.toObject2.xyz)),
		std.dot(view, data.up),
	);
	const step = std.mul(std.div(v.xy, v.z), row.x);
	const bits = fxSlotBits(id, d.u32(0));
	const base = fxSlotBase(bases, bits);
	const bias = std.exp2(frameLayout.$.frame.params.y);
	const uv = fxSlotCoords(id, d.u32(0), base.uv);
	const dx = std.mul(fxSlotGradient(id, d.u32(0), base.dx), bias);
	const dy = std.mul(fxSlotGradient(id, d.u32(0), base.dy), bias);
	let shift = d.vec2f(step);
	let previous = d.vec2f(0);
	let layer = d.f32(29 / 30);
	let height = d.f32(0);
	let previousLayer = d.f32(1);
	let previousHeight = d.f32(0);
	for (let i = d.i32(0); i < d.i32(31); i++) {
		height = fxSample(depthSlot, std.add(uv, shift), dx, dy).x;
		if (height > layer) {
			break;
		}
		previous = d.vec2f(shift);
		previousLayer = layer;
		previousHeight = height;
		shift = std.add(shift, step);
		layer -= 1 / 30;
	}
	const t = (previousHeight - previousLayer) / (previousHeight - height + layer - previousLayer);
	return std.add(previous, std.mul(step, t));
});

/** fragment entrypoint for transparent `VFXBaseV2`, `VFXWater`, `LightBeam`, and `SixWaySmoke` effects */
export const fsEffect = tgpu.fragmentFn({
	in: {
		...EffectFragmentIn,
		front: d.builtin.frontFacing,
	},
	out: EffectAccumulatedOut,
})((v) => {
	'use gpu';
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
	const id = data.look;
	const dx = std.dpdx(data.uv);
	const dy = std.dpdy(data.uv);
	const relDx = std.dpdx(data.rel);
	const relDy = std.dpdy(data.rel);
	const kind = fxRow(id, d.u32(FX_UNFOGGED));
	const bases = fxLayerBases(data);
	if (kind.y === FX_KIND_WATER_SHEET) {
		return { color: waterSheet(data, v.front, dx.xy, dy.xy, relDx, relDy) };
	}
	if (kind.y === FX_KIND_BEAM) {
		return { color: lightBeam(data) };
	}
	if (kind.y === FX_KIND_SIX_WAY) {
		return { color: sixWaySmoke(data, bases) };
	}
	const layer = fxStackLayer(data, bases, v.front);
	if (fxBelowWaterBlend(data)) {
		return { color: fxAccumulate(fxUnsupportedChecker(data), 1, data.rel, data.position.xy, kind.x) };
	}
	if (kind.z >= 0.5) {
		return { color: fxAdditive(std.mul(layer.xyz, layer.w)) };
	}
	return { color: fxAccumulate(std.mul(layer.xyz, layer.w), layer.w, data.rel, data.position.xy, kind.x) };
});

/** fragment entrypoint for opaque `VFXBaseV2` layers written as unlit into the main G-buffer */
export const fsEffectOpaque = tgpu.fragmentFn({
	in: {
		...EffectFragmentIn,
		front: d.builtin.frontFacing,
	},
	out: {
		emission: d.location(0, d.vec4f),
		gbufferA: d.location(1, d.vec4f),
		gbufferB: d.location(2, d.vec4f),
		gbufferC: d.location(3, d.vec4f),
		mipFeedback: d.location(4, d.vec4u),
		velocity: d.location(5, d.vec4f),
	},
})((v) => {
	'use gpu';
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
	const layer = fxStackLayer(data, fxLayerBases(data), v.front);
	const out = packGbufferUnlit(
		std.select(std.mul(layer.xyz, layer.w), fxUnsupportedChecker(data), fxBelowWaterBlend(data)),
		d.u32(0),
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

/** fragment entrypoint for `_BlendMode` 2 `VFXBaseV2` layers multiplying the composited scene */
export const fsEffectMultiply = tgpu.fragmentFn({
	in: {
		...EffectFragmentIn,
		front: d.builtin.frontFacing,
	},
	out: d.location(0, d.vec4f),
})((v) => {
	'use gpu';
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
	const layer = fxStackLayer(data, fxLayerBases(data), v.front);
	return d.vec4f(std.mix(d.vec3f(1), layer.xyz, layer.w), 1);
});

/** fragment entrypoint for `VFXDecal` projected boxes */
export const fsEffectDecal = tgpu.fragmentFn({
	in: EffectFragmentIn,
	out: EffectAccumulatedOut,
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
	const id = data.look;
	const px = d.vec2i(data.position.xy);
	const sceneDepth = fxSceneDepth(px);
	const rel = std.mul(data.rel, sceneDepth / std.dot(data.rel, frame.viewForward.xyz));
	const p = d.vec4f(rel, 1);
	const objectP = d.vec3f(std.dot(data.toObject0, p), std.dot(data.toObject1, p), std.dot(data.toObject2, p));
	const uv = std.add(objectP.xz, d.vec2f(0.5));
	const screen = std.div(std.floor(data.position.xy), frame.renderSize.x);
	const bases = fxBases(uv, uv, fxPolar(objectP.xz), screen);
	if (std.any(std.ge(std.abs(objectP), d.vec3f(0.5))) || sceneDepth >= 1e9) {
		return { color: fxNothing() };
	}
	const covers = fxRow(id, d.u32(FX_DECAL)).z;
	if (covers > 0.5 && fxKeepsLitDecalsOff(px) !== covers > 1.5) {
		return { color: fxNothing() };
	}
	const cracked = fxRow(id, d.u32(FX_PARALLAX)).y !== 0;
	let parallax = d.vec2f(0);
	if (cracked) {
		parallax = fxDecalParallax(id, data, bases, std.normalize(std.neg(rel)));
	}
	const combined = fxCombine(
		id,
		bases,
		fxRow(id, d.u32(FX_TINT)),
		data.custom,
		data.color,
		cracked,
		parallax,
	).color;
	const soft = fxRow(id, d.u32(FX_SOFT));
	const color = std.mul(
		std.clamp(combined.xyz, d.vec3f(0), d.vec3f(1000)),
		std.mix(1, frame.ambient.y, soft.z),
	);

	const fade = fxRow(id, d.u32(FX_DECAL_FADE));
	const decal = fxRow(id, d.u32(FX_DECAL));
	const height = std.saturate(((0.5 + std.abs(decal.x) - std.abs(objectP.y + decal.x)) / fade.w) * 2);
	const edgeX = std.smoothstep(0.5 - fade.x + fade.z, 0.5 - fade.x, std.abs(objectP.x));
	const edgeZ = std.smoothstep(0.5 - fade.y + fade.z, 0.5 - fade.y, std.abs(objectP.z));
	let angle = d.f32(1);
	if (decal.y > 0) {
		const n = fxSurfaceNormal(px);
		if (std.any(std.ne(n, d.vec3f(0)))) {
			angle = std.pow(std.saturate(std.dot(data.up, n)), decal.y);
		}
	}
	const alpha = std.saturate(combined.w * fxNearFade(id, sceneDepth) * height * edgeX * edgeZ) * angle;
	if (fxRow(id, d.u32(FX_UNFOGGED)).z >= 0.5) {
		return { color: fxAdditive(std.mul(color, alpha * alpha)) };
	}
	return {
		color: fxAccumulate(
			std.mul(color, alpha * alpha),
			alpha,
			rel,
			data.position.xy,
			fxRow(id, d.u32(FX_UNFOGGED)).x,
		),
	};
});
