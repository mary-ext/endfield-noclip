// screen-space reflections: glossy surfaces march their mirror ray through the depth buffer, and where it hits
// something on screen, that radiance replaces the sky reflection the main pass gave them. writes the change to
// add to the radiance (composite adds it before occlusion and fog). needs post-common.wgsl and ssr-trace.wgsl.

@group(1) @binding(0) var radiance_texture: texture_2d<f32>;
@group(1) @binding(1) var reflection_texture: texture_2d<f32>;
@group(1) @binding(2) var reflection_normal_texture: texture_2d<f32>;
@group(1) @binding(3) var depth_texture: texture_depth_2d;

fn oct_decode_unit(e: vec2f) -> vec3f {
	var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
	if (n.z < 0.0) {
		let s = select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
		n = vec3f((1.0 - abs(n.yx)) * s, n.z);
	}
	return normalize(n);
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
	// off the surface by two pixels' footprint, so the ray doesn't hit where it starts
	let start = rel + n * 2.0 * length(rel) / post.right.w;
	let hit = ssr_trace(start, r, in.position.xy);
	if (hit.confidence <= 0.0) {
		return vec4f(0.0);
	}
	let hit_radiance = textureLoad(radiance_texture, vec2i(hit.uv * post.viewport.xy), 0).rgb;
	return vec4f((hit_radiance * reflection.a - reflection.rgb) * hit.confidence, 0.0);
}
