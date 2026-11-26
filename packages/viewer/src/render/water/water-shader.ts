/**
 * open-world water shaders: vertex projection and normal decoding, nearest-surface depth prepass, and full
 * water shading (dual-layer flow/sector-atlas wave normals, foam + foam boxes, refracted ground and caustics,
 * sun highlight + subsurface foam, screen-space reflection march with previous-frame reprojection, local
 * reflection probes / sky fallback, water-column absorption/scattering, and atmospheric/volumetric fog).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout, hue } from '../core/frame-core.ts';
import { postUniformLayout, viewDepth, viewRay } from '../core/post-schema.ts';
import { ssrDeviceDepth, ssrFade, ssrMarchRay, ssrProject } from '../core/screen-space.ts';
import { fresnelSchlick, octDecode, henyeyGreenstein } from '../core/shader-math.ts';
import {
	ambientIrradiance,
	environmentBrdfTerms,
	sampleReflection,
} from '../lighting/shaders/ambient-probes.ts';
import { sunVisibility } from '../lighting/shaders/sun-shadow.ts';
import { rayleighPhase, skyReadLayout } from '../sky/atmosphere-shader.ts';
import { fogOver, froxelsAt } from '../sky/fog-shader.ts';

/** GPU schema of one water surface instance */
export const WaterSurfaceSchema = d.struct({
	t0: d.vec4f,
	t1: d.vec4f,
	t2: d.vec4f,
	offset: d.vec4f,
	scale: d.vec4f,
});

/** float count per {@link WaterSurfaceSchema} */
export const WATER_SURFACE_FLOATS = d.sizeOf(WaterSurfaceSchema) / 4;

/** GPU schema of one water look configuration */
export const WaterConfigSchema = d.struct({
	scattering: d.vec4f,
	absorptionDeep: d.vec4f,
	absorptionShallow: d.vec4f,
	optics: d.vec4f,
	surface: d.vec4f,
	small: d.vec4f,
	large: d.vec4f,
	flow: d.vec4f,
	layers: d.vec4f,
	fade: d.vec4f,
	foam: d.vec4f,
	foamShape: d.vec4f,
	caustics: d.vec4f,
	causticDepths: d.vec4f,
});

/** float count per {@link WaterConfigSchema} */
export const WATER_CONFIG_FLOATS = d.sizeOf(WaterConfigSchema) / 4;

/** group 2 bind group layout for the water depth and shading passes */
export const waterLayout = tgpu
	.bindGroupLayout({
		surfaces: { storage: d.arrayOf(WaterSurfaceSchema), access: 'readonly' },
		configs: { storage: d.arrayOf(WaterConfigSchema), access: 'readonly' },
		background: { texture: d.texture2d(d.f32) },
		depthTexture: { texture: d.textureDepth2d() },
		waveNormals: { texture: d.texture2dArray(d.f32) },
		flowMap: { texture: d.texture2d(d.f32) },
		repeatSampler: { sampler: 'filtering' },
		water: { uniform: d.arrayOf(d.vec4f, 9) },
		causticMap: { texture: d.texture2d(d.f32) },
		foamTexture: { texture: d.texture2d(d.f32) },
		reflectionScene: { texture: d.texture2d(d.f32) },
		clampSampler: { sampler: 'filtering' },
		waterDepthTexture: { texture: d.textureDepth2d() },
		sectorFlow: { texture: d.texture2d(d.f32) },
	})
	.$idx(2);

const SSR_STEPS = 32;
const SSR_FADE_ON_SCREEN = 0.1;
const SSR_FADE_MIRROR_MUL = 2;
const SSR_FADE_MIRROR_ADD = -1;

const SsrHit = d.struct({
	uv: d.vec2f,
	confidence: d.f32,
});

