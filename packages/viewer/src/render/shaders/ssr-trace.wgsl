// the water pass's reflection march, the same screen-space march as the game's (and ssr.wgsl's `fs_march`): the
// mirror ray is projected to the screen, stretched to its edge and stepped in equal steps of uv and device depth,
// so it has no reach limit in metres. needs post-common.wgsl and a `depth_texture` (the main pass's depth)
// declared by the pass.

// PC high quality's `ssrRayMarchingSampleCount`, which glossy surfaces such as water always take
const SSR_STEPS = 32.0;
// the ScreenSpaceReflectionVolume's fadenessOnScreen, fadenessOnMirrorMul and fadenessOnMirrorAdd, the same in
// every shipped profile
const SSR_FADE_ON_SCREEN = 0.1;
const SSR_FADE_MIRROR_MUL = 2.0;
const SSR_FADE_MIRROR_ADD = -1.0;

// a camera-relative point on the main pass's (jittered) targets: xy uv, z device depth
fn ssr_project(rel: vec3f) -> vec3f {
	let d = dot(rel, post.forward.xyz);
	let right = post.right.xyz;
	let up = post.up.xyz;
	let ndc = vec2f(dot(rel, right) / dot(right, right), dot(rel, up) / dot(up, up)) / d + post.jitter.xy;
	return vec3f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, post.forward.w / d);
}

// the main pass's (reversed-Z) device depth under a uv, 0 for the sky
fn ssr_device_depth(uv: vec2f) -> f32 {
	let px = clamp(vec2i(uv * post.viewport.xy), vec2i(0), vec2i(post.viewport.xy) - 1);
	return textureLoad(depth_texture, px, 0);
}

struct SsrHit {
	// where the ray hit, on the main pass's targets
	uv: vec2f,
	// 0 for a miss, fading towards the screen's edges and for surfaces seen head-on
	confidence: f32,
}

// marches the mirror ray `r` of the surface at the camera-relative `start` with normal `n`; `px` seeds the
// per-frame start offset
fn ssr_trace(start_rel: vec3f, r: vec3f, n: vec3f, px: vec2f) -> SsrHit {
	let miss = SsrHit(vec2f(0.0), 0.0);
	let eye = dot(start_rel, post.forward.xyz);
	let end_rel = start_rel + r * eye;
	if (dot(end_rel, post.forward.xyz) <= post.forward.w) {
		return miss;
	}
	let start = ssr_project(start_rel);
	let end = ssr_project(end_rel);
	// stretch the ray to the screen's edge (Unreal's clip-to-screen)
	let start_ndc = vec2f(start.x * 2.0 - 1.0, 1.0 - start.y * 2.0);
	var delta = vec3f((end.x - start.x) * 2.0, (start.y - end.y) * 2.0, end.z - start.z);
	{
		let half_length = max(0.5 * length(delta.xy), 1e-9);
		let scale =
			1.0 - max(abs(delta.xy + start_ndc * half_length) - half_length, vec2f(0.0)) / max(abs(delta.xy), vec2f(1e-9));
		delta *= min(scale.x, scale.y) / half_length;
	}
	let tolerance = max(abs(delta.z) / SSR_STEPS, 1e-4);
	let step = vec3f(delta.x * 0.5, -delta.y * 0.5, delta.z) / SSR_STEPS;
	var offset: f32;
	{
		let pixels = abs(step.xy * post.viewport.xy);
		let longest = max(pixels.x, pixels.y);
		if (longest < 1.0) {
			offset = 1.0 / (longest + 0.001);
		} else {
			offset = ign(px + vec2f(2.083, 4.867) * post.eye.w);
		}
	}
	var position = start + step * offset;
	var last = position.z - ssr_device_depth(position.xy);
	var hit = false;
	for (var i = 0.0; i < SSR_STEPS; i += 4.0) {
		var diff: array<f32, 4>;
		var found = -1;
		for (var k = 0; k < 4; k++) {
			let tap = position + step * f32(k + 1);
			diff[k] = tap.z - ssr_device_depth(tap.xy);
			// a hit lies behind the depth buffer's surface by less than two steps' depth
			if (found < 0 && abs(diff[k] + tolerance) < tolerance) {
				found = k;
			}
		}
		if (found >= 0) {
			let before = select(diff[max(found - 1, 0)], last, found == 0);
			let after = diff[found];
			position += step * (f32(found) + clamp(before / (before - after), 0.0, 1.0));
			hit = true;
			break;
		}
		position += step * 4.0;
		last = diff[3];
	}
	if (!hit) {
		return miss;
	}
	let edge = min(1.0 - max(position.x, position.y), min(position.x, position.y));
	let on_screen = clamp(select(edge / SSR_FADE_ON_SCREEN, 1.0, edge > SSR_FADE_ON_SCREEN), 0.0, 1.0);
	let v = normalize(start_rel);
	let mirror = 1.0 - clamp(abs(dot(n, v)) * SSR_FADE_MIRROR_MUL + SSR_FADE_MIRROR_ADD, 0.0, 1.0);
	return SsrHit(position.xy, on_screen * mirror);
}
