// instanced meshes with the HGRP surface essentials: base colour, tangent-space normal map, roughness from
// the normal map's B channel or an MRO map, emission, and Lit's tri-channel mask, detail map, parallax
// glow and top layer, plus the erosion shader, opaque, alpha-tested or alpha-blended. quantized positions, octahedral normals and tangents and UV sets 0 and 1 from the geometry blob;
// instances from this frame's visible list; draw parameters by the list entry's draw id (see materials.ts for
// their layout).

struct Row {
	t0: vec4f,
	t1: vec4f,
	t2: vec4f,
	center: vec3f,
	block: u32,
	extent: vec3f,
	info: u32,
}

struct Draw {
	// dequantization: position = offset.xyz + value · scale.xyz; offset.w = look flags (u32 bits)
	offset: vec4f,
	scale: vec4f,
	// UV sets 0 and 1: uv = value · xy + zw
	uv0: vec4f,
	uv1: vec4f,
	// linear tint, w = alpha-test threshold (negative without alpha testing)
	tint: vec4f,
	// UV transforms (uv · xy + zw) of the base colour, normal, mask, emissive, detail, parallax and parallax
	// noise slots
	slot_uv: array<vec4f, 7>,
	// roughness min, roughness max, metallic, normal scale
	surface: vec4f,
	// occlusion strength, f0, transmission, base colour brighter scale
	surface2: vec4f,
	// emissive colour (linear), w = how much the tint covers the base colour
	emissive: vec4f,
	// x = how little the albedo tints emission (1: not at all), y = the emission mask channel, z = 1 when
	// emission ignores the post exposure
	emissive2: vec4f,
	// the tri-channel mask's R, G and B: linear colour, strength
	mask_albedo: array<vec4f, 3>,
	// per mask channel (xyz): the roughness and metallic it blends toward, its contrast and offset
	mask_roughness: vec4f,
	mask_metallic: vec4f,
	mask_scale: vec4f,
	mask_offset: vec4f,
	// detail mode (0 colour overlay, 1 PBR), mask mode, normal intensity, PBR intensity
	detail: vec4f,
	// view depths where the detail starts and finishes fading, overlay brighter scale
	detail2: vec4f,
	// overlay colour (linear), how much it covers
	detail_overlay: vec4f,
	// parallax depth, march steps, Fresnel power, pulse amplitude
	parallax: vec4f,
	// pulse phase per second, pulse phase per metre of the object's position, 1 when the glow ignores the post
	// exposure, pulse mean
	parallax2: vec4f,
	// bright colour, w = mask channel
	parallax_color: vec4f,
	// dark colour
	parallax_dark: vec4f,
	// brightening near the player: outer radius, inner radius, strength
	parallax_bright: vec4f,
	// leaves (`leafParams` in materials.ts): how much the vertex AO shadows the sun, the fake directional
	// shadow's strength and power, 1 when the sun's N·L takes the vertex normal
	foliage: vec4f,
	// leaves: the vertex AO ranges fading transmission (xy: start, range) and subsurface (zw) in
	foliage_ao: vec4f,
	// leaves: subsurface intensity, 1 when transmission fades out with distance, canopy ramp intensity, 1 when
	// the ramp starts at the top
	foliage2: vec4f,
	// leaves: canopy ramp range, transition range, colour brighter scale, colour cover
	canopy: vec4f,
	// leaves: canopy ramp colour (linear)
	canopy_color: vec4f,
}

const BASE_MAP = 1u;
const NORMAL_MAP = 2u;
const MASK_MAP = 4u;
const EMISSIVE_MAP = 8u;
const NORMAL_RAG = 16u;
const NORMAL_ROUGHNESS = 32u;
const FOLIAGE = 64u;
const METALLIC_BASE_ALPHA = 128u;
const NORMAL_OCCLUSION = 256u;
const EMISSIVE_MASK = 2048u;
const UNLIT = 4096u;
const ALPHA_NORMAL = 8192u;
const TRI_CHANNEL_MASK = 16384u;
const DETAIL_MAP = 32768u;
const PARALLAX_MAP = 65536u;
const PARALLAX_NOISE_MAP = 131072u;
// `HGRP/Erosion` (`erosionLook` in materials.ts)
const EROSION = 33554432u;
// `HGRP/Foliage/Leaf` (`leafParams` in materials.ts)
const FOLIAGE_LEAF = 134217728u;
// `_LAYERBLEND_TOP` (`topLayerParams` in materials.ts): the parallax slots and rows hold the top layer
const TOP_LAYER = 2147483648u;
// slot i samples UV set 1 when bit UV1_SHIFT + i is set
const UV1_SHIFT = 18u;
// set per draw from the geometry's streams (`GeometryFlags` in mesh-renderer.ts)
const HAS_NORMALS = 512u;
const HAS_TANGENTS = 1024u;
const HAS_COLORS = 67108864u;

const BASE_SLOT = 0u;
const NORMAL_SLOT = 1u;
const MASK_SLOT = 2u;
const EMISSIVE_SLOT = 3u;
const DETAIL_SLOT = 4u;
const PARALLAX_SLOT = 5u;
const NOISE_SLOT = 6u;
// the top layer's `_Layer1BaseMap`; `_Layer1BumpMap` is in the noise slot, with the same coordinates
const LAYER_SLOT = 5u;

