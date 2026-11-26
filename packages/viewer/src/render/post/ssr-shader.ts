/**
 * screen-space reflections (PC high quality, half render size): `fsSsrMarch` traces mirror rays through the
 * depth buffer into last frame's composited scene, `fsSsrTemporal` filters hit colour and fade over frames,
 * `fsSsrDownsample` builds a depth-aware pyramid, and `fsSsrResolve` blurs by the reflected cone footprint.
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

import { gbufferBNormal, gbufferBValid } from '../core/gbuffer.ts';
import { postUniformLayout, viewDepth, viewRay } from '../core/post-schema.ts';
import { ssrDeviceDepth, ssrFade, ssrMarchRay, ssrProject } from '../core/screen-space.ts';
import { fromYcocg, toYcocg } from '../core/shader-math.ts';

/** per-frame SSR uniforms */
export const SsrSchema = d.struct({
	/** last frame's camera-relative view-projection, unjittered */
	previousViewProj: d.mat4x4f,
	/** this frame's eye minus last frame's (m); w = 1 when there is no last frame to read */
	eyeDelta: d.vec4f,
	/** volume's fadenessOnScreen, fadenessOnMirrorMul and fadenessOnMirrorAdd; w unused */
	fade: d.vec4f,
	/** x = march steps, y = pyramid's coarsest mip, zw unused */
	march: d.vec4f,
	/** the passes' size, px (xy), and its reciprocal (zw) */
	size: d.vec4f,
});

/** shared SSR uniforms, depth buffer, and linear clamping sampler */
export const ssrSharedLayout = tgpu.bindGroupLayout({
	ssr: { uniform: SsrSchema },
	depth: { texture: d.textureDepth2d() },
	linearSampler: { sampler: 'filtering' },
});

/** inputs for `fsSsrMarch` */
export const ssrMarchLayout = tgpu.bindGroupLayout({
	gbufferB: { texture: d.texture2d(d.f32) },
	previousScene: { texture: d.texture2d(d.f32) },
	velocity: { texture: d.texture2d(d.f32) },
});

/** inputs for `fsSsrTemporal` */
export const ssrTemporalLayout = tgpu.bindGroupLayout({
	marchColor: { texture: d.texture2d(d.f32) },
	marchWeight: { texture: d.texture2d(d.f32) },
	marchFade: { texture: d.texture2d(d.f32) },
	history: { texture: d.texture2d(d.f32) },
	velocity: { texture: d.texture2d(d.f32) },
});

/** inputs for `fsSsrDownsample` */
export const ssrDownsampleLayout = tgpu.bindGroupLayout({
	finePyramid: { texture: d.texture2d(d.f32) },
	fineDepth: { texture: d.texture2d(d.f32) },
});

/** inputs for `fsSsrResolve` */
export const ssrResolveLayout = tgpu.bindGroupLayout({
	marchWeight: { texture: d.texture2d(d.f32) },
	pyramid: { texture: d.texture2d(d.f32) },
	depthPyramid: { texture: d.texture2d(d.f32) },
});

/** view depth stored where nothing was drawn; any real surface is nearer */
const SKY_DEPTH = 60000;

/** the game's 4x4 binomial weights for pyramid downsample and resolve */
const BINOMIAL = tgpu.const(d.arrayOf(d.f32, 4), [0.125, 0.375, 0.375, 0.125]);

const SsrSurface = d.struct({
	normal: d.vec3f,
	roughness: d.f32,
	valid: d.bool,
});

const reflectionSurfaceAt = tgpu.fn(
	[d.vec2i],
	SsrSurface,
)((px) => {
	'use gpu';
	const gb = std.textureLoad(ssrMarchLayout.$.gbufferB, px, 0);
	return SsrSurface({
		normal: gbufferBNormal(gb),
		roughness: gb.b,
		valid: gbufferBValid(gb),
	});
});

/** main pass pixel a half-size texel stands for: the one under its centre */
const fullPx = tgpu.fn(
	[d.vec2i],
	d.vec2i,
)((px) => {
	'use gpu';
	const viewport = postUniformLayout.$.post.viewport.xy;
	return std.min(
		d.vec2i(std.mul(std.mul(std.add(d.vec2f(px), d.vec2f(0.5)), viewport), ssrSharedLayout.$.ssr.size.zw)),
		std.sub(d.vec2i(viewport), d.vec2i(1)),
	);
});

