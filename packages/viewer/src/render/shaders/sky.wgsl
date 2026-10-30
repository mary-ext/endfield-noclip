// the sky, aerial perspective and height fog as the composite and water passes apply them. needs
// post-common.wgsl and atmosphere.wgsl.

// the fog as HGRP's deferred lighting and sky apply it: the atmosphere fog, then the two-layer height fog, in
// the game's own units, with the froxel fog (volumetric-fog.wgsl) in front when it's on. the froxels then
// cover the ray out to the fog's distance in view depth, and the height fog only what lies beyond.

// the froxel fog integrated up to each slice: scattered light (rgb) and transmittance (a)
@group(1) @binding(5) var froxel_texture: texture_3d<f32>;

// one height-fog layer's density along a ray from `base_y`, per metre of ray: Unreal's base-2 form of the
// line integral, with its series near zero
fn fog_layer_density(layer: vec4f, base_y: f32, delta_y: f32) -> f32 {
	let x = max(-127.0, layer.y * delta_y);
	var integral = 0.693147182 - 0.240226507 * x;
	if (abs(x) > 5.96e-8) {
		integral = (1.0 - exp2(-x)) / x;
	}
	return layer.x * exp2(-max(-127.0, layer.y * (base_y - layer.z))) * integral;
}

struct Fog {
	// what the colour behind is multiplied by
	transmittance: vec3f,
	// what's added in front
	inscatter: vec3f,
}

// the froxel fog in front of a point
struct Froxels {
	// scattered light (rgb) and transmittance (a)
	light: vec4f,
	// view depth (m) the froxels cover, which the height fog leaves out
	covered: f32,
}

// for rays the froxel grid doesn't hold (reflections): the height fog all the way
const NO_FROXELS = Froxels(vec4f(0.0, 0.0, 0.0, 1.0), 0.0);

// the froxel fog in front of something `depth` metres of view depth away, at `uv` on screen
fn froxels_at(uv: vec2f, depth: f32) -> Froxels {
	if (post.froxel_slices.w <= 0.0) {
		return NO_FROXELS;
	}
	// as in the game, nothing nearer than the start distance
	if (depth < post.froxel_range.x) {
		return Froxels(vec4f(0.0, 0.0, 0.0, 1.0), post.froxel_slices.w);
	}
	let w = log2(depth * post.froxel_slices.x + post.froxel_slices.y) * post.froxel_slices.z;
	return Froxels(textureSampleLevel(froxel_texture, lut_sampler, vec3f(uv, w), 0.0), post.froxel_slices.w);
}

// the fog between the camera and something `distance` metres along unit `direction`
fn fog_over(direction: vec3f, distance: f32, froxels: Froxels) -> Fog {
	var fog = Fog(vec3f(1.0), vec3f(0.0));
	let point_y = post.eye.y + direction.y * distance;

	// atmosphere fog: density e^((start height − y) / H), integrated from the camera's height
	var atmosphere = vec3f(1.0);
	if (post.flags.z != 0u && post.sky_fog.y > 0.5) {
		let below = -point_y * post.atmo_mie.w;
		let a = max(0.01, below + post.eye.y * post.atmo_mie.w);
		let depth = max(0.0, distance * post.atmo_rayleigh.w - post.atmo_extinction.w) * ((1.0 - exp(-a)) / a) *
			exp(below + post.atmo_ambient.w);
		atmosphere = exp(-post.atmo_extinction.rgb * depth);
		let mu = dot(direction, post.atmo_sun.xyz);
		let g = post.atmo_sun.w;
		let hg_base = 1.0 + g * g - 2.0 * g * mu;
		let hg = (1.0 - g * g) / max(4.0 * PI * hg_base * sqrt(hg_base), 0.001);
		let rayleigh = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
		let scattered = clamp(post.atmo_rayleigh.rgb * rayleigh + post.atmo_ambient.rgb + post.atmo_mie.rgb * hg,
			vec3f(0.0), vec3f(255.0));
		fog = Fog(atmosphere, scattered * (vec3f(1.0) - atmosphere));
	}

	// height fog: fades in past the start distance and out past the cutoff, each over 1 / transition metres.
	// it integrates only the part of the ray past the froxels (a negative length leaves it clear); the ramps
	// and the opacity cap still measure the whole distance
	if (post.flags.y != 0u) {
		let cosine = dot(direction, post.forward.xyz);
		var covered = 0.0;
		if (cosine > 5.96e-8) {
			covered = froxels.covered / cosine / distance;
		}
		let delta_y = direction.y * distance;
		let base_y = post.eye.y + covered * delta_y;
		let rest_y = delta_y * (1.0 - covered);
		let rest = distance * (1.0 - covered);
		let density = fog_layer_density(post.fog_layer0, base_y, rest_y) +
			fog_layer_density(post.fog_layer1, base_y, rest_y);
		let range = post.fog_range;
		let before_start = clamp((range.x - distance) * range.y, 0.0, 1.0);
		let past_cutoff = clamp((distance - range.z) * range.w, 0.0, 1.0);
		let t = clamp(max(clamp(exp2(-density * rest), 0.0, 1.0), post.fog_colour.w) + before_start + past_cutoff,
			0.0, 1.0);
		let toward_light = clamp(dot(direction, post.fog_directional_direction.xyz), 0.0, 1.0);
		let directional_depth = density * max(rest - post.fog_directional_direction.w, 0.0);
		let directional = post.fog_directional.rgb * pow(toward_light, post.fog_directional.w) *
			(1.0 - clamp(exp2(-directional_depth), 0.0, 1.0)) * (1.0 - past_cutoff);
		fog = Fog(fog.transmittance * t, fog.inscatter * t + post.fog_colour.rgb * (1.0 - t) + directional);
	}
	// the froxels add in front of both
	let light = froxels.light;
	return Fog(fog.transmittance * light.a, fog.inscatter * light.a + light.rgb);
}

