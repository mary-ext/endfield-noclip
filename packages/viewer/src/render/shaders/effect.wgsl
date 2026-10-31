// scene effect meshes (effect-looks.ts): `HGRP/Effect/VFXBaseV2` surfaces and `HGRP/Effect/VFXDecal` boxes, unlit
// and premultiplied, accumulated into the transparent pass's targets like alpha-blended meshes. the decal box
// projects its textures down its local y onto the main pass's surfaces inside it, found through the depth
// buffer. instances, draws and vertex streams are laid out as in mesh.wgsl; group 3 is this family's own.

struct EffectRow {
	t0: vec4f,
	t1: vec4f,
	t2: vec4f,
	center: vec3f,
	block: u32,
	extent: vec3f,
	info: u32,
}

@group(1) @binding(0) var<storage, read> effect_rows: array<EffectRow>;
@group(1) @binding(1) var<storage, read> effect_blocks: array<vec4f>;
@group(1) @binding(2) var<storage, read> effect_list: array<u32>;
// mesh.wgsl's `Draw`: dequantization (4 vec4s), then the look's 32 rows (`EffectRow` in effect-looks.ts)
@group(2) @binding(0) var<storage, read> effect_draws: array<array<vec4f, 36>>;
@group(2) @binding(1) var<storage, read> effect_draw_ids: array<u32>;
@group(3) @binding(0) var fx_tex0: texture_2d<f32>;
@group(3) @binding(1) var fx_tex1: texture_2d<f32>;
@group(3) @binding(2) var fx_tex2: texture_2d<f32>;
@group(3) @binding(3) var fx_tex3: texture_2d<f32>;
@group(3) @binding(4) var fx_tex4: texture_2d<f32>;
@group(3) @binding(5) var fx_tex5: texture_2d<f32>;
@group(3) @binding(6) var fx_tex6: texture_2d<f32>;
@group(3) @binding(7) var fx_samp0: sampler;
@group(3) @binding(8) var fx_samp1: sampler;
@group(3) @binding(9) var fx_samp2: sampler;
@group(3) @binding(10) var fx_samp3: sampler;
@group(3) @binding(11) var fx_samp4: sampler;
@group(3) @binding(12) var fx_samp5: sampler;
@group(3) @binding(13) var fx_samp6: sampler;
// the main pass's depth (read-only in this pass) and its packed surfaces (`pack_reflection_surface`)
@group(3) @binding(14) var fx_depth: texture_depth_2d;
@group(3) @binding(15) var fx_surface: texture_2d<u32>;

// rows of the look (`EffectRow` in effect-looks.ts, in vec4s)
const FX_TINT = 0u;
const FX_UV = 1u;
const FX_ANIM = 8u;
const FX_SLOT_BITS = 15u;
const FX_BLEND_TINT = 17u;
const FX_DISTURB = 18u;
const FX_WEIGHT = 19u;
const FX_DISSOLVE = 20u;
const FX_DISSOLVE_COLOR = 21u;
const FX_FRESNEL = 22u;
const FX_SOFT = 23u;
const FX_NEAR = 24u;
const FX_MISC = 25u;
const FX_DECAL_FADE = 26u;
const FX_DECAL = 27u;
const FX_OFFSET_DIR = 28u;
const FX_OFFSET = 29u;
const FX_OFFSET_MODE = 30u;
const FX_UNFOGGED = 31u;
// the slot of the vertex offset's texture (`OFFSET_SLOT` in effect-looks.ts)
const FX_OFFSET_SLOT = 6u;

// texture roles (`EffectRole` in effect-looks.ts)
const ROLE_DISTURB1 = 0u;
const ROLE_DISTURB2 = 1u;
const ROLE_WEIGHT = 2u;
const ROLE_MASK = 3u;
const ROLE_BLEND = 4u;
const ROLE_DISSOLVE = 5u;
const ROLE_NONE = 7u;
const SLOT_DISTURBED = 8u;
const SLOT_RED_ALPHA = 16u;
const SLOT_UV1 = 32u;

const FX_HAS_COLORS = 67108864u;

struct EffectIn {
	@location(0) position: vec4f,
	@location(1) normal: vec2f,
	@location(2) uv0: vec2f,
	@location(4) uv1: vec2f,
	@location(3) tangent: vec4f,
	@location(5) color: vec4f,
}

struct EffectOut {
	@builtin(position) position: vec4f,
	@location(0) rel: vec3f,
	@location(1) normal: vec3f,
	@location(2) uv: vec4f,
	@location(3) color: vec4f,
	@location(4) @interpolate(flat) draw: u32,
	// camera-relative world → object space, by rows (w: translation)
	@location(5) @interpolate(flat) to_object0: vec4f,
	@location(6) @interpolate(flat) to_object1: vec4f,
	@location(7) @interpolate(flat) to_object2: vec4f,
	// the object's unit y axis in world space: the decal's projection direction, reversed
	@location(8) @interpolate(flat) up: vec3f,
}

// the transparent pass's outputs (`TRANSPARENT_TARGETS` in render-targets.ts), as in mesh.wgsl
struct EffectAccumulated {
	@location(0) sum: vec4f,
	@location(1) revealage: vec4f,
	// additive light, which the composite adds after the fog
	@location(2) glow: vec4f,
}