const unproject = tgpu.fn(
	[d.vec2f, d.f32],
	d.vec3f,
)((uv, depth) => {
	'use gpu';
	return std.mul(viewRay(uv), viewDepth(depth));
});

const previousUv = tgpu.fn(
	[d.vec3f],
	d.vec2f,
)((rel) => {
	'use gpu';
	const ssr = ssrSharedLayout.$.ssr;
	const clip = std.mul(ssr.previousViewProj, d.vec4f(std.add(rel, ssr.eyeDelta.xyz), 1));
	const ndc = std.div(clip.xy, clip.w);
	return d.vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
});

/** unjittered screen motion (this frame's uv minus last frame's) of the surface under `uv` */
const motionAt = tgpu.fn(
	[d.texture2d(d.f32), d.vec2f],
	d.vec2f,
)((velocityTex, uv) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const ssr = ssrSharedLayout.$.ssr;
	const depth = ssrDeviceDepth(ssrSharedLayout.$.depth, uv);
	if (depth <= 0 || ssr.eyeDelta.w > 0.5) {
		return d.vec2f(0);
	}
	const unjittered = std.add(uv, std.mul(d.vec2f(-post.jitter.x, post.jitter.y), 0.5));
	const px = std.clamp(
		d.vec2i(std.mul(uv, post.viewport.xy)),
		d.vec2i(0),
		std.sub(d.vec2i(post.viewport.xy), d.vec2i(1)),
	);
	const dynDelta = std.textureLoad(velocityTex, px, 0).rg;
	return std.sub(unjittered, std.add(previousUv(unproject(uv, depth)), dynDelta));
});

/** Karis' tonemap-like weighting the game keeps hit colours in until resolve */
const compress = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((c) => {
	'use gpu';
	return std.div(c, std.max(std.max(c.r, c.g), c.b) + 1);
});

const expand = tgpu.fn(
	[d.vec3f],
	d.vec3f,
)((c) => {
	'use gpu';
	return std.div(c, std.max(1 - std.max(std.max(c.r, c.g), c.b), 1e-4));
});

// #region march

const coneEdge = tgpu.fn(
	[d.vec3f, d.vec3f, d.vec3f, d.f32, d.f32],
	d.vec3f,
)((p, v, axis, theta, reach) => {
	'use gpu';
	const away = std.neg(v);
	const turned = std.add(
		std.mix(std.mul(axis, std.dot(axis, away)), away, d.vec3f(std.cos(theta))),
		std.mul(std.cross(axis, away), std.sin(theta)),
	);
	return std.add(p, std.mul(turned, reach));
});

