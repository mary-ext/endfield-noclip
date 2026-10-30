// temporal antialiasing with upsampling (TAAU), in place of MSAA as in the game. the main pass renders one
// jittered sample per pixel at the render size; each output pixel reconstructs the current frame from the 3×3
// samples around it, reprojects last frame's output through the depth buffer (the scenery is static, so the
// camera's motion is all the motion there is), clips that history to the current neighbourhood and blends.
// needs post-common.wgsl.

struct Taa {
	// last frame's camera-relative view-projection, unjittered
	previous_view_proj: mat4x4f,
	// this frame's eye minus last frame's (m); w = 1 to drop the history (first frame, resize, cut)
	eye_delta: vec4f,
	// the main pass's size: width, height, 1 / width, 1 / height (px)
	input: vec4f,
	// x = the new frame's weight in the blend, y = 1 to pass the current frame through without history, zw unused
	params: vec4f,
}

@group(1) @binding(0) var<uniform> taa: Taa;
@group(1) @binding(1) var current_texture: texture_2d<f32>;
@group(1) @binding(2) var depth_texture: texture_depth_2d;
@group(1) @binding(3) var history_texture: texture_2d<f32>;
@group(1) @binding(4) var linear_sampler: sampler;

// how far out the reconstruction filter reaches: a Gaussian fit to Blackman-Harris over output pixels
const FILTER = 2.29;
// the clipping box's half size in standard deviations of the neighbourhood
const CLIP_SIGMA = 1.25;

fn to_ycocg(c: vec3f) -> vec3f {
	return vec3f(dot(c, vec3f(0.25, 0.5, 0.25)), dot(c, vec3f(0.5, 0.0, -0.5)), dot(c, vec3f(-0.25, 0.5, -0.25)));
}

