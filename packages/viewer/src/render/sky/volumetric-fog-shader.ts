/**
 * volumetric fog compute shaders: a 3D injection pass lights every froxel in parallel (sun + shadow, ambient
 * probe, local lights, emission) and blends with reprojected history, then a 2D integration pass walks each
 * column front-to-back to accumulate scattered radiance (rgb) and transmittance (a).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { frameLayout } from '../core/frame-core.ts';
import { LUMINANCE_ROUNDED, henyeyGreenstein } from '../core/shader-math.ts';
import { localFogLighting } from '../lighting/shaders/local-lights.ts';
import { cloudShadow } from '../lighting/shaders/sun-shadow.ts';

/** GPU schema of the volumetric fog uniform block */
export const VolumetricFogSchema = d.struct({
	forward: d.vec4f,
	right: d.vec4f,
	up: d.vec4f,
	eye: d.vec4f,
	slices: d.vec4f,
	range: d.vec4f,
	albedo: d.vec4f,
	emissive: d.vec4f,
	sunDirection: d.vec4f,
	sun: d.vec4f,
	layer0: d.vec4f,
	layer1: d.vec4f,
	jitter: d.vec4f,
	previousForward: d.vec4f,
	previousRight: d.vec4f,
	previousUp: d.vec4f,
	eyeOffset: d.vec4f,
});

/** byte size of {@link VolumetricFogSchema} */
export const VOLUMETRIC_FOG_BYTES = d.sizeOf(VolumetricFogSchema);

/** group 1 bind group layout for the 3D froxel lighting/injection compute pass */
export const volumetricFogInjectLayout = tgpu
	.bindGroupLayout({
		fog: { uniform: VolumetricFogSchema },
		historyOut: { storageTexture: d.textureStorage3d('rgba16float', 'write-only') },
		historyIn: { texture: d.texture3d(d.f32) },
		historySampler: { sampler: 'filtering' },
	})
	.$idx(1);

/** group 0 bind group layout for the 2D froxel front-to-back integration compute pass */
export const volumetricFogIntegrateLayout = tgpu
	.bindGroupLayout({
		fog: { uniform: VolumetricFogSchema },
		medium: { texture: d.texture3d(d.f32) },
		froxels: { storageTexture: d.textureStorage3d('rgba16float', 'write-only') },
	})
	.$idx(0);

const sliceDepth = tgpu.fn(
	[d.vec4f, d.f32],
	d.f32,
)((slices, s) => {
	'use gpu';
	return (std.exp2(s / slices.z) - slices.y) / slices.x;
});

const fogDensity = tgpu.fn(
	[d.f32],
	d.f32,
)((y) => {
	'use gpu';
	const fog = volumetricFogInjectLayout.$.fog;
	let density = fog.layer0.x * std.exp2(-std.max(-127, fog.layer0.y * (y - fog.layer0.z)));
	if (fog.layer1.x > 0) {
		density += fog.layer1.x * std.exp2(-std.max(-127, fog.layer1.y * (y - fog.layer1.z)));
	}
	return density;
});

const froxelSun = tgpu.fn(
	[d.vec3f],
	d.f32,
)((rel) => {
	'use gpu';
	const frame = frameLayout.$.frame;
	if (frame.shadowFade.w < 0.5) {
		return cloudShadow(rel);
	}
	let shadow = d.f32(1);
	for (let i = d.u32(0); i < d.u32(4); i++) {
		const diff = std.sub(rel, frame.shadowSpheres[i].xyz);
		if (std.dot(diff, diff) >= frame.shadowSpheres[i].w) {
			continue;
		}
		const p = std.mul(frame.shadowMatrices[i], d.vec4f(rel, 1));
		if (std.all(std.gt(p.xyz, d.vec3f(0))) && std.all(std.lt(p.xyz, d.vec3f(1)))) {
			shadow = std.textureSampleCompareLevel(
				frameLayout.$.shadowMap,
				frameLayout.$.shadowSampler,
				p.xy,
				i,
				p.z,
			);
			break;
		}
	}
	shadow = std.mix(shadow * cloudShadow(rel), frame.shadowLook.z, frame.shadowLook.y);
	return std.mix(1, std.min(1, shadow), frame.shadowLook.x);
});

const History = d.struct({
	medium: d.vec4f,
	weight: d.f32,
});

const froxelHistory = tgpu.fn(
	[d.vec3f],
	History,
)((rel) => {
	'use gpu';
	const fog = volumetricFogInjectLayout.$.fog;
	const weight = fog.previousForward.w;
	if (weight <= 0) {
		return History({ medium: d.vec4f(0), weight: 0 });
	}
	const p = std.add(rel, fog.eyeOffset.xyz);
	const z = std.dot(p, fog.previousForward.xyz);
	const w = (std.log2(std.max(z * fog.slices.x + fog.slices.y, 1e-6)) * fog.slices.z) / fog.slices.w;
	const ndc = std.div(
		d.vec2f(std.dot(p, fog.previousRight.xyz), std.dot(p, fog.previousUp.xyz)),
		std.max(z, 1e-4),
	);
	const uvw = d.vec3f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, w);
	if (z <= 0 || std.any(std.lt(uvw, d.vec3f(0))) || std.any(std.gt(uvw, d.vec3f(1)))) {
		return History({ medium: d.vec4f(0), weight: 0 });
	}
	return History({
		medium: std.textureSampleLevel(
			volumetricFogInjectLayout.$.historyIn,
			volumetricFogInjectLayout.$.historySampler,
			uvw,
			0,
		),
		weight,
	});
});