/** ray-march fragment entrypoint: outputs compressed hit colour, temporal/mip weight, fade, and view depth */
export const fsSsrMarch = tgpu.fragmentFn({
	in: { position: d.builtin.position },
	out: {
		color: d.vec4f,
		weight: d.vec4f,
		fade: d.vec4f,
		depth: d.vec4f,
	},
})((input) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	const ssr = ssrSharedLayout.$.ssr;
	const px = d.vec2i(input.position.xy);
	const full = fullPx(px);
	const depth = std.textureLoad(ssrSharedLayout.$.depth, full, 0);
	const outDepth = d.vec4f(std.select(SKY_DEPTH, viewDepth(depth), depth > 0));
	const s = reflectionSurfaceAt(full);
	if (!s.valid || depth <= 0 || ssr.eyeDelta.w > 0.5) {
		return {
			color: d.vec4f(0),
			weight: d.vec4f(0),
			fade: d.vec4f(0),
			depth: outDepth,
		};
	}
	const uv = std.mul(std.add(d.vec2f(full), d.vec2f(0.5)), post.viewport.zw);
	const eye = viewDepth(depth);
	// rough surfaces past 100 m always fade to 0 (`far = clamp((100 - eye) * 0.1, 0, 1)`), so skip marching
	if (s.roughness >= 0.1 && eye >= 100) {
		return {
			color: d.vec4f(0),
			weight: d.vec4f(0),
			fade: d.vec4f(0),
			depth: outDepth,
		};
	}
	const p = unproject(uv, depth);
	const v = std.normalize(p);
	const r = std.reflect(v, s.normal);
	const alpha2 = std.pow(s.roughness, 4);

	const start = d.vec3f(uv, depth);
	let steps = std.max(std.ceil(ssr.march.x * std.clamp(2 * std.exp(-0.07 * eye), 0.125, 1)), 32);
	if (s.roughness >= 0.3) {
		steps *= 0.125;
	}
	const endRel = std.add(p, std.mul(r, eye));
	if (std.dot(endRel, post.forward.xyz) <= post.forward.w) {
		return {
			color: d.vec4f(0),
			weight: d.vec4f(0),
			fade: d.vec4f(0),
			depth: outDepth,
		};
	}
	const end = ssrProject(endRel);
	const march = ssrMarchRay(
		ssrSharedLayout.$.depth,
		start,
		end,
		steps,
		ssr.size.xy,
		std.add(d.vec2f(px), d.vec2f(0.5)),
	);
	const pos = march.position;

	const jitterUv = std.mul(d.vec2f(-post.jitter.x, post.jitter.y), 0.5);
	let hitMotion = d.vec2f(0);
	let source = std.add(uv, jitterUv);
	let outFade = d.vec4f(0);
	if (march.hit) {
		const far = std.select(std.clamp((100 - eye) * 0.1, 0, 1), 1, s.roughness < 0.1);
		outFade = d.vec4f(ssrFade(pos.xy, s.normal, v, ssr.fade.x, ssr.fade.y, ssr.fade.z) * far);
		hitMotion = motionAt(ssrMarchLayout.$.velocity, pos.xy);
		source = std.sub(std.add(pos.xy, jitterUv), hitMotion);
	}
	const outColor = d.vec4f(
		compress(
			std.textureSampleLevel(ssrMarchLayout.$.previousScene, ssrSharedLayout.$.linearSampler, source, 0).rgb,
		),
		0,
	);

	const moved = std.length(
		std.mul(std.add(motionAt(ssrMarchLayout.$.velocity, source), hitMotion), post.viewport.xy),
	);
	const weightX = std.exp(-moved * std.clamp(std.log(0.02 * eye) + 0.01, 0, 1));
	let weightY = d.f32(0);
	if (march.hit && alpha2 > 1e-4) {
		const theta = std.acos(std.pow(0.244, 1 / (2 / alpha2 - 1)));
		const reach = std.distance(unproject(pos.xy, pos.z), p);
		const towardsCamera = std.neg(v);
		const pick = std.select(d.vec3f(1, 0, 0), d.vec3f(0, 0, 1), std.abs(s.normal.z) < 0.999);
		const t = std.normalize(std.cross(pick, s.normal));
		const center = std.mul(ssrProject(std.sub(p, std.mul(towardsCamera, reach))).xy, ssr.size.xy);
		const a = std.mul(
			ssrProject(coneEdge(p, towardsCamera, std.cross(t, towardsCamera), theta, reach)).xy,
			ssr.size.xy,
		);
		const b = std.mul(
			ssrProject(coneEdge(p, towardsCamera, std.cross(std.cross(s.normal, t), towardsCamera), theta, reach))
				.xy,
			ssr.size.xy,
		);
		const ca = std.sub(center, a);
		const cb = std.sub(center, b);
		const footprint = std.sqrt(std.dot(ca, ca) + std.dot(cb, cb)) * 0.5;
		weightY = std.clamp(std.log2(footprint), 0, ssr.march.y) / ssr.march.y;
	}
	return {
		color: outColor,
		weight: d.vec4f(weightX, weightY, 0, 0),
		fade: outFade,
		depth: outDepth,
	};
});

// #endregion

// #region temporal

