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
	// x = indirect specular factor, y = pre-exposure (scales emission), z = 1 with a reflection cubemap, w = its finest mip count - 1
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
	// camera-relative position → shadow map [0, 1]² × depth, per cascade
	shadow_matrices: array<mat4x4f, 3>,
	// far distance (m) of each cascade, w = 1 when shadows are on
	shadow_splits: vec4f,
	// world-space texel size of each cascade (m), w reserved
	shadow_params: vec4f,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadow_map: texture_depth_2d_array;
@group(0) @binding(2) var shadow_sampler: sampler_comparison;
// the level's sky reflection, prefiltered by roughness over its mips (Unity's convention); a black cube
// until it streams in, flagged by ambient.z
@group(0) @binding(3) var reflection_map: texture_cube<f32>;
@group(0) @binding(4) var reflection_sampler: sampler;

// the sun's visibility at a camera-relative position: 3×3 PCF in the nearest cascade that covers it
fn sun_shadow(rel: vec3f, normal: vec3f) -> f32 {
	if (frame.shadow_splits.w < 0.5) {
		return 1.0;
	}
	let distance = length(rel);
	var cascade = 3u;
	for (var i = 0u; i < 3u; i++) {
		if (distance < frame.shadow_splits[i]) {
			cascade = i;
			break;
		}
	}
	if (cascade > 2u) {
		return 1.0;
	}
	// push the lookup off the surface by about a texel of this cascade
	let texel = frame.shadow_params[cascade];
	let n_dot_l = dot(normal, frame.sun.xyz);
	let offset = normal * texel * 1.5 * (1.0 - max(n_dot_l, 0.0) * 0.5);
	let p = frame.shadow_matrices[cascade] * vec4f(rel + offset, 1.0);
	let uv = p.xy;
	if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || p.z > 1.0) {
		return 1.0;
	}
	let size = vec2f(textureDimensions(shadow_map));
	var sum = 0.0;
	for (var y = -1; y <= 1; y++) {
		for (var x = -1; x <= 1; x++) {
			let st = uv + vec2f(f32(x), f32(y)) / size;
			sum += textureSampleCompareLevel(shadow_map, shadow_sampler, st, i32(cascade), p.z);
		}
	}
	var visibility = sum / 9.0;
	// fade out over the last tenth of the far cascade
	if (cascade == 2u) {
		let fade = clamp((frame.shadow_splits.z - distance) / (frame.shadow_splits.z * 0.1), 0.0, 1.0);
		visibility = mix(1.0, visibility, fade);
	}
	return visibility;
}

// the main pass writes the full radiance and, separately, its ambient part, so ambient occlusion computed
// from the depth buffer afterwards can darken only the light that it occludes
struct Shaded {
	@location(0) radiance: vec4f,
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
fn shade_surface(s: Surface, rel: vec3f) -> Shaded {
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
		var visibility = 0.0;
		if (n_dot_l > 0.0 || s.transmission * back > 0.0) {
			visibility = sun_shadow(rel, n);
		}
		direct *= frame.sun_colour.rgb * visibility * frame.sun.w;
	}

	var ambient = diffuse_colour * ambient_probe(n);
	{
		let r = normalize(mix(reflect(-v, n), n, roughness * roughness));
		// without the cubemap, reflect the ambient probe (the sky's low-frequency radiance)
		var reflected = ambient_probe(r);
		if (frame.ambient.z > 0.5) {
			reflected = textureSampleLevel(reflection_map, reflection_sampler, r, roughness * frame.ambient.w).rgb;
		}
		ambient += reflected * environment_brdf(f0, roughness, n_dot_v) * frame.ambient.x;
	}
	ambient *= s.occlusion;

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
			out.radiance = vec4f(ambient, 1.0);
			out.ambient = vec4f(ambient, 1.0);
			return out;
		}
		default: {}
	}
	out.radiance = vec4f(direct + ambient + s.emission, 1.0);
	out.ambient = vec4f(ambient, 1.0);
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
