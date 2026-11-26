/**
 * deferred lighting shader: unpacks the G-buffer, applies high-quality rain wetness and wetness decals,
 * evaluates sun, shadows, local lights, irradiance volume, local reflection probes, GTAO, and SSR blending,
 * and writes lit HDR radiance into `scene.lit` (discarding sky pixels so the celestial pass stays intact).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { Surface, frameLayout, unpackGbuffer } from '../core/frame-core.ts';
import { SHADING_UNLIT } from '../core/gbuffer.ts';
import { postUniformLayout, viewDepth, viewRay } from '../core/post-schema.ts';
import { fresnelSchlick, ggxDistribution, LUMINANCE_ROUNDED } from '../core/shader-math.ts';

import {
	ambientIrradiance,
	environmentBrdf,
	foliageSun,
	localLighting,
	sampleReflection,
	smithVisibility,
	subsurfaceSun,
	sunVisibility,
} from './frame-lighting.ts';

/** group 2 bind group layout for deferred lighting: G-buffer, depth, AO, SSR, wetness mask, and linear sampler */
export const deferredInputsLayout = tgpu
	.bindGroupLayout({
		gbEmission: { texture: d.texture2d(d.f32) },
		gbA: { texture: d.texture2d(d.f32) },
		gbB: { texture: d.texture2d(d.f32) },
		gbC: { texture: d.texture2d(d.f32) },
		gbDepth: { texture: d.textureDepth2d() },
		aoTexture: { texture: d.texture2d(d.f32) },
		ssrTexture: { texture: d.texture2d(d.f32) },
		wetnessTexture: { texture: d.texture2d(d.f32) },
		linearSampler: { sampler: 'filtering' },
	})
	.$idx(2);

/** GPU schema of the high-quality rain wetness uniform block */
export const RainWetnessSchema = d.struct({
	/** camera-relative (centerX, topRelY, centerZ, 1 / (2 * range)) */
	occOrigin: d.vec4f,
	/** (1 / height, height, texelWorldSize, active) */
	occMetrics: d.vec4f,
	/** (normalBias, depthBias, noiseScale, hasNoise) */
	occBias: d.vec4f,
	/** (horizontalJitterLevel, verticalJitterLevel, 0, 0) */
	occJitter: d.vec4f,
	/** (flowOffset, normalStrength, slopeThreshold, porosity) */
	flowParams: d.vec4f,
	/** (scaleX, scaleY, offsetX, offsetY) */
	flowSt: d.vec4f,
	/** (rippleTimeOffset, rippleNormalStrength, waveTimeOffset, waveNormalStrength) */
	rippleParams: d.vec4f,
	/** (scaleX, scaleY, rowColumnCount, roughnessMaskThreshold) */
	rippleSt: d.vec4f,
});

/** byte size of {@link RainWetnessSchema} */
export const RAIN_WETNESS_BYTES = d.sizeOf(RainWetnessSchema);

/**
 * group 3 bind group layout for deferred lighting: rain wetness uniforms, vertical occlusion, and
 * runoff/ripple maps
 */
export const rainWetnessLayout = tgpu
	.bindGroupLayout({
		rainWet: { uniform: RainWetnessSchema },
		verticalOcclusion: { texture: d.textureDepth2d() },
		verticalOcclusionCompare: { sampler: 'comparison' },
		rainOccNoise: { texture: d.texture3d(d.f32) },
		rippleTexture: { texture: d.texture2d(d.f32) },
		verticalFlowTexture: { texture: d.texture2d(d.f32) },
		repeatSampler: { sampler: 'filtering' },
	})
	.$idx(3);

