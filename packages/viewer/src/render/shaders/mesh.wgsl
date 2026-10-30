// instanced meshes with the HGRP surface essentials: base colour, tangent-space normal map, roughness from
// the normal map's B channel or an MRO map, emission, and Lit's tri-channel mask, detail map and parallax
// glow. quantized positions, octahedral normals and tangents and UV sets 0 and 1 from the geometry blob;
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
// slot i samples UV set 1 when bit UV1_SHIFT + i is set
const UV1_SHIFT = 18u;
// set per draw from the geometry's streams (`GeometryFlags` in mesh-renderer.ts)
const HAS_NORMALS = 512u;
const HAS_TANGENTS = 1024u;

const BASE_SLOT = 0u;
const NORMAL_SLOT = 1u;
const MASK_SLOT = 2u;
const EMISSIVE_SLOT = 3u;
const DETAIL_SLOT = 4u;
const PARALLAX_SLOT = 5u;
const NOISE_SLOT = 6u;

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

// a shader that may discard loses early depth and, on tile-based GPUs, hidden-surface removal, so only the
// depth passes of alpha-tested materials discard (fs_cutout_depth). their shading runs fs_opaque where the
// depth matches.

@fragment
fn fs_opaque(in: VertexOut) -> Shaded {
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

	var albedo = clamp(base.rgb * draw.surface2.w, vec3f(0.0), vec3f(1.0));
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

	var roughness = draw.surface.y;
	if (has_normal && in.tangent.w != 0.0) {
		var rg = packed.rg;
		if ((flags & NORMAL_RAG) != 0u) {
			rg.x = packed.r * packed.a;
		}
		let xy = unpack_normal_xy(rg);
		var tn = vec3f(xy * draw.surface.w, normal_z(xy));
		if (has_detail) {
			// reoriented normal mapping of the detail onto the base normal
			let dxy = unpack_normal_xy(detail.rg);
			let d = vec3f(dxy * (detail_weight * draw.detail.z), normal_z(dxy)) * vec3f(-1.0, -1.0, 1.0);
			let b1 = tn + vec3f(0.0, 0.0, 1.0);
			tn = b1 * dot(b1, d) / max(1e-5, b1.z) - d;
		}
		var t = normalize(in.tangent.xyz - n * dot(in.tangent.xyz, n));
		var b = cross(in.normal, in.tangent.xyz) * in.tangent.w;
		if (!towards_viewer) {
			b = -b;
		}
		b = normalize(b - n * dot(b, n));
		n = normalize(t * tn.x + b * tn.y + n * tn.z);
		if ((flags & NORMAL_ROUGHNESS) != 0u) {
			roughness = mix(draw.surface.x, draw.surface.y, packed.b);
		}
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
	if ((flags & parallax_maps) == parallax_maps && in.tangent.w != 0.0) {
		// the glow's mask uses the same channel numbering as the emission mask, one lower
		let glow_mask = map_channel(flags, draw.parallax_color.w + 1.0, base_a, packed, mask);
		if (glow_mask > 0.01) {
			let v = normalize(-in.rel);
			s.emission += parallax_glow(draw, in, v, n, parallax_uv, uv0_dx, uv0_dy, parallax_dx, parallax_dy) *
				(glow_mask * glow_mask);
		}
	}

	if ((flags & FOLIAGE) != 0u) {
		s.transmission = draw.surface2.z;
	}
	return shade_surface(s, in.rel, in.position.xy);
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
// hit between the last two steps, and colour it from the pattern's G; then the Fresnel power and the pulse.
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
	let color = mix(draw.parallax_dark.rgb, draw.parallax_color.rgb, pattern) * fresnel * pulse;
	return clamp(color, vec3f(0.0), vec3f(1000.0)) * mix(1.0, frame.ambient.y, draw.parallax2.z);
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
