// the sky, aerial perspective and height fog as the composite and water passes apply them. needs
// post-common.wgsl and atmosphere.wgsl.

// distance (m) the sky counts as for fog without a cutoff
const SKY_FOG_DISTANCE = 100000.0;

// one exponential layer's optical depth along a ray from the camera, Unreal's analytic line integral
fn fog_layer_depth(layer: vec4f, origin_y: f32, delta_y: f32, distance: f32) -> f32 {
	let density = layer.x * exp(-layer.y * (origin_y - layer.z));
	let falloff = layer.y * delta_y;
	var integral = 1.0;
	if (abs(falloff) > 1e-4) {
		integral = (1.0 - exp(-falloff)) / falloff;
	}
	return density * integral * distance;
}

fn height_fog(colour: vec3f, direction: vec3f, distance: f32) -> vec3f {
	let start = post.fog_range.x;
	let cutoff = post.fog_range.y;
	var end = distance;
	if (cutoff > 0.0) {
		end = min(end, cutoff);
	}
	if (end <= start) {
		return colour;
	}
	// the part of the ray past the start distance
	let length_after = end - start;
	let origin_y = post.eye.y + direction.y * start;
	let delta_y = direction.y * length_after;
	let depth = fog_layer_depth(post.fog_layer0, origin_y, delta_y, length_after) +
		fog_layer_depth(post.fog_layer1, origin_y, delta_y, length_after);
	let opacity = min(1.0 - exp(-depth), post.fog_colour.w);
	// the inscatter colour reads as a multiple of the sky's illuminance (the ambient probe is far too dim for
	// the near-white fog the game shows); a guess, matched against in-game shots
	var inscatter = post.fog_colour.rgb * post.sky_illuminance.rgb / PI;
	if (distance > post.fog_range.w) {
		let toward_sun = clamp(dot(direction, post.sun.xyz), 0.0, 1.0);
		inscatter += post.fog_directional.rgb * pow(toward_sun, post.fog_range.z);
	}
	return mix(colour, inscatter, opacity);
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

// the sky along a direction, given the cloud panorama's texel there (ignored without a cloud layer)
fn sky_radiance(direction: vec3f, painted: vec3f) -> vec3f {
	if (post.flags.x == 0u) {
		return vec3f(0.0);
	}
	if (post.cloud_tint.w > 0.5) {
		if (post.cloud_shape.w > 0.5) {
			return painted;
		}
		// the panorama is an opaque painted sky (alpha is 1 throughout); its brightness settings read as an
		// absolute scale and an exposure offset
		return painted * post.cloud_tint.rgb * post.cloud.w * exp2(post.cloud.z);
	}
	return sky_view(direction) * sky_scale();
}

// aerial perspective and height fog over something `distance` metres away
fn atmosphere_over(colour: vec3f, direction: vec3f, distance: f32) -> vec3f {
	var c = colour;
	if (post.flags.z != 0u) {
		let km = distance * 0.001;
		let scattering = integrate_scattering(camera_planet_position(), direction, km, post.sky_sun.xyz, 8);
		c = c * scattering.transmittance + scattering.inscatter * sky_scale();
	}
	if (post.flags.y != 0u) {
		c = height_fog(c, direction, distance);
	}
	return c;
}