fn fx_row(id: u32, r: u32) -> vec4f {
	return effect_draws[id][4u + r];
}

fn fx_slot_bits(id: u32, slot: u32) -> u32 {
	return u32(fx_row(id, FX_SLOT_BITS + slot / 4u)[slot % 4u]);
}

fn inverse3(m: mat3x3f) -> mat3x3f {
	let a = cross(m[1], m[2]);
	let b = cross(m[2], m[0]);
	let c = cross(m[0], m[1]);
	let det = dot(m[0], a);
	return transpose(mat3x3f(a, b, c)) * (1.0 / det);
}

// VFXBaseV2's vertex offset: along a direction (object or world space, or the normal), by the offset texture's
// red channel remapped by `_Bi_Offset`, optionally weighted by the vertex alpha, plus a pull towards the camera
// of up to `_VertCameraOffset` metres. `rel` is the vertex's camera-relative position, the camera at the origin
fn fx_vertex_offset(id: u32, m: mat3x3f, normal: vec3f, rel: vec3f, uv: vec4f, vertex_alpha: f32) -> vec3f {
	let dir_row = fx_row(id, FX_OFFSET_DIR);
	let params = fx_row(id, FX_OFFSET);
	var dir = m * dir_row.xyz;
	if (dir_row.w == 1.0) {
		dir = dir_row.xyz;
	} else if (dir_row.w == 2.0) {
		dir = m * normal;
	}
	let st = fx_row(id, FX_UV + FX_OFFSET_SLOT);
	let speed = fx_row(id, FX_ANIM + FX_OFFSET_SLOT).xy;
	let base = select(uv.xy, uv.zw, fx_row(id, FX_OFFSET_MODE).y != 0.0);
	let t = textureSampleLevel(fx_tex6, fx_samp6, base * st.xy + st.zw + speed * frame.eye.w, 0.0).r;
	let weight = (1.0 - params.z) + vertex_alpha * params.z;
	let camera_distance = length(rel);
	let towards_camera =
		-rel / max(camera_distance, 1e-6) * (min(max(0.0, camera_distance - 1.0), params.w) + 0.001);
	return dir * params.x * (t * (1.0 + params.y) - params.y) * weight + towards_camera;
}

@vertex
fn vs_effect(v: EffectIn, @builtin(instance_index) ii: u32) -> EffectOut {
	let row = effect_rows[effect_list[ii]];
	let draw_id = effect_draw_ids[ii];
	let offset = effect_draws[draw_id][0];
	let scale = effect_draws[draw_id][1];
	let uv0 = effect_draws[draw_id][2];
	let uv1 = effect_draws[draw_id][3];
	let p = offset.xyz + v.position.xyz * scale.xyz;
	let origin = vec3f(row.t0.w, row.t1.w, row.t2.w) + effect_blocks[row.block].xyz;
	let m = mat3x3f(
		vec3f(row.t0.x, row.t1.x, row.t2.x),
		vec3f(row.t0.y, row.t1.y, row.t2.y),
		vec3f(row.t0.z, row.t1.z, row.t2.z),
	);
	let inverse = transpose(inverse3(m));
	let flags = bitcast<u32>(offset.w);
	let uv = sheet_uv(row.info, vec4f(v.uv0 * uv0.xy + uv0.zw, v.uv1 * uv1.xy + uv1.zw));
	let color = select(vec4f(1.0), v.color, (flags & FX_HAS_COLORS) != 0u) * instance_color(row.info, row.extent.z);
	let normal = oct_decode(v.normal);
	var rel = m * p + origin;
	if (fx_row(draw_id, FX_OFFSET_MODE).x != 0.0) {
		rel += fx_vertex_offset(draw_id, m, normal, rel, uv, color.a);
	}
	var out: EffectOut;
	out.position = frame.view_proj * vec4f(rel, 1.0);
	out.rel = rel;
	out.normal = m * normal;
	out.uv = uv;
	out.color = color;
	out.draw = draw_id;
	out.to_object0 = vec4f(inverse[0], -dot(inverse[0], origin));
	out.to_object1 = vec4f(inverse[1], -dot(inverse[1], origin));
	out.to_object2 = vec4f(inverse[2], -dot(inverse[2], origin));
	out.up = normalize(m[1]);
	return out;
}

// a slot's UVs: scrolled, rotated about the texture's centre, then its `_ST`
fn fx_slot_coords(id: u32, slot: u32, base: vec2f) -> vec2f {
	let anim = fx_row(id, FX_ANIM + slot);
	let st = fx_row(id, FX_UV + slot);
	let p = base + anim.xy * frame.eye.w - 0.5;
	let r = vec2f(anim.z * p.x - anim.w * p.y, anim.w * p.x + anim.z * p.y) + 0.5;
	return r * st.xy + st.zw;
}

// a base UV gradient carried through a slot's rotation and scale
fn fx_slot_gradient(id: u32, slot: u32, g: vec2f) -> vec2f {
	let anim = fx_row(id, FX_ANIM + slot);
	let st = fx_row(id, FX_UV + slot);
	return vec2f(anim.z * g.x - anim.w * g.y, anim.w * g.x + anim.z * g.y) * st.xy;
}

