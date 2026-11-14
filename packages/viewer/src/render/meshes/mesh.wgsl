// instanced meshes with the HGRP surface shaders (looks/, docs/game-data/materials.md): Lit and its
// layers, foliage, glass, matte paintings, erosion and VFXDitherAlpha, opaque, alpha-tested or
// alpha-blended. quantized positions, octahedral normals and tangents, UV sets 0 and 1 and vertex colours from
// the geometry blob; instances from this frame's visible list; draw parameters by the list entry's draw id,
// and the material's parameters by the draw's look slot (`LookRow` in look.ts lays them out).

struct Draw {
	// dequantization: position = offset.xyz + value · scale.xyz; offset.w = look flags (u32 bits)
	offset: vec4f,
	// w = the material's slot in `looks` (u32 bits)
	scale: vec4f,
	// UV sets 0 and 1: uv = value · xy + zw
	uv0: vec4f,
	uv1: vec4f,
}

// a material's parameters, `LOOK_FLOATS` in look.ts
struct Look {
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
	// the tri-channel mask's R, G and B: linear colour, strength. leaves: `_BLEND_COLOR` (`LeafBlendRow` in
	// lit-look.ts)
	mask_albedo: array<vec4f, 3>,
	// per mask channel (xyz): the roughness and metallic it blends toward, its contrast and offset.
	// `mask_offset.w` is 1 when the mask sits in the emissive slot
	mask_roughness: vec4f,
	mask_metallic: vec4f,
	mask_scale: vec4f,
	mask_offset: vec4f,
	// detail mode (0 colour overlay, 1 PBR), mask mode, normal intensity, PBR intensity
	detail: vec4f,
	// view depths where the detail starts and finishes fading, overlay brighter scale (transparent looks: 1 for
	// premultiplied blending), 1 when the surface keeps lit decals off
	detail2: vec4f,
	// overlay colour (linear), how much it covers
	detail_overlay: vec4f,
	// parallax depth, march steps, Fresnel power, pulse amplitude. without parallax or layer maps, this row and
	// the next hold `_EMISSIVE_ANIM`'s pulse (`emissive_pulse`)
	parallax: vec4f,
	// pulse phase per second, pulse phase per metre of the object's position, 1 when the glow ignores the post
	// exposure, pulse mean
	parallax2: vec4f,
	// bright colour, w = mask channel. with a vertex offset, this row and the next two hold its inputs
	// (`VertexOffsetRow` in lit-look.ts)
	parallax_color: vec4f,
	// dark colour
	parallax_dark: vec4f,
	// brightening near the player: outer radius, inner radius, strength
	parallax_bright: vec4f,
	// leaves (`leafParams` in lit-look.ts): how much the vertex AO shadows the sun, the fake directional
	// shadow's strength and power, 1 when the sun's N·L takes the vertex normal. Lit layers: the fuzzy shading's
	// core darkness, edge brightness, edge shadow range and offset. dithered VFXDitherAlpha (`DitherRow` in
	// special-looks.ts): the subsurface colour times its amount, the amount
	foliage: vec4f,
	// leaves: the vertex AO ranges fading transmission (xy: start, range) and subsurface (zw) in. Lit layers:
	// the fuzzy edge shadow's intensity, the dark and bright powers, the edge's normal strength. dithered
	// VFXDitherAlpha: the subsurface colour's share of the ambient light
	foliage_ao: vec4f,
	// leaves: subsurface intensity, 1 when transmission fades out with distance, canopy ramp intensity, 1 when
	// the ramp starts at the top
	foliage2: vec4f,
	// leaves: canopy ramp range, transition range, colour brighter scale, colour cover. dithered VFXDitherAlpha
	// (`DitherRow` in special-looks.ts): alpha scale, exponent, dither tiling, its `DitherFlags`.
	// trunks (`TrunkRow` in lit-look.ts): the ramp's range and transition range, vertex AO strength, ramp intensity
	canopy: vec4f,
	// leaves: canopy ramp colour (linear), then 1 for `_TwoSidedNormal`. trunks: the ramp's colour (linear)
	canopy_color: vec4f,
	// the HDR colours the emissive map's G, B and A add (rgb); effect looks use these rows and the rest for
	// their own (`EffectRow` in effects/effect-look.ts)
	emissive_channels: array<vec4f, 3>,
	// the per-draw albedo tint where the emission's strength is at least 0.1: linear colour, w = weight
	emissive_albedo: vec4f,
	effect_only: array<vec4f, 8>,
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
// `HGRP/Erosion` (`erosionLook` in special-looks.ts)
const EROSION = 33554432u;
// `HGRP/Foliage/Leaf` (`leafParams` in lit-look.ts)
const FOLIAGE_LEAF = 134217728u;
// a scene effect, drawn by effect.wgsl; its rows are laid out by looks/effects/
const EFFECT = 268435456u;
// `_USE_VERTOFFSET` (`vertexOffsetParams` in lit-look.ts): the parallax slots hold the vertex offset's texture
// and its mask, which the vertex stage samples
const VERTEX_OFFSET = 536870912u;
// `HGRP/Foliage/Trunk`'s `_FOLIAGE_TRUNK` (`trunkParams` in lit-look.ts): the canopy rows hold its vertex AO
// and ramp
const TRUNK = 1073741824u;
// `_LAYERBLEND_TOP` or `_LAYERBLEND_MASK` (`layerBlendParams` in lit-look.ts): the parallax slots and rows hold
// the layer, and a mask map sits in the emissive slot
const LAYER_BLEND = 2147483648u;
// what decides the layer's coverage (`LayerSource` in lit-look.ts)
const LAYER_SOURCE_TOP = 0.0;
const LAYER_SOURCE_MASK_MAP = 1.0;
// slot i samples UV set 1 when bit UV1_SHIFT + i is set
const UV1_SHIFT = 18u;
// set per draw from the geometry's streams (`GeometryFlags` in look.ts)
const HAS_NORMALS = 512u;
const HAS_TANGENTS = 1024u;
const HAS_COLORS = 67108864u;

// the bits of a dithered look's `canopy.w` (`DitherFlags` in special-looks.ts)
const DITHER_RED_ALPHA = 1u;
const DITHER_VERTEX_COLOR = 2u;
const DITHER_MASK = 4u;
const DITHER_MASK_RED = 8u;
const DITHER_SURFACE = 16u;

const BASE_SLOT = 0u;
const NORMAL_SLOT = 1u;
const MASK_SLOT = 2u;
const EMISSIVE_SLOT = 3u;
const DETAIL_SLOT = 4u;
const PARALLAX_SLOT = 5u;
const NOISE_SLOT = 6u;
// the layer's `_Layer1BaseMap`; `_Layer1BumpMap` is in the noise slot, with the same coordinates
const LAYER_SLOT = 5u;

@group(1) @binding(0) var<storage, read> rows: array<InstanceRow>;
@group(1) @binding(1) var<storage, read> blocks: array<vec4f>;
@group(1) @binding(2) var<storage, read> list: array<u32>;
@group(2) @binding(0) var<storage, read> draws: array<Draw>;
// per visible-list entry: its index into `draws`
@group(2) @binding(1) var<storage, read> draw_ids: array<u32>;
// written once per material, when it's first drawn
@group(2) @binding(5) var<storage, read> looks: array<Look>;

// a draw's index into `looks`
fn look_slot(draw: Draw) -> u32 {
	return bitcast<u32>(draw.scale.w);
}
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
// the noise slot's own sampler, for the vertex offset's mask and a dithered look's; the glow and the layers
// sample the slot with the parallax slot's
@group(3) @binding(10) var noise_sampler: sampler;

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
	let look = looks[look_slot(draw)];
	let p = draw.offset.xyz + v.position.xyz * draw.scale.xyz;
	let origin = vec3f(row.t0.w, row.t1.w, row.t2.w) + blocks[row_block(row.block)].xyz;
	let m = row_basis(row.t0, row.t1, row.t2, row.info);
	let flags = bitcast<u32>(draw.offset.w);
	let uv = vec4f(v.uv0 * draw.uv0.xy + draw.uv0.zw, v.uv1 * draw.uv1.xy + draw.uv1.zw);
	// as vs_cutout_depth computes it, so alpha-tested depth matches exactly where they're shaded
	let rel = instance_rel(v.position, ii, draw, look) + vertex_offset(flags, look, m, uv, v.position.w);
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
	out.uv = sheet_uv(row.sheet, uv);
	out.draw = draw_id;
	out.phase = world.x + world.y + world.z;
	out.object_y = p.y;
	out.color = select(vec4f(1.0), v.color, (flags & HAS_COLORS) != 0u) * unpack4x8unorm(row.color);
	out.origin = origin;
	return out;
}

