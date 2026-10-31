// what the game draws on the sky beyond the atmosphere: the sun disc, the nebula, planets painted on the sky dome
// (HGRP/SkydomeStar) and the ray-traced planet (HGRP/Planet/PlanetBillboard). each is a function of the view
// direction alone; the game shades them all in its one sky-dome draw. this pass renders them at the sky pixels
// into a target the composite reads, which keeps the composite under the sampled-texture limit
// (docs/game-data/sky-and-fog.md#beyond-the-atmosphere). needs post-common.wgsl.

// a planet painted on the sky dome: a sphere at unit distance whose angular size comes from its radius
struct SkyPlanet {
	// unit direction to the centre, w = 1 when drawn
	center: vec4f,
	// the planet's axes: up (pole), forward (u = 0) and right (u sign); w unused
	up: vec4f,
	forward: vec4f,
	right: vec4f,
	// unit vector towards its light, w = 1 with the atmosphere rim
	light: vec4f,
	// x = radius at unit distance, y = ring shadow scale, z = ring radial scale, w = ring radial offset; the ring
	// is drawn when z ≠ 0
	params: vec4f,
	// multiplies the disc and ring (HDR), w = how far the rim ignores the light (0 lit side only, 1 all round)
	color: vec4f,
	// multiplies the emissive map, w = below-horizon fade (1 fades it out under the horizon)
	emissive: vec4f,
	// ring tint and alpha
	ring_color: vec4f,
	// x = lighting sharpness, y = back-face light, z = ring shadow softness, w unused
	shading: vec4f,
	// atmosphere rim: height, view samples, scattering coefficient, planet radius (world units)
	atmosphere0: vec4f,
	// light samples, density falloff, brightness, hue shift
	atmosphere1: vec4f,
	// the planet centre relative to the camera (world units, for the rim), w unused
	origin: vec4f,
}

// the ray-traced planet, in the units of its material (metres); see celestial.ts for the packing
struct RayPlanet {
	// the camera relative to the planet centre, w = surface radius
	origin: vec4f,
	// density ground radius, atmosphere top, cloud shell radius, view samples
	radii: vec4f,
	// Rayleigh and Mie scale heights, Mie anisotropy, 1 with the transmittance lookup
	heights: vec4f,
	// Rayleigh scattering (per m), w = atmosphere brightness
	rayleigh: vec4f,
	// Mie scattering (per m), w = 1 with cloud shadows
	mie: vec4f,
	// towards the light that lights it, w unused
	light: vec4f,
	// the surface's light colour, pre-exposed (rgb); w unused
	light_color: vec4f,
	// texture-space rotation (columns of the axis tilt)
	tilt0: vec4f,
	tilt1: vec4f,
	tilt2: vec4f,
	// u offset (spin), base colour u offset, base colour scale (xy)
	uv: vec4f,
	tint: vec4f,
	sea_shallow: vec4f,
	sea_deep: vec4f,
	// rim colour
	fresnel: vec4f,
	// flat ambient added everywhere on the disc
	indirect: vec4f,
	cloud_shadow: vec4f,
	// back-side scattering per unit of Rayleigh optical depth
	ambient: vec4f,
	// cloud alpha, cloud brightness, roughness, 1 to scale roughness by the map
	surface: vec4f,
}

struct Celestial {
	// x = nebula, y = ray-traced planet, zw = sky planets 0 and 1; each 1 when drawn
	flags: vec4u,
	// x = 1 with the star field, y = 1 with the sun disc, zw unused
	star_flags: vec4u,
	// nebula tint (× 2, as the game adds it), w = rotation (rad)
	nebula: vec4f,
	// x = how far the sky planets hide the nebula, yzw unused
	nebula_mask: vec4f,
	// the game's _SkyBoxStarParam0..6, packed from the star config (`starLook` in celestial.ts)
	stars: array<vec4f, 7>,
	ray: RayPlanet,
	sky: array<SkyPlanet, 2>,
	// unit vector towards the sun, w = how far the lobe's soft skirt shows
	sun_direction: vec4f,
	// the disc's colour, pre-exposed (rgb), w = the lobe's exponent
	sun_disc: vec4f,
}

