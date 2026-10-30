// the game's bloom: a thresholded prefilter into the first level, a separable Gaussian per further level (each
// halving the size), then bicubic upsamples blended towards the coarser level by the scatter factor. needs
// post-common.wgsl.

struct BloomPass {
	// texel size of the source
	texel: vec2f,
	// upsamples: size of the coarser level in texels
	low_size: vec2f,
}

@group(1) @binding(0) var source: texture_2d<f32>;
@group(1) @binding(1) var bilinear: sampler;
@group(1) @binding(2) var<uniform> pass_info: BloomPass;
// upsamples: the matching level of the downsample chain
@group(1) @binding(3) var high: texture_2d<f32>;

fn tap(uv: vec2f, offset: vec2f) -> vec3f {
	return textureSampleLevel(source, bilinear, uv + offset * pass_info.texel, 0.0).rgb;
}

// the exposed colour above the threshold, with a quadratic knee
fn thresholded(uv: vec2f, offset: vec2f) -> vec3f {
	let c = tap(uv, offset);
	let brightness = max(c.r, max(c.g, c.b));
	let soft = clamp(brightness - post.bloom.y, 0.0, post.bloom.z);
	let multiplier = max(post.bloom.w * soft * soft, brightness - post.bloom.x) / max(brightness, 1e-4);
	return c * multiplier * post.grade.x;
}

// five taps around the centre, each weighted by its inverse luma against fireflies
@fragment
fn fs_prefilter(in: FullscreenOut) -> @location(0) vec4f {
	let offsets = array<vec2f, 5>(
		vec2f(0.0, 0.0),
		vec2f(0.9, -0.4),
		vec2f(-0.9, 0.4),
		vec2f(0.4, 0.9),
		vec2f(-0.4, -0.9),
	);
	var sum = vec3f(0.0);
	var weights = 0.0;
	for (var i = 0; i < 5; i++) {
		let c = thresholded(in.uv, offsets[i]);
		let w = 1.0 / (luminance(c) + 1.0);
		sum += c * w;
		weights += w;
	}
	return vec4f(sum / weights, 1.0);
}

// nine taps two source texels apart, into a target half the source's width
@fragment
fn fs_blur_h(in: FullscreenOut) -> @location(0) vec4f {
	var c = tap(in.uv, vec2f(0.0, 0.0)) * 0.22702703;
	c += (tap(in.uv, vec2f(-2.0, 0.0)) + tap(in.uv, vec2f(2.0, 0.0))) * 0.19459459;
	c += (tap(in.uv, vec2f(-4.0, 0.0)) + tap(in.uv, vec2f(4.0, 0.0))) * 0.12162162;
	c += (tap(in.uv, vec2f(-6.0, 0.0)) + tap(in.uv, vec2f(6.0, 0.0))) * 0.05405405;
	c += (tap(in.uv, vec2f(-8.0, 0.0)) + tap(in.uv, vec2f(8.0, 0.0))) * 0.01621622;
	return vec4f(c, 1.0);
}

// the same Gaussian in five bilinear taps
@fragment
fn fs_blur_v(in: FullscreenOut) -> @location(0) vec4f {
	var c = tap(in.uv, vec2f(0.0, 0.0)) * 0.22702703;
	c += (tap(in.uv, vec2f(0.0, -1.38461538)) + tap(in.uv, vec2f(0.0, 1.38461538))) * 0.31621622;
	c += (tap(in.uv, vec2f(0.0, -3.23076923)) + tap(in.uv, vec2f(0.0, 3.23076923))) * 0.07027027;
	return vec4f(c, 1.0);
}

// cubic B-spline over the coarser level in four bilinear taps
fn bicubic(uv: vec2f) -> vec3f {
	let p = uv * pass_info.low_size + 0.5;
	let i = floor(p);
	let f = fract(p);
	let w0 = (1.0 / 6.0) + f * (-0.5 + f * (0.5 - f * (1.0 / 6.0)));
	let w1 = (2.0 / 3.0) + f * f * (-1.0 + 0.5 * f);
	let w2 = (1.0 / 6.0) + f * (0.5 + f * (0.5 - 0.5 * f));
	let w3 = f * f * f * (1.0 / 6.0);
	let g0 = w0 + w1;
	let g1 = w2 + w3;
	let h0 = -1.0 + w1 / g0;
	let h1 = 1.0 + w3 / g1;
	let texel = 1.0 / pass_info.low_size;
	let s = textureSampleLevel(source, bilinear, (i + vec2f(h0.x, h0.y) - 0.5) * texel, 0.0).rgb * g0.x
		+ textureSampleLevel(source, bilinear, (i + vec2f(h1.x, h0.y) - 0.5) * texel, 0.0).rgb * g1.x;
	let t = textureSampleLevel(source, bilinear, (i + vec2f(h0.x, h1.y) - 0.5) * texel, 0.0).rgb * g0.x
		+ textureSampleLevel(source, bilinear, (i + vec2f(h1.x, h1.y) - 0.5) * texel, 0.0).rgb * g1.x;
	return s * g0.y + t * g1.y;
}

@fragment
fn fs_up(in: FullscreenOut) -> @location(0) vec4f {
	let near = textureSampleLevel(high, bilinear, in.uv, 0.0).rgb;
	return vec4f(mix(near, bicubic(in.uv), post.bloom_shape.y), 1.0);
}
