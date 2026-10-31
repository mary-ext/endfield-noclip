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
	// the page's world minimum corner x, z; the eye's world y; detail slot + 1 (0: none), as bits
	detail: vec4f,
}

// one close-up material layer; see `TerrainLayerInfo`
struct Layer {
	// repeats per metre, uv offset, normal xy scale
	tiling: vec4f,
	// diffuse rgb scale, height-blend border
	diffuse: vec4f,
	// mean albedo rgb (the tint's reference), texture index
	mean: vec4f,
	// height scale and offset, occlusion scale and offset
	remap0: vec4f,
	// roughness scale and offset
	remap1: vec4f,
}

@group(1) @binding(0) var<storage, read> heights: array<u32>;
@group(1) @binding(1) var<storage, read> patches: array<Patch>;
// baked surface pages: albedo rgb (linear); normal rg = world x, z, b roughness, a occlusion
@group(1) @binding(2) var surface_albedo: texture_2d_array<f32>;
@group(1) @binding(3) var surface_normal: texture_2d_array<f32>;
@group(1) @binding(4) var surface_sampler: sampler;
// splat pages: splat control (rgb weights, slot 3 the remainder) and tint (rgb, weight a⁴)
@group(1) @binding(5) var detail_control: texture_2d_array<f32>;
@group(1) @binding(6) var detail_tint: texture_2d_array<f32>;
// layer textures: diffuse rgb + height a; normal xy, roughness b, occlusion a
@group(1) @binding(7) var layer_diffuse: texture_2d_array<f32>;
@group(1) @binding(8) var layer_normal: texture_2d_array<f32>;
// per detail slot, 8 × 8 cells of 4 layer ordinals packed into a u32
@group(1) @binding(9) var<storage, read> detail_index: array<u32>;
@group(1) @binding(10) var<storage, read> layers: array<Layer>;
@group(1) @binding(11) var layer_sampler: sampler;

// samples per page edge, from `PAGE_SIDE`
override SIDE: i32 = 65;
override LAST: i32 = SIDE - 1;
// two samples per word
override PAGE_WORDS: u32 = (u32(SIDE * SIDE) + 1u) / 2u;
// vertices per grid edge
override GRID: u32 = u32(LAST) / 2u + 1u;

// splat page layout, from `SURFACE_SIDE` and `SURFACE_BORDER`: 2 texels of border around 128 per 64 m
const PAGE_TEXELS = 132.0;
const PAGE_BORDER = 2.0;
const LEAF_METRES = 64.0;
const CELL_METRES = 8.0;
const CELLS = 8u;
// detail fades into the baked pages over this distance range, m; `DETAIL_DISTANCE` loads beyond it
const DETAIL_FADE_START = 96.0;
const DETAIL_FADE_END = 144.0;
const EPSILON = 6.103515625e-05;
// puddle depth (level above the ground) at which a puddle is fully wet; the baked pages' ground is 0.5
const PUDDLE_FULL = 0.46;
const BAKED_GROUND = 0.5;

struct VertexOut {
	@builtin(position) position: vec4f,
	@location(0) rel: vec3f,
	@location(1) normal: vec3f,
	@location(2) hole: f32,
	@location(3) @interpolate(flat) level: u32,
	@location(4) surface_uv: vec2f,
	@location(5) @interpolate(flat) surface: u32,
	// metres from the page's minimum corner
	@location(6) local: vec2f,
	@location(7) world: vec3f,
	@location(8) @interpolate(flat) detail: u32,
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

	let local = m * spacing;
	let rel = vec3f(p.origin.x + local.x, h, p.origin.y + local.y);
	var out: VertexOut;
	out.position = frame.view_proj * vec4f(rel, 1.0);
	out.rel = rel;
	out.normal = normal;
	out.hole = hole;
	out.level = u32(p.origin.w);
	out.surface_uv = (rel.xz - p.surface.xy) * p.surface.z + p.surface.w;
	out.surface = p.info.w;
	out.local = local;
	out.world = vec3f(p.detail.x + local.x, h + p.detail.z, p.detail.y + local.y);
	out.detail = bitcast<u32>(p.detail.w);
	return out;
}

// stand-in ground colours for patches without a surface page
fn stand_in_albedo(n: vec3f) -> vec3f {
	let grass = vec3f(0.13, 0.19, 0.07);
	let rock = vec3f(0.24, 0.22, 0.2);
	return mix(rock, grass, smoothstep(0.72, 0.86, n.y));
}

