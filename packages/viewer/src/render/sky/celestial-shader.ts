/**
 * celestial pass shaders: sun disc, nebula, star field, cloud panorama, sky-dome planets
 * (`HGRP/SkydomeStar`), and the ray-traced planet (`HGRP/Planet/PlanetBillboard`). draws only at sky pixels
 * (depth == 0).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { postUniformLayout, viewRay } from '../core/post-schema.ts';
import { hsvToRgb } from '../core/shader-math.ts';

/** a planet painted on the sky dome: a sphere at unit distance whose angular size comes from its radius */
export const SkyPlanetSchema = d.struct({
	/** unit direction to the centre, w = 1 when drawn */
	center: d.vec4f,
	/** the planet's axes: up (pole), forward (u = 0) and right (u sign); w unused */
	up: d.vec4f,
	forward: d.vec4f,
	right: d.vec4f,
	/** unit vector towards its light, w = 1 with the atmosphere rim */
	light: d.vec4f,
	/** x = radius at unit distance, y = ring shadow scale, z = ring radial scale, w = ring radial offset */
	params: d.vec4f,
	/** multiplies the disc and ring (HDR), w = how far the rim ignores the light */
	color: d.vec4f,
	/** multiplies the emissive map, w = below-horizon fade */
	emissive: d.vec4f,
	/** ring tint and alpha */
	ringColor: d.vec4f,
	/** x = lighting sharpness, y = back-face light, z = ring shadow softness, w unused */
	shading: d.vec4f,
	/** atmosphere rim: height, view samples, scattering coefficient, planet radius (world units) */
	atmosphere0: d.vec4f,
	/** light samples, density falloff, brightness, hue shift */
	atmosphere1: d.vec4f,
	/** the planet centre relative to the camera (world units, for the rim), w unused */
	origin: d.vec4f,
});

/** the ray-traced planet, in the units of its material (metres) */
export const RayPlanetSchema = d.struct({
	/** the camera relative to the planet centre, w = surface radius */
	origin: d.vec4f,
	/** density ground radius, atmosphere top, cloud shell radius, view samples */
	radii: d.vec4f,
	/** Rayleigh and Mie scale heights, Mie anisotropy, 1 with the transmittance lookup */
	heights: d.vec4f,
	/** Rayleigh scattering (per m), w = atmosphere brightness */
	rayleigh: d.vec4f,
	/** Mie scattering (per m), w = 1 with cloud shadows */
	mie: d.vec4f,
	/** towards the light that lights it, w unused */
	light: d.vec4f,
	/** the surface's light colour, pre-exposed (rgb); w unused */
	lightColor: d.vec4f,
	/** texture-space rotation (columns of the axis tilt) */
	tilt0: d.vec4f,
	tilt1: d.vec4f,
	tilt2: d.vec4f,
	/** u offset (spin), base colour u offset, base colour scale (xy) */
	uv: d.vec4f,
	tint: d.vec4f,
	seaShallow: d.vec4f,
	seaDeep: d.vec4f,
	/** rim colour */
	fresnel: d.vec4f,
	/** flat ambient added everywhere on the disc */
	indirect: d.vec4f,
	cloudShadow: d.vec4f,
	/** back-side scattering per unit of Rayleigh optical depth */
	ambient: d.vec4f,
	/** cloud alpha, cloud brightness, roughness, 1 to scale roughness by the map */
	surface: d.vec4f,
});

/** uniform block for the celestial pass */
export const CelestialSchema = d.struct({
	/** x = nebula, y = ray-traced planet, zw = sky planets 0 and 1; each 1 when drawn */
	flags: d.vec4u,
	/** x = 1 with the star field, y = 1 with the sun disc, zw unused */
	starFlags: d.vec4u,
	/** nebula tint (x 2, as the game adds it), w = rotation (rad) */
	nebula: d.vec4f,
	/** x = how far the sky planets hide the nebula, yzw unused */
	nebulaMask: d.vec4f,
	/** the game's _SkyBoxStarParam0..6 */
	stars: d.arrayOf(d.vec4f, 7),
	ray: RayPlanetSchema,
	sky: d.arrayOf(SkyPlanetSchema, 2),
	/** unit vector towards the sun, w = how far the lobe's soft skirt shows */
	sunDirection: d.vec4f,
	/** the disc's colour, pre-exposed (rgb), w = the lobe's exponent */
	sunDisc: d.vec4f,
});