@group(1) @binding(0) var<uniform> celestial: Celestial;
@group(1) @binding(1) var celestial_sampler: sampler;
@group(1) @binding(2) var celestial_point_sampler: sampler;
@group(1) @binding(3) var nebula_texture: texture_2d<f32>;
@group(1) @binding(4) var ray_base_texture: texture_2d<f32>;
@group(1) @binding(5) var ray_rsm_texture: texture_2d<f32>;
@group(1) @binding(6) var ray_cloud_texture: texture_2d<f32>;
@group(1) @binding(7) var ray_lut_texture: texture_2d<f32>;
@group(1) @binding(8) var sky0_main_texture: texture_2d<f32>;
@group(1) @binding(9) var sky0_emissive_texture: texture_2d<f32>;
@group(1) @binding(10) var sky0_ring_texture: texture_2d<f32>;
@group(1) @binding(11) var sky1_main_texture: texture_2d<f32>;
@group(1) @binding(12) var sky1_emissive_texture: texture_2d<f32>;
@group(1) @binding(13) var sky1_ring_texture: texture_2d<f32>;
@group(1) @binding(14) var star_density_texture: texture_2d<f32>;

// the pass draws only sky pixels, under a per-pixel branch where implicit-derivative samples aren't allowed, so
// mip levels come from how many texels a pixel spans: `radians` is the pixel's footprint in the texture's u,
// which wraps once around 2π
fn celestial_lod(texture: texture_2d<f32>, radians: f32) -> f32 {
	let width = f32(textureDimensions(texture).x);
	return max(log2(width / (2.0 * PI) * radians), 0.0);
}

// radians of view a pixel spans at the screen centre
fn pixel_angle() -> f32 {
	return 1.0 / post.right.w;
}

// #region sun disc

// the sun disc: a sharp forward-scattering lobe around the sun, its soft skirt kept by the ramp, clamped to 3
fn sun_disc(direction: vec3f) -> vec3f {
	let c = pow(clamp(dot(celestial.sun_direction.xyz, direction), 0.0, 1.0), 20.0);
	let lobe = 0.0100164 * (1.0 + c * c) / max(pow(1.9801 - 1.98 * c, celestial.sun_disc.w), 1e-4);
	let shaped = mix(smoothstep(0.5, 1.0, lobe) * lobe, lobe, celestial.sun_direction.w);
	return clamp(celestial.sun_disc.rgb * shaped, vec3f(0.0), vec3f(3.0));
}

// #endregion

// #region nebula

// an equirectangular map's uv along a direction turned by `angle` about the vertical (Unity's bottom-up rows)
fn rotated_sky_uv(direction: vec3f, angle: f32) -> vec2f {
	let c = cos(angle);
	let s = sin(angle);
	let x = direction.x * c - direction.z * s;
	let z = direction.x * s + direction.z * c;
	return vec2f(atan2(x, z) / (2.0 * PI) + 0.5, asin(clamp(direction.y, -1.0, 1.0)) / PI + 0.5);
}

// the nebula map's texel along a direction, black without a nebula (as the game binds black then)
fn nebula_texel(direction: vec3f) -> vec3f {
	if (celestial.flags.x == 0u) {
		return vec3f(0.0);
	}
	// u spans 2π of azimuth, which a pixel near the horizon crosses at the pixel angle
	let lod = celestial_lod(nebula_texture, pixel_angle());
	return textureSampleLevel(nebula_texture, celestial_sampler, rotated_sky_uv(direction, celestial.nebula.w), lod)
		.rgb;
}

// #endregion

// #region cloud panorama

