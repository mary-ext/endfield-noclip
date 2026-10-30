// the water pass's reflection march (the viewer's own, not the game's ssr.wgsl): a mirror ray steps through the
// depth buffer until it passes behind something drawn. needs post-common.wgsl and a `depth_texture` (the main
// pass's depth) declared by the pass.

const SSR_STEPS = 48u;
const SSR_REFINE = 5u;
// the first step (m) and how much each step grows, which reach ~190 m together
const SSR_FIRST_STEP = 0.15;
const SSR_STEP_GROWTH = 1.09;
// a hit must lie within this much of the depth buffer's surface: a fixed part plus a share of the step
const SSR_THICKNESS = 0.3;
// rays fade out within this fraction of the screen edge
const SSR_EDGE_FADE = 0.08;

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

struct SsrHit {
	// where the ray hit, on the main pass's targets
	uv: vec2f,
	// 0 for a miss, fading towards the screen's edges and for rays turning towards the camera
	confidence: f32,
}

// marches the unit ray `r` from the camera-relative `start` (already pushed off its surface); `px` seeds the
// per-pixel step offset that the temporal resolve averages out
fn ssr_trace(start: vec3f, r: vec3f, px: vec2f) -> SsrHit {
	let miss = SsrHit(vec2f(0.0), 0.0);
	// rays towards the camera leave the screen through surfaces the depth buffer can't see behind
	let facing = smoothstep(-0.1, 0.2, dot(r, post.forward.xyz));
	if (facing <= 0.0) {
		return miss;
	}
	var step = SSR_FIRST_STEP * (0.5 + ign(px + f32(u32(post.eye.w) % 8u) * 5.588238));
	var t = 0.0;
	var previous = 0.0;
	var hit = false;
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
		return miss;
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
		return miss;
	}
	let edge = min(p.uv, 1.0 - p.uv) / SSR_EDGE_FADE;
	return SsrHit(p.uv, facing * clamp(min(edge.x, edge.y), 0.0, 1.0));
}