/** group 1 bind group layout for celestial uniforms, samplers, and body textures */
export const celestialLayerLayout = tgpu.bindGroupLayout({
	celestial: { uniform: CelestialSchema },
	sampler: { sampler: 'filtering' },
	pointSampler: { sampler: 'non-filtering' },
	nebula: { texture: d.texture2d(d.f32) },
	rayBase: { texture: d.texture2d(d.f32) },
	rayRsm: { texture: d.texture2d(d.f32) },
	rayClouds: { texture: d.texture2d(d.f32) },
	rayLut: { texture: d.texture2d(d.f32) },
	sky0Main: { texture: d.texture2d(d.f32) },
	sky0Emissive: { texture: d.texture2d(d.f32) },
	sky0Ring: { texture: d.texture2d(d.f32) },
	sky1Main: { texture: d.texture2d(d.f32) },
	sky1Emissive: { texture: d.texture2d(d.f32) },
	sky1Ring: { texture: d.texture2d(d.f32) },
	starDensity: { texture: d.texture2d(d.f32) },
});

/** group 2 bind group layout for main-pass depth and cloud panorama */
export const celestialSceneLayout = tgpu.bindGroupLayout({
	depth: { texture: d.textureDepth2d() },
	cloud: { texture: d.texture2d(d.f32) },
	cloudSampler: { sampler: 'filtering' },
});

const celestialLod = tgpu.fn(
	[d.texture2d(d.f32), d.f32],
	d.f32,
)((tex, radians) => {
	'use gpu';
	const width = d.f32(std.textureDimensions(tex).x);
	return std.max(std.log2((width / (2 * Math.PI)) * radians), 0);
});

const pixelAngle = tgpu.fn(
	[],
	d.f32,
)(() => {
	'use gpu';
	return 1 / postUniformLayout.$.post.right.w;
});

// #region sun disc

const sunDisc = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((direction) => {
	'use gpu';
	const celestial = celestialLayerLayout.$.celestial;
	const c = std.pow(std.clamp(std.dot(celestial.sunDirection.xyz, direction), 0, 1), 20);
	const lobe = (0.0100164 * (1 + c * c)) / std.max(std.pow(1.9801 - 1.98 * c, celestial.sunDisc.w), 1e-4);
	const shaped = std.mix(std.smoothstep(0.5, 1, lobe) * lobe, lobe, celestial.sunDirection.w);
	return std.clamp(std.mul(celestial.sunDisc.rgb, shaped), d.vec3f(0), d.vec3f(3));
});

// #endregion

// #region nebula

const rotatedSkyUv = tgpu.fn(
	[d.vec3f, d.f32],
	d.vec2f,
)((direction, angle) => {
	'use gpu';
	const c = std.cos(angle);
	const s = std.sin(angle);
	const x = direction.x * c - direction.z * s;
	const z = direction.x * s + direction.z * c;
	return d.vec2f(
		std.atan2(x, z) / (2 * Math.PI) + 0.5,
		std.asin(std.clamp(direction.y, -1, 1)) / Math.PI + 0.5,
	);
});

const nebulaTexel = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((direction) => {
	'use gpu';
	const celestial = celestialLayerLayout.$.celestial;
	if (celestial.flags.x === 0) {
		return d.vec3f(0);
	}
	const lod = celestialLod(celestialLayerLayout.$.nebula, pixelAngle());
	return std.textureSampleLevel(
		celestialLayerLayout.$.nebula,
		celestialLayerLayout.$.sampler,
		rotatedSkyUv(direction, celestial.nebula.w),
		lod,
	).rgb;
});

// #endregion

// #region cloud panorama

