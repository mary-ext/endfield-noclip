// uniforms and helpers shared by the post passes (group 0, binding 0). world positions are Unity metres; the
// atmosphere works in kilometres with the planet's surface at world y = 0. needs brdf.wgsl.

struct Post {
	// view rays: rel = (forward + ndc.x · right + ndc.y · up) · near / depth
	// forward (unit), w = near plane (m)
	forward: vec4f,
	// right · aspect · tan(fovY / 2), w = pixels per metre at 1 m
	right: vec4f,
	// up · tan(fovY / 2), w = time (s)
	up: vec4f,
	// camera world position (m), w = frame index
	eye: vec4f,
	// width, height, 1 / width, 1 / height (px)
	viewport: vec4f,
	// towards the sun that lights the scene; w = 1 when it shines
	sun: vec4f,
	// the scene sun's pre-exposed illuminance, linear rgb
	sun_illuminance: vec4f,
	// towards the sun the sky is lit by
	sky_sun: vec4f,
	// the sky sun's pre-exposed illuminance, w unused
	sky_illuminance: vec4f,
	// atmosphere (km): bottom radius, top radius, Mie anisotropy, multiple-scattering factor
	planet: vec4f,
	// Rayleigh scattering (per km), w = exponential distribution (km)
	rayleigh: vec4f,
	// Mie scattering (per km), w = exponential distribution (km)
	mie_scattering: vec4f,
	// Mie extinction (per km)
	mie_extinction: vec4f,
	// ozone absorption (per km), w = tent tip altitude (km)
	ozone: vec4f,
	// x = tent tip value, y = tent width (km)
	ozone_tent: vec4f,
	ground_albedo: vec4f,
	// height fog layers in the game's base-2 units: density, falloff, height (m), unused
	fog_layer0: vec4f,
	fog_layer1: vec4f,
	// fog inscattered radiance (pre-exposed), w = least transmittance (1 − max opacity)
	fog_colour: vec4f,
	// start distance, start transition, cutoff distance, cutoff transition (m, per m)
	fog_range: vec4f,
	// directional inscattered radiance (pre-exposed), w = exponent
	fog_directional: vec4f,
	// the ambient probe looking up and looking at the horizon, pre-exposed
	sky_up: vec4f,
	sky_horizon: vec4f,
	// ambient occlusion: radius (m), intensity, power, enabled
	ao: vec4f,
	// bloom: threshold, knee, intensity, scatter
	bloom: vec4f,
	bloom_tint: vec4f,
	// exposure multiplier, vignette intensity, vignette smoothness, tonemapper (0 game, 1 neutral, 2 none)
	grade: vec4f,
	// x = sky, y = height fog, z = aerial perspective, w = bloom
	flags: vec4u,
	// ambient occlusion falloff (fraction of the radius), sample distribution power
	ao_shape: vec4f,
	// vignette colour (linear), w = roundness
	vignette_colour: vec4f,
	// vignette centre (uv), z = 1 when rounded
	vignette_centre: vec4f,
	// cloud layer: rotation (rad), contrast, 1 = colour from max(R, G) (texture mode 0), w = 1 with a cloud layer
	cloud: vec4f,
	// multiplies the cloud texel (the game's _CloudTint)
	cloud_tint: vec4f,
	// opacity of the R and G layers, unused, w = 1 to show the raw texture
	cloud_shape: vec4f,
	// towards the light the fog's directional inscattering comes from, w = its start distance (m)
	fog_directional_direction: vec4f,
	// atmosphere fog: towards its sun, w = Mie anisotropy
	atmo_sun: vec4f,
	// extinction (per km), w = fog-free distance (km)
	atmo_extinction: vec4f,
	// Rayleigh-scattered sun over extinction (pre-exposed), w = km of fog per metre of distance
	atmo_rayleigh: vec4f,
	// Mie-scattered sun over extinction, w = 1 / falloff height (per m)
	atmo_mie: vec4f,
	// scattered ambient over extinction, w = start height / falloff height
	atmo_ambient: vec4f,
	// sky dome distance (m), atmosphere fog on, unused, unused
	sky_fog: vec4f,
	// colour grading (the game's _ColorGradingCB): white balance (LMS), w = post exposure multiplier
	colour_balance: vec4f,
	// linear colour filter
	colour_filter: vec4f,
	// hue shift (turns), saturation, contrast
	hue_sat_con: vec4f,
	// rows of the channel mixer
	mixer_red: vec4f,
	mixer_green: vec4f,
	mixer_blue: vec4f,
	shadows: vec4f,
	midtones: vec4f,
	highlights: vec4f,
	// shadows start and end, highlights start and end
	sha_hi_limits: vec4f,
	lift: vec4f,
	gamma: vec4f,
	gain: vec4f,
	// split toning tints; w = balance
	split_shadows: vec4f,
	split_highlights: vec4f,
}

@group(0) @binding(0) var<uniform> post: Post;

struct FullscreenOut {
	@builtin(position) position: vec4f,
	// 0 at the top-left corner
	@location(0) uv: vec2f,
}

// one triangle covering the target
@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> FullscreenOut {
	let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
	var out: FullscreenOut;
	out.position = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
	out.uv = vec2f(p.x, 1.0 - p.y);
	return out;
}

// the camera-relative direction through a target position, scaled so its forward component is 1
fn view_ray(uv: vec2f) -> vec3f {
	let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
	return post.forward.xyz + ndc.x * post.right.xyz + ndc.y * post.up.xyz;
}

// reversed-Z, infinite far plane: depth = near / view distance
fn view_depth(depth: f32) -> f32 {
	return post.forward.w / max(depth, 1e-9);
}

fn luminance(c: vec3f) -> f32 {
	return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

// Jimenez' interleaved gradient noise
fn ign(p: vec2f) -> f32 {
	return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}
