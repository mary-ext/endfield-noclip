/**
 * physically based atmosphere after Hillaire (EGSR 2020), matching Unreal's SkyAtmosphere: transmittance LUT,
 * multiple-scattering LUT, and per-frame sky-view LUT around the camera. kilometres throughout; the planet's
 * centre is below world y = 0 by `bottomRadius`.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { postUniformLayout } from '../core/post-schema.ts';

/** bind group layout for `fsMultiScattering` */
export const multiScatteringLayout = tgpu.bindGroupLayout({
	transmittance: { texture: d.texture2d(d.f32) },
	lutSampler: { sampler: 'filtering' },
});

/** bind group layout for `fsSkyView` */
export const skyViewBuildLayout = tgpu.bindGroupLayout({
	transmittance: { texture: d.texture2d(d.f32) },
	multiScattering: { texture: d.texture2d(d.f32) },
	lutSampler: { sampler: 'filtering' },
});

/** bind group layout for reading the sky-view LUT and volumetric fog (composite, water, etc.) */
export const skyReadLayout = tgpu
	.bindGroupLayout({
		skyView: { texture: d.texture2d(d.f32) },
		lutSampler: { sampler: 'filtering' },
		froxels: { texture: d.texture3d(d.f32) },
	})
	.$idx(1);

const TRANSMITTANCE_SIZE = tgpu.const(d.vec2f, d.vec2f(256, 64));
const MULTI_SCATTERING_SIZE = 32;
const SKY_VIEW_SIZE = tgpu.const(d.vec2f, d.vec2f(192, 108));

const bottomRadius = tgpu.fn(
	[],
	d.f32,
)(() => {
	'use gpu';
	return postUniformLayout.$.post.planet.x;
});

const topRadius = tgpu.fn(
	[],
	d.f32,
)(() => {
	'use gpu';
	return postUniformLayout.$.post.planet.y;
});

/** the camera in planet coordinates (km), kept just above the ground */
const cameraPlanetPosition = tgpu.fn(
	[],
	d.vec3f,
)(() => {
	'use gpu';
	const height = std.max(postUniformLayout.$.post.eye.y * 0.001, 0.001);
	return d.vec3f(0, bottomRadius() + height, 0);
});

/** distance along the ray to the sphere around the planet's centre, or -1 if it misses */
const raySphere = tgpu.fn(
	[d.vec3f, d.vec3f, d.f32],
	d.f32,
)((origin, direction, radius) => {
	'use gpu';
	const b = std.dot(origin, direction);
	const c = std.dot(origin, origin) - radius * radius;
	const discriminant = b * b - c;
	if (discriminant < 0) {
		return -1;
	}
	const s = std.sqrt(discriminant);
	const near = -b - s;
	const far = -b + s;
	if (near >= 0) {
		return near;
	}
	if (far >= 0) {
		return far;
	}
	return -1;
});

const Medium = d.struct({
	rayleigh: d.vec3f,
	mie: d.vec3f,
	scattering: d.vec3f,
	extinction: d.vec3f,
});

const sampleMedium = tgpu.fn(
	[d.vec3f],
	Medium,
)((p) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const height = std.max(std.length(p) - bottomRadius(), 0);
	const rayleighDensity = std.exp(-height / std.max(post.rayleigh.w, 1e-3));
	const mieDensity = std.exp(-height / std.max(post.mieScattering.w, 1e-3));
	const ozoneDensity = std.clamp(
		post.ozoneTent.x * (1 - std.abs(height - post.ozone.w) / std.max(post.ozoneTent.y, 0.01)),
		0,
		1,
	);
	const rayleigh = std.mul(post.rayleigh.rgb, rayleighDensity);
	const mie = std.mul(post.mieScattering.rgb, mieDensity);
	const scattering = std.add(rayleigh, mie);
	const extinction = std.add(
		std.add(rayleigh, std.mul(post.mieExtinction.rgb, mieDensity)),
		std.mul(post.ozone.rgb, ozoneDensity),
	);
	return Medium({ rayleigh, mie, scattering, extinction });
});

/**
 * Rayleigh scattering phase function.
 *
 * @param cosTheta cosine of the scattering angle
 * @returns phase function value
 */
export const rayleighPhase = tgpu.fn(
	[d.f32],
	d.f32,
)((cosTheta) => {
	'use gpu';
	return (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta);
});

const miePhase = tgpu.fn(
	[d.f32],
	d.f32,
)((cosTheta) => {
	'use gpu';
	const g = postUniformLayout.$.post.planet.z;
	const k = 1 + g * g - 2 * g * cosTheta;
	return (1 - g * g) / (4 * Math.PI * k * std.sqrt(k));
});

// #region transmittance LUT (Bruneton's parameterization)