const applyRainWetness = tgpu.fn(
	[Surface, d.vec3f, d.vec3f, d.f32],
	Surface,
)((sIn, rel, geoN, surfacePorosity) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const p0 = frame.wetness[0];
	if (p0.x <= 0) {
		return Surface(sIn);
	}
	const p1 = frame.wetness[1];
	const rainWet = rainWetnessLayout.$.rainWet;
	const s = Surface(sIn);
	const n = d.vec3f(s.normal);
	const worldPos = std.add(frame.eye.xyz, rel);
	const down = -n.y;

	let noise = d.f32(0);
	let jitter = d.vec3f(0);
	if (rainWet.occBias.w > 0.5) {
		const an = std.abs(n);
		const w = std.div(an, std.max(an.x + an.y + an.z, 1e-5));
		noise = std.textureSampleLevel(
			rainWetnessLayout.$.rainOccNoise,
			rainWetnessLayout.$.repeatSampler,
			std.mul(worldPos, rainWet.occBias.z),
			0,
		).x;
		const dir = std.add(
			std.add(std.mul(d.vec3f(0, 0, 1), w.x), std.mul(d.vec3f(Math.SQRT1_2, 0, Math.SQRT1_2), w.y)),
			std.mul(d.vec3f(1, 0, 0), w.z),
		);
		const jitterAmt = std.mix(
			rainWet.occJitter.y,
			rainWet.occJitter.x,
			std.smoothstep(0.7, 0.95, std.abs(down)),
		);
		jitter = std.mul(dir, (noise * 2 - 1) * jitterAmt);
	}

	const biasScale = (1 - std.clamp(down, 0, 0.9)) * std.clamp(1 - std.smoothstep(0.1, 0.2, down), 0.1, 1);
	const sampleRel = std.add(
		std.add(
			rel,
			std.mul(
				std.add(std.mul(n, rainWet.occMetrics.z * rainWet.occBias.x), d.vec3f(0, rainWet.occBias.y, 0)),
				biasScale,
			),
		),
		jitter,
	);
	const occUv = d.vec2f(
		0.5 + (sampleRel.x - rainWet.occOrigin.x) * rainWet.occOrigin.w,
		0.5 - (sampleRel.z - rainWet.occOrigin.z) * rainWet.occOrigin.w,
	);
	const occZ = (rainWet.occOrigin.y - sampleRel.y) * rainWet.occMetrics.x;
	let exposed = d.f32(1);
	if (
		rainWet.occMetrics.w > 0.5 &&
		std.all(std.gt(occUv, d.vec2f(0))) &&
		std.all(std.lt(occUv, d.vec2f(1))) &&
		occZ > 0 &&
		occZ < 1
	) {
		exposed = std.textureSampleCompareLevel(
			rainWetnessLayout.$.verticalOcclusion,
			rainWetnessLayout.$.verticalOcclusionCompare,
			occUv,
			std.max(occZ, 0.00048828125),
		);
	}

	const up = std.saturate(n.y);
	const facing = std.mix(p1.w, 1, up);
	const dist = std.max(std.abs(rel.x), std.abs(rel.z));
	const open = std.mix(facing * exposed, 1, std.smoothstep(0.7 * p0.w, 0.75 * p0.w, dist));
	const nearCov = std.mix(p1.z * facing, 1, open);
	const coverage = std.mix(nearCov, p1.y, std.smoothstep(p0.w, std.max(p1.x * p0.w, p0.w + 1e-4), dist));

	const geoUp = std.saturate(std.mul(geoN, std.inverseSqrt(std.max(1e-38, std.dot(geoN, geoN)))).y);
	const slopeA = rainWet.flowParams.z * 0.3;
	const slopeB = slopeA + 0.686;
	const distFade = 1 - std.saturate((std.dot(rel, frame.viewForward.xyz) - 15) * 0.015);
	const threshold = rainWet.rippleSt.w;
	let flat = d.f32(0);
	if (threshold > 0) {
		const upMask = std.smoothstep(std.min(std.max(slopeB, 0.97), 0.989), 0.99, up);
		const geoMask = std.smoothstep(0.991, 1, geoUp) * std.step(s.occlusion, noise * 0.2 + 0.8);
		flat = std.smoothstep(std.min(threshold, 0.99), std.max(threshold, 1e-4), std.saturate(upMask + geoMask));
	}

	let flowNormal = d.vec3f(n);
	let flowWet = d.f32(0);
	const wallMask = (1 - std.smoothstep(slopeB, slopeA + 0.687, geoUp)) * std.smoothstep(-0.5, -0.1, n.y);
	if (rainWet.flowParams.y > 0.0005 && wallMask > 0.0005) {
		const an2 = std.mul(n, n);
		const bw = std.div(an2, std.max(an2.x + an2.z, 1e-5));
		const tVec = std.normalize(std.cross(n, d.vec3f(0, 1, 0)));
		const bVec = std.normalize(std.cross(tVec, n));
		const cell3 = std.add(std.floor(std.add(std.mul(worldPos, 2), d.vec3f(0.31415927))), d.vec3f(0.5));
		const cellKey = std.add(cell3.xz, cell3.yy);
		const wrappedKey = std.sub(cellKey, std.mul(std.trunc(std.div(cellKey, 1024)), 1024));
		const h = std.fract(std.sin(std.dot(wrappedKey, d.vec2f(12.9898, 78.233))) * 43758.546875);
		const signs = std.sub(std.mul(std.step(d.vec2f(0), n.zx), 2), d.vec2f(1));
		const wp = d.vec3f(worldPos.x * signs.x, worldPos.y, worldPos.z * -signs.y);
		const nh = noise * h;
		const flowT = d.vec2f(
			std.fract(-rainWet.flowParams.x * ((1 - h) * 0.7 + 0.3) + nh * 3),
			std.fract(rainWet.flowParams.x * -0.3 + nh * 6),
		);
		const freq = std.floor(h * 5) + 1;
		const yPhase = std.fract(std.mul(d.vec2f(freq, 0.1 * freq), worldPos.y));
		const pulse = std.mix(
			std.max(
				std.smoothstep(d.vec2f(0.8), d.vec2f(1), std.sub(yPhase, std.sub(flowT, d.vec2f(1)))),
				std.sub(flowT, yPhase),
			),
			std.max(
				std.smoothstep(d.vec2f(0.8), d.vec2f(1), std.sub(yPhase, flowT)),
				std.sub(std.add(flowT, d.vec2f(1)), yPhase),
			),
			std.step(flowT, yPhase),
		);
		const pX = std.smoothstep(0.4, 1, pulse.x * pulse.x);
		const pY = pulse.y * 2 - 1;
		const uvOff = d.vec2f(noise * 0.1 + 0.01 * pX * pY, noise * (noise + pX * 0.01 * pX * pY));
		const flowSample = std.add(
			std.mul(
				std.textureSampleLevel(
					rainWetnessLayout.$.verticalFlowTexture,
					rainWetnessLayout.$.repeatSampler,
					std.add(std.mul(wp.zy, rainWet.flowSt.xy), uvOff),
					0,
				),
				bw.x,
			),
			std.mul(
				std.textureSampleLevel(
					rainWetnessLayout.$.verticalFlowTexture,
					rainWetnessLayout.$.repeatSampler,
					std.add(std.mul(wp.xy, rainWet.flowSt.xy), uvOff),
					0,
				),
				bw.z,
			),
		);
		const fXy = std.sub(std.mul(flowSample.xy, 2), d.vec2f(1));
		const fW = flowSample.w;
		const streak = std.max(
			std.smoothstep(0.7, 1, std.saturate(pulse.y + (pX * 2 - 1) * 0.8) * (1 - fW * 0.5)),
			std.mix(0.1, 0.6, std.saturate(pY * fW * 0.5 + pX)),
		);
		const fZ = flowSample.z;
		const flowAmt =
			std.mix(0.1, streak * 0.7 + 0.3, std.step(std.pow(std.saturate(1 - streak), 5), fZ)) *
			fZ *
			rainWet.flowParams.y *
			0.33 *
			(p0.x * open * std.step(0.045, surfacePorosity) * distFade);
		if (flowAmt > 0.0005) {
			const fnZ = std.max(0.00048828125, std.sqrt(1 - std.saturate(std.dot(fXy, fXy))));
			const fnXy = std.mul(fXy, std.smoothstep(0, 0.1, flowAmt) * rainWet.flowParams.y);
			const fnZBlend = std.mix(std.mix(0, -0.2, std.smoothstep(1.5, 3, rainWet.flowParams.y)), fnZ, flowAmt);
			const fnRaw = d.vec3f(fnXy, fnZBlend);
			const fnTs = std.mul(fnRaw, std.inverseSqrt(std.max(1e-20, std.dot(fnRaw, fnRaw))));
			const fnWs = std.add(std.add(std.mul(tVec, fnTs.x), std.mul(bVec, fnTs.y)), std.mul(n, fnTs.z));
			const mixedN = std.mix(n, fnWs, std.saturate(flowAmt));
			flowNormal = std.mul(mixedN, std.inverseSqrt(std.max(1e-20, std.dot(mixedN, mixedN))));
			flowWet = flowAmt * rainWet.flowParams.y * 0.33;
		}
	}

	let outNormal = d.vec3f(flowNormal);
	let standing = d.f32(0);
	if (flat > 0.0005) {
		const uvBase = std.mul(std.neg(worldPos.xz), rainWet.rippleSt.xy);
		const cell = std.floor(uvBase);
		const cellUv = std.fract(uvBase);
		let rippleXy = d.vec2f(0);
		if (rainWet.rippleParams.y > 0.0005) {
			const wrappedCell = std.sub(cell, std.mul(std.trunc(std.div(cell, 1024)), 1024));
			const h = std.fract(std.sin(std.dot(wrappedCell, d.vec2f(12.9898, 78.233))) * 43758.546875);
			const cols = rainWet.rippleSt.z;
			const frameIdx = std.floor(std.fract(rainWet.rippleParams.x + h) * (cols * cols));
			const invCols = 1 / cols;
			const tileUv = std.mix(cellUv, cellUv.yx, std.step(h, 0.5));
			const atlasUv = std.fract(
				std.add(
					std.mul(tileUv, invCols),
					d.vec2f(
						invCols * (frameIdx - cols * std.trunc(frameIdx / cols)),
						invCols * (cols - 1 - std.floor(frameIdx * invCols)),
					),
				),
			);
			const rippleSample = std.textureSampleLevel(
				rainWetnessLayout.$.rippleTexture,
				deferredInputsLayout.$.linearSampler,
				atlasUv,
				0,
			).xy;
			rippleXy = std.mul(std.sub(std.mul(rippleSample, 2), d.vec2f(1)), rainWet.rippleParams.y);
		}
		if (rainWet.rippleParams.w > 0.0005) {
			const wUv1 = std.add(
				std.add(uvBase, d.vec2f(0, rainWet.rippleParams.z)),
				d.vec2f(noise * 0.5 - 0.5, 0),
			);
			const wUv2 = std.sub(
				std.sub(uvBase, d.vec2f(rainWet.rippleParams.z, 0)),
				d.vec2f(0, (1 - noise) * 0.5 - 0.5),
			);
			const w1 = std.textureSampleLevel(
				rainWetnessLayout.$.rippleTexture,
				rainWetnessLayout.$.repeatSampler,
				wUv1,
				0,
			).zw;
			const w2 = std.textureSampleLevel(
				rainWetnessLayout.$.rippleTexture,
				rainWetnessLayout.$.repeatSampler,
				wUv2,
				0,
			).zw;
			const waveSum = std.add(std.sub(std.mul(w1, 2), d.vec2f(1)), std.sub(std.mul(w2, 2), d.vec2f(1)));
			rippleXy = std.add(rippleXy, std.mul(waveSum, rainWet.rippleParams.w * noise));
		}
		const level = (noise * 0.7 + s.roughness * 0.3) * std.saturate((s.roughness - 0.1) * 100) * s.occlusion;
		const fill = std.smoothstep(std.min(level, 0.99), std.saturate(level + 0.6), threshold);
		const wet = p0.x * flat;
		const rZ = std.max(0.00048828125, std.sqrt(1 - std.saturate(std.dot(rippleXy, rippleXy))));
		const rN = std.mul(std.normalize(d.vec3f(rippleXy, rZ)).yzx, d.vec3f(1, 1, -1));
		outNormal = std.normalize(std.mix(n, rN, std.saturate(wet * fill * open * distFade)));
		const depth = std.saturate(
			std.mix(threshold * (1 - noise) * 0.5, 1, fill) + std.smoothstep(0.6, 1, threshold) * 0.6,
		);
		standing = std.max(
			std.smoothstep(0, std.max(s.occlusion * 0.2, 1e-4), wet * depth * rN.y) * open * distFade,
			0,
		);
	}

	const smoothness = 1 - s.roughness;
	const porosity = std.mix(
		std.saturate(
			std.saturate(smoothness * p0.z + p0.y) +
				std.mix(0, rainWet.flowParams.w, flowWet) +
				standing * 0.1 * s.roughness,
		),
		1,
		s.metallic,
	);
	const notDown = 1 - std.smoothstep(0.2, 0.5, down);
	const darken = std.mix(1, 0.25, p0.x * porosity * (1 - s.metallic) * notDown);
	const wetSmoothness = std.clamp(
		std.saturate(std.mix(0.9, 0.6, porosity) + std.mix(-0.6, 0.4, std.sqrt(smoothness))),
		smoothness,
		0.99,
	);
	const k = p0.x * std.saturate(2 - p0.x) * notDown * coverage;
	const wetRoughness =
		(1 - std.mix(smoothness, wetSmoothness, k)) *
		std.mix(1, 0.1, std.max(standing, std.smoothstep(0, 0.05, flowWet)));
	s.normal = d.vec3f(outNormal);
	s.roughness = std.mix(s.roughness, wetRoughness, coverage);
	s.albedo = std.mul(s.albedo, std.mix(1, darken, coverage));
	return Surface(s);
});

