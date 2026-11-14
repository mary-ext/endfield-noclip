// scene effect meshes (looks/effects/, docs/game-data/effects.md), accumulated into the transparent pass's
// targets like alpha-blended meshes: VFXBaseV2 surfaces and VFXWater sheets (`fs_effect`), VFXDecal boxes
// (`fs_effect_decal`), FogSimple mist cards (`fs_mist_card`) and VFXFakeVolumeFog boxes (`fs_mist_volume`); lit
// decals that only change the surface add to the main pass's radiance instead (`fs_decal_relight`).
// instances, draws and vertex streams are laid out as in mesh.wgsl; group 3 is this family's own.

@group(1) @binding(0) var<storage, read> effect_rows: array<InstanceRow>;
// each block's origin (xyz) and where its decal placements start, less 1 (w)
@group(1) @binding(1) var<storage, read> effect_blocks: array<vec4f>;
@group(1) @binding(2) var<storage, read> effect_list: array<u32>;
// rect decal placements (`DecalPlacements` in package-format): colour, then UV scale and offset
@group(1) @binding(3) var<storage, read> effect_placements: array<array<vec4f, 2>>;
// mesh.wgsl's `Draw`: dequantization, flags and look slot (4 vec4s)
@group(2) @binding(0) var<storage, read> effect_draws: array<array<vec4f, 4>>;
@group(2) @binding(1) var<storage, read> effect_draw_ids: array<u32>;
// mesh.wgsl's `looks`: the look's 44 rows (`EffectRow`, `WaterSheetRow` or `MistRow` in mist.ts)
@group(2) @binding(5) var<storage, read> effect_looks: array<array<vec4f, 44>>;
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
// the main pass's diffuse ambient and material occlusion (`Shaded.ambient` in frame.wgsl)
@group(3) @binding(16) var fx_ambient: texture_2d<f32>;
// the look's 3D texture (`volumeTexture`: the mist boxes' noise), a zeroed placeholder without one
@group(3) @binding(17) var fx_volume: texture_3d<f32>;
@group(3) @binding(18) var fx_volume_samp: sampler;
// a copy of the composited scene, which refraction samples (`fs_refract`); a white placeholder in other passes
@group(3) @binding(19) var fx_background: texture_2d<f32>;
@group(3) @binding(20) var fx_background_samp: sampler;

// rows of the look (`EffectRow` in effect-look.ts, in vec4s)
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
const FX_EDGE_COLOR = 32u;
const FX_EDGE = 33u;
// z, w: the vertex offset mask's slot and strength (`EffectRow.offsetMask`)
const FX_EDGE_ALPHA = 34u;
// the pull towards the camera's most (m), 1 when it pulls (`EffectRow.cameraPull`)
const FX_CAMERA_PULL = 35u;
// the texture stack's per-slot custom data shifts (u, v), from row 36 on (`EffectRow.customScroll` in
// effect-look.ts)
const FX_CUSTOM_SCROLL = 36u;
// the texture stack's reveal around the player (`EffectRow.appear*`): radii, alpha factor and edge; noise
// scale, speed, centre height and 1 with a reveal; brightening colour
const FX_APPEAR = 40u;
const FX_APPEAR_NOISE = 41u;
const FX_APPEAR_BRIGHT = 42u;
// the texture stack's switches: the vertex alpha scales the reveal's brightening, the global radii add to the
// reveal's, the first disturb texture holds a normal, the vertex colour scales the blend tint
const FX_STACK_FLAGS = 43u;
// a decal's parallax (`EffectRow.parallax`), crack colour and crack noise colour, in the reveal's rows
const FX_PARALLAX = 40u;
const FX_CRACK = 41u;
const FX_CRACK_NOISE = 42u;
// the slot of the vertex offset's texture (`OFFSET_SLOT` in stack.ts)
const FX_OFFSET_SLOT = 6u;
// how the vertex stage moves vertices (`VertexMotion` in stack.ts)
const FX_MOTION_OFFSET = 1.0;
const FX_MOTION_SOFT_BODY = 2.0;

// texture roles (`EffectRole` in effect-look.ts)
const ROLE_DISTURB1 = 0u;
const ROLE_DISTURB2 = 1u;
const ROLE_WEIGHT = 2u;
const ROLE_MASK = 3u;
const ROLE_BLEND = 4u;
const ROLE_DISSOLVE = 5u;
const ROLE_NONE = 7u;
const SLOT_RED_ALPHA = 16u;
// two bits of `SlotSource` (effect-look.ts): UV0, UV1, polar, screen
const SLOT_SOURCE_SHIFT = 5u;
const SLOT_NO_BASE = 128u;

// the share of the distortion a slot's UVs take, in 1/1024ths above the low byte (`slotDisturb` in
// stack.ts)
fn slot_disturb(bits: u32) -> f32 {
	return f32(bits >> 8u) / 1024.0;
}

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
	// the draw's look slot, which `fx_row` reads
	@location(4) @interpolate(flat) look: u32,
	// camera-relative world → object space, by rows (w: translation)
	@location(5) @interpolate(flat) to_object0: vec4f,
	@location(6) @interpolate(flat) to_object1: vec4f,
	@location(7) @interpolate(flat) to_object2: vec4f,
	// the object's unit y axis in world space: the decal's projection direction, reversed
	@location(8) @interpolate(flat) up: vec3f,
	// the object origin, camera-relative, and its view depth (w), which scales VFXBaseV2's screen UVs
	@location(9) @interpolate(flat) origin: vec4f,
	// a rect decal row's placement: its colour, and its UV scale and offset; white and the identity elsewhere
	@location(10) @interpolate(flat) placement_color: vec4f,
	@location(11) @interpolate(flat) placement_uv: vec4f,
	// the row's extras: a particle's custom data
	@location(12) @interpolate(flat) custom: vec4f,
}

// the transparent pass's output (`TRANSPARENT_TARGETS` in render-targets.ts), as in mesh.wgsl: premultiplied
// colour and the opacity it hides the scene behind by, 0 for additive light
struct EffectAccumulated {
	@location(0) color: vec4f,
}

