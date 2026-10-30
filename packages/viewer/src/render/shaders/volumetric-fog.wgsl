// the game's volumetric fog: a grid over the view, its slices spaced logarithmically in view depth out to the
// fog's distance. each thread walks one column front to back, lighting every froxel (the height fog's medium
// scattering the sun, shadowed, the ambient probe and the local lights, plus its own emission), blending that with
// the froxel's reprojected history, and storing the light scattered towards the camera so far (rgb) and the
// transmittance (a). needs frame.wgsl.

struct VolumetricFog {
	// view rays through the grid: rel = (forward + ndc.x · right + ndc.y · up) · view depth
	forward: vec4f,
	right: vec4f,
	up: vec4f,
	// camera world position (m), w unused
	eye: vec4f,
	// slice of view depth z: s = log2(z · x + y) · z_scale; x, y, z_scale (slices per doubling), slice count
	slices: vec4f,
	// view depth of the first slice's near edge (m), 1 / near fade-in distance, Henyey-Greenstein g, unused
	range: vec4f,
	// scattering albedo, w = extinction scale
	albedo: vec4f,
	// emitted radiance per metre (pre-exposed), w = ambient intensity
	emissive: vec4f,
	// towards the sun, w unused
	sun_direction: vec4f,
	// scattered sun radiance (pre-exposed), w unused
	sun: vec4f,
	// the height fog's two layers in the game's base-2 units: density, falloff, height (m), unused
	layer0: vec4f,
	layer1: vec4f,
	// where in its cell each froxel is lit this frame: across and down in [-0.5, 0.5), depth in [0, 1); w unused
	jitter: vec4f,
	// the last frame's view, to reproject into: rel' = rel + eye_offset, view depth z' = dot(rel', forward),
	// NDC = (dot(rel', right), dot(rel', up)) / z'. forward.w is the history's weight, 0 without one
	previous_forward: vec4f,
	previous_right: vec4f,
	previous_up: vec4f,
	// this eye minus the last frame's (m), w unused
	eye_offset: vec4f,
}

@group(1) @binding(0) var<uniform> fog: VolumetricFog;
@group(1) @binding(1) var froxels: texture_storage_3d<rgba16float, write>;
// each froxel's lit medium, scattered radiance per metre (rgb) and extinction (a): this frame's and the last's
@group(1) @binding(2) var history_out: texture_storage_3d<rgba16float, write>;
@group(1) @binding(3) var history_in: texture_3d<f32>;
@group(1) @binding(4) var history_sampler: sampler;

// view depth of a (fractional) slice coordinate
fn slice_depth(s: f32) -> f32 {
	return (exp2(s / fog.slices.z) - fog.slices.y) / fog.slices.x;
}

// the height fog's density at a height, as its analytic form integrates it
fn fog_density(y: f32) -> f32 {
	var density = fog.layer0.x * exp2(-max(-127.0, fog.layer0.y * (y - fog.layer0.z)));
	if (fog.layer1.x > 0.0) {
		density += fog.layer1.x * exp2(-max(-127.0, fog.layer1.y * (y - fog.layer1.z)));
	}
	return density;
}

fn henyey_greenstein(g: f32, mu: f32) -> f32 {
	let x = 1.0 + g * g - 2.0 * g * mu;
	return (1.0 - g * g) / max(4.0 * PI * x * sqrt(x), 0.001);
}

// the sun's visibility at a camera-relative position: one comparison in the sharpest layer holding it, as the
// game takes one filtered lookup per froxel, times the cloud shadow, then the environment's override and strength
fn froxel_sun(rel: vec3f) -> f32 {
	if (frame.shadow_fade.w < 0.5) {
		return cloud_shadow(rel);
	}
	var shadow = 1.0;
	for (var i = 0u; i < 4u; i++) {
		let d = rel - frame.shadow_spheres[i].xyz;
		if (dot(d, d) >= frame.shadow_spheres[i].w) {
			continue;
		}
		let p = frame.shadow_matrices[i] * vec4f(rel, 1.0);
		if (all(p.xyz > vec3f(0.0)) && all(p.xyz < vec3f(1.0))) {
			shadow = textureSampleCompareLevel(shadow_map, shadow_sampler, p.xy, i, p.z);
			break;
		}
	}
	shadow = mix(shadow * cloud_shadow(rel), frame.shadow_look.z, frame.shadow_look.y);
	return mix(1.0, min(1.0, shadow), frame.shadow_look.x);
}