// the cloud panorama's uv along a direction: equirectangular over the whole sphere, v = 0 at the nadir (the
// texture keeps Unity's bottom-up rows)
fn cloud_uv(direction: vec3f) -> vec2f {
	let azimuth = atan2(direction.x, direction.z) + post.cloud.x;
	return vec2f(fract(azimuth / (2.0 * PI) + 0.5), 0.5 + asin(clamp(direction.y, -1.0, 1.0)) / PI);
}

// 1×1: the sky-view LUT's mean from fs_sky_mean, rendered once per frame after the LUT
@group(1) @binding(4) var sky_mean_texture: texture_2d<f32>;

// the sky LUT's cosine-weighted mean over the upper hemisphere (per unit sun illuminance)
@fragment
fn fs_sky_mean() -> @location(0) vec4f {
	var sum = vec3f(0.0);
	for (var e = 0; e < 4; e++) {
		let elevation = (f32(e) + 0.5) / 4.0 * PI * 0.5;
		for (var a = 0; a < 4; a++) {
			let azimuth = f32(a) / 4.0 * 2.0 * PI;
			let d = vec3f(cos(elevation) * cos(azimuth), sin(elevation), cos(elevation) * sin(azimuth));
			sum += sky_view(d) * sin(elevation);
		}
	}
	return vec4f(sum / 16.0 * 2.0, 1.0);
}

// the atmosphere's absolute brightness isn't known (the game scales it by factors not read yet), so it's
// matched to the ambient probe the game bakes from its sky: the same luminance looking up
fn sky_scale() -> f32 {
	let mean = textureLoad(sky_mean_texture, vec2i(0), 0).rgb;
	return luminance(post.sky_up.rgb) / max(luminance(mean), 1e-6);
}

// the sky along a direction, given the cloud panorama's texel there (ignored without a cloud layer): the
// atmosphere's sky with the cloud layer blended over it above the horizon, as HGRP/ProceduralSky does
fn sky_radiance(direction: vec3f, painted: vec4f) -> vec3f {
	if (post.flags.x == 0u) {
		return vec3f(0.0);
	}
	if (post.cloud.w > 0.5 && post.cloud_shape.w > 0.5) {
		return painted.rgb;
	}
	// the game fades its sky-view LUT out just below the horizon
	var sky = sky_view(direction) * sky_scale() * clamp(1.0 + direction.y * 10.0, 0.0, 1.0);
	if (post.cloud.w > 0.5 && direction.y >= 0.0) {
		let contrasted = (painted.rgb - 0.5) * post.cloud.y + 0.5;
		var cloud = vec4f(contrasted, painted.a) * vec4f(post.cloud_shape.xy, 1.0, 1.0);
		cloud = mix(cloud, vec4f(max(cloud.r, cloud.g)), post.cloud.z) * post.cloud_tint;
		sky = mix(sky, cloud.rgb, clamp(cloud.a, 0.0, 1.0));
	}
	return sky;
}

// the sky along a direction, fogged at the sky dome's distance
fn fogged_sky(direction: vec3f, painted: vec4f, froxels: Froxels) -> vec3f {
	let fog = fog_over(direction, post.sky_fog.x, froxels);
	return sky_radiance(direction, painted) * fog.transmittance + fog.inscatter;
}

// the fog over something `distance` metres away
fn atmosphere_over(colour: vec3f, direction: vec3f, distance: f32, froxels: Froxels) -> vec3f {
	let fog = fog_over(direction, distance, froxels);
	return colour * fog.transmittance + fog.inscatter;
}
