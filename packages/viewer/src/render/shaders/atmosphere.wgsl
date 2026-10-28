// a physically based atmosphere after Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering
// Technique" (EGSR 2020), which the game's atmosphere parameters follow (Unreal's SkyAtmosphere): a
// transmittance LUT, a multiple-scattering LUT, and a per-frame sky-view LUT around the camera. kilometres
// throughout; the planet's centre is below world y = 0 by the bottom radius. needs post-common.wgsl.

@group(1) @binding(0) var transmittance_lut: texture_2d<f32>;
@group(1) @binding(1) var multi_scattering_lut: texture_2d<f32>;
@group(1) @binding(2) var sky_view_lut: texture_2d<f32>;
@group(1) @binding(3) var lut_sampler: sampler;

const TRANSMITTANCE_SIZE = vec2f(256.0, 64.0);
const MULTI_SCATTERING_SIZE = 32.0;
const SKY_VIEW_SIZE = vec2f(192.0, 108.0);

fn bottom_radius() -> f32 {
	return post.planet.x;
}

fn top_radius() -> f32 {
	return post.planet.y;
}

// the camera in planet coordinates (km), kept just above the ground
fn camera_planet_position() -> vec3f {
	let height = max(post.eye.y * 0.001, 0.001);
	return vec3f(0.0, bottom_radius() + height, 0.0);
}

// distance along the ray to the sphere around the planet's centre, or -1 if it misses (nearest hit ahead)
fn ray_sphere(origin: vec3f, direction: vec3f, radius: f32) -> f32 {
	let b = dot(origin, direction);
	let c = dot(origin, origin) - radius * radius;
	let discriminant = b * b - c;
	if (discriminant < 0.0) {
		return -1.0;
	}
	let s = sqrt(discriminant);
	let near = -b - s;
	let far = -b + s;
	if (near >= 0.0) {
		return near;
	}
	if (far >= 0.0) {
		return far;
	}
	return -1.0;
}

struct Medium {
	rayleigh: vec3f,
	mie: vec3f,
	scattering: vec3f,
	extinction: vec3f,
}

fn sample_medium(p: vec3f) -> Medium {
	let height = max(length(p) - bottom_radius(), 0.0);
	let rayleigh_density = exp(-height / max(post.rayleigh.w, 1e-3));
	let mie_density = exp(-height / max(post.mie_scattering.w, 1e-3));
	let ozone_density = clamp(post.ozone_tent.x * (1.0 - abs(height - post.ozone.w) / max(post.ozone_tent.y, 0.01)), 0.0, 1.0);
	var m: Medium;
	m.rayleigh = post.rayleigh.rgb * rayleigh_density;
	m.mie = post.mie_scattering.rgb * mie_density;
	m.scattering = m.rayleigh + m.mie;
	m.extinction = m.rayleigh + post.mie_extinction.rgb * mie_density + post.ozone.rgb * ozone_density;
	return m;
}

fn rayleigh_phase(cos_theta: f32) -> f32 {
	return 3.0 / (16.0 * PI) * (1.0 + cos_theta * cos_theta);
}

fn mie_phase(cos_theta: f32) -> f32 {
	let g = post.planet.z;
	let k = 1.0 + g * g - 2.0 * g * cos_theta;
	return (1.0 - g * g) / (4.0 * PI * k * sqrt(k));
}

// #region transmittance LUT (Bruneton's parameterization)

fn transmittance_uv(radius: f32, cos_zenith: f32) -> vec2f {
	let bottom = bottom_radius();
	let top = top_radius();
	let h = sqrt(max(top * top - bottom * bottom, 0.0));
	let rho = sqrt(max(radius * radius - bottom * bottom, 0.0));
	let discriminant = radius * radius * (cos_zenith * cos_zenith - 1.0) + top * top;
	let d = max(0.0, -radius * cos_zenith + sqrt(max(discriminant, 0.0)));
	let d_min = top - radius;
	let d_max = rho + h;
	let x_mu = (d - d_min) / max(d_max - d_min, 1e-6);
	let x_r = rho / max(h, 1e-6);
	return vec2f(x_mu, x_r);
}

fn transmittance_to_top(p: vec3f, direction: vec3f) -> vec3f {
	let radius = length(p);
	let cos_zenith = dot(p / radius, direction);
	let uv = transmittance_uv(radius, cos_zenith);
	return textureSampleLevel(transmittance_lut, lut_sampler, uv, 0.0).rgb;
}