const transmittanceUv = tgpu.fn(
	[d.f32, d.f32],
	d.vec2f,
)((radius, cosZenith) => {
	'use gpu';
	const bottom = bottomRadius();
	const top = topRadius();
	const h = std.sqrt(std.max(top * top - bottom * bottom, 0));
	const rho = std.sqrt(std.max(radius * radius - bottom * bottom, 0));
	const discriminant = radius * radius * (cosZenith * cosZenith - 1) + top * top;
	const dist = std.max(0, -radius * cosZenith + std.sqrt(std.max(discriminant, 0)));
	const dMin = top - radius;
	const dMax = rho + h;
	const xMu = (dist - dMin) / std.max(dMax - dMin, 1e-6);
	const xR = rho / std.max(h, 1e-6);
	return d.vec2f(xMu, xR);
});

const transmittanceToTop = tgpu.fn(
	[d.texture2d(d.f32), d.sampler(), d.vec3f, d.vec3f],
	d.vec3f,
)((transmittanceTex, lutSampler, p, direction) => {
	'use gpu';
	const radius = std.length(p);
	const cosZenith = std.dot(std.div(p, radius), direction);
	const uv = transmittanceUv(radius, cosZenith);
	return std.textureSampleLevel(transmittanceTex, lutSampler, uv, 0).rgb;
});

/** fragment entrypoint building the 256x64 transmittance LUT */
export const fsTransmittance = tgpu.fragmentFn({
	in: { position: d.builtin.position },
	out: d.vec4f,
})((input) => {
	'use gpu';
	const uv = std.div(input.position.xy, TRANSMITTANCE_SIZE.$);
	const bottom = bottomRadius();
	const top = topRadius();
	const h = std.sqrt(std.max(top * top - bottom * bottom, 0));
	const rho = h * uv.y;
	const radius = std.sqrt(rho * rho + bottom * bottom);
	const dMin = top - radius;
	const dMax = rho + h;
	const dist = dMin + uv.x * (dMax - dMin);
	let cosZenith = d.f32(1);
	if (dist > 0) {
		cosZenith = std.clamp((h * h - rho * rho - dist * dist) / (2 * radius * dist), -1, 1);
	}
	const origin = d.vec3f(0, radius, 0);
	const direction = d.vec3f(std.sqrt(std.max(1 - cosZenith * cosZenith, 0)), cosZenith, 0);
	const lengthToTop = std.max(raySphere(origin, direction, top), 0);
	const steps = 40;
	let depth = d.vec3f(0);
	const dt = lengthToTop / steps;
	for (let i = 0; i < steps; i++) {
		const p = std.add(origin, std.mul(direction, (d.f32(i) + 0.5) * dt));
		depth = std.add(depth, std.mul(sampleMedium(p).extinction, dt));
	}
	return d.vec4f(std.exp(std.neg(depth)), 1);
});

// #endregion

// #region multiple scattering LUT

const multiScattering = tgpu.fn(
	[d.vec3f, d.vec3f],
	d.vec3f,
)((p, sun) => {
	'use gpu';
	const radius = std.length(p);
	const cosSun = std.dot(std.div(p, radius), sun);
	const uv = d.vec2f(
		cosSun * 0.5 + 0.5,
		std.clamp((radius - bottomRadius()) / (topRadius() - bottomRadius()), 0, 1),
	);
	const st = std.div(std.add(std.mul(uv, MULTI_SCATTERING_SIZE - 1), d.vec2f(0.5)), MULTI_SCATTERING_SIZE);
	return std.textureSampleLevel(skyViewBuildLayout.$.multiScattering, skyViewBuildLayout.$.lutSampler, st, 0)
		.rgb;
});

/** whether the sun is above the planet's horizon at `p` */
const sunVisible = tgpu.fn(
	[d.vec3f, d.vec3f],
	d.f32,
)((p, sun) => {
	'use gpu';
	return std.select(d.f32(1), d.f32(0), raySphere(p, sun, bottomRadius()) >= 0);
});

