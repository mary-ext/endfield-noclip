/**
 * TypeGPU frame bind group layout (group 0) and core shader helpers shared by geometry, deferred lighting,
 * and forward passes: `Surface`, G-buffer packing/unpacking, mip feedback, dynamic velocity, and instance-row
 * decoding.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { BLOCK_SLOT_BITS } from '../../content/instance-rows.ts';

import { FrameSchema } from './frame-schema.ts';
import {
	GBUFFER_NO_LIT_DECALS,
	GBUFFER_VALID,
	SHADING_FOLIAGE,
	SHADING_LIT,
	SHADING_SUBSURFACE,
	SHADING_UNLIT,
	gbufferBNormal,
	gbufferShadingModel,
	packGbufferB,
} from './gbuffer.ts';
import { gradientNoise } from './shader-math.ts';

// #region group 0 layout

/**
 * group 0 bind group layout matching `createBindLayouts().frame` (bindings 0..16). shaders that only
 * reference `frameLayout.$.frame` emit only `@group(0) @binding(0)` and are compatible with
 * `BindLayouts.frameCore`.
 */
export const frameLayout = tgpu
	.bindGroupLayout({
		frame: { uniform: FrameSchema },
		shadowMap: { texture: d.textureDepth2dArray() },
		shadowSampler: { sampler: 'comparison' },
		reflectionMap: { texture: d.textureCube(d.f32) },
		reflectionSampler: { sampler: 'filtering' },
		irradianceA: { texture: d.texture3d(d.f32) },
		irradianceB: { texture: d.texture3d(d.f32) },
		irradianceRepeat: { sampler: 'filtering' },
		irradianceClamp: { sampler: 'filtering' },
		shadowGatherSampler: { sampler: 'non-filtering' },
		shadowRamp: { texture: d.texture2d(d.f32) },
		lights: { storage: d.arrayOf(d.vec4f), access: 'readonly' },
		lightBins: { storage: d.arrayOf(d.u32), access: 'readonly' },
		cloudShadowMap: { texture: d.texture2d(d.f32) },
		lightShadowMap: { texture: d.textureDepth2d() },
		reflectionProbesTex: { texture: d.textureCubeArray(d.f32) },
		reflectionProbes: { storage: d.arrayOf(d.vec4f), access: 'readonly' },
	})
	.$idx(0);

// #endregion

// #region g-buffer and surface structs

/** G-buffer outputs of the main geometry pass (`MAIN_TARGETS` in `render-targets.ts`) */
export const GBufferOut = d.struct({
	emission: d.location(0, d.vec4f),
	gbufferA: d.location(1, d.vec4f),
	gbufferB: d.location(2, d.vec4f),
	gbufferC: d.location(3, d.vec4f),
	mipFeedback: d.location(4, d.vec4u),
	velocity: d.location(5, d.vec4f),
});

/** surface parameters handed by a material family to deferred packing or forward lighting */
export const Surface = d.struct({
	albedo: d.vec3f,
	normal: d.vec3f,
	roughness: d.f32,
	metallic: d.f32,
	f0: d.f32,
	occlusion: d.f32,
	emission: d.vec3f,
	transmission: d.f32,
	foliage: d.bool,
	subsurface: d.f32,
	sunShadow: d.f32,
	sunNDotL: d.f32,
	scatter: d.vec4f,
	scatterIndirect: d.f32,
	porosity: d.f32,
});

/** unpacked G-buffer payload returned by {@link unpackGbuffer} */
export const UnpackedGBuffer = d.struct({
	model: d.u32,
	surface: Surface,
	porosity: d.f32,
});

/**
 * constructs a {@link Surface} with default PBR parameters.
 *
 * @param albedo base colour
 * @param normal world-space unit normal facing the viewer's side
 * @returns default surface
 */
export const defaultSurface = tgpu.fn(
	[d.vec3f, d.vec3f],
	Surface,
)((albedo, normal) => {
	'use gpu';
	return Surface({
		albedo: d.vec3f(albedo),
		normal: d.vec3f(normal),
		roughness: 0.85,
		metallic: 0,
		f0: 0.04,
		occlusion: 1,
		emission: d.vec3f(0),
		transmission: 0,
		foliage: false,
		subsurface: 0,
		sunShadow: 1,
		sunNDotL: -1,
		scatter: d.vec4f(0),
		scatterIndirect: 0,
		porosity: -1,
	});
});