@group(1) @binding(0) var<storage, read> rows: array<Row>;
@group(1) @binding(1) var<storage, read> blocks: array<vec4f>;
@group(1) @binding(2) var<storage, read> list: array<u32>;
@group(2) @binding(0) var<storage, read> draws: array<Draw>;
// per visible-list entry: its index into `draws`
@group(2) @binding(1) var<storage, read> draw_ids: array<u32>;
@group(3) @binding(0) var base_map: texture_2d<f32>;
@group(3) @binding(1) var normal_map: texture_2d<f32>;
@group(3) @binding(2) var mask_map: texture_2d<f32>;
@group(3) @binding(3) var emissive_map: texture_2d<f32>;
@group(3) @binding(4) var detail_map: texture_2d<f32>;
@group(3) @binding(5) var parallax_map: texture_2d<f32>;
@group(3) @binding(6) var parallax_noise_map: texture_2d<f32>;
@group(3) @binding(7) var base_sampler: sampler;
@group(3) @binding(8) var detail_sampler: sampler;
@group(3) @binding(9) var parallax_sampler: sampler;

struct VertexIn {
	@location(0) position: vec4f,
	@location(1) normal: vec2f,
	@location(2) uv0: vec2f,
	@location(4) uv1: vec2f,
	// octahedral tangent, z = bitangent sign; zero without tangents
	@location(3) tangent: vec4f,
	@location(5) color: vec4f,
}

struct VertexOut {
	// alpha-tested meshes are shaded where their depth equals that of an earlier pass with another pipeline
	@builtin(position) @invariant position: vec4f,
	@location(0) rel: vec3f,
	@location(1) normal: vec3f,
	// w = bitangent sign, 0 without a tangent
	@location(2) tangent: vec4f,
	// dequantized UV sets 0 and 1
	@location(3) uv: vec4f,
	@location(4) @interpolate(flat) draw: u32,
	// the sum of the object's world position components, which offsets the parallax pulse
	@location(5) @interpolate(flat) phase: f32,
	// the object-space height, along which the erosion flow band runs
	@location(6) object_y: f32,
	// the vertex colour, white for meshes without one
	@location(7) color: vec4f,
	// the camera-relative object origin, which the leaves' transmission fades out by
	@location(8) @interpolate(flat) origin: vec3f,
}

@vertex
fn vs_main(v: VertexIn, @builtin(instance_index) ii: u32) -> VertexOut {
	let row = rows[list[ii]];
	let draw_id = draw_ids[ii];
	let draw = draws[draw_id];
	let p = draw.offset.xyz + v.position.xyz * draw.scale.xyz;
	let origin = vec3f(row.t0.w, row.t1.w, row.t2.w) + blocks[row.block].xyz;
	let rel = vec3f(dot(row.t0.xyz, p), dot(row.t1.xyz, p), dot(row.t2.xyz, p)) + origin;
	let m = mat3x3f(
		vec3f(row.t0.x, row.t1.x, row.t2.x),
		vec3f(row.t0.y, row.t1.y, row.t2.y),
		vec3f(row.t0.z, row.t1.z, row.t2.z),
	);
	let flags = bitcast<u32>(draw.offset.w);
	// no normals in the mesh: zero here, faceted in the fragment shader
	var n = vec3f(0.0);
	if ((flags & HAS_NORMALS) != 0u) {
		// strictly the inverse transpose; scenery is scaled close to uniformly, so the matrix does once
		// renormalized
		n = m * oct_decode(v.normal);
	}
	var t = vec4f(0.0);
	if ((flags & HAS_TANGENTS) != 0u) {
		let sign = select(-1.0, 1.0, v.tangent.z >= 0.0) * select(-1.0, 1.0, determinant(m) >= 0.0);
		t = vec4f(m * oct_decode(v.tangent.xy), sign);
	}
	let world = origin + frame.eye.xyz;
	var out: VertexOut;
	out.position = frame.view_proj * vec4f(rel, 1.0);
	out.rel = rel;
	out.normal = n;
	out.tangent = t;
	out.uv = vec4f(v.uv0 * draw.uv0.xy + draw.uv0.zw, v.uv1 * draw.uv1.xy + draw.uv1.zw);
	out.draw = draw_id;
	out.phase = world.x + world.y + world.z;
	out.object_y = p.y;
	out.color = select(vec4f(1.0), v.color, (flags & HAS_COLORS) != 0u);
	out.origin = origin;
	return out;
}

// the UV set a slot samples, before its transform
fn slot_set(uv: vec4f, flags: u32, slot: u32) -> vec2f {
	return select(uv.xy, uv.zw, (flags & (1u << (UV1_SHIFT + slot))) != 0u);
}

// read through the buffer: arrays in a `let` copy can't be indexed by a variable
fn slot_uv(draw_id: u32, uv: vec4f, flags: u32, slot: u32) -> vec2f {
	let t = draws[draw_id].slot_uv[slot];
	return slot_set(uv, flags, slot) * t.xy + t.zw;
}

// one tri-channel mask channel's blend toward its colour, roughness and metallic
fn blend_mask_channel(s: Surface, w: f32, albedo: vec3f, roughness: f32, metallic: f32) -> Surface {
	var out = s;
	out.albedo = mix(s.albedo, albedo, w);
	out.roughness = mix(s.roughness, roughness, w);
	out.metallic = mix(s.metallic, metallic, w);
	return out;
}