const ssrTrace = tgpu.fn(
	[d.vec3f, d.vec3f, d.vec3f, d.vec2f],
	SsrHit,
)((startRel, r, n, px) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const eye = std.dot(startRel, post.forward.xyz);
	const endRel = std.add(startRel, std.mul(r, eye));
	if (std.dot(endRel, post.forward.xyz) <= post.forward.w) {
		return SsrHit({ uv: d.vec2f(0), confidence: 0 });
	}
	const start = ssrProject(startRel);
	const end = ssrProject(endRel);
	const march = ssrMarchRay(waterLayout.$.depthTexture, start, end, SSR_STEPS, post.viewport.xy, px);
	if (!march.hit) {
		return SsrHit({ uv: d.vec2f(0), confidence: 0 });
	}
	const v = std.normalize(startRel);
	return SsrHit({
		uv: d.vec2f(march.position.xy),
		confidence: ssrFade(
			march.position.xy,
			n,
			v,
			SSR_FADE_ON_SCREEN,
			SSR_FADE_MIRROR_MUL,
			SSR_FADE_MIRROR_ADD,
		),
	});
});

const waterMiePhase = tgpu.fn(
	[d.f32],
	d.f32,
)((cosTheta) => {
	'use gpu';
	return henyeyGreenstein(0.854, cosTheta);
});

const waterEnvironmentBrdf = tgpu.fn(
	[d.f32, d.f32, d.f32, d.f32],
	d.f32,
)((f0, f90, roughness, nDotV) => {
	'use gpu';
	const ab = environmentBrdfTerms(roughness, nDotV);
	return std.clamp(f0 * ab.x + f90 * ab.y, 0, 1);
});

const rgbToHsv = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((c) => {
	'use gpu';
	const p = std.select(d.vec4f(c.z, c.y, -1, 2 / 3), d.vec4f(c.y, c.z, 0, -1 / 3), c.z <= c.y);
	const q = std.select(d.vec4f(p.x, p.y, p.w, c.x), d.vec4f(c.x, p.y, p.z, p.x), p.x <= c.x);
	const diff = q.x - std.min(q.w, q.y);
	return d.vec3f(std.abs(q.z + (q.w - q.y) / (6 * diff + 1e-4)), diff / (q.x + 1e-4), q.x);
});

const WaterVertexOut = {
	position: d.builtin.position,
	rel: d.vec3f,
	normal: d.vec3f,
	config: d.interpolate('flat', d.u32),
	mirrored: d.interpolate('flat', d.u32),
};

/** vertex entrypoint projecting water surface geometry using the post camera */
export const vsWater = tgpu.vertexFn({
	in: {
		position: d.location(0, d.vec4f),
		normal: d.location(1, d.vec2f),
		ii: d.builtin.instanceIndex,
	},
	out: WaterVertexOut,
})((input) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const s = waterLayout.$.surfaces[input.ii];
	const p = std.add(s.offset.xyz, std.mul(input.position.xyz, s.scale.xyz));
	const rel = d.vec3f(
		std.dot(s.t0.xyz, p) + s.t0.w,
		std.dot(s.t1.xyz, p) + s.t1.w,
		std.dot(s.t2.xyz, p) + s.t2.w,
	);
	const z = std.dot(rel, post.forward.xyz);
	const right = std.div(post.right.xyz, std.dot(post.right.xyz, post.right.xyz));
	const up = std.div(post.up.xyz, std.dot(post.up.xyz, post.up.xyz));
	const clipXy = std.add(d.vec2f(std.dot(rel, right), std.dot(rel, up)), std.mul(post.jitter.xy, z));
	let n = d.vec3f(0, 1, 0);
	if (s.scale.w > 0.5) {
		const m = octDecode(input.normal);
		n = d.vec3f(std.dot(s.t0.xyz, m), std.dot(s.t1.xyz, m), std.dot(s.t2.xyz, m));
	}
	return {
		position: d.vec4f(clipXy, post.forward.w, z),
		rel,
		normal: n,
		config: std.bitcast(d.f32, d.u32)(s.offset.w),
		mirrored: std.select(d.u32(0), d.u32(1), std.dot(std.cross(s.t0.xyz, s.t1.xyz), s.t2.xyz) < 0),
	};
});

/** fragment entrypoint writing the nearest visible water surface's depth */
export const fsWaterDepth = tgpu.fragmentFn({
	in: {
		...WaterVertexOut,
		front: d.builtin.frontFacing,
	},
	out: d.Void,
})((input) => {
	'use gpu';
	if (input.front === (input.mirrored !== d.u32(0))) {
		std.discard();
	}
	const size = d.vec2f(std.textureDimensions(waterLayout.$.background));
	const depth = std.textureLoad(waterLayout.$.depthTexture, d.vec2i(input.position.xy), 0);
	if (
		depth > 0 &&
		std.length(std.mul(viewRay(std.div(input.position.xy, size)), viewDepth(depth))) <
			std.length(input.rel) - 0.02
	) {
		std.discard();
	}
});