const cloudTexel = tgpu.fn(
	[d.vec3f],
	d.vec4f,
)((direction) => {
	'use gpu';
	const azimuth = std.atan2(direction.x, direction.z) - postUniformLayout.$.post.cloud.x;
	const uv = d.vec2f(
		std.fract(azimuth / (2 * Math.PI) + 0.5),
		(2 * std.asin(std.clamp(direction.y, -1, 1))) / Math.PI,
	);
	return std.textureSampleLevel(
		celestialSceneLayout.$.cloud,
		celestialSceneLayout.$.cloudSampler,
		uv,
		celestialLod(celestialSceneLayout.$.cloud, pixelAngle()),
	);
});

const cloudLayer = tgpu.fn(
	[d.vec3f],
	d.vec4f,
)((direction) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	if (post.cloud.w < 0.5 || direction.y < 0) {
		return d.vec4f(0);
	}
	const texel = cloudTexel(direction);
	const contrasted = std.add(std.mul(std.sub(texel.rgb, d.vec3f(0.5)), post.cloud.y), d.vec3f(0.5));
	let cloud = std.mul(d.vec4f(contrasted, texel.a), d.vec4f(post.cloudShape.xy, 1, 1));
	cloud = std.mul(std.mix(cloud, d.vec4f(std.max(cloud.r, cloud.g)), post.cloud.z), post.cloudTint);
	return d.vec4f(cloud.rgb, std.clamp(cloud.a, 0, 1));
});

// #endregion

// #region stars

const starHash = tgpu.fn(
	[d.vec3f],
	d.f32,
)((v) => {
	'use gpu';
	let h = std.fract(std.mul(v, 0.1031));
	h = std.add(h, d.vec3f(std.dot(h, std.add(h.yzx, d.vec3f(33.33)))));
	return std.fract((h.x + h.y) * h.z);
});

const starWave = tgpu.fn(
	[d.f32],
	d.f32,
)((x) => {
	'use gpu';
	const a = 1 - std.abs(std.fract(x) * 2 - 1);
	return a * a * (3 - 2 * a);
});

const stars = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((direction) => {
	'use gpu';
	const celestial = celestialLayerLayout.$.celestial;
	const p0 = celestial.stars[0];
	const p1 = celestial.stars[1];
	const p2 = celestial.stars[2];
	const p3 = celestial.stars[3];
	const p4 = celestial.stars[4];
	const p6 = celestial.stars[6];
	const angle = (p3.w * Math.PI) / 180;
	const c = std.cos(angle);
	const s = std.sin(angle);
	const p = std.mul(
		std.normalize(d.vec3f(direction.x * c - direction.z * s, direction.y, direction.x * s + direction.z * c)),
		200 * p0.z,
	);
	const cell = std.floor(p);
	const f = std.sub(std.fract(p), d.vec3f(0.5));
	const r0 = starHash(std.add(cell, d.vec3f(p6.y * 0.618034)));
	const soft = std.clamp(p1.w, 0, 1);
	const w = std.max(std.mix(0, 0.01, soft), 1e-5);
	const size = std.mix(p3.x, p3.y, starHash(d.vec3f(r0 + p4.x * 0.618034, p4.x + 1.7, r0 * 3.13 + 0.11)));
	const r2 = std.dot(f, f);
	const g = std.mix(std.exp2(-r2 * size), std.exp2(-r2 * size * 0.24), std.mix(0.12, 0.68, soft));
	const t1 = starHash(std.add(std.add(cell, d.vec3f(1.3, 7.1, 13.7)), d.vec3f(p6.x * 0.071)));
	const t2 = starHash(std.add(std.add(cell.yzx, d.vec3f(5.9, 2.6, 11.4)), d.vec3f(p6.x * 0.193)));
	const time = (postUniformLayout.$.post.up.w / 20) * p0.w;
	const flicker = std.clamp(
		starWave(time * 37 * std.mix(0.55, 1.85, t1) + t2) * 0.62 +
			starWave(time * 61 * std.mix(0.35, 1.25, t2) + t1) * 0.38,
		0,
		1,
	);
	const tint = std.mix(
		p1.rgb,
		p2.rgb,
		starHash(d.vec3f(r0 + p6.x * 0.7548777, p6.x + 9.2, r0 * 5.27 + 0.37)),
	);
	const lod = celestialLod(celestialLayerLayout.$.starDensity, pixelAngle());
	const density = std.textureSampleLevel(
		celestialLayerLayout.$.starDensity,
		celestialLayerLayout.$.sampler,
		rotatedSkyUv(direction, angle),
		lod,
	).r;
	const scale =
		std.smoothstep(p0.x - w, p0.x + w, r0) *
		std.mix(g * g, std.sqrt(std.clamp(g, 0, 1)), soft) *
		(1 + 3 * std.step(0.9995, r0)) *
		flicker *
		2.5 *
		p0.y *
		std.fract(r0 * 4.394 + p4.x) *
		std.clamp(density - p2.w, 0, 1);
	return std.mul(tint, scale);
});