/** compute entrypoint lighting one froxel in 3D and blending with reprojected history */
export const csFroxelInject = tgpu.computeFn({
	in: { id: d.builtin.globalInvocationId },
	workgroupSize: [4, 4, 4],
})((input) => {
	'use gpu';
	const id = input.id;
	const size = std.textureDimensions(volumetricFogInjectLayout.$.historyOut);
	if (id.x >= size.x || id.y >= size.y || id.z >= size.z) {
		return;
	}
	const fog = volumetricFogInjectLayout.$.fog;
	const frame = frameLayout.$.frame;
	const sizeF = d.vec2f(size.xy);
	const uv = std.div(std.add(d.vec2f(id.xy), d.vec2f(0.5)), sizeF);
	const ray = std.add(
		std.add(fog.forward.xyz, std.mul(fog.right.xyz, uv.x * 2 - 1)),
		std.mul(fog.up.xyz, 1 - uv.y * 2),
	);
	const litUv = std.div(std.add(std.add(d.vec2f(id.xy), d.vec2f(0.5)), fog.jitter.xy), sizeF);
	const litRay = std.add(
		std.add(fog.forward.xyz, std.mul(fog.right.xyz, litUv.x * 2 - 1)),
		std.mul(fog.up.xyz, 1 - litUv.y * 2),
	);
	const s = d.f32(id.z);
	const depth = sliceDepth(fog.slices, s + 0.5);
	const rel = std.mul(litRay, sliceDepth(fog.slices, s + fog.jitter.z));
	const sigma = std.max(0.5 * fogDensity(fog.eye.y + rel.y) * fog.albedo.w, 0);
	let rawSource = d.vec3f(fog.emissive.xyz);
	let rawExtinction = d.f32(0);
	if (sigma > 0) {
		const scattering = std.mul(fog.albedo.xyz, sigma);
		const scatteringLuminance = std.dot(scattering, LUMINANCE_ROUNDED.$);
		const direction = std.normalize(litRay);
		const pixel = std.mul(litUv, frame.renderSize.xy);
		const g = fog.range.z;
		const d4 = d.vec4f(std.mul(direction, g), 1);
		let light = std.mul(
			std.max(
				d.vec3f(std.dot(frame.sh[0], d4), std.dot(frame.sh[1], d4), std.dot(frame.sh[2], d4)),
				d.vec3f(0),
			),
			fog.emissive.w / Math.PI,
		);
		if (fog.sun.x + fog.sun.y + fog.sun.z > 0) {
			const phase = henyeyGreenstein(g, std.dot(direction, fog.sunDirection.xyz));
			light = std.add(light, std.mul(fog.sun.xyz, froxelSun(rel) * phase));
		}
		light = std.add(light, localFogLighting(rel, pixel, direction, g));
		rawSource = std.add(std.mul(light, scattering), fog.emissive.xyz);
		rawExtinction = std.max(sigma - scatteringLuminance, 0) + scatteringLuminance;
	}
	const history = froxelHistory(std.mul(ray, depth));
	const medium = std.mix(d.vec4f(rawSource, rawExtinction), history.medium, history.weight);
	std.textureStore(volumetricFogInjectLayout.$.historyOut, id, medium);
});

/**
 * compute entrypoint integrating one lit froxel column front-to-back into scattered radiance and
 * transmittance
 */
export const csFroxelIntegrate = tgpu.computeFn({
	in: { id: d.builtin.globalInvocationId },
	workgroupSize: [8, 8, 1],
})((input) => {
	'use gpu';
	const id = input.id;
	const size = std.textureDimensions(volumetricFogIntegrateLayout.$.froxels);
	if (id.x >= size.x || id.y >= size.y) {
		return;
	}
	const fog = volumetricFogIntegrateLayout.$.fog;
	const sizeF = d.vec2f(size.xy);
	const uv = std.div(std.add(d.vec2f(id.xy), d.vec2f(0.5)), sizeF);
	const ray = std.add(
		std.add(fog.forward.xyz, std.mul(fog.right.xyz, uv.x * 2 - 1)),
		std.mul(fog.up.xyz, 1 - uv.y * 2),
	);
	const rayLen = std.length(ray);
	const count = d.u32(fog.slices.w);

	let scattered = d.vec3f(0);
	let transmittance = d.f32(1);
	let previous = fog.range.x;
	let travelled = d.f32(0);
	for (let s = d.u32(0); s < count; s++) {
		const depth = sliceDepth(fog.slices, d.f32(s) + 0.5);
		const medium = std.textureLoad(volumetricFogIntegrateLayout.$.medium, d.vec3u(id.xy, s), 0);
		const source = medium.xyz;
		const extinction = medium.w;

		const span = (depth - previous) * rayLen;
		previous = depth;
		travelled += span;
		const fade = std.clamp(travelled * fog.range.y, 0, 1);
		const stepTransmittance = std.exp(-extinction * span);
		const stepScatter = std.div(
			std.mul(std.sub(source, std.mul(source, stepTransmittance)), fade * transmittance),
			std.max(extinction, 1e-5),
		);
		scattered = std.add(scattered, stepScatter);
		transmittance *= std.mix(1, stepTransmittance, fade);
		std.textureStore(
			volumetricFogIntegrateLayout.$.froxels,
			d.vec3u(id.xy, s),
			d.vec4f(scattered, transmittance),
		);
	}
});
