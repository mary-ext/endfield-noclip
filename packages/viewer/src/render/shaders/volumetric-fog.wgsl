// the game's volumetric fog: a grid over the view, its slices spaced logarithmically in view depth out to the
// fog's distance. each thread walks one column front to back, lighting every froxel (the height fog's medium
// scattering the sun, shadowed, the ambient probe and the local lights, plus its own emission) and storing the light
// scattered towards the camera so far (rgb) and the transmittance (a). needs frame.wgsl.

struct VolumetricFog {
	// view rays through the grid: rel = (forward + ndc.x · right + ndc.y · up) · view depth
	forward: vec4f,
	right: vec4f,
	up: vec4f,
	// camera world position (m), w = frame index
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
}

@group(1) @binding(0) var<uniform> fog: VolumetricFog;
@group(1) @binding(1) var froxels: texture_storage_3d<rgba16float, write>;

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
// game takes one filtered lookup per froxel, then the environment's override and strength
fn froxel_sun(rel: vec3f) -> f32 {
	if (frame.shadow_fade.w < 0.5) {
		return 1.0;
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
	shadow = mix(shadow, frame.shadow_look.z, frame.shadow_look.y);
	return mix(1.0, min(1.0, shadow), frame.shadow_look.x);
}

@compute @workgroup_size(8, 8, 1)
fn cs_froxels(@builtin(global_invocation_id) id: vec3u) {
	let size = textureDimensions(froxels);
	if (any(id.xy >= size.xy)) {
		return;
	}
	let uv = (vec2f(id.xy) + 0.5) / vec2f(size.xy);
	let ray = fog.forward.xyz + (uv.x * 2.0 - 1.0) * fog.right.xyz + (1.0 - uv.y * 2.0) * fog.up.xyz;
	let direction = normalize(ray);
	// the column's render pixel, for the local lights' screen tiles
	let pixel = uv * frame.render_size.xy;
	let g = fog.range.z;
	let phase = henyey_greenstein(g, dot(direction, fog.sun_direction.xyz));
	// the ambient probe's linear part towards the viewer, softened by the anisotropy
	let d4 = vec4f(direction * g, 1.0);
	let sky = max(vec3f(dot(frame.sh[0], d4), dot(frame.sh[1], d4), dot(frame.sh[2], d4)), vec3f(0.0)) *
		fog.emissive.w / PI;
	// each froxel is lit at a point that moves through it from frame to frame, for the temporal antialiasing
	// to average
	let jitter = fract(gradient_noise(vec2f(id.xy)) + fog.eye.w * 0.618034);

	var scattered = vec3f(0.0);
	var transmittance = 1.0;
	var previous = fog.range.x;
	var travelled = 0.0;
	let count = u32(fog.slices.w);
	for (var s = 0u; s < count; s++) {
		let rel = ray * slice_depth(f32(s) + jitter);
		let sigma = max(0.5 * fog_density(fog.eye.y + rel.y) * fog.albedo.w, 0.0);
		let scattering = fog.albedo.rgb * sigma;
		let scattering_luminance = dot(scattering, vec3f(0.2126, 0.7152, 0.0722));
		let extinction = max(sigma - scattering_luminance, 0.0) + scattering_luminance;
		let light = fog.sun.rgb * (froxel_sun(rel) * phase) + sky + local_fog_lighting(rel, pixel, direction, g);
		let source = light * scattering + fog.emissive.rgb;

		// front to back between successive froxel centres, measured along the ray, fading in from the first
		// slice
		let depth = slice_depth(f32(s) + 0.5);
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