fn from_ycocg(c: vec3f) -> vec3f {
	return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

// HDR samples weighted down by their brightness at the shown exposure, so a lone bright sample can't dominate the
// filters and flicker (Karis); `expand` undoes it
fn compress(c: vec3f) -> vec3f {
	return c / (1.0 + luminance(c) * post.grade.x);
}

fn expand(c: vec3f) -> vec3f {
	return c / max(1.0 - luminance(c) * post.grade.x, 1e-4);
}

// the history at `uv` through a Catmull-Rom filter, from five bilinear taps (the corners' weights are dropped)
fn sample_history(uv: vec2f) -> vec3f {
	let size = vec2f(textureDimensions(history_texture));
	let p = uv * size;
	let t1 = floor(p - 0.5) + 0.5;
	let f = p - t1;
	let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
	let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
	let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
	let w3 = f * f * (-0.5 + 0.5 * f);
	let w12 = w1 + w2;
	let t0 = (t1 - 1.0) / size;
	let t3 = (t1 + 2.0) / size;
	let t12 = (t1 + w2 / w12) / size;
	var sum = textureSampleLevel(history_texture, linear_sampler, vec2f(t12.x, t0.y), 0.0).rgb * (w12.x * w0.y);
	sum += textureSampleLevel(history_texture, linear_sampler, vec2f(t0.x, t12.y), 0.0).rgb * (w0.x * w12.y);
	sum += textureSampleLevel(history_texture, linear_sampler, t12, 0.0).rgb * (w12.x * w12.y);
	sum += textureSampleLevel(history_texture, linear_sampler, vec2f(t3.x, t12.y), 0.0).rgb * (w3.x * w12.y);
	sum += textureSampleLevel(history_texture, linear_sampler, vec2f(t12.x, t3.y), 0.0).rgb * (w12.x * w3.y);
	let weight = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
	return max(sum / weight, vec3f(0.0));
}

// moves `c` towards the box's centre until it lies inside (Playdead's clip, gentler on colour than a clamp)
fn clip_to_box(c: vec3f, lo: vec3f, hi: vec3f) -> vec3f {
	let centre = 0.5 * (lo + hi);
	let extent = 0.5 * (hi - lo) + 1e-5;
	let offset = c - centre;
	let units = abs(offset / extent);
	let reach = max(units.x, max(units.y, units.z));
	return select(c, centre + offset / reach, reach > 1.0);
}

@fragment
fn fs_taa(in: FullscreenOut) -> @location(0) vec4f {
	if (taa.params.y > 0.5) {
		return vec4f(textureSampleLevel(current_texture, linear_sampler, in.uv, 0.0).rgb, 1.0);
	}
	// this output pixel's centre in the jittered main-pass image, in its pixels
	let p = (in.uv + vec2f(post.jitter.x, -post.jitter.y) * 0.5) * taa.input.xy;
	let size = vec2i(taa.input.xy);
	let centre = vec2i(floor(p));
	// output pixels per main-pass pixel
	let ratio = vec2f(textureDimensions(history_texture)) * taa.input.zw;

	var sum = vec3f(0.0);
	var weight = 0.0;
	var nearest_weight = 0.0;
	var m1 = vec3f(0.0);
	var m2 = vec3f(0.0);
	var lo = vec3f(1e9);
	var hi = vec3f(-1e9);
	var nearest_depth = 0.0;
	for (var y = -1; y <= 1; y++) {
		for (var x = -1; x <= 1; x++) {
			let px = clamp(centre + vec2i(x, y), vec2i(0), size - 1);
			let c = compress(max(textureLoad(current_texture, px, 0).rgb, vec3f(0.0)));
			let d = (vec2f(px) + 0.5 - p) * ratio;
			let w = exp(-FILTER * dot(d, d));
			sum += c * w;
			weight += w;
			nearest_weight = max(nearest_weight, w);
			let ycocg = to_ycocg(c);
			m1 += ycocg;
			m2 += ycocg * ycocg;
			lo = min(lo, ycocg);
			hi = max(hi, ycocg);
			// reversed-Z: the largest depth is the nearest surface
			nearest_depth = max(nearest_depth, textureLoad(depth_texture, px, 0));
		}
	}
	let current = sum / max(weight, 1e-6);

	// reproject through the nearest depth around the pixel, so the history follows the edges of what's in front
	let ndc = vec2f(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
	var previous_clip: vec4f;
	if (nearest_depth <= 0.0) {
		// the sky: a direction, which the camera's translation doesn't move
		previous_clip = taa.previous_view_proj * vec4f(view_ray_ndc(ndc), 0.0);
	} else {
		let rel = view_ray_ndc(ndc) * view_depth(nearest_depth);
		previous_clip = taa.previous_view_proj * vec4f(rel + taa.eye_delta.xyz, 1.0);
	}
	let previous_ndc = previous_clip.xy / previous_clip.w;
	let previous_uv = vec2f(previous_ndc.x * 0.5 + 0.5, 0.5 - previous_ndc.y * 0.5);
	let offscreen = any(previous_uv < vec2f(0.0)) || any(previous_uv > vec2f(1.0));
	if (taa.eye_delta.w > 0.5 || previous_clip.w <= 0.0 || offscreen) {
		return vec4f(expand(current), 1.0);
	}

	let mean = m1 / 9.0;
	let sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3f(0.0)));
	let box_lo = max(lo, mean - CLIP_SIGMA * sigma);
	let box_hi = min(hi, mean + CLIP_SIGMA * sigma);
	let history = from_ycocg(clip_to_box(to_ycocg(compress(sample_history(previous_uv))), box_lo, box_hi));
	// when upsampling, the frame counts for less where none of its samples lands near the pixel; normalised so
	// that without upsampling, the nearest sample always gets the full weight (it's at most half a pixel away
	// along each axis)
	let confidence = saturate(nearest_weight / exp(-FILTER * 0.5));
	let blend = taa.params.x * confidence;
	return vec4f(expand(mix(history, current, blend)), 1.0);
}