// a tangent-space normal from a map's RG, with the game's dead zone around flat and the Z floor
fn unpack_normal_xy(rg: vec2f) -> vec2f {
	let xy = rg * 2.0 - 1.0;
	return select(xy, vec2f(0.0), abs(xy) < vec2f(0.012));
}

fn normal_z(xy: vec2f) -> f32 {
	return max(1.0 / 2048.0, sqrt(saturate(1.0 - dot(xy, xy))));
}

// reoriented normal mapping of a tangent-space normal, its x and y already negated, onto a base normal
fn reorient_normal(base: vec3f, flipped: vec3f) -> vec3f {
	let b = base + vec3f(0.0, 0.0, 1.0);
	return b * dot(b, flipped) / max(1e-5, b.z) - flipped;
}

// #region top layer
// `_LAYERBLEND_TOP` (`topLayerParams` in materials.ts, parameters by `TopLayerRow`, which reuses the parallax rows:
// coverage in `parallax`, height in `parallax2`, colour in `parallax_color`, blend in `parallax_dark`, normal in
// `parallax_bright`)

// how much the layer covers, from the upward component of the normal and the layer's height (`layer_a`)
fn top_layer_coverage(draw: Draw, up: f32, layer_a: f32) -> f32 {
	let coverage = draw.parallax;
	let height = draw.parallax2;
	let top = saturate((up - coverage.y) / coverage.z);
	if (height.x == 0.0) {
		return top;
	}
	// each side's height, weighted by its coverage; the higher one wins within the transition
	let weights = vec2f(1.0 - top, top);
	let heights = weights * vec2f(height.z, layer_a);
	let w = (max(vec2f(0.0), heights + height.y - max(heights.x, heights.y)) + 1e-6) * weights;
	return w.y / max(1.175494e-38, w.x + w.y);
}

// the layer's tangent-space normal, reoriented onto the base's by the base normal intensity
fn top_layer_normal(draw: Draw, base: vec3f, bump: vec4f) -> vec3f {
	let normal = draw.parallax_bright;
	let xy = bump.rg * 2.0 - 1.0;
	let layer = vec3f(xy * normal.x, max(1e-16, sqrt(1.0 - saturate(dot(xy, xy)))));
	let reoriented = reorient_normal(base, layer * vec3f(-1.0, -1.0, 1.0));
	return mix(layer, reoriented, normal.y);
}

// the layer's colour, metallic, roughness (the bump map's B) and occlusion (its A) blended in by `top`
fn top_layer_surface(surface: Surface, draw: Draw, top: f32, layer: vec4f, bump: vec4f) -> Surface {
	var s = surface;
	let color = draw.parallax_color;
	let blend = draw.parallax_dark;
	let normal = draw.parallax_bright;
	let luma = dot(layer.rgb, vec3f(0.2126729, 0.7151522, 0.0721750));
	let tinted = mix(vec3f(luma), layer.rgb, color.w) * color.rgb;
	// replace (mode 0) or add (mode 1, scaled by the additive intensity)
	s.albedo = s.albedo * (1.0 - top * (1.0 - blend.x)) + tinted * top * mix(1.0, blend.y, blend.x);
	s.metallic = mix(s.metallic, select(blend.w, layer.a, blend.z != 0.0), top);
	s.roughness = mix(s.roughness, bump.b, top);
	s.occlusion = mix(s.occlusion, select(mix(1.0, bump.a, normal.z), 1.0, normal.w != 0.0), top);
	return s;
}
// #endregion

// a shader that may discard loses early depth and, on tile-based GPUs, hidden-surface removal, so only the
// depth passes of alpha-tested materials discard (fs_cutout_depth). their shading runs fs_opaque where the
// depth matches.

@fragment
fn fs_opaque(in: VertexOut) -> Shaded {
	return shade(in, true);
}

// the transparent pass's outputs (`TRANSPARENT_TARGETS` in render-targets.ts)
struct Accumulated {
	// the premultiplied radiance times the layer's weight; a: alpha times the weight
	@location(0) sum: vec4f,
	// alpha, which the blend turns into the product of 1 − alpha
	@location(1) revealage: vec4f,
	// additive light, none for glass
	@location(2) glow: vec4f,
}

// alpha-blended materials (`transparent` in materials.ts), shaded like opaque ones. the opacity is the alpha
// the alpha test would read, times `_BaseColor.a`. the weight favours nearer layers a little, so the front
// pane of overlapping glass shows more; it stays at most 1 so the half-float sum can't overflow
@fragment
fn fs_transparent(in: VertexOut) -> Accumulated {
	let draw = draws[in.draw];
	let flags = bitcast<u32>(draw.offset.w);
	let bias = frame.params.y;
	let base = textureSampleBias(base_map, base_sampler, slot_uv(in.draw, in.uv, flags, BASE_SLOT), bias);
	let packed = textureSampleBias(normal_map, detail_sampler, slot_uv(in.draw, in.uv, flags, NORMAL_SLOT), bias);
	let shaded = shade(in, false);
	// a map still streaming leaves the tint's alpha alone
	var alpha = select(base.a, packed.a, (flags & ALPHA_NORMAL) != 0u);
	let alpha_map = select(BASE_MAP, NORMAL_MAP, (flags & ALPHA_NORMAL) != 0u);
	if ((flags & alpha_map) == 0u) {
		alpha = 1.0;
	}
	alpha = saturate(alpha * draw.emissive2.w);
	let distance = length(in.rel) / 20.0;
	let weight = alpha * max(0.01, 1.0 / (1.0 + distance * distance));
	var out: Accumulated;
	out.sum = vec4f(shaded.radiance.rgb * weight, weight);
	out.revealage = vec4f(alpha);
	out.glow = vec4f(0.0);
	return out;
}

