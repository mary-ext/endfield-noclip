// screen-space reflections: glossy surfaces march their mirror ray through the depth buffer, and where it hits
// something on screen, that radiance replaces the sky reflection the main pass gave them. writes the change to
// add to the radiance (composite adds it before occlusion and fog). needs post-common.wgsl.

@group(1) @binding(0) var radiance_texture: texture_2d<f32>;
@group(1) @binding(1) var reflection_texture: texture_2d<f32>;
@group(1) @binding(2) var reflection_normal_texture: texture_2d<f32>;
@group(1) @binding(3) var depth_texture: texture_depth_2d;

const SSR_STEPS = 48u;
const SSR_REFINE = 5u;
// the first step (m) and how much each step grows, which reach ~190 m together
const SSR_FIRST_STEP = 0.15;
const SSR_STEP_GROWTH = 1.09;
// a hit must lie within this much of the depth buffer's surface: a fixed part plus a share of the step
const SSR_THICKNESS = 0.3;
// rays fade out within this fraction of the screen edge
const SSR_EDGE_FADE = 0.08;

fn oct_decode_unit(e: vec2f) -> vec3f {
	var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
	if (n.z < 0.0) {
		let s = select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
		n = vec3f((1.0 - abs(n.yx)) * s, n.z);
	}
	return normalize(n);
}

struct Projected {
	// uv of the main pass's (jittered) targets
	uv: vec2f,
	// view depth along the forward axis (m)
	depth: f32,
}

// a camera-relative position on the main pass's targets
fn project(rel: vec3f) -> Projected {
	let d = dot(rel, post.forward.xyz);
	let right = post.right.xyz;
	let up = post.up.xyz;
	let ndc = vec2f(dot(rel, right) / dot(right, right), dot(rel, up) / dot(up, up)) / d + post.jitter.xy;
	return Projected(vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5), d);
}

// the scene's view depth under a uv, or 0 where nothing was drawn (sky)
fn scene_depth(uv: vec2f) -> f32 {
	let px = vec2i(uv * post.viewport.xy);
	let depth = textureLoad(depth_texture, px, 0);
	if (depth <= 0.0) {
		return 0.0;
	}
	return view_depth(depth);
}

@fragment
fn fs_ssr(in: FullscreenOut) -> @location(0) vec4f {
	let px = vec2i(in.position.xy);
	let reflection = textureLoad(reflection_texture, px, 0);
	if (post.reflections.x < 0.5 || reflection.a <= 0.0) {
		return vec4f(0.0);
	}
	let depth = textureLoad(depth_texture, px, 0);
	if (depth <= 0.0) {
		return vec4f(0.0);
	}
	let packed = textureLoad(reflection_normal_texture, px, 0);
	let n = oct_decode_unit(packed.xy * 2.0 - 1.0);
	let ray = view_ray(in.uv);
	let rel = ray * view_depth(depth);
	let v = -normalize(rel);
	let r = reflect(-v, n);
	// rays towards the camera leave the screen through surfaces the depth buffer can't see behind
	let facing = smoothstep(-0.1, 0.2, dot(r, post.forward.xyz));
	if (facing <= 0.0) {
		return vec4f(0.0);
	}

	// march along the ray with growing steps, from a per-pixel offset that the temporal resolve averages out
	// off the surface by two pixels' footprint, so the ray doesn't hit where it starts
	let start = rel + n * 2.0 * length(rel) / post.right.w;
	var step = SSR_FIRST_STEP * (0.5 + ign(in.position.xy + f32(u32(post.eye.w) % 8u) * 5.588238));
	var t = 0.0;
	var previous = 0.0;
	var hit = false;
	var hit_uv = vec2f(0.0);
	for (var i = 0u; i < SSR_STEPS; i++) {
		previous = t;
		t += step;
		let p = project(start + r * t);
		if (p.depth <= post.forward.w || any(p.uv < vec2f(0.0)) || any(p.uv > vec2f(1.0))) {
			break;
		}
		let surface = scene_depth(p.uv);
		let behind = p.depth - surface;
		if (surface > 0.0 && behind > 0.0) {
			if (behind < SSR_THICKNESS + step) {
				hit = true;
			}
			break;
		}
		step *= SSR_STEP_GROWTH;
	}
	if (!hit) {
		return vec4f(0.0);
	}
	// binary search between the last step in front and the first behind
	var lo = previous;
	var hi = t;
	for (var i = 0u; i < SSR_REFINE; i++) {
		let mid = 0.5 * (lo + hi);
		let p = project(start + r * mid);
		let surface = scene_depth(p.uv);
		if (surface > 0.0 && p.depth > surface) {
			hi = mid;
		} else {
			lo = mid;
		}
	}
	let p = project(start + r * hi);
	let surface = scene_depth(p.uv);
	if (surface <= 0.0 || abs(p.depth - surface) > SSR_THICKNESS + (hi - lo) * 4.0 + 0.02 * surface) {
		return vec4f(0.0);
	}
	let edge = min(p.uv, 1.0 - p.uv) / SSR_EDGE_FADE;
	let confidence = facing * clamp(min(edge.x, edge.y), 0.0, 1.0);
	let hit_radiance = textureLoad(radiance_texture, vec2i(p.uv * post.viewport.xy), 0).rgb;
	return vec4f((hit_radiance * reflection.a - reflection.rgb) * confidence, 0.0);
}