// explicit gradients keep sampling valid after the distortion and the branches
fn fx_sample(slot: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
	switch slot {
		case 0u: {
			return textureSampleGrad(fx_tex0, fx_samp0, uv, dx, dy);
		}
		case 1u: {
			return textureSampleGrad(fx_tex1, fx_samp1, uv, dx, dy);
		}
		case 2u: {
			return textureSampleGrad(fx_tex2, fx_samp2, uv, dx, dy);
		}
		case 3u: {
			return textureSampleGrad(fx_tex3, fx_samp3, uv, dx, dy);
		}
		case 4u: {
			return textureSampleGrad(fx_tex4, fx_samp4, uv, dx, dy);
		}
		case 5u: {
			return textureSampleGrad(fx_tex5, fx_samp5, uv, dx, dy);
		}
		default: {
			return textureSampleGrad(fx_tex6, fx_samp6, uv, dx, dy);
		}
	}
}

// the texture stack: the distortion and weight run through the slots in order, then the main texture, its mask,
// the blend layer and the dissolve. returns the colour (before exposure) and alpha
fn fx_combine(id: u32, uv0: vec2f, uv1: vec2f, dx: vec2f, dy: vec2f, tint: vec4f) -> vec4f {
	let weight_row = fx_row(id, FX_WEIGHT);
	let disturb = fx_row(id, FX_DISTURB);
	let distorting = fx_row(id, FX_MISC).w != 0.0;
	let dissolve = fx_row(id, FX_DISSOLVE);
	let dissolve_color = fx_row(id, FX_DISSOLVE_COLOR);
	let bias = exp2(frame.params.y);
	var offset = vec2f(0.0);
	var weight = vec4f(1.0 - weight_row.w);
	var mask = vec4f(1.0 - dissolve_color.w);
	var blend = vec4f(0.0);
	var dissolved = 0.0;
	for (var slot = 1u; slot < 7u; slot++) {
		let bits = fx_slot_bits(id, slot);
		let role = bits & 7u;
		if (role == ROLE_NONE) {
			continue;
		}
		let base = select(uv0, uv1, (bits & SLOT_UV1) != 0u);
		var uv = fx_slot_coords(id, slot, base);
		if ((bits & SLOT_DISTURBED) != 0u) {
			uv += offset;
		}
		var t = fx_sample(slot, uv, fx_slot_gradient(id, slot, dx) * bias, fx_slot_gradient(id, slot, dy) * bias);
		if ((bits & SLOT_RED_ALPHA) != 0u) {
			t = vec4f(1.0, 1.0, 1.0, t.r);
		}
		let centred = t.r * (weight_row.x + 1.0) - weight_row.x;
		switch role {
			case ROLE_DISTURB1: {
				offset += select(vec2f(0.0), centred * disturb.xy, distorting);
			}
			case ROLE_DISTURB2: {
				offset += select(vec2f(0.0), centred * disturb.zw, distorting);
			}
			case ROLE_WEIGHT: {
				weight += t;
				offset *= (1.0 - weight_row.y) + weight.x * weight_row.y;
			}
			case ROLE_MASK: {
				mask += t;
			}
			case ROLE_BLEND: {
				blend += t;
			}
			case ROLE_DISSOLVE: {
				dissolved = t.r;
			}
			default: {}
		}
	}
	let bits = fx_slot_bits(id, 0u);
	var uv = fx_slot_coords(id, 0u, select(uv0, uv1, (bits & SLOT_UV1) != 0u));
	if ((bits & SLOT_DISTURBED) != 0u) {
		uv += offset;
	}
	var main_sample = fx_sample(0u, uv, fx_slot_gradient(id, 0u, dx) * bias, fx_slot_gradient(id, 0u, dy) * bias);
	if ((bits & SLOT_RED_ALPHA) != 0u) {
		main_sample = vec4f(1.0, 1.0, 1.0, main_sample.r);
	}
	let c = tint * main_sample * mask;
	let blend_tint = fx_row(id, FX_BLEND_TINT);
	var color = blend.rgb * saturate((c.a + blend.a) * blend_tint.w) * blend_tint.rgb + c.rgb;
	var alpha = c.a;
	if (dissolve.w != 0.0) {
		let threshold = mix(-1.0, dissolve.x, (1.0 - weight_row.z) + weight.x * weight_row.z);
		let v = dissolved - threshold;
		let edge = saturate((dissolve.z - v) * dissolve.y);
		alpha *= saturate(v * dissolve.y);
		color = mix(color, dissolve_color.rgb * edge, edge);
	}
	return vec4f(color, alpha);
}

// the near camera fade at a view depth: fades in from x to y metres and out from z to w
fn fx_near_fade(id: u32, depth: f32) -> f32 {
	if (fx_row(id, FX_MISC).x == 0.0) {
		return 1.0;
	}
	let near = fx_row(id, FX_NEAR);
	return saturate((depth - near.x) / (near.y - near.x)) * saturate((depth - near.z) / (near.w - near.z));
}

// the main pass's view depth at a pixel; the reversed-Z projection's depth is near / view depth
fn fx_scene_depth(px: vec2i) -> f32 {
	let d = textureLoad(fx_depth, px, 0);
	return select(1e9, frame.local_lights.w / d, d > 0.0);
}