fn shade(in: VertexOut, wet: bool) -> Shaded {
	let draw = draws[in.draw];
	let flags = bitcast<u32>(draw.offset.w);
	// derivatives (and implicit-LOD sampling) must happen in uniform control flow
	let faceted = cross(dpdy(in.rel), dpdx(in.rel));
	let bias = frame.params.y;
	let id = in.draw;
	let base = textureSampleBias(base_map, base_sampler, slot_uv(id, in.uv, flags, BASE_SLOT), bias);
	let packed = textureSampleBias(normal_map, detail_sampler, slot_uv(id, in.uv, flags, NORMAL_SLOT), bias);
	let mask = textureSampleBias(mask_map, detail_sampler, slot_uv(id, in.uv, flags, MASK_SLOT), bias);
	let glow = textureSampleBias(emissive_map, base_sampler, slot_uv(id, in.uv, flags, EMISSIVE_SLOT), bias);
	let detail = textureSampleBias(detail_map, detail_sampler, slot_uv(id, in.uv, flags, DETAIL_SLOT), bias);
	// the parallax march samples with explicit gradients: those of UV set 0 (as the game does) for the noise,
	// and of the pattern's own UVs for the pattern
	let gradient_scale = exp2(bias);
	let parallax_uv = slot_set(in.uv, flags, PARALLAX_SLOT);
	let uv0_dx = dpdx(in.uv.xy) * gradient_scale;
	let uv0_dy = dpdy(in.uv.xy) * gradient_scale;
	let parallax_dx = dpdx(parallax_uv) * gradient_scale;
	let parallax_dy = dpdy(parallax_uv) * gradient_scale;
	// the top layer's coordinates: UV set 0, world XZ, or UV set 2, which the viewer reads as set 0
	// (`topLayerParams` in materials.ts)
	let layer_type = draw.parallax.w;
	let layer_source = select(in.uv.xy, (in.rel + frame.eye.xyz).xz, layer_type > 0.5 && layer_type < 1.5);
	let layer_t = draw.slot_uv[LAYER_SLOT];
	let layer_uv = layer_source * layer_t.xy + layer_t.zw;
	let layer_dx = dpdx(layer_uv) * gradient_scale;
	let layer_dy = dpdy(layer_uv) * gradient_scale;

	if ((flags & UNLIT) != 0u) {
		// matte paintings (`mattePaintingLook` in materials.ts): the tinted texture brightened above a threshold,
		// in pre-exposed units unless it ignores the post exposure
		var c = draw.tint.rgb;
		if ((flags & BASE_MAP) != 0u) {
			c *= base.rgb;
		}
		c += max(c - vec3f(draw.surface.x), vec3f(0.0)) * draw.surface.y;
		return unlit(clamp(c * mix(1.0, frame.ambient.y, draw.emissive2.z), vec3f(0.0), vec3f(1000.0)));
	}
	if ((flags & EROSION) != 0u) {
		var s = erosion_surface(draw, in, flags, faceted, packed, mask, detail, uv0_dx, uv0_dy);
		if (wet) {
			s = rain_wet_surface(s, in.rel);
		}
		return shade_surface(s, in.rel, in.position.xy);
	}

	var albedo = clamp(base.rgb * draw.tint.rgb * draw.surface2.w, vec3f(0.0), vec3f(1.0));
	if ((flags & BASE_MAP) == 0u) {
		albedo = vec3f(1.0);
	}
	albedo = mix(albedo, draw.tint.rgb, draw.emissive.w);
	let base_a = select(0.0, base.a, (flags & BASE_MAP) != 0u);
	let has_normal = (flags & NORMAL_MAP) != 0u;

	// the detail map's weight: a mask channel (`_DetailMaskMode`: none, the detail's alpha, the base colour's
	// alpha, the normal map's B or A) fading out with view depth
	let has_detail = (flags & DETAIL_MAP) != 0u;
	var detail_weight = 0.0;
	if (has_detail) {
		let mode = draw.detail.y;
		let own = mix(mix(base_a, packed.b, saturate(mode - 2.0)), packed.a, saturate(mode - 3.0));
		let depth = abs(dot(in.rel, frame.view_forward.xyz));
		let span = draw.detail2.y - draw.detail2.x;
		let fade = saturate((draw.detail2.y - depth) / select(span, 1e-6, span == 0.0));
		detail_weight = mix(mix(1.0, detail.a, saturate(mode)), own, saturate(mode - 1.0)) * fade;
		// colour mode: the overlay, where the detail's B is dark
		let overlay = mix(
			clamp(albedo * draw.detail_overlay.rgb * draw.detail2.z, vec3f(0.0), vec3f(1.0)),
			draw.detail_overlay.rgb,
			draw.detail_overlay.a,
		);
		albedo = mix(albedo, overlay, detail_weight * (1.0 - draw.detail.x) * (1.0 - detail.b));
	}
	let detail_pbr = draw.detail.w * detail_weight;

	var n = in.normal;
	if (dot(n, n) < 1e-6) {
		n = faceted;
	}
	n = normalize(n);
	// two-sided materials (foliage) show both faces, and smooth normals can face away at silhouettes: light the
	// side facing us
	let towards_viewer = dot(n, in.rel) <= 0.0;
	if (!towards_viewer) {
		n = -n;
	}

	// the top layer, once both its maps are bound; the parallax glow can't share the slots
	let layer_maps = PARALLAX_MAP | PARALLAX_NOISE_MAP;
	let top_layer = (flags & TOP_LAYER) != 0u && (flags & layer_maps) == layer_maps;
	var layer = vec4f(0.0);
	var layer_bump = vec4f(0.0);
	if (top_layer) {
		layer = textureSampleGrad(parallax_map, parallax_sampler, layer_uv, layer_dx, layer_dy);
		layer_bump = textureSampleGrad(parallax_noise_map, parallax_sampler, layer_uv, layer_dx, layer_dy);
	}
	// how much the layer covers
	var top = 0.0;

	var roughness = draw.surface.y;
	if ((has_normal || top_layer) && in.tangent.w != 0.0) {
		var tn = vec3f(0.0, 0.0, 1.0);
		if (has_normal) {
			var rg = packed.rg;
			if ((flags & NORMAL_RAG) != 0u) {
				rg.x = packed.r * packed.a;
			}
			let xy = unpack_normal_xy(rg);
			tn = vec3f(xy * draw.surface.w, normal_z(xy));
			if (has_detail) {
				// reoriented normal mapping of the detail onto the base normal
				let dxy = unpack_normal_xy(detail.rg);
				let d = vec3f(dxy * (detail_weight * draw.detail.z), normal_z(dxy)) * vec3f(-1.0, -1.0, 1.0);
				tn = reorient_normal(tn, d);
			}
		}
		var t = normalize(in.tangent.xyz - n * dot(in.tangent.xyz, n));
		var b = cross(in.normal, in.tangent.xyz) * in.tangent.w;
		if (!towards_viewer) {
			b = -b;
		}
		b = normalize(b - n * dot(b, n));
		if (top_layer) {
			let bumped = normalize(t * tn.x + b * tn.y + n * tn.z);
			top = top_layer_coverage(draw, mix(n.y, bumped.y, draw.parallax.x), layer.a);
			tn = mix(tn, top_layer_normal(draw, tn, layer_bump), top);
		}
		n = normalize(t * tn.x + b * tn.y + n * tn.z);
		if (has_normal && (flags & NORMAL_ROUGHNESS) != 0u) {
			roughness = mix(draw.surface.x, draw.surface.y, packed.b);
		}
	} else if (top_layer) {
		top = top_layer_coverage(draw, n.y, layer.a);
	}

	var s = default_surface(albedo, n);
	s.roughness = roughness;
	s.metallic = draw.surface.z;
	s.f0 = draw.surface2.y;
	if ((flags & METALLIC_BASE_ALPHA) != 0u) {
		// dielectric until the base colour streams in
		s.metallic = base_a;
	}
	if ((flags & (NORMAL_MAP | NORMAL_OCCLUSION)) == (NORMAL_MAP | NORMAL_OCCLUSION)) {
		s.occlusion = mix(1.0, packed.a, draw.surface2.x);
	}
	let mro = (flags & (MASK_MAP | TRI_CHANNEL_MASK)) == MASK_MAP;
	if (mro) {
		s.metallic = mask.r;
		s.roughness = mix(draw.surface.x, draw.surface.y, mask.g);
		s.occlusion = mix(1.0, mask.b, draw.surface2.x);
	}
	if (has_detail) {
		// PBR mode: the detail's alpha (roughness) and B; colour mode: B as roughness only
		s.roughness = mix(s.roughness, mix(detail.a, detail.b, draw.detail.x), detail_pbr);
		s.occlusion *= mix(1.0, mix(1.0, detail.a, draw.detail.x), detail_pbr);
	}
	if ((flags & (MASK_MAP | TRI_CHANNEL_MASK)) == (MASK_MAP | TRI_CHANNEL_MASK)) {
		// each channel, remapped by its contrast and offset, blends toward its own surface, B first and R last
		let scale = draw.mask_scale.xyz;
		let w = saturate(scale * 0.5 + mix(-scale, vec3f(1.0), mask.rgb + draw.mask_offset.xyz)) *
			vec3f(draw.mask_albedo[0].w, draw.mask_albedo[1].w, draw.mask_albedo[2].w);
		let roughnesses = draw.mask_roughness;
		let metallics = draw.mask_metallic;
		s = blend_mask_channel(s, w.z, draw.mask_albedo[2].rgb, roughnesses.z, metallics.z);
		s = blend_mask_channel(s, w.y, draw.mask_albedo[1].rgb, roughnesses.y, metallics.y);
		s = blend_mask_channel(s, w.x, draw.mask_albedo[0].rgb, roughnesses.x, metallics.x);
	}
	if (top_layer) {
		s = top_layer_surface(s, draw, top, layer, layer_bump);
	}

	var emission = 0.0;
	if ((flags & EMISSIVE_MAP) != 0u) {
		emission = glow.r;
	}
	if ((flags & EMISSIVE_MASK) != 0u) {
		// mask channel 1 is the base colour's alpha. in the two-basemap layout 2 is the normal map's B and 3 its
		// alpha; with an MRO map 2 is the base alpha too and 3 the MRO map's alpha. a map still streaming reads 0
		emission = saturate((map_channel(flags, draw.emissive2.y, base_a, packed, mask) - 0.05) / 0.9);
	}
	// emission is in the pre-exposed units of the light already. emitters that ignore the post exposure divide
	// it out, so they keep their brightness however the exposure adapts
	let tint = mix(s.albedo, vec3f(1.0), draw.emissive2.x);
	s.emission = draw.emissive.rgb * emission * tint * mix(1.0, frame.ambient.y, draw.emissive2.z);

	let parallax_maps = PARALLAX_MAP | PARALLAX_NOISE_MAP;
	if ((flags & (parallax_maps | TOP_LAYER)) == parallax_maps && in.tangent.w != 0.0) {
		// the glow's mask uses the same channel numbering as the emission mask, one lower
		let glow_mask = map_channel(flags, draw.parallax_color.w + 1.0, base_a, packed, mask);
		if (glow_mask > 0.01) {
			let v = normalize(-in.rel);
			s.emission += parallax_glow(draw, in, v, n, parallax_uv, uv0_dx, uv0_dy, parallax_dx, parallax_dy) *
				(glow_mask * glow_mask);
		}
	}

	if ((flags & FOLIAGE) != 0u) {
		s.foliage = true;
		s.transmission = draw.surface2.z;
		if ((flags & FOLIAGE_LEAF) != 0u) {
			s = leaf_surface(s, draw, in, has_normal, packed.a);
		}
	}
	// the game wets what its deferred lighting shades, so not the forward-shaded glass
	if (wet) {
		s = rain_wet_surface(s, in.rel);
	}
	return shade_surface(s, in.rel, in.position.xy);
}

