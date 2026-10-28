// ground-truth ambient occlusion (Jimenez et al. 2016) from the depth buffer alone: two slices per pixel,
// rotated by a 4×4 interleaved pattern that the blur pass averages away. needs post-common.wgsl.

@group(1) @binding(0) var depth_texture: DEPTH_TEXTURE;

const SLICES = 2;
const STEPS = 6;

fn depth_at(px: vec2i) -> f32 {
	let size = vec2i(textureDimensions(depth_texture));
	return textureLoad(depth_texture, clamp(px, vec2i(0), size - 1), 0);
}

// view space: x right, y up, z forward (m)
fn view_position(px: vec2i, depth: f32) -> vec3f {
	let uv = (vec2f(px) + 0.5) * post.viewport.zw;
	let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
	let z = view_depth(depth);
	return vec3f(ndc.x * length(post.right.xyz), ndc.y * length(post.up.xyz), 1.0) * z;
}

fn view_position_at(px: vec2i) -> vec3f {
	return view_position(px, depth_at(px));
}

@fragment
fn fs_gtao(in: FullscreenOut) -> @location(0) vec4f {
	let px = vec2i(in.position.xy);
	let depth = depth_at(px);
	if (depth <= 0.0) {
		return vec4f(1.0);
	}
	let p = view_position(px, depth);
	// the normal from whichever neighbours lie closer, so silhouettes don't bend it
	let left = view_position_at(px - vec2i(1, 0));
	let right = view_position_at(px + vec2i(1, 0));
	let top = view_position_at(px - vec2i(0, 1));
	let bottom = view_position_at(px + vec2i(0, 1));
	var dx = right - p;
	if (abs(left.z - p.z) < abs(right.z - p.z)) {
		dx = p - left;
	}
	var dy = p - top;
	if (abs(bottom.z - p.z) < abs(top.z - p.z)) {
		dy = bottom - p;
	}
	// view space is left-handed and rows grow downwards: this points back at the camera
	let n = normalize(cross(dx, dy));
	let v = normalize(-p);

	let radius = post.ao.x;
	let radius_px = min(radius * post.right.w / p.z, 96.0);
	if (radius_px < 1.0) {
		return vec4f(1.0);
	}
	// 4×4 interleaved rotations and step offsets
	let cell = vec2f(f32(px.x & 3), f32(px.y & 3));
	let rotation = (cell.x * 4.0 + cell.y) / 16.0;
	let jitter = fract(rotation * 7.0 + 0.5 / 16.0) ;

	var visibility = 0.0;
	for (var s = 0; s < SLICES; s++) {
		let phi = (f32(s) + rotation) * PI / f32(SLICES);
		let omega = vec2f(cos(phi), sin(phi));
		let direction = vec3f(omega, 0.0);
		let ortho = direction - dot(direction, v) * v;
		let axis = normalize(cross(direction, v));
		let projected = n - axis * dot(n, axis);
		let projected_length = max(length(projected), 1e-4);
		let sign_n = sign(dot(ortho, projected));
		let cos_n = clamp(dot(projected, v) / projected_length, -1.0, 1.0);
		let angle_n = sign_n * acos(cos_n);

		var horizons = vec2f(-1.0);
		for (var side = 0; side < 2; side++) {
			let sign = select(-1.0, 1.0, side == 1);
			let low = cos(angle_n + sign * PI * 0.5);
			var best = low;
			for (var i = 0; i < STEPS; i++) {
				let t = pow((f32(i) + jitter) / f32(STEPS), post.ao_shape.y);
				let offset = vec2f(omega.x, -omega.y) * sign * max(t * radius_px, f32(i) + 1.0);
				let q = view_position_at(px + vec2i(round(offset)));
				let delta = q - p;
				let distance = length(delta);
				let cos_h = dot(delta / max(distance, 1e-4), v);
				// XeGTAO's falloff: full weight up to (1 - range) of the radius, linear to none at the radius
				let range = max(post.ao_shape.x * radius, 1e-3);
				let falloff = clamp((radius - distance) / range, 0.0, 1.0);
				best = max(best, mix(low, cos_h, falloff));
			}
			horizons[side] = best;
		}
		let h0 = angle_n + max(-acos(horizons.x) - angle_n, -PI * 0.5);
		let h1 = angle_n + min(acos(horizons.y) - angle_n, PI * 0.5);
		let arc0 = (cos_n + 2.0 * h0 * sin(angle_n) - cos(2.0 * h0 - angle_n)) * 0.25;
		let arc1 = (cos_n + 2.0 * h1 * sin(angle_n) - cos(2.0 * h1 - angle_n)) * 0.25;
		visibility += projected_length * (arc0 + arc1);
	}
	visibility = clamp(visibility / f32(SLICES), 0.0, 1.0);
	let ao = pow(visibility, post.ao.z);
	return vec4f(mix(1.0, ao, post.ao.y), 0.0, 0.0, 1.0);
}

@group(1) @binding(1) var ao_texture: texture_2d<f32>;

// 4×4 depth-aware box blur over the interleaved pattern
@fragment
fn fs_blur(in: FullscreenOut) -> @location(0) vec4f {
	let px = vec2i(in.position.xy);
	let depth = depth_at(px);
	if (depth <= 0.0) {
		return vec4f(1.0);
	}
	let z = view_depth(depth);
	let size = vec2i(textureDimensions(ao_texture));
	var sum = 0.0;
	var weight = 0.0;
	for (var y = -2; y < 2; y++) {
		for (var x = -2; x < 2; x++) {
			let q = clamp(px + vec2i(x, y), vec2i(0), size - 1);
			let qz = view_depth(depth_at(q));
			let w = select(0.0, 1.0, abs(qz - z) < 0.05 * z + 0.1);
			sum += textureLoad(ao_texture, q, 0).r * w;
			weight += w;
		}
	}
	return vec4f(sum / max(weight, 1.0), 0.0, 0.0, 1.0);
}
