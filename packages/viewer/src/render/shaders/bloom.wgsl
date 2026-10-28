// bloom over a mip chain: a thresholded 13-tap downsample (Jimenez, "Next Generation Post Processing in Call
// of Duty"), further downsamples, then tent-filtered upsamples blended by the scatter factor, like URP's
// bloom that the game's settings follow. needs post-common.wgsl.

struct BloomPass {
	// texel size of the source
	texel: vec2f,
	// 1 on the first downsample: threshold and average by luma against fireflies
	first: f32,
	unused: f32,
}

@group(1) @binding(0) var source: texture_2d<f32>;
@group(1) @binding(1) var bilinear: sampler;
@group(1) @binding(2) var<uniform> pass_info: BloomPass;
// upsamples: the matching level of the downsample chain
@group(1) @binding(3) var high: texture_2d<f32>;

fn tap(uv: vec2f, offset: vec2f) -> vec3f {
	return textureSampleLevel(source, bilinear, uv + offset * pass_info.texel, 0.0).rgb;
}

fn threshold(c: vec3f) -> vec3f {
	let t = post.bloom.x;
	let knee = post.bloom.y;
	let brightness = max(c.r, max(c.g, c.b));
	var soft = clamp(brightness - t + knee, 0.0, 2.0 * knee);
	soft = soft * soft / (4.0 * knee + 1e-4);
	let multiplier = max(brightness - t, soft) / max(brightness, 1e-4);
	return c * multiplier;
}

fn karis(c: vec3f) -> f32 {
	return 1.0 / (1.0 + luminance(c));
}

@fragment
fn fs_down(in: FullscreenOut) -> @location(0) vec4f {
	let uv = in.uv;
	let a = tap(uv, vec2f(-2.0, -2.0));
	let b = tap(uv, vec2f(0.0, -2.0));
	let c = tap(uv, vec2f(2.0, -2.0));
	let d = tap(uv, vec2f(-1.0, -1.0));
	let e = tap(uv, vec2f(1.0, -1.0));
	let f = tap(uv, vec2f(-2.0, 0.0));
	let g = tap(uv, vec2f(0.0, 0.0));
	let h = tap(uv, vec2f(2.0, 0.0));
	let i = tap(uv, vec2f(-1.0, 1.0));
	let j = tap(uv, vec2f(1.0, 1.0));
	let k = tap(uv, vec2f(-2.0, 2.0));
	let l = tap(uv, vec2f(0.0, 2.0));
	let m = tap(uv, vec2f(2.0, 2.0));
	var result: vec3f;
	if (pass_info.first > 0.5) {
		// five 2×2 groups, each weighted by its inverse luma
		let g0 = (d + e + i + j) * 0.25;
		let g1 = (a + b + f + g) * 0.25;
		let g2 = (b + c + g + h) * 0.25;
		let g3 = (f + g + k + l) * 0.25;
		let g4 = (g + h + l + m) * 0.25;
		let w0 = karis(g0) * 0.5;
		let w1 = karis(g1) * 0.125;
		let w2 = karis(g2) * 0.125;
		let w3 = karis(g3) * 0.125;
		let w4 = karis(g4) * 0.125;
		result = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
		result = threshold(min(result, vec3f(60000.0)));
	} else {
		result = (d + e + i + j) * 0.125;
		result += (a + b + f + g) * 0.03125;
		result += (b + c + g + h) * 0.03125;
		result += (f + g + k + l) * 0.03125;
		result += (g + h + l + m) * 0.03125;
	}
	return vec4f(result, 1.0);
}

@fragment
fn fs_up(in: FullscreenOut) -> @location(0) vec4f {
	let uv = in.uv;
	// 3×3 tent over the coarser level
	var low = tap(uv, vec2f(0.0, 0.0)) * 4.0;
	low += (tap(uv, vec2f(-1.0, 0.0)) + tap(uv, vec2f(1.0, 0.0)) + tap(uv, vec2f(0.0, -1.0)) + tap(uv, vec2f(0.0, 1.0))) * 2.0;
	low += tap(uv, vec2f(-1.0, -1.0)) + tap(uv, vec2f(1.0, -1.0)) + tap(uv, vec2f(-1.0, 1.0)) + tap(uv, vec2f(1.0, 1.0));
	low /= 16.0;
	let near = textureSampleLevel(high, bilinear, uv, 0.0).rgb;
	return vec4f(mix(near, low, post.bloom.w), 1.0);
}
