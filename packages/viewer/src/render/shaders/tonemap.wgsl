// the last pass: exposure, bloom, vignette, colour grading, tonemapping and display encoding into the
// swapchain. needs post-common.wgsl.
//
// the grading and curve are the game's (its LUT builder under TONEMAPPING_ACES_MODIFIED): URP's grading in
// ACEScg with a luminance contrast, then a rational fit of ACES. the game bakes them into a 32³ LogC LUT; here
// they run per pixel, with the colour curves left out (the package doesn't carry them; neutral curves cancel).
// see docs/game-data/post-processing.md#colour-grading-and-tonemapping. matrices multiply row vectors
// (`v * m` dots v with each column).

@group(1) @binding(0) var scene_texture: texture_2d<f32>;
@group(1) @binding(1) var bloom_texture: texture_2d<f32>;
@group(1) @binding(2) var bilinear: sampler;

const LIN_TO_LMS = mat3x3f(
	vec3f(0.390405, 0.549941, 0.00892632),
	vec3f(0.0708416, 0.963172, 0.00135775),
	vec3f(0.0231082, 0.128021, 0.936245),
);
const LMS_TO_LIN = mat3x3f(
	vec3f(2.85847, -1.62879, -0.024891),
	vec3f(-0.210182, 1.1582, 0.000324281),
	vec3f(-0.041812, -0.118169, 1.06867),
);
const SRGB_TO_AP0 = mat3x3f(
	vec3f(0.439701, 0.382978, 0.177335),
	vec3f(0.0897923, 0.813423, 0.0967616),
	vec3f(0.017544, 0.111544, 0.870704),
);
const AP0_TO_AP1 = mat3x3f(
	vec3f(1.4514393, -0.23651075, -0.21492857),
	vec3f(-0.07655377, 1.1762297, -0.09967592),
	vec3f(0.00831615, -0.00603245, 0.9977163),
);
const AP1_TO_SRGB = mat3x3f(
	vec3f(1.7050515, -0.6217907, -0.08325868),
	vec3f(-0.13025714, 1.1408029, -0.01054819),
	vec3f(-0.02400327, -0.12896878, 1.1529716),
);
const AP1_LUMINANCE = vec3f(0.272229, 0.674082, 0.0536895);
// the LUT's LogC encoding saturates here (linear)
const LUT_MAX = 58.85;

// Adobe's soft light, as URP's split toning blends
fn soft_light(base: vec3f, blend: vec3f) -> vec3f {
	let r1 = 2.0 * base * blend + base * base * (1.0 - 2.0 * blend);
	let r2 = sqrt(base) * (2.0 * blend - 1.0) + 2.0 * base * (1.0 - blend);
	return select(r1, r2, blend >= vec3f(0.5));
}

fn rgb_to_hsv(c: vec3f) -> vec3f {
	let k = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
	let p = mix(vec4f(c.bg, k.wz), vec4f(c.gb, k.xy), step(c.b, c.g));
	let q = mix(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), step(p.x, c.r));
	let d = q.x - min(q.w, q.y);
	let e = 1e-4;
	return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

fn hsv_to_rgb(c: vec3f) -> vec3f {
	let k = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
	let p = abs(fract(c.xxx + k.xyz) * 6.0 - k.www);
	return c.z * mix(k.xxx, clamp(p - k.xxx, vec3f(0.0), vec3f(1.0)), c.y);
}

// linear sRGB in, graded ACEScg out (≥ 0)
fn grade(linear: vec3f) -> vec3f {
	// white balance in LMS, then into ACEScg
	var c = (linear * LIN_TO_LMS) * post.color_balance.xyz;
	c = ((c * LMS_TO_LIN) * SRGB_TO_AP0) * AP0_TO_AP1;
	// HG's contrast: a power of luminance around 0.18
	c *= pow(max(dot(c, AP1_LUMINANCE), 1e-6) / 0.18, post.hue_sat_con.z - 1.0);
	c = max(vec3f(0.0), c * post.color_filter.xyz);
	// split toning in gamma space
	{
		var g = pow(c, vec3f(1.0 / 2.2));
		let t = clamp(dot(clamp(g, vec3f(0.0), vec3f(1.0)), AP1_LUMINANCE) + post.split_shadows.w, 0.0, 1.0);
		g = soft_light(g, mix(vec3f(0.5), post.split_shadows.xyz, 1.0 - t));
		g = soft_light(g, mix(vec3f(0.5), post.split_highlights.xyz, t));
		c = pow(abs(g), vec3f(2.2));
	}
	c = vec3f(dot(c, post.mixer_red.xyz), dot(c, post.mixer_green.xyz), dot(c, post.mixer_blue.xyz));
	// shadows, midtones, highlights
	{
		let luma = dot(c, AP1_LUMINANCE);
		let s = smoothstep(post.sha_hi_limits.x, post.sha_hi_limits.y, luma);
		let h = smoothstep(post.sha_hi_limits.z, post.sha_hi_limits.w, luma);
		c = c * post.shadows.xyz * (1.0 - s) + c * post.midtones.xyz * (s - h) + c * post.highlights.xyz * h;
	}
	// lift, gamma, gain
	c = c * post.gain.xyz + post.lift.xyz;
	c = sign(c) * pow(abs(c), post.gamma.xyz);
	// hue shift and saturation
	{
		var hsv = rgb_to_hsv(c);
		hsv.x = fract(hsv.x + post.hue_sat_con.x);
		c = hsv_to_rgb(hsv);
		let luma = dot(c, AP1_LUMINANCE);
		c = luma + post.hue_sat_con.y * (c - luma);
	}
	// neutral curves pass the colour through, minus negatives
	return max(c, vec3f(0.0));
}

