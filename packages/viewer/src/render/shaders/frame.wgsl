// per-pass uniforms and the lighting shared by every family (group 0). positions are camera-relative Unity
// coordinates. light is pre-exposed: the sun's illuminance and the ambient probe are already multiplied by
// the level's exposure, so shaded values land around 0–2 before tonemapping.

struct Frame {
	// camera-relative view-projection: reversed-Z, infinite far plane
	view_proj: mat4x4f,
	// camera world position (f32, for world-space lookups only), w = time (s)
	eye: vec4f,
	// direction towards the sun, w = 1 when the sun casts light
	sun: vec4f,
	// sun illuminance (pre-exposed lux, linear rgb), w = specular intensity
	sun_colour: vec4f,
	// the ambient probe in Unity's shader form: SHAr, SHAg, SHAb, SHBr, SHBg, SHBb, SHC
	sh: array<vec4f, 7>,
	// x = indirect specular factor, y = 1 / post exposure (scales emission that ignores it), z = 1 with a reflection cubemap, w = its finest mip count - 1
	ambient: vec4f,
	// width, height (px), pixel factor (px per metre at 1 m), minimum projected instance size (px)
	viewport: vec4f,
	// terrain: zero-sample height relative to the eye, metres per height unit, hole bit (u32 bits), 0
	terrain: vec4f,
	// x = wireframe, y = debug view (0 lit, 1 albedo, 2 normals, 3 roughness, 4 ambient only; 5, the raw
	// cloud panorama, is lit here and shown by the post chain), z, w reserved
	flags: vec4u,
	// boxes larger than x metres (max half extent) draw as outlines only; y, z, w reserved
	params: vec4f,
	// camera-relative position → shadow map [0, 1]² × depth, per layer: three sharp cascades, then the far layer
	shadow_matrices: array<mat4x4f, 4>,
	// x = the sharp cascades' reach squared (m²), y = 1 / (reach² − fade start²), z reserved, w = 1 when shadows are on
	shadow_fade: vec4f,
	// xyz = each sharp cascade's filter radius (shadow map uv), w reserved
	shadow_penumbra: vec4f,
	// each layer's bounding sphere: camera-relative centre, w = radius squared
	shadow_spheres: array<vec4f, 4>,
	// x = strength, y = how far the shadow is replaced by z (a fixed attenuation), w = 1 with a penumbra ramp
	shadow_look: vec4f,
	// world position of each irradiance clipmap level's centre (0.5 m, 2 m, 8 m probes), w = 1 once filled
	irradiance: array<vec4f, 3>,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadow_map: texture_depth_2d_array;
@group(0) @binding(2) var shadow_sampler: sampler_comparison;
// raw depth reads (gathers) of the shadow map
@group(0) @binding(13) var shadow_gather_sampler: sampler;
// the penumbra tint, sampled at the shadow value (u) with irradiance_clamp; black without one
@group(0) @binding(14) var shadow_ramp: texture_2d<f32>;
// the level's sky reflection, prefiltered by roughness over its mips (Unity's convention); a black cube
// until it streams in, flagged by ambient.z
@group(0) @binding(3) var reflection_map: texture_cube<f32>;
@group(0) @binding(4) var reflection_sampler: sampler;
// the baked irradiance volume's clipmaps (see irradiance-volume.ts): per level, L0 rgb (A), and three slabs
// along y holding the red, green and blue L1 directions · 0.25 + 0.5 with the probe's validity in alpha (B)
@group(0) @binding(5) var irradiance_a0: texture_3d<f32>;
@group(0) @binding(6) var irradiance_b0: texture_3d<f32>;
@group(0) @binding(7) var irradiance_a1: texture_3d<f32>;
@group(0) @binding(8) var irradiance_b1: texture_3d<f32>;
@group(0) @binding(9) var irradiance_a2: texture_3d<f32>;
@group(0) @binding(10) var irradiance_b2: texture_3d<f32>;
@group(0) @binding(11) var irradiance_repeat: sampler;
@group(0) @binding(12) var irradiance_clamp: sampler;

// #region sun shadow

// the classic 16-point Poisson disk
const POISSON = array<vec2f, 16>(
	vec2f(-0.94201624, -0.39906216), vec2f(0.94558609, -0.76890725), vec2f(-0.09418410, -0.92938870),
	vec2f(0.34495938, 0.29387760), vec2f(-0.91588581, 0.45771432), vec2f(-0.81544232, -0.87912464),
	vec2f(-0.38277543, 0.27676845), vec2f(0.97484398, 0.75648379), vec2f(0.44323325, -0.97511554),
	vec2f(0.53742981, -0.47373420), vec2f(-0.26496911, -0.41893023), vec2f(0.79197514, 0.19090188),
	vec2f(-0.24188840, 0.99706507), vec2f(-0.81409955, 0.91437590), vec2f(0.19984126, 0.78641367),
	vec2f(0.14383161, -0.14100790),
);

// interleaved gradient noise (Jimenez) at a pixel
fn gradient_noise(px: vec2f) -> f32 {
	return fract(52.9829189 * fract(dot(px, vec2f(0.06711056, 0.00583715))));
}

// the position pushed off the surface by about a texel of the layer, against acne
fn shadow_receiver(rel: vec3f, normal: vec3f, layer: u32) -> vec3f {
	let texel = 2.0 * sqrt(frame.shadow_spheres[layer].w) / f32(textureDimensions(shadow_map).x);
	let n_dot_l = dot(normal, frame.sun.xyz);
	return rel + normal * texel * 1.5 * (1.0 - max(n_dot_l, 0.0) * 0.5);
}

// a sharp cascade's visibility, or -1 outside it: the game's filter, 64 depths on a Poisson disk rotated per 4×4
// pixel cell, shaped by how far the blockers are. near blockers harden the edge, far ones leave plain PCF
fn cascade_shadow(rel: vec3f, normal: vec3f, cascade: u32, px: vec2f) -> f32 {
	let p = frame.shadow_matrices[cascade] * vec4f(shadow_receiver(rel, normal, cascade), 1.0);
	if (any(p.xyz <= vec3f(0.0)) || any(p.xyz >= vec3f(1.0))) {
		return -1.0;
	}
	let cell = vec2u(px) % 4u;
	let angle = f32(cell.x * 4u + cell.y) * (2.0 * PI / 16.0);
	let rotation = mat2x2f(cos(angle), sin(angle), -sin(angle), cos(angle));
	let radius = frame.shadow_penumbra[cascade];
	var gap = 0.0;
	var blockers = 0.0;
	for (var k = 0; k < 16; k++) {
		let depths = textureGather(shadow_map, shadow_gather_sampler, p.xy + rotation * POISSON[k] * radius, cascade);
		let blocked = step(depths, vec4f(p.z));
		gap += dot(vec4f(p.z) - depths, blocked);
		blockers += dot(blocked, vec4f(1.0));
	}
	if (blockers == 0.0) {
		return 1.0;
	}
	let t = 2.0 * clamp(blockers / 64.0, 0.0, 1.0) - 1.0;
	let s = sign(t);
	let u = 1.0 - s * t;
	let k = clamp((gap / blockers) / max(1.0 - p.z, 1e-5), 0.0, 1.0);
	return 0.5 - 0.5 * s * (1.0 - mix(u * u * u, u, k));
}

// the far layer's visibility (1 outside it): a 3×3 grid of bilinear comparisons
fn far_shadow(rel: vec3f, normal: vec3f) -> f32 {
	let p = frame.shadow_matrices[3] * vec4f(shadow_receiver(rel, normal, 3u), 1.0);
	if (any(p.xyz <= vec3f(0.0)) || any(p.xyz >= vec3f(1.0))) {
		return 1.0;
	}
	let size = vec2f(textureDimensions(shadow_map));
	var sum = 0.0;
	for (var y = -1; y <= 1; y++) {
		for (var x = -1; x <= 1; x++) {
			sum += textureSampleCompareLevel(shadow_map, shadow_sampler, p.xy + vec2f(f32(x), f32(y)) / size, 3, p.z);
		}
	}
	// fade out towards the layer's edge
	let d = rel - frame.shadow_spheres[3].xyz;
	let edge = clamp((1.0 - dot(d, d) / frame.shadow_spheres[3].w) * 5.0, 0.0, 1.0);
	return mix(1.0, sum / 9.0, edge);
}

// the sun's visibility at a camera-relative position. as in the game: sharp cascades out to a reach, dithered
// between neighbours over the outer tenth of each one's sphere, fading into the coarse far layer before the reach
fn sun_shadow(rel: vec3f, normal: vec3f, px: vec2f) -> f32 {
	if (frame.shadow_fade.w < 0.5) {
		return 1.0;
	}
	let near = clamp((frame.shadow_fade.x - dot(rel, rel)) * frame.shadow_fade.y, 0.0, 1.0);
	var sharp = -1.0;
	if (near > 0.0) {
		var cascade = 3u;
		for (var i = 0u; i < 3u; i++) {
			let d = rel - frame.shadow_spheres[i].xyz;
			if (dot(d, d) < frame.shadow_spheres[i].w) {
				cascade = i;
				break;
			}
		}
		if (cascade < 2u) {
			let d = rel - frame.shadow_spheres[cascade].xyz;
			let next = rel - frame.shadow_spheres[cascade + 1u].xyz;
			if (dot(next, next) < frame.shadow_spheres[cascade + 1u].w) {
				let outer = (sqrt(dot(d, d) / frame.shadow_spheres[cascade].w) - 0.9) * 12.0;
				cascade += u32(step(gradient_noise(px), outer));
			}
		}
		if (cascade < 3u) {
			sharp = cascade_shadow(rel, normal, cascade, px);
		}
	}
	if (near >= 1.0 && sharp >= 0.0) {
		return sharp;
	}
	let far = far_shadow(rel, normal);
	if (sharp < 0.0) {
		return far;
	}
	return mix(far, sharp, near);
}

// what reaches a surface of the sun's light, per channel: the shadow, replaced by the environment's fixed
// attenuation where it keeps the sun out (caves), weakened by its strength and tinted through its penumbra ramp
fn sun_visibility(rel: vec3f, normal: vec3f, px: vec2f) -> vec3f {
	if (frame.shadow_fade.w < 0.5) {
		return vec3f(1.0);
	}
	var shadow = frame.shadow_look.z;
	if (frame.shadow_look.y < 0.99) {
		shadow = mix(sun_shadow(rel, normal, px), frame.shadow_look.z, frame.shadow_look.y);
	}
	let sh = mix(1.0, min(1.0, shadow), frame.shadow_look.x);
	if (frame.shadow_look.w < 0.5) {
		return vec3f(sh);
	}
	let ramp = textureSampleLevel(shadow_ramp, irradiance_clamp, vec2f(sh, 0.5), 0.0).rgb;
	return vec3f(1.0) - (vec3f(1.0) - ramp) * (1.0 - sh);
}

// #endregion

// the main pass writes the full radiance and, separately, its diffuse ambient part, so ambient occlusion
// computed from the depth buffer afterwards can darken only the light that it occludes. the radiance carries
// the diffuse ambient times the material occlusion; the composite swaps that for the multi-bounce of the
// lower of both occlusions, as the game does
struct Shaded {
	// rgb: radiance, a: albedo luminance (for the multi-bounce)
	@location(0) radiance: vec4f,
	// rgb: diffuse ambient before any occlusion, a: material occlusion
	@location(1) ambient: vec4f,
}

// what a material family hands to the lighting
struct Surface {
	albedo: vec3f,
	// world-space unit normal facing the viewer's side
	normal: vec3f,
	// perceptual roughness
	roughness: f32,
	metallic: f32,
	// the dielectric reflectance at normal incidence (0.04 for most materials)
	f0: f32,
	// baked material occlusion
	occlusion: f32,
	emission: vec3f,
	// light passing through thin foliage, 0 for opaque surfaces
	transmission: f32,
}

fn default_surface(albedo: vec3f, normal: vec3f) -> Surface {
	var s: Surface;
	s.albedo = albedo;
	s.normal = normal;
	s.roughness = 0.85;
	s.metallic = 0.0;
	s.f0 = 0.04;
	s.occlusion = 1.0;
	s.emission = vec3f(0.0);
	s.transmission = 0.0;
	return s;
}

// Unity's ShadeSH9: the probe's irradiance over π, ready to multiply by albedo
fn ambient_probe(n: vec3f) -> vec3f {
	let n4 = vec4f(n, 1.0);
	var c = vec3f(dot(frame.sh[0], n4), dot(frame.sh[1], n4), dot(frame.sh[2], n4));
	let b = n.xyzz * n.yzzx;
	c += vec3f(dot(frame.sh[3], b), dot(frame.sh[4], b), dot(frame.sh[5], b));
	c += frame.sh[6].xyz * (n.x * n.x - n.y * n.y);
	return max(c, vec3f(0.0));
}

// the L1 probe of one clipmap level at a world position, per channel as (L1 · L0, L0), times `weight`; w of
// the result's fourth vector is the probe's validity times `weight`
struct IrradianceSample {
	r: vec4f,
	g: vec4f,
	b: vec4f,
	validity: f32,
}

const IRRADIANCE_TEXELS = vec3f(128.0, 64.0, 128.0);

fn irradiance_level(a: texture_3d<f32>, b: texture_3d<f32>, uvw_in: vec3f, clamp_all: bool, weight: f32) -> IrradianceSample {
	var uvw = uvw_in - floor(uvw_in);
	let half = 0.5 / IRRADIANCE_TEXELS;
	if (clamp_all) {
		uvw = clamp(uvw, half, vec3f(1.0) - half);
	}
	let l0 = textureSampleLevel(a, irradiance_repeat, uvw, 0.0).xyz;
	let v = clamp(uvw.y, half.y, 1.0 - half.y) / 3.0;
	let br = textureSampleLevel(b, irradiance_clamp, vec3f(uvw.x, v, uvw.z), 0.0);
	let bg = textureSampleLevel(b, irradiance_clamp, vec3f(uvw.x, v + 1.0 / 3.0, uvw.z), 0.0);
	let bb = textureSampleLevel(b, irradiance_clamp, vec3f(uvw.x, v + 2.0 / 3.0, uvw.z), 0.0);
	var s: IrradianceSample;
	s.r = vec4f((br.xyz * 4.0 - 2.0) * l0.x, l0.x) * weight;
	s.g = vec4f((bg.xyz * 4.0 - 2.0) * l0.y, l0.y) * weight;
	s.b = vec4f((bb.xyz * 4.0 - 2.0) * l0.z, l0.z) * weight;
	s.validity = br.w * weight;
	return s;
}

// how far a position is outside a clipmap level's box (half extents h metres, fading over 1/fade metres)
fn irradiance_outside(d: vec3f, h: vec2f, fade: f32) -> f32 {
	return max(clamp((max(abs(d.x), abs(d.z)) - h.x) * fade, 0.0, 1.0), clamp((abs(d.y) - h.y) * fade, 0.0, 1.0));
}

// diffuse ambient: the irradiance volume's L1 probes blended over the clipmap levels, with the ambient probe
// where they don't reach or are invalid (HGRP DeferredLighting's indirect pass, without its jitter)
fn ambient_irradiance(world: vec3f, n: vec3f) -> vec3f {
	let base = ambient_probe(n);
	if (frame.irradiance[2].w < 0.5) {
		return base;
	}
	let p = world + n * 0.25;
	let outside = irradiance_outside(p - frame.irradiance[2].xyz, vec2f(464.0, 208.0), 0.03125);
	if (outside >= 1.0) {
		return base;
	}
	var r = vec4f(0.0);
	var g = vec4f(0.0);
	var b = vec4f(0.0);
	var validity = outside;
	// a level not filled yet counts as out of reach
	let f0 = select(1.0, irradiance_outside(p - frame.irradiance[0].xyz, vec2f(29.0, 13.0), 0.5), frame.irradiance[0].w > 0.5);
	if (f0 < 1.0) {
		let s = irradiance_level(irradiance_a0, irradiance_b0, (p * 2.0 + 0.5) / IRRADIANCE_TEXELS, false, 1.0 - f0);
		r += s.r;
		g += s.g;
		b += s.b;
		validity += s.validity;
	}
	let f1 = select(1.0, irradiance_outside(p - frame.irradiance[1].xyz, vec2f(116.0, 52.0), 0.125), frame.irradiance[1].w > 0.5);
	if (f1 < 1.0) {
		let s = irradiance_level(irradiance_a1, irradiance_b1, (p * 0.5 + 0.5) / IRRADIANCE_TEXELS, false, f0 * (1.0 - f1));
		r += s.r;
		g += s.g;
		b += s.b;
		validity += s.validity;
	}
	if (f1 > 0.0) {
		let s = irradiance_level(irradiance_a2, irradiance_b2, (p * 0.125 + 0.5) / IRRADIANCE_TEXELS, true, f1 * (1.0 - outside));
		r += s.r;
		g += s.g;
		b += s.b;
		validity += s.validity;
	}
	// the ambient probe fills in for missing validity; `band` is the game's vertical correction term
	let valid = clamp(validity * 2.0 - 1.0, 0.0, 1.0);
	let band = valid - outside;
	let fallback = (valid + outside) * 0.5;
	let sh = array<vec4f, 3>(r, g, b);
	var c = vec3f(0.0);
	for (var i = 0; i < 3; i++) {
		let d = frame.sh[i];
		let corrected = sh[i] + vec4f(0.0, d.w * band * 0.5, 0.0, d.y * band * 0.375);
		c[i] = dot(corrected.xyz, n) + corrected.w;
	}
	return max(c + base * fallback, vec3f(0.0));
}

const LUMINANCE = vec3f(0.2126729, 0.7151522, 0.0721750);

// the game's scale on a sky reflection, from the surface's diffuse irradiance against the sky probe's L1 along the
// normal (docs/game-data/lighting.md, "ambient")
fn reflection_normalisation(irradiance: vec3f, n: vec3f) -> f32 {
	let d = dot(irradiance, LUMINANCE);
	let sky = LUMINANCE.x * frame.sh[0] + LUMINANCE.y * frame.sh[1] + LUMINANCE.z * frame.sh[2];
	let p = max(1e-4, dot(sky, vec4f(n, 1.0)));
	return (2.0 * clamp(d / p, 0.0, 1.0) + d) / (2.0 + p);
}

// height-correlated Smith visibility (Heitz), V = G / (4 n·l n·v)
fn smith_visibility(n_dot_v: f32, n_dot_l: f32, a2: f32) -> f32 {
	let v = n_dot_l * sqrt(n_dot_v * n_dot_v * (1.0 - a2) + a2);
	let l = n_dot_v * sqrt(n_dot_l * n_dot_l * (1.0 - a2) + a2);
	return 0.5 / max(v + l, 1e-5);
}

// Karis' analytic fit of the split-sum environment BRDF
fn environment_brdf(f0: vec3f, roughness: f32, n_dot_v: f32) -> vec3f {
	let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
	let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
	let r = roughness * c0 + c1;
	let a004 = min(r.x * r.x, exp2(-9.28 * n_dot_v)) * r.x + r.y;
	let ab = vec2f(-1.04, 1.04) * a004 + r.zw;
	return f0 * ab.x + ab.y;
}

// sun (shadowed) plus ambient probe; `rel` is the camera-relative position
fn shade_surface(s: Surface, rel: vec3f, px: vec2f) -> Shaded {
	let n = s.normal;
	let v = -normalize(rel);
	let l = frame.sun.xyz;
	let n_dot_v = clamp(abs(dot(n, v)), 1e-4, 1.0);
	let n_dot_l = clamp(dot(n, l), 0.0, 1.0);
	let roughness = clamp(s.roughness, 0.045, 1.0);
	let a = roughness * roughness;
	let a2 = a * a;
	let diffuse_colour = s.albedo * (1.0 - s.metallic);
	let f0 = mix(vec3f(s.f0), s.albedo, s.metallic);

	var direct = vec3f(0.0);
	{
		let h = normalize(l + v);
		let n_dot_h = clamp(dot(n, h), 0.0, 1.0);
		let v_dot_h = clamp(dot(v, h), 0.0, 1.0);
		let f = fresnel_schlick(f0, v_dot_h);
		let specular = f * (ggx_distribution(n_dot_h, a2) * smith_visibility(n_dot_v, n_dot_l, a2)) * frame.sun_colour.w;
		let diffuse = diffuse_colour / PI * (vec3f(1.0) - f);
		direct = (diffuse + specular) * n_dot_l;
		// thin translucency: light from behind, wrapped around the leaf
		let back = clamp(dot(-n, l), 0.0, 1.0);
		direct += diffuse_colour / PI * s.transmission * back;
		// the shadow lookup only where the sun can reach
		var visibility = vec3f(0.0);
		if (n_dot_l > 0.0 || s.transmission * back > 0.0) {
			visibility = sun_visibility(rel, n, px);
		}
		direct *= frame.sun_colour.rgb * visibility * frame.sun.w;
	}

	let irradiance = ambient_irradiance(frame.eye.xyz + rel, n);
	let diffuse_ambient = diffuse_colour * irradiance;
	var specular_ambient: vec3f;
	{
		let r = normalize(mix(reflect(-v, n), n, roughness * roughness));
		// without the cubemap, reflect the ambient probe (the sky's low-frequency radiance)
		var reflected = ambient_probe(r);
		if (frame.ambient.z > 0.5) {
			reflected = textureSampleLevel(reflection_map, reflection_sampler, r, roughness * frame.ambient.w).rgb;
		}
		specular_ambient = reflected * reflection_normalisation(irradiance, n) * environment_brdf(f0, roughness, n_dot_v) * frame.ambient.x;
	}
	// specular sees only the material occlusion, through Lagarde's specular occlusion
	let specular_occlusion = clamp(pow(n_dot_v + s.occlusion, exp2(-16.0 * roughness - 1.0)) - 1.0 + s.occlusion, 0.0, 1.0);
	let ambient = diffuse_ambient * s.occlusion + specular_ambient * specular_occlusion;
	let albedo_luminance = dot(diffuse_colour, vec3f(0.2126, 0.7152, 0.0722));

	var out: Shaded;
	switch frame.flags.y {
		case 1u: {
			out.radiance = vec4f(s.albedo, 1.0);
			out.ambient = vec4f(0.0);
			return out;
		}
		case 2u: {
			out.radiance = vec4f(n * 0.5 + 0.5, 1.0);
			out.ambient = vec4f(0.0);
			return out;
		}
		case 3u: {
			out.radiance = vec4f(vec3f(roughness), 1.0);
			out.ambient = vec4f(0.0);
			return out;
		}
		case 4u: {
			out.radiance = vec4f(ambient, albedo_luminance);
			out.ambient = vec4f(diffuse_ambient, s.occlusion);
			return out;
		}
		default: {}
	}
	out.radiance = vec4f(direct + ambient + s.emission, albedo_luminance);
	out.ambient = vec4f(diffuse_ambient, s.occlusion);
	return out;
}

// a flat colour that occlusion leaves alone (debug overlays)
fn unlit(colour: vec3f) -> Shaded {
	var out: Shaded;
	out.radiance = vec4f(colour, 1.0);
	out.ambient = vec4f(0.0);
	return out;
}

fn hue(h: f32) -> vec3f {
	let k = vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0);
	return clamp(abs(fract(vec3f(h) + k) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
}

fn oct_decode(e: vec2f) -> vec3f {
	var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
	if (n.z < 0.0) {
		let s = select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
		n = vec3f((1.0 - abs(n.yx)) * s, n.z);
	}
	return normalize(n);
}