// #endregion

// #region sky planets

const skyPlanetUv = tgpu.fn(
	[d.vec3f, SkyPlanetSchema],
	d.vec2f,
)((n, planet) => {
	'use gpu';
	const h = -std.dot(n, planet.up.xyz);
	const e = std.normalize(std.add(n, std.mul(planet.up.xyz, h)));
	const s = std.sign(std.dot(e, planet.right.xyz));
	const u =
		std.clamp(-s, 0, 1) + (s * std.acos(std.clamp(std.dot(e, planet.forward.xyz), -1, 1))) / (2 * Math.PI);
	return d.vec2f(u, 0.5 - std.asin(std.clamp(-h, -1, 1)) / Math.PI);
});

const sphereSpan = tgpu.fn(
	[d.vec3f, d.vec3f, d.vec3f, d.f32],
	d.vec2f,
)((origin, direction, center, radius) => {
	'use gpu';
	const o = std.sub(origin, center);
	const b = std.dot(o, direction);
	const disc = b * b - (std.dot(o, o) - radius * radius);
	if (disc <= 0) {
		return d.vec2f(0, -1);
	}
	const root = std.sqrt(disc);
	const enter = std.max(0, -b - root);
	return d.vec2f(enter, -b + root - enter);
});

const rgbToHsv = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((c) => {
	'use gpu';
	const k = d.vec4f(0, -1 / 3, 2 / 3, -1);
	const p = std.select(d.vec4f(c.gb, k.xy), d.vec4f(c.bg, k.wz), c.g < c.b);
	const q = std.select(d.vec4f(p.xyw, c.r), d.vec4f(c.r, p.yzx), p.x < c.r);
	const diff = q.x - std.min(q.w, q.y);
	const e = 1e-10;
	return d.vec3f(std.abs(q.z + (q.w - q.y) / (6 * diff + e)), diff / (q.x + e), q.x);
});

const skyPlanetAtmosphere = tgpu.fn(
	[d.vec3f, SkyPlanetSchema],
	d.vec3f,
)((direction, planet) => {
	'use gpu';
	const a = planet.atmosphere0;
	const b = planet.atmosphere1;
	const center = planet.origin.xyz;
	const light = planet.light.xyz;
	const surface = a.w;
	const top = a.w + a.x;
	const shell = sphereSpan(d.vec3f(0), direction, center, top);
	if (shell.y <= 0) {
		return d.vec3f(0);
	}
	let len = shell.y;
	const ground = sphereSpan(d.vec3f(0), direction, center, surface);
	if (ground.y > 0 && ground.x > 0) {
		len = std.min(len, ground.x - shell.x);
	}
	if (len <= 0) {
		return d.vec3f(0);
	}
	const beta = std.mul(a.z, d.vec3f(1 / 4096, 0.0012673497, 0.002668021));
	const step = len / a.y;
	let p = std.mul(direction, shell.x + 0.5 * step);
	let depth = d.f32(0);
	let sum = d.vec3f(0);
	for (let i = d.f32(0); i < a.y; i += 1) {
		const density = std.exp((-(std.distance(p, center) - surface) / a.x) * b.y) * step;
		depth += density;
		const lightSpan = sphereSpan(p, light, center, top);
		const lightStep = std.max(lightSpan.y, 0) / b.x;
		let q = std.add(p, std.mul(light, 0.5 * lightStep));
		let lightDepth = d.f32(0);
		for (let j = d.f32(0); j < b.x; j += 1) {
			lightDepth += std.exp((-std.max(std.distance(q, center) - surface, 0) / a.x) * b.y);
			q = std.add(q, std.mul(light, lightStep));
		}
		sum = std.add(sum, std.mul(std.exp(std.mul(std.neg(beta), lightDepth * lightStep + depth)), density));
		p = std.add(p, std.mul(direction, step));
	}
	const mu = std.dot(std.neg(direction), light);
	const inscatter = std.mul(std.mul(sum, (3 / (16 * Math.PI)) * (1 + mu * mu) * b.z), beta);
	const hsv = rgbToHsv(inscatter);
	hsv.x = std.abs(hsv.x) + b.w;
	return hsvToRgb(hsv);
});