// the depth-only stages read only the streams they need, so they bind fewer vertex buffers per geometry:
// positions for opaque shadow casters, plus the UV sets for alpha-tested depth
struct DepthIn {
	@location(0) position: vec4f,
}

struct CutoutDepthIn {
	@location(0) position: vec4f,
	@location(2) uv0: vec2f,
	@location(4) uv1: vec2f,
}

// the camera-relative position of a vertex of list entry `ii`; `position.w` is the geometry's sway weight
fn instance_rel(position: vec4f, ii: u32, draw: Draw, look: Look) -> vec3f {
	let row = rows[list[ii]];
	let p = draw.offset.xyz + position.xyz * draw.scale.xyz;
	let origin = vec3f(row.t0.w, row.t1.w, row.t2.w) + blocks[row_block(row.block)].xyz;
	let rel = row_basis(row.t0, row.t1, row.t2, row.info) * p + origin;
	let flags = bitcast<u32>(draw.offset.w);
	return rel + grass_lean(flags, look, p.y) + sway(flags, look, p, position.w, rel, origin);
}

// `_SIMPLE_VERTEXANIM_CLOTH`'s world-space offset (`swayParams` in lit-look.ts,
// docs/game-data/materials.md#swaying-cloth). `weight` is the vertex colour's alpha, which the geometry carries
// in position W
fn sway(flags: u32, look: Look, p: vec3f, weight: f32, rel: vec3f, origin: vec3f) -> vec3f {
	let intensity = look.foliage2.x;
	if (weight == 0.0 || intensity == 0.0 || (flags & (FOLIAGE | EROSION | UNLIT | EFFECT)) != 0u) {
		return vec3f(0.0);
	}
	let frequency = look.foliage2.y;
	let softness = look.foliage2.z;
	let kite = look.foliage2.w;
	let tendency = look.canopy_color.x;
	let along = select(frame.wind.zw, look.canopy_color.zw, look.canopy_color.y > 0.5);
	let phase = frame.wind.x * frequency + origin.x + frame.eye.x;
	var s: f32;
	var amplitude: f32;
	if (kite != 0.0) {
		amplitude = intensity * 0.05;
		s = sin(phase + mix(0.0, p.y * softness - weight * PI, kite)) * p.y;
	} else {
		amplitude = intensity * 0.5;
		s = sin(phase - (rel.z + frame.eye.z) * softness - weight * 3.14);
	}
	let offset = (s + 1.0 + tendency) * amplitude * weight;
	return vec3f(along.x, 0.0, along.y) * offset;
}

// `_USE_VERTOFFSET`'s world-space offset (`vertexOffsetParams` in lit-look.ts,
// docs/game-data/materials.md#vertex-offset): along a direction by a scrolling texture's red, scaled by a
// mask's. `basis` is the object's transform, `uv` the mesh's UV sets before the sheet remap, and `weight` the
// vertex colour's alpha, which the geometry carries in position W. only alpha-tested draws are offset, since
// only their depth and shadow passes read the UV sets and textures (vs_cutout_depth): a look's draws are
// alpha-tested exactly while the map holding its alpha is bound. the offset waits for its own textures too
fn vertex_offset(flags: u32, look: Look, basis: mat3x3f, uv: vec4f, weight: f32) -> vec3f {
	let alpha_map = select(BASE_MAP, NORMAL_MAP, (flags & ALPHA_NORMAL) != 0u);
	let needed = VERTEX_OFFSET | PARALLAX_MAP | alpha_map;
	let shape = look.parallax_dark;
	let masked = shape.w != 0.0;
	if ((flags & needed) != needed || (masked && (flags & PARALLAX_NOISE_MAP) == 0u)) {
		return vec3f(0.0);
	}
	let direction = look.parallax_color;
	let scroll = look.parallax_bright * frame.eye.w;
	// both textures sample one UV set, each through its own transform
	let source = slot_set(uv, flags, PARALLAX_SLOT);
	let noise_t = look.slot_uv[PARALLAX_SLOT];
	let mask_t = look.slot_uv[NOISE_SLOT];
	let noise_uv = source * noise_t.xy + noise_t.zw + scroll.xy;
	let noise = textureSampleLevel(parallax_map, parallax_sampler, noise_uv, 0.0).r;
	var scale = shape.x * (noise * (1.0 + shape.y) - shape.y);
	if (masked) {
		let mask_uv = source * mask_t.xy + mask_t.zw + scroll.zw;
		let mask = textureSampleLevel(parallax_noise_map, noise_sampler, mask_uv, 0.0).r;
		scale *= 1.0 - shape.w * (1.0 - mask);
	}
	if (shape.z > 0.5) {
		scale *= weight;
	}
	return select(basis * direction.xyz, direction.xyz, direction.w > 0.5) * scale;
}

