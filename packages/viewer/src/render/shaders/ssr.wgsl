// the game's screen-space reflections, as its PC high quality runs them, in fullscreen passes at the render size:
// `fs_march` follows each lit pixel's mirror ray through the depth buffer into last frame's composited scene,
// `fs_temporal` filters the hit colour and fade over frames, `fs_downsample` builds a depth-aware pyramid of both,
// and `fs_resolve` blurs by the reflected cone's footprint and writes the change to the radiance (composite adds
// it before occlusion and fog). see docs/game-data/lighting.md. needs post-common.wgsl.

struct Ssr {
	// last frame's camera-relative view-projection, unjittered
	previous_view_proj: mat4x4f,
	// this frame's eye minus last frame's (m); w = 1 when there's no last frame to read
	eye_delta: vec4f,
	// the volume's fadenessOnScreen, fadenessOnMirrorMul and fadenessOnMirrorAdd; w unused
	fade: vec4f,
	// x = march steps, y = the pyramid's coarsest mip, zw unused
	march: vec4f,
}

@group(1) @binding(0) var<uniform> ssr: Ssr;
@group(1) @binding(1) var depth_texture: texture_depth_2d;
// the main pass's `reflection_surface` (frame.wgsl)
@group(1) @binding(2) var surface_texture: texture_2d<u32>;
// last frame's composited scene, which the hits read
@group(1) @binding(3) var previous_scene: texture_2d<f32>;
@group(1) @binding(4) var linear_sampler: sampler;
// fs_march's outputs
@group(1) @binding(5) var march_color: texture_2d<f32>;
@group(1) @binding(6) var march_weight: texture_2d<f32>;
@group(1) @binding(7) var march_fade: texture_2d<f32>;
// last frame's fs_temporal output: rgb the compressed colour, a the fade
@group(1) @binding(8) var history_texture: texture_2d<f32>;
// fs_downsample: the next finer mip of the pyramid and of the view depth pyramid
@group(1) @binding(9) var fine_pyramid: texture_2d<f32>;
@group(1) @binding(10) var fine_depth: texture_2d<f32>;
// fs_resolve: this frame's pyramid and view depth pyramid, all mips
@group(1) @binding(11) var pyramid: texture_2d<f32>;
@group(1) @binding(12) var depth_pyramid: texture_2d<f32>;
// the main pass's `reflection`: the sky reflection the radiance holds
@group(1) @binding(13) var reflection_texture: texture_2d<f32>;

// the view depth stored where nothing was drawn; any real surface is nearer
const SKY_DEPTH = 60000.0;

// the game's 4 × 4 binomial for its pyramid and resolve
const BINOMIAL = array<f32, 4>(0.125, 0.375, 0.375, 0.125);

struct ReflectionSurface {
	normal: vec3f,
	roughness: f32,
	// what a hit's radiance is multiplied by: environment BRDF and specular occlusion
	weight: vec3f,
	valid: bool,
}

fn oct_decode_unit(e: vec2f) -> vec3f {
	var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
	if (n.z < 0.0) {
		let s = select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
		n = vec3f((1.0 - abs(n.yx)) * s, n.z);
	}
	return normalize(n);
}

// unpacks `pack_reflection_surface` (frame.wgsl)
fn reflection_surface_at(px: vec2i) -> ReflectionSurface {
	let packed = textureLoad(surface_texture, px, 0).xy;
	var s: ReflectionSurface;
	s.valid = (packed.y & (1u << 30u)) != 0u;
	let e = vec2f(f32(packed.x & 0xfffu), f32((packed.x >> 12u) & 0xfffu)) / 4095.0;
	s.normal = oct_decode_unit(e * 2.0 - 1.0);
	s.roughness = f32(packed.x >> 24u) / 255.0;
	let w = vec3f(f32(packed.y & 0x3ffu), f32((packed.y >> 10u) & 0x3ffu), f32((packed.y >> 20u) & 0x3ffu)) / 1023.0;
	s.weight = w * w;
	return s;
}