const WaveTaps = d.struct({
	uv: d.vec4f,
	weights: d.vec2f,
});

const waveTaps = tgpu.fn(
	[d.vec2f, d.vec2f, d.f32, d.f32, d.f32, d.bool],
	WaveTaps,
)((p, velocity, tiling, cycle, progress, flowing) => {
	'use gpu';
	if (!flowing) {
		return WaveTaps({
			uv: d.vec4f(std.mul(std.sub(p, std.mul(velocity, progress)), tiling), 0, 0),
			weights: d.vec2f(1, 0),
		});
	}
	const a = std.fract(progress);
	const b = std.fract(progress + 0.5);
	const uvA = std.add(std.mul(std.sub(p, std.mul(velocity, a)), tiling), d.vec2f((progress - a) * cycle));
	const uvB = std.add(
		std.mul(std.sub(p, std.mul(velocity, b)), tiling),
		d.vec2f(0.5 + (progress - b) * cycle),
	);
	return WaveTaps({
		uv: d.vec4f(uvA, uvB),
		weights: d.vec2f(1 - std.abs(1 - 2 * a), 1 - std.abs(1 - 2 * b)),
	});
});

const waveNormal = tgpu.fn(
	[d.vec2f, d.f32],
	d.vec3f,
)((rg, strength) => {
	'use gpu';
	const xy = std.sub(std.mul(rg, 2), d.vec2f(1));
	return d.vec3f(std.mul(xy, strength), std.max(1e-16, std.sqrt(1 - std.clamp(std.dot(xy, xy), 0, 1))));
});

const columnInscatter = tgpu.fn(
	[d.vec3f, d.f32],
	d.vec3f,
)((extinction, depth) => {
	'use gpu';
	return std.div(std.sub(d.vec3f(1), std.exp(std.mul(std.neg(extinction), depth))), extinction);
});