const multiBounceRgb = tgpu.fn(
	[d.f32, d.vec3f],
	d.vec3f,
)((ao, albedo) => {
	'use gpu';
	const a = std.sub(std.mul(2.0404, albedo), d.vec3f(0.3324));
	const b = std.add(std.mul(-4.7951, albedo), d.vec3f(0.6417));
	const c = std.add(std.mul(2.7552, albedo), d.vec3f(0.6903));
	return std.max(d.vec3f(ao), std.mul(std.add(std.mul(std.add(std.mul(a, ao), b), ao), c), ao));
});

/** fragment entrypoint evaluating deferred lighting into `scene.lit` */
export const fsDeferredLighting = tgpu.fragmentFn({
	in: {
		position: d.builtin.position,
		uv: d.vec2f,
	},
	out: d.vec4f,
})((input) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const post = postUniformLayout.$.post;
	const px = d.vec2i(input.position.xy);
	const depth = std.textureLoad(deferredInputsLayout.$.gbDepth, px, 0);
	const ray = viewRay(input.uv);
	const rel = std.mul(ray, viewDepth(std.max(depth, 1e-6)));
	// derivatives must be evaluated in uniform control flow, before the sky discard / unlit early return
	const geoN = std.cross(std.dpdxFine(rel), std.dpdyFine(rel));
	if (depth <= 0) {
		std.discard();
	}
	const em = std.textureLoad(deferredInputsLayout.$.gbEmission, px, 0);
	const ga = std.textureLoad(deferredInputsLayout.$.gbA, px, 0);
	const gb = std.textureLoad(deferredInputsLayout.$.gbB, px, 0);
	const gc = std.textureLoad(deferredInputsLayout.$.gbC, px, 0);
	const unpacked = unpackGbuffer(em, ga, gb, gc);
	if (unpacked.model === SHADING_UNLIT) {
		return d.vec4f(em.xyz, 1);
	}

	const s = applyRainWetness(unpacked.surface, rel, geoN, unpacked.porosity);
	const w = std.textureLoad(deferredInputsLayout.$.wetnessTexture, px, 0).x;
	if (w > 0) {
		const porosity = unpacked.porosity;
		const w2 = w * w;
		s.albedo = std.mul(s.albedo, 1 - porosity * w2);
		s.roughness = std.mix(s.roughness, std.min(1 - porosity * w, s.roughness), w2);
	}

	const n = s.normal;
	const v = std.neg(std.normalize(rel));
	const l = frame.sun.xyz;
	const nDotV = std.clamp(std.abs(std.dot(n, v)), 1e-4, 1);
	const nDotL = std.clamp(std.dot(n, l), 0, 1);
	const roughness = std.clamp(s.roughness, 0.045, 1);
	const a = roughness * roughness;
	const a2 = a * a;
	const diffuseColor = std.mul(s.albedo, 1 - s.metallic);
	const f0 = std.mix(d.vec3f(s.f0), s.albedo, s.metallic);

	const debugView = frame.flags.y;
	if (debugView === d.u32(1)) {
		return d.vec4f(s.albedo, 1);
	}
	if (debugView === d.u32(2)) {
		return d.vec4f(std.add(std.mul(n, 0.5), d.vec3f(0.5)), 1);
	}
	if (debugView === d.u32(3)) {
		return d.vec4f(d.vec3f(roughness), 1);
	}
	if (debugView === d.u32(6)) {
		return d.vec4f(d.vec3f(std.dot(s.albedo, LUMINANCE_ROUNDED.$)), 1);
	}

	const worldPos = std.add(frame.eye.xyz, rel);
	const irradiance = ambientIrradiance(worldPos, n);
	const diffuseAmbient = std.mul(
		std.add(diffuseColor, std.mul(s.scatter.xyz, s.scatterIndirect)),
		irradiance,
	);
	const useAo = post.ao.w > 0.5;
	const gtao = std.select(d.f32(1), std.textureLoad(deferredInputsLayout.$.aoTexture, px, 0).x, useAo);
	const ao = std.min(gtao, s.occlusion);
	const diffuseAo = std.select(d.vec3f(s.occlusion), multiBounceRgb(ao, diffuseColor), useAo);
	const specularOcclusion = std.clamp(std.pow(nDotV + ao, std.exp2(-16 * roughness - 1)) - 1 + ao, 0, 1);
	const ssrWeight = std.mul(environmentBrdf(f0, roughness, nDotV), specularOcclusion);
	const r = std.normalize(std.mix(std.reflect(std.neg(v), n), n, roughness * roughness));
	const skySpec = std.mul(
		sampleReflection(worldPos, n, r, roughness, irradiance),
		std.mul(ssrWeight, frame.ambient.x),
	);
	let specularAmbient = d.vec3f(skySpec);
	if (post.reflections.x > 0.5) {
		const ssr = std.textureSampleLevel(
			deferredInputsLayout.$.ssrTexture,
			deferredInputsLayout.$.linearSampler,
			input.uv,
			0,
		);
		specularAmbient = std.mix(skySpec, std.mul(ssr.xyz, ssrWeight), ssr.w);
	}
	const ambient = std.add(std.mul(diffuseAmbient, diffuseAo), specularAmbient);
	if (debugView === d.u32(4)) {
		return d.vec4f(ambient, 1);
	}

	let direct = d.vec3f(0);
	if (s.foliage) {
		direct = std.mul(
			std.mul(foliageSun(s, n, v, l, a2, f0, diffuseColor), frame.sunColor.xyz),
			std.mul(sunVisibility(rel, n, input.position.xy), frame.sun.w),
		);
	} else {
		const h = std.normalize(std.add(l, v));
		const nDotH = std.clamp(std.dot(n, h), 0, 1);
		const vDotH = std.clamp(std.dot(v, h), 0, 1);
		const f = fresnelSchlick(f0, vDotH);
		const specular = std.mul(
			f,
			ggxDistribution(nDotH, a2) * smithVisibility(nDotV, nDotL, a2) * frame.sunColor.w,
		);
		const diffuse = std.mul(std.div(diffuseColor, Math.PI), std.sub(d.vec3f(1), f));
		direct = std.mul(std.add(diffuse, specular), nDotL);
		const scatters = s.scatter.w > 0;
		if (scatters) {
			direct = std.add(direct, std.div(subsurfaceSun(s.scatter, n, v, l), Math.PI));
		}
		let visibility = d.vec3f(0);
		if (nDotL > 0 || scatters) {
			visibility = sunVisibility(rel, n, input.position.xy);
		}
		direct = std.mul(direct, std.mul(std.mul(frame.sunColor.xyz, visibility), frame.sun.w));
	}
	direct = std.add(direct, localLighting(s, v, rel, input.position.xy, diffuseColor, f0, roughness));
	return d.vec4f(std.max(std.add(std.add(direct, ambient), s.emission), d.vec3f(0)), 1);
});