// world-position derivatives, taken in uniform control flow so layer samples can branch
struct Footprint {
	world: vec3f,
	dx: vec3f,
	dy: vec3f,
	// triplanar weights of the x, y and z projections
	axes: vec3f,
}

// one layer texture, projected on the axes that carry weight (the game picks one axis per pixel at random;
// without temporal smoothing a weighted blend reads better)
fn sample_layer(tex: texture_2d_array<f32>, layer: Layer, f: Footprint) -> vec4f {
	let k = layer.tiling.x;
	let offset = layer.tiling.yz;
	let index = u32(layer.mean.w);
	var sum = vec4f(0.0);
	var weight = 0.0;
	if (f.axes.y > 0.02) {
		sum += f.axes.y * textureSampleGrad(tex, layer_sampler, f.world.xz * k + offset, index, f.dx.xz * k, f.dy.xz * k);
		weight += f.axes.y;
	}
	if (f.axes.x > 0.02) {
		sum += f.axes.x * textureSampleGrad(tex, layer_sampler, f.world.zy * k + offset, index, f.dx.zy * k, f.dy.zy * k);
		weight += f.axes.x;
	}
	if (f.axes.z > 0.02) {
		sum += f.axes.z * textureSampleGrad(tex, layer_sampler, f.world.xy * k + offset, index, f.dx.xy * k, f.dy.xy * k);
		weight += f.axes.z;
	}
	return sum / max(weight, EPSILON);
}

fn leaf_local(in: VertexOut) -> vec2f {
	return clamp(in.local, vec2f(0.0), vec2f(LEAF_METRES - 0.001));
}

// the leaf's splat control: rgb weight a cell's slots 0–2, a is the puddle level. the weights belong to the
// cell's layers, so filtering stays half a texel inside the cell
fn sample_control(slot: u32, local: vec2f) -> vec4f {
	let cell = floor(local / CELL_METRES);
	let inside = clamp(fract(local / CELL_METRES), vec2f(1.0 / 32.0), vec2f(31.0 / 32.0));
	let texels_per_cell = (PAGE_TEXELS - 2.0 * PAGE_BORDER) / f32(CELLS);
	let uv = (PAGE_BORDER + (cell + inside) * texels_per_cell) / PAGE_TEXELS;
	return textureSampleLevel(detail_control, surface_sampler, uv, slot, 0.0);
}

struct Detail {
	surface: Surface,
	// the layers' height under the splat weights, which puddles fill up to
	height: f32,
}

// the close-up layer blend of one leaf: 4 layers per 8 m cell, weighted by the splat control and a height
// blend, then tinted. `base` is the baked surface, whose normal orients the layers' normal maps
fn detail_surface(in: VertexOut, base: Surface, f: Footprint, control: vec4f) -> Detail {
	let slot = in.detail - 1u;
	let local = leaf_local(in);
	let cell = vec2u(local / CELL_METRES);
	let ordinals = unpack4xU8(detail_index[slot * CELLS * CELLS + cell.y * CELLS + cell.x]);
	let weights = vec4f(control.rgb, clamp(1.0 - control.r - control.g - control.b, 0.0, 1.0));
	let page_uv = (PAGE_BORDER + local * ((PAGE_TEXELS - 2.0 * PAGE_BORDER) / LEAF_METRES)) / PAGE_TEXELS;
	let tint = textureSampleLevel(detail_tint, surface_sampler, page_uv, slot, 0.0);

	var diffuse: array<vec4f, 4>;
	var packed: array<vec4f, 4>;
	var heights = vec4f(0.0);
	var borders = vec4f(EPSILON);
	for (var i = 0u; i < 4u; i++) {
		if (weights[i] <= 0.0) {
			continue;
		}
		let layer = layers[ordinals[i]];
		diffuse[i] = sample_layer(layer_diffuse, layer, f);
		packed[i] = sample_layer(layer_normal, layer, f);
		heights[i] = diffuse[i].a * layer.remap0.x + layer.remap0.y;
		borders[i] = max(layer.diffuse.w, EPSILON);
	}
	// height blend: layers more than their border below the highest weighted height drop out
	let weighted = heights * weights;
	let peak = max(max(weighted.x, weighted.y), max(weighted.z, weighted.w));
	let raw = (max(vec4f(0.0), weighted - peak + borders) + EPSILON) * weights;
	let blend = raw / max(dot(raw, vec4f(1.0)), EPSILON);

	var albedo = vec3f(0.0);
	var mean = vec3f(0.0);
	var tangent_normal = vec3f(0.0);
	var roughness = 0.0;
	var occlusion = 0.0;
	for (var i = 0u; i < 4u; i++) {
		if (blend[i] <= 0.0) {
			continue;
		}
		let layer = layers[ordinals[i]];
		albedo += blend[i] * diffuse[i].rgb * layer.diffuse.rgb;
		mean += blend[i] * layer.mean.rgb;
		let xy = packed[i].xy * 2.0 - 1.0;
		let z = max(EPSILON, sqrt(1.0 - clamp(dot(xy, xy), 0.0, 1.0)));
		tangent_normal += blend[i] * vec3f(xy * layer.tiling.w, z);
		roughness += blend[i] * (packed[i].z * layer.remap1.x + layer.remap1.y);
		occlusion += blend[i] * (packed[i].w * layer.remap0.z + layer.remap0.w);
	}
	// the tint shifts the blend's colour away from the layers' mean, by a⁴
	let t2 = tint.a * tint.a;
	albedo += t2 * t2 * (tint.rgb - mean);

	// the layers' normal maps are oriented on the baked normal, x along +X and y along +Z on flat ground
	let nb = base.normal;
	let c = cross(nb, vec3f(0.0, 0.0, 1.0));
	let t = select(c * inverseSqrt(dot(c, c)), vec3f(1.0, 0.0, 0.0), dot(c, c) < 1e-8);
	let b = cross(t, nb);
	var s = base;
	s.albedo = max(albedo, vec3f(0.0));
	s.normal = normalize(t * tangent_normal.x + b * tangent_normal.y + nb * tangent_normal.z);
	s.roughness = clamp(roughness, 0.0, 1.0);
	s.occlusion = clamp(occlusion, 0.0, 1.0);
	return Detail(s, dot(heights, weights));
}