// a premultiplied layer into the weighted sum and revealage. an unfogged layer also adds its weight to the
// glow's alpha, which nothing else writes, so the composite knows which share of the weighted sum to keep out
// of the fog
fn fx_accumulate(premultiplied: vec3f, alpha: f32, distance: f32, unfogged: f32) -> EffectAccumulated {
	// mesh.wgsl's weighting
	let x = distance / 20.0;
	let weight = max(0.01, 1.0 / (1.0 + x * x));
	var out: EffectAccumulated;
	out.sum = vec4f(premultiplied * weight, alpha * weight);
	out.revealage = vec4f(alpha);
	out.glow = vec4f(0.0, 0.0, 0.0, alpha * weight * unfogged);
	return out;
}

// VFXBaseV2 surfaces: the texture stack tinted by the vertex colour, brightened above a threshold, faded by the
// Fresnel term, where the surface nears what lies behind it (soft blend), and by the near camera fade. VFXWater
// sheets branch off to `water_sheet`
@fragment
fn fs_effect(in: EffectOut, @builtin(front_facing) front: bool) -> EffectAccumulated {
	let id = in.draw;
	let dx = dpdx(in.uv);
	let dy = dpdy(in.uv);
	let rel_dx = dpdx(in.rel);
	let rel_dy = dpdy(in.rel);
	if (fx_row(id, FX_UNFOGGED).y == FX_KIND_WATER_SHEET) {
		return water_sheet(in, front, dx.xy, dy.xy, rel_dx, rel_dy);
	}
	let soft = fx_row(id, FX_SOFT);
	let misc = fx_row(id, FX_MISC);
	let tint = fx_row(id, FX_TINT) * select(vec4f(1.0), in.color, soft.w != 0.0);
	let combined = fx_combine(id, in.uv.xy, in.uv.zw, dx.xy, dy.xy, tint);
	var color = combined.rgb;
	color += max(color - vec3f(misc.y), vec3f(0.0)) * misc.z;
	color = clamp(color * mix(1.0, frame.ambient.y, soft.z), vec3f(0.0), vec3f(1000.0));

	let fresnel_row = fx_row(id, FX_FRESNEL);
	var fresnel = 1.0;
	if (fresnel_row.x > 0.0) {
		let n = normalize(in.normal);
		let f = pow(saturate(dot(normalize(-in.rel), n) + fresnel_row.y), fresnel_row.x);
		fresnel = mix(1.0 - f, f, fresnel_row.z);
	}
	let depth = dot(in.rel, frame.view_forward.xyz);
	var soft_fade = 1.0;
	if (soft.x > 0.0) {
		soft_fade = saturate((fx_scene_depth(vec2i(in.position.xy)) - depth + soft.y) / soft.x);
	}
	let alpha = saturate(
		saturate(combined.a) * mix(1.0, fresnel, fresnel_row.w) * soft_fade * fx_near_fade(id, depth),
	);
	return fx_accumulate(color * alpha, alpha, length(in.rel), fx_row(id, FX_UNFOGGED).x);
}

// #region water sheets

// `EffectKind.WaterSheet` (effect-looks.ts), in FX_UNFOGGED's y
const FX_KIND_WATER_SHEET = 1.0;

// rows of a VFXWater look (`WaterSheetRow` in effect-looks.ts, in vec4s)
const WS_FLAGS = 17u;
const WS_DISTURB = 18u;
const WS_DISTURB_USE = 19u;
const WS_DISSOLVE = 20u;
const WS_DISSOLVE_COLOR = 21u;
const WS_SEQUENCE = 22u;
const WS_SEQUENCE_SHAPE = 26u;
const WS_SEQUENCE_TINT = 27u;
const WS_SURFACE = 28u;
const WS_SUBSURFACE = 29u;
const WS_MISC = 30u;

// `WaterSheetFlags`
const WS_DISTURB_ON = 1u;
const WS_DISTURB_NORMAL = 2u;
const WS_MASK = 4u;
const WS_DISSOLVE_ON = 8u;
const WS_SEQUENCE_ON = 16u;
const WS_SEQUENCE_MOTION = 32u;
const WS_SEQUENCE_NORMAL = 64u;
const WS_NORMAL_MAP = 128u;
const WS_MAIN_AS_ALPHA = 256u;
const WS_MASK_AS_ALPHA = 512u;
const WS_VERTEX_OPACITY = 1024u;
const WS_FRESNEL_OPACITY = 2048u;
const WS_VERTEX_COLOR = 4096u;

// a slot sampled at its scrolled, rotated, scaled UVs plus `offset`
fn ws_sample(id: u32, slot: u32, uv: vec2f, offset: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
	let bias = exp2(frame.params.y);
	return fx_sample(slot, fx_slot_coords(id, slot, uv) + offset, fx_slot_gradient(id, slot, dx) * bias,
		fx_slot_gradient(id, slot, dy) * bias);
}

// where a flipbook frame's tile starts: frames run along rows from the top, which the UVs reach by wrapping
fn ws_frame_offset(frame: f32, size: vec2f) -> vec2f {
	let count = size.x * size.y;
	let n = frame - count * trunc(frame / count);
	let row = size.y - floor(n / size.x);
	return fract(vec2f((n - row * size.x) / size.x, row / size.y));
}