// smoothstep that also runs downhill (`low` > `high`), as HLSL's does
fn hermite(low: f32, high: f32, x: f32) -> f32 {
	let span = high - low;
	let t = saturate((x - low) / select(span, 1e-6, span == 0.0));
	return t * t * (3.0 - 2.0 * t);
}

// `HGRP/Foliage/Leaf`'s inputs to the two-sided foliage lighting (`leafParams` in materials.ts). the vertex
// colour's R is ambient occlusion and A the height in the canopy; the normal map's alpha (`normal_a`) masks
// transmission and the canopy ramp
fn leaf_surface(surface: Surface, draw: Draw, in: VertexOut, has_normal: bool, normal_a: f32) -> Surface {
	var s = surface;
	let thin = select(1.0, saturate(1.0 - normal_a), has_normal);
	let ao = saturate(mix(1.0, in.color.r, draw.surface2.x));
	s.occlusion = ao;
	let fade_in = vec2f(
		hermite(draw.foliage_ao.x, draw.foliage_ao.x + draw.foliage_ao.y, ao),
		hermite(draw.foliage_ao.z, draw.foliage_ao.z + draw.foliage_ao.w, ao),
	);
	// transmission fades out between 50 and 60 m from the object
	let far = select(1.0, hermite(3600.0, 2500.0, dot(in.origin, in.origin)), draw.foliage2.y > 0.5);
	s.transmission = draw.surface2.z * thin * far * fade_in.x;
	s.subsurface = draw.foliage2.x * fade_in.y;

	let height = select(in.color.a, 1.0 - in.color.a, draw.foliage2.w > 0.5);
	let ramp = hermite(draw.canopy.x + draw.canopy.y, draw.canopy.x, height) * thin * draw.foliage2.z;
	let tinted = mix(
		saturate(s.albedo * draw.canopy_color.rgb * draw.canopy.z),
		draw.canopy_color.rgb,
		draw.canopy.w,
	);
	s.albedo = mix(s.albedo, tinted, ramp);

	// the sun's shadow: the vertex AO, and a fake shadow on the side of the canopy facing away from the sun
	let fake = saturate(1.0 - pow(saturate(dot(s.normal, -frame.sun.xyz) * 0.5 + 0.5), draw.foliage.z) * draw.foliage.y);
	s.sun_shadow = mix(1.0, in.color.r, draw.foliage.x) * fake;
	// the diffuse N·L, from the vertex normal as the mesh stores it (not turned towards the viewer)
	var vertex_normal = s.normal;
	if (dot(in.normal, in.normal) > 1e-6) {
		vertex_normal = normalize(in.normal);
	}
	s.sun_n_dot_l = saturate(dot(mix(s.normal, vertex_normal, draw.foliage.w), frame.sun.xyz));
	return s;
}