// standing water where the puddle level rises above the ground: darker, mirror-smooth and flat
// (docs/game-data/world.md#puddles)
fn wet_surface(s: Surface, depth: f32) -> Surface {
	let w = clamp(depth / PUDDLE_FULL, 0.0, 1.0);
	var out = s;
	out.albedo = s.albedo * mix(1.0, 0.65, w);
	out.occlusion = s.occlusion * mix(1.0, 0.9, w);
	out.roughness = mix(s.roughness, 0.0, w);
	out.normal = normalize(mix(s.normal, vec3f(0.0, 1.0, 0.0), w * 0.98));
	return out;
}

@fragment
fn fs_main(in: VertexOut) -> Shaded {
	var f: Footprint;
	f.world = in.world;
	// the layers' footprint at the output's pixel density (the mip bias, as gradients)
	let bias = exp2(frame.params.y);
	f.dx = dpdx(in.world) * bias;
	f.dy = dpdy(in.world) * bias;
	if (in.hole > 0.01) {
		discard;
	}
	var s: Surface;
	if (in.surface == 0u) {
		let n = normalize(in.normal);
		s = default_surface(stand_in_albedo(n), n);
		s.roughness = 0.9;
	} else {
		let layer = in.surface - 1u;
		let albedo = textureSampleLevel(surface_albedo, surface_sampler, in.surface_uv, layer, 0.0);
		let packed = textureSampleLevel(surface_normal, surface_sampler, in.surface_uv, layer, 0.0);
		let xz = packed.xy * 2.0 - 1.0;
		let n = normalize(vec3f(xz.x, sqrt(max(1.0 - dot(xz, xz), 0.0)), xz.y));
		s = default_surface(albedo.rgb, n);
		s.roughness = packed.z;
		s.occlusion = packed.w;
	}
	if (in.detail != 0u) {
		let control = sample_control(in.detail - 1u, leaf_local(in));
		// puddles fill to the control's alpha: over the layers' height close up, over a flat ground far away
		var ground = BAKED_GROUND;
		let fade = 1.0 - smoothstep(DETAIL_FADE_START, DETAIL_FADE_END, length(in.rel));
		if (fade > 0.0) {
			let a = pow(abs(s.normal), vec3f(8.0));
			f.axes = a / (a.x + a.y + a.z + EPSILON);
			let d = detail_surface(in, s, f, control);
			s.albedo = mix(s.albedo, d.surface.albedo, fade);
			s.normal = normalize(mix(s.normal, d.surface.normal, fade));
			s.roughness = mix(s.roughness, d.surface.roughness, fade);
			s.occlusion = mix(s.occlusion, d.surface.occlusion, fade);
			ground = mix(ground, d.height, fade);
		}
		s = wet_surface(s, control.a - ground);
	}
	s = rain_wet_surface(s, in.rel);
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