// the game's modified ACES: graded ACEScg in, display-linear sRGB out
fn aces_modified(x: vec3f) -> vec3f {
	let fit = x * (x * 2.785085 + 0.107772) * clamp(1.0 / (x * (x * 2.936045 + 0.887122) + 0.806889), vec3f(1e-4), vec3f(1e4));
	var y = clamp(fit, vec3f(0.0), vec3f(1.0));
	y = mix(vec3f(dot(y, AP1_LUMINANCE)), y, 0.93) * AP1_TO_SRGB;
	// bright colours blend towards their hue at full brightness
	let peak = clamp(y / max(max(max(y.r, y.g), y.b), 1e-5), vec3f(0.0), vec3f(1.0));
	let blend = clamp((dot(x, AP1_LUMINANCE) - 0.5) * (2.0 / 3.0), 0.0, 1.0);
	return clamp(mix(y, peak, blend), vec3f(0.0), vec3f(1.0));
}

// Khronos PBR Neutral
fn pbr_neutral(color: vec3f) -> vec3f {
	let start = 0.8 - 0.04;
	let desaturation = 0.15;
	let x = min(color.r, min(color.g, color.b));
	let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
	var c = color - offset;
	let peak = max(c.r, max(c.g, c.b));
	if (peak < start) {
		return c;
	}
	let d = 1.0 - start;
	let new_peak = 1.0 - d * d / (peak + d - start);
	c *= new_peak / peak;
	let g = 1.0 - 1.0 / (desaturation * (peak - new_peak) + 1.0);
	return mix(c, vec3f(new_peak), g);
}

fn srgb_encode(c: vec3f) -> vec3f {
	let low = c * 12.92;
	let high = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
	return select(high, low, c <= vec3f(0.0031308));
}

@fragment
fn fs_tonemap(in: FullscreenOut) -> @location(0) vec4f {
	let px = vec2i(in.position.xy);
	var color = textureLoad(scene_texture, px, 0).rgb;
	color *= post.grade.x;
	// the game's composite: adds the bloom scaled by its intensity; blend modes other than add take the
	// scene's above-threshold part out by the same factor, add mode compresses bloom past 0.3 instead
	if (post.flags.w != 0u) {
		let subtract = post.bloom_shape.x;
		let brightness = max(color.r, max(color.g, color.b));
		let soft = clamp(brightness - post.bloom.y, 0.0, post.bloom.z);
		let above = color * max(post.bloom.w * soft * soft, brightness - post.bloom.x) / max(brightness, 1e-4);
		var bloom = textureSampleLevel(bloom_texture, bilinear, in.uv, 0.0).rgb;
		let compressed = pow(bloom, vec3f(0.33)) * 1.4938 - 0.7;
		bloom = select(bloom, compressed, bloom * (1.0 - subtract) > vec3f(0.3));
		color += (bloom * post.bloom_tint.rgb - above * subtract) * post.bloom_tint.w;
	}
	// URP's vignette, in HDR before grading as the game's uber pass applies it
	if (post.grade.y > 0.0) {
		var d = abs(in.uv - post.vignette_center.xy) * post.grade.y * 3.0;
		if (post.vignette_center.z > 0.5) {
			d.x *= post.viewport.x * post.viewport.w;
		}
		let roundness = (1.0 - post.vignette_color.w) * 6.0 + post.vignette_color.w;
		d = pow(clamp(d, vec2f(0.0), vec2f(1.0)), vec2f(roundness));
		let factor = pow(clamp(1.0 - dot(d, d), 0.0, 1.0), post.grade.z * 5.0);
		color *= mix(post.vignette_color.rgb, vec3f(1.0), factor);
	}
	switch u32(post.grade.w) {
		case 0u: {
			color = aces_modified(grade(clamp(color * post.color_balance.w, vec3f(0.0), vec3f(LUT_MAX))));
		}
		case 1u: {
			let graded = grade(clamp(color * post.color_balance.w, vec3f(0.0), vec3f(LUT_MAX)));
			color = pbr_neutral(max(graded * AP1_TO_SRGB, vec3f(0.0)));
		}
		default: {
			color = clamp(color, vec3f(0.0), vec3f(1.0));
		}
	}
	// ±half a step of dither against banding in the sky
	let noise = (ign(in.position.xy + post.eye.w * 5.588238) - 0.5) / 255.0;
	return vec4f(srgb_encode(color) + noise, 1.0);
}