const skyPlanet = tgpu.fn(
	[d.vec3f, SkyPlanetSchema, d.texture2d(d.f32), d.texture2d(d.f32), d.texture2d(d.f32)],
	d.vec4f,
)((direction, planet, mainTex, emissiveTex, ringTex) => {
	'use gpu';
	const center = planet.center.xyz;
	const radius = planet.params.x;
	const k = std.dot(direction, center);
	const disc = radius * radius - 1 + k * k;
	const hit = disc > 0 && k > 0;
	const n = std.div(std.sub(std.mul(direction, k - std.sqrt(std.max(disc, 0))), center), radius);
	const light = planet.light.xyz;
	const uv = skyPlanetUv(n, planet);
	const lit = std.clamp(std.clamp(std.dot(light, n), 0, 1) * planet.shading.x + planet.shading.y, 0, 1);
	const footprint = pixelAngle() / radius / std.max(std.dot(std.neg(direction), n), 0.1);
	const texel = std.textureSampleLevel(
		mainTex,
		celestialLayerLayout.$.sampler,
		uv,
		celestialLod(mainTex, footprint),
	);
	const glow = std.mul(
		std.textureSampleLevel(
			emissiveTex,
			celestialLayerLayout.$.sampler,
			uv,
			celestialLod(emissiveTex, footprint),
		).rgb,
		planet.emissive.rgb,
	);
	let rgb = d.vec3f(0);
	if (hit) {
		rgb = std.mul(std.add(std.mul(texel.rgb, lit), glow), texel.a * texel.a);
	}

	if (planet.params.z !== 0) {
		const up = planet.up.xyz;
		const q = std.sub(
			std.mul(direction, std.abs(std.dot(up, center)) / std.max(std.abs(std.dot(up, direction)), 1e-6)),
			center,
		);
		const r = std.length(q);
		const qn = std.div(q, std.max(r, 1e-6));
		const valid = std.abs(std.dot(up, q)) < 0.001 * std.max(r, 1);
		const v = std.select(d.f32(0), r, valid) * planet.params.z + planet.params.w;
		const s = std.sign(std.dot(qn, planet.right.xyz));
		const u =
			std.clamp(-s, 0, 1) + (s * std.acos(std.clamp(std.dot(qn, planet.forward.xyz), -1, 1))) / (2 * Math.PI);
		const ring = std.textureSampleLevel(ringTex, celestialLayerLayout.$.sampler, d.vec2f(u, v), 0);
		let mask = std.select(d.f32(0), d.f32(1), v > 0 && v < 1);
		if (hit && std.dot(direction, qn) >= 0) {
			mask = 0;
		}
		const c = std.clamp(-std.dot(light, qn), 0, 1);
		const shadowed =
			1 -
			std.clamp(
				std.max(((radius - r * std.sqrt(1 - c * c)) * planet.params.y) / planet.shading.z + 1, 0),
				0,
				1,
			);
		const tinted = std.mul(
			std.mul(ring, planet.ringColor),
			shadowed * std.clamp(std.abs(std.dot(light, up)) + 0.4, 0, 1),
		);
		rgb = std.add(rgb, std.mul(tinted.rgb, tinted.a * mask));
	}

	const horizon = std.mix(1, std.clamp(direction.y, 0, 1), planet.emissive.w);
	rgb = std.mul(std.mul(rgb, planet.color.rgb), horizon);
	if (planet.light.w > 0.5) {
		const rim = skyPlanetAtmosphere(direction, planet);
		rgb = std.add(rgb, std.mul(std.mix(std.mul(rim, lit), rim, planet.color.w), horizon));
	}
	return d.vec4f(rgb, std.select(d.f32(0), d.f32(1), hit));
});