// `_USE_CAMERA_BASED_TILLING` (`grassParams` in lit-look.ts): grass leans away from the camera along its up
// vector flattened onto the ground, by the vertex's object-space height times the intensity in world metres
fn grass_lean(flags: u32, look: Look, height: f32) -> vec3f {
	if ((flags & (FOLIAGE | FOLIAGE_LEAF)) != FOLIAGE) {
		return vec3f(0.0);
	}
	return vec3f(frame.view_up.x, 0.0, frame.view_up.z) * (height * look.foliage.y);
}

@vertex
fn vs_depth(v: DepthIn, @builtin(instance_index) ii: u32) -> @builtin(position) @invariant vec4f {
	let draw = draws[draw_ids[ii]];
	let look = looks[look_slot(draw)];
	return frame.view_proj * vec4f(instance_rel(v.position, ii, draw, look), 1.0);
}

// the opaque depth prepass writes depth alone; the targets' write masks are 0
@fragment
fn fs_depth() {}

// what fs_cutout_depth reads, at VertexOut's locations so vs_main can feed it too
struct CutoutDepthVaryings {
	@builtin(position) position: vec4f,
	@location(3) uv: vec4f,
	@location(4) @interpolate(flat) draw: u32,
	@location(7) color: vec4f,
}

struct CutoutDepthOut {
	@builtin(position) @invariant position: vec4f,
	@location(3) uv: vec4f,
	@location(4) @interpolate(flat) draw: u32,
	// the instance's colour (a particle's), without the mesh's vertex colours, whose stream these passes don't bind
	@location(7) color: vec4f,
}

@vertex
fn vs_cutout_depth(v: CutoutDepthIn, @builtin(instance_index) ii: u32) -> CutoutDepthOut {
	let draw_id = draw_ids[ii];
	let draw = draws[draw_id];
	let look = looks[look_slot(draw)];
	let row = rows[list[ii]];
	let m = row_basis(row.t0, row.t1, row.t2, row.info);
	let flags = bitcast<u32>(draw.offset.w);
	let uv = vec4f(v.uv0 * draw.uv0.xy + draw.uv0.zw, v.uv1 * draw.uv1.xy + draw.uv1.zw);
	// as vs_main computes it
	let rel = instance_rel(v.position, ii, draw, look) + vertex_offset(flags, look, m, uv, v.position.w);
	var out: CutoutDepthOut;
	out.position = frame.view_proj * vec4f(rel, 1.0);
	out.uv = sheet_uv(row.sheet, uv);
	out.draw = draw_id;
	out.color = unpack4x8unorm(row.color);
	return out;
}

// the UV set a slot samples, before its transform
fn slot_set(uv: vec4f, flags: u32, slot: u32) -> vec2f {
	return select(uv.xy, uv.zw, (flags & (1u << (UV1_SHIFT + slot))) != 0u);
}

