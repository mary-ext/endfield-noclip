// CDLOD terrain: one instanced draw of a grid of half a page's quads per side; each instance is a quadrant of
// a SIDE×SIDE height page.

struct Patch {
	// x, z of the page's minimum corner relative to the eye; sample spacing (m); level
	origin: vec4f,
	// height pool slot, quadrant offset x and z (samples), surface layer + 1 (0: none)
	info: vec4u,
	// morph start and end distance (m); morphing is off when start ≥ end
	morph: vec4f,
	// surface page uv = (rel.xz − xy) · z + w; the page may be an ancestor's
	surface: vec4f,
}

@group(1) @binding(0) var<storage, read> heights: array<u32>;
@group(1) @binding(1) var<storage, read> patches: array<Patch>;
// baked surface pages: albedo rgb (linear); normal rg = world x, z, b roughness, a occlusion
@group(1) @binding(2) var surface_albedo: texture_2d_array<f32>;
@group(1) @binding(3) var surface_normal: texture_2d_array<f32>;
@group(1) @binding(4) var surface_sampler: sampler;

// samples per page edge, from `PAGE_SIDE`
override SIDE: i32 = 65;
override LAST: i32 = SIDE - 1;
// two samples per word
override PAGE_WORDS: u32 = (u32(SIDE * SIDE) + 1u) / 2u;
// vertices per grid edge
override GRID: u32 = u32(LAST) / 2u + 1u;

struct VertexOut {
	@builtin(position) position: vec4f,
	@location(0) rel: vec3f,
	@location(1) normal: vec3f,
	@location(2) hole: f32,
	@location(3) @interpolate(flat) level: u32,
	@location(4) surface_uv: vec2f,
	@location(5) @interpolate(flat) surface: u32,
}

fn raw_sample(slot: u32, x: i32, z: i32) -> u32 {
	let i = u32(clamp(z, 0, LAST) * SIDE + clamp(x, 0, LAST));
	let word = heights[slot * PAGE_WORDS + i / 2u];
	return (word >> ((i & 1u) * 16u)) & 0xffffu;
}

fn hole_bit() -> u32 {
	return bitcast<u32>(frame.terrain.z);
}

fn height_of(raw: u32) -> f32 {
	return frame.terrain.x + f32(raw & (hole_bit() - 1u)) * frame.terrain.y;
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexOut {
	let p = patches[ii];
	let slot = p.info.x;
	let spacing = p.origin.z;
	let g = vec2i(i32(vi % GRID + p.info.y), i32(vi / GRID + p.info.z));

	// distance of the unmorphed vertex decides the morph factor
	let h0 = raw_sample(slot, g.x, g.y);
	let pos0 = vec3f(p.origin.x + f32(g.x) * spacing, height_of(h0), p.origin.y + f32(g.y) * spacing);
	var k = 0.0;
	if (p.morph.x < p.morph.y) {
		k = clamp((length(pos0) - p.morph.x) / (p.morph.y - p.morph.x), 0.0, 1.0);
	}

	// odd samples slide towards the coarser grid; heights interpolate along the slid edge
	let odd = vec2f(vec2i(g.x & 1, g.y & 1));
	let m = vec2f(g) - odd * k;
	let i0 = vec2i(floor(m));
	let t = m - floor(m);
	let s00 = raw_sample(slot, i0.x, i0.y);
	let s10 = raw_sample(slot, i0.x + 1, i0.y);
	let s01 = raw_sample(slot, i0.x, i0.y + 1);
	let s11 = raw_sample(slot, i0.x + 1, i0.y + 1);
	let h = mix(
		mix(height_of(s00), height_of(s10), t.x),
		mix(height_of(s01), height_of(s11), t.x),
		t.y,
	);
	var hole = 0.0;
	if (((s00 | select(0u, s10, t.x > 0.0) | select(0u, s01, t.y > 0.0) | select(0u, s11, t.x > 0.0 && t.y > 0.0)) & hole_bit()) != 0u) {
		hole = 1.0;
	}

	// normal from central differences of the fine samples
	let hl = height_of(raw_sample(slot, g.x - 1, g.y));
	let hr = height_of(raw_sample(slot, g.x + 1, g.y));
	let hd = height_of(raw_sample(slot, g.x, g.y - 1));
	let hu = height_of(raw_sample(slot, g.x, g.y + 1));
	let normal = normalize(vec3f(hl - hr, 2.0 * spacing, hd - hu));

	let rel = vec3f(p.origin.x + m.x * spacing, h, p.origin.y + m.y * spacing);
	var out: VertexOut;
	out.position = frame.view_proj * vec4f(rel, 1.0);
	out.rel = rel;
	out.normal = normal;
	out.hole = hole;
	out.level = u32(p.origin.w);
	out.surface_uv = (rel.xz - p.surface.xy) * p.surface.z + p.surface.w;
	out.surface = p.info.w;
	return out;
}

// stand-in ground colours for patches without a surface page
fn stand_in_albedo(n: vec3f) -> vec3f {
	let grass = vec3f(0.13, 0.19, 0.07);
	let rock = vec3f(0.24, 0.22, 0.2);
	return mix(rock, grass, smoothstep(0.72, 0.86, n.y));
}

@fragment
fn fs_main(in: VertexOut) -> Shaded {
	if (in.hole > 0.01) {
		discard;
	}
	if (in.surface == 0u) {
		let n = normalize(in.normal);
		var s = default_surface(stand_in_albedo(n), n);
		s.roughness = 0.9;
		return shade_surface(s, in.rel, in.position.xy);
	}
	// the baked pages as stored; the close-up layer blend isn't drawn
	let layer = in.surface - 1u;
	let albedo = textureSampleLevel(surface_albedo, surface_sampler, in.surface_uv, layer, 0.0);
	let packed = textureSampleLevel(surface_normal, surface_sampler, in.surface_uv, layer, 0.0);
	let xz = packed.xy * 2.0 - 1.0;
	let n = normalize(vec3f(xz.x, sqrt(max(1.0 - dot(xz, xz), 0.0)), xz.y));
	var s = default_surface(albedo.rgb, n);
	s.roughness = packed.z;
	s.occlusion = packed.w;
	return shade_surface(s, in.rel, in.position.xy);
}

@fragment
fn fs_wire(in: VertexOut) -> Shaded {
	if (in.hole > 0.01) {
		discard;
	}
	return unlit(mix(vec3f(0.02), hue(f32(in.level) * 0.17) * 0.6, 0.5));
}

@fragment
fn fs_shadow(in: VertexOut) {
	if (in.hole > 0.01) {
		discard;
	}
}
