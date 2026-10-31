// open-world water, drawn after compositing over a copy of the scene and lit like the main pass (the frame's
// sun shadow, irradiance volume and sky reflection). the water column between the surface and the ground below
// absorbs and scatters with the config's per-metre coefficients, flowing wave normals distort the view through
// it, and the surface reflects what screen-space reflections find, else the sky reflection. the flow-map
// conventions come from earlier community tooling rather than the game's shaders; foam and caustics aren't
// drawn. needs frame.wgsl, then post-common.wgsl (its uniforms at group 3), atmosphere.wgsl, sky.wgsl and
// ssr-trace.wgsl.

struct WaterSurface {
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
	// x = depth (m) of full absorption, y = ambient light intensity, z = shore blend factor, w = Mie–Rayleigh mix
	optics: vec4f,
	// roughness, f0, distortion strength, sky reflection intensity
	surface: vec4f,
	// small waves: speed, tiling, normal scale, cycle
	small: vec4f,
	// large waves: speed (negative to reverse), tiling, normal scale, cycle
	large: vec4f,
	// flow direction xy (without a flow map), 1 to follow the flow map, unused
	flow: vec4f,
	// layers of the wave normal array: small waves, large waves; z = sun highlight intensity, w unused
	layers: vec4f,
}

@group(2) @binding(0) var<storage, read> surfaces: array<WaterSurface>;
@group(2) @binding(1) var<storage, read> configs: array<Config>;
@group(2) @binding(2) var background: texture_2d<f32>;
@group(2) @binding(3) var depth_texture: texture_depth_2d;
@group(2) @binding(4) var wave_normals: texture_2d_array<f32>;
@group(2) @binding(5) var flow_map: texture_2d<f32>;
@group(2) @binding(6) var repeat_sampler: sampler;
// x = 1 with wave normals, y = 1 with a flow map, z = flow map size (m), w unused; then the map's centre
@group(2) @binding(7) var<uniform> water: array<vec4f, 2>;

// the in-water Mie lobe: Henyey–Greenstein with the game's anisotropy
fn water_mie_phase(cos_theta: f32) -> f32 {
	let g = 0.854;
	let x = 1.0 + g * g - 2.0 * g * cos_theta;
	return (1.0 - g * g) / max(4.0 * PI * x * sqrt(x), 0.001);
}

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
	// the post passes' camera: clip = (ndc · z, z) with reversed-Z depth near / z, jittered as the main pass is
	let z = dot(rel, post.forward.xyz);
	let right = post.right.xyz / dot(post.right.xyz, post.right.xyz);
	let up = post.up.xyz / dot(post.up.xyz, post.up.xyz);
	var out: VertexOut;
	out.position = vec4f(vec2f(dot(rel, right), dot(rel, up)) + post.jitter.xy * z, post.forward.w, z);
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

// light scattered towards the eye over `depth` metres of water whose extinction is `extinction`
fn column_inscatter(extinction: vec3f, depth: f32) -> vec3f {
	return (vec3f(1.0) - exp(-extinction * depth)) / extinction;
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

	// the light reaching the water: the sun through the shadow, looked up where the waves bend it as the game
	// does, and the irradiance volume
	let up = vec3f(0.0, 1.0, 0.0);
	let sun = frame.sun_color.rgb * sun_visibility(in.rel + vec3f(n.x, 0.0, n.z) * 2.0, up, in.position.xy) * frame.sun.w;
	let irradiance = ambient_irradiance(world, n);

	// the water column: each light's path through it lengthens with its slant
	let absorption = mix(c.absorption_far.rgb, c.absorption.rgb, min(thickness / max(c.optics.x, 0.01), 1.0));
	let extinction = max(c.scattering.rgb + absorption, vec3f(1e-4));
	let transmittance = exp(-extinction * thickness);
	let ambient_in = column_inscatter(extinction * (1.0 + abs(v.y) * 1.394), thickness) * irradiance * (0.717 * c.optics.y);
	let cos_theta = dot(-v, frame.sun.xyz);
	let phase = mix(water_mie_phase(cos_theta), rayleigh_phase(cos_theta), c.optics.w);
	// the sun's light that the surface lets in
	let slant = 1.0 - dot(frame.sun.xyz, n);
	let entry = max(abs(0.98 - 0.98 * slant * slant * slant * slant * slant), 0.1);
	let sun_extinction = extinction * (1.0 + abs(v.y / max(frame.sun.y, 0.05)));
	let sun_in = column_inscatter(sun_extinction, thickness) * sun * phase * entry;
	let inscatter = c.scattering.rgb * (ambient_in + sun_in);

	// reflection: what the screen-space march finds, else the sky reflection
	let roughness = max(c.surface.x, 0.02);
	let n_dot_v = clamp(dot(n, v), 1e-4, 1.0);
	let r = reflect(-v, n);
	var sky = ambient_probe(r);
	if (frame.ambient.z > 0.5) {
		sky = textureSampleLevel(reflection_map, reflection_sampler, r, roughness * frame.ambient.w).rgb;
	}
	sky *= reflection_normalisation(irradiance, n) * frame.ambient.x * c.surface.w;
	var reflected = sky;
	var found = 0.0;
	if (post.reflections.x > 0.5) {
		let hit = ssr_trace(in.rel, r, n, in.position.xy);
		if (hit.confidence > 0.0) {
			reflected = mix(sky, textureLoad(background, vec2i(hit.uv * size), 0).rgb, hit.confidence);
			found = hit.confidence;
		}
	}
	let f0 = vec3f(c.surface.y);
	let specular_weight = environment_brdf(f0, roughness, n_dot_v);

	// the sun's highlight
	var highlight = vec3f(0.0);
	{
		let l = frame.sun.xyz;
		let n_dot_l = clamp(dot(n, l), 0.0, 1.0);
		let h = normalize(l + v);
		let a = roughness * roughness;
		let a2 = a * a;
		let brdf = fresnel_schlick(f0, clamp(dot(v, h), 0.0, 1.0)) * ggx_distribution(clamp(dot(n, h), 0.0, 1.0), a2) * smith_visibility(n_dot_v, n_dot_l, a2);
		highlight = min(brdf, vec3f(2048.0)) * n_dot_l * sun * c.layers.z;
	}

	var color = behind * transmittance + inscatter + reflected * specular_weight + highlight;
	// where the march found something, lean towards it over deep water, as the game does
	color = mix(color, reflected, specular_weight * (vec3f(1.0) - transmittance) * found);
	// the shore: shallow water fades into what's under it, more so at a distance seen from the side
	let edge = thickness * mix(1.0, abs(dot(v, n)), clamp(surface_distance * 0.05, 0.0, 1.0));
	color = mix(behind, color, clamp(edge * c.optics.z, 0.0, 1.0));
	let froxels = froxels_at(in.position.xy / size, surface_distance * dot(-v, post.forward.xyz));
	return vec4f(atmosphere_over(color, -v, surface_distance, froxels), 1.0);
}