// read through the buffer: arrays in a `let` copy can't be indexed by a variable
fn slot_uv(look_id: u32, uv: vec4f, flags: u32, slot: u32) -> vec2f {
	let t = looks[look_id].slot_uv[slot];
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

// reoriented normal mapping of a tangent-space normal, its x and y already negated, onto a base normal
fn reorient_normal(base: vec3f, flipped: vec3f) -> vec3f {
	let b = base + vec3f(0.0, 0.0, 1.0);
	return b * dot(b, flipped) / max(1e-5, b.z) - flipped;
}

// #region layer blend
// `_LAYERBLEND_TOP` and `_LAYERBLEND_MASK` (`layerBlendParams` in lit-look.ts, parameters by `LayerBlendRow`,
// which reuses the parallax rows: coverage in `parallax`, height and source in `parallax2`, colour in
// `parallax_color`, blend in `parallax_dark`, normal in `parallax_bright`; and the leaf rows `foliage` and
// `foliage_ao` for `_LAYERBLEND_MOSS`'s fuzzy shading)

// the top layer's coverage before the height blend, from the upward component of the normal
fn top_coverage(look: Look, up: f32) -> f32 {
	let coverage = look.parallax;
	return saturate((up - coverage.y) / coverage.z);
}

// the mask layer's coverage before the height blend, by its source (`LayerSource` in lit-look.ts): the mask
// map's R, the layer bump map's alpha, the base colour's alpha, the normal map's alpha, or everywhere
fn mask_coverage(source: f32, mask_r: f32, bump_a: f32, base_a: f32, normal_a: f32) -> f32 {
	switch (u32(source + 0.5)) {
		case 1u: {
			return mask_r;
		}
		case 2u: {
			return bump_a;
		}
		case 3u: {
			return base_a;
		}
		case 4u: {
			return normal_a;
		}
		default: {
			return 1.0;
		}
	}
}

// how much the layer covers, from its raw coverage and the layer's height (`layer_a`)
fn layer_coverage(look: Look, raw: f32, layer_a: f32) -> f32 {
	let height = look.parallax2;
	let cover = saturate(raw);
	if (height.x == 0.0) {
		return cover;
	}
	// each side's height, weighted by its coverage; the higher one wins within the transition
	let weights = vec2f(1.0 - cover, cover);
	let heights = weights * vec2f(height.z, layer_a);
	let w = (max(vec2f(0.0), heights + height.y - max(heights.x, heights.y)) + 1e-6) * weights;
	return w.y / max(1.175494e-38, w.x + w.y);
}

// `_LAYERBLEND_MOSS`: 1 along the coverage edge the edge shadow offset picks, falling off over its range
fn layer_fuzzy_edge(look: Look, raw: f32) -> f32 {
	let d = raw - look.foliage.w;
	return saturate(1.0 - d * d / look.foliage.z);
}

// the layer's tangent-space normal, reoriented onto the base's by the base normal intensity
fn layer_normal(look: Look, base: vec3f, bump: vec4f) -> vec3f {
	let normal = look.parallax_bright;
	let xy = bump.rg * 2.0 - 1.0;
	let layer = vec3f(xy * normal.x, max(1e-16, sqrt(1.0 - saturate(dot(xy, xy)))));
	let reoriented = reorient_normal(base, layer * vec3f(-1.0, -1.0, 1.0));
	return mix(layer, reoriented, normal.y);
}

// the layer's colour, metallic, roughness (the bump map's B) and occlusion (its A) blended in by `cover`.
// `facing` is 1 − N·V and `edge` the fuzzy edge term, which shade the colour as moss (neutral without
// `_LAYERBLEND_MOSS`)
fn layer_surface(
	surface: Surface,
	look: Look,
	cover: f32,
	layer: vec4f,
	bump: vec4f,
	facing: f32,
	edge: f32,
) -> Surface {
	var s = surface;
	let color = look.parallax_color;
	let blend = look.parallax_dark;
	let normal = look.parallax_bright;
	let fuzzy = look.foliage;
	let fuzzy2 = look.foliage_ao;
	let luma = dot(layer.rgb, LUMINANCE);
	let tinted = mix(vec3f(luma), layer.rgb, color.w) * color.rgb * (1.0 - edge * fuzzy2.x);
	// darker facing the viewer, brighter towards the silhouette, the more so the brighter the moss
	let core = mix(1.0 - fuzzy.x, 1.0, pow(facing, fuzzy2.y));
	let bright = core + fuzzy.y * 2.0 * dot(tinted, vec3f(0.299, 0.587, 0.114));
	let fuzz = mix(core, bright, pow(facing, fuzzy2.z));
	// replace (mode 0) or add (mode 1, scaled by the additive intensity)
	s.albedo = s.albedo * (1.0 - cover * (1.0 - blend.x)) + tinted * fuzz * cover * mix(1.0, blend.y, blend.x);
	s.metallic = mix(s.metallic, select(blend.w, layer.a, blend.z != 0.0), cover);
	s.roughness = mix(s.roughness, bump.b, cover);
	s.occlusion = mix(s.occlusion, select(mix(1.0, bump.a, normal.z), 1.0, normal.w != 0.0), cover);
	return s;
}
// #endregion

// a shader that may discard loses early depth and, on tile-based GPUs, hidden-surface removal, so only the
// depth passes of alpha-tested materials discard (fs_cutout_depth). their shading runs fs_opaque where the
// depth matches.

@fragment
fn fs_opaque(in: VertexOut) -> Shaded {
	let look = look_slot(draws[in.draw]);
	let feedback = pack_mip_feedback(look, in.uv, in.rel, frame.params.y);
	var out = shade(in, true);
	if (looks[look].detail2.w > 0.5) {
		out.reflection_surface.y |= SURFACE_NO_LIT_DECALS;
	}
	out.mip_feedback = feedback;
	return out;
}

// alpha-blended materials (`transparent` in look.ts), shaded like opaque ones and fogged at their own depth,
// drawn far to near over the composited scene (`TRANSPARENT_TARGETS` in render-targets.ts): premultiplied
// colour and the opacity, the alpha the alpha test would read times `_BaseColor.a`
@fragment
fn fs_transparent(in: VertexOut) -> @location(0) vec4f {
	let draw = draws[in.draw];
	let flags = bitcast<u32>(draw.offset.w);
	let id = look_slot(draw);
	let look = looks[id];
	let bias = frame.params.y;
	let base = textureSampleBias(base_map, base_sampler, slot_uv(id, in.uv, flags, BASE_SLOT), bias);
	let packed = textureSampleBias(normal_map, detail_sampler, slot_uv(id, in.uv, flags, NORMAL_SLOT), bias);
	let shaded = shade(in, false);
	// a map still streaming leaves the tint's alpha alone
	var alpha = select(base.a, packed.a, (flags & ALPHA_NORMAL) != 0u);
	let alpha_map = select(BASE_MAP, NORMAL_MAP, (flags & ALPHA_NORMAL) != 0u);
	if ((flags & alpha_map) == 0u) {
		alpha = 1.0;
	}
	alpha = saturate(alpha * look.emissive2.w);
	// premultiplied glass (detail2.z) adds its whole radiance and lets its opacity only dim what's behind
	let color = shaded.radiance.rgb * select(alpha, 1.0, look.detail2.z > 0.5);
	let uv = in.position.xy / frame.render_size.xy;
	return vec4f(fog_premultiplied(color, alpha, in.rel, uv), alpha);
}

// a VFXDitherAlpha look's `DitherFlags`, 0 on other looks: only leaves and trunks, which have their own flags,
// fill the canopy row otherwise
fn dither_bits(look: Look, flags: u32) -> u32 {
	return select(u32(look.canopy.w), 0u, (flags & (FOLIAGE | FOLIAGE_LEAF | TRUNK)) != 0u);
}

// what multiplies a VFXDitherAlpha look's colour: the vertex colour, a particle's, under
// `DitherFlags.VertexColor`; 1 on other looks
fn dither_vertex_color(look: Look, flags: u32, color: vec4f) -> vec3f {
	return select(vec3f(1.0), color.rgb, (dither_bits(look, flags) & DITHER_VERTEX_COLOR) != 0u);
}

fn shade(in: VertexOut, wet: bool) -> Shaded {
	let draw = draws[in.draw];
	let flags = bitcast<u32>(draw.offset.w);
	let id = look_slot(draw);
	let look = looks[id];
	// derivatives (and implicit-LOD sampling) must happen in uniform control flow
	let faceted = cross(dpdy(in.rel), dpdx(in.rel));
	let bias = frame.params.y;
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
	// the layer's coordinates: UV set 0, world XZ, or UV set 2, which the viewer reads as set 0
	// (`layerBlendParams` in lit-look.ts)
	let layer_type = look.parallax.w;
	let layer_source = select(in.uv.xy, (in.rel + frame.eye.xyz).xz, layer_type > 0.5 && layer_type < 1.5);
	let layer_t = look.slot_uv[LAYER_SLOT];
	let layer_uv = layer_source * layer_t.xy + layer_t.zw;
	let layer_dx = dpdx(layer_uv) * gradient_scale;
	let layer_dy = dpdy(layer_uv) * gradient_scale;

	// the gaps view (`DEBUG_VIEWS` in debug-views.ts): a material drawn without something the game draws
	// (`GAPS_FLOAT` in look.ts) shows amber and black stripes, 25 cm wide in world space, over its base map's
	// brightness
	if (frame.flags.y == 6u && look.effect_only[0].x > 0.5) {
		let world = in.rel + frame.eye.xyz;
		let stripe = fract((world.x + world.y + world.z) * 2.0) < 0.5;
		let shape = select(1.0, dot(base.rgb, LUMINANCE_ROUNDED), (flags & BASE_MAP) != 0u);
		return unlit(select(vec3f(0.02), vec3f(1.0, 0.5, 0.0), stripe) * (0.5 + 0.5 * shape));
	}
	if ((flags & UNLIT) != 0u) {
		// matte paintings (`mattePaintingLook` in special-looks.ts): the tinted texture brightened above a threshold,
		// in pre-exposed units unless it ignores the post exposure
		var c = look.tint.rgb;
		if ((flags & BASE_MAP) != 0u) {
			c *= base.rgb;
		}
		c *= dither_vertex_color(look, flags, in.color);
		// materials the viewer can't draw (`unsupportedLook` in material-looks.ts): a world-space checker of the tint
		// and black
		if (look.surface.z > 0.0) {
			let cell = vec3i(floor((in.rel + frame.eye.xyz) / look.surface.z));
			if (((cell.x + cell.y + cell.z) & 1) != 0) {
				c = vec3f(0.0);
			}
		}
		c += max(c - vec3f(look.surface.x), vec3f(0.0)) * look.surface.y;
		return unlit(clamp(c * mix(1.0, frame.ambient.y, look.emissive2.z), vec3f(0.0), vec3f(1000.0)));
	}
	if ((flags & EROSION) != 0u) {
		var s = erosion_surface(look, in, flags, faceted, packed, mask, detail, uv0_dx, uv0_dy);
		if (wet) {
			s = rain_wet_surface(s, in.rel);
		}
		return shade_surface(s, in.rel, in.position.xy);
	}

	var albedo = clamp(base.rgb * look.tint.rgb * look.surface2.w, vec3f(0.0), vec3f(1.0));
	if ((flags & BASE_MAP) == 0u) {
		albedo = vec3f(1.0);
	}
	albedo = mix(albedo, look.tint.rgb, look.emissive.w);
	if ((dither_bits(look, flags) & DITHER_SURFACE) != 0u) {
		// VFXDitherAlpha's albedo saturates only after the tint, the texture and the vertex colour multiply
		let texel = select(vec3f(1.0), base.rgb, (flags & BASE_MAP) != 0u && look.emissive.w < 0.5);
		albedo = saturate(look.tint.rgb * texel * dither_vertex_color(look, flags, in.color));
	}
	let base_a = select(0.0, base.a, (flags & BASE_MAP) != 0u);
	let has_normal = (flags & NORMAL_MAP) != 0u;

	// the detail map's weight: a mask channel (`_DetailMaskMode`: none, the detail's alpha, the base colour's
	// alpha, the normal map's B or A) fading out with view depth
	let has_detail = (flags & DETAIL_MAP) != 0u;
	var detail_weight = 0.0;
	if (has_detail) {
		let mode = look.detail.y;
		let own = mix(mix(base_a, packed.b, saturate(mode - 2.0)), packed.a, saturate(mode - 3.0));
		let depth = abs(dot(in.rel, frame.view_forward.xyz));
		let span = look.detail2.y - look.detail2.x;
		let fade = saturate((look.detail2.y - depth) / select(span, 1e-6, span == 0.0));
		detail_weight = mix(mix(1.0, detail.a, saturate(mode)), own, saturate(mode - 1.0)) * fade;
		// colour mode: the overlay, where the detail's B is dark
		let overlay = mix(
			clamp(albedo * look.detail_overlay.rgb * look.detail2.z, vec3f(0.0), vec3f(1.0)),
			look.detail_overlay.rgb,
			look.detail_overlay.a,
		);
		albedo = mix(albedo, overlay, detail_weight * (1.0 - look.detail.x) * (1.0 - detail.b));
	}
	let detail_pbr = look.detail.w * detail_weight;

	var n = in.normal;
	if (dot(n, n) < 1e-6) {
		n = faceted;
	}
	n = normalize(n);
	// two-sided materials (foliage) show both faces, and smooth normals can face away at silhouettes: light the
	// side facing us. leaves without `_TwoSidedNormal` keep the normals the canopy's shape gave them, whichever
	// face shows, as the game's do
	let canopy_normal = (flags & FOLIAGE_LEAF) != 0u && look.canopy_color.w < 0.5;
	let towards_viewer = canopy_normal || dot(n, in.rel) <= 0.0;
	if (!towards_viewer) {
		n = -n;
	}

	// the layer, once both its maps are bound; the parallax glow can't share the slots
	let layer_maps = PARALLAX_MAP | PARALLAX_NOISE_MAP;
	let layered = (flags & LAYER_BLEND) != 0u && (flags & layer_maps) == layer_maps;
	let cover_source = look.parallax2.w;
	let top_layer = layered && cover_source == LAYER_SOURCE_TOP;
	// the mask map sits in the emissive slot and reads 0 while streaming
	let layer_mask_map = layered && cover_source == LAYER_SOURCE_MASK_MAP;
	var layer = vec4f(0.0);
	var layer_bump = vec4f(0.0);
	if (layered) {
		layer = textureSampleGrad(parallax_map, parallax_sampler, layer_uv, layer_dx, layer_dy);
		layer_bump = textureSampleGrad(parallax_noise_map, parallax_sampler, layer_uv, layer_dx, layer_dy);
	}
	// the layer's coverage before the height blend (the fuzzy edge reads it), and after
	var raw_cover = 0.0;
	var cover = 0.0;
	if (layered && !top_layer) {
		let mask_r = select(0.0, glow.r, (flags & EMISSIVE_MAP) != 0u);
		let normal_a = select(0.0, packed.a, has_normal);
		raw_cover = mask_coverage(cover_source, mask_r, layer_bump.a, base_a, normal_a);
		cover = layer_coverage(look, raw_cover, layer.a);
	}

	var roughness = look.surface.y;
	let grass = (flags & (FOLIAGE | FOLIAGE_LEAF)) == FOLIAGE;
	if ((has_normal || layered) && in.tangent.w != 0.0) {
		var tn = vec3f(0.0, 0.0, 1.0);
		if (has_normal) {
			var rg = packed.rg;
			if ((flags & NORMAL_RAG) != 0u) {
				rg.x = packed.r * packed.a;
			}
			var xy = unpack_normal_xy(rg);
			if (grass) {
				// `_BendNormalUpward`: towards the blade's up (tangent-space +Y), before the normal scale
				xy = mix(xy, vec2f(0.0, 1.0), look.foliage.x);
			}
			tn = vec3f(xy * look.surface.w, normal_z(xy));
			if (has_detail) {
				// reoriented normal mapping of the detail onto the base normal
				let dxy = unpack_normal_xy(detail.rg);
				let d = vec3f(dxy * (detail_weight * look.detail.z), normal_z(dxy)) * vec3f(-1.0, -1.0, 1.0);
				tn = reorient_normal(tn, d);
			}
		}
		var t = normalize(in.tangent.xyz - n * dot(in.tangent.xyz, n));
		var b = cross(in.normal, in.tangent.xyz) * in.tangent.w;
		// grass with `_TwoSidedNormal` flips only the surface normal on its back faces, so its bent normal keeps
		// pointing up the blade
		if (!towards_viewer && !(grass && look.foliage_ao.w > 0.5)) {
			b = -b;
		}
		b = normalize(b - n * dot(b, n));
		if (top_layer) {
			let bumped = normalize(t * tn.x + b * tn.y + n * tn.z);
			raw_cover = top_coverage(look, mix(n.y, bumped.y, look.parallax.x));
			cover = layer_coverage(look, raw_cover, layer.a);
		}
		if (layered) {
			tn = mix(tn, layer_normal(look, tn, layer_bump), cover);
		}
		n = normalize(t * tn.x + b * tn.y + n * tn.z);
	} else if (top_layer) {
		raw_cover = top_coverage(look, n.y);
		cover = layer_coverage(look, raw_cover, layer.a);
	}
	// read whether or not the mesh has tangents: tangentless meshes lose only the normal's bump
	if (has_normal && (flags & NORMAL_ROUGHNESS) != 0u) {
		roughness = mix(look.surface.x, look.surface.y, packed.b);
	}
	// `_LAYERBLEND_MOSS` (neutral without it): the fuzzy shading faces the blended normal to the view, and
	// the coverage edge tips the normal down
	var layer_facing = 0.0;
	var layer_edge = 0.0;
	if (layered) {
		layer_facing = 1.0 - saturate(dot(n, normalize(-in.rel)));
		layer_edge = layer_fuzzy_edge(look, raw_cover);
		n = normalize(n - vec3f(0.0, layer_edge * look.foliage_ao.w, 0.0));
	}

	var s = default_surface(albedo, n);
	s.roughness = roughness;
	s.metallic = look.surface.z;
	s.f0 = look.surface2.y;
	if ((flags & METALLIC_BASE_ALPHA) != 0u) {
		// dielectric until the base colour streams in
		s.metallic = base_a;
	}
	if ((flags & (NORMAL_MAP | NORMAL_OCCLUSION)) == (NORMAL_MAP | NORMAL_OCCLUSION)) {
		s.occlusion = mix(1.0, packed.a, look.surface2.x);
	}
	// the tri-channel mask sits in the mask slot, or under an MRO map in the emissive slot
	// (`TRI_CHANNEL_IN_EMISSIVE_SLOT` in lit-look.ts)
	let tri_in_glow = look.mask_offset.w > 0.5;
	let mro = has_mro(flags, look);
	if (mro) {
		s.metallic = mask.r;
		s.roughness = mix(look.surface.x, look.surface.y, mask.g);
		s.occlusion = mix(1.0, mask.b, look.surface2.x);
	}
	if (has_detail) {
		// PBR mode: roughness toward the detail's B, occlusion times its alpha; colour mode: roughness toward its
		// alpha only
		s.roughness = mix(s.roughness, mix(detail.a, detail.b, look.detail.x), detail_pbr);
		s.occlusion *= mix(1.0, mix(1.0, detail.a, look.detail.x), detail_pbr);
	}
	let tri_flags = TRI_CHANNEL_MASK | select(MASK_MAP, EMISSIVE_MAP, tri_in_glow);
	if ((flags & tri_flags) == tri_flags) {
		// each channel, remapped by its contrast and offset, blends toward its own surface, B first and R last
		let scale = look.mask_scale.xyz;
		let tri = select(mask.rgb, glow.rgb, tri_in_glow);
		let w = saturate(scale * 0.5 + mix(-scale, vec3f(1.0), tri + look.mask_offset.xyz)) *
			vec3f(look.mask_albedo[0].w, look.mask_albedo[1].w, look.mask_albedo[2].w);
		let roughnesses = look.mask_roughness;
		let metallics = look.mask_metallic;
		s = blend_mask_channel(s, w.z, look.mask_albedo[2].rgb, roughnesses.z, metallics.z);
		s = blend_mask_channel(s, w.y, look.mask_albedo[1].rgb, roughnesses.y, metallics.y);
		s = blend_mask_channel(s, w.x, look.mask_albedo[0].rgb, roughnesses.x, metallics.x);
	}
	if (layered) {
		s = layer_surface(s, look, cover, layer, layer_bump, layer_facing, layer_edge);
	}

	var emission = vec3f(0.0);
	// the emission's strength: the map's R or the remapped mask channel
	var strength = 0.0;
	if ((flags & EMISSIVE_MAP) != 0u && !layer_mask_map && !tri_in_glow) {
		// R scales the emissive colour; G, B and A add colours of their own (zero unless `_EmissiveType` is set)
		let channels = look.emissive_channels;
		strength = glow.r;
		emission = look.emissive.rgb * glow.r + channels[0].rgb * glow.g + channels[1].rgb * glow.b
			+ channels[2].rgb * glow.a;
	}
	if ((flags & EMISSIVE_MASK) != 0u) {
		strength = saturate((map_channel(flags, mro, look.emissive2.y, base_a, packed, mask) - 0.05) / 0.9);
		emission = look.emissive.rgb * strength;
	}
	// a per-draw albedo tint darkens or tints the emitting parts, and so the emission that follows the albedo
	let tinted = look.emissive_albedo.w * step(0.1, strength);
	s.albedo *= vec3f(1.0 - tinted) + look.emissive_albedo.rgb * tinted;
	// emission is in the light's pre-exposed units already; emitters that ignore the post exposure divide it out
	// (docs/game-data/materials.md#emission)
	let tint = mix(s.albedo, vec3f(1.0), look.emissive2.x);
	s.emission = emission * tint * mix(1.0, frame.ambient.y, look.emissive2.z);
	// a vertex offset's textures in the parallax slots leave the pulse its rows
	let pulse_rows = (flags & (PARALLAX_MAP | LAYER_BLEND)) == 0u || (flags & VERTEX_OFFSET) != 0u;
	if (pulse_rows && look.parallax.z > 0.0) {
		s.emission *= mix(1.0, emissive_pulse(look), look.parallax2.x);
	}

	// the glow needs its pattern; without a noise map it marches a flat height field
	if ((flags & (PARALLAX_MAP | LAYER_BLEND | VERTEX_OFFSET)) == PARALLAX_MAP && in.tangent.w != 0.0) {
		// the glow's mask uses the same channel numbering as the emission mask, one lower
		let glow_mask = map_channel(flags, mro, look.parallax_color.w + 1.0, base_a, packed, mask);
		if (glow_mask > 0.01) {
			let v = normalize(-in.rel);
			let has_noise = (flags & PARALLAX_NOISE_MAP) != 0u;
			s.emission += parallax_glow(look, in, v, n, has_noise, parallax_uv, uv0_dx, uv0_dy, parallax_dx, parallax_dy) *
				(glow_mask * glow_mask);
		}
	}

	if ((flags & FOLIAGE) != 0u) {
		s.foliage = true;
		s.transmission = look.surface2.z;
		if ((flags & FOLIAGE_LEAF) != 0u) {
			s = leaf_surface(s, look, in, has_normal, packed.a);
		} else {
			s = grass_surface(s, look, in, select(1.0, packed.a, has_normal));
		}
	} else if ((flags & TRUNK) != 0u) {
		s = trunk_surface(s, look, in, base_a);
	} else if ((flags & LAYER_BLEND) == 0u) {
		// VFXWaterDitherAlpha's `_SUBSURFACE` (`DitherRow` in special-looks.ts); zero on other looks
		s.scatter = look.foliage;
		s.scatter_indirect = look.foliage_ao.x;
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

// a trunk's `_FOLIAGE_TRUNK` (`TrunkRow` in lit-look.ts; zeros on other looks, which change nothing): the vertex
// colour's R darkens the material occlusion, and the albedo ramps toward a colour below a height in its A, by
// the base map's alpha
fn trunk_surface(surface: Surface, look: Look, in: VertexOut, base_a: f32) -> Surface {
	var s = surface;
	s.occlusion *= mix(1.0, in.color.r, look.canopy.z);
	let ramp = look.canopy.w * hermite(look.canopy.x + look.canopy.y, look.canopy.x, in.color.a) * base_a;
	s.albedo = mix(s.albedo, look.canopy_color.rgb, ramp);
	return s;
}

// `HGRP/Foliage/Leaf`'s inputs to the two-sided foliage lighting (`leafParams` in lit-look.ts). the vertex
// colour's R is ambient occlusion and A the height in the canopy; the normal map's alpha (`normal_a`) masks
// transmission and the canopy ramp
fn leaf_surface(surface: Surface, look: Look, in: VertexOut, has_normal: bool, normal_a: f32) -> Surface {
	var s = surface;
	let thin = select(1.0, saturate(1.0 - normal_a), has_normal);
	let ao = saturate(mix(1.0, in.color.r, look.surface2.x));
	s.occlusion = ao;
	let fade_in = vec2f(
		hermite(look.foliage_ao.x, look.foliage_ao.x + look.foliage_ao.y, ao),
		hermite(look.foliage_ao.z, look.foliage_ao.z + look.foliage_ao.w, ao),
	);
	// transmission fades out between 50 and 60 m from the object
	let far = select(1.0, hermite(3600.0, 2500.0, dot(in.origin, in.origin)), look.foliage2.y > 0.5);
	s.transmission = look.surface2.z * thin * far * fade_in.x;
	s.subsurface = look.foliage2.x * fade_in.y;

	let height = select(in.color.a, 1.0 - in.color.a, look.foliage2.w > 0.5);
	let ramp = hermite(look.canopy.x + look.canopy.y, look.canopy.x, height) * thin * look.foliage2.z;
	let tinted = mix(
		saturate(s.albedo * look.canopy_color.rgb * look.canopy.z),
		look.canopy_color.rgb,
		look.canopy.w,
	);
	s.albedo = mix(s.albedo, tinted, ramp);

	// the vertex normal as the mesh stores it (not turned towards the viewer)
	var vertex_normal = s.normal;
	if (dot(in.normal, in.normal) > 1e-6) {
		vertex_normal = normalize(in.normal);
	}
	// `_BLEND_COLOR` (`LeafBlendRow` in lit-look.ts): the albedo times the blend colour, or times the tint again
	// on thick parts whose normal faces up
	let blend = look.mask_albedo[1];
	if (blend.w > 0.5) {
		let up = saturate(mix(s.normal.y, vertex_normal.y, blend.z) + 0.5 + blend.x);
		let keep = saturate(pow(up, blend.y) + 1.0 - saturate(thin * look.mask_albedo[0].w * 10.0));
		s.albedo *= mix(look.mask_albedo[0].rgb, look.tint.rgb, keep);
	}

	// the sun's shadow: the vertex AO, and a fake shadow on the side of the canopy facing away from the sun
	let fake = saturate(1.0 - pow(saturate(dot(s.normal, -frame.sun.xyz) * 0.5 + 0.5), look.foliage.z) * look.foliage.y);
	s.sun_shadow = mix(1.0, in.color.r, look.foliage.x) * fake;
	// the diffuse N·L takes the stored vertex normal
	s.sun_n_dot_l = saturate(dot(mix(s.normal, vertex_normal, look.foliage.w), frame.sun.xyz));
	return s;
}

// `HGRP/Foliage/Grass` and its card LOD (`grassParams` in lit-look.ts, docs/game-data/materials.md#foliage):
// occlusion and a sun mask that rise from a floor at the root to 1 up the blade, by the object-space height
// standing in for the game's; the sun mask's diffuse and transmission parts masked by the normal map's alpha
// (`mask`), and transmission where those agree
fn grass_surface(surface: Surface, look: Look, in: VertexOut, mask: f32) -> Surface {
	var s = surface;
	let height = max(in.object_y, 0.0);
	let ao = look.foliage_ao;
	s.occlusion = 1.0 - ao.z * (1.0 - saturate((height - ao.x) * ao.y));
	let dir = 1.0 - look.foliage2.w * (1.0 - saturate((height - look.foliage2.y) * look.foliage2.z));
	let diffuse = dir * mix(1.0, mask, look.foliage.z);
	let transmitted = dir * mix(1.0, mask, look.foliage.w);
	s.sun_shadow = max(diffuse, transmitted);
	s.transmission = look.surface2.z * (1.0 - abs(diffuse - transmitted));
	s.subsurface = look.foliage2.x;
	return s;
}

// a mask channel of the material's own maps, numbered like `_EmissiveMaskChannel`: 1 the base colour's alpha;
// in the two-basemap layout 2 the normal map's B and 3 its alpha, with an MRO map 2 the base alpha and 3 the
// MRO map's alpha (`mro`: whether the mask slot holds one, `has_mro`). maps still streaming read 0
fn map_channel(flags: u32, mro: bool, channel: f32, base_a: f32, packed: vec4f, mask: vec4f) -> f32 {
	if ((flags & NORMAL_OCCLUSION) != 0u) {
		let has_normal = (flags & NORMAL_MAP) != 0u;
		let b = select(0.0, packed.b, has_normal);
		let a = select(0.0, packed.a, has_normal);
		return mix(mix(base_a, b, saturate(channel - 1.0)), a, saturate(channel - 2.0));
	}
	return mix(base_a, select(0.0, mask.a, mro), saturate(channel - 2.0));
}

// whether the mask slot holds a bound MRO map rather than the tri-channel mask, which under an MRO map sits in
// the emissive slot
fn has_mro(flags: u32, look: Look) -> bool {
	return (flags & MASK_MAP) != 0u && ((flags & TRI_CHANNEL_MASK) == 0u || look.mask_offset.w > 0.5);
}

// `_EMISSIVE_ANIM`'s pulse (`EmissivePulseRow` in lit-look.ts, docs/game-data/materials.md#emission): each cycle
// rises from the minimum brightness to 1 and back over the interval's share of it, then stays at the minimum
fn emissive_pulse(look: Look) -> f32 {
	let x = saturate(fract(frame.eye.w * look.parallax.x + look.parallax.y) * look.parallax.z) * 2.0 - 1.0;
	let low = min(look.parallax.w, 0.999);
	let x2 = x * x;
	return (2.0 * abs(x2 * x) - 3.0 * x2 + 0.5 + 0.5 * (1.0 + low) / (1.0 - low)) * (1.0 - low);
}

// `_PARALLAX_MAP` (`parallaxParams` in lit-look.ts, docs/game-data/materials.md#lit-layers): march the view
// ray down through the noise map as a height field, refine the hit between the last two steps, and colour it
// from the pattern's G; then the Fresnel power and the pulse, plus the brightening near the player. the result
// is HDR emission before the mask
fn parallax_glow(
	look: Look,
	in: VertexOut,
	v: vec3f,
	n: vec3f,
	has_noise: bool,
	uv: vec2f,
	uv0_dx: vec2f,
	uv0_dy: vec2f,
	dx: vec2f,
	dy: vec2f,
) -> vec3f {
	// the view direction in the geometric tangent frame
	let bitangent = cross(in.normal, in.tangent.xyz) * in.tangent.w;
	let vt = normalize(vec3f(dot(v, in.tangent.xyz), dot(v, bitangent), dot(v, in.normal)));
	let steps = look.parallax.y;
	let step = 1.0 / steps;
	let delta = vt.xy / (vt.z + 0.42) / max(vt.z, 0.001) * (-look.parallax.x * step);
	let noise_uv = uv * look.slot_uv[NOISE_SLOT].xy;

	var height = 1.0 - step;
	var offset = delta;
	var previous_offset = vec2f(0.0);
	var previous_sample = 0.0;
	var previous_height = 1.0;
	var hit = -1.0;
	for (var i = 0.0; i < steps + 1.0; i += 1.0) {
		// an empty noise slot is Unity's black default
		let sampled = textureSampleGrad(parallax_noise_map, parallax_sampler, noise_uv + offset, uv0_dx, uv0_dy).x;
		let found = select(0.0, sampled, has_noise);
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
	let tiling = look.slot_uv[PARALLAX_SLOT].xy;
	let pattern = textureSampleGrad(
		parallax_map,
		parallax_sampler,
		(uv + previous_offset + delta * t) * tiling,
		dx * tiling,
		dy * tiling,
	).y;

	let fresnel = pow(max(saturate(dot(v, n)), 0.001), look.parallax.z);
	let pulse = cos(frame.eye.w * look.parallax2.x + look.parallax2.y * in.phase) * look.parallax.w + look.parallax2.w;
	// the player stands at the camera. a smoothstep from the outer radius down to the inner one, written out
	// because WGSL's smoothstep wants its edges in ascending order
	let bright = look.parallax_bright;
	let near_t = saturate((length(in.rel) - bright.x) / (bright.y - bright.x));
	let near = near_t * near_t * (3.0 - 2.0 * near_t) * bright.z;
	let color = mix(look.parallax_dark.rgb, look.parallax_color.rgb, pattern) * fresnel * (pulse + near);
	return clamp(color, vec3f(0.0), vec3f(1000.0)) * mix(1.0, frame.ambient.y, look.parallax2.z);
}

// `HGRP/Erosion` (`erosionLook` in special-looks.ts, parameters by `ErosionRow`): base and metal colours mixed by the
// metal map, plus a parallax-offset noise layer and a flow band along the object's height. `packed` is the base
// normal map, `mask` the metal map and `detail` the detail normal map; textures still streaming read as the
// game's defaults (white, flat normals, the ramp's grey-blue)
fn erosion_surface(
	look: Look,
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
	let base_color = look.tint.rgb;
	let roughness = look.surface.x;
	let roughness_cover = look.surface.y;
	let metallic = look.surface.z;
	let normal_scale = look.surface.w;
	let occlusion_strength = look.surface2.x;
	let metallic_offset = look.surface2.z;
	let detail_scale = look.surface2.w;
	let noise_emissive = look.emissive.x;
	let flow_strength = look.emissive.y;
	let flow_emissive = look.emissive.z;
	let distance_blend = look.emissive.w;
	let metal_color = look.mask_albedo[0].rgb;
	let noise_depth = look.mask_albedo[0].w;
	let noise_tint = look.mask_albedo[1].rgb;
	let noise_min = look.mask_albedo[1].w;
	let noise_alpha_tint = look.mask_albedo[2].rgb;
	let flow_offset = look.mask_albedo[2].w;
	let flow_top = look.mask_roughness.rgb;
	let flow_roughness = look.mask_roughness.w;
	let flow_bottom = look.mask_metallic.rgb;
	let flow = look.mask_scale;

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
		let tiling = look.slot_uv[PARALLAX_SLOT].xy;
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
	s.f0 = look.surface2.y;
	s.occlusion = 1.0 - occlusion_strength + metal_map.g * occlusion_strength;
	s.emission = noise * noise_emissive + flow_color * flow_emissive * saturate(1.0 - metal_map.b);
	return s;
}

// the depth of alpha-tested materials, in the main pass and the shadow passes (opaque ones have no fragment
// stage there). only drawn for materials with an alpha-test threshold whose alpha texture is bound (`cutout`
// in look.ts and MeshRenderer.prepare). a negative threshold marks VFXDitherAlpha's dithered test
// (`DitherRow` in special-looks.ts), which keeps a fraction of the pixels equal to the scaled alpha
@fragment
fn fs_cutout_depth(in: CutoutDepthVaryings) {
	let draw = draws[in.draw];
	let flags = bitcast<u32>(draw.offset.w);
	let id = look_slot(draw);
	let look = looks[id];
	let bias = frame.params.y;
	let base = textureSampleBias(base_map, base_sampler, slot_uv(id, in.uv, flags, BASE_SLOT), bias);
	let packed = textureSampleBias(normal_map, detail_sampler, slot_uv(id, in.uv, flags, NORMAL_SLOT), bias);
	let texel = select(base, packed, (flags & ALPHA_NORMAL) != 0u);
	// a dithered look's `_USE_MASK`, in the noise slot (white until it's loaded); sampled here, in uniform
	// control flow
	let masking = textureSampleBias(parallax_noise_map, noise_sampler, slot_uv(id, in.uv, flags, NOISE_SLOT), bias);
	if (look.tint.w < 0.0) {
		let dither = look.canopy;
		let bits = u32(dither.w);
		var scaled = select(texel.a, texel.r, (bits & DITHER_RED_ALPHA) != 0u) * dither.x;
		if ((bits & DITHER_VERTEX_COLOR) != 0u) {
			scaled *= in.color.a;
		}
		if ((bits & DITHER_MASK) != 0u) {
			scaled *= select(masking.a, masking.r, (bits & DITHER_MASK_RED) != 0u);
		}
		// the near camera fade: in over the first range of view depths, out over the second
		let near = look.canopy_color;
		if (any(near != vec4f(0.0))) {
			let depth = 1.0 / in.position.w;
			scaled *= saturate((depth - near.x) / (near.y - near.x)) * saturate((depth - near.z) / (near.w - near.z));
		}
		let alpha = pow(saturate(scaled), dither.y);
		// the pattern moves each frame, so the temporal antialiasing resolves the surviving pixels into coverage
		if (alpha - gradient_noise(in.position.xy * dither.z + frame.params.w) < 1e-5) {
			discard;
		}
	} else if (texel.a < look.tint.w) {
		discard;
	}
}