/**
 * packs a lit {@link Surface} into the G-buffer (`GBufferOut`, 24 bytes/sample).
 *
 * @param s surface parameters
 * @param noLitDecals whether lit decals should skip this pixel
 * @param mipFeedback packed mip-feedback word
 * @returns G-buffer fragment outputs
 */
export const packGbuffer = tgpu.fn(
	[Surface, d.bool, d.u32],
	GBufferOut,
)((s, noLitDecals, mipFeedback) => {
	'use gpu';
	const flags = GBUFFER_VALID | std.select(d.u32(0), d.u32(GBUFFER_NO_LIT_DECALS), noLitDecals);
	const gbufferB = packGbufferB(s.normal, s.roughness, flags);
	if (s.foliage) {
		const sub = std.round(std.clamp(s.subsurface, 0, 1) * 127);
		const f0Code = std.round(std.clamp(s.f0 / 0.16, 0, 1) * 15);
		const nl = std.select(d.f32(0), (std.clamp(s.sunNDotL, 0, 1) * 1022 + 1) / 1023, s.sunNDotL >= 0);
		return GBufferOut({
			emission: d.vec4f(s.emission, sub + f0Code * 128),
			gbufferA: d.vec4f(
				std.clamp(s.transmission, 0, 1),
				std.clamp(s.sunShadow, 0, 1),
				nl,
				d.f32(SHADING_FOLIAGE) / 3,
			),
			gbufferB,
			gbufferC: d.vec4f(std.clamp(s.albedo, d.vec3f(0), d.vec3f(1)), std.clamp(s.occlusion, 0, 1)),
			mipFeedback: d.vec4u(mipFeedback, 0, 0, 0),
			velocity: d.vec4f(0),
		});
	}
	if (s.scatter.w > 0) {
		return GBufferOut({
			emission: d.vec4f(s.emission, s.scatterIndirect),
			gbufferA: d.vec4f(std.clamp(s.scatter.xyz, d.vec3f(0), d.vec3f(1)), d.f32(SHADING_SUBSURFACE) / 3),
			gbufferB,
			gbufferC: d.vec4f(std.clamp(s.albedo, d.vec3f(0), d.vec3f(1)), std.clamp(s.scatter.w, 0, 1)),
			mipFeedback: d.vec4u(mipFeedback, 0, 0, 0),
			velocity: d.vec4f(0),
		});
	}
	const porosity = std.select(s.porosity, std.saturate(0.2 * s.roughness + 0.4), s.porosity < 0);
	return GBufferOut({
		emission: d.vec4f(s.emission, s.f0),
		gbufferA: d.vec4f(
			std.clamp(s.metallic, 0, 1),
			std.clamp(s.occlusion, 0, 1),
			std.clamp(porosity, 0, 1),
			d.f32(SHADING_LIT) / 3,
		),
		gbufferB,
		gbufferC: d.vec4f(std.clamp(s.albedo, d.vec3f(0), d.vec3f(1)), 1),
		mipFeedback: d.vec4u(mipFeedback, 0, 0, 0),
		velocity: d.vec4f(0),
	});
});

/**
 * packs an unlit colour (matte paintings, debug overlays, opaque effects) into the G-buffer.
 *
 * @param color linear HDR unlit colour
 * @param mipFeedback packed mip-feedback word
 * @returns G-buffer fragment outputs
 */
export const packGbufferUnlit = tgpu.fn(
	[d.vec3f, d.u32],
	GBufferOut,
)((color, mipFeedback) => {
	'use gpu';
	return GBufferOut({
		emission: d.vec4f(color, 0),
		gbufferA: d.vec4f(0, 0, 0, d.f32(SHADING_UNLIT) / 3),
		gbufferB: d.vec4f(0),
		gbufferC: d.vec4f(0),
		mipFeedback: d.vec4u(mipFeedback, 0, 0, 0),
		velocity: d.vec4f(0),
	});
});

/**
 * unpacks the four G-buffer textures into a shading model, {@link Surface}, and wetness porosity.
 *
 * @param em emission texel
 * @param ga gbufferA texel
 * @param gb gbufferB texel
 * @param gc gbufferC texel
 * @returns unpacked G-buffer record
 */