// VFXWater, the sheets of falling water (`vfxWaterLook`): the tinted main texture and mask, or a flipbook whose
// frames blend along their motion vectors, distorted by a scrolling texture and eaten by a dissolve; lit by the
// irradiance volume and the sun, with a glow through the sheet when the sun is behind it. the game's sun carries
// no 1/π (docs/game-data/lighting.md); the viewer's does
fn water_sheet(in: EffectOut, front: bool, dx: vec2f, dy: vec2f, rel_dx: vec3f, rel_dy: vec3f) -> EffectAccumulated {
	let id = in.draw;
	let ws = fx_row(id, WS_FLAGS);
	let flags = u32(ws.x);
	let uv = in.uv.xy;
	let random = fract(dot(mist_origin(in) + frame.eye.xyz, vec3f(1.0)));
	let stretch = random * ws.w;

	// the distortion, and the textures it moves
	var offset = vec2f(0.0);
	if ((flags & WS_DISTURB_ON) != 0u) {
		let d = ws_sample(id, 1u, uv, vec2f(0.0), dx, dy);
		let row = fx_row(id, WS_DISTURB);
		let centred = d.r * (row.x + 1.0) - row.x;
		if ((flags & WS_DISTURB_NORMAL) != 0u) {
			offset = (vec2f(d.a * centred, d.g) * 2.0 - 1.0) * row.y;
		} else {
			offset = centred * row.yz;
		}
	}
	let use_disturb = fx_row(id, WS_DISTURB_USE);
	var main_uv = fx_slot_coords(id, 0u, uv);
	main_uv.y *= 1.0 + min(stretch, 0.5);
	main_uv += vec2f(stretch) + offset * use_disturb.x;
	let bias = exp2(frame.params.y);
	var main_tex = fx_sample(0u, main_uv, fx_slot_gradient(id, 0u, dx) * bias, fx_slot_gradient(id, 0u, dy) * bias);
	if ((flags & WS_MAIN_AS_ALPHA) != 0u) {
		main_tex = vec4f(1.0, 1.0, 1.0, main_tex.r);
	}
	var mask = vec4f(1.0);
	if ((flags & WS_MASK) != 0u) {
		mask = ws_sample(id, 2u, uv, offset * use_disturb.y, dx, dy);
		if ((flags & WS_MASK_AS_ALPHA) != 0u) {
			mask = vec4f(1.0, 1.0, 1.0, mask.r);
		}
	}
	let vertex = select(vec4f(1.0), in.color, (flags & WS_VERTEX_COLOR) != 0u);
	let base = fx_row(id, FX_TINT) * vertex * main_tex * mask;
	var color = base.rgb;
	var dissolved = 1.0;
	if ((flags & WS_DISSOLVE_ON) != 0u) {
		let row = fx_row(id, WS_DISSOLVE);
		let v = ws_sample(id, 3u, uv, offset * use_disturb.w, dx, dy).r - row.x;
		dissolved = saturate(v * row.y);
		let edge = saturate((row.z - v) * row.y);
		color = mix(color, fx_row(id, WS_DISSOLVE_COLOR).rgb * edge, edge);
	}

	// the flipbook: two frames, each pushed along its motion vectors towards the other
	let shape = fx_row(id, WS_SEQUENCE_SHAPE);
	let sequencing = (flags & WS_SEQUENCE_ON) != 0u;
	var frame_a = uv;
	var frame_b = uv;
	var blend = 0.0;
	var sequence = vec4f(0.0);
	if (sequencing) {
		let row = fx_row(id, WS_SEQUENCE);
		let f = (frame.eye.w + random * row.w) * row.z;
		let tile = 1.0 / row.xy;
		frame_a = uv * tile + ws_frame_offset(floor(f), row.xy);
		frame_b = uv * tile + ws_frame_offset(floor(f + 1.0), row.xy);
		blend = fract(f);
		let gx = dx * tile * bias;
		let gy = dy * tile * bias;
		if ((flags & WS_SEQUENCE_MOTION) != 0u) {
			let mv_a = fx_sample(5u, frame_a, gx, gy).xy * 2.0 - 1.0;
			let mv_b = fx_sample(5u, frame_b, gx, gy).xy * 2.0 - 1.0;
			frame_a -= mv_a * blend * shape.x;
			frame_b += mv_b * (1.0 - blend) * shape.x;
		}
		sequence = saturate(mix(fx_sample(4u, frame_a, gx, gy), fx_sample(4u, frame_b, gx, gy), blend) - shape.w);
		color += sequence.rgb * fx_row(id, WS_SEQUENCE_TINT).rgb * sequence.a;
	}

	// opacity
	let depth = dot(in.rel, frame.view_forward.xyz);
	let soft = fx_row(id, FX_SOFT);
	var alpha = base.a * dissolved * fx_near_fade(id, depth);
	if (sequencing) {
		alpha = saturate(alpha * sequence.a * shape.y - shape.z) * shape.y;
	}
	if (soft.x > 0.0) {
		alpha *= saturate((fx_scene_depth(vec2i(in.position.xy)) - depth + soft.y) / soft.x);
	}
	if ((flags & WS_VERTEX_OPACITY) != 0u) {
		alpha *= in.color.a;
	}
	let v = -normalize(in.rel);
	let n_geo = normalize(in.normal);
	let surface = fx_row(id, WS_SURFACE);
	if ((flags & WS_FRESNEL_OPACITY) != 0u) {
		alpha *= pow(abs(dot(n_geo, v)), surface.w);
	}
	alpha = saturate(alpha);
	color = clamp(color, vec3f(0.0), vec3f(1000.0));

	// the normal: the flipbook's or the normal map's, in the frame the UVs make
	var n = n_geo;
	if ((flags & (WS_SEQUENCE_NORMAL | WS_NORMAL_MAP)) != 0u) {
		var s: vec4f;
		if ((flags & WS_SEQUENCE_NORMAL) != 0u) {
			let tile = 1.0 / fx_row(id, WS_SEQUENCE).xy;
			s = mix(fx_sample(6u, frame_a, dx * tile * bias, dy * tile * bias),
				fx_sample(6u, frame_b, dx * tile * bias, dy * tile * bias), blend);
		} else {
			s = ws_sample(id, 6u, uv, offset * use_disturb.z, dx, dy);
		}
		let xy = vec2f(s.a * s.r, s.g) * 2.0 - 1.0;
		let z = max(1e-16, sqrt(1.0 - saturate(dot(xy, xy))));
		let scaled = xy * fx_row(id, WS_SEQUENCE_TINT).w;
		let dp1 = cross(rel_dy, n_geo);
		let dp2 = cross(n_geo, rel_dx);
		var t = dp1 * dx.x + dp2 * dy.x;
		var b = dp1 * dx.y + dp2 * dy.y;
		let scale = inverseSqrt(max(max(dot(t, t), dot(b, b)), 1e-20));
		n = normalize(t * scale * scaled.x + b * scale * scaled.y + n_geo * z);
	}
	n = select(-n, n, front);

	// lighting: the lit share takes the irradiance volume and the sun, the rest stays as it is
	// the game also divides the lit share by the post exposure under `_IgnorePostExposure`, which in the viewer's
	// exposure darkens sheets in dark places far below the game's; only the unlit share keeps it
	let lit = color * ws.z;
	let unlit = color * (1.0 - ws.z) * mix(1.0, frame.ambient.y, soft.z);
	let sss_row = fx_row(id, WS_SUBSURFACE);
	var thickness = 1.0;
	if (sequencing) {
		thickness = sequence.a * shape.y;
	}
	if ((flags & WS_VERTEX_OPACITY) != 0u) {
		thickness *= in.color.r;
	}
	let value = sss_row.z * thickness * lit.x;
	let subsurface = mix(vec3f(1.0), hue(sss_row.x), sss_row.y) * value;
	var indirect = ambient_irradiance(in.rel + frame.eye.xyz, n) * (lit + subsurface * sss_row.w);
	{
		let mean = (indirect.x + indirect.y + indirect.z) / 3.0;
		indirect = mean + (indirect - mean) * fx_row(id, WS_MISC).y;
	}
	let l = frame.sun.xyz;
	let h = normalize(l + v);
	let n_dot_l = saturate(dot(n, l));
	let n_dot_h = saturate(dot(n, h));
	let n_dot_v = saturate(dot(n, v));
	let a = surface.x * surface.x;
	let a2 = a * a;
	let d = (n_dot_h * a2 - n_dot_h) * n_dot_h + 1.0;
	let fresnel = fresnel_schlick(vec3f(0.08 * surface.y), saturate(dot(v, h)));
	let visible = 0.5 / (n_dot_l * sqrt((-n_dot_v * a2 + n_dot_v) * n_dot_v + a2) +
		n_dot_v * sqrt((-n_dot_l * a2 + n_dot_l) * n_dot_l + a2) + 1e-4);
	// divided by the opacity, so the highlight survives the premultiplication
	let specular = clamp(clamp(min(fresnel * (a2 / (d * d)) * visible, vec3f(2048.0)) * frame.sun_color.w, vec3f(0.0),
		vec3f(1000.0)) / max(alpha, 0.01), vec3f(0.0), vec3f(1000.0)) * surface.z;
	let k = saturate(1.0 - value);
	let wrap = saturate(dot(n, l) * (2.0 / 3.0) + 1.0 / 3.0);
	let through = mix(mix(1.0, wrap * sqrt(wrap) * (5.0 / 3.0), k) / (2.0 * PI), 1.0,
		pow(saturate(-dot(v, l)), 12.0) * mix(3.0, 0.1, k));
	let sun = (specular * n_dot_l + subsurface * through + lit * n_dot_l) * frame.sun_color.rgb * (frame.sun.w / PI) *
		sun_visibility(in.rel, n, in.position.xy);
	let shaded = indirect + unlit + sun;

	// `_BlendMode` 1 adds the layer rather than blending it over
	if (ws.y >= 0.5) {
		var out: EffectAccumulated;
		out.sum = vec4f(0.0);
		out.revealage = vec4f(0.0);
		out.glow = vec4f(shaded * alpha, 0.0);
		return out;
	}
	return fx_accumulate(shaded * alpha, alpha, length(in.rel), 0.0);
}