// the panorama (`cloud.cloudTexture`), with its own sampler
@group(2) @binding(1) var cloud_texture: texture_2d<f32>;
@group(2) @binding(2) var cloud_sampler: sampler;

// the panorama's raw texel along a direction: equirectangular over the upper hemisphere, v = 0 at the horizon and
// 1 at the zenith (the texture keeps Unity's bottom-up rows), turned back by the rotation
fn cloud_texel(direction: vec3f) -> vec4f {
	let azimuth = atan2(direction.x, direction.z) - post.cloud.x;
	let uv = vec2f(fract(azimuth / (2.0 * PI) + 0.5), 2.0 * asin(clamp(direction.y, -1.0, 1.0)) / PI);
	return textureSampleLevel(cloud_texture, cloud_sampler, uv, celestial_lod(cloud_texture, pixel_angle()));
}

// the cloud layer along a direction: tinted colour and its cover (0–1), none below the horizon or without a layer
fn cloud_layer(direction: vec3f) -> vec4f {
	if (post.cloud.w < 0.5 || direction.y < 0.0) {
		return vec4f(0.0);
	}
	let texel = cloud_texel(direction);
	let contrasted = (texel.rgb - 0.5) * post.cloud.y + 0.5;
	var cloud = vec4f(contrasted, texel.a) * vec4f(post.cloud_shape.xy, 1.0, 1.0);
	cloud = mix(cloud, vec4f(max(cloud.r, cloud.g)), post.cloud.z) * post.cloud_tint;
	return vec4f(cloud.rgb, clamp(cloud.a, 0.0, 1.0));
}

// #endregion

// #region stars

// Dave Hoskins' hash13
fn star_hash(v: vec3f) -> f32 {
	var h = fract(v * 0.1031);
	h += dot(h, h.yzx + 33.33);
	return fract((h.x + h.y) * h.z);
}

// a triangle wave's smoothstep, for the twinkle
fn star_wave(x: f32) -> f32 {
	let a = 1.0 - abs(fract(x) * 2.0 - 1.0);
	return a * a * (3.0 - 2.0 * a);
}

// the star field: one candidate star per cell of a grid over the direction, kept where its hash clears the
// density threshold, shaped, tinted and twinkling, thinned by the density map
fn stars(direction: vec3f) -> vec3f {
	let p0 = celestial.stars[0];
	let p1 = celestial.stars[1];
	let p2 = celestial.stars[2];
	let p3 = celestial.stars[3];
	let p4 = celestial.stars[4];
	let p6 = celestial.stars[6];
	let angle = p3.w * PI / 180.0;
	let c = cos(angle);
	let s = sin(angle);
	let p = normalize(vec3f(direction.x * c - direction.z * s, direction.y, direction.x * s + direction.z * c)) *
		200.0 * p0.z;
	let cell = floor(p);
	let f = fract(p) - 0.5;
	let r0 = star_hash(cell + p6.y * 0.618034);
	let soft = clamp(p1.w, 0.0, 1.0);
	let w = max(mix(0.0, 0.01, soft), 1e-5);
	let size = mix(p3.x, p3.y, star_hash(vec3f(r0 + p4.x * 0.618034, p4.x + 1.7, r0 * 3.13 + 0.11)));
	let r2 = dot(f, f);
	let g = mix(exp2(-r2 * size), exp2(-r2 * size * 0.24), mix(0.12, 0.68, soft));
	let t1 = star_hash(cell + vec3f(1.3, 7.1, 13.7) + p6.x * 0.071);
	let t2 = star_hash(cell.yzx + vec3f(5.9, 2.6, 11.4) + p6.x * 0.193);
	// Unity's _Time.x is seconds / 20
	let time = post.up.w / 20.0 * p0.w;
	let flicker = clamp(star_wave(time * 37.0 * mix(0.55, 1.85, t1) + t2) * 0.62 +
		star_wave(time * 61.0 * mix(0.35, 1.25, t2) + t1) * 0.38, 0.0, 1.0);
	let tint = mix(p1.rgb, p2.rgb, star_hash(vec3f(r0 + p6.x * 0.7548777, p6.x + 9.2, r0 * 5.27 + 0.37)));
	let lod = celestial_lod(star_density_texture, pixel_angle());
	let density = textureSampleLevel(star_density_texture, celestial_sampler,
		rotated_sky_uv(direction, angle), lod).r;
	return tint * smoothstep(p0.x - w, p0.x + w, r0) * mix(g * g, sqrt(clamp(g, 0.0, 1.0)), soft) *
		(1.0 + 3.0 * step(0.9995, r0)) * flicker * 2.5 * p0.y * fract(r0 * 4.394 + p4.x) *
		clamp(density - p2.w, 0.0, 1.0);
}