export const unpackGbuffer = tgpu.fn(
	[d.vec4f, d.vec4f, d.vec4f, d.vec4f],
	UnpackedGBuffer,
)((em, ga, gb, gc) => {
	'use gpu';
	const model = gbufferShadingModel(ga);
	const s = defaultSurface(gc.xyz, gbufferBNormal(gb));
	s.roughness = gb.z;
	s.emission = d.vec3f(em.xyz);
	let porosity = std.saturate(0.2 * s.roughness + 0.4);
	if (model === SHADING_FOLIAGE) {
		s.foliage = true;
		s.transmission = ga.x;
		s.sunShadow = ga.y;
		const nlCode = std.round(ga.z * 1023);
		s.sunNDotL = std.select(d.f32(-1), (nlCode - 1) / 1022, nlCode >= 1);
		const packed = d.u32(std.max(std.round(em.w), 0));
		s.subsurface = d.f32(packed & 127) / 127;
		s.f0 = d.f32((packed >>> 7) & 15) * (0.16 / 15);
		s.occlusion = gc.w;
	} else if (model === SHADING_SUBSURFACE) {
		s.scatter = d.vec4f(ga.xyz, gc.w);
		s.scatterIndirect = em.w;
	} else if (model === SHADING_LIT) {
		s.metallic = ga.x;
		s.occlusion = ga.y;
		porosity = ga.z;
		s.f0 = em.w;
	}
	return UnpackedGBuffer({
		model,
		surface: Surface(s),
		porosity,
	});
});

// #endregion

// #region velocity and mip feedback

/**
 * dynamic screen-space velocity delta (`dyn_prev_uv - static_prev_uv`) for a vertex that moved between
 * frames; returns `(0, 0)` on static geometry or when there is no valid previous frame.
 *
 * @param currRel current camera-relative position
 * @param prevRel previous camera-relative position
 * @returns screen-space UV delta
 */
export const dynamicVelocity = tgpu.fn(
	[d.vec3f, d.vec3f],
	d.vec2f,
)((currRel, prevRel) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	if (frame.prevEyeDelta.w > 0.5 || std.allEq(currRel, prevRel)) {
		return d.vec2f(0);
	}
	const sClip = std.mul(frame.prevViewProj, d.vec4f(std.add(currRel, frame.prevEyeDelta.xyz), 1));
	const dClip = std.mul(frame.prevViewProj, d.vec4f(std.add(prevRel, frame.prevEyeDelta.xyz), 1));
	if (sClip.w <= 0 || dClip.w <= 0) {
		return d.vec2f(0);
	}
	const sNdc = std.div(sClip.xy, sClip.w);
	const dNdc = std.div(dClip.xy, dClip.w);
	const sUv = d.vec2f(sNdc.x * 0.5 + 0.5, 0.5 - sNdc.y * 0.5);
	const dUv = d.vec2f(dNdc.x * 0.5 + 0.5, 0.5 - dNdc.y * 0.5);
	return std.sub(dUv, sUv);
});

const MIP_FEEDBACK_STEPS = 126;
const MIP_FEEDBACK_SWATCH_METRES = 32768;

/**
 * packs a mesh pixel's texture-streaming mip feedback word. must be called in uniform control flow.
 *
 * @param look material slot in the look table
 * @param uv UV sets 0 (xy) and 1 (zw) before slot transforms
 * @param rel camera-relative surface position
 * @param bias mip bias applied when sampling textures
 * @returns packed `r32uint` mip-feedback word
 */
export const packMipFeedback = tgpu.fn(
	[d.u32, d.vec4f, d.vec3f, d.f32],
	d.u32,
)((look, uv, rel, bias) => {
	'use gpu';
	const dx = std.dpdx(uv);
	const dy = std.dpdy(uv);
	const px = std.dpdx(rel);
	const py = std.dpdy(rel);
	const squared = d.vec2f(
		std.max(std.dot(dx.xy, dx.xy), std.dot(dy.xy, dy.xy)),
		std.max(std.dot(dx.zw, dx.zw), std.dot(dy.zw, dy.zw)),
	);
	const metresSquared = std.max(std.dot(px, px), std.dot(py, py));
	const levels = std.neg(std.add(std.mul(0.5, std.log2(std.max(squared, d.vec2f(1e-30)))), d.vec2f(bias)));
	const steps = d.vec2u(std.clamp(std.ceil(std.mul(levels, 4)), d.vec2f(0), d.vec2f(MIP_FEEDBACK_STEPS)));
	const swatch = std.le(
		std.mul(squared, MIP_FEEDBACK_SWATCH_METRES * MIP_FEEDBACK_SWATCH_METRES),
		d.vec2f(metresSquared),
	);
	const q = std.select(steps, d.vec2u(0), swatch);
	return d.u32(0x80000000) | (look & d.u32(0x1ffff)) | (q.x << d.u32(17)) | (q.y << d.u32(24));
});

