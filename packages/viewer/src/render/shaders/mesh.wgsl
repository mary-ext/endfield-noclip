// instanced meshes with their base colour texture: quantized positions, octahedral normals and UV set 0 from
// the geometry blob, instances from this frame's visible list, draw parameters by the list entry's draw id. a
// simple stand-in for the game's material families (no normal/MRO maps yet).

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
	// dequantization: position = offset.xyz + value · scale.xyz; offset.w = 1 when the base colour texture is bound
	offset: vec4f,
	scale: vec4f,
	// material tint (linear); w = alpha-test threshold, negative without alpha testing
	colour: vec4f,
	// base colour UV transform: uv · xy + zw
	uv: vec4f,
}

@group(1) @binding(0) var<storage, read> rows: array<Row>;
@group(1) @binding(1) var<storage, read> blocks: array<vec4f>;
@group(1) @binding(2) var<storage, read> list: array<u32>;
@group(2) @binding(0) var<storage, read> draws: array<Draw>;
// per visible-list entry: its index into `draws`
@group(2) @binding(1) var<storage, read> draw_ids: array<u32>;
@group(3) @binding(0) var base_colour: texture_2d<f32>;
@group(3) @binding(1) var base_sampler: sampler;

struct VertexIn {
	@location(0) position: vec4f,
	@location(1) normal: vec2f,
	@location(2) uv: vec2f,
}

struct VertexOut {
	@builtin(position) position: vec4f,
	@location(0) rel: vec3f,
	@location(1) normal: vec3f,
	@location(2) @interpolate(flat) colour: vec3f,
	@location(3) uv: vec2f,
	// x = 1 when the base colour texture is bound, y = alpha-test threshold
	@location(4) @interpolate(flat) material: vec2f,
}

fn oct_decode(e: vec2f) -> vec3f {
	var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
	if (n.z < 0.0) {
		let s = select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
		n = vec3f((1.0 - abs(n.yx)) * s, n.z);
	}
	return n;
}

@vertex
fn vs_main(v: VertexIn, @builtin(instance_index) ii: u32) -> VertexOut {
	let row = rows[list[ii]];
	let draw = draws[draw_ids[ii]];
	let tag = row.info & 0xffu;
	let p = draw.offset.xyz + v.position.xyz * draw.scale.xyz;
	let rel = vec3f(
		dot(row.t0.xyz, p) + row.t0.w,
		dot(row.t1.xyz, p) + row.t1.w,
		dot(row.t2.xyz, p) + row.t2.w,
	) + blocks[row.block].xyz;
	// no normals in the mesh: zero here, faceted in the fragment shader
	var n = vec3f(0.0);
	if (any(v.normal != vec2f(0.0))) {
		let local = oct_decode(v.normal);
		n = vec3f(dot(row.t0.xyz, local), dot(row.t1.xyz, local), dot(row.t2.xyz, local));
	}
	var out: VertexOut;
	out.position = frame.view_proj * vec4f(rel, 1.0);
	out.rel = rel;
	out.normal = n;
	out.uv = v.uv * draw.uv.xy + draw.uv.zw;
	out.material = vec2f(draw.offset.w, draw.colour.w);
	if (frame.flags.x == 1u) {
		out.colour = tag_colour(tag);
	} else {
		out.colour = draw.colour.rgb;
	}
	return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
	// derivatives (and implicit-LOD sampling) must happen in uniform control flow
	let faceted = cross(dpdy(in.rel), dpdx(in.rel));
	let texel = textureSample(base_colour, base_sampler, in.uv);
	var albedo = in.colour;
	if (in.material.x > 0.5) {
		if (texel.a < in.material.y) {
			discard;
		}
		albedo *= texel.rgb;
	}
	var n = in.normal;
	if (dot(n, n) < 1e-6) {
		n = faceted;
	}
	n = normalize(n);
	// culling is off (mirrored instances flip winding), so light back faces from the viewer's side
	if (dot(n, in.rel) > 0.0) {
		n = -n;
	}
	return to_display(shade(albedo, n, in.rel));
}