// row `r` of the look in slot `id` of `effect_looks`
fn fx_row(id: u32, r: u32) -> vec4f {
	return effect_looks[id][r];
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

// the vertex offset of VFXBaseV2 and VFXDitherAlpha: along a direction (object or world space, or the
// normal), by the offset texture's red channel remapped by `_Bi_Offset`; VFXBaseV2's is optionally weighted by
// the vertex alpha
fn fx_vertex_offset(id: u32, m: mat3x3f, normal: vec3f, uv: vec4f, vertex_alpha: f32) -> vec3f {
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
	var weight = (1.0 - params.z) + vertex_alpha * params.z;
	// `_USE_VERTOFFSETMASK`: the mask's red at the same UVs, through its own `_ST` and scroll
	let mask = fx_row(id, FX_EDGE_ALPHA).zw;
	if (mask.y != 0.0) {
		let slot = u32(mask.x);
		let mask_st = fx_row(id, FX_UV + slot);
		let mask_speed = fx_row(id, FX_ANIM + slot).xy;
		let r = fx_sample_level(slot, base * mask_st.xy + mask_st.zw + mask_speed * frame.eye.w, 0.0).r;
		weight *= 1.0 - mask.y * (1.0 - r);
	}
	return dir * params.x * (t * (1.0 + params.y) - params.y) * weight;
}

// a stack slot sampled at one mip level, which the vertex stage needs
fn fx_sample_level(slot: u32, uv: vec2f, level: f32) -> vec4f {
	switch slot {
		case 0u: {
			return textureSampleLevel(fx_tex0, fx_samp0, uv, level);
		}
		case 1u: {
			return textureSampleLevel(fx_tex1, fx_samp1, uv, level);
		}
		case 2u: {
			return textureSampleLevel(fx_tex2, fx_samp2, uv, level);
		}
		case 3u: {
			return textureSampleLevel(fx_tex3, fx_samp3, uv, level);
		}
		case 4u: {
			return textureSampleLevel(fx_tex4, fx_samp4, uv, level);
		}
		case 5u: {
			return textureSampleLevel(fx_tex5, fx_samp5, uv, level);
		}
		default: {
			return textureSampleLevel(fx_tex6, fx_samp6, uv, level);
		}
	}
}

// VFXBaseV2's pull towards the camera: up to `pull` metres past the first, plus 1 mm. `rel` is the vertex's
// camera-relative position, the camera at the origin
fn fx_camera_pull(rel: vec3f, pull: f32) -> vec3f {
	let camera_distance = length(rel);
	return -rel / max(camera_distance, 1e-6) * (min(max(0.0, camera_distance - 1.0), pull) + 0.001);
}

// VFXBaseV2's soft-body animation (`VertexMotion.SoftBody` in stack.ts): the object-space position moved
// by the position texture's texel at UV1's column and the current frame's row. vertices with UV1's v at most
// 0.1 collapse to the object's origin, as the game's do
fn fx_soft_body(id: u32, p: vec3f, uv1: vec2f) -> vec3f {
	let low = fx_row(id, FX_OFFSET_DIR);
	let range = fx_row(id, FX_OFFSET).xyz;
	let scale = fx_row(id, FX_UV + FX_OFFSET_SLOT).xy;
	let play = fx_row(id, FX_ANIM + FX_OFFSET_SLOT).xy;
	let frames = low.w;
	let current = floor(fract(frame.eye.w * play.x + play.y) * frames);
	let at = vec2f(uv1.x * scale.x, 1.0 - scale.y * ((1.0 - uv1.y) + current / frames));
	let texel = textureSampleLevel(fx_tex6, fx_samp6, at, 0.0).xyz;
	return select(p + range * texel + low.xyz, vec3f(0.0), uv1.y <= 0.1);
}

@vertex
fn vs_effect(v: EffectIn, @builtin(instance_index) ii: u32) -> EffectOut {
	let row = effect_rows[effect_list[ii]];
	let draw_id = effect_draw_ids[ii];
	let offset = effect_draws[draw_id][0];
	let scale = effect_draws[draw_id][1];
	let uv0 = effect_draws[draw_id][2];
	let uv1 = effect_draws[draw_id][3];
	let id = bitcast<u32>(scale.w);
	var p = offset.xyz + v.position.xyz * scale.xyz;
	if (fx_row(id, FX_UNFOGGED).y == FX_KIND_BEAM) {
		p = beam_vertex(id, p);
	}
	let origin = vec3f(row.t0.w, row.t1.w, row.t2.w) + effect_blocks[row_block(row.block)].xyz;
	let m = row_basis(row.t0, row.t1, row.t2, row.info);
	let inverse = transpose(inverse3(m));
	let flags = bitcast<u32>(offset.w);
	let uv = sheet_uv(row.sheet, vec4f(v.uv0 * uv0.xy + uv0.zw, v.uv1 * uv1.xy + uv1.zw));
	let color = select(vec4f(1.0), v.color, (flags & FX_HAS_COLORS) != 0u) * unpack4x8unorm(row.color);
	let normal = oct_decode(v.normal);
	let motion = fx_row(id, FX_OFFSET_MODE).x;
	if (motion == FX_MOTION_SOFT_BODY) {
		p = fx_soft_body(id, p, v.uv1 * uv1.xy + uv1.zw);
	}
	var rel = m * p + origin;
	let pull = fx_row(id, FX_CAMERA_PULL).xy;
	// the pull is measured from the position before the offset, and added beside it
	let pulled = select(vec3f(0.0), fx_camera_pull(rel, pull.x), pull.y != 0.0);
	if (motion == FX_MOTION_OFFSET) {
		rel += fx_vertex_offset(id, m, normal, uv, color.a);
	}
	rel += pulled;
	var out: EffectOut;
	out.position = frame.view_proj * vec4f(rel, 1.0);
	out.rel = rel;
	out.normal = m * normal;
	out.uv = uv;
	out.color = color;
	out.look = id;
	out.to_object0 = vec4f(inverse[0], -dot(inverse[0], origin));
	out.to_object1 = vec4f(inverse[1], -dot(inverse[1], origin));
	out.to_object2 = vec4f(inverse[2], -dot(inverse[2], origin));
	out.up = normalize(m[1]);
	out.origin = vec4f(origin, dot(origin, frame.view_forward.xyz));
	out.placement_color = vec4f(1.0);
	out.placement_uv = vec4f(1.0, 1.0, 0.0, 0.0);
	out.custom = row_custom(row);
	let placement = row_placement(row.block);
	if (placement != 0u) {
		let at = u32(i32(effect_blocks[row_block(row.block)].w) + i32(placement));
		out.placement_color = effect_placements[at][0];
		out.placement_uv = effect_placements[at][1];
	}
	return out;
}

// polar UVs of a point about the centre: the angle from +y as a fraction of a turn, and twice the distance
fn fx_polar(centred: vec2f) -> vec2f {
	return vec2f((atan2(centred.x, centred.y) + PI) / (2.0 * PI), 2.0 * length(centred));
}

// the UVs a texture slot can start from (`SlotSource` in effect-look.ts), with their screen gradients
struct FxBases {
	uv: array<vec2f, 4>,
	dx: array<vec2f, 4>,
	dy: array<vec2f, 4>,
}

// call in uniform control flow. the polar angle's gradient wraps, so its seam doesn't read as a whole turn and
// pick the smallest mip
fn fx_bases(uv0: vec2f, uv1: vec2f, polar: vec2f, screen: vec2f) -> FxBases {
	var pdx = dpdx(polar);
	var pdy = dpdy(polar);
	pdx.x -= round(pdx.x);
	pdy.x -= round(pdy.x);
	var b: FxBases;
	b.uv = array(uv0, uv1, polar, screen);
	b.dx = array(dpdx(uv0), dpdx(uv1), pdx, dpdx(screen));
	b.dy = array(dpdy(uv0), dpdy(uv1), pdy, dpdy(screen));
	return b;
}

// a slot's base UV and its gradients by its bits, zero when its source isn't computed
fn fx_slot_base(bases: FxBases, bits: u32) -> array<vec2f, 3> {
	if ((bits & SLOT_NO_BASE) != 0u) {
		return array(vec2f(0.0), vec2f(0.0), vec2f(0.0));
	}
	// arrays in a value can't be indexed by a variable
	var b = bases;
	let source = (bits >> SLOT_SOURCE_SHIFT) & 3u;
	return array(b.uv[source], b.dx[source], b.dy[source]);
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

// a texture stack slot's UV shift by the particle's custom data (VFXBaseV2's `*UVSpeed.zw`): the main texture's
// by its x, the sample textures' by its y
fn fx_custom_shift(id: u32, slot: u32, custom: vec4f) -> vec2f {
	let row = fx_row(id, FX_CUSTOM_SCROLL + slot / 2u);
	let scroll = select(row.xy, row.zw, slot % 2u == 1u);
	return scroll * select(custom.y, custom.x, slot == 0u);
}

// the texture stack: the distortion and weight run through the slots in order, then the main texture, its mask,
// the blend layer and the dissolve, whose threshold the particle's custom data's z adds to as the schedule.
// `vertex_color` scales the blend tint where the look says so. a decal's parallax (`cracked`) shifts the main
// texture by `parallax` and adds its cracks before the dissolve. returns the colour (before exposure) and alpha
fn fx_combine(id: u32, bases: FxBases, tint: vec4f, custom: vec4f, vertex_color: vec4f, cracked: bool, parallax: vec2f)
	-> vec4f {
	let weight_row = fx_row(id, FX_WEIGHT);
	let disturb = fx_row(id, FX_DISTURB);
	let flags = fx_row(id, FX_STACK_FLAGS);
	let distorting = fx_row(id, FX_MISC).w != 0.0;
	let dissolve = fx_row(id, FX_DISSOLVE);
	let dissolve_color = fx_row(id, FX_DISSOLVE_COLOR);
	let bias = exp2(frame.params.y);
	// `_UseParticleDisturb`: the custom data's w scales the distortion (`EffectRow.particleDisturb`)
	let disturb_scale = select(1.0, custom.w, fx_row(id, FX_EDGE_ALPHA).y != 0.0);
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
		let base = fx_slot_base(bases, bits);
		let uv = fx_slot_coords(id, slot, base[0] + fx_custom_shift(id, slot, custom)) + offset * slot_disturb(bits);
		var t = fx_sample(
			slot,
			uv,
			fx_slot_gradient(id, slot, base[1]) * bias,
			fx_slot_gradient(id, slot, base[2]) * bias,
		);
		if ((bits & SLOT_RED_ALPHA) != 0u) {
			t = vec4f(1.0, 1.0, 1.0, t.r);
		}
		let centred = t.r * (weight_row.x + 1.0) - weight_row.x;
		switch role {
			case ROLE_DISTURB1: {
				// VFXAdvance's `_DisturbTex1Normal` reads it as a normal, scaled by its u strength alone
				var shift = centred * disturb.xy;
				if (flags.z != 0.0) {
					shift = (vec2f(t.a * centred, t.g) * 2.0 - 1.0) * disturb.x;
				}
				offset += select(vec2f(0.0), shift * disturb_scale, distorting);
			}
			case ROLE_DISTURB2: {
				offset += select(vec2f(0.0), centred * disturb.zw * disturb_scale, distorting);
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
	let base = fx_slot_base(bases, bits);
	let main_uv = fx_slot_coords(id, 0u, base[0] + fx_custom_shift(id, 0u, custom));
	let main_dx = fx_slot_gradient(id, 0u, base[1]) * bias;
	let main_dy = fx_slot_gradient(id, 0u, base[2]) * bias;
	var main_sample = fx_sample(0u, main_uv + offset * slot_disturb(bits) + parallax, main_dx, main_dy);
	if ((bits & SLOT_RED_ALPHA) != 0u) {
		main_sample = vec4f(1.0, 1.0, 1.0, main_sample.r);
	}
	// VFXDitherAlpha's mask scales only the alpha (`EffectRow.maskAlphaOnly`)
	if (fx_row(id, FX_CAMERA_PULL).z != 0.0) {
		mask = vec4f(1.0, 1.0, 1.0, mask.a);
	}
	let c = tint * main_sample * mask;
	let blend_tint = fx_row(id, FX_BLEND_TINT) * select(vec4f(1.0), vertex_color, flags.w != 0.0);
	var color = blend.rgb * saturate((c.a + blend.a) * blend_tint.w) * blend_tint.rgb + c.rgb;
	var alpha = c.a;
	if (cracked) {
		color += fx_decal_cracks(id, bases, main_uv + parallax, main_dx, main_dy, offset, parallax);
	}
	if (dissolve.w != 0.0) {
		let threshold = mix(-1.0, dissolve.x + custom.z * 2.02, (1.0 - weight_row.z) + weight.x * weight_row.z);
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

// a premultiplied layer over the scene, fogged at its camera-relative position `rel` (drawn at `position`
// on screen) unless `unfogged` is set, for effects without fog of their own
fn fx_accumulate(premultiplied: vec3f, alpha: f32, rel: vec3f, position: vec2f, unfogged: f32)
	-> EffectAccumulated {
	if (unfogged > 0.5) {
		return EffectAccumulated(vec4f(premultiplied, alpha));
	}
	let fogged = fog_premultiplied(premultiplied, alpha, rel, position / frame.render_size.xy);
	return EffectAccumulated(vec4f(fogged, alpha));
}

// additive light over the scene, kept out of the fog: the game's additive effects fog themselves, if at all,
// by their own settings, which aren't read
fn fx_additive(light: vec3f) -> EffectAccumulated {
	return EffectAccumulated(vec4f(light, 0.0));
}

// a fragment that leaves the scene as it is
fn fx_nothing() -> EffectAccumulated {
	return EffectAccumulated(vec4f(0.0));
}

// the UV sources of a pixel of a texture-stack layer. the look's screen-UV flags shape the screen UVs: 4 takes
// them about the object's origin (`_LocalPivortSpace`), 2 takes v from the world height, 1 scales them by the
// object's view depth past the near plane. call in uniform control flow
fn fx_layer_bases(in: EffectOut) -> FxBases {
	let kind = fx_row(in.look, FX_UNFOGGED);
	let size = frame.render_size.xy;
	let q = floor(in.position.xy);
	let screen_flags = u32(kind.w);
	var screen = vec2f(2.0 * q.x / size.x - 1.0, (2.0 * q.y / size.y - 1.0) * size.y / size.x);
	if ((screen_flags & 4u) != 0u) {
		let from_origin = in.rel - in.origin.xyz;
		screen = vec2f(dot(from_origin, frame.view_right.xyz), dot(from_origin, frame.view_up.xyz));
	}
	screen.y = select(screen.y, frame.eye.y + in.rel.y, (screen_flags & 2u) != 0u);
	screen *= select(1.0, max(1.0, in.origin.w - frame.local_lights.w), (screen_flags & 1u) != 0u);
	return fx_bases(in.uv.xy, in.uv.zw, fx_polar(in.uv.xy - 0.5), screen);
}

// VFXBaseV2 surfaces: the texture stack tinted by the vertex colour, brightened above a threshold, faded by the
// Fresnel term, where the surface nears what lies behind it (soft blend), and by the near camera fade. VFXWater
// sheets branch off to `water_sheet`
@fragment
fn fs_effect(in: EffectOut, @builtin(front_facing) front: bool) -> EffectAccumulated {
	let id = in.look;
	let dx = dpdx(in.uv);
	let dy = dpdy(in.uv);
	let rel_dx = dpdx(in.rel);
	let rel_dy = dpdy(in.rel);
	let kind = fx_row(id, FX_UNFOGGED);
	let bases = fx_layer_bases(in);
	if (kind.y == FX_KIND_WATER_SHEET) {
		return water_sheet(in, front, dx.xy, dy.xy, rel_dx, rel_dy);
	}
	if (kind.y == FX_KIND_BEAM) {
		return light_beam(in);
	}
	if (kind.y == FX_KIND_SIX_WAY) {
		return six_way_smoke(in, bases);
	}
	let layer = fx_stack_layer(in, bases);
	let color = layer.rgb;
	let alpha = layer.a;
	if (fx_below_water_blend(in)) {
		return fx_accumulate(fx_unsupported_checker(in), 1.0, in.rel, in.position.xy, kind.x);
	}
	// `_BlendMode` 1 adds the layer rather than blending it over
	if (kind.z >= 0.5) {
		return fx_additive(color * alpha);
	}
	return fx_accumulate(color * alpha, alpha, in.rel, in.position.xy, kind.x);
}

// below its `_USE_WATER_BLEND` height the game absorbs and scatters a layer's colour, which isn't drawn
fn fx_below_water_blend(in: EffectOut) -> bool {
	return in.rel.y + frame.eye.y < fx_row(in.look, FX_DECAL).z;
}

// what fragments the viewer can't draw show: a world-space magenta and black checker (as `unsupportedLook` in
// material-looks.ts)
fn fx_unsupported_checker(in: EffectOut) -> vec3f {
	let cell = vec3i(floor((in.rel + frame.eye.xyz) / 0.5));
	return select(vec3f(1.0, 0.0, 1.0), vec3f(0.0), ((cell.x + cell.y + cell.z) & 1) != 0);
}

// opaque VFXBaseV2 layers (`Blend One Zero`), shaded in the main pass: the colour times the alpha covers what's
// behind, as the game writes it. what the lit surfaces hand the post passes is left empty, as for unlit meshes
@fragment
fn fs_effect_opaque(in: EffectOut) -> Shaded {
	let layer = fx_stack_layer(in, fx_layer_bases(in));
	if (fx_below_water_blend(in)) {
		return unlit(fx_unsupported_checker(in));
	}
	return unlit(layer.rgb * layer.a);
}

// `_BlendMode` 2 VFXBaseV2 layers, drawn over the composited scene with a blend that multiplies it by the output:
// `lerp(1, colour, alpha)`
@fragment
fn fs_effect_multiply(in: EffectOut) -> @location(0) vec4f {
	let layer = fx_stack_layer(in, fx_layer_bases(in));
	return vec4f(mix(vec3f(1.0), layer.rgb, layer.a), 1.0);
}

// GLSL's smoothstep, which also runs from a higher edge to a lower one as the reveal's do
fn fx_smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
	let t = saturate((x - edge0) / (edge1 - edge0));
	return t * t * (3.0 - 2.0 * t);
}

// the reveal edge's hash of a lattice point, its coordinates wrapped to 1024 first
fn fx_appear_hash(p: vec2f) -> f32 {
	let q = p - 1024.0 * trunc(p / 1024.0);
	return fract(sin(dot(q, vec2f(12.9898, 78.233))) * 43758.5453);
}

// the reveal edge's value noise in 0…1, smoothly interpolated between lattice hashes
fn fx_appear_noise(p: vec2f) -> f32 {
	let i = floor(p);
	let f = fract(p);
	let a = fx_appear_hash(i);
	let b = fx_appear_hash(i + vec2f(1.0, 0.0));
	let c = fx_appear_hash(i + vec2f(0.0, 1.0));
	let d = fx_appear_hash(i + vec2f(1.0));
	let u = f * f * (3.0 - 2.0 * f);
	return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

// VFXAdvance's and VFXDitherAlpha's reveal around the player (`EffectAppear`,
// docs/game-data/effects.md#invisible-bridges), the camera standing in for the player; the global radii are
// `frame.render_size.zw`. returns the tint
fn fx_appear(in: EffectOut, bases: FxBases, tint: vec4f) -> vec4f {
	let id = in.look;
	let appear = fx_row(id, FX_APPEAR);
	let noise = fx_row(id, FX_APPEAR_NOISE);
	let flags = fx_row(id, FX_STACK_FLAGS);
	let global = select(vec2f(0.0), frame.render_size.zw, flags.y != 0.0);
	let inner = appear.x + global.x;
	let outer = appear.y + global.y;
	let d = length(in.rel - vec3f(0.0, noise.z, 0.0));
	var bright = fx_row(id, FX_APPEAR_BRIGHT) * fx_smoothstep(outer, inner, d);
	bright.a *= select(1.0, in.color.a, flags.x != 0.0);
	var revealed = tint + bright;
	// the noise runs over the main texture's UVs, before the distortion
	let base = fx_slot_base(bases, fx_slot_bits(id, 0u));
	let uv = fx_slot_coords(id, 0u, base[0] + fx_custom_shift(id, 0u, in.custom));
	let n = fx_appear_noise(uv * noise.x + frame.eye.w * noise.y) * 2.0 - 1.0;
	let fade = fx_smoothstep(outer, inner, d + appear.w * n);
	revealed.a = saturate(mix(revealed.a, revealed.a * appear.z, fade));
	return revealed;
}

// a texture-stack layer's colour (exposed, unpremultiplied) and alpha
fn fx_stack_layer(in: EffectOut, bases: FxBases) -> vec4f {
	let id = in.look;
	let soft = fx_row(id, FX_SOFT);
	let misc = fx_row(id, FX_MISC);
	var tint = fx_row(id, FX_TINT) * select(vec4f(1.0), in.color, soft.w != 0.0);
	// `_USE_ANIM_BREATHING` pulses the tint's alpha (FX_DECAL_FADE holds it for stack layers, which decals don't
	// draw through)
	let breathing = fx_row(id, FX_DECAL_FADE);
	if (breathing.w > 0.0) {
		let wave = saturate(pow(cos(frame.eye.w * breathing.y) * 0.5 + 0.5, breathing.z));
		tint.a *= mix(breathing.x, 1.0, wave);
	}
	if (fx_row(id, FX_APPEAR_NOISE).w > 0.0) {
		tint = fx_appear(in, bases, tint);
	}
	var combined = fx_combine(id, bases, tint, in.custom, in.color, false, vec2f(0.0));
	let depth = dot(in.rel, frame.view_forward.xyz);
	// `_USE_EDGECOLOR` marks where the surface nears what lies behind it: mode 1 adds the edge colour and the tint
	// alpha by its strength, 0 multiplies the colour by the edge colour and the alpha by the strength
	let edge_row = fx_row(id, FX_EDGE);
	if (edge_row.w > 0.0) {
		let edge_color = fx_row(id, FX_EDGE_COLOR);
		let gap = max(fx_scene_depth(vec2i(in.position.xy)) - depth, 0.001);
		let e = edge_color.w * saturate(edge_row.x / gap - edge_row.y);
		let added = combined + vec4f(edge_color.rgb, fx_row(id, FX_EDGE_ALPHA).x) * e;
		let multiplied = combined * vec4f(edge_color.rgb, e);
		combined = mix(multiplied, added, edge_row.z);
	}
	var color = combined.rgb;
	color += max(color - vec3f(misc.y), vec3f(0.0)) * misc.z;
	let lighting = fx_row(id, FX_OFFSET_MODE);
	if (lighting.z > 0.0) {
		// `_USE_LIGHTING`: the colour is an albedo, lit by the irradiance volume and the sun at the surface's normal
		// turned towards the camera, or at the world's up; the game's division by the post exposure is left out
		var n = normalize(in.normal);
		n = select(-n, n, dot(n, in.rel) <= 0.0);
		n = select(n, vec3f(0.0, 1.0, 0.0), lighting.w > 0.0);
		let sun = frame.sun_color.rgb * (frame.sun.w / PI) * saturate(dot(n, frame.sun.xyz)) *
			sun_visibility(in.rel, n, in.position.xy);
		color = clamp(color, vec3f(0.0), vec3f(1000.0)) * (ambient_irradiance(in.rel + frame.eye.xyz, n) + sun);
	} else {
		color = clamp(color * mix(1.0, frame.ambient.y, soft.z), vec3f(0.0), vec3f(1000.0));
	}

	let fresnel_row = fx_row(id, FX_FRESNEL);
	var fresnel = 1.0;
	if (fresnel_row.x > 0.0) {
		let n = normalize(in.normal);
		let f = pow(saturate(dot(normalize(-in.rel), n) + fresnel_row.y), fresnel_row.x);
		fresnel = mix(1.0 - f, f, fresnel_row.z);
	}
	var soft_fade = 1.0;
	if (soft.x > 0.0) {
		soft_fade = saturate((fx_scene_depth(vec2i(in.position.xy)) - depth + soft.y) / soft.x);
	}
	let alpha = saturate(
		saturate(combined.a) * mix(1.0, fresnel, fresnel_row.w) * soft_fade * fx_near_fade(id, depth),
	);
	// VFXDitherAlpha's `_DitherAlphaExp`; 1 for the other stack looks
	return vec4f(color, pow(alpha, fx_row(id, FX_DECAL).w));
}

// #region refraction

// `EffectKind.Refract` (effect-look.ts), in FX_UNFOGGED's y
const FX_KIND_REFRACT = 4.0;

// rows of a VFXRefract look (`RefractRow` in refract.ts, in vec4s)
const RF_REFRACT = 17u;
const RF_REFRACT2 = 18u;
const RF_RB = 19u;
const RF_RB_MAIN = 20u;
const RF_RB_FIRST = 21u;
const RF_RB_SECOND = 22u;
const RF_DISSOLVE = 26u;
const RF_SPREAD = 28u;
const RF_BLEND_COLOR = 32u;
const RF_BLEND = 33u;

// a refraction slot sampled at its UVs, shifted by `shift`
fn rf_sample(id: u32, slot: u32, bases: FxBases, custom: vec4f, shift: vec2f) -> vec4f {
	let bias = exp2(frame.params.y);
	let bits = fx_slot_bits(id, slot);
	let base = fx_slot_base(bases, bits);
	var t = fx_sample(
		slot,
		fx_slot_coords(id, slot, base[0] + fx_custom_shift(id, slot, custom)) + shift,
		fx_slot_gradient(id, slot, base[1]) * bias,
		fx_slot_gradient(id, slot, base[2]) * bias,
	);
	if ((bits & SLOT_RED_ALPHA) != 0u) {
		t = vec4f(1.0, 1.0, 1.0, t.r);
	}
	return t;
}

// VFXRefract (docs/game-data/effects.md#refraction): the composited scene seen at an offset in screen UVs,
// tinted by the mask's and blend layer's colours, and blended over by their alpha times the spread's band
@fragment
fn fs_refract(in: EffectOut) -> @location(0) vec4f {
	let id = in.look;
	let bases = fx_bases(in.uv.xy, in.uv.zw, fx_polar(in.uv.xy - 0.5), vec2f(0.0));
	let bias = exp2(frame.params.y);
	let row = fx_row(id, RF_REFRACT);
	let row2 = fx_row(id, RF_REFRACT2);
	var offset = vec2f(0.0);
	// what scales the colour offsets when `_UseMainTexAsMask` is set: the remapped red, or the normal's offset
	var amount = 0.0;
	{
		let bits = fx_slot_bits(id, 0u);
		let base = fx_slot_base(bases, bits);
		let t = fx_sample(
			0u,
			fx_slot_coords(id, 0u, base[0] + fx_custom_shift(id, 0u, in.custom)),
			fx_slot_gradient(id, 0u, base[1]) * bias,
			fx_slot_gradient(id, 0u, base[2]) * bias,
		);
		let centred = t.r * (1.0 + row.w) - row.w;
		let strength = row.z * in.color.a;
		let normal = (vec2f(t.a * centred, t.g) * 2.0 - 1.0) * row.xy * strength;
		offset = select(row.xy * centred * strength, normal, row2.x != 0.0);
		amount = select(centred, length(normal), row2.x != 0.0);
	}
	// the dissolve scales the offset (not the colour offsets' further shift), and the alpha by its share
	let dissolve_row = fx_row(id, RF_DISSOLVE);
	var dissolved = 1.0;
	if (dissolve_row.w != 0.0) {
		let bits = fx_slot_bits(id, 2u);
		let base = fx_slot_base(bases, bits);
		let t = fx_sample(
			2u,
			fx_slot_coords(id, 2u, base[0]),
			fx_slot_gradient(id, 2u, base[1]) * bias,
			fx_slot_gradient(id, 2u, base[2]) * bias,
		);
		// a particle's custom data's z adds to the schedule
		dissolved = saturate((t.r - dissolve_row.x - in.custom.z * 2.02) * dissolve_row.y);
		offset *= dissolved;
	}
	// the spread: a band `range` wide around the schedule (plus the custom data's w), stretched so it starts and
	// ends off the texture, covers where the spread texture's red (flipped) falls inside it
	var cover = 1.0;
	let spread = fx_row(id, RF_SPREAD);
	if (spread.y > 0.0) {
		let s = rf_sample(id, 4u, bases, in.custom, vec2f(0.0)).r;
		let at = (spread.x + in.custom.w) * (1.0 + 2.0 * spread.y) - spread.y;
		let level = spread.z + s - 2.0 * s * spread.z;
		cover = saturate(1.0 - abs(at - level) / spread.y) * spread.w;
	}
	var mask = vec4f(1.0);
	if (row2.z != 0.0) {
		mask = rf_sample(id, 1u, bases, in.custom, offset * row2.y);
	}
	// the blend layer tints by `_BlendColor.a` and covers by its alpha
	let blend_row = fx_row(id, RF_BLEND);
	var tint = mask;
	if (blend_row.x != 0.0) {
		let blend = rf_sample(id, 3u, bases, in.custom, offset * blend_row.y);
		let blend_color = fx_row(id, RF_BLEND_COLOR);
		tint *= vec4f((1.0 - blend_color.a) + blend.rgb * blend_color.rgb * blend_color.a, blend.a);
	}
	let uv = in.position.xy / frame.render_size.xy + offset;
	var behind = textureSampleLevel(fx_background, fx_background_samp, uv, 0.0).rgb;
	let main = fx_row(id, RF_RB_MAIN);
	if (main.w != 0.0) {
		let rb = fx_row(id, RF_RB);
		let first = fx_row(id, RF_RB_FIRST);
		let second = fx_row(id, RF_RB_SECOND);
		let shift = rb.xy * in.color.a * mix(1.0, amount, first.w);
		var split = max(
			behind * main.rgb,
			textureSampleLevel(fx_background, fx_background_samp, uv + shift, 0.0).rgb * first.rgb,
		);
		if (second.w != 0.0) {
			split = max(
				split,
				textureSampleLevel(fx_background, fx_background_samp, uv + shift * rb.z, 0.0).rgb * second.rgb,
			);
		}
		behind = max(mix(behind, split, rb.w), vec3f(0.0));
	}
	let depth = dot(in.rel, frame.view_forward.xyz);
	let soft = fx_row(id, FX_SOFT);
	var soft_fade = 1.0;
	if (soft.x > 0.0) {
		soft_fade = saturate((fx_scene_depth(vec2i(in.position.xy)) - depth) / soft.x);
	}
	let alpha = saturate(
		cover * tint.a * soft_fade * fx_near_fade(id, depth) * mix(1.0, dissolved, dissolve_row.z),
	);
	return vec4f(clamp(behind * tint.rgb, vec3f(0.0), vec3f(1000.0)), alpha);
}

// #endregion

// #region water sheets

// `EffectKind.WaterSheet` (effect-look.ts), in FX_UNFOGGED's y
const FX_KIND_WATER_SHEET = 1.0;

// rows of a VFXWater look (`WaterSheetRow` in water-sheet.ts, in vec4s)
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

// the particle's custom data, for `ws_sample`; the water sheet and six-way smoke set it from their input
var<private> ws_custom: vec4f;

// a slot sampled at its scrolled, rotated, scaled UVs, shifted by the particle's custom data, plus `offset`
fn ws_sample(id: u32, slot: u32, uv: vec2f, offset: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
	let bias = exp2(frame.params.y);
	let at = fx_slot_coords(id, slot, uv + fx_custom_shift(id, slot, ws_custom)) + offset;
	return fx_sample(slot, at, fx_slot_gradient(id, slot, dx) * bias, fx_slot_gradient(id, slot, dy) * bias);
}

// where a flipbook frame's tile starts: frames run along rows from the top, which the UVs reach by wrapping
fn ws_frame_offset(frame: f32, size: vec2f) -> vec2f {
	let count = size.x * size.y;
	let n = frame - count * trunc(frame / count);
	let row = size.y - floor(n / size.x);
	return fract(vec2f((n - row * size.x) / size.x, row / size.y));
}

// VFXWater, the sheets of falling water (`waterSheetLook` in water-sheet.ts,
// docs/game-data/effects.md#waterfalls). sun units follow the viewer's illuminance convention
// (docs/viewer/lighting.md#sun)
fn water_sheet(in: EffectOut, front: bool, dx: vec2f, dy: vec2f, rel_dx: vec3f, rel_dy: vec3f) -> EffectAccumulated {
	let id = in.look;
	ws_custom = in.custom;
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
	var main_uv = fx_slot_coords(id, 0u, uv + fx_custom_shift(id, 0u, in.custom));
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
		// a particle's custom data's z adds to the schedule
		let v = ws_sample(id, 3u, uv, offset * use_disturb.w, dx, dy).r - row.x - in.custom.z * 2.02;
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

	// lighting: the lit share takes the irradiance volume and the sun, the rest stays as it is. only the unlit
	// share takes the game's division by the post exposure (docs/viewer/effects.md#waterfalls)
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
		return fx_additive(shaded * alpha);
	}
	return fx_accumulate(shaded * alpha, alpha, in.rel, in.position.xy, 0.0);
}

// #endregion

// #region six-way smoke

// `EffectKind.SixWaySmoke` (effect-look.ts), in FX_UNFOGGED's y
const FX_KIND_SIX_WAY = 6.0;

// rows of a six-way smoke look (`SixWayRow` in six-way-smoke.ts, in vec4s)
const SW_FLAGS = 17u;
const SW_DISTURB = 18u;
const SW_DISTURB_USE = 19u;
const SW_DISSOLVE = 20u;
const SW_DISSOLVE_COLOR = 21u;
const SW_BLEND_TINT = 22u;

// `SixWayFlags`
const SW_DISTURB1 = 1u;
const SW_DISTURB2 = 2u;
const SW_DISTURB1_NORMAL = 4u;
const SW_DISTURB2_NORMAL = 8u;
const SW_MASK = 16u;
const SW_MASK_RED_ALPHA = 32u;
const SW_BLEND = 64u;
const SW_DISSOLVE_ON = 128u;
const SW_VERTEX_COLOR = 256u;

// `SIX_WAY_SCREEN_DEPTH` in six-way-smoke.ts: the slot's screen UVs scale by the object's view depth
const SW_SLOT_SCREEN_DEPTH = 8u;

// a six-way slot's base UV and its gradients: UV0, polar or screen UVs by its bits (`*SwitchUV`), the screen
// ones times `depth` where its bit asks (`*ScreenDepthUV`)
fn sw_base(id: u32, slot: u32, bases: FxBases, depth: f32) -> array<vec2f, 3> {
	let bits = fx_slot_bits(id, slot);
	let b = fx_slot_base(bases, bits);
	let s = select(1.0, depth, (bits & SW_SLOT_SCREEN_DEPTH) != 0u);
	return array(b[0] * s, b[1] * s, b[2] * s);
}

// one distortion texture's offset: its red remapped by `_Bi_Disturb` times the u and v strengths, or with a
// normal its (a·r, g) remapped to [-1, 1] times the u strength
fn sw_disturb(id: u32, slot: u32, base: array<vec2f, 3>, strength: vec2f, normal: bool) -> vec2f {
	let t = ws_sample(id, slot, base[0], vec2f(0.0), base[1], base[2]);
	let bias = fx_row(id, SW_FLAGS).y;
	let centred = t.r * (bias + 1.0) - bias;
	if (normal) {
		return (vec2f(t.a * centred, t.g) * 2.0 - 1.0) * strength.x;
	}
	return centred * strength;
}

// the light a lightmap value lets through once the smoke absorbs `exponent`'s colour: Unity's six-way
// absorption, the value raised per channel within `range`
fn sw_absorb(t: f32, exponent: vec3f, range: f32) -> vec3f {
	return min(vec3f(range), pow(vec3f(saturate(t / range)), exponent) * range);
}

// six-way lit smoke (`sixWaySmokeLook` in six-way-smoke.ts, docs/game-data/effects.md#six-way-smoke): the
// texture stack makes the colour the smoke absorbs and its opacity; the two lightmaps hold how much light
// passes from each axis of the particle's frame. sun units follow the viewer's convention for the game's
// light colour (docs/viewer/lighting.md#sun)
fn six_way_smoke(in: EffectOut, bases: FxBases) -> EffectAccumulated {
	let id = in.look;
	ws_custom = in.custom;
	let row = fx_row(id, SW_FLAGS);
	let flags = u32(row.x);
	let bias = exp2(frame.params.y);
	// what scales screen UVs by depth: the object origin's view depth past the near plane
	let depth_scale = max(0.0, in.origin.w - frame.local_lights.w);

	var offset = vec2f(0.0);
	let strength = fx_row(id, SW_DISTURB);
	if ((flags & SW_DISTURB1) != 0u) {
		let base = sw_base(id, 1u, bases, depth_scale);
		offset += sw_disturb(id, 1u, base, strength.xy, (flags & SW_DISTURB1_NORMAL) != 0u);
	}
	if ((flags & SW_DISTURB2) != 0u) {
		let base = sw_base(id, 2u, bases, depth_scale);
		offset += sw_disturb(id, 2u, base, strength.zw, (flags & SW_DISTURB2_NORMAL) != 0u);
	}
	let use_disturb = fx_row(id, SW_DISTURB_USE);

	// the lightmaps share slot 0's UVs
	let lightmap = sw_base(id, 0u, bases, depth_scale);
	let lightmap_uv =
		fx_slot_coords(id, 0u, lightmap[0] + fx_custom_shift(id, 0u, in.custom)) + offset * use_disturb.x;
	let gx = fx_slot_gradient(id, 0u, lightmap[1]) * bias;
	let gy = fx_slot_gradient(id, 0u, lightmap[2]) * bias;
	let positive = fx_sample(0u, lightmap_uv, gx, gy);
	let negative = fx_sample(6u, lightmap_uv, gx, gy).rgb;

	var mask = vec4f(1.0);
	if ((flags & SW_MASK) != 0u) {
		let base = sw_base(id, 3u, bases, depth_scale);
		mask = ws_sample(id, 3u, base[0], offset * use_disturb.y, base[1], base[2]);
		if ((flags & SW_MASK_RED_ALPHA) != 0u) {
			mask = vec4f(1.0, 1.0, 1.0, mask.r);
		}
	}
	let tint = fx_row(id, FX_TINT) * select(vec4f(1.0), in.color, (flags & SW_VERTEX_COLOR) != 0u);
	let c = tint * mask;
	var color = c.rgb;
	if ((flags & SW_BLEND) != 0u) {
		// the game applies the blend texture's `_ST` again after the distortion; its tint takes the vertex colour
		// whatever `_DisableVertColor` says
		let st = fx_row(id, FX_UV + 4u);
		let base = sw_base(id, 4u, bases, depth_scale);
		let blend_uv =
			(fx_slot_coords(id, 4u, base[0] + fx_custom_shift(id, 4u, in.custom)) + offset * use_disturb.z) * st.xy +
			st.zw;
		let blend = fx_sample(4u, blend_uv, fx_slot_gradient(id, 4u, base[1]) * st.xy * bias,
			fx_slot_gradient(id, 4u, base[2]) * st.xy * bias);
		let blend_tint = fx_row(id, SW_BLEND_TINT) * in.color;
		color += blend.rgb * saturate((c.a + blend.a) * blend_tint.a) * blend_tint.rgb;
	}
	var alpha = c.a;
	if ((flags & SW_DISSOLVE_ON) != 0u) {
		let dissolve = fx_row(id, SW_DISSOLVE);
		// a particle's custom data's z adds to the schedule
		let base = sw_base(id, 5u, bases, depth_scale);
		let v = ws_sample(id, 5u, base[0], offset * use_disturb.w, base[1], base[2]).r - dissolve.x -
			in.custom.z * 2.02;
		let edge = saturate((dissolve.z - v) * dissolve.y);
		alpha *= saturate(v * dissolve.y);
		color = mix(color, fx_row(id, SW_DISSOLVE_COLOR).rgb * edge, edge);
	}
	let depth = dot(in.rel, frame.view_forward.xyz);
	let soft = fx_row(id, FX_SOFT);
	if (soft.x > 0.0) {
		alpha *= saturate((fx_scene_depth(vec2i(in.position.xy)) - depth + soft.y) / soft.x);
	}
	alpha = positive.a * saturate(alpha * fx_near_fade(id, depth));
	let misc = fx_row(id, FX_MISC);
	color = clamp(color + max(color - vec3f(misc.y), vec3f(0.0)) * misc.z, vec3f(0.0), vec3f(1000.0));

	// the colour sets how strongly each channel is absorbed: 1 − log2(colour) / log2(0.2)
	let exponent = 1.0 + log2(max(color, vec3f(1e-5))) * -0.43067657;
	let range = row.z;

	// the particle's frame: right (its x axis, made square to the normal), up, and away from the camera
	var n = normalize(in.normal);
	n = select(-n, n, dot(n, in.rel) <= 0.0);
	let away = -n;
	let x_axis = normalize(in.to_object0.xyz);
	let right = normalize(x_axis - away * dot(x_axis, away));
	let up = cross(away, right);

	let world = in.rel + frame.eye.xyz;
	let all_axes = sw_absorb(positive.r, exponent, range) + sw_absorb(positive.g, exponent, range) +
		sw_absorb(positive.b, exponent, range) + sw_absorb(negative.r, exponent, range) +
		sw_absorb(negative.g, exponent, range) + sw_absorb(negative.b, exponent, range);
	var ambient = ambient_irradiance(world, n) * all_axes;
	{
		let grey = dot(ambient, LUMINANCE);
		ambient = mix(vec3f(grey), ambient, row.w);
	}
	let l = frame.sun.xyz;
	let lt = vec3f(dot(l, right), dot(l, up), dot(l, away));
	let through = dot(lt * lt, select(negative, positive.rgb, lt >= vec3f(0.0)));
	let sun = frame.sun_color.rgb * (frame.sun.w / PI) * sw_absorb(through, exponent, range) *
		sun_visibility(in.rel, n, in.position.xy);
	let shaded = ambient + sun;
	return fx_accumulate(shaded * alpha, alpha, in.rel, in.position.xy, fx_row(id, FX_UNFOGGED).x);
}

// #endregion

// #region water foam

// rows of a WaterDecal look (`WaterFoamRow` in water-foam.ts, in vec4s)
const WF_TINT = 17u;
const WF_DISTURB = 18u;
const WF_USE = 19u;
const WF_SOURCES = 20u;
const WF_MASK_MATRIX = 21u;
const WF_DISSOLVE = 22u;
const WF_DISSOLVE_COLOR = 23u;
const WF_BOX_UV = 24u;
const WF_FADE = 25u;
const WF_MIP = 26u;
const WF_EROSION = 27u;
const WF_EROSION_EDGE = 28u;
const WF_EROSION_LAYERS = 32u;

// `WaterFoamFlags`
const WF_DISTURB_ON = 1u;
const WF_MASK_ON = 2u;
const WF_DISSOLVE_ON = 4u;
const WF_EDGE_FADE = 8u;
const WF_CLIP_TO_BOX = 16u;
const WF_SOFT = 32u;
const WF_EROSION_ON = 64u;

// `EROSION_SLOTS` in water-foam.ts
const WF_SLOT_FLOW = 1u;
const WF_SLOT_FLOW_NOISE = 2u;
const WF_SLOT_GRADIENT = 3u;
const WF_SLOT_LAYERS = 4u;

// the layers' noises are read three mip levels finer, as the game's bias of −3
const WF_LAYER_GRADIENT_SCALE = 0.125;

// the flowmap and the gradient through the game's clamping sampler: the slots' samplers repeat, so the UVs stop
// half a texel inside the edges
fn wf_sample_clamped(slot: u32, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f {
	var size: vec2u;
	if (slot == WF_SLOT_FLOW) {
		size = textureDimensions(fx_tex1);
	} else {
		size = textureDimensions(fx_tex3);
	}
	let half_texel = 0.5 / vec2f(size);
	return fx_sample(slot, clamp(uv, half_texel, 1.0 - half_texel), dx, dy);
}

// `_USE_WATER_EROSION`, the red tide's flowing front (docs/game-data/water.md#water-erosion), over the foam's
// colour, from the mesh's UV0 and its gradients
fn wf_erosion(id: u32, color: vec3f, uv: vec2f, dx: vec2f, dy: vec2f, t: f32) -> vec3f {
	let row = fx_row(id, WF_EROSION);
	// the noise: its `_ST`, then its scroll
	let noise_st = fx_row(id, FX_UV + WF_SLOT_FLOW_NOISE);
	let noise_uv = uv * noise_st.xy + noise_st.zw + fx_row(id, FX_ANIM + WF_SLOT_FLOW_NOISE).xy * t;
	let noise = fx_sample(WF_SLOT_FLOW_NOISE, noise_uv, dx * noise_st.xy, dy * noise_st.xy).r * row.x;
	// the flowmap: its `_ST`, its u shifted by the noise
	let flow_st = fx_row(id, FX_UV + WF_SLOT_FLOW);
	var flow_uv = uv * flow_st.xy + flow_st.zw;
	flow_uv.x += noise * row.y;
	let flow = wf_sample_clamped(WF_SLOT_FLOW, flow_uv, dx * flow_st.xy, dy * flow_st.xy);
	let front = saturate(flow * row.z + noise + row.w);
	// the gradient: u from the front's position along UV0's u, v from UV0's v. its gradients leave out the noise's
	// and the clamps' share
	let gradient_st = fx_row(id, FX_UV + WF_SLOT_GRADIENT);
	let along = saturate(uv.x * row.z + noise + row.w);
	let gradient_uv = vec2f(saturate(along * gradient_st.x + gradient_st.z), uv.y * gradient_st.y);
	let gradient_scale = vec2f(gradient_st.x * row.z, gradient_st.y);
	let gradient = wf_sample_clamped(WF_SLOT_GRADIENT, gradient_uv, dx * gradient_scale, dy * gradient_scale);
	// each layer's colour where its flow channel passes its threshold, broken up by its noise and kept to the
	// gradient's alpha
	var layers: array<vec3f, 3>;
	for (var i = 0u; i < 3u; i++) {
		let slot = WF_SLOT_LAYERS + i;
		let st = fx_row(id, FX_UV + slot);
		let layer_uv = uv * st.xy + st.zw + fx_row(id, FX_ANIM + slot).xy * t;
		let scale = st.xy * WF_LAYER_GRADIENT_SCALE;
		let layer_noise = saturate(fx_sample(slot, layer_uv, dx * scale, dy * scale).rgb);
		let layer = fx_row(id, WF_EROSION_LAYERS + i);
		layers[i] = layer.rgb * saturate(front[i + 1u] - layer.w) * layer_noise * gradient.a;
	}
	// the flowmap's colour darkens the foam, the second and third layers cover it, then the first
	var c = color * (1.0 - length(flow.rgb));
	c = mix(c, layers[1], saturate(length(layers[1])));
	c = mix(c, layers[2], saturate(length(layers[2])));
	c = mix(c, layers[0], saturate(length(layers[0])));
	return c + gradient.rgb * fx_row(id, WF_EROSION_EDGE).rgb * flow.r;
}

// a UV source picked by the game's switch value (`WaterFoamSource` in package-format): the box, polar, the world
// over 10 m, UV set 0, with fractional values blending between neighbours
fn wf_pick(s: f32, a: vec2f, b: vec2f, c: vec2f, d: vec2f) -> vec2f {
	return mix(mix(mix(a, b, s), c, saturate(s - 1.0)), d, saturate(s - 2.0));
}

// WaterDecal boxes (`waterFoamLook`): each covered pixel finds the water surface along its view ray (the water
// pass's depth in `fx_depth`) and writes the foam the box projects there, down its y. the water pass then lights
// it as its foam (docs/viewer/water.md#foam-boxes). rgb is the premultiplied foam, alpha how much of what's
// there it covers (0 with `_BlendMode` 1), clamped as the game's 8-bit target clamps it
@fragment
fn fs_water_foam(in: EffectOut) -> @location(0) vec4f {
	let id = in.look;
	let px = vec2i(in.position.xy);
	let water_device = textureLoad(fx_depth, px, 0);
	let water_depth = select(1e9, frame.local_lights.w / water_device, water_device > 0.0);
	let rel = in.rel * (water_depth / dot(in.rel, frame.view_forward.xyz));
	let p = vec4f(rel, 1.0);
	let object_p = vec3f(dot(in.to_object0, p), dot(in.to_object1, p), dot(in.to_object2, p));
	let box_uv_row = fx_row(id, WF_BOX_UV);
	let box = (object_p.xz + 0.5) * box_uv_row.xy + box_uv_row.zw;
	let centred = box - 0.5;
	let polar = fx_polar(centred);
	let world = (rel.xz + frame.eye.xz) * 0.1;
	let mesh = in.uv.xy;
	// gradients before anything branches; the polar angle's wraps at its seam
	let bias = exp2(frame.params.y);
	// the material's own mip bias, as scaled gradients
	let mip = fx_row(id, WF_MIP);
	let base_bias = bias * exp2(mip.x);
	let mask_bias = bias * exp2(mip.y);
	var polar_dx = dpdx(polar);
	var polar_dy = dpdy(polar);
	polar_dx.x -= round(polar_dx.x);
	polar_dy.x -= round(polar_dy.x);
	let box_dx = dpdx(box);
	let box_dy = dpdy(box);
	let world_dx = dpdx(world);
	let world_dy = dpdy(world);
	let mesh_dx = dpdx(mesh);
	let mesh_dy = dpdy(mesh);
	let sources = fx_row(id, WF_SOURCES);
	let base_src = wf_pick(sources.x, box, polar, world, mesh);
	let base_dx = wf_pick(sources.x, box_dx, polar_dx, world_dx, mesh_dx) * base_bias;
	let base_dy = wf_pick(sources.x, box_dy, polar_dy, world_dy, mesh_dy) * base_bias;
	let disturb_src = wf_pick(sources.y, box, polar, world, mesh);
	let disturb_dx = wf_pick(sources.y, box_dx, polar_dx, world_dx, mesh_dx) * bias;
	let disturb_dy = wf_pick(sources.y, box_dy, polar_dy, world_dy, mesh_dy) * bias;
	let mask_src = wf_pick(sources.z, box, polar, world, mesh);
	let mask_dx = wf_pick(sources.z, box_dx, polar_dx, world_dx, mesh_dx) * mask_bias;
	let mask_dy = wf_pick(sources.z, box_dy, polar_dy, world_dy, mesh_dy) * mask_bias;
	let dissolve_src = wf_pick(sources.w, box, polar, world, mesh);

	let tint = fx_row(id, WF_TINT);
	let flags = u32(tint.w);
	if (water_device <= 0.0 || ((flags & WF_CLIP_TO_BOX) != 0u && any(abs(object_p) >= vec3f(0.5)))) {
		return vec4f(0.0);
	}
	let t = frame.eye.w;
	let use_disturb = fx_row(id, WF_USE);
	let disturb_row = fx_row(id, WF_DISTURB);

	// the distortion: scrolled, then the disturb texture's `_ST`
	var offset = vec2f(0.0);
	if ((flags & WF_DISTURB_ON) != 0u) {
		let st = fx_row(id, FX_UV + 1u);
		let uv = (disturb_src + fx_row(id, FX_ANIM + 1u).xy * t) * st.xy + st.zw;
		let d = fx_sample(1u, uv, disturb_dx * st.xy, disturb_dy * st.xy).r * (disturb_row.x + 1.0) - disturb_row.x;
		offset = d * disturb_row.yz;
	}
	// the base colour: its `_ST`, then its scroll
	var base = vec4f(1.0);
	{
		let st = fx_row(id, FX_UV);
		let uv = (base_src + offset * use_disturb.x) * st.xy + st.zw + fx_row(id, FX_ANIM).xy * t;
		base = fx_sample(0u, uv, base_dx * st.xy, base_dy * st.xy);
	}
	let base_alpha = mix(1.0, base.a, use_disturb.w);
	var color = fx_row(id, FX_TINT).rgb + base.rgb * base_alpha * tint.rgb;
	var cover = 1.0 + base_alpha;
	// the dissolve, read at a fixed mip level as the game does: scrolled, then its `_ST`
	if ((flags & WF_DISSOLVE_ON) != 0u) {
		let st = fx_row(id, FX_UV + 3u);
		let row = fx_row(id, WF_DISSOLVE);
		let uv = (dissolve_src + offset * use_disturb.z + fx_row(id, FX_ANIM + 3u).xy * t) * st.xy + st.zw;
		let v = fx_sample_level(3u, uv, mip.z).r - row.x;
		let kept = saturate(v * row.y);
		let edge = saturate((row.z - v) * row.y);
		color = mix(color, fx_row(id, WF_DISSOLVE_COLOR).rgb * edge, edge) * kept;
		cover *= kept;
	}
	// the mask: turned about its centre, then its `_ST`, then its scroll
	if ((flags & WF_MASK_ON) != 0u) {
		let st = fx_row(id, FX_UV + 2u);
		let m = fx_row(id, WF_MASK_MATRIX);
		let turn = mat2x2f(m.xy, m.zw);
		let uv = (turn * (mask_src - 0.5) + 0.5 + offset * use_disturb.y) * st.xy + st.zw + fx_row(id, FX_ANIM + 2u).xy * t;
		let mask = fx_sample(2u, uv, (turn * mask_dx) * st.xy, (turn * mask_dy) * st.xy);
		color *= mask.rgb;
		color = mix(color, color * mask.a, fx_row(id, WF_DISSOLVE).w);
	}
	if ((flags & WF_EROSION_ON) != 0u) {
		color = wf_erosion(id, color, mesh, mesh_dx * bias, mesh_dy * bias, t);
	}
	let fade = fx_row(id, WF_FADE);
	var edge_fade = 1.0;
	if ((flags & WF_EDGE_FADE) != 0u) {
		edge_fade = saturate(1.0 - length(abs(centred) + fade.xy) * 1.4142);
	}
	// the soft blend, in reversed-Z device depth like the game's: the box's face against the water's surface
	var soft = 1.0;
	if ((flags & WF_SOFT) != 0u) {
		soft = saturate((saturate(water_device - in.position.z) + fade.z) / fade.w);
	}
	let out_color = max(color, vec3f(0.0)) * soft * cover * edge_fade * fx_row(id, FX_TINT).w;
	return vec4f(out_color, saturate(cover * (1.0 - disturb_row.w)));
}

// #endregion

// unpacks the normal of `pack_reflection_surface` (frame.wgsl), or returns zero where nothing lit was drawn
fn fx_surface_normal(px: vec2i) -> vec3f {
	let surface = unpack_reflection_surface(textureLoad(fx_surface, px, 0).xy);
	if (!surface.valid) {
		return vec3f(0.0);
	}
	return surface.normal;
}

// VFXDecal's `_USE_PARALLAX` (docs/game-data/effects.md#vfxdecal): the main texture's UV shift where the view
// ray (`view`, towards the camera) meets the depth texture's red (1 at the top), stepped down in 30 layers and
// interpolated between the last layer above the surface and the first below
fn fx_decal_parallax(id: u32, in: EffectOut, bases: FxBases, view: vec3f) -> vec2f {
	let row = fx_row(id, FX_PARALLAX);
	let depth_slot = u32(row.y);
	let v = vec3f(
		dot(view, normalize(in.to_object0.xyz)),
		dot(view, normalize(in.to_object2.xyz)),
		dot(view, in.up),
	);
	let step = v.xy / v.z * row.x;
	let bits = fx_slot_bits(id, 0u);
	let base = fx_slot_base(bases, bits);
	let bias = exp2(frame.params.y);
	let uv = fx_slot_coords(id, 0u, base[0]);
	let dx = fx_slot_gradient(id, 0u, base[1]) * bias;
	let dy = fx_slot_gradient(id, 0u, base[2]) * bias;
	var shift = step;
	var previous = vec2f(0.0);
	var layer = 29.0 / 30.0;
	var height = 0.0;
	var previous_layer = 1.0;
	var previous_height = 0.0;
	for (var i = 0; i < 31; i++) {
		height = fx_sample(depth_slot, uv + shift, dx, dy).r;
		if (height > layer) {
			break;
		}
		previous = shift;
		previous_layer = layer;
		previous_height = height;
		shift += step;
		layer -= 1.0 / 30.0;
	}
	let t = (previous_height - previous_layer) / ((previous_height - height) + layer - previous_layer);
	return previous + step * t;
}

// a decal's cracks at the parallax-shifted main UVs: the crack colour weighed against the crack noise by the
// crack mask's red. the noise takes its own UVs, the distortion's share and the parallax shift
fn fx_decal_cracks(id: u32, bases: FxBases, uv: vec2f, dx: vec2f, dy: vec2f, offset: vec2f, parallax: vec2f)
	-> vec3f {
	let row = fx_row(id, FX_PARALLAX);
	let crack_row = fx_row(id, FX_CRACK);
	let crack = fx_sample(u32(row.z), uv, dx, dy).r;
	let noise_slot = u32(row.w);
	let bits = fx_slot_bits(id, noise_slot);
	let base = fx_slot_base(bases, bits);
	let bias = exp2(frame.params.y);
	let noise_uv = fx_slot_coords(id, noise_slot, base[0]) + offset * crack_row.w + parallax;
	let noise = fx_sample(
		noise_slot,
		noise_uv,
		fx_slot_gradient(id, noise_slot, base[1]) * bias,
		fx_slot_gradient(id, noise_slot, base[2]) * bias,
	);
	return mix(crack_row.rgb * crack, noise.rgb * fx_row(id, FX_CRACK_NOISE).rgb, crack);
}

// VFXDecal boxes, drawn by their back faces without a depth test: each covered pixel finds the main pass's
// surface along its view ray, and the texture stack projects onto it down the box's y, faded towards the
// box's sides and top and bottom, on surfaces facing away from the projection, and near the camera
@fragment
fn fs_effect_decal(in: EffectOut) -> EffectAccumulated {
	let id = in.look;
	let px = vec2i(in.position.xy);
	let scene_depth = fx_scene_depth(px);
	let rel = in.rel * (scene_depth / dot(in.rel, frame.view_forward.xyz));
	let p = vec4f(rel, 1.0);
	let object_p = vec3f(dot(in.to_object0, p), dot(in.to_object1, p), dot(in.to_object2, p));
	let uv = object_p.xz + 0.5;
	// the decal's screen UVs are the pixel's position over the width, unlike VFXBaseV2's
	let screen = floor(in.position.xy) / frame.render_size.x;
	let bases = fx_bases(uv, uv, fx_polar(object_p.xz), screen);
	let rel_dx = dpdx(rel);
	let rel_dy = dpdy(rel);
	if (any(abs(object_p) >= vec3f(0.5)) || scene_depth >= 1e9) {
		return fx_nothing();
	}
	if (fx_row(id, FX_UNFOGGED).y == FX_KIND_LIT_DECAL) {
		if (fx_keeps_lit_decals_off(px)) {
			return fx_nothing();
		}
		return fx_lit_decal(in, px, rel, rel_dx, rel_dy, object_p, uv, bases.dx[0], bases.dy[0]);
	}
	let cracked = fx_row(id, FX_PARALLAX).y != 0.0;
	var parallax = vec2f(0.0);
	if (cracked) {
		parallax = fx_decal_parallax(id, in, bases, normalize(-rel));
	}
	let combined = fx_combine(id, bases, fx_row(id, FX_TINT), in.custom, in.color, cracked, parallax);
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
	if (fx_row(id, FX_UNFOGGED).z >= 0.5) {
		return fx_additive(color * alpha * alpha);
	}
	return fx_accumulate(color * alpha * alpha, alpha, rel, in.position.xy, fx_row(id, FX_UNFOGGED).x);
}

// #region lit decals

// `EffectKind.LitDecal` (effect-look.ts)
const FX_KIND_LIT_DECAL = 2.0;
// rows of a lit decal look (`DecalLitRow` in lit-decal.ts, in vec4s)
const LD_SURFACE = 17u;
const LD_WRITES = 18u;
const LD_PBR = 19u;
const LD_CHANNELS = 20u;
const LD_WATER = 21u;
const LD_FLOW = 22u;
const LD_FLOW_FADE = 23u;
const LD_EMISSIVE = 24u;
const LD_EMISSIVE_MASK = 25u;
const LD_PBR_PLACED = 26u;
const LD_SLUDGE = 32u;
// the sludge texture's slot, whose UV row holds its scale
const LD_SLUDGE_SLOT = 2u;

// one of four map channels by `_MetallicChannel`/`_OcclusionChannel`'s numbering, as the game blends them:
// `offset` 1 for the occlusion's (R at 1, … A at 4) and 0 for the metallic's (R at 2, … A at 5)
fn ld_channel(p: vec4f, channel: f32, offset: f32) -> f32 {
	let c = channel + offset;
	return mix(mix(p.x, p.y, saturate(c - 2.0)), mix(p.z, p.w, saturate(c - 4.0)), saturate(c - 3.0));
}

// a decoded tangent-space normal map texel, unit length
fn ld_tangent_normal(rg: vec2f) -> vec3f {
	let xy = unpack_normal_xy(rg);
	return vec3f(xy, normal_z(xy));
}

// what a lit decal makes of the surface beneath at one pixel
struct LitDecal {
	// how much of it shows, 0 to 1
	alpha: f32,
	// the decal's colour, which only laid-over decals use
	albedo: vec3f,
	normal: vec3f,
	roughness: f32,
	// metallic and occlusion where the decal writes them (`writes_metallic`, `writes_occlusion`)
	metallic: f32,
	occlusion: f32,
	writes_metallic: bool,
	writes_occlusion: bool,
	// `_BLEND_EMISSIVE`'s light, in pre-exposed units like the surface's own; zero without it
	emission: vec3f,
}

// `HGRP/DecalLit` boxes (`litDecalLook` in lit-decal.ts, docs/game-data/materials.md#decals) over a surface of
// normal `n` and roughness `roughness` at camera-relative `rel` (with its screen gradients): where the
// material's colour masks let it, the decal's roughness, normal, metallic and occlusion replace the surface's.
// `local` is the point in the box (±0.5) and `uv` its `local.xz + 0.5` with its screen gradients; the
// placement's colour and UV transform are its row's
fn ld_decal(in: EffectOut, rel: vec3f, rel_dx: vec3f, rel_dy: vec3f, local: vec3f, uv: vec2f, dx: vec2f, dy: vec2f,
	n: vec3f, roughness: f32) -> LitDecal {
	let id = in.look;
	let base_t = in.placement_uv;
	let base = textureSampleGrad(fx_tex0, fx_samp0, uv * base_t.xy + base_t.zw, dx * base_t.xy, dy * base_t.xy);
	// the PBR map's own transform, or the placement's
	let pbr_t = select(fx_row(id, FX_UV + 1u), in.placement_uv, fx_row(id, LD_PBR_PLACED).x > 0.5);
	// the placement's colour, its alpha times the opacity
	let tint = in.placement_color * fx_row(id, FX_TINT);
	let surface_row = fx_row(id, LD_SURFACE);
	let writes = fx_row(id, LD_WRITES);
	let pbr_row = fx_row(id, LD_PBR);
	let channels = fx_row(id, LD_CHANNELS);
	let water = fx_row(id, LD_WATER);
	// with `_BaseTexChannel` the base map is the PBR map, and the colour the placement's alone
	let pbr_base = channels.x > 0.5;

	var d: LitDecal;
	d.albedo = tint.rgb * select(base.rgb, vec3f(1.0), pbr_base);
	d.normal = n;
	d.roughness = roughness;
	d.metallic = 0.0;
	d.occlusion = 1.0;
	d.writes_metallic = false;
	d.writes_occlusion = false;
	d.emission = vec3f(0.0);
	var alpha = base.a * tint.a;
	if (surface_row.w > 0.0) {
		alpha *= pow(max(saturate(dot(in.up, n)), 5.96e-8), surface_row.w);
	}
	let sludge = fx_row(id, LD_SLUDGE);
	if (sludge.x > 0.5) {
		// `_BLEND_SLUDGE_EROSION`: surfaces facing the world's x and z take the sludge texture, untinted, at the
		// box's local zy and xy; the weights are the surface normal's squared world components, as the game's
		let st = fx_row(id, FX_UV + LD_SLUDGE_SLOT).xy;
		let local_dx = vec3f(dot(in.to_object0.xyz, rel_dx), dot(in.to_object1.xyz, rel_dx), dot(in.to_object2.xyz, rel_dx));
		let local_dy = vec3f(dot(in.to_object0.xyz, rel_dy), dot(in.to_object1.xyz, rel_dy), dot(in.to_object2.xyz, rel_dy));
		let side_x = textureSampleGrad(fx_tex2, fx_samp2, local.zy * st, local_dx.zy * st, local_dy.zy * st);
		let side_z = textureSampleGrad(fx_tex2, fx_samp2, local.xy * st, local_dx.xy * st, local_dy.xy * st);
		let w = n * n;
		d.albedo = d.albedo * w.y + side_x.rgb * w.x + side_z.rgb * w.z;
		// the alpha stays the base map's, scaled, and fades out above the box's centre
		alpha *= sludge.y * saturate(1.0 - local.y * sludge.z);
	}

	var tangent_n: vec3f;
	var pbr: vec4f;
	if (water.x > 0.5) {
		let flow = fx_row(id, LD_FLOW);
		let steep = pow(max(abs(1.0 - abs(n.y)), 5.96e-8), fx_row(id, LD_FLOW_FADE).x);
		alpha *= steep;
		let n2 = n * n;
		let w = n2.xz / max(n2.x + n2.z, 1e-5);
		let push = vec2f(0.0, steep * water.w);
		let world = frame.eye.xyz + rel;
		let scroll = vec2f(0.0, frame.eye.w);
		let zy = world.zy * pbr_t.xy;
		let xy = world.xy * pbr_t.xy;
		let zy_dx = rel_dx.zy * pbr_t.xy;
		let zy_dy = rel_dy.zy * pbr_t.xy;
		let xy_dx = rel_dx.xy * pbr_t.xy;
		let xy_dy = rel_dy.xy * pbr_t.xy;
		let a_zy = textureSampleGrad(fx_tex1, fx_samp1, zy * flow.z + scroll * flow.x + push, zy_dx * flow.z, zy_dy * flow.z);
		let a_xy = textureSampleGrad(fx_tex1, fx_samp1, xy * flow.z + scroll * flow.x + push, xy_dx * flow.z, xy_dy * flow.z);
		let b_zy = textureSampleGrad(fx_tex1, fx_samp1, zy * flow.w + scroll * flow.y + push, zy_dx * flow.w, zy_dy * flow.w);
		let b_xy = textureSampleGrad(fx_tex1, fx_samp1, xy * flow.w + scroll * flow.y + push, xy_dx * flow.w, xy_dy * flow.w);
		let t = (ld_tangent_normal(a_zy.rg) + ld_tangent_normal(b_zy.rg)) * w.x +
			(ld_tangent_normal(a_xy.rg) + ld_tangent_normal(b_xy.rg)) * w.y;
		tangent_n = vec3f(t.xy * water.y, t.z);
		pbr = vec4f(0.0, 0.0, (a_zy.b + a_xy.b) * 0.5, 0.0);
		if (writes.y > 0.5) {
			d.roughness = water.z * pbr.b;
		}
	} else {
		let sampled = textureSampleGrad(fx_tex1, fx_samp1, uv * pbr_t.xy + pbr_t.zw, dx * pbr_t.xy, dy * pbr_t.xy);
		pbr = select(sampled, base, pbr_base);
		let t = ld_tangent_normal(pbr.rg);
		tangent_n = vec3f(t.xy * surface_row.z, t.z);
		if (writes.y > 0.5) {
			d.roughness = mix(surface_row.x, surface_row.y, pbr.b);
		}
		let emissive = fx_row(id, LD_EMISSIVE);
		if (emissive.w > 0.5) {
			// the channel blends R → G → B → A → the base map's alpha as it rises from 0 to 4, from `_SampleTex1`
			// itself even when the base map stands in for the PBR map
			let mask = fx_row(id, LD_EMISSIVE_MASK);
			let c = mask.x;
			let rgba = mix(mix(sampled.r, sampled.g, saturate(c)), mix(sampled.b, sampled.a, saturate(c - 2.0)), saturate(c - 1.0));
			let strength = mix(rgba, base.a, saturate(c - 3.0));
			d.emission = emissive.rgb * strength * mix(d.albedo, vec3f(1.0), mask.y) * mix(1.0, frame.ambient.y, mask.z);
		}
	}
	d.alpha = saturate(alpha);
	if (writes.x > 0.5) {
		// the box's frame (x tangent, y normal), or the surface's by `_BlendSceneNormal`; the bitangent's sign is
		// the game's −1. the result turns from the surface's normal by `_AffectNormal`
		let t = normalize(in.to_object0.xyz);
		let frame_n = normalize(mix(in.up, n, writes.z));
		let b = -mix(cross(in.up, t), cross(n, t), writes.z);
		let decal_n = normalize(t * tangent_n.x + b * tangent_n.y + frame_n * tangent_n.z);
		d.normal = normalize(mix(n, decal_n, channels.w));
	}
	if (pbr_row.x > 0.5) {
		d.writes_metallic = true;
		d.metallic = mix(pbr_row.z * saturate(channels.y), ld_channel(pbr, channels.y, 0.0), saturate(channels.y - 1.0));
	}
	if (pbr_row.y > 0.5) {
		d.writes_occlusion = true;
		let occlusion = mix(1.0, ld_channel(pbr, channels.z, 1.0), saturate(channels.z));
		d.occlusion = (1.0 - pbr_row.w) + occlusion * pbr_row.w;
	}
	return d;
}

// whether the surface under a pixel keeps lit decals off (`SURFACE_NO_LIT_DECALS`), as the game's stencil test
fn fx_keeps_lit_decals_off(px: vec2i) -> bool {
	return (textureLoad(fx_surface, px, 0).y & SURFACE_NO_LIT_DECALS) != 0u;
}

// the main pass's roughness under a pixel (`pack_reflection_surface`)
fn fx_surface_roughness(px: vec2i) -> f32 {
	return f32(textureLoad(fx_surface, px, 0).x >> 24u) / 255.0;
}

// a lit decal laid over the surface by its alpha, over the composited scene before the water draws, lit like any
// surface: the decals that write albedo
fn fx_lit_decal(in: EffectOut, px: vec2i, rel: vec3f, rel_dx: vec3f, rel_dy: vec3f, local: vec3f, uv: vec2f,
	dx: vec2f, dy: vec2f) -> EffectAccumulated {
	var n = fx_surface_normal(px);
	var roughness = fx_surface_roughness(px);
	if (all(n == vec3f(0.0))) {
		n = in.up;
		roughness = 1.0;
	}
	let d = ld_decal(in, rel, rel_dx, rel_dy, local, uv, dx, dy, n, roughness);
	if (d.alpha <= 0.0) {
		return fx_nothing();
	}
	var s = default_surface(d.albedo, d.normal);
	s.roughness = d.roughness;
	if (d.writes_metallic) {
		s.metallic = d.metallic;
	}
	if (d.writes_occlusion) {
		s.occlusion = d.occlusion;
	}
	s.emission = d.emission;
	let shaded = shade_surface(s, rel, in.position.xy);
	return fx_accumulate(shaded.radiance.rgb * d.alpha, d.alpha, rel, in.position.xy, 0.0);
}

// lit decals that write no albedo, between the main and the transparent pass (docs/viewer/materials.md#decals):
// each adds the difference between the surface lit with and without its changes, times its alpha, to the
// radiance. the surface's colour is its diffuse ambient over the ambient light at its normal (taken as a
// dielectric's)
@fragment
fn fs_decal_relight(in: EffectOut) -> @location(0) vec4f {
	let px = vec2i(in.position.xy);
	let scene_depth = fx_scene_depth(px);
	let rel = in.rel * (scene_depth / dot(in.rel, frame.view_forward.xyz));
	let p = vec4f(rel, 1.0);
	let object_p = vec3f(dot(in.to_object0, p), dot(in.to_object1, p), dot(in.to_object2, p));
	let uv = object_p.xz + 0.5;
	let dx = dpdx(uv);
	let dy = dpdy(uv);
	let rel_dx = dpdx(rel);
	let rel_dy = dpdy(rel);
	let n = fx_surface_normal(px);
	if (any(abs(object_p) >= vec3f(0.5)) || scene_depth >= 1e9 || all(n == vec3f(0.0)) || fx_keeps_lit_decals_off(px)) {
		return vec4f(0.0);
	}
	let d = ld_decal(in, rel, rel_dx, rel_dy, object_p, uv, dx, dy, n, fx_surface_roughness(px));
	if (d.alpha <= 0.0) {
		return vec4f(0.0);
	}
	let ambient = textureLoad(fx_ambient, px, 0);
	let irradiance = ambient_irradiance(frame.eye.xyz + rel, n);
	let diffuse = saturate(ambient.rgb / max(irradiance, vec3f(1e-4)));
	var before = default_surface(diffuse, n);
	before.roughness = fx_surface_roughness(px);
	before.occlusion = ambient.a;
	var after = before;
	after.normal = d.normal;
	after.roughness = d.roughness;
	if (d.writes_occlusion) {
		after.occlusion = d.occlusion;
	}
	// the decal's emission is added over the surface's rather than replacing it by the alpha
	let change = shade_surface(after, rel, in.position.xy).radiance.rgb - shade_surface(before, rel, in.position.xy).radiance.rgb;
	return vec4f((change + d.emission) * d.alpha, 0.0);
}

// #endregion

// #region mist

// rows of a mist look (`MistRow` in mist.ts, in vec4s)
const MIST_COLOR = 0u;
const MIST_CARD = 8u;
const MIST_WIND = 9u;
const MIST_LIGHT = 10u;
const MIST_INDIRECT = 11u;
const MIST_FADE = 12u;
const MIST_TOP = 13u;
const MIST_VOLUME = 14u;
// cards' Fresnel term, in the volumes' row
const MIST_FRESNEL = 14u;
const MIST_VOLUME_HEIGHT = 15u;
const MIST_VOLUME_FADE = 16u;
const MIST_MISC = 17u;
const MIST_VOLUME_NOISE = 18u;
const MIST_VOLUME_NOISE_FLOW = 19u;
const MIST_VOLUME_NOISE_MIX = 20u;

// a mist layer over the scene at camera-relative `rel`: additive ones add, premultiplied ones blend like other
// layers
fn mist_accumulate(id: u32, premultiplied: vec3f, alpha: f32, rel: vec3f, position: vec2f) -> EffectAccumulated {
	if (fx_row(id, MIST_INDIRECT).w != 0.0) {
		return fx_additive(premultiplied);
	}
	return fx_accumulate(premultiplied, alpha, rel, position, 0.0);
}

// a fade between two view depths: in from x to y (or out, when y < x)
fn mist_fade(range: vec2f, depth: f32) -> f32 {
	return saturate((depth - range.x) / (range.y - range.x));
}

// `HGRP/FogSimple` mist cards (docs/game-data/effects.md#mist): the main texture's red broken up by the noise
// texture, the wind and a Fresnel term, in the flat colour or lit by the sun; faded by view depth, towards the
// card's top and where it nears what lies behind it
@fragment
fn fs_mist_card(in: EffectOut) -> EffectAccumulated {
	let id = in.look;
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
		// convert the viewer's sun illuminance to diffuse radiance (docs/viewer/lighting.md#sun)
		let n = normalize(in.normal) * select(-1.0, 1.0, dot(in.normal, -in.rel) >= 0.0);
		let lit = (1.0 - light.w) + max(dot(n, frame.sun.xyz), 0.0) * light.w;
		let sun = frame.sun_color.rgb * (frame.sun.w / PI);
		color = mix(fx_row(id, MIST_INDIRECT).rgb, base.rgb * sun, lit);
	}
	let windy = (1.0 - card.z) + ((1.0 - card.w) + saturate(mix(-wind.x, wind.x + 1.0, gust)) * card.w) * card.z;
	color *= windy;
	alpha *= windy;
	let fresnel = fx_row(id, MIST_FRESNEL);
	if (fresnel.x != 0.0) {
		let facing = saturate(abs(dot(normalize(-in.rel), normalize(in.normal))));
		let f = mix(1.0, pow(max(abs(mix(1.0 - facing, facing, fresnel.w)), 0.00048828125), fresnel.z), fresnel.y);
		color *= f;
		alpha *= f;
	}

	let depth = dot(in.rel, frame.view_forward.xyz);
	let fade = fx_row(id, MIST_FADE);
	let top = fx_row(id, MIST_TOP);
	// the top fade runs by the world height below the origin, in units of the object's y scale, not along the
	// object's y axis: an upside-down card still fades towards the sky
	let basis = mist_basis(in);
	let origin = -(basis * vec3f(in.to_object0.w, in.to_object1.w, in.to_object2.w));
	let below = (origin.y - in.rel.y) / max(length(basis[1]), 1e-6);
	var soft = 1.0;
	if (top.z > 0.0) {
		soft = saturate((fx_scene_depth(vec2i(in.position.xy)) - depth) / top.z);
	}
	alpha = saturate(
		alpha * mist_fade(fade.xy, depth) * mist_fade(fade.zw, depth) * saturate(below * top.x + top.y) * soft * card.x,
	);
	return mist_accumulate(id, max(color, vec3f(0.0)) * alpha, alpha, in.rel, in.position.xy);
}

// `HGRP/Effect/VFXFakeVolumeFog` boxes (docs/game-data/effects.md#mist), drawn by their back faces without a
// depth test like the decals: the fog's thickness from the nearer of the surface behind and the back face,
// along the ray towards the camera through the unit cube (or up to the camera inside it), then the box's fades
@fragment
fn fs_mist_volume(in: EffectOut) -> EffectAccumulated {
	let id = in.look;
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
	let noise_mix = fx_row(id, MIST_VOLUME_NOISE_MIX);
	if (noise_mix.w != 0.0) {
		// scrolling 3D noise thins the fog where it's high, by an intensity that moves from the near value to
		// the far one over distance; negative intensities thin it further
		let noise_at = fx_row(id, MIST_VOLUME_NOISE);
		let at = select(object_p, frame.eye.xyz + rel, noise_at.w != 0.0);
		let uvw = at * noise_at.xyz + fx_row(id, MIST_VOLUME_NOISE_FLOW).xyz * frame.eye.w;
		let n = textureSampleLevel(fx_volume, fx_volume_samp, uvw, 0.0).r;
		let intensity = mix(noise_mix.y, noise_mix.x, 1.0 - saturate(length(rel) * noise_mix.z));
		alpha *= saturate(1.0 - n + intensity * n);
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
	return mist_accumulate(id, color * alpha, alpha, rel, in.position.xy);
}

// an effect object's object → world basis (columns are its scaled axes), from its world → object rows
fn mist_basis(in: EffectOut) -> mat3x3f {
	return inverse3(transpose(mat3x3f(in.to_object0.xyz, in.to_object1.xyz, in.to_object2.xyz)));
}

// the camera-relative origin of an effect's object, from its world → object rows
fn mist_origin(in: EffectOut) -> vec3f {
	return -(mist_basis(in) * vec3f(in.to_object0.w, in.to_object1.w, in.to_object2.w));
}

// #endregion

// #region light beams

// `EffectKind.Beam` (effect-look.ts), in FX_UNFOGGED's y
const FX_KIND_BEAM = 3.0;

// rows of a light beam's look (`BeamRow` in light-beam.ts, in vec4s)
const BM_COLOR = 0u;
const BM_CONE = 1u;
const BM_DIRECTION = 2u;
const BM_FALLOFF = 3u;
const BM_ALPHA = 4u;
const BM_GLARE = 5u;
const BM_FADE = 6u;
const BM_CLIP = 7u;
const BM_PLANE = 8u;
const BM_TILT = 9u;

// the beam's scale from its unit cone (the transform holds the rest): largest radius across, length along
fn beam_scale(id: u32) -> vec3f {
	let cone = fx_row(id, BM_CONE);
	let radius = max(max(cone.x, cone.y), 1e-6);
	return vec3f(radius, radius, fx_row(id, BM_FALLOFF).z);
}

// the cone mesh's vertex shaped into the beam: z squared along the length, the radius from start to end, and
// the side skewed along the beam's direction
fn beam_vertex(id: u32, p: vec3f) -> vec3f {
	let cone = fx_row(id, BM_CONE);
	let dir = fx_row(id, BM_DIRECTION);
	let scale = beam_scale(id);
	let z = p.z * p.z;
	var xy = p.xy * mix(cone.x, cone.y, z) / scale.x;
	xy += dir.xy * z * scale.z / (scale.xy * dir.z);
	return vec3f(xy, z);
}

// a point in the beam's own frame, with the direction's skew taken out
fn beam_unskew(id: u32, p: vec3f) -> vec3f {
	let dir = fx_row(id, BM_DIRECTION);
	return vec3f(p.xy - dir.xy * (p.z / dir.z), p.z);
}

// a volumetric light beam (docs/game-data/lighting.md#light-beams): the product of the side, attenuation and
// fade terms listed there. the mesh holds the inside and outside faces (UV0's v) and a start cap (u)
fn light_beam(in: EffectOut) -> EffectAccumulated {
	let id = in.look;
	let color = fx_row(id, BM_COLOR);
	let cone = fx_row(id, BM_CONE);
	let dir = fx_row(id, BM_DIRECTION);
	let falloff = fx_row(id, BM_FALLOFF);
	let alpha = fx_row(id, BM_ALPHA);
	let glare = fx_row(id, BM_GLARE);
	let fade = fx_row(id, BM_FADE);
	let clip = fx_row(id, BM_CLIP);
	let tilt = fx_row(id, BM_TILT);
	let cap = in.uv.x;
	let outside = in.uv.y;

	let scale = beam_scale(id);
	let to_object = vec3f(in.to_object0.w, in.to_object1.w, in.to_object2.w);
	let object = vec3f(
		dot(in.to_object0.xyz, in.rel),
		dot(in.to_object1.xyz, in.rel),
		dot(in.to_object2.xyz, in.rel),
	) + to_object;
	let skewed = object * scale;
	let local = beam_unskew(id, skewed);
	let camera = beam_unskew(id, to_object * scale);
	let view_dir = normalize(local - camera);
	let depth = dot(in.rel, frame.view_forward.xyz);
	let near = frame.local_lights.w;
	let along = abs(skewed.z) + skewed.x * tilt.x + skewed.y * tilt.y;

	var visible = 1.0;
	if (clip.w != 0.0) {
		let plane = fx_row(id, BM_PLANE);
		let side = saturate((dot(plane.xyz, in.rel + frame.eye.xyz) + plane.w) / tilt.z);
		visible = mix(1.0, side, clip.w);
	}
	if (clip.y > 0.0) {
		let apex_share = saturate(abs(skewed.z) / clip.y);
		let distance = mix(clip.y, clip.y * apex_share, clip.z);
		var blend = 1.0;
		if (distance > 0.0) {
			let scene = fx_scene_depth(vec2i(in.position.xy));
			blend = saturate((max(0.0, scene - near) - max(0.0, depth - near)) / distance);
		}
		visible *= mix(1.0, blend, saturate(apex_share * 100.0));
	}
	visible *= smoothstep(0.0, 1.0, saturate((abs(depth) - near) / max(clip.x, 1e-4)));
	visible *= select(0.0, 1.0, cap - 1e-5 <= dir.w) * (1.0 - outside * cap);

	// the side's normal, flipped on the inside faces, against the view: across the axis when looking across the
	// beam, straight at the camera when looking along it
	let radial = select(vec2f(0.0), normalize(local.xy), dot(local.xy, local.xy) > 0.0);
	let normal = vec3f(radial * cone.z, -cone.w) * (outside * 2.0 - 1.0);
	let to_camera = -view_dir;
	let from_apex = normalize(local + vec3f(0.0, 0.0, glare.z));
	let align = abs(dot(view_dir, dir.xyz));
	let across = to_camera - from_apex * dot(to_camera, from_apex);
	let across_dir = select(vec3f(0.0), normalize(across), dot(across, across) > 0.0);
	let f = smoothstep(0.0, 1.0, mix(dot(normal, across_dir), dot(normal, to_camera), align));
	let power = mix(alpha.w, min(alpha.w, 1.5 * (1.0 - mix(glare.x, glare.y, outside))), align);
	let fresnel = select(0.0, pow(f, power), f > 0.0);
	let surface = mix(mix(fresnel, 1.001, cap), fresnel, outside);

	let origin_distance = abs(in.origin.w);
	let distance_fade = saturate((origin_distance - fade.x) / (fade.y - fade.x)) *
		saturate((origin_distance - fade.z) / (fade.w - fade.z));
	var t = select(0.0, 1.0, along >= falloff.x);
	if (falloff.y != falloff.x) {
		t = saturate((along - falloff.x) / (falloff.y - falloff.x));
	}
	let linear = smoothstep(0.0, 1.0, 1.0 - t);
	let quadratic = 1.0 / (1.0 + 25.0 * t * t) * (1.0 - smoothstep(0.8, 1.0, t));
	let attenuation = mix(linear, quadratic, alpha.z);
	let start_fade = mix(select(1.0, saturate(along / falloff.w), falloff.w > 0.0), 1.0, cap);
	let facing_back = saturate(1.0 - smoothstep(-1.0, 1.0, view_dir.z));
	let facing = mix(facing_back, 1.0 - facing_back, outside);

	let intensity = visible * surface * distance_fade * attenuation * start_fade * facing;
	let opacity = color.a * mix(alpha.x, alpha.y, outside);
	// `_BlendMode` 1 adds the light
	if (glare.w >= 0.5) {
		return fx_additive(color.rgb * opacity * intensity);
	}
	let a = saturate(opacity * intensity);
	return fx_accumulate(color.rgb * a, a, in.rel, in.position.xy, fx_row(id, FX_UNFOGGED).x);
}

// #endregion
