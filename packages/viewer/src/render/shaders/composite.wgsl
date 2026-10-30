// composites the main pass into the HDR scene: ambient occlusion on the ambient part, the sky where nothing
// was drawn, the atmosphere fog and the two-layer height fog. needs post-common.wgsl, atmosphere.wgsl and
// sky.wgsl.

@group(2) @binding(0) var radiance_texture: texture_2d<f32>;
@group(2) @binding(1) var ambient_texture: texture_2d<f32>;
@group(2) @binding(2) var ao_texture: texture_2d<f32>;
@group(2) @binding(3) var depth_texture: texture_depth_2d;
@group(2) @binding(4) var cloud_texture: texture_2d<f32>;
@group(2) @binding(5) var cloud_sampler: sampler;

// Jimenez et al.'s multi-bounce fit: occluded light that bounces off a bright surface comes back, so bright
// surfaces darken less than `ao`. per channel in the game; here from the albedo's luminance
fn multi_bounce(ao: f32, albedo: f32) -> f32 {
	let a = 2.0404 * albedo - 0.3324;
	let b = -4.7951 * albedo + 0.6417;
	let c = 2.7552 * albedo + 0.6903;
	return max(ao, ((a * ao + b) * ao + c) * ao);
}

@fragment
fn fs_composite(in: FullscreenOut) -> @location(0) vec4f {
	let px = vec2i(in.position.xy);
	let depth = textureLoad(depth_texture, px, 0);
	let ray = view_ray(in.uv);
	let direction = normalize(ray);
	if (depth <= 0.0) {
		let painted = textureSampleLevel(cloud_texture, cloud_sampler, cloud_uv(direction), 0.0);
		if (post.cloud.w > 0.5 && post.cloud_shape.w > 0.5) {
			return vec4f(painted.rgb, 1.0);
		}
		let froxels = froxels_at(in.uv, post.sky_fog.x * dot(direction, post.forward.xyz));
		return vec4f(fogged_sky(direction, painted, froxels), 1.0);
	}
	let radiance = textureLoad(radiance_texture, px, 0);
	var color = radiance.rgb;
	// the AO passes don't run while it's off, and the radiance then keeps the material occlusion alone
	if (post.ao.w > 0.5) {
		let ambient = textureLoad(ambient_texture, px, 0);
		let ao = min(textureLoad(ao_texture, px, 0).r, ambient.a);
		color = max(color + ambient.rgb * (multi_bounce(ao, radiance.a) - ambient.a), vec3f(0.0));
	}
	let eye_depth = view_depth(depth);
	let distance = length(ray * eye_depth);
	return vec4f(atmosphere_over(color, direction, distance, froxels_at(in.uv, eye_depth)), 1.0);
}
