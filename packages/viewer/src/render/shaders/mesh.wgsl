// instanced meshes with the HGRP surface essentials: base colour, tangent-space normal map, roughness from
// the normal map's B channel or an MRO map, emission. quantized positions, octahedral normals and tangents
// and UV set 0 from the geometry blob; instances from this frame's visible list; draw parameters by the list
// entry's draw id (see materials.ts for their layout).

struct Row {
	t0: vec4f,
	t1: vec4f,
	t2: vec4f,
	centre: vec3f,
	block: u32,
	extent: vec3f,
	info: u32,
}

struct Draw {
	// dequantization: position = offset.xyz + value · scale.xyz; offset.w = look flags (u32 bits)
	offset: vec4f,
	scale: vec4f,
	// linear tint, w = alpha-test threshold (negative without alpha testing)
	tint: vec4f,
	// UV transforms (uv · xy + zw) of the base colour, normal, mask and emissive slots
	base_uv: vec4f,
	normal_uv: vec4f,
	mask_uv: vec4f,
	emissive_uv: vec4f,
	// roughness min, roughness max, metallic, normal scale
	surface: vec4f,
	// occlusion strength, f0, transmission, base colour brighter scale
	surface2: vec4f,
	// emissive colour (linear), w = how much the tint covers the base colour
	emissive: vec4f,
	// x = how little the albedo tints emission (1: not at all), y = the emission mask channel, z = 1 when
	// emission ignores the post exposure
	emission2: vec4f,
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
// set per draw from the geometry's streams (`GeometryFlags` in mesh-renderer.ts)
const HAS_NORMALS = 512u;
const HAS_TANGENTS = 1024u;

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
@group(3) @binding(4) var base_sampler: sampler;
@group(3) @binding(5) var detail_sampler: sampler;

struct VertexIn {
	@location(0) position: vec4f,
	@location(1) normal: vec2f,
	@location(2) uv: vec2f,
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
	@location(3) uv: vec2f,
	@location(4) @interpolate(flat) draw: u32,
}

@vertex
fn vs_main(v: VertexIn, @builtin(instance_index) ii: u32) -> VertexOut {
	let row = rows[list[ii]];
	let draw_id = draw_ids[ii];
	let draw = draws[draw_id];
	let p = draw.offset.xyz + v.position.xyz * draw.scale.xyz;
	let rel = vec3f(
		dot(row.t0.xyz, p) + row.t0.w,
		dot(row.t1.xyz, p) + row.t1.w,
		dot(row.t2.xyz, p) + row.t2.w,
	) + blocks[row.block].xyz;
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
	var out: VertexOut;
	out.position = frame.view_proj * vec4f(rel, 1.0);
	out.rel = rel;
	out.normal = n;
	out.tangent = t;
	out.uv = v.uv;
	out.draw = draw_id;
	return out;
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
	let base = textureSample(base_map, base_sampler, in.uv * draw.base_uv.xy + draw.base_uv.zw);
	let packed = textureSample(normal_map, detail_sampler, in.uv * draw.normal_uv.xy + draw.normal_uv.zw);
	let mask = textureSample(mask_map, detail_sampler, in.uv * draw.mask_uv.xy + draw.mask_uv.zw);
	let glow = textureSample(emissive_map, base_sampler, in.uv * draw.emissive_uv.xy + draw.emissive_uv.zw);

	var albedo = clamp(base.rgb * draw.surface2.w, vec3f(0.0), vec3f(1.0));
	if ((flags & BASE_MAP) == 0u) {
		albedo = vec3f(1.0);
	}
	albedo = mix(albedo, draw.tint.rgb, draw.emissive.w);

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
	if ((flags & NORMAL_MAP) != 0u && in.tangent.w != 0.0) {
		var xy = packed.rg * 2.0 - 1.0;
		if ((flags & NORMAL_RAG) != 0u) {
			xy.x = (packed.r * packed.a) * 2.0 - 1.0;
		}
		let z = sqrt(max(1.0 - dot(xy, xy), 0.0));
		xy *= draw.surface.w;
		var t = normalize(in.tangent.xyz - n * dot(in.tangent.xyz, n));
		var b = cross(in.normal, in.tangent.xyz) * in.tangent.w;
		if (!towards_viewer) {
			b = -b;
		}
		b = normalize(b - n * dot(b, n));
		n = normalize(t * xy.x + b * xy.y + n * z);
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
		s.metallic = select(0.0, base.a, (flags & BASE_MAP) != 0u);
	}
	if ((flags & (NORMAL_MAP | NORMAL_OCCLUSION)) == (NORMAL_MAP | NORMAL_OCCLUSION)) {
		s.occlusion = mix(1.0, packed.a, draw.surface2.x);
	}
	if ((flags & MASK_MAP) != 0u) {
		s.metallic = mask.r;
		s.roughness = mix(draw.surface.x, draw.surface.y, mask.g);
		s.occlusion = mix(1.0, mask.b, draw.surface2.x);
	}
	var emission = 0.0;
	if ((flags & EMISSIVE_MAP) != 0u) {
		emission = glow.r;
	}
	if ((flags & EMISSIVE_MASK) != 0u) {
		// mask channel 1 is the base colour's alpha. in the two-texture layout 2 is the normal map's B and 3 its
		// alpha; with an MRO map 2 is the base alpha too and 3 the MRO map's alpha. a map still streaming reads 0
		let channel = draw.emission2.y;
		let base_a = select(0.0, base.a, (flags & BASE_MAP) != 0u);
		var m: f32;
		if ((flags & NORMAL_OCCLUSION) != 0u) {
			let has_normal = (flags & NORMAL_MAP) != 0u;
			let b = select(0.0, packed.b, has_normal);
			let a = select(0.0, packed.a, has_normal);
			m = mix(mix(base_a, b, saturate(channel - 1.0)), a, saturate(channel - 2.0));
		} else {
			m = mix(base_a, select(0.0, mask.a, (flags & MASK_MAP) != 0u), saturate(channel - 2.0));
		}
		emission = saturate((m - 0.05) / 0.9);
	}
	// emission is in the pre-exposed units of the light already. emitters that ignore the post exposure divide
	// it out, so they keep their brightness however the exposure adapts
	let tint = mix(albedo, vec3f(1.0), draw.emission2.x);
	s.emission = draw.emissive.rgb * emission * tint * mix(1.0, frame.ambient.y, draw.emission2.z);
	if ((flags & FOLIAGE) != 0u) {
		s.transmission = draw.surface2.z;
	}
	return shade_surface(s, in.rel, in.position.xy);
}

// the depth of alpha-tested materials, in the main pass and the shadow passes (opaque ones have no fragment
// stage there). only drawn for materials with an alpha-test threshold whose base colour is bound (`cutout`
// in materials.ts and MeshRenderer.prepare)
@fragment
fn fs_cutout_depth(in: VertexOut) {
	let draw = draws[in.draw];
	let base = textureSample(base_map, base_sampler, in.uv * draw.base_uv.xy + draw.base_uv.zw);
	if (base.a < draw.tint.w) {
		discard;
	}
}