/** fragment entrypoint shading water surfaces over the composited HDR scene */
export const fsWater = tgpu.fragmentFn({
	in: {
		...WaterVertexOut,
		front: d.builtin.frontFacing,
	},
	out: d.vec4f,
})((input) => {
	'use gpu';
	if (input.front === (input.mirrored !== d.u32(0))) {
		std.discard();
	}
	const frame = frameLayout.$.frame;
	const post = postUniformLayout.$.post;
	const water = waterLayout.$.water;
	const c = waterLayout.$.configs[input.config];
	const px = d.vec2i(input.position.xy);
	const size = d.vec2f(std.textureDimensions(waterLayout.$.background));
	const world = std.add(input.rel, post.eye.xyz);
	const surfaceDistance = std.length(input.rel);
	const v = std.div(std.neg(input.rel), surfaceDistance);
	const nGeo = std.normalize(input.normal);
	const geoNDotV = std.dot(v, nGeo);
	const time = post.up.w;
	const near = std.max(
		0,
		1 - std.clamp((surfaceDistance * std.clamp(1 - geoNDotV, 0, 1)) / std.max(c.fade.x, 1e-4), 0, 1),
	);

	let flow = d.vec4f(0.5, 0.5, 0, 1);
	{
		const q = std.sub(world.xz, water[1].xy);
		const uv = std.add(std.div(q, std.max(water[0].z, 1)), d.vec2f(0.5));
		const sampled = std.textureSampleLevel(waterLayout.$.flowMap, waterLayout.$.repeatSampler, uv, 0);
		flow = std.select(flow, sampled, water[0].y > 0.5);
		const sectorMask = std.bitcast(d.f32, d.u32)(water[8].w);
		if (sectorMask !== d.u32(0)) {
			const local = std.div(std.sub(q, water[8].xy), std.max(water[8].z, 1));
			if (std.all(std.ge(local, d.vec2f(0))) && std.all(std.lt(local, d.vec2f(3)))) {
				const cell = d.vec2u(std.floor(local));
				const bit = d.u32(1) << (cell.y * d.u32(3) + cell.x);
				if ((sectorMask & bit) !== d.u32(0)) {
					const inset = 0.5 / std.max(water[1].w, 1);
					const hasXm =
						cell.x > d.u32(0) &&
						(sectorMask & (d.u32(1) << (cell.y * d.u32(3) + cell.x - d.u32(1)))) !== d.u32(0);
					const hasXp =
						cell.x < d.u32(2) &&
						(sectorMask & (d.u32(1) << (cell.y * d.u32(3) + cell.x + d.u32(1)))) !== d.u32(0);
					const hasZm =
						cell.y > d.u32(0) &&
						(sectorMask & (d.u32(1) << ((cell.y - d.u32(1)) * d.u32(3) + cell.x))) !== d.u32(0);
					const hasZp =
						cell.y < d.u32(2) &&
						(sectorMask & (d.u32(1) << ((cell.y + d.u32(1)) * d.u32(3) + cell.x))) !== d.u32(0);
					const cellF = d.vec2f(cell);
					const lo = std.add(
						cellF,
						d.vec2f(std.select(inset, d.f32(0), hasXm), std.select(inset, d.f32(0), hasZm)),
					);
					const hi = std.sub(
						std.add(cellF, d.vec2f(1)),
						d.vec2f(std.select(inset, d.f32(0), hasXp), std.select(inset, d.f32(0), hasZp)),
					);
					const sUv = std.div(std.clamp(local, lo, hi), 3);
					const sector = std.textureSampleLevel(waterLayout.$.sectorFlow, waterLayout.$.clampSampler, sUv, 0);
					const edge = std.max(std.abs(local.x / 3 - 0.5), std.abs(local.y / 3 - 0.5)) * 2;
					flow = std.mix(sector, flow, std.clamp((edge - 0.9) * 10, 0, 1));
				}
			}
		}
	}

	const amplitude = std.select(flow.w, d.f32(1), c.flow.w === 1);
	const direction = std.mul(
		std.sub(std.mul(std.mix(c.flow.xy, flow.xy, c.flow.z), 2), d.vec2f(1)),
		d.vec2f(1, -1),
	);
	const flowing = c.flow.z > 0;
	const bias = c.fade.z;

	const smallTaps = waveTaps(
		world.xz,
		std.mul(direction, c.small.x),
		c.small.y,
		c.small.w,
		time * c.small.w,
		flowing,
	);
	const largeTaps = waveTaps(
		world.xz,
		std.mul(direction, c.large.x),
		c.large.y,
		c.large.w,
		time * c.large.w + 0.5,
		flowing,
	);
	const smallLayer = d.i32(c.layers.x);
	const largeLayer = d.i32(c.layers.y);
	const small = std.add(
		std.mul(
			std.textureSampleBias(
				waterLayout.$.waveNormals,
				waterLayout.$.repeatSampler,
				smallTaps.uv.xy,
				smallLayer,
				bias,
			),
			smallTaps.weights.x,
		),
		std.mul(
			std.textureSampleBias(
				waterLayout.$.waveNormals,
				waterLayout.$.repeatSampler,
				smallTaps.uv.zw,
				smallLayer,
				bias,
			),
			smallTaps.weights.y,
		),
	);
	const large = std.add(
		std.mul(
			std.textureSampleBias(
				waterLayout.$.waveNormals,
				waterLayout.$.repeatSampler,
				largeTaps.uv.xy,
				largeLayer,
				bias,
			),
			largeTaps.weights.x,
		),
		std.mul(
			std.textureSampleBias(
				waterLayout.$.waveNormals,
				waterLayout.$.repeatSampler,
				largeTaps.uv.zw,
				largeLayer,
				bias,
			),
			largeTaps.weights.y,
		),
	);

	let n = d.vec3f(nGeo);
	if (water[0].x > 0.5) {
		const t = std.add(waveNormal(small.xy, c.small.z * near * amplitude * geoNDotV), d.vec3f(0, 0, 1));
		const u = std.mul(
			waveNormal(large.xy, c.large.z * amplitude * std.max(c.fade.y, near)),
			d.vec3f(-1, -1, 1),
		);
		const m = std.normalize(std.sub(std.div(std.mul(t, std.dot(t, u)), std.max(t.z, 1e-5)), u));
		const tangent = d.vec3f(1, 0, 0);
		n = std.normalize(
			std.add(std.add(std.mul(tangent, m.x), std.mul(std.cross(tangent, nGeo), m.y)), std.mul(nGeo, m.z)),
		);
	}

	const foam =
		flow.z *
		std.clamp(small.w - c.foamShape.x, 0, 1) *
		c.foam.w *
		(1 - std.clamp(surfaceDistance * c.foamShape.y, 0, 1)) *
		std.max(0.5, std.clamp(geoNDotV, 0, 1));
	let foamAlbedo = std.mul(c.foam.xyz, foam);
	if (water[1].z > 0.5) {
		const boxes = std.textureLoad(waterLayout.$.foamTexture, px, 0);
		foamAlbedo = std.add(boxes.xyz, std.mul(std.saturate(foamAlbedo), boxes.w));
	}
	foamAlbedo = std.saturate(foamAlbedo);
	const roughness = std.clamp(std.mix(std.mix(c.surface.x, 0.01, near), c.fade.w, foam), 0, 1);

	const uvStraight = std.div(input.position.xy, size);
	let groundStraight = d.f32(100000);
	{
		const depth = std.textureLoad(waterLayout.$.depthTexture, px, 0);
		if (depth > 0) {
			groundStraight = std.length(std.mul(viewRay(uvStraight), viewDepth(depth)));
		}
	}
	const straight = std.max(groundStraight - surfaceDistance, 0);
	let uv = d.vec2f(uvStraight);
	let groundRel = std.sub(input.rel, std.mul(v, straight));
	let groundV = d.vec3f(v);
	let thickness = straight;
	{
		const ndc = std.sub(std.mul(uvStraight, 2), d.vec2f(1));
		const edge = std.min(1 - std.abs(ndc.x), 1 - std.abs(ndc.y));
		const k = std.mix(
			std.clamp((0.2 - edge) * 5, 0, 1),
			std.clamp(1.25 - edge, 0, 1),
			1 - std.clamp((surfaceDistance - 0.75) * 4, 0, 1),
		);
		const bent = std.mix(
			std.normalize(d.vec3f(n.x * c.surface.z, n.y, n.z * c.surface.z)),
			d.vec3f(0, 1, 0),
			k,
		);
		const pushed = std.add(input.rel, std.mul(std.mul(bent, d.vec3f(-1, 0, -1)), std.min(straight, 0.5)));
		const projected = std.clamp(ssrProject(pushed).xy, d.vec2f(0), std.sub(d.vec2f(1), post.viewport.zw));
		const depth = ssrDeviceDepth(waterLayout.$.depthTexture, projected);
		let refracted = std.mul(viewRay(projected), 100000);
		if (depth > 0) {
			refracted = std.mul(viewRay(projected), viewDepth(depth));
		}
		if (std.dot(std.sub(refracted, input.rel), v) <= 0) {
			const along = std.select(d.f32(1000), std.length(std.sub(refracted, input.rel)), depth > 0);
			uv = d.vec2f(projected);
			groundRel = d.vec3f(refracted);
			groundV = std.normalize(std.neg(refracted));
			thickness = std.mix(
				along,
				std.mix(straight, along, std.clamp(straight - 0.5, 0, 1)),
				std.clamp(surfaceDistance - 20, 0, 1),
			);
		}
	}
	thickness = std.min(thickness, 10000);

	let caustics = d.vec3f(0);
	{
		const k = 0.02 / std.max(c.caustics.x, 1e-4);
		const distort = std.mul(n.xz, c.caustics.z * 20 * k);
		const scroll = d.vec2f(time * 0.05 * k * c.caustics.w);
		const p = std.mul(std.add(groundRel.xz, post.eye.xz), c.caustics.x);
		const a = std.textureSample(
			waterLayout.$.causticMap,
			waterLayout.$.repeatSampler,
			std.add(std.add(p, distort), scroll),
		).xyz;
		const b = std.textureSample(
			waterLayout.$.causticMap,
			waterLayout.$.repeatSampler,
			std.add(std.sub(std.mul(p, d.vec2f(1, -1)), distort), scroll),
		).xyz;
		const viewZ = surfaceDistance * std.dot(std.neg(v), post.forward.xyz);
		const causticWeight =
			frame.sun.w *
			c.caustics.y *
			std.clamp(thickness - c.causticDepths.x, 0, 1) *
			(1 - std.clamp(viewZ * 0.02, 0, 1)) *
			(1 - std.clamp(thickness - c.causticDepths.y, 0, 1)) *
			water[0].w;
		caustics = std.mul(
			std.mul(std.add(std.max(a, b), std.mul(std.mul(a, b), 100)), water[2].xyz),
			causticWeight,
		);
	}

	if (groundStraight < surfaceDistance - 0.02) {
		std.discard();
	}
	if (input.position.z < std.textureLoad(waterLayout.$.waterDepthTexture, px, 0) * 0.9999) {
		std.discard();
	}

	const froxels = froxelsAt(
		skyReadLayout.$.froxels,
		skyReadLayout.$.lutSampler,
		uvStraight,
		surfaceDistance * std.dot(std.neg(v), post.forward.xyz),
	);
	const fog = fogOver(std.neg(v), surfaceDistance, froxels);
	const behindPx = d.vec2i(std.mul(uv, size));
	const behindRaw = std.textureLoad(waterLayout.$.background, behindPx, 0).xyz;
	const behind = std.mul(behindRaw, std.add(d.vec3f(1), std.mul(caustics, fog.transmittance)));

	const l = frame.sun.xyz;
	const visibility = std.mul(
		sunVisibility(std.add(input.rel, std.mul(d.vec3f(n.x, 0, n.z), 2)), nGeo, input.position.xy),
		frame.sun.w,
	);
	const irradiance = ambientIrradiance(world, n);

	let direct = d.vec3f(0);
	{
		const ns = std.normalize(d.vec3f(n.x, n.y * c.layers.z, n.z));
		const hRaw = std.add(l, v);
		const h = std.mul(hRaw, std.inverseSqrt(std.max(6.1e-5, std.dot(hRaw, hRaw))));
		const nDotL = std.clamp(std.dot(l, ns), 0, 1);
		const nDotH = std.clamp(std.dot(ns, h), 0, 1);
		const nDotV = std.clamp(std.dot(ns, v), 0, 1);
		const a = roughness * roughness;
		const a2 = a * a;
		const dd = (nDotH * a2 - nDotH) * nDotH + 1;
		const f0 = 0.08 * c.surface.y;
		const fresnel = fresnelSchlick(d.vec3f(f0), std.clamp(std.dot(v, h), 0, 1));
		const visible =
			0.5 /
			(nDotL * std.sqrt((-nDotV * a2 + nDotV) * nDotV + a2) +
				nDotV * std.sqrt((-nDotL * a2 + nDotL) * nDotL + a2) +
				1e-4);
		const specular = std.mul(
			std.clamp(
				std.mul(std.min(std.mul(fresnel, (a2 / (dd * dd)) * visible), d.vec3f(2048)), frame.sunColor.w),
				d.vec3f(0),
				d.vec3f(1000),
			),
			nDotL,
		);
		const hsv = rgbToHsv(foamAlbedo);
		const value = hsv.z * c.foamShape.z;
		const k = std.clamp(1 - value, 0, 1);
		const wrap = std.clamp(std.dot(ns, l) * (2 / 3) + 1 / 3, 0, 1);
		const through = std.mix(
			std.mix(1, wrap * std.sqrt(wrap) * (5 / 3), k) / (2 * Math.PI),
			1,
			std.pow(std.clamp(-std.dot(v, l), 0, 1), 12) * std.mix(3, 0.1, k),
		);
		const subsurface = std.mul(std.mix(d.vec3f(1), hue(hsv.x), hsv.y), value * through);
		direct = std.mul(
			std.div(
				std.mul(std.add(std.add(specular, subsurface), std.mul(foamAlbedo, nDotL)), frame.sunColor.xyz),
				Math.PI,
			),
			visibility,
		);
	}

	const nDotV = std.clamp(std.dot(n, v), 0, 1);
	const r = std.reflect(std.neg(v), n);
	const sky = std.mul(
		sampleReflection(std.add(frame.eye.xyz, input.rel), n, r, roughness, irradiance),
		c.surface.w,
	);
	let reflection = d.vec3f(sky);
	let found = d.f32(0);
	if (post.reflections.x > 0.5) {
		const hit = ssrTrace(input.rel, r, n, input.position.xy);
		if (hit.confidence > 0) {
			let reflected = std.textureLoad(waterLayout.$.background, d.vec2i(std.mul(hit.uv, size)), 0).xyz;
			if (water[7].w < 0.5) {
				const hitDepth = ssrDeviceDepth(waterLayout.$.depthTexture, hit.uv);
				let prevUv = d.vec2f(hit.uv);
				if (hitDepth > 0) {
					const hitRel = std.mul(viewRay(hit.uv), viewDepth(hitDepth));
					const prevVp = d.mat4x4f(water[3], water[4], water[5], water[6]);
					const clip = std.mul(prevVp, d.vec4f(std.add(hitRel, water[7].xyz), 1));
					if (clip.w > 0) {
						const ndc = std.div(clip.xy, clip.w);
						prevUv = d.vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
					}
				}
				if (std.all(std.ge(prevUv, d.vec2f(0))) && std.all(std.le(prevUv, d.vec2f(1)))) {
					reflected = std.textureSampleLevel(
						waterLayout.$.reflectionScene,
						waterLayout.$.clampSampler,
						prevUv,
						0,
					).xyz;
				}
			}
			reflection = std.mix(sky, reflected, hit.confidence);
			found = hit.confidence;
		}
	}
	const specularWeight = waterEnvironmentBrdf(
		0.08 * c.surface.y,
		std.clamp(4 * c.surface.y, 0, 1),
		roughness,
		nDotV,
	);

	const depth = std.min(thickness, 50);
	const extinction = std.max(
		std.add(
			c.scattering.xyz,
			std.mix(
				c.absorptionShallow.xyz,
				c.absorptionDeep.xyz,
				std.clamp(depth / std.max(c.optics.x, 0.01), 0, 1),
			),
		),
		d.vec3f(1e-4),
	);
	const transmittance = std.exp(std.mul(std.neg(extinction), depth));
	const feed = std.mul(behind, c.layers.w);
	const ambientIn = std.mul(
		std.mul(columnInscatter(std.mul(extinction, 1 + std.abs(v.y) * 1.394), depth), std.add(irradiance, feed)),
		0.717 * c.optics.y,
	);
	const cosTheta = std.dot(std.neg(groundV), l);
	const phase = std.mix(waterMiePhase(cosTheta), rayleighPhase(cosTheta), c.optics.w);
	const slant = 1 - std.dot(l, n);
	const entry = std.max(std.abs(0.98 - 0.98 * slant * slant * slant * slant * slant), 0.1);
	const sunExtinction = std.mul(extinction, 1 + std.abs(v.y / std.max(0.05, -l.y)));
	const sunIn = std.mul(
		std.mul(
			std.mul(columnInscatter(sunExtinction, depth), std.mul(water[2].xyz, phase * frame.sun.w * entry)),
			std.add(d.vec3f(1), feed),
		),
		visibility,
	);
	const inscatter = std.mul(c.scattering.xyz, std.add(ambientIn, sunIn));

	const own = std.add(
		std.add(std.add(direct, std.mul(reflection, specularWeight)), std.mul(irradiance, foamAlbedo)),
		inscatter,
	);
	let color = std.add(
		std.add(std.mul(own, fog.transmittance), std.mul(behind, transmittance)),
		std.mul(fog.inscatter, std.sub(d.vec3f(1), transmittance)),
	);
	color = std.mix(
		color,
		reflection,
		std.mul(std.mul(std.sub(d.vec3f(1), transmittance), specularWeight * found), fog.transmittance),
	);
	color = std.add(color, std.mul(std.mul(c.foam.xyz, c.foamShape.w), foamAlbedo));
	const edge = thickness * std.mix(1, std.abs(std.dot(v, n)), std.clamp(surfaceDistance * 0.05, 0, 1));
	return d.vec4f(std.mix(behind, color, std.clamp(edge * c.optics.z, 0, 1)), 1);
});