// a mask channel of the material's own maps, numbered like `_EmissiveMaskChannel`: 1 the base colour's alpha;
// in the two-basemap layout 2 the normal map's B and 3 its alpha, with an MRO map 2 the base alpha and 3 the
// MRO map's alpha. maps still streaming read 0
fn map_channel(flags: u32, channel: f32, base_a: f32, packed: vec4f, mask: vec4f) -> f32 {
	if ((flags & NORMAL_OCCLUSION) != 0u) {
		let has_normal = (flags & NORMAL_MAP) != 0u;
		let b = select(0.0, packed.b, has_normal);
		let a = select(0.0, packed.a, has_normal);
		return mix(mix(base_a, b, saturate(channel - 1.0)), a, saturate(channel - 2.0));
	}
	let mro = (flags & (MASK_MAP | TRI_CHANNEL_MASK)) == MASK_MAP;
	return mix(base_a, select(0.0, mask.a, mro), saturate(channel - 2.0));
}

// `_PARALLAX_MAP` (materials.ts): march the view ray down through the noise map as a height field, refine the
// hit between the last two steps, and colour it from the pattern's G; then the Fresnel power and the pulse,
// plus the brightening near the player.
// the result is HDR emission before the mask
fn parallax_glow(
	draw: Draw,
	in: VertexOut,
	v: vec3f,
	n: vec3f,
	uv: vec2f,
	uv0_dx: vec2f,
	uv0_dy: vec2f,
	dx: vec2f,
	dy: vec2f,
) -> vec3f {
	// the view direction in the geometric tangent frame
	let bitangent = cross(in.normal, in.tangent.xyz) * in.tangent.w;
	let vt = normalize(vec3f(dot(v, in.tangent.xyz), dot(v, bitangent), dot(v, in.normal)));
	let steps = draw.parallax.y;
	let step = 1.0 / steps;
	let delta = vt.xy / (vt.z + 0.42) / max(vt.z, 0.001) * (-draw.parallax.x * step);
	let noise_uv = uv * draw.slot_uv[NOISE_SLOT].xy;

	var height = 1.0 - step;
	var offset = delta;
	var previous_offset = vec2f(0.0);
	var previous_sample = 0.0;
	var previous_height = 1.0;
	var hit = -1.0;
	for (var i = 0.0; i < steps + 1.0; i += 1.0) {
		let found = textureSampleGrad(parallax_noise_map, parallax_sampler, noise_uv + offset, uv0_dx, uv0_dy).x;
		if (found > height) {
			hit = found;
			break;
		}
		previous_offset = offset;
		previous_sample = found;
		previous_height = height;
		offset += delta;
		height -= step;
	}
	if (hit < 0.0) {
		hit = previous_sample;
	}
	let denominator = (previous_sample - hit) + height - previous_height;
	let t = (previous_sample - previous_height) / select(denominator, 1e-6, denominator == 0.0);
	let tiling = draw.slot_uv[PARALLAX_SLOT].xy;
	let pattern = textureSampleGrad(
		parallax_map,
		parallax_sampler,
		(uv + previous_offset + delta * t) * tiling,
		dx * tiling,
		dy * tiling,
	).y;

	let fresnel = pow(max(saturate(dot(v, n)), 0.001), draw.parallax.z);
	let pulse = cos(frame.eye.w * draw.parallax2.x + draw.parallax2.y * in.phase) * draw.parallax.w + draw.parallax2.w;
	// the player stands at the camera. a smoothstep from the outer radius down to the inner one, written out
	// because WGSL's smoothstep wants its edges in ascending order
	let bright = draw.parallax_bright;
	let near_t = saturate((length(in.rel) - bright.x) / (bright.y - bright.x));
	let near = near_t * near_t * (3.0 - 2.0 * near_t) * bright.z;
	let color = mix(draw.parallax_dark.rgb, draw.parallax_color.rgb, pattern) * fresnel * (pulse + near);
	return clamp(color, vec3f(0.0), vec3f(1000.0)) * mix(1.0, frame.ambient.y, draw.parallax2.z);
}

