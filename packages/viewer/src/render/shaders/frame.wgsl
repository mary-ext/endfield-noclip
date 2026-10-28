// per-pass uniforms shared by every family (group 0). positions are camera-relative Unity coordinates.

struct Frame {
	// camera-relative view-projection: reversed-Z, infinite far plane
	view_proj: mat4x4f,
	// camera world position (f32, for world-space lookups only), w = time (s)
	eye: vec4f,
	// direction towards the sun, w = ambient strength
	sun: vec4f,
	// width, height (px), pixel factor (px per metre at 1 m), minimum projected instance size (px)
	viewport: vec4f,
	// terrain: zero-sample height relative to the eye, metres per height unit, hole bit (u32 bits), 0
	terrain: vec4f,
	// isolate cell grid: world x and z of cell (0, 0), cell size, cells per side
	cells: vec4f,
	// fog colour (linear), w = density per metre
	fog: vec4f,
	// isolate level tag (0 = off), colour mode (0 = tier, 1 = level), isolate cells on, wireframe on
	flags: vec4u,
	// boxes larger than x metres (max half extent) draw as outlines only; y, z, w reserved
	params: vec4f,
}

@group(0) @binding(0) var<uniform> frame: Frame;

fn shade(albedo: vec3f, normal: vec3f, rel: vec3f) -> vec3f {
	let n_dot_l = max(dot(normal, frame.sun.xyz), 0.0);
	let sky = mix(vec3f(0.30, 0.28, 0.26), vec3f(0.55, 0.66, 0.85), normal.y * 0.5 + 0.5);
	let lit = albedo * (vec3f(1.0, 0.94, 0.84) * n_dot_l * 1.8 + sky * frame.sun.w);
	let fog = 1.0 - exp(-length(rel) * frame.fog.w);
	return mix(lit, frame.fog.rgb, fog);
}

// the swapchain is a unorm format, so encode gamma by hand
fn to_display(linear: vec3f) -> vec4f {
	return vec4f(pow(max(linear, vec3f(0.0)), vec3f(1.0 / 2.2)), 1.0);
}

fn hue(h: f32) -> vec3f {
	let k = vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0);
	return clamp(abs(fract(vec3f(h) + k) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
}

// a distinct colour per level tag
fn tag_colour(tag: u32) -> vec3f {
	return mix(vec3f(0.5), hue(f32(tag) * 0.381966), 0.75);
}
