/**
 * volumetric light beam shading (`EffectKind.Beam`).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout } from '../../core/frame-core.ts';

import {
	BM_ALPHA,
	BM_CLIP,
	BM_COLOR,
	BM_CONE,
	BM_DIRECTION,
	BM_FADE,
	BM_FALLOFF,
	BM_GLARE,
	BM_PLANE,
	BM_TILT,
	EffectVertexData,
	FX_UNFOGGED,
	fxAccumulate,
	fxAdditive,
	fxRow,
	fxSceneDepth,
} from './common.ts';
import { beamScale } from './vertex.ts';

const beamUnskew = tgpu.fn(
	[d.u32, d.vec3f],
	d.vec3f,
)((id, p) => {
	'use gpu';
	const dir = fxRow(id, d.u32(BM_DIRECTION));
	return d.vec3f(std.sub(p.xy, std.mul(dir.xy, p.z / dir.z)), p.z);
});

/**
 * shades a volumetric light beam cone into transparent-accumulated RGBA.
 *
 * @param data interpolated effect vertex data
 * @returns accumulated RGBA
 */
export const lightBeam = tgpu.fn(
	[EffectVertexData],
	d.vec4f,
)((data) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const id = data.look;
	const color = fxRow(id, d.u32(BM_COLOR));
	const cone = fxRow(id, d.u32(BM_CONE));
	const dir = fxRow(id, d.u32(BM_DIRECTION));
	const falloff = fxRow(id, d.u32(BM_FALLOFF));
	const alpha = fxRow(id, d.u32(BM_ALPHA));
	const glare = fxRow(id, d.u32(BM_GLARE));
	const fade = fxRow(id, d.u32(BM_FADE));
	const clip = fxRow(id, d.u32(BM_CLIP));
	const tilt = fxRow(id, d.u32(BM_TILT));
	const cap = data.uv.x;
	const outside = data.uv.y;

	const scale = beamScale(id);
	const toObject = d.vec3f(data.toObject0.w, data.toObject1.w, data.toObject2.w);
	const object = std.add(
		d.vec3f(
			std.dot(data.toObject0.xyz, data.rel),
			std.dot(data.toObject1.xyz, data.rel),
			std.dot(data.toObject2.xyz, data.rel),
		),
		toObject,
	);
	const skewed = std.mul(object, scale);
	const local = beamUnskew(id, skewed);
	const camera = beamUnskew(id, std.mul(toObject, scale));
	const viewDir = std.normalize(std.sub(local, camera));
	const depth = std.dot(data.rel, frame.viewForward.xyz);
	const near = frame.localLights.w;
	const along = std.abs(skewed.z) + skewed.x * tilt.x + skewed.y * tilt.y;

	let visible = d.f32(1);
	if (clip.w !== 0) {
		const plane = fxRow(id, d.u32(BM_PLANE));
		const side = std.saturate((std.dot(plane.xyz, std.add(data.rel, frame.eye.xyz)) + plane.w) / tilt.z);
		visible = std.mix(1, side, clip.w);
	}
	if (clip.y > 0) {
		const apexShare = std.saturate(std.abs(skewed.z) / clip.y);
		const distance = std.mix(clip.y, clip.y * apexShare, clip.z);
		let blend = d.f32(1);
		if (distance > 0) {
			const scene = fxSceneDepth(d.vec2i(data.position.xy));
			blend = std.saturate((std.max(0, scene - near) - std.max(0, depth - near)) / distance);
		}
		visible *= std.mix(1, blend, std.saturate(apexShare * 100));
	}
	visible *= std.smoothstep(0, 1, std.saturate((std.abs(depth) - near) / std.max(clip.x, 1e-4)));
	visible *= std.select(d.f32(0), d.f32(1), cap - 1e-5 <= dir.w) * (1 - outside * cap);

	const radial = std.select(d.vec2f(0), std.normalize(local.xy), std.dot(local.xy, local.xy) > 0);
	const normal = std.mul(d.vec3f(std.mul(radial, cone.z), -cone.w), outside * 2 - 1);
	const toCamera = std.neg(viewDir);
	const fromApex = std.normalize(std.add(local, d.vec3f(0, 0, glare.z)));
	const align = std.abs(std.dot(viewDir, dir.xyz));
	const across = std.sub(toCamera, std.mul(fromApex, std.dot(toCamera, fromApex)));
	const acrossDir = std.select(d.vec3f(0), std.normalize(across), std.dot(across, across) > 0);
	const f = std.smoothstep(0, 1, std.mix(std.dot(normal, acrossDir), std.dot(normal, toCamera), align));
	const power = std.mix(alpha.w, std.min(alpha.w, 1.5 * (1 - std.mix(glare.x, glare.y, outside))), align);
	const fresnel = std.select(0, std.pow(f, power), f > 0);
	const surface = std.mix(std.mix(fresnel, 1.001, cap), fresnel, outside);

	const originDistance = std.abs(data.origin.w);
	const distanceFade =
		std.saturate((originDistance - fade.x) / (fade.y - fade.x)) *
		std.saturate((originDistance - fade.z) / (fade.w - fade.z));
	let t = std.select(d.f32(0), d.f32(1), along >= falloff.x);
	if (falloff.y !== falloff.x) {
		t = std.saturate((along - falloff.x) / (falloff.y - falloff.x));
	}
	const linear = std.smoothstep(0, 1, 1 - t);
	const quadratic = (1 / (1 + 25 * t * t)) * (1 - std.smoothstep(0.8, 1, t));
	const attenuation = std.mix(linear, quadratic, alpha.z);
	const startFade = std.mix(std.select(1, std.saturate(along / falloff.w), falloff.w > 0), 1, cap);
	const facingBack = std.saturate(1 - std.smoothstep(-1, 1, viewDir.z));
	const facing = std.mix(facingBack, 1 - facingBack, outside);

	const intensity = visible * surface * distanceFade * attenuation * startFade * facing;
	const opacity = color.w * std.mix(alpha.x, alpha.y, outside);
	if (glare.w >= 0.5) {
		return fxAdditive(std.mul(color.xyz, opacity * intensity));
	}
	const a = std.saturate(opacity * intensity);
	return fxAccumulate(std.mul(color.xyz, a), a, data.rel, data.position.xy, fxRow(id, d.u32(FX_UNFOGGED)).x);
});