struct History {
	medium: vec4f,
	// 0 where the last frame's grid didn't cover the point
	weight: f32,
}

// the last frame's lit medium at a camera-relative position
fn froxel_history(rel: vec3f) -> History {
	let weight = fog.previous_forward.w;
	if (weight <= 0.0) {
		return History(vec4f(0.0), 0.0);
	}
	let p = rel + fog.eye_offset.xyz;
	let z = dot(p, fog.previous_forward.xyz);
	let w = log2(max(z * fog.slices.x + fog.slices.y, 1e-6)) * fog.slices.z / fog.slices.w;
	let ndc = vec2f(dot(p, fog.previous_right.xyz), dot(p, fog.previous_up.xyz)) / max(z, 1e-4);
	let uvw = vec3f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, w);
	if (z <= 0.0 || any(uvw < vec3f(0.0)) || any(uvw > vec3f(1.0))) {
		return History(vec4f(0.0), 0.0);
	}
	return History(textureSampleLevel(history_in, history_sampler, uvw, 0.0), weight);
}

@compute @workgroup_size(8, 8, 1)
fn cs_froxels(@builtin(global_invocation_id) id: vec3u) {
	let size = textureDimensions(froxels);
	if (any(id.xy >= size.xy)) {
		return;
	}
	let uv = (vec2f(id.xy) + 0.5) / vec2f(size.xy);
	let ray = fog.forward.xyz + (uv.x * 2.0 - 1.0) * fog.right.xyz + (1.0 - uv.y * 2.0) * fog.up.xyz;
	// each froxel is lit at a point that moves through its cell from frame to frame, and the history averages
	// them, so a shadow edge crossing a cell shades it in proportion instead of all or nothing
	let lit_uv = (vec2f(id.xy) + 0.5 + fog.jitter.xy) / vec2f(size.xy);
	let lit_ray = fog.forward.xyz + (lit_uv.x * 2.0 - 1.0) * fog.right.xyz + (1.0 - lit_uv.y * 2.0) * fog.up.xyz;
	let direction = normalize(lit_ray);
	// the column's render pixel, for the local lights' screen tiles
	let pixel = lit_uv * frame.render_size.xy;
	let g = fog.range.z;
	let phase = henyey_greenstein(g, dot(direction, fog.sun_direction.xyz));
	// the ambient probe's linear part towards the viewer, softened by the anisotropy
	let d4 = vec4f(direction * g, 1.0);
	let sky = max(vec3f(dot(frame.sh[0], d4), dot(frame.sh[1], d4), dot(frame.sh[2], d4)), vec3f(0.0)) *
		fog.emissive.w / PI;

	var scattered = vec3f(0.0);
	var transmittance = 1.0;
	var previous = fog.range.x;
	var travelled = 0.0;
	let count = u32(fog.slices.w);
	for (var s = 0u; s < count; s++) {
		var source: vec3f;
		var extinction: f32;
		let depth = slice_depth(f32(s) + 0.5);
		{
			let rel = lit_ray * slice_depth(f32(s) + fog.jitter.z);
			let sigma = max(0.5 * fog_density(fog.eye.y + rel.y) * fog.albedo.w, 0.0);
			let scattering = fog.albedo.rgb * sigma;
			let scattering_luminance = dot(scattering, vec3f(0.2126, 0.7152, 0.0722));
			let light = fog.sun.rgb * (froxel_sun(rel) * phase) + sky + local_fog_lighting(rel, pixel, direction, g);
			source = light * scattering + fog.emissive.rgb;
			extinction = max(sigma - scattering_luminance, 0.0) + scattering_luminance;
			// the froxel's centre, reprojected into the last frame's grid
			let history = froxel_history(ray * depth);
			let medium = mix(vec4f(source, extinction), history.medium, history.weight);
			textureStore(history_out, vec3u(id.xy, s), medium);
			source = medium.rgb;
			extinction = medium.a;
		}

		// front to back between successive froxel centres, measured along the ray, fading in from the first
		// slice
		let span = (depth - previous) * length(ray);
		previous = depth;
		travelled += span;
		let fade = clamp(travelled * fog.range.y, 0.0, 1.0);
		let step_transmittance = exp(-extinction * span);
		scattered += fade * (source - source * step_transmittance) / max(extinction, 1e-5) * transmittance;
		transmittance *= mix(1.0, step_transmittance, fade);
		textureStore(froxels, vec3u(id.xy, s), vec4f(scattered, transmittance));
	}
}