// #endregion

// #region ray-traced planet

const rayCloud = tgpu.fn(
	[d.f32, d.f32],
	d.f32,
)((u, v) => {
	'use gpu';
	const su = std.step(0.5, u);
	const sv = std.step(0.5, v);
	const mask = d.vec4f((1 - su) * sv, su * sv, (1 - su) * (1 - sv), su * (1 - sv));
	return std.dot(
		mask,
		std.textureSampleLevel(
			celestialLayerLayout.$.rayClouds,
			celestialLayerLayout.$.pointSampler,
			std.fract(std.mul(d.vec2f(u, v), 2)),
			0,
		),
	);
});

const rayPlanetUv = tgpu.fn(
	[d.vec3f],
	d.vec2f,
)((n) => {
	'use gpu';
	const ray = celestialLayerLayout.$.celestial.ray;
	const t = d.vec3f(std.dot(n, ray.tilt0.xyz), std.dot(n, ray.tilt1.xyz), std.dot(n, ray.tilt2.xyz));
	return d.vec2f(std.atan2(t.z, t.x) / (2 * Math.PI) + ray.uv.x, (t.y + 1) * 0.5);
});

const RayPlanetHit = d.struct({
	radiance: d.vec3f,
	cover: d.f32,
});

const rayPlanet = tgpu.fn(
	[d.vec3f],
	RayPlanetHit,
)((direction) => {
	'use gpu';
	const ray = celestialLayerLayout.$.celestial.ray;
	const o = ray.origin.xyz;
	const radius = ray.origin.w;
	const light = ray.light.xyz;
	const b = std.dot(direction, o);
	const c = std.dot(o, o);
	const disc = 4 * b * b - 4 * (c - radius * radius);
	const hit = disc > 0 && b < 0;
	const point = std.add(o, std.mul(direction, -b - 0.5 * std.sqrt(std.max(disc, 0))));
	const n = std.normalize(point);

	const uv = rayPlanetUv(n);
	const baseUv = std.mul(d.vec2f(uv.x + ray.uv.y, uv.y), ray.uv.zw);
	const footprint =
		(pixelAngle() * std.length(std.sub(point, o))) / radius / std.max(std.dot(std.neg(direction), n), 0.1);
	const base = std.textureSampleLevel(
		celestialLayerLayout.$.rayBase,
		celestialLayerLayout.$.sampler,
		baseUv,
		celestialLod(celestialLayerLayout.$.rayBase, footprint),
	);
	const rsm = std.textureSampleLevel(
		celestialLayerLayout.$.rayRsm,
		celestialLayerLayout.$.sampler,
		baseUv,
		celestialLod(celestialLayerLayout.$.rayRsm, footprint),
	);

	let surface = d.vec3f(0);
	let rimMask = d.f32(1);
	if (hit) {
		const cloud = rayCloud(std.fract(uv.x * 2), uv.y);
		const cloudColor = cloud * ray.surface.x;

		let shadow = d.f32(1);
		if (ray.mie.w > 0.5) {
			const along = std.dot(point, light);
			const shell = ray.radii.z;
			const toShell = std.sqrt(std.max(shell * shell - (radius * radius - along * along), 0)) - along;
			const shellUv = rayPlanetUv(std.normalize(std.add(point, std.mul(light, toShell))));
			const occluder = rayCloud(std.fract(shellUv.x * 2), shellUv.y);
			shadow =
				1 -
				std.clamp(std.step(0.1, occluder) * occluder * (1 - cloud), 0, 1) / (1 + toShell * toShell * 1e-7);
		}

		let roughness = ray.surface.z;
		if (ray.surface.w > 0.5) {
			roughness *= rsm.r;
		}
		roughness = std.mix(roughness, cloudColor, cloud * ray.surface.x);
		const view = std.neg(direction);
		const nDotL = std.dot(n, light);
		const a = std.max(roughness * roughness, 0.0078125);
		const a2 = a * a;
		const h = std.normalize(std.add(light, view));
		const nDotH = std.clamp(std.dot(n, h), 0, 1);
		const lDotH = std.clamp(std.dot(light, h), 0, 1);
		const denom = nDotH * nDotH * (a2 - 1) + 1.00001;
		const specular = (0.04 * a2) / (denom * denom * std.max(0.1, lDotH * lDotH) * (4 * a + 2));
		const land = std.mul(base.rgb, ray.tint.rgb);
		const sea = std.mix(ray.seaShallow.rgb, ray.seaDeep.rgb, rsm.g);
		const albedo = std.mul(
			std.mix(std.mix(land, sea, rsm.b), d.vec3f(cloudColor * ray.surface.y), cloud),
			0.96,
		);
		const terminator = 1 / (1 + std.exp(-20 * nDotL));
		surface = std.add(
			std.add(
				std.mul(std.mul(std.add(d.vec3f(specular), albedo), terminator), ray.lightColor.rgb),
				std.mul(ray.fresnel.rgb, (1 - std.clamp(std.dot(view, n), 0, 1)) * std.max(0, nDotL)),
			),
			ray.indirect.rgb,
		);
		surface = std.mix(std.mul(surface, ray.cloudShadow.rgb), surface, shadow);
		rimMask = std.mix(shadow, 1, std.pow(std.clamp(1 - std.smoothstep(0, 0.65, std.dot(n, view)), 0, 1), 2));
	}

	let atmosphere = d.vec3f(0);
	if (b <= 0) {
		const top = ray.radii.y;
		const ground = ray.radii.x;
		const dist = std.sqrt(c);
		const cosine = -b / dist;
		const perpendicular = dist * std.sqrt(std.max(1 - cosine * cosine, 0));
		const shell = std.sqrt(std.max(4 * b * b - 4 * (c - top * top), 0));
		let t = (-2 * b - shell) * 0.5;
		const misses = std.step(radius, perpendicular);
		const end = std.mix(
			std.max(dist * cosine - std.sqrt(std.max(radius * radius - perpendicular * perpendicular, 0)), 0),
			(-2 * b + shell) * 0.5,
			misses,
		);
		const steps = ray.radii.w;
		const dt = (end - t) / steps;
		const mu = std.dot(direction, light);
		const g = ray.heights.z;
		const height = top - ground;
		let depth = d.vec2f(0);
		let rayleigh = d.vec3f(0);
		let mie = d.vec3f(0);
		for (let i = d.f32(0); i < steps; i += 1) {
			const x = std.add(o, std.mul(direction, t + dt * 0.5));
			const r = std.length(x);
			const h = r - ground;
			const density = std.mul(std.exp(std.div(d.vec2f(-h), ray.heights.xy)), dt);
			depth = std.add(depth, density);
			const along = std.dot(light, x);
			let sun = d.vec3f(1);
			if (ray.heights.w > 0.5) {
				sun = std.textureSampleLevel(
					celestialLayerLayout.$.rayLut,
					celestialLayerLayout.$.sampler,
					d.vec2f(h / height, std.min((1 - along / r) * 0.5, 0.99)),
					0,
				).rgb;
			} else {
				const span = -along + std.sqrt(std.max(along * along - (std.dot(x, x) - top * top), 0));
				const lightDepth = std.mul(
					std.exp(
						std.div(d.vec2f(-(std.length(std.add(x, std.mul(light, span * 0.5))) - ground)), ray.heights.xy),
					),
					span,
				);
				sun = std.exp(
					std.sub(std.mul(std.neg(ray.mie.rgb), lightDepth.y), std.mul(ray.rayleigh.rgb, lightDepth.x)),
				);
			}
			const transmittance = std.mul(
				std.exp(std.sub(std.mul(std.neg(ray.mie.rgb), depth.y), std.mul(ray.rayleigh.rgb, depth.x))),
				sun,
			);
			rayleigh = std.add(rayleigh, std.mul(transmittance, density.x));
			mie = std.add(mie, std.mul(transmittance, density.y));
			t += dt;
		}
		const phaseRayleigh = ((1 + mu * mu) * 3) / (16 * Math.PI);
		const phaseMie =
			((misses / Math.PI) * (1 - g * g) * (mu * mu + 1)) /
			(std.pow(std.max(1 + g * g - 2 * mu * g, 0), 1.5) * (2 + g * g));
		atmosphere = std.mul(
			std.add(
				std.add(
					std.mul(std.mul(ray.rayleigh.rgb, phaseRayleigh), rayleigh),
					std.mul(std.mul(ray.mie.rgb, phaseMie), mie),
				),
				std.mul(ray.ambient.rgb, depth.x),
			),
			ray.rayleigh.w,
		);
	}
	const inscatter = std.mul(
		std.max(std.mul(atmosphere, std.div(postUniformLayout.$.post.sunIlluminance.rgb, Math.PI)), d.vec3f(0)),
		rimMask,
	);
	return RayPlanetHit({
		radiance: std.add(inscatter, surface),
		cover: std.select(d.f32(0), d.f32(1), hit),
	});
});