// #endregion

// unpacks the normal of `pack_reflection_surface` (frame.wgsl), or returns zero where nothing lit was drawn
fn fx_surface_normal(px: vec2i) -> vec3f {
	let packed = textureLoad(fx_surface, px, 0).xy;
	if ((packed.y & (1u << 30u)) == 0u) {
		return vec3f(0.0);
	}
	let e = vec2f(f32(packed.x & 0xfffu), f32((packed.x >> 12u) & 0xfffu)) / 4095.0 * 2.0 - 1.0;
	var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
	if (n.z < 0.0) {
		let s = select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
		n = vec3f((1.0 - abs(n.yx)) * s, n.z);
	}
	return normalize(n);
}

// VFXDecal boxes, drawn by their back faces without a depth test: each covered pixel finds the main pass's
// surface along its view ray, and the texture stack projects onto it down the box's y, faded towards the
// box's sides and top and bottom, on surfaces facing away from the projection, and near the camera
@fragment
fn fs_effect_decal(in: EffectOut) -> EffectAccumulated {
	let id = in.draw;
	let px = vec2i(in.position.xy);
	let scene_depth = fx_scene_depth(px);
	let rel = in.rel * (scene_depth / dot(in.rel, frame.view_forward.xyz));
	let p = vec4f(rel, 1.0);
	let object_p = vec3f(dot(in.to_object0, p), dot(in.to_object1, p), dot(in.to_object2, p));
	let uv = object_p.xz + 0.5;
	let dx = dpdx(uv);
	let dy = dpdy(uv);
	if (any(abs(object_p) >= vec3f(0.5)) || scene_depth >= 1e9) {
		return fx_accumulate(vec3f(0.0), 0.0, 1.0, 0.0);
	}
	let combined = fx_combine(id, uv, uv, dx, dy, fx_row(id, FX_TINT));
	let soft = fx_row(id, FX_SOFT);
	let color = clamp(combined.rgb, vec3f(0.0), vec3f(1000.0)) * mix(1.0, frame.ambient.y, soft.z);

	let fade = fx_row(id, FX_DECAL_FADE);
	let decal = fx_row(id, FX_DECAL);
	let height = saturate(((0.5 + abs(decal.x)) - abs(object_p.y + decal.x)) / fade.w * 2.0);
	let edge_x = smoothstep(0.5 - fade.x + fade.z, 0.5 - fade.x, abs(object_p.x));
	let edge_z = smoothstep(0.5 - fade.y + fade.z, 0.5 - fade.y, abs(object_p.z));
	var angle = 1.0;
	if (decal.y > 0.0) {
		let n = fx_surface_normal(px);
		if (any(n != vec3f(0.0))) {
			angle = pow(saturate(dot(in.up, n)), decal.y);
		}
	}
	let alpha = saturate(combined.a * fx_near_fade(id, scene_depth) * height * edge_x * edge_z) * angle;
	// the game's decal premultiplies its colour by the alpha twice
	return fx_accumulate(color * alpha * alpha, alpha, length(rel), fx_row(id, FX_UNFOGGED).x);
}

