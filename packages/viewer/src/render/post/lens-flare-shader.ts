/**
 * sun lens flare shaders (SRP core's data-driven lens flare): one quad per element copy in SRP core's screen
 * frame, faded by how much of a disc around the sun shows sky, and blended onto the composited scene.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

/** per-frame lens flare occlusion parameters */
export const FlareFrameSchema = d.struct({
	/** occlusion disc radius (viewport units), sample count, 1 with occlusion test, height / width */
	occlusion: d.vec4f,
});

/** one flare quad: SRP core's `_FlareData0`, `_FlareData2`, `_FlareColorValue` and `_FlareData3` */
export const FlareQuadSchema = d.struct({
	/** the quad's rotation (cos, sin) and its offset from the sun */
	data0: d.vec4f,
	/** the sun's position, the quad's half size (in units of the screen's height) */
	data2: d.vec4f,
	color: d.vec4f,
	/** off-screen (1 allowed, -1 hidden), circle edge, circle falloff exponent, 1 / side count */
	data3: d.vec4f,
});

/** group 0 bind group layout for lens flare passes */
export const flareFrameLayout = tgpu.bindGroupLayout({
	frame: { uniform: FlareFrameSchema },
	quads: { storage: d.arrayOf(FlareQuadSchema), access: 'readonly' },
	depth: { texture: d.textureDepth2d(), visibility: ['vertex'] },
});

/** group 1 bind group layout for image lens flare quads */
export const flareTextureLayout = tgpu.bindGroupLayout({
	texture: { texture: d.texture2d(d.f32), visibility: ['fragment'] },
	sampler: { sampler: 'filtering', visibility: ['fragment'] },
});

/** SRP core's lens flare hash: a float in `[0, 1)` from an integer */
const flareHash = tgpu.fn(
	[d.u32],
	d.f32,
)((seed) => {
	'use gpu';
	let s = d.u32(seed ^ d.u32(2747636419));
	s = d.u32(s * d.u32(2654435769));
	s = d.u32(s ^ (s >>> 16));
	s = d.u32(s * d.u32(2654435769));
	s = d.u32(s ^ (s >>> 16));
	s = d.u32(s * d.u32(2654435769));
	return d.f32(s) / 4294967296;
});

/** share of samples on a disc around the sun that land on sky */
const sunVisibility = tgpu.fn(
	[d.vec2f, d.bool],
	d.f32,
)((sun, allowOffScreen) => {
	'use gpu';
	const frame = flareFrameLayout.$.frame;
	const samples = d.u32(frame.occlusion.y);
	if (frame.occlusion.z < 0.5 || samples === 0) {
		return 1;
	}
	const size = d.vec2f(std.textureDimensions(flareFrameLayout.$.depth));
	let visible = d.f32(0);
	for (let i = d.u32(0); i < samples; i++) {
		const r = std.sqrt(flareHash(2 * i + 1));
		const phi = 2 * Math.PI * flareHash(2 * i + 2);
		const offset = std.mul(d.vec2f(std.cos(phi), std.sin(phi)), frame.occlusion.x * r);
		const uv = std.add(std.mul(std.add(sun, offset), 0.5), d.vec2f(0.5));
		if (std.all(std.ge(uv, d.vec2f(0))) && std.all(std.le(uv, d.vec2f(1)))) {
			const texel = d.vec2i(std.min(std.mul(uv, size), std.sub(size, d.vec2f(1))));
			// reversed-Z: the sky is cleared to 0, behind everything drawn
			if (std.textureLoad(flareFrameLayout.$.depth, texel, 0) <= 0) {
				visible += 1;
			}
		} else if (allowOffScreen) {
			visible += 1;
		}
	}
	return visible / d.f32(samples);
});

/** vertex entrypoint for lens flare quads */
export const vsFlare = tgpu.vertexFn({
	in: {
		vi: d.builtin.vertexIndex,
		instance: d.builtin.instanceIndex,
	},
	out: {
		position: d.builtin.position,
		uv: d.vec2f,
		quad: d.interpolate('flat', d.u32),
		occlusion: d.f32,
	},
})((input) => {
	'use gpu';
	const frame = flareFrameLayout.$.frame;
	const quad = flareFrameLayout.$.quads[input.instance];
	const corner = d.vec2f(d.f32(input.vi & 1), d.f32(input.vi >>> 1));
	const localXy = std.mul(std.sub(std.mul(corner, 2), d.vec2f(1)), quad.data2.zw);
	const local = d.vec2f(
		localXy.x * quad.data0.x - localXy.y * quad.data0.y,
		localXy.x * quad.data0.y + localXy.y * quad.data0.x,
	);
	local.x *= frame.occlusion.w;
	const pos = std.add(std.add(local, quad.data2.xy), quad.data0.zw);
	const allowOffScreen = quad.data3.x > 0;
	let occlusion = sunVisibility(quad.data2.xy, allowOffScreen);
	if (
		!allowOffScreen &&
		(std.any(std.lt(quad.data2.xy, d.vec2f(-1))) || std.any(std.ge(quad.data2.xy, d.vec2f(1))))
	) {
		occlusion = 0;
	}
	return {
		// SRP core's frame has y down; clip space has it up
		position: d.vec4f(pos.x, -pos.y, 0, 1),
		// v runs with the frame's y, as Unity's quad texture coordinates do on Direct3D
		uv: corner,
		quad: input.instance,
		occlusion,
	};
});

/** fragment entrypoint for textured lens flare quads */
export const fsFlareImage = tgpu.fragmentFn({
	in: {
		uv: d.vec2f,
		quad: d.interpolate('flat', d.u32),
		occlusion: d.f32,
	},
	out: d.vec4f,
})((input) => {
	'use gpu';
	const quad = flareFrameLayout.$.quads[input.quad];
	return std.mul(
		std.mul(
			std.textureSample(flareTextureLayout.$.texture, flareTextureLayout.$.sampler, input.uv),
			quad.color,
		),
		input.occlusion,
	);
});

/** fragment entrypoint for procedural circular lens flare quads */
export const fsFlareCircle = tgpu.fragmentFn({
	in: {
		uv: d.vec2f,
		quad: d.interpolate('flat', d.u32),
		occlusion: d.f32,
	},
	out: d.vec4f,
})((input) => {
	'use gpu';
	const quad = flareFrameLayout.$.quads[input.quad];
	const x = std.length(std.sub(std.mul(input.uv, 2), d.vec2f(1)));
	const sdf = std.clamp((x - 1) / (quad.data3.y - 1 + 1e-4), 0, 1);
	return std.mul(quad.color, std.pow(sdf, quad.data3.z) * input.occlusion);
});