// #endregion

// #region sky planets

// the uv on a planet with axes up (pole), forward (u origin) and right (u sign) at unit normal `n`; v = 0 at the
// pole
fn sky_planet_uv(n: vec3f, planet: SkyPlanet) -> vec2f {
	let h = -dot(n, planet.up.xyz);
	let e = normalize(n + planet.up.xyz * h);
	let s = sign(dot(e, planet.right.xyz));
	let u = clamp(-s, 0.0, 1.0) + s * acos(clamp(dot(e, planet.forward.xyz), -1.0, 1.0)) / (2.0 * PI);
	return vec2f(u, 0.5 - asin(clamp(-h, -1.0, 1.0)) / PI);
}

// the entry distance and length of a ray's path through a sphere, or a negative length when it misses
fn sphere_span(origin: vec3f, direction: vec3f, center: vec3f, radius: f32) -> vec2f {
	let o = origin - center;
	let b = dot(o, direction);
	let disc = b * b - (dot(o, o) - radius * radius);
	if (disc <= 0.0) {
		return vec2f(0.0, -1.0);
	}
	let root = sqrt(disc);
	let enter = max(0.0, -b - root);
	return vec2f(enter, -b + root - enter);
}

fn rgb_to_hsv(c: vec3f) -> vec3f {
	let k = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
	let p = select(vec4f(c.gb, k.xy), vec4f(c.bg, k.wz), c.g < c.b);
	let q = select(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), p.x < c.r);
	let d = q.x - min(q.w, q.y);
	let e = 1e-10;
	return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