// #region mist

// rows of a mist look (`MistRow` in effect-looks.ts, in vec4s)
const MIST_COLOR = 0u;
const MIST_CARD = 8u;
const MIST_WIND = 9u;
const MIST_LIGHT = 10u;
const MIST_INDIRECT = 11u;
const MIST_FADE = 12u;
const MIST_TOP = 13u;
const MIST_VOLUME = 14u;
const MIST_VOLUME_HEIGHT = 15u;
const MIST_VOLUME_FADE = 16u;
const MIST_MISC = 17u;

// a mist layer into the transparent pass: additive ones into the glow, premultiplied ones like other layers
fn mist_accumulate(id: u32, premultiplied: vec3f, alpha: f32, distance: f32) -> EffectAccumulated {
	if (fx_row(id, MIST_INDIRECT).w != 0.0) {
		var out: EffectAccumulated;
		out.sum = vec4f(0.0);
		out.revealage = vec4f(0.0);
		out.glow = vec4f(premultiplied, 0.0);
		return out;
	}
	return fx_accumulate(premultiplied, alpha, distance, 0.0);
}

// a fade between two view depths: in from x to y (or out, when y < x)
fn mist_fade(range: vec2f, depth: f32) -> f32 {
	return saturate((depth - range.x) / (range.y - range.x));
}