// #endregion

const celestialLayers = tgpu.fn(
	[d.vec3f],
	d.vec4f,
)((direction) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const celestial = celestialLayerLayout.$.celestial;
	let mask = d.f32(0);
	let planets = d.vec3f(0);
	if (celestial.flags.z !== 0) {
		const planet = skyPlanet(
			direction,
			SkyPlanetSchema(celestial.sky[0]),
			celestialLayerLayout.$.sky0Main,
			celestialLayerLayout.$.sky0Emissive,
			celestialLayerLayout.$.sky0Ring,
		);
		planets = std.add(planets, planet.rgb);
		mask = std.max(mask, planet.a);
	}
	if (celestial.flags.w !== 0) {
		const planet = skyPlanet(
			direction,
			SkyPlanetSchema(celestial.sky[1]),
			celestialLayerLayout.$.sky1Main,
			celestialLayerLayout.$.sky1Emissive,
			celestialLayerLayout.$.sky1Ring,
		);
		planets = std.add(planets, planet.rgb);
		mask = std.max(mask, planet.a);
	}
	const unmasked = std.clamp(1 - mask, 0, 1);
	const cloud = cloudLayer(direction);
	const behind = 1 - post.cloudShape.z;
	const over = cloud.a * (1 - mask * behind);
	let color = std.add(
		std.add(std.mul(planets, 1 - over), std.mul(cloud.rgb, over)),
		std.mul(planets, cloud.a * behind * unmasked),
	);
	const texel = nebulaTexel(direction);
	color = std.add(
		color,
		std.mul(std.mul(texel, celestial.nebula.rgb), std.mix(1, unmasked, celestial.nebulaMask.x)),
	);
	if (celestial.starFlags.x !== 0) {
		const starMask =
			unmasked *
			std.clamp(1 - std.length(texel) * celestial.stars[4].w, 0, 1) *
			std.mix(1, 1 - cloud.a, celestial.stars[3].z);
		color = std.add(color, std.mul(stars(direction), starMask));
	}
	let sky = 1 - over;
	if (celestial.flags.y !== 0) {
		const ray = rayPlanet(direction);
		color = std.add(std.mul(color, 1 - ray.cover), ray.radiance);
		sky *= 1 - ray.cover;
	}
	if (celestial.starFlags.y !== 0) {
		color = std.add(color, std.mul(sunDisc(direction), sky));
	}
	return d.vec4f(color, 1 - sky);
});

/** fragment entrypoint rendering celestial layers on sky pixels */
export const fsCelestial = tgpu.fragmentFn({
	in: {
		position: d.builtin.position,
		uv: d.vec2f,
	},
	out: d.vec4f,
})((input) => {
	'use gpu';
	if (std.textureLoad(celestialSceneLayout.$.depth, d.vec2i(input.position.xy), 0) > 0) {
		std.discard();
	}
	const post = postUniformLayout.$.post;
	const celestial = celestialLayerLayout.$.celestial;
	const direction = std.normalize(viewRay(input.uv));
	if (post.cloud.w > 0.5 && post.cloudShape.w > 0.5) {
		return d.vec4f(cloudTexel(direction).rgb, 1);
	}
	if (
		post.flags.x === 0 ||
		(std.allEq(celestial.flags, d.vec4u(0)) && celestial.starFlags.y === 0 && post.cloud.w < 0.5)
	) {
		return d.vec4f(0);
	}
	return celestialLayers(direction);
});