/** temporal filter fragment entrypoint: YCoCg neighbourhood box clip and blend */
export const fsSsrTemporal = tgpu.fragmentFn({
	in: { position: d.builtin.position },
	out: d.vec4f,
})((input) => {
	'use gpu';
	const ssr = ssrSharedLayout.$.ssr;
	const px = d.vec2i(input.position.xy);
	const maxPx = std.sub(d.vec2i(ssr.size.xy), d.vec2i(1));
	const samples = d.arrayOf(d.vec4f, 9)();
	let sum = d.vec4f(0);
	let squares = d.vec4f(0);
	for (let i = 0; i < 9; i++) {
		const at = std.clamp(std.add(px, d.vec2i((i % 3) - 1, std.intdiv(i, 3) - 1)), d.vec2i(0), maxPx);
		const c = d.vec4f(
			toYcocg(std.textureLoad(ssrTemporalLayout.$.marchColor, at, 0).rgb),
			std.textureLoad(ssrTemporalLayout.$.marchFade, at, 0).r,
		);
		samples[i] = d.vec4f(c);
		sum = std.add(sum, c);
		squares = std.add(squares, std.mul(c, c));
	}
	const plusLo = std.min(
		samples[1],
		std.min(std.min(samples[3], samples[4]), std.min(samples[5], samples[7])),
	);
	const plusHi = std.max(
		samples[1],
		std.max(std.max(samples[3], samples[4]), std.max(samples[5], samples[7])),
	);
	const cornersLo = std.min(std.min(samples[0], samples[2]), std.min(samples[6], samples[8]));
	const cornersHi = std.max(std.max(samples[0], samples[2]), std.max(samples[6], samples[8]));
	const mean = std.div(sum, 9);
	const sigma = std.mul(
		std.sqrt(std.max(std.sub(std.div(squares, 9), std.mul(mean, mean)), d.vec4f(0))),
		1.25,
	);
	const lo = std.min(std.mul(std.add(plusLo, std.min(plusLo, cornersLo)), 0.5), std.sub(mean, sigma));
	const hi = std.max(std.mul(std.add(plusHi, std.max(plusHi, cornersHi)), 0.5), std.add(mean, sigma));

	const current = d.vec4f(
		std.textureLoad(ssrTemporalLayout.$.marchColor, px, 0).rgb,
		std.textureLoad(ssrTemporalLayout.$.marchFade, px, 0).r,
	);
	if (ssr.eyeDelta.w > 0.5) {
		return d.vec4f(std.max(current.rgb, d.vec3f(0.001)), current.a);
	}
	const uv = std.mul(std.add(d.vec2f(px), d.vec2f(0.5)), ssr.size.zw);
	const history = std.textureSampleLevel(
		ssrTemporalLayout.$.history,
		ssrSharedLayout.$.linearSampler,
		std.sub(uv, motionAt(ssrTemporalLayout.$.velocity, uv)),
		0,
	);
	const keep = 0.97 * std.textureLoad(ssrTemporalLayout.$.marchWeight, px, 0).x;
	let color = d.vec3f(0);
	{
		const center = std.mul(std.add(hi.xyz, lo.xyz), 0.5);
		const offset = std.sub(toYcocg(history.rgb), center);
		const units = std.abs(std.div(offset, std.max(std.mul(std.sub(hi.xyz, lo.xyz), 0.5), d.vec3f(1e-7))));
		const reach = std.max(units.x, std.max(units.y, units.z));
		color = fromYcocg(
			std.select(std.add(center, offset), std.add(center, std.div(offset, reach)), reach > 1),
		);
	}
	let fade = d.f32(0);
	{
		const center = (hi.w + lo.w) * 0.5;
		const offset = history.a - center;
		const reach = std.abs(offset / std.max((hi.w - lo.w) * 0.5, 1e-7));
		fade = std.select(history.a, center + offset / reach, reach > 1);
	}
	return d.vec4f(std.max(std.mix(current.rgb, color, keep), d.vec3f(0.001)), std.mix(current.a, fade, keep));
});

// #endregion

// #region pyramid

/** depth-aware 4x4 binomial pyramid downsample fragment entrypoint */
export const fsSsrDownsample = tgpu.fragmentFn({
	in: { position: d.builtin.position },
	out: {
		color: d.vec4f,
		depth: d.vec4f,
	},
})((input) => {
	'use gpu';
	const g = d.vec2i(input.position.xy);
	const fineDims = std.textureDimensions(ssrDownsampleLayout.$.fineDepth);
	const fineSize = d.vec2i(fineDims);
	const maxFine = std.sub(fineSize, d.vec2i(1));
	const base = std.mul(g, 2);
	let nearest = d.f32(SKY_DEPTH);
	{
		const last = d.vec2i(std.intdiv(fineSize.x, 2) - 1, std.intdiv(fineSize.y, 2) - 1);
		const extraX = std.select(0, 1, fineSize.x % 2 === 1 && g.x === last.x);
		const extraY = std.select(0, 1, fineSize.y % 2 === 1 && g.y === last.y);
		for (let y = 0; y <= 1 + extraY; y++) {
			for (let x = 0; x <= 1 + extraX; x++) {
				const dSample = std.textureLoad(
					ssrDownsampleLayout.$.fineDepth,
					std.min(std.add(base, d.vec2i(x, y)), maxFine),
					0,
				).r;
				nearest = std.min(nearest, dSample);
			}
		}
	}
	let color = d.vec4f(0);
	let weight = d.f32(0);
	for (let y = 0; y < 4; y++) {
		for (let x = 0; x < 4; x++) {
			const at = std.clamp(std.add(base, d.vec2i(x - 1, y - 1)), d.vec2i(0), maxFine);
			const fineD = std.textureLoad(ssrDownsampleLayout.$.fineDepth, at, 0).r;
			const w = BINOMIAL.$[x] * BINOMIAL.$[y] * std.exp(-0.01 * std.abs(fineD - nearest));
			color = std.add(color, std.mul(std.textureLoad(ssrDownsampleLayout.$.finePyramid, at, 0), w));
			weight += w;
		}
	}
	return {
		color: std.div(color, std.max(weight, 0.01)),
		depth: d.vec4f(nearest),
	};
});