// #endregion

// #region math and instance rows

/**
 * smoothstep that also runs downhill (`low > high`), matching HLSL/GLSL.
 *
 * @param low lower edge
 * @param high upper edge
 * @param x input value
 * @returns Hermite-interpolated factor in `[0, 1]`
 */
export const hermite = tgpu.fn(
	[d.f32, d.f32, d.f32],
	d.f32,
)((low, high, x) => {
	'use gpu';
	const span = high - low;
	const t = std.saturate((x - low) / std.select(span, d.f32(1e-6), span === 0));
	return t * t * (3 - 2 * t);
});

/**
 * maps a scalar hue in `[0, 1]` to a saturated RGB colour.
 *
 * @param h hue in turns
 * @returns linear RGB colour
 */
export const hue = tgpu.fn(
	[d.f32],
	d.vec3f,
)((h) => {
	'use gpu';
	const k = d.vec3f(0, 2 / 3, 1 / 3);
	return std.clamp(
		std.sub(std.abs(std.sub(std.mul(std.fract(std.add(d.vec3f(h), k)), 6), d.vec3f(3))), d.vec3f(1)),
		d.vec3f(0),
		d.vec3f(1),
	);
});

/** GPU layout of an instance row (`ROW_WORDS` and `RowWord` in `instance-rows.ts`) */
export const InstanceRow = d.struct({
	t0: d.vec4f,
	t1: d.vec4f,
	t2: d.vec4f,
	center: d.vec3f,
	block: d.u32,
	extent: d.vec3f,
	info: d.u32,
	sheet: d.u32,
	color: d.u32,
	custom: d.vec2u,
});

/**
 * applies an instance row's texture-sheet flips and tile remapping to UV sets 0 and 1.
 *
 * @param sheet packed texture-sheet word
 * @param uv UV0 in xy, UV1 in zw
 * @returns remapped UV sets
 */
export const sheetUv = tgpu.fn(
	[d.u32, d.vec4f],
	d.vec4f,
)((sheet, uv) => {
	'use gpu';
	const flip = d.vec2b((sheet & (d.u32(1) << d.u32(26))) !== 0, (sheet & (d.u32(1) << d.u32(27))) !== 0);
	const u0 = std.select(uv.xy, std.sub(d.vec2f(1), uv.xy), flip);
	const u1 = std.select(uv.zw, std.sub(d.vec2f(1), uv.zw), flip);
	const tiles = d.vec2u((sheet & d.u32(63)) + d.u32(1), ((sheet >>> d.u32(6)) & d.u32(63)) + d.u32(1));
	const tile = (sheet >>> d.u32(12)) & d.u32(4095);
	const size = std.div(d.vec2f(1), d.vec2f(tiles));
	const corner = std.mul(
		d.vec2f(
			d.f32(tile % tiles.x),
			d.f32(tiles.y - d.u32(1) - std.min(std.intdiv(tile, tiles.x), tiles.y - d.u32(1))),
		),
		size,
	);
	const uv0 = std.select(u0, std.add(std.mul(u0, size), corner), (sheet & (d.u32(1) << d.u32(24))) !== 0);
	const uv1 = std.select(u1, std.add(std.mul(u1, size), corner), (sheet & (d.u32(1) << d.u32(25))) !== 0);
	return d.vec4f(uv0, uv1);
});

/**
 * unpacks a particle row's custom data (two f16 pairs).
 *
 * @param row instance row
 * @returns four custom floats
 */
export const rowCustom = tgpu.fn(
	[InstanceRow],
	d.vec4f,
)((row) => {
	'use gpu';
	return d.vec4f(std.unpack2x16float(row.custom.x), std.unpack2x16float(row.custom.y));
});

/**
 * extracts an instance row's block slot from its block word.
 *
 * @param word packed block word
 * @returns block slot index
 */
