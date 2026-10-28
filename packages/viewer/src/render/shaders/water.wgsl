// open-world water, drawn after compositing over a copy of the scene: the water column between the surface
// and the ground below absorbs and scatters (the config's per-metre coefficients), flowing wave normals
// distort the view through it and reflect the sky, and the shore fades in with depth. follows the game's
// WaterConfig fields; the blend of the two absorptions and the flow-map conventions come from earlier
// community tooling rather than the game's shaders. foam isn't drawn yet. needs post-common.wgsl,
// atmosphere.wgsl and sky.wgsl.

struct Surface {
	// object-to-world rows, translation relative to the eye
	t0: vec4f,
	t1: vec4f,
	t2: vec4f,
	// position dequantization: offset, w = config index (u32 bits)
	offset: vec4f,
	scale: vec4f,
}

struct Config {
	// scattering per metre
	scattering: vec4f,
	// absorption per metre, near and far
	absorption: vec4f,
	absorption_far: vec4f,
	// x = depth (m) of full absorption, y = ambient light intensity, z = shore blend factor, w = Rayleigh–Mie mix
	optics: vec4f,
	// roughness, f0, distortion strength, unused
	surface: vec4f,
	// small waves: speed, tiling, normal scale, cycle
	small: vec4f,
	// large waves: speed (negative to reverse), tiling, normal scale, cycle
	large: vec4f,
	// flow direction xy (without a flow map), 1 to follow the flow map, unused
	flow: vec4f,
	// layers of the wave normal array: small waves, large waves; z, w unused
	layers: vec4f,
}

@group(2) @binding(0) var<storage, read> surfaces: array<Surface>;
@group(2) @binding(1) var<storage, read> configs: array<Config>;
@group(2) @binding(2) var background: texture_2d<f32>;
@group(2) @binding(3) var depth_texture: DEPTH_TEXTURE;
@group(2) @binding(4) var cloud_texture: texture_2d<f32>;
@group(2) @binding(5) var cloud_sampler: sampler;
@group(2) @binding(6) var wave_normals: texture_2d_array<f32>;
@group(2) @binding(7) var flow_map: texture_2d<f32>;
@group(2) @binding(8) var repeat_sampler: sampler;
// x = 1 with wave normals, y = 1 with a flow map, z = flow map size (m), w unused; then the map's centre
@group(2) @binding(9) var<uniform> water: array<vec4f, 2>;

struct VertexOut {
	@builtin(position) position: vec4f,
	@location(0) rel: vec3f,
	@location(1) @interpolate(flat) config: u32,
}

@vertex
fn vs_water(@location(0) position: vec4f, @builtin(instance_index) ii: u32) -> VertexOut {
	let s = surfaces[ii];
	let p = s.offset.xyz + position.xyz * s.scale.xyz;
	let rel = vec3f(dot(s.t0.xyz, p) + s.t0.w, dot(s.t1.xyz, p) + s.t1.w, dot(s.t2.xyz, p) + s.t2.w);
	// the post passes' camera: clip = (ndc · z, z) with reversed-Z depth near / z
	let z = dot(rel, post.forward.xyz);
	let right = post.right.xyz / dot(post.right.xyz, post.right.xyz);
	let up = post.up.xyz / dot(post.up.xyz, post.up.xyz);
	var out: VertexOut;
	out.position = vec4f(dot(rel, right), dot(rel, up), post.forward.w, z);
	out.rel = rel;
	out.config = bitcast<u32>(s.offset.w);
	return out;
}

// one layer of flowing waves: two phases of the flow, cross-faded (the usual flow-map scheme)
fn wave(p: vec2f, direction: vec2f, spec: vec4f, layer: i32, shift: f32) -> vec4f {
	let progress = post.up.w * spec.w + shift;
	let phase0 = fract(progress);
	let phase1 = fract(progress + 0.5);
	let uv0 = (p - direction * phase0 * spec.x) * spec.y;
	let uv1 = (p - direction * phase1 * spec.x) * spec.y + 0.5;
	let a = textureSample(wave_normals, repeat_sampler, uv0, layer);
	let b = textureSample(wave_normals, repeat_sampler, uv1, layer);
	return mix(a, b, abs(1.0 - 2.0 * phase0));
}

fn wave_normal(rg: vec2f, strength: f32) -> vec3f {
	let xy = (rg * 2.0 - 1.0) * strength;
	return vec3f(xy, sqrt(max(1.0 - dot(xy, xy), 0.0)));
}