fn texel_of(uv: vec2f) -> vec2i {
	return clamp(vec2i(uv * post.viewport.xy), vec2i(0), vec2i(post.viewport.xy) - 1);
}

// the main pass's (reversed-Z) device depth under a uv, 0 for the sky
fn device_depth(uv: vec2f) -> f32 {
	return textureLoad(depth_texture, texel_of(uv), 0);
}

// a camera-relative point on the main pass's (jittered) targets: xy uv, z device depth
fn project(rel: vec3f) -> vec3f {
	let d = dot(rel, post.forward.xyz);
	let right = post.right.xyz;
	let up = post.up.xyz;
	let ndc = vec2f(dot(rel, right) / dot(right, right), dot(rel, up) / dot(up, up)) / d + post.jitter.xy;
	return vec3f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, post.forward.w / d);
}

// the camera-relative point at a uv and device depth
fn unproject(uv: vec2f, depth: f32) -> vec3f {
	return view_ray(uv) * view_depth(depth);
}

// where a camera-relative point of this frame was on last frame's targets
fn previous_uv(rel: vec3f) -> vec2f {
	let clip = ssr.previous_view_proj * vec4f(rel + ssr.eye_delta.xyz, 1.0);
	let ndc = clip.xy / clip.w;
	return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

// the screen motion (this frame's uv minus last frame's) of the surface under a uv; none for the sky or without a
// last frame
fn motion_at(uv: vec2f) -> vec2f {
	let depth = device_depth(uv);
	if (depth <= 0.0 || ssr.eye_delta.w > 0.5) {
		return vec2f(0.0);
	}
	return uv - previous_uv(unproject(uv, depth));
}

// Karis' tonemap-like weighting the game keeps the hit colours in until the resolve
fn compress(c: vec3f) -> vec3f {
	return c / (max(max(c.r, c.g), c.b) + 1.0);
}

fn expand(c: vec3f) -> vec3f {
	return c / max(1.0 - max(max(c.r, c.g), c.b), 1e-4);
}

fn to_ycocg(c: vec3f) -> vec3f {
	return vec3f(dot(c, vec3f(0.25, 0.5, 0.25)), dot(c, vec3f(0.5, 0.0, -0.5)), dot(c, vec3f(-0.25, 0.5, -0.25)));
}

fn from_ycocg(c: vec3f) -> vec3f {
	return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

// #region march

struct March {
	// rgb: the hit's compressed colour from last frame's scene
	@location(0) color: vec4f,
	// x: how much the temporal filter may keep of last frame, y: the pyramid mip the reflected cone covers, over
	// the coarsest mip
	@location(1) weight: vec4f,
	@location(2) fade: vec4f,
	// view depth, the depth pyramid's finest mip
	@location(3) depth: vec4f,
}

// the point a surface point's reflected cone of half-angle `theta` shows at `reach` past it, turned about `axis`
// (the game's Rodrigues rotation of the view direction, with its unnormalised axes); `v` points to the camera
fn cone_edge(p: vec3f, v: vec3f, axis: vec3f, theta: f32, reach: f32) -> vec3f {
	let away = -v;
	let turned = mix(axis * dot(axis, away), away, vec3f(cos(theta))) + cross(axis, away) * sin(theta);
	return p + turned * reach;
}

@fragment
fn fs_march(in: FullscreenOut) -> March {
	var out: March;
	let px = vec2i(in.position.xy);
	let depth = textureLoad(depth_texture, px, 0);
	out.depth = vec4f(select(SKY_DEPTH, view_depth(depth), depth > 0.0));
	let s = reflection_surface_at(px);
	if (!s.valid || depth <= 0.0) {
		return out;
	}
	let uv = (vec2f(px) + 0.5) * post.viewport.zw;
	let eye = view_depth(depth);
	let p = unproject(uv, depth);
	let v = normalize(p);
	let r = reflect(v, s.normal);
	let alpha2 = pow(s.roughness, 4.0);

	// the ray from the pixel to where the reflection of a point one view depth along it lands, stretched to the
	// screen's edge (Unreal's clip-to-screen); steps are equal in uv and device depth
	let start = vec3f(uv, depth);
	var steps = max(ceil(ssr.march.x * clamp(2.0 * exp(-0.07 * eye), 0.125, 1.0)), 32.0);
	if (s.roughness >= 0.3) {
		steps *= 0.125;
	}
	let end_rel = p + r * eye;
	if (dot(end_rel, post.forward.xyz) <= post.forward.w) {
		return out;
	}
	let end = project(end_rel);
	let start_ndc = vec2f(start.x * 2.0 - 1.0, 1.0 - start.y * 2.0);
	var delta = vec3f((end.x - start.x) * 2.0, (start.y - end.y) * 2.0, end.z - start.z);
	{
		let half_length = max(0.5 * length(delta.xy), 1e-9);
		let scale =
			1.0 - max(abs(delta.xy + start_ndc * half_length) - half_length, vec2f(0.0)) / max(abs(delta.xy), vec2f(1e-9));
		delta *= min(scale.x, scale.y) / half_length;
	}
	let tolerance = max(abs(delta.z) / steps, 1e-4);
	let step = vec3f(delta.x * 0.5, -delta.y * 0.5, delta.z) / steps;
	var offset: f32;
	{
		let pixels = abs(step.xy * post.viewport.xy);
		let longest = max(pixels.x, pixels.y);
		if (longest < 1.0) {
			offset = 1.0 / (longest + 0.001);
		} else {
			offset = ign(vec2f(px) + 0.5 + vec2f(2.083, 4.867) * post.eye.w);
		}
	}
	var position = start + step * offset;
	var last = position.z - device_depth(position.xy);
	var hit = false;
	for (var i = 0.0; i < steps; i += 4.0) {
		var diff: array<f32, 4>;
		var found = -1;
		for (var k = 0; k < 4; k++) {
			let tap = position + step * f32(k + 1);
			diff[k] = tap.z - device_depth(tap.xy);
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

	// fade towards the screen's edges, for surfaces seen head-on (their rays turn back off the screen) and, for
	// all but the glossiest, between 90 and 100 m
	var hit_motion = vec2f(0.0);
	var source = uv;
	if (hit) {
		let edge = min(1.0 - max(position.x, position.y), min(position.x, position.y));
		let on_screen = clamp(select(edge / ssr.fade.x, 1.0, edge > ssr.fade.x), 0.0, 1.0);
		let mirror = 1.0 - clamp(abs(dot(s.normal, v)) * ssr.fade.y + ssr.fade.z, 0.0, 1.0);
		let far = select(clamp((100.0 - eye) * 0.1, 0.0, 1.0), 1.0, s.roughness < 0.1);
		out.fade = vec4f(on_screen * mirror * far);
		hit_motion = motion_at(position.xy);
		source = position.xy - hit_motion;
	}
	out.color = vec4f(compress(textureSampleLevel(previous_scene, linear_sampler, source, 0.0).rgb), 0.0);

	// the temporal filter keeps less where things move on screen, and almost nothing nearer than 50 m
	let moved = length((motion_at(source) + hit_motion) * post.viewport.xy);
	out.weight.x = exp(-moved) * clamp(log(0.02 * eye) + 0.01, 0.0, 1.0);
	if (alpha2 > 1e-4) {
		// the reflected cone (a Blinn-Phong lobe's angle) seen through the mirror at the hit's distance, in pixels
		let theta = acos(pow(0.244, 1.0 / (2.0 / alpha2 - 1.0)));
		let reach = distance(unproject(position.xy, position.z), p);
		let towards_camera = -v;
		let pick = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(s.normal.z) < 0.999);
		let t = normalize(cross(pick, s.normal));
		let center = project(p - towards_camera * reach).xy * post.viewport.xy;
		let a = project(cone_edge(p, towards_camera, cross(t, towards_camera), theta, reach)).xy * post.viewport.xy;
		let b = project(cone_edge(p, towards_camera, cross(cross(s.normal, t), towards_camera), theta, reach)).xy *
			post.viewport.xy;
		let footprint = sqrt(dot(center - a, center - a) + dot(center - b, center - b)) * 0.5;
		out.weight.y = clamp(log2(footprint), 0.0, ssr.march.y) / ssr.march.y;
	}
	return out;
}

// #endregion

// #region temporal

// the game's neighbourhood box: the plus and the full 3 × 3 extremes averaged, widened to mean ± 1.25 σ
struct Box {
	lo: vec4f,
	hi: vec4f,
}

@fragment
fn fs_temporal(in: FullscreenOut) -> @location(0) vec4f {
	let px = vec2i(in.position.xy);
	let size = vec2i(post.viewport.xy);
	var samples: array<vec4f, 9>;
	var sum = vec4f(0.0);
	var squares = vec4f(0.0);
	for (var i = 0; i < 9; i++) {
		let at = clamp(px + vec2i(i % 3 - 1, i / 3 - 1), vec2i(0), size - 1);
		let c = vec4f(to_ycocg(textureLoad(march_color, at, 0).rgb), textureLoad(march_fade, at, 0).r);
		samples[i] = c;
		sum += c;
		squares += c * c;
	}
	let plus_lo = min(samples[1], min(min(samples[3], samples[4]), min(samples[5], samples[7])));
	let plus_hi = max(samples[1], max(max(samples[3], samples[4]), max(samples[5], samples[7])));
	let corners_lo = min(min(samples[0], samples[2]), min(samples[6], samples[8]));
	let corners_hi = max(max(samples[0], samples[2]), max(samples[6], samples[8]));
	let mean = sum / 9.0;
	let sigma = sqrt(max(squares / 9.0 - mean * mean, vec4f(0.0))) * 1.25;
	let lo = min((plus_lo + min(plus_lo, corners_lo)) * 0.5, mean - sigma);
	let hi = max((plus_hi + max(plus_hi, corners_hi)) * 0.5, mean + sigma);

	let current = vec4f(textureLoad(march_color, px, 0).rgb, textureLoad(march_fade, px, 0).r);
	if (ssr.eye_delta.w > 0.5) {
		return vec4f(max(current.rgb, vec3f(0.001)), current.a);
	}
	let uv = (vec2f(px) + 0.5) * post.viewport.zw;
	let history = textureSampleLevel(history_texture, linear_sampler, uv - motion_at(uv), 0.0);
	let keep = 0.97 * textureLoad(march_weight, px, 0).x;
	// the colour and the fade are each moved towards their box's centre until they lie inside
	var color: vec3f;
	{
		let center = (hi.xyz + lo.xyz) * 0.5;
		let offset = to_ycocg(history.rgb) - center;
		let units = abs(offset / max((hi.xyz - lo.xyz) * 0.5, vec3f(1e-7)));
		let reach = max(units.x, max(units.y, units.z));
		color = from_ycocg(select(center + offset, center + offset / reach, reach > 1.0));
	}
	var fade: f32;
	{
		let center = (hi.w + lo.w) * 0.5;
		let offset = history.a - center;
		let reach = abs(offset / max((hi.w - lo.w) * 0.5, 1e-7));
		fade = select(history.a, center + offset / reach, reach > 1.0);
	}
	return vec4f(max(mix(current.rgb, color, keep), vec3f(0.001)), mix(current.a, fade, keep));
}

// #endregion

// #region pyramid

struct Downsampled {
	@location(0) color: vec4f,
	@location(1) depth: vec4f,
}

// one pyramid mip from the next finer one: a 4 × 4 binomial about the texel's 2 × 2 footprint, each tap weighted
// by how close its view depth is to the texel's (the nearest of its footprint, as the game's depth pyramid)
@fragment
fn fs_downsample(in: FullscreenOut) -> Downsampled {
	let g = vec2i(in.position.xy);
	let fine_size = vec2i(textureDimensions(fine_depth));
	let base = g * 2;
	var nearest = SKY_DEPTH;
	{
		// on an odd size, the last texel also takes in the row or column the halving leaves over
		let last = vec2i(textureDimensions(fine_depth) / 2u) - 1;
		let extra = vec2i(select(0, 1, fine_size.x % 2 == 1 && g.x == last.x), select(0, 1, fine_size.y % 2 == 1 && g.y == last.y));
		for (var y = 0; y <= 1 + extra.y; y++) {
			for (var x = 0; x <= 1 + extra.x; x++) {
				nearest = min(nearest, textureLoad(fine_depth, min(base + vec2i(x, y), fine_size - 1), 0).r);
			}
		}
	}
	var color = vec4f(0.0);
	var weight = 0.0;
	for (var y = 0; y < 4; y++) {
		for (var x = 0; x < 4; x++) {
			let at = clamp(base + vec2i(x - 1, y - 1), vec2i(0), fine_size - 1);
			let w = BINOMIAL[x] * BINOMIAL[y] * exp(-0.01 * abs(textureLoad(fine_depth, at, 0).r - nearest));
			color += textureLoad(fine_pyramid, at, 0) * w;
			weight += w;
		}
	}
	var out: Downsampled;
	out.color = color / max(weight, 0.01);
	out.depth = vec4f(nearest);
	return out;
}

// #endregion

// #region resolve

// the pyramid's colour at one mip around a pixel: the binomial over a 4 × 4 grid of that mip's texels, weighted by
// view depth against the pixel's
fn pyramid_color(px: vec2f, mip: f32, eye: f32) -> vec3f {
	let texel = post.viewport.zw * exp2(mip);
	let corner = px * post.viewport.zw - 1.5 * texel;
	var color = vec3f(0.0);
	var weight = 0.0;
	for (var y = 0; y < 4; y++) {
		for (var x = 0; x < 4; x++) {
			let at = corner + vec2f(f32(x), f32(y)) * texel;
			let depth = textureSampleLevel(depth_pyramid, linear_sampler, at, mip).r;
			let w = BINOMIAL[x] * BINOMIAL[y] * exp(-0.01 * abs(depth - eye));
			color += textureSampleLevel(pyramid, linear_sampler, at, mip).rgb * w;
			weight += w;
		}
	}
	return color / max(weight, 0.01);
}

// what the reflection changes in the radiance: the hit colour, blurred to the reflected cone, replaces the sky
// reflection by the fade, both under the surface's environment BRDF and specular occlusion
@fragment
fn fs_resolve(in: FullscreenOut) -> @location(0) vec4f {
	let px = vec2i(in.position.xy);
	let s = reflection_surface_at(px);
	let depth = textureLoad(depth_texture, px, 0);
	if (!s.valid || depth <= 0.0) {
		return vec4f(0.0);
	}
	let uv = (vec2f(px) + 0.5) * post.viewport.zw;
	let mip = textureLoad(march_weight, px, 0).y * ssr.march.y;
	var color: vec3f;
	if (mip < 0.25) {
		color = textureLoad(pyramid, px, 0).rgb;
	} else {
		let eye = view_depth(depth);
		let lower = floor(mip);
		let upper = clamp(lower + 1.0, 0.0, ssr.march.y);
		color = mix(pyramid_color(vec2f(px), lower, eye), pyramid_color(vec2f(px), upper, eye), mip - lower);
	}
	let fade = textureSampleLevel(pyramid, linear_sampler, uv, floor(mip)).a;
	let sky = textureLoad(reflection_texture, px, 0).rgb;
	return vec4f((s.weight * expand(color) - sky) * fade, 0.0);
}

// #endregion
