// ground-truth ambient occlusion (Jimenez et al. 2016) from the depth buffer alone, at half resolution: two
// slices per pixel, rotated by a 4×4 interleaved pattern that the upsampling blur averages away. needs
// post-common.wgsl.
//
// three passes: fs_ao_depth reduces the (multisampled) depth buffer to half-resolution view depth, fs_gtao
// marches it, and fs_blur filters and upsamples the result to full resolution, weighted by depth so edges stay
// sharp. the half-resolution single-sample source keeps the march's wide, scattered reads in cache.

@group(1) @binding(0) var depth_texture: DEPTH_TEXTURE;
// half resolution, view depth in metres (0 for the sky)
@group(1) @binding(1) var half_depth: texture_2d<f32>;
@group(1) @binding(2) var ao_texture: texture_2d<f32>;

const SLICES = 2;
const STEPS = 6;
// full-resolution pixels per AO pixel along each axis (AO_SCALE in post-process.ts sizes the targets)
const AO_SCALE = 2;
// the march's reach, AO pixels
const MAX_RADIUS = 48.0;

@fragment
fn fs_ao_depth(in: FullscreenOut) -> @location(0) vec4f {
	let size = vec2i(textureDimensions(depth_texture));
	let depth = textureLoad(depth_texture, min(vec2i(in.position.xy) * AO_SCALE, size - 1), 0);
	return vec4f(select(view_depth(depth), 0.0, depth <= 0.0), 0.0, 0.0, 1.0);
}

fn half_depth_at(px: vec2i) -> f32 {
	let size = vec2i(textureDimensions(half_depth));
	return textureLoad(half_depth, clamp(px, vec2i(0), size - 1), 0).r;
}

// view space: x right, y up, z forward (m)
fn view_position(px: vec2i, z: f32) -> vec3f {
	let uv = (vec2f(px) + 0.5) / vec2f(textureDimensions(half_depth));
	let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
	return vec3f(ndc.x * length(post.right.xyz), ndc.y * length(post.up.xyz), 1.0) * z;
}

fn view_position_at(px: vec2i) -> vec3f {
	return view_position(px, half_depth_at(px));
}

@fragment
fn fs_gtao(in: FullscreenOut) -> @location(0) vec4f {
	let px = vec2i(in.position.xy);
	let z = half_depth_at(px);
	if (z <= 0.0) {
		return vec4f(1.0);
	}
	let p = view_position(px, z);
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
	// the pixel factor is for full resolution
	let radius_px = min(radius * post.right.w / (f32(AO_SCALE) * p.z), MAX_RADIUS);
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

// a 4×4 box over the half-resolution interleaved pattern, upsampled to full resolution: each tap is weighted
// by how close its depth is to this pixel's
@fragment
fn fs_blur(in: FullscreenOut) -> @location(0) vec4f {
	let px = vec2i(in.position.xy);
	let depth = textureLoad(depth_texture, px, 0);
	if (depth <= 0.0) {
		return vec4f(1.0);
	}
	let z = view_depth(depth);
	let size = vec2i(textureDimensions(ao_texture));
	let centre = px / AO_SCALE;
	var sum = 0.0;
	var weight = 0.0;
	for (var y = -2; y < 2; y++) {
		for (var x = -2; x < 2; x++) {
			let q = clamp(centre + vec2i(x, y), vec2i(0), size - 1);
			let qz = textureLoad(half_depth, q, 0).r;
			let w = select(0.0, 1.0, abs(qz - z) < 0.05 * z + 0.1);
			sum += textureLoad(ao_texture, q, 0).r * w;
			weight += w;
		}
	}
	// no tap at this depth (a thin edge the half-resolution march missed): leave it unoccluded
	return vec4f(select(1.0, sum / weight, weight > 0.0), 0.0, 0.0, 1.0);
}