@fragment
fn fs_water(in: VertexOut) -> @location(0) vec4f {
	let c = configs[in.config];
	let px = vec2i(in.position.xy);
	let size = vec2f(textureDimensions(background));
	let world = in.rel + post.eye.xyz;
	let surface_distance = length(in.rel);
	let v = -in.rel / surface_distance;

	// waves, sampled before any branching (implicit derivatives)
	var direction = c.flow.xy * 2.0 - 1.0;
	var amplitude = 1.0;
	let flow_uv = (world.xz - water[1].xy) / max(water[0].z, 1.0) + 0.5;
	let flow = textureSample(flow_map, repeat_sampler, flow_uv);
	if (water[0].y > 0.5 && c.flow.z > 0.5) {
		direction = vec2f(flow.r * 2.0 - 1.0, flow.g * 2.0 - 1.0);
		amplitude = flow.a;
	}
	let small = wave(world.xz, direction, c.small, i32(c.layers.x), 0.0);
	let large = wave(world.xz, direction, c.large, i32(c.layers.y), 0.5);
	var n = vec3f(0.0, 1.0, 0.0);
	if (water[0].x > 0.5) {
		// reoriented normal mapping of the two layers, in the surface's tangent frame (x, z)
		let t = wave_normal(small.rg, c.small.z * amplitude) + vec3f(0.0, 0.0, 1.0);
		let u = wave_normal(large.rg, c.large.z * amplitude) * vec3f(-1.0, -1.0, 1.0);
		let combined = normalize(t * dot(t, u) / max(t.z, 1e-5) - u);
		n = normalize(vec3f(combined.x, combined.z, combined.y));
	}

	// the ground under the surface
	let scene_depth = textureLoad(depth_texture, px, 0);
	let ray = view_ray(in.position.xy / size);
	// nothing drawn behind: the sky, far away
	var ground_distance = 100000.0;
	if (scene_depth > 0.0) {
		ground_distance = length(ray * view_depth(scene_depth));
	}
	if (ground_distance < surface_distance - 0.02) {
		discard;
	}
	let thickness = min(ground_distance - surface_distance, 50.0);

	// refraction: shift the lookup by the waves, unless that lands on something in front of the water
	var uv = in.position.xy / size + n.xz * c.surface.z * 0.01 * min(thickness, 3.0);
	uv = clamp(uv, vec2f(0.001), vec2f(0.999));
	let shifted_depth = textureLoad(depth_texture, vec2i(uv * size), 0);
	if (shifted_depth > 0.0 && length(view_ray(uv) * view_depth(shifted_depth)) < surface_distance) {
		uv = in.position.xy / size;
	}
	let behind = textureLoad(background, vec2i(uv * size), 0).rgb;

	// the water column
	let absorption = mix(c.absorption_far.rgb, c.absorption.rgb, min(thickness / max(c.optics.x, 0.01), 1.0));
	let extinction = c.scattering.rgb + absorption;
	let transmittance = exp(-extinction * thickness);
	let albedo = c.scattering.rgb / max(extinction, vec3f(1e-4));
	let cos_theta = dot(-v, post.sun.xyz);
	let phase = mix(rayleigh_phase(cos_theta), mie_phase(cos_theta), c.optics.w);
	let sunlight = post.sun_illuminance.rgb * phase * max(post.sun.y, 0.0);
	let ambient = post.sky_up.rgb * c.optics.y;
	let inscatter = albedo * (sunlight + ambient) * (vec3f(1.0) - transmittance);
	let through = behind * transmittance + inscatter;

	// reflection of the sky, and the sun's highlight
	let n_dot_v = clamp(dot(n, v), 1e-4, 1.0);
	let fresnel = fresnel_schlick(vec3f(c.surface.y), n_dot_v).x;
	let r = reflect(-v, n);
	var reflected = post.sky_horizon.rgb;
	if (post.flags.x != 0u && r.y >= 0.0) {
		let painted = textureSampleLevel(cloud_texture, cloud_sampler, cloud_uv(r), 0.0);
		reflected = fogged_sky(r, painted);
	}
	let h = normalize(post.sun.xyz + v);
	let roughness = max(c.surface.x, 0.02);
	let a2 = roughness * roughness * roughness * roughness;
	let n_dot_h = clamp(dot(n, h), 0.0, 1.0);
	let highlight = post.sun_illuminance.rgb * ggx_distribution(n_dot_h, a2) * 0.25 * clamp(dot(n, post.sun.xyz), 0.0, 1.0);

	var colour = through * (1.0 - fresnel) + (reflected + highlight) * fresnel;
	// the shore: shallow water fades into what's under it
	let coverage = clamp(thickness * c.optics.z, 0.0, 1.0);
	colour = mix(behind, colour, coverage);
	return vec4f(atmosphere_over(colour, -v, surface_distance), 1.0);
}