/** fragment entrypoint building the 32x32 multiple-scattering LUT */
export const fsMultiScattering = tgpu.fragmentFn({
	in: { position: d.builtin.position },
	out: d.vec4f,
})((input) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const uv = std.div(std.sub(input.position.xy, d.vec2f(0.5)), MULTI_SCATTERING_SIZE - 1);
	const cosSun = uv.x * 2 - 1;
	const sun = d.vec3f(0, cosSun, std.sqrt(std.max(1 - cosSun * cosSun, 0)));
	const radius = bottomRadius() + std.clamp(uv.y, 0, 1) * (topRadius() - bottomRadius());
	const origin = d.vec3f(0, std.max(radius, bottomRadius() + 0.001), 0);
	const isotropic = 1 / (4 * Math.PI);

	let second = d.vec3f(0);
	let transfer = d.vec3f(0);
	const rows = 8;
	for (let j = 0; j < rows; j++) {
		for (let i = 0; i < rows; i++) {
			const cosTheta = 1 - (2 * (d.f32(j) + 0.5)) / rows;
			const phi = (2 * Math.PI * (d.f32(i) + 0.5)) / rows;
			const sinTheta = std.sqrt(std.max(1 - cosTheta * cosTheta, 0));
			const direction = d.vec3f(std.cos(phi) * sinTheta, cosTheta, std.sin(phi) * sinTheta);
			const ground = raySphere(origin, direction, bottomRadius());
			const top = raySphere(origin, direction, topRadius());
			let tMax = top;
			if (ground >= 0) {
				tMax = ground;
			}
			tMax = std.max(tMax, 0);
			const steps = 20;
			const dt = tMax / steps;
			let throughput = d.vec3f(1);
			let radiance = d.vec3f(0);
			let f = d.vec3f(0);
			for (let s = 0; s < steps; s++) {
				const p = std.add(origin, std.mul(direction, (d.f32(s) + 0.5) * dt));
				const m = sampleMedium(p);
				const stepTransmittance = std.exp(std.mul(std.neg(m.extinction), dt));
				const sunLight = std.mul(
					transmittanceToTop(
						multiScatteringLayout.$.transmittance,
						multiScatteringLayout.$.lutSampler,
						p,
						sun,
					),
					sunVisible(p, sun),
				);
				const source = std.mul(std.mul(m.scattering, isotropic), sunLight);
				const invExt = std.max(m.extinction, d.vec3f(1e-6));
				const integral = std.div(std.sub(source, std.mul(source, stepTransmittance)), invExt);
				radiance = std.add(radiance, std.mul(throughput, integral));
				const fIntegral = std.div(std.sub(m.scattering, std.mul(m.scattering, stepTransmittance)), invExt);
				f = std.add(f, std.mul(throughput, fIntegral));
				throughput = std.mul(throughput, stepTransmittance);
			}
			if (ground >= 0) {
				const p = std.add(origin, std.mul(direction, ground));
				const n = std.normalize(p);
				const lit = std.mul(
					transmittanceToTop(
						multiScatteringLayout.$.transmittance,
						multiScatteringLayout.$.lutSampler,
						p,
						sun,
					),
					std.clamp(std.dot(n, sun), 0, 1),
				);
				radiance = std.add(
					radiance,
					std.div(std.mul(std.mul(throughput, lit), post.groundAlbedo.rgb), Math.PI),
				);
			}
			second = std.add(second, radiance);
			transfer = std.add(transfer, std.mul(f, isotropic));
		}
	}
	const count = d.f32(rows * rows);
	second = std.mul(std.div(second, count), 4 * Math.PI * isotropic);
	transfer = std.mul(std.div(transfer, count), 4 * Math.PI);
	const psi = std.div(second, std.max(std.sub(d.vec3f(1), transfer), d.vec3f(1e-3)));
	return d.vec4f(std.mul(psi, post.planet.w), 1);
});

// #endregion

// #region single + multiple scattering along a ray

const Scattering = d.struct({
	inscatter: d.vec3f,
	transmittance: d.vec3f,
});

const integrateScattering = tgpu.fn(
	[d.vec3f, d.vec3f, d.f32, d.vec3f, d.i32],
	Scattering,
)((origin, direction, maxDistance, sun, steps) => {
	'use gpu';
	let start = d.f32(0);
	if (std.length(origin) > topRadius()) {
		const enter = raySphere(origin, direction, topRadius());
		if (enter < 0) {
			return Scattering({ inscatter: d.vec3f(0), transmittance: d.vec3f(1) });
		}
		start = enter;
	}
	const ground = raySphere(origin, direction, bottomRadius());
	const top = raySphere(std.add(origin, std.mul(direction, start + 1e-4)), direction, topRadius());
	let end = start + std.max(top, 0);
	if (ground >= 0) {
		end = std.min(end, ground);
	}
	end = std.min(end, maxDistance);
	if (end <= start) {
		return Scattering({ inscatter: d.vec3f(0), transmittance: d.vec3f(1) });
	}
	const cosTheta = std.dot(direction, sun);
	const phaseR = rayleighPhase(cosTheta);
	const phaseM = miePhase(cosTheta);
	const dt = (end - start) / d.f32(steps);
	let throughput = d.vec3f(1);
	let radiance = d.vec3f(0);
	for (let s = 0; s < steps; s++) {
		const p = std.add(origin, std.mul(direction, start + (d.f32(s) + 0.3) * dt));
		const m = sampleMedium(p);
		const stepTransmittance = std.exp(std.mul(std.neg(m.extinction), dt));
		const sunLight = std.mul(
			transmittanceToTop(skyViewBuildLayout.$.transmittance, skyViewBuildLayout.$.lutSampler, p, sun),
			sunVisible(p, sun),
		);
		const single = std.mul(std.add(std.mul(m.rayleigh, phaseR), std.mul(m.mie, phaseM)), sunLight);
		const multiple = std.mul(m.scattering, multiScattering(p, sun));
		const source = std.add(single, multiple);
		radiance = std.add(
			radiance,
			std.div(
				std.mul(throughput, std.sub(source, std.mul(source, stepTransmittance))),
				std.max(m.extinction, d.vec3f(1e-6)),
			),
		);
		throughput = std.mul(throughput, stepTransmittance);
	}
	return Scattering({ inscatter: radiance, transmittance: throughput });
});