export const rowBlock = tgpu.fn(
	[d.u32],
	d.u32,
)((word) => {
	'use gpu';
	return word & d.u32((1 << BLOCK_SLOT_BITS) - 1);
});

/**
 * extracts an instance row's 1-based decal placement index from its block word (0 when absent).
 *
 * @param word packed block word
 * @returns 1-based placement index or 0
 */
export const rowPlacement = tgpu.fn(
	[d.u32],
	d.u32,
)((word) => {
	'use gpu';
	return word >>> d.u32(BLOCK_SLOT_BITS);
});

const LIST_ROW_MASK = 0x00ffffff;

/**
 * extracts the 24-bit global row index from a visible-list entry.
 *
 * @param entry visible-list word
 * @returns global row index
 */
export const listRow = tgpu.fn(
	[d.u32],
	d.u32,
)((entry) => {
	'use gpu';
	return entry & d.u32(LIST_ROW_MASK);
});

/**
 * extracts the 8-bit transition fade code from a visible-list entry.
 *
 * @param entry visible-list word
 * @returns fade code (`0` opaque, `1..127` fading in, `129..255` fading out)
 */
export const listFade = tgpu.fn(
	[d.u32],
	d.u32,
)((entry) => {
	'use gpu';
	return entry >>> d.u32(24);
});

/**
 * converts a transition fade code to a scalar opacity in `[0, 1]`.
 *
 * @param code 8-bit fade code
 * @returns opacity in `[0, 1]`
 */
export const fadeOpacity = tgpu.fn(
	[d.u32],
	d.f32,
)((code) => {
	'use gpu';
	if (code === 0) {
		return 1;
	}
	return d.f32(std.select(code, code - d.u32(128), code >= d.u32(128))) / 128;
});

/**
 * dithered cross-fade discard test for HLOD/detail transitions.
 *
 * @param code 8-bit fade code
 * @param px pixel coordinates
 * @returns `true` when the pixel should be discarded
 */
export const fadeDiscard = tgpu.fn(
	[d.u32, d.vec2f],
	d.bool,
)((code, px) => {
	'use gpu';
	if (code === 0) {
		return false;
	}
	const n = gradientNoise(std.add(px, d.vec2f(frameLayout.$.frame.params.w)));
	if (code < d.u32(128)) {
		return n >= d.f32(code) / 128;
	}
	return n < 1 - d.f32(code - d.u32(128)) / 128;
});

/**
 * builds the 3×3 basis matrix of an instance row, applying camera or vertical billboarding when set in
 * `info`.
 *
 * @param t0 first transform row
 * @param t1 second transform row
 * @param t2 third transform row
 * @param info packed info word (billboard mode in bits 30–31)
 * @returns 3×3 transform basis
 */
export const rowBasis = tgpu.fn(
	[d.vec4f, d.vec4f, d.vec4f, d.u32],
	d.mat3x3f,
)((t0, t1, t2, info) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	const m = d.mat3x3f(d.vec3f(t0.x, t1.x, t2.x), d.vec3f(t0.y, t1.y, t2.y), d.vec3f(t0.z, t1.z, t2.z));
	const mode = info >>> d.u32(30);
	if (mode === d.u32(1)) {
		return std.mul(d.mat3x3f(frame.viewRight.xyz, frame.viewUp.xyz, frame.viewForward.xyz), m);
	}
	if (mode === d.u32(2)) {
		const right = std.normalize(d.vec3f(frame.viewRight.x, 0, frame.viewRight.z));
		const up = d.vec3f(0, 1, 0);
		return std.mul(d.mat3x3f(right, up, std.cross(right, up)), m);
	}
	if (mode === d.u32(3)) {
		const c0 = d.vec3f(t0.x, t1.x, t2.x);
		const axisLen = std.length(c0);
		if (axisLen <= 1e-6) {
			return m;
		}
		const axis = std.div(c0, axisLen);
		let across = std.cross(frame.viewForward.xyz, axis);
		if (std.length(across) <= 1e-4) {
			across = std.cross(frame.viewUp.xyz, axis);
		}
		across = std.normalize(across);
		const face = std.cross(axis, across);
		const yScale = std.length(d.vec3f(t0.y, t1.y, t2.y));
		const zScale = std.length(d.vec3f(t0.z, t1.z, t2.z));
		return d.mat3x3f(c0, std.mul(across, yScale), std.mul(face, zScale));
	}
	return m;
});

// #endregion