@fragment
fn fs_transmittance(@builtin(position) position: vec4f) -> @location(0) vec4f {
	let uv = position.xy / TRANSMITTANCE_SIZE;
	let bottom = bottom_radius();
	let top = top_radius();
	let h = sqrt(max(top * top - bottom * bottom, 0.0));
	let rho = h * uv.y;
	let radius = sqrt(rho * rho + bottom * bottom);
	let d_min = top - radius;
	let d_max = rho + h;
	let d = d_min + uv.x * (d_max - d_min);
	var cos_zenith = 1.0;
	if (d > 0.0) {
		cos_zenith = clamp((h * h - rho * rho - d * d) / (2.0 * radius * d), -1.0, 1.0);
	}
	let origin = vec3f(0.0, radius, 0.0);
	let direction = vec3f(sqrt(max(1.0 - cos_zenith * cos_zenith, 0.0)), cos_zenith, 0.0);
	let length_to_top = max(ray_sphere(origin, direction, top), 0.0);
	let steps = 40;
	var depth = vec3f(0.0);
	let dt = length_to_top / f32(steps);
	for (var i = 0; i < steps; i++) {
		let p = origin + direction * ((f32(i) + 0.5) * dt);
		depth += sample_medium(p).extinction * dt;
	}
	return vec4f(exp(-depth), 1.0);
}

// #endregion

// #region multiple scattering LUT

fn multi_scattering(p: vec3f, sun: vec3f) -> vec3f {
	let radius = length(p);
	let cos_sun = dot(p / radius, sun);
	let uv = vec2f(cos_sun * 0.5 + 0.5, clamp((radius - bottom_radius()) / (top_radius() - bottom_radius()), 0.0, 1.0));
	// texel centres
	let st = (uv * (MULTI_SCATTERING_SIZE - 1.0) + 0.5) / MULTI_SCATTERING_SIZE;
	return textureSampleLevel(multi_scattering_lut, lut_sampler, st, 0.0).rgb;
}

// whether the sun is above the planet's horizon at p
fn sun_visible(p: vec3f, sun: vec3f) -> f32 {
	return select(1.0, 0.0, ray_sphere(p, sun, bottom_radius()) >= 0.0);
}

@fragment
fn fs_multi_scattering(@builtin(position) position: vec4f) -> @location(0) vec4f {
	let uv = (position.xy - 0.5) / (MULTI_SCATTERING_SIZE - 1.0);
	let cos_sun = uv.x * 2.0 - 1.0;
	let sun = vec3f(0.0, cos_sun, sqrt(max(1.0 - cos_sun * cos_sun, 0.0)));
	let radius = bottom_radius() + clamp(uv.y, 0.0, 1.0) * (top_radius() - bottom_radius());
	let origin = vec3f(0.0, max(radius, bottom_radius() + 0.001), 0.0);
	let isotropic = 1.0 / (4.0 * PI);

	// second-order radiance and the transfer function f_ms, averaged over the sphere of directions
	var second = vec3f(0.0);
	var transfer = vec3f(0.0);
	let rows = 8;
	for (var j = 0; j < rows; j++) {
		for (var i = 0; i < rows; i++) {
			let cos_theta = 1.0 - 2.0 * (f32(j) + 0.5) / f32(rows);
			let phi = 2.0 * PI * (f32(i) + 0.5) / f32(rows);
			let sin_theta = sqrt(max(1.0 - cos_theta * cos_theta, 0.0));
			let direction = vec3f(cos(phi) * sin_theta, cos_theta, sin(phi) * sin_theta);
			let ground = ray_sphere(origin, direction, bottom_radius());
			let top = ray_sphere(origin, direction, top_radius());
			var t_max = top;
			if (ground >= 0.0) {
				t_max = ground;
			}
			t_max = max(t_max, 0.0);
			let steps = 20;
			let dt = t_max / f32(steps);
			var throughput = vec3f(1.0);
			var radiance = vec3f(0.0);
			var f = vec3f(0.0);
			for (var s = 0; s < steps; s++) {
				let p = origin + direction * ((f32(s) + 0.5) * dt);
				let m = sample_medium(p);
				let step_transmittance = exp(-m.extinction * dt);
				let sun_light = transmittance_to_top(p, sun) * sun_visible(p, sun);
				let source = m.scattering * isotropic * sun_light;
				let integral = (source - source * step_transmittance) / max(m.extinction, vec3f(1e-6));
				radiance += throughput * integral;
				let f_integral = (m.scattering - m.scattering * step_transmittance) / max(m.extinction, vec3f(1e-6));
				f += throughput * f_integral;
				throughput *= step_transmittance;
			}
			if (ground >= 0.0) {
				// the ground's Lambertian bounce
				let p = origin + direction * ground;
				let n = normalize(p);
				let lit = transmittance_to_top(p, sun) * clamp(dot(n, sun), 0.0, 1.0);
				radiance += throughput * lit * post.ground_albedo.rgb / PI;
			}
			second += radiance;
			transfer += f * isotropic;
		}
	}
	let count = f32(rows * rows);
	// both integrate over 4π sr with the isotropic phase, so the averages are the integrals
	second = second / count * 4.0 * PI * isotropic;
	transfer = transfer / count * 4.0 * PI;
	let psi = second / max(vec3f(1.0) - transfer, vec3f(1e-3));
	return vec4f(psi * post.planet.w, 1.0);
}

// #endregion

// #region single + multiple scattering along a ray

struct Scattering {
	// inscattered radiance per unit sun illuminance
	inscatter: vec3f,
	transmittance: vec3f,
}