// `HGRP/Erosion` (`erosionLook` in materials.ts, parameters by `ErosionRow`): base and metal colours mixed by the
// metal map, plus a parallax-offset noise layer and a flow band along the object's height. `packed` is the base
// normal map, `mask` the metal map and `detail` the detail normal map; textures still streaming read as the
// game's defaults (white, or flat normals)
fn erosion_surface(
	draw: Draw,
	in: VertexOut,
	flags: u32,
	faceted: vec3f,
	packed_in: vec4f,
	mask_in: vec4f,
	detail_in: vec4f,
	uv0_dx: vec2f,
	uv0_dy: vec2f,
) -> Surface {
	let flat_normal = vec4f(0.5, 0.5, 1.0, 1.0);
	let packed = select(flat_normal, packed_in, (flags & NORMAL_MAP) != 0u);
	let metal_map = select(vec4f(1.0), mask_in, (flags & MASK_MAP) != 0u);
	let detail = select(flat_normal, detail_in, (flags & DETAIL_MAP) != 0u);
	let base_color = draw.tint.rgb;
	let roughness = draw.surface.x;
	let roughness_cover = draw.surface.y;
	let metallic = draw.surface.z;
	let normal_scale = draw.surface.w;
	let occlusion_strength = draw.surface2.x;
	let metallic_offset = draw.surface2.z;
	let detail_scale = draw.surface2.w;
	let noise_emissive = draw.emissive.x;
	let flow_strength = draw.emissive.y;
	let flow_emissive = draw.emissive.z;
	let distance_blend = draw.emissive.w;
	let metal_color = draw.mask_albedo[0].rgb;
	let noise_depth = draw.mask_albedo[0].w;
	let noise_tint = draw.mask_albedo[1].rgb;
	let noise_min = draw.mask_albedo[1].w;
	let noise_alpha_tint = draw.mask_albedo[2].rgb;
	let flow_offset = draw.mask_albedo[2].w;
	let flow_top = draw.mask_roughness.rgb;
	let flow_roughness = draw.mask_roughness.w;
	let flow_bottom = draw.mask_metallic.rgb;
	let flow = draw.mask_scale;

	var n = in.normal;
	if (dot(n, n) < 1e-6) {
		n = faceted;
	}
	n = normalize(n);
	let towards_viewer = dot(n, in.rel) <= 0.0;
	if (!towards_viewer) {
		n = -n;
	}
	let v = normalize(-in.rel);
	// 1 where metal
	let metal = saturate(1.0 - metal_map.r);
	let has_tangent = in.tangent.w != 0.0;
	var b = vec3f(0.0);
	if (has_tangent) {
		b = cross(in.normal, in.tangent.xyz) * in.tangent.w;
	}

	// the noise layer: one parallax step into the noise map as a height field, then a tinted lookup at the hit,
	// fading with distance
	var noise_offset = vec2f(0.0);
	if (has_tangent && (flags & PARALLAX_NOISE_MAP) != 0u) {
		let vt = normalize(vec3f(dot(v, in.tangent.xyz), dot(v, b), dot(v, in.normal)));
		let delta = vt.xy / (vt.z + 0.42) / max(vt.z, 0.001) * -noise_depth;
		let hit = textureSampleGrad(parallax_noise_map, parallax_sampler, in.uv.xy + delta, uv0_dx, uv0_dy).x;
		// the hit refined between the surface (height 1) and the step (height 0)
		noise_offset = delta / (1.0 + max(hit, 0.0));
	}
	var noise_rgb = vec3f(1.0);
	if ((flags & PARALLAX_MAP) != 0u) {
		let tiling = draw.slot_uv[PARALLAX_SLOT].xy;
		noise_rgb = textureSampleGrad(
			parallax_map,
			parallax_sampler,
			(in.uv.xy + noise_offset) * tiling,
			uv0_dx * tiling,
			uv0_dy * tiling,
		).rgb;
	}
	let fade = max(0.001, 1.0 - saturate(length(in.rel) / distance_blend));
	let noise = noise_rgb * noise_tint * packed.a * max(dot(n, v), noise_min) * fade;

	// the flow band: the ramp read along the object's height, offset by the metal map's G and a scroll, coloured
	// from the bottom colour below the offset height to the top colour above it
	let flow_u = in.object_y * flow.x + metal_map.g * flow.y + frame.eye.w * flow.z + flow.w;
	var ramp = vec3f(0.5, 0.5, 1.0);
	if ((flags & EMISSIVE_MAP) != 0u) {
		ramp = textureSampleLevel(emissive_map, base_sampler, vec2f(flow_u, 0.5), 0.0).rgb;
	}
	var below = select(0.0, 1.0, flow_offset >= 0.0);
	if (in.object_y != 0.0) {
		below = saturate(flow_offset / in.object_y);
	}
	below = below * below * (3.0 - 2.0 * below);
	let flow_color = ramp * mix(flow_bottom, flow_top, 1.0 - below);

	var albedo = mix(base_color + noise + noise_alpha_tint * metal, metal_color, metal);
	albedo += flow_color * flow_strength * metal_map.b;

	// the base and detail normals summed; metal flattens the bitangent component
	if (has_tangent) {
		let base_xy = packed.rg * 2.0 - 1.0;
		let detail_xy = vec2f(detail.r * detail.a, detail.g) * 2.0 - 1.0;
		var tn = normalize(
			vec3f(base_xy * normal_scale, normal_z(base_xy)) + vec3f(detail_xy * detail_scale, normal_z(detail_xy)),
		);
		tn.y = mix(tn.y, 0.0, metal);
		let t = normalize(in.tangent.xyz - n * dot(in.tangent.xyz, n));
		var bt = select(-b, b, towards_viewer);
		bt = normalize(bt - n * dot(bt, n));
		n = normalize(t * tn.x + bt * tn.y + n * tn.z);
	}

	var s = default_surface(clamp(albedo, vec3f(0.0), vec3f(1.0)), n);
	s.roughness = saturate(
		mix(mix(roughness * metal_map.a, detail.a, roughness_cover), 0.01, metal) - length(flow_color) * flow_roughness,
	);
	s.metallic = saturate(metallic * (metal - metallic_offset));
	s.f0 = draw.surface2.y;
	s.occlusion = 1.0 - occlusion_strength + metal_map.g * occlusion_strength;
	s.emission = noise * noise_emissive + flow_color * flow_emissive * saturate(1.0 - metal_map.b);
	return s;
}

// the depth of alpha-tested materials, in the main pass and the shadow passes (opaque ones have no fragment
// stage there). only drawn for materials with an alpha-test threshold whose alpha texture is bound (`cutout`
// in materials.ts and MeshRenderer.prepare)
@fragment
fn fs_cutout_depth(in: VertexOut) {
	let draw = draws[in.draw];
	let flags = bitcast<u32>(draw.offset.w);
	let bias = frame.params.y;
	let base = textureSampleBias(base_map, base_sampler, slot_uv(in.draw, in.uv, flags, BASE_SLOT), bias);
	let packed = textureSampleBias(normal_map, detail_sampler, slot_uv(in.draw, in.uv, flags, NORMAL_SLOT), bias);
	let alpha = select(base.a, packed.a, (flags & ALPHA_NORMAL) != 0u);
	if (alpha < draw.tint.w) {
		discard;
	}
}