fn hsv_to_rgb(c: vec3f) -> vec3f {
	let p = abs(fract(c.xxx + vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
	return c.z * mix(vec3f(1.0), clamp(p - 1.0, vec3f(0.0), vec3f(1.0)), c.y);
}

// the planet's atmosphere rim: single scattering in a shell above its surface, seen from the camera
fn sky_planet_atmosphere(direction: vec3f, planet: SkyPlanet) -> vec3f {
	let a = planet.atmosphere0;
	let b = planet.atmosphere1;
	let center = planet.origin.xyz;
	let light = planet.light.xyz;
	let surface = a.w;
	let top = a.w + a.x;
	let shell = sphere_span(vec3f(0.0), direction, center, top);
	if (shell.y <= 0.0) {
		return vec3f(0.0);
	}
	var length = shell.y;
	let ground = sphere_span(vec3f(0.0), direction, center, surface);
	if (ground.y > 0.0 && ground.x > 0.0) {
		length = min(length, ground.x - shell.x);
	}
	if (length <= 0.0) {
		return vec3f(0.0);
	}
	// coff_R over wavelength⁴, with 800, 530 and 440 nm in units of 100 nm
	let beta = a.z * vec3f(1.0 / 4096.0, 0.0012673497, 0.0026680210);
	let step = length / a.y;
	var p = direction * (shell.x + 0.5 * step);
	var depth = 0.0;
	var sum = vec3f(0.0);
	for (var i = 0.0; i < a.y; i += 1.0) {
		let density = exp(-(distance(p, center) - surface) / a.x * b.y) * step;
		depth += density;
		let light_span = sphere_span(p, light, center, top);
		let light_step = max(light_span.y, 0.0) / b.x;
		var q = p + light * 0.5 * light_step;
		var light_depth = 0.0;
		for (var j = 0.0; j < b.x; j += 1.0) {
			light_depth += exp(-max(distance(q, center) - surface, 0.0) / a.x * b.y);
			q += light * light_step;
		}
		sum += exp(-beta * (light_depth * light_step + depth)) * density;
		p += direction * step;
	}
	let mu = dot(-direction, light);
	let inscatter = sum * (3.0 / (16.0 * PI)) * (1.0 + mu * mu) * beta * b.z;
	var hsv = rgb_to_hsv(inscatter);
	hsv.x = abs(hsv.x) + b.w;
	return hsv_to_rgb(hsv);
}

// one planet's radiance along `direction` (added to the sky) and its disc coverage
fn sky_planet(
	direction: vec3f,
	planet: SkyPlanet,
	main_texture: texture_2d<f32>,
	emissive_texture: texture_2d<f32>,
	ring_texture: texture_2d<f32>,
) -> vec4f {
	let center = planet.center.xyz;
	let radius = planet.params.x;
	let k = dot(direction, center);
	let disc = radius * radius - 1.0 + k * k;
	let hit = disc > 0.0 && k > 0.0;
	let n = (direction * (k - sqrt(max(disc, 0.0))) - center) / radius;
	let light = planet.light.xyz;
	let uv = sky_planet_uv(n, planet);
	let lit = clamp(clamp(dot(light, n), 0.0, 1.0) * planet.shading.x + planet.shading.y, 0.0, 1.0);
	// a pixel spans pixel angle / radius of the surface's longitude, more towards the limb
	let footprint = pixel_angle() / radius / max(dot(-direction, n), 0.1);
	let texel = textureSampleLevel(main_texture, celestial_sampler, uv, celestial_lod(main_texture, footprint));
	let glow = textureSampleLevel(emissive_texture, celestial_sampler, uv, celestial_lod(emissive_texture, footprint))
		.rgb * planet.emissive.rgb;
	var rgb = vec3f(0.0);
	if (hit) {
		rgb = (texel.rgb * lit + glow) * texel.a * texel.a;
	}

	// the ring: the plane through the centre across the pole, hidden where the planet is in front of it
	if (planet.params.z != 0.0) {
		let up = planet.up.xyz;
		let q = direction * (abs(dot(up, center)) / max(abs(dot(up, direction)), 1e-6)) - center;
		let r = length(q);
		let qn = q / max(r, 1e-6);
		let valid = abs(dot(up, q)) < 0.001 * max(r, 1.0);
		let v = select(0.0, r, valid) * planet.params.z + planet.params.w;
		let s = sign(dot(qn, planet.right.xyz));
		let u = clamp(-s, 0.0, 1.0) + s * acos(clamp(dot(qn, planet.forward.xyz), -1.0, 1.0)) / (2.0 * PI);
		let ring = textureSampleLevel(ring_texture, celestial_sampler, vec2f(u, v), 0.0);
		var mask = select(0.0, 1.0, v > 0.0 && v < 1.0);
		if (hit && dot(direction, qn) >= 0.0) {
			mask = 0.0;
		}
		let c = clamp(-dot(light, qn), 0.0, 1.0);
		let shadowed = 1.0 - clamp(max((radius - r * sqrt(1.0 - c * c)) * planet.params.y / planet.shading.z + 1.0, 0.0),
			0.0, 1.0);
		let tinted = ring * planet.ring_color * shadowed * clamp(abs(dot(light, up)) + 0.4, 0.0, 1.0);
		rgb += tinted.rgb * tinted.a * mask;
	}

	let horizon = mix(1.0, clamp(direction.y, 0.0, 1.0), planet.emissive.w);
	rgb *= planet.color.rgb * horizon;
	if (planet.light.w > 0.5) {
		let rim = sky_planet_atmosphere(direction, planet);
		rgb += mix(rim * lit, rim, planet.color.w) * horizon;
	}
	return vec4f(rgb, select(0.0, 1.0, hit));
}

// #endregion

// #region ray-traced planet

// the cloud atlas: four quadrants of longitude × hemisphere packed into RGBA, longitude repeating twice
fn ray_cloud(u: f32, v: f32) -> f32 {
	let su = step(0.5, u);
	let sv = step(0.5, v);
	let mask = vec4f((1.0 - su) * sv, su * sv, (1.0 - su) * (1.0 - sv), su * (1.0 - sv));
	return dot(mask, textureSampleLevel(ray_cloud_texture, celestial_point_sampler, fract(vec2f(u, v) * 2.0), 0.0));
}

// the texture-space uv at a planet-relative unit normal: cylindrical equal-area after the axis tilt
fn ray_planet_uv(n: vec3f) -> vec2f {
	let ray = celestial.ray;
	let t = vec3f(dot(n, ray.tilt0.xyz), dot(n, ray.tilt1.xyz), dot(n, ray.tilt2.xyz));
	return vec2f(atan2(t.z, t.x) / (2.0 * PI) + ray.uv.x, (t.y + 1.0) * 0.5);
}

struct RayPlanetHit {
	// what's added over the sky
	radiance: vec3f,
	// 1 where the disc covers the sky behind
	cover: f32,
}

// the ray-traced planet along `direction`: its lit surface where the ray hits it and its atmosphere's inscatter
fn ray_planet(direction: vec3f) -> RayPlanetHit {
	let ray = celestial.ray;
	let o = ray.origin.xyz;
	let radius = ray.origin.w;
	let light = ray.light.xyz;
	let b = dot(direction, o);
	let c = dot(o, o);
	let disc = 4.0 * b * b - 4.0 * (c - radius * radius);
	let hit = disc > 0.0 && b < 0.0;
	let point = o + direction * (-b - 0.5 * sqrt(max(disc, 0.0)));
	let n = normalize(point);

	let uv = ray_planet_uv(n);
	let base_uv = vec2f(uv.x + ray.uv.y, uv.y) * ray.uv.zw;
	// a pixel spans pixel angle · distance / radius of the surface's longitude, more towards the limb
	let footprint = pixel_angle() * length(point - o) / radius / max(dot(-direction, n), 0.1);
	let base = textureSampleLevel(ray_base_texture, celestial_sampler, base_uv,
		celestial_lod(ray_base_texture, footprint));
	let rsm = textureSampleLevel(ray_rsm_texture, celestial_sampler, base_uv, celestial_lod(ray_rsm_texture, footprint));

	var surface = vec3f(0.0);
	var rim_mask = 1.0;
	if (hit) {
		let cloud = ray_cloud(fract(uv.x * 2.0), uv.y);
		let cloud_color = cloud * ray.surface.x;

		// cloud shadow: the cloud shell where the ray from the surface towards the light crosses it
		var shadow = 1.0;
		if (ray.mie.w > 0.5) {
			let along = dot(point, light);
			let shell = ray.radii.z;
			let to_shell = sqrt(max(shell * shell - (radius * radius - along * along), 0.0)) - along;
			let shell_uv = ray_planet_uv(normalize(point + light * to_shell));
			let occluder = ray_cloud(fract(shell_uv.x * 2.0), shell_uv.y);
			shadow = 1.0 - clamp(step(0.1, occluder) * occluder * (1.0 - cloud), 0.0, 1.0) /
				(1.0 + to_shell * to_shell * 1e-7);
		}

		// URP's minimal GGX with F0 0.04 and a soft terminator in place of the clamped cosine
		var roughness = ray.surface.z;
		if (ray.surface.w > 0.5) {
			roughness *= rsm.r;
		}
		roughness = mix(roughness, cloud_color, cloud * ray.surface.x);
		let view = -direction;
		let n_dot_l = dot(n, light);
		let a = max(roughness * roughness, 0.0078125);
		let a2 = a * a;
		let h = normalize(light + view);
		let n_dot_h = clamp(dot(n, h), 0.0, 1.0);
		let l_dot_h = clamp(dot(light, h), 0.0, 1.0);
		let d = n_dot_h * n_dot_h * (a2 - 1.0) + 1.00001;
		let specular = 0.04 * a2 / (d * d * max(0.1, l_dot_h * l_dot_h) * (4.0 * a + 2.0));
		let land = base.rgb * ray.tint.rgb;
		let sea = mix(ray.sea_shallow.rgb, ray.sea_deep.rgb, rsm.g);
		let albedo = mix(mix(land, sea, rsm.b), vec3f(cloud_color * ray.surface.y), cloud) * 0.96;
		let terminator = 1.0 / (1.0 + exp(-20.0 * n_dot_l));
		surface = (specular + albedo) * terminator * ray.light_color.rgb +
			ray.fresnel.rgb * (1.0 - clamp(dot(view, n), 0.0, 1.0)) * max(0.0, n_dot_l) + ray.indirect.rgb;
		surface = mix(surface * ray.cloud_shadow.rgb, surface, shadow);
		rim_mask = mix(shadow, 1.0, pow(clamp(1.0 - smoothstep(0.0, 0.65, dot(n, view)), 0.0, 1.0), 2.0));
	}

	// the atmosphere: single scattering over a few samples, the sun's transmittance from the material's lookup
	var atmosphere = vec3f(0.0);
	if (b <= 0.0) {
		let top = ray.radii.y;
		let ground = ray.radii.x;
		let distance = sqrt(c);
		let cosine = -b / distance;
		let perpendicular = distance * sqrt(max(1.0 - cosine * cosine, 0.0));
		let shell = sqrt(max(4.0 * b * b - 4.0 * (c - top * top), 0.0));
		var t = (-2.0 * b - shell) * 0.5;
		let misses = step(radius, perpendicular);
		let end = mix(max(distance * cosine - sqrt(max(radius * radius - perpendicular * perpendicular, 0.0)), 0.0),
			(-2.0 * b + shell) * 0.5, misses);
		let steps = ray.radii.w;
		let dt = (end - t) / steps;
		let mu = dot(direction, light);
		let g = ray.heights.z;
		let height = top - ground;
		var depth = vec2f(0.0);
		var rayleigh = vec3f(0.0);
		var mie = vec3f(0.0);
		for (var i = 0.0; i < steps; i += 1.0) {
			let x = o + direction * (t + dt * 0.5);
			let r = length(x);
			let h = r - ground;
			let density = exp(-h / ray.heights.xy) * dt;
			depth += density;
			let along = dot(light, x);
			var sun = vec3f(1.0);
			if (ray.heights.w > 0.5) {
				sun = textureSampleLevel(ray_lut_texture, celestial_sampler,
					vec2f(h / height, min((1.0 - along / r) * 0.5, 0.99)), 0.0).rgb;
			} else {
				let span = -along + sqrt(max(along * along - (dot(x, x) - top * top), 0.0));
				let light_depth = exp(-(length(x + light * span * 0.5) - ground) / ray.heights.xy) * span;
				sun = exp(-ray.mie.rgb * light_depth.y - ray.rayleigh.rgb * light_depth.x);
			}
			let transmittance = exp(-ray.mie.rgb * depth.y - ray.rayleigh.rgb * depth.x) * sun;
			rayleigh += transmittance * density.x;
			mie += transmittance * density.y;
			t += dt;
		}
		let phase_rayleigh = (1.0 + mu * mu) * 3.0 / (16.0 * PI);
		let phase_mie = misses / PI * (1.0 - g * g) * (mu * mu + 1.0) /
			(pow(max(1.0 + g * g - 2.0 * mu * g, 0.0), 1.5) * (2.0 + g * g));
		atmosphere = (ray.rayleigh.rgb * phase_rayleigh * rayleigh + ray.mie.rgb * phase_mie * mie +
			ray.ambient.rgb * depth.x) * ray.rayleigh.w;
	}
	let inscatter = max(atmosphere * post.sun_illuminance.rgb, vec3f(0.0)) * rim_mask;
	return RayPlanetHit(inscatter + surface, select(0.0, 1.0, hit));
}

// #endregion

// the main pass's depth: the layers are drawn only where it's clear (sky)
@group(2) @binding(0) var celestial_depth: texture_depth_2d;

// the layers along `direction` in the game's order: the sun disc and sky planets added to the sky, the cloud panorama over
// them (or behind them, without `drawCloudAfterPlanet`), the nebula and stars added, then the ray-traced planet
// over everything. over a sky radiance `s` they give `s · (1 − a) + rgb`
fn celestial_layers(direction: vec3f) -> vec4f {
	var mask = 0.0;
	var planets = vec3f(0.0);
	if (celestial.flags.z != 0u) {
		let planet = sky_planet(direction, celestial.sky[0], sky0_main_texture, sky0_emissive_texture,
			sky0_ring_texture);
		planets += planet.rgb;
		mask = max(mask, planet.a);
	}
	if (celestial.flags.w != 0u) {
		let planet = sky_planet(direction, celestial.sky[1], sky1_main_texture, sky1_emissive_texture,
			sky1_ring_texture);
		planets += planet.rgb;
		mask = max(mask, planet.a);
	}
	let unmasked = clamp(1.0 - mask, 0.0, 1.0);
	// the clouds cover the sky and planets by `over`; drawn behind the planets (`behind` = 1), they leave the discs
	// alone and the planets' glow off the discs is added back over them
	let cloud = cloud_layer(direction);
	let behind = 1.0 - post.cloud_shape.z;
	let over = cloud.a * (1.0 - mask * behind);
	var color = planets * (1.0 - over) + cloud.rgb * over + planets * (cloud.a * behind * unmasked);
	let texel = nebula_texel(direction);
	color += texel * celestial.nebula.rgb * mix(1.0, unmasked, celestial.nebula_mask.x);
	// stars fade where the nebula is bright and behind the clouds (the game also thins them behind a sky planet's
	// ring; not done here)
	if (celestial.star_flags.x != 0u) {
		color += stars(direction) * unmasked * clamp(1.0 - length(texel) * celestial.stars[4].w, 0.0, 1.0) *
			mix(1.0, 1.0 - cloud.a, celestial.stars[3].z);
	}
	var sky = 1.0 - over;
	if (celestial.flags.y != 0u) {
		let ray = ray_planet(direction);
		color = color * (1.0 - ray.cover) + ray.radiance;
		sky *= 1.0 - ray.cover;
	}
	// the game adds the sun disc onto the sky before the rest, so it shows where the sky does
	if (celestial.star_flags.y != 0u) {
		color += sun_disc(direction) * sky;
	}
	return vec4f(color, 1.0 - sky);
}

// the layers at each sky pixel, for the composite to put over the atmosphere's sky; the raw cloud texel with the
// `clouds` debug view
@fragment
fn fs_celestial(in: FullscreenOut) -> @location(0) vec4f {
	if (textureLoad(celestial_depth, vec2i(in.position.xy), 0) > 0.0) {
		return vec4f(0.0);
	}
	let direction = normalize(view_ray(in.uv));
	if (post.cloud.w > 0.5 && post.cloud_shape.w > 0.5) {
		return vec4f(cloud_texel(direction).rgb, 1.0);
	}
	if (post.flags.x == 0u ||
		(all(celestial.flags == vec4u(0u)) && celestial.star_flags.y == 0u && post.cloud.w < 0.5)) {
		return vec4f(0.0);
	}
	return celestial_layers(direction);
}