// #endregion

// #region sky-view LUT

const skyViewHorizon = tgpu.fn(
	[d.f32],
	d.vec2f,
)((radius) => {
	'use gpu';
	const vHorizon = std.sqrt(std.max(radius * radius - bottomRadius() * bottomRadius(), 0));
	const cosBeta = vHorizon / radius;
	const beta = std.acos(std.clamp(cosBeta, -1, 1));
	return d.vec2f(Math.PI - beta, beta);
});

/** fragment entrypoint building the per-frame 192x108 sky-view LUT */
export const fsSkyView = tgpu.fragmentFn({
	in: { position: d.builtin.position },
	out: d.vec4f,
})((input) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const uv = std.div(input.position.xy, SKY_VIEW_SIZE.$);
	const origin = cameraPlanetPosition();
	const radius = std.length(origin);
	const horizon = skyViewHorizon(radius);
	let zenithAngle = d.f32(0);
	if (uv.y < 0.5) {
		let coord = 1 - 2 * uv.y;
		coord = 1 - coord * coord;
		zenithAngle = horizon.x * coord;
	} else {
		let coord = uv.y * 2 - 1;
		coord *= coord;
		zenithAngle = horizon.x + horizon.y * coord;
	}
	const cosLight = -(uv.x * uv.x * 2 - 1);
	const sinLight = std.sqrt(std.max(1 - cosLight * cosLight, 0));
	const sinZenith = std.sin(zenithAngle);
	const direction = d.vec3f(sinZenith * cosLight, std.cos(zenithAngle), sinZenith * sinLight);
	const sun = post.skySun.xyz;
	const sunHorizontal = std.length(sun.xz);
	const sunLocal = d.vec3f(sunHorizontal, sun.y, 0);
	const scattering = integrateScattering(origin, direction, 1e9, sunLocal, 30);
	return d.vec4f(scattering.inscatter, 1);
});

/**
 * sky radiance (per unit sun illuminance) seen along a world direction, sampled from {@link skyReadLayout}.
 *
 * @param direction unit world direction
 * @returns sky radiance per unit sun illuminance
 */
export const skyView = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((direction) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const origin = cameraPlanetPosition();
	const radius = std.length(origin);
	const horizon = skyViewHorizon(radius);
	const cosZenith = std.clamp(direction.y, -1, 1);
	const zenithAngle = std.acos(cosZenith);
	let v = d.f32(0);
	if (zenithAngle < horizon.x) {
		let coord = zenithAngle / horizon.x;
		coord = std.sqrt(std.max(1 - coord, 0));
		v = (1 - coord) * 0.5;
	} else {
		let coord = (zenithAngle - horizon.x) / std.max(horizon.y, 1e-4);
		coord = std.sqrt(std.clamp(coord, 0, 1));
		v = coord * 0.5 + 0.5;
	}
	const sun = post.skySun.xyz;
	const flatSun = std.normalize(std.add(d.vec2f(sun.x, sun.z), d.vec2f(1e-6, 0)));
	const flatView = std.normalize(std.add(d.vec2f(direction.x, direction.z), d.vec2f(1e-6, 0)));
	const cosLight = std.dot(flatView, flatSun);
	const u = std.sqrt(std.clamp(-cosLight * 0.5 + 0.5, 0, 1));
	const st = std.div(
		std.add(std.mul(d.vec2f(u, v), std.sub(SKY_VIEW_SIZE.$, d.vec2f(1))), d.vec2f(0.5)),
		SKY_VIEW_SIZE.$,
	);
	return std.textureSampleLevel(skyReadLayout.$.skyView, skyReadLayout.$.lutSampler, st, 0).rgb;
});

/**
 * atmosphere sky radiance along a world direction, faded just below the horizon.
 *
 * @param direction unit world direction
 * @returns pre-exposed sky radiance
 */
export const skyRadiance = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((direction) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	if (post.flags.x === 0) {
		return d.vec3f(0);
	}
	return std.mul(std.mul(skyView(direction), post.skyIlluminance.rgb), std.clamp(1 + direction.y * 10, 0, 1));
});

// #endregion