// `HGRP/FogSimple` mist cards: the main texture's red broken up by the noise texture, times a scrolling wind
// sample of it (on colour and opacity both, as the game's), in the flat colour or lit by the sun; faded by view
// depth, towards the card's top (object y) and where it nears what lies behind it
@fragment
fn fs_mist_card(in: EffectOut) -> EffectAccumulated {
	let id = in.draw;
	let uv = in.uv.xy;
	let dx = dpdx(uv);
	let dy = dpdy(uv);
	let bias = exp2(frame.params.y);
	let card = fx_row(id, MIST_CARD);
	let wind = fx_row(id, MIST_WIND);
	let light = fx_row(id, MIST_LIGHT);
	let main_st = fx_row(id, FX_UV);
	let noise_st = fx_row(id, FX_UV + 1u);
	let main = textureSampleGrad(fx_tex0, fx_samp0, uv * main_st.xy + main_st.zw, dx * main_st.xy * bias, dy * main_st.xy * bias);
	let noise = textureSampleGrad(fx_tex1, fx_samp1, uv * noise_st.xy + noise_st.zw, dx * noise_st.xy * bias, dy * noise_st.xy * bias);
	let wind_uv = uv * wind.yz + vec2f(-light.x, light.y) * (frame.eye.w * wind.w);
	let gust = textureSampleGrad(fx_tex1, fx_samp1, wind_uv, dx * wind.yz * bias, dy * wind.yz * bias).x;
	let base = fx_row(id, MIST_COLOR);
	var alpha = ((1.0 - card.y) + noise.x * card.y) * main.x * base.a;
	var color = base.rgb;
	if (light.z != 0.0) {
		// the game's sun colour carries no 1/π (docs/game-data/lighting.md); the viewer's does
		let n = normalize(in.normal) * select(-1.0, 1.0, dot(in.normal, -in.rel) >= 0.0);
		let lit = (1.0 - light.w) + max(dot(n, frame.sun.xyz), 0.0) * light.w;
		let sun = frame.sun_color.rgb * (frame.sun.w / PI);
		color = mix(fx_row(id, MIST_INDIRECT).rgb, base.rgb * sun, lit);
	}
	let windy = (1.0 - card.z) + ((1.0 - card.w) + saturate(mix(-wind.x, wind.x + 1.0, gust)) * card.w) * card.z;
	color *= windy;
	alpha *= windy;

	let depth = dot(in.rel, frame.view_forward.xyz);
	let fade = fx_row(id, MIST_FADE);
	let top = fx_row(id, MIST_TOP);
	let object_y = dot(in.to_object1, vec4f(in.rel, 1.0));
	var soft = 1.0;
	if (top.z > 0.0) {
		soft = saturate((fx_scene_depth(vec2i(in.position.xy)) - depth) / top.z);
	}
	alpha = saturate(
		alpha * mist_fade(fade.xy, depth) * mist_fade(fade.zw, depth) * saturate(-object_y * top.x + top.y) * soft * card.x,
	);
	return mist_accumulate(id, max(color, vec3f(0.0)) * alpha, alpha, length(in.rel));
}

// `HGRP/Effect/VFXFakeVolumeFog` boxes, drawn by their back faces without a depth test like the decals: from
// the nearer of the surface behind and the back face, the fog's thickness along the ray towards the camera
// through the unit cube (or up to the camera inside it), faded towards the box's edges and top, with distance and,
// for boxes the camera can't walk into, close to them
@fragment
fn fs_mist_volume(in: EffectOut) -> EffectAccumulated {
	let id = in.draw;
	let px = vec2i(in.position.xy);
	let face = dot(in.rel, frame.view_forward.xyz);
	let depth = min(fx_scene_depth(px), face);
	let rel = in.rel * (depth / face);
	let p = vec4f(rel, 1.0);
	let object_p = vec3f(dot(in.to_object0, p), dot(in.to_object1, p), dot(in.to_object2, p));
	let to_camera = vec3f(dot(in.to_object0.xyz, -rel), dot(in.to_object1.xyz, -rel), dot(in.to_object2.xyz, -rel));
	let reach = length(to_camera);
	let dir = to_camera / reach;
	let exits = max((vec3f(-0.5) - object_p) / dir, (vec3f(0.5) - object_p) / dir);
	let object_length = min(min(min(exits.x, exits.y), exits.z), reach);
	// back to metres: the object-space ray's length per world metre
	let thickness = object_length * (length(rel) / reach);

	let volume = fx_row(id, MIST_VOLUME);
	let height = fx_row(id, MIST_VOLUME_HEIGHT);
	let base = fx_row(id, MIST_COLOR);
	var alpha = base.a * (1.0 - exp2(-thickness * volume.x)) * volume.y;
	alpha *= saturate(1.0 - length(cross(object_p, dir)) / volume.z);
	alpha *= 1.0 - saturate((object_p.y - height.x) * height.y);
	if (height.w > height.z) {
		alpha *= 1.0 - smoothstep(height.z - 0.5, height.w - 0.5, object_p.y);
	}
	if (volume.w > 0.0) {
		alpha *= saturate(thickness / volume.w);
	}
	let fade = fx_row(id, MIST_VOLUME_FADE);
	let to_point = length(rel);
	let distance = mix(to_point, length(mist_origin(in)), fade.y);
	alpha = saturate(alpha) * (1.0 - saturate(distance / fade.x));
	if (fade.z > 0.0) {
		alpha *= smoothstep(min(fade.w, 0.99), 1.0, saturate(to_point / fade.z));
	}
	let color = base.rgb * mix(1.0, frame.ambient.y, fx_row(id, MIST_MISC).x);
	return mist_accumulate(id, color * alpha, alpha, to_point);
}

// the camera-relative origin of an effect's object, from its world → object rows
fn mist_origin(in: EffectOut) -> vec3f {
	let m = transpose(mat3x3f(in.to_object0.xyz, in.to_object1.xyz, in.to_object2.xyz));
	return -(inverse3(m) * vec3f(in.to_object0.w, in.to_object1.w, in.to_object2.w));
}

// #endregion