// #endregion

// #region resolve

const pyramidColor = tgpu.fn(
	[d.vec2f, d.f32, d.f32],
	d.vec3f,
)((px, mipLevel, eye) => {
	'use gpu';
	const ssr = ssrSharedLayout.$.ssr;
	const texel = std.mul(ssr.size.zw, std.exp2(mipLevel));
	const base = std.mul(px, ssr.size.zw);
	// 4 bilinear taps at (±0.75, ±0.75) texels reproduce the 4×4 binomial kernel [0.125, 0.375, 0.375, 0.125]
	// with 4× fewer texture fetches
	const off = std.mul(texel, 0.75);
	let color = d.vec3f(0);
	let weight = d.f32(0);
	for (let y = 0; y < 2; y++) {
		const oy = std.select(-off.y, off.y, y === 1);
		for (let x = 0; x < 2; x++) {
			const ox = std.select(-off.x, off.x, x === 1);
			const at = std.add(base, d.vec2f(ox, oy));
			const depth = std.textureSampleLevel(
				ssrResolveLayout.$.depthPyramid,
				ssrSharedLayout.$.linearSampler,
				at,
				mipLevel,
			).r;
			const w = 0.25 * std.exp(-0.01 * std.abs(depth - eye));
			const sample = std.textureSampleLevel(
				ssrResolveLayout.$.pyramid,
				ssrSharedLayout.$.linearSampler,
				at,
				mipLevel,
			).rgb;
			color = std.add(color, std.mul(sample, w));
			weight += w;
		}
	}
	return std.div(color, std.max(weight, 0.01));
});

/** resolves reflection radiance (rgb) and fade (a) at half size */
export const fsSsrResolve = tgpu.fragmentFn({
	in: { position: d.builtin.position },
	out: d.vec4f,
})((input) => {
	'use gpu';
	const ssr = ssrSharedLayout.$.ssr;
	const px = d.vec2i(input.position.xy);
	const full = fullPx(px);
	const depth = std.textureLoad(ssrSharedLayout.$.depth, full, 0);
	if (depth <= 0) {
		return d.vec4f(0);
	}
	const uv = std.mul(std.add(d.vec2f(px), d.vec2f(0.5)), ssr.size.zw);
	const mipLevel = std.textureLoad(ssrResolveLayout.$.marchWeight, px, 0).y * ssr.march.y;
	const lower = std.floor(mipLevel);
	const fade = std.textureSampleLevel(
		ssrResolveLayout.$.pyramid,
		ssrSharedLayout.$.linearSampler,
		uv,
		lower,
	).a;
	if (fade <= 0.001) {
		return d.vec4f(0);
	}
	let color = d.vec3f(0);
	if (mipLevel < 0.25) {
		color = std.textureLoad(ssrResolveLayout.$.pyramid, px, 0).rgb;
	} else {
		const eye = viewDepth(depth);
		const frac = mipLevel - lower;
		const upper = std.clamp(lower + 1, 0, ssr.march.y);
		const lowColor = pyramidColor(d.vec2f(px), lower, eye);
		if (frac < 0.01 || upper === lower) {
			color = lowColor;
		} else {
			color = std.mix(lowColor, pyramidColor(d.vec2f(px), upper, eye), frac);
		}
	}
	return d.vec4f(expand(color), fade);
});

// #endregion