fn integrate_scattering(origin: vec3f, direction: vec3f, max_distance: f32, sun: vec3f, steps: i32) -> Scattering {
	var result: Scattering;
	result.inscatter = vec3f(0.0);
	result.transmittance = vec3f(1.0);
	var start = 0.0;
	var origin_inside = origin;
	// from above the atmosphere, start where the ray enters it
	if (length(origin) > top_radius()) {
		let enter = ray_sphere(origin, direction, top_radius());
		if (enter < 0.0) {
			return result;
		}
		start = enter;
	}
	let ground = ray_sphere(origin, direction, bottom_radius());
	let top = ray_sphere(origin + direction * (start + 1e-4), direction, top_radius());
	var end = start + max(top, 0.0);
	if (ground >= 0.0) {
		end = min(end, ground);
	}
	end = min(end, max_distance);
	if (end <= start) {
		return result;
	}
	let cos_theta = dot(direction, sun);
	let phase_r = rayleigh_phase(cos_theta);
	let phase_m = mie_phase(cos_theta);
	let dt = (end - start) / f32(steps);
	var throughput = vec3f(1.0);
	var radiance = vec3f(0.0);
	for (var s = 0; s < steps; s++) {
		let p = origin + direction * (start + (f32(s) + 0.3) * dt);
		let m = sample_medium(p);
		let step_transmittance = exp(-m.extinction * dt);
		let sun_light = transmittance_to_top(p, sun) * sun_visible(p, sun);
		let single = (m.rayleigh * phase_r + m.mie * phase_m) * sun_light;
		let multiple = m.scattering * multi_scattering(p, sun);
		let source = single + multiple;
		radiance += throughput * (source - source * step_transmittance) / max(m.extinction, vec3f(1e-6));
		throughput *= step_transmittance;
	}
	result.inscatter = radiance;
	result.transmittance = throughput;
	return result;
}

// #endregion

// #region sky-view LUT: latitude/longitude around the camera, denser near the horizon

fn sky_view_horizon(radius: f32) -> vec2f {
	let v_horizon = sqrt(max(radius * radius - bottom_radius() * bottom_radius(), 0.0));
	let cos_beta = v_horizon / radius;
	let beta = acos(clamp(cos_beta, -1.0, 1.0));
	// zenith angle of the horizon, and how far below it the ground extends
	return vec2f(PI - beta, beta);
}

@fragment
fn fs_sky_view(@builtin(position) position: vec4f) -> @location(0) vec4f {
	let uv = position.xy / SKY_VIEW_SIZE;
	let origin = camera_planet_position();
	let radius = length(origin);
	let horizon = sky_view_horizon(radius);
	var zenith_angle: f32;
	if (uv.y < 0.5) {
		var coord = 1.0 - 2.0 * uv.y;
		coord = 1.0 - coord * coord;
		zenith_angle = horizon.x * coord;
	} else {
		var coord = uv.y * 2.0 - 1.0;
		coord *= coord;
		zenith_angle = horizon.x + horizon.y * coord;
	}
	let cos_light = -((uv.x * uv.x) * 2.0 - 1.0);
	let sin_light = sqrt(max(1.0 - cos_light * cos_light, 0.0));
	let sin_zenith = sin(zenith_angle);
	// local frame: the sun's azimuth is +X
	let direction = vec3f(sin_zenith * cos_light, cos(zenith_angle), sin_zenith * sin_light);
	let sun = post.sky_sun.xyz;
	let sun_horizontal = length(sun.xz);
	let sun_local = vec3f(sun_horizontal, sun.y, 0.0);
	let scattering = integrate_scattering(origin, direction, 1e9, sun_local, 30);
	return vec4f(scattering.inscatter, 1.0);
}

// sky radiance (per unit sun illuminance) seen along a world direction
fn sky_view(direction: vec3f) -> vec3f {
	let origin = camera_planet_position();
	let radius = length(origin);
	let horizon = sky_view_horizon(radius);
	let cos_zenith = clamp(direction.y, -1.0, 1.0);
	let zenith_angle = acos(cos_zenith);
	var v: f32;
	if (zenith_angle < horizon.x) {
		var coord = zenith_angle / horizon.x;
		coord = sqrt(max(1.0 - coord, 0.0));
		v = (1.0 - coord) * 0.5;
	} else {
		var coord = (zenith_angle - horizon.x) / max(horizon.y, 1e-4);
		coord = sqrt(clamp(coord, 0.0, 1.0));
		v = coord * 0.5 + 0.5;
	}
	let sun = post.sky_sun.xyz;
	let flat_sun = normalize(vec2f(sun.x, sun.z) + vec2f(1e-6, 0.0));
	let flat_view = normalize(vec2f(direction.x, direction.z) + vec2f(1e-6, 0.0));
	let cos_light = dot(flat_view, flat_sun);
	let u = sqrt(clamp(-cos_light * 0.5 + 0.5, 0.0, 1.0));
	// the LUT holds one half of the azimuth range (it's symmetric about the sun's azimuth)
	let st = (vec2f(u, v) * (SKY_VIEW_SIZE - 1.0) + 0.5) / SKY_VIEW_SIZE;
	return textureSampleLevel(sky_view_lut, lut_sampler, st, 0.0).rgb;
}

// #endregion
