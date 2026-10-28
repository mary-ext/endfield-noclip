// the last pass: exposure, bloom, tonemapping, vignette and display encoding into the swapchain. needs
// post-common.wgsl.

@group(1) @binding(0) var scene_texture: texture_2d<f32>;
@group(1) @binding(1) var bloom_texture: texture_2d<f32>;
@group(1) @binding(2) var bilinear: sampler;

// Hill's fit of the ACES reference rendering and output transforms
fn aces_fitted(colour: vec3f) -> vec3f {
	let input = mat3x3f(
		vec3f(0.59719, 0.07600, 0.02840),
		vec3f(0.35458, 0.90834, 0.13383),
		vec3f(0.04823, 0.01566, 0.83777),
	);
	let output = mat3x3f(
		vec3f(1.60475, -0.10208, -0.00327),
		vec3f(-0.53108, 1.10813, -0.07276),
		vec3f(-0.07367, -0.00605, 1.07602),
	);
	let v = input * colour;
	let a = v * (v + 0.0245786) - 0.000090537;
	let b = v * (0.983729 * v + 0.4329510) + 0.238081;
	return clamp(output * (a / b), vec3f(0.0), vec3f(1.0));
}

// Khronos PBR Neutral
fn neutral(colour: vec3f) -> vec3f {
	let start = 0.8 - 0.04;
	let desaturation = 0.15;
	let x = min(colour.r, min(colour.g, colour.b));
	let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
	var c = colour - offset;
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
	var colour = textureLoad(scene_texture, px, 0).rgb;
	if (post.flags.w != 0u) {
		let bloom = textureSampleLevel(bloom_texture, bilinear, in.uv, 0.0).rgb;
		colour += bloom * post.bloom.z * post.bloom_tint.rgb;
	}
	colour *= post.grade.x;
	switch u32(post.grade.w) {
		case 0u: {
			colour = aces_fitted(colour);
		}
		case 1u: {
			colour = neutral(colour);
		}
		default: {
			colour = clamp(colour, vec3f(0.0), vec3f(1.0));
		}
	}
	// URP's vignette
	if (post.grade.y > 0.0) {
		var d = abs(in.uv - post.vignette_centre.xy) * post.grade.y * 3.0;
		if (post.vignette_centre.z > 0.5) {
			d.x *= post.viewport.x * post.viewport.w;
		}
		let roundness = (1.0 - post.vignette_colour.w) * 6.0 + post.vignette_colour.w;
		d = pow(clamp(d, vec2f(0.0), vec2f(1.0)), vec2f(roundness));
		let factor = pow(clamp(1.0 - dot(d, d), 0.0, 1.0), post.grade.z * 5.0);
		colour *= mix(post.vignette_colour.rgb, vec3f(1.0), factor);
	}
	// ±half a step of dither against banding in the sky
	let noise = (ign(in.position.xy + post.eye.w * 5.588238) - 0.5) / 255.0;
	return vec4f(srgb_encode(colour) + noise, 1.0);
}
