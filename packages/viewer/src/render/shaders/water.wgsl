// open-world water, drawn after compositing over a copy of the scene and lit like the main pass (the frame's
// sun shadow, irradiance volume and sky reflection), with the game's water lighting: flowing wave normals that
// fade with distance, foam, the water column's absorption and scattering, caustics on the ground below, a
// distortion of the view through it, and reflections from the screen-space march or the sky. see
// docs/game-data/water.md. needs frame.wgsl, then post-common.wgsl (its uniforms at group 3), atmosphere.wgsl,
// sky.wgsl and ssr-trace.wgsl.

struct WaterSurface {
	// object-to-world rows, translation relative to the eye
	t0: vec4f,
	t1: vec4f,
	t2: vec4f,
	// position dequantization: offset, w = config index (u32 bits)
	offset: vec4f,
	// w = 1 when the mesh has normals
	scale: vec4f,
}

struct Config {
	// scattering per metre
	scattering: vec4f,
	// absorption per metre in deep and in shallow water
	absorption_deep: vec4f,
	absorption_shallow: vec4f,
	// x = depth (m) of full absorption, y = ambient light intensity, z = shore blend factor, w = Mie–Rayleigh mix
	optics: vec4f,
	// roughness, specular, distortion strength, sky reflection intensity
	surface: vec4f,
	// small waves: speed, tiling, normal scale, cycle
	small: vec4f,
	// large waves: speed (negative to reverse), tiling, normal scale, cycle
	large: vec4f,
	// flow direction xy (0–1 encoded, without a flow map), 1 to follow the flow map, the flow map option (1: its
	// alpha doesn't scale the waves)
	flow: vec4f,
	// layers of the wave normal array: small waves, large waves; z = the sun highlight normal's vertical scale,
	// w = how much the scene behind feeds the column's light
	layers: vec4f,
	// distance (m) over which the waves fade, the large waves' least strength, the normal array's mip bias, foam
	// roughness
	fade: vec4f,
	// foam colour (as authored), foam opacity
	foam: vec4f,
	// foam shape offset, 1 / foam fade distance (m), subsurface scale, emissive strength
	foam_shape: vec4f,
	// caustics: tiling, opacity, distortion, speed
	caustics: vec4f,
	// caustics' start and end depth (m), zw unused
	caustic_depths: vec4f,
}

@group(2) @binding(0) var<storage, read> surfaces: array<WaterSurface>;
@group(2) @binding(1) var<storage, read> configs: array<Config>;
@group(2) @binding(2) var background: texture_2d<f32>;
@group(2) @binding(3) var depth_texture: texture_depth_2d;
@group(2) @binding(4) var wave_normals: texture_2d_array<f32>;
@group(2) @binding(5) var flow_map: texture_2d<f32>;
@group(2) @binding(6) var repeat_sampler: sampler;
// [0]: x = 1 with wave normals, y = 1 with a flow map, z = flow map size (m), w = 1 with a caustic map;
// [1]: the flow map's centre (world xz), zw unused; [2]: the sun as the atmosphere fog takes it (raw colour,
// pre-exposed), w unused
@group(2) @binding(7) var<uniform> water: array<vec4f, 3>;
@group(2) @binding(8) var caustic_map: texture_2d<f32>;

// the in-water Mie lobe: Henyey–Greenstein with the game's anisotropy
fn water_mie_phase(cos_theta: f32) -> f32 {
	let g = 0.854;
	let x = 1.0 + g * g - 2.0 * g * cos_theta;
	return (1.0 - g * g) / max(4.0 * PI * x * sqrt(x), 0.001);
}

// Karis' environment BRDF with the game's water reflectance at grazing angles
fn water_environment_brdf(f0: f32, f90: f32, roughness: f32, n_dot_v: f32) -> f32 {
	let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
	let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
	let r = roughness * c0 + c1;
	let a004 = min(r.x * r.x, exp2(-9.28 * n_dot_v)) * r.x + r.y;
	let ab = vec2f(-1.04, 1.04) * a004 + r.zw;
	return clamp(f0 * ab.x + f90 * ab.y, 0.0, 1.0);
}

fn rgb_to_hsv(c: vec3f) -> vec3f {
	let p = select(vec4f(c.b, c.g, -1.0, 2.0 / 3.0), vec4f(c.g, c.b, 0.0, -1.0 / 3.0), c.b <= c.g);
	let q = select(vec4f(p.x, p.y, p.w, c.r), vec4f(c.r, p.y, p.z, p.x), p.x <= c.r);
	let d = q.x - min(q.w, q.y);
	return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-4)), d / (q.x + 1e-4), q.x);
}

struct VertexOut {
	@builtin(position) position: vec4f,
	@location(0) rel: vec3f,
	@location(1) normal: vec3f,
	@location(2) @interpolate(flat) config: u32,
}

@vertex
fn vs_water(@location(0) position: vec4f, @location(1) normal: vec2f, @builtin(instance_index) ii: u32) -> VertexOut {
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
	var n = vec3f(0.0, 1.0, 0.0);
	if (s.scale.w > 0.5) {
		let m = oct_decode(normal);
		n = vec3f(dot(s.t0.xyz, m), dot(s.t1.xyz, m), dot(s.t2.xyz, m));
	}
	out.normal = n;
	out.config = bitcast<u32>(s.offset.w);
	return out;
}

// where one layer of waves samples the normal array: two phases of the flow cross-fading (with a flow map), or
// one continuous scroll; xy and zw are the phases' uvs
struct WaveTaps {
	uv: vec4f,
	weights: vec2f,
}

fn wave_taps(p: vec2f, velocity: vec2f, tiling: f32, cycle: f32, progress: f32, flowing: bool) -> WaveTaps {
	if (!flowing) {
		return WaveTaps(vec4f((p - velocity * progress) * tiling, 0.0, 0.0), vec2f(1.0, 0.0));
	}
	let a = fract(progress);
	let b = fract(progress + 0.5);
	let uv_a = (p - velocity * a) * tiling + (progress - a) * cycle;
	let uv_b = (p - velocity * b) * tiling + 0.5 + (progress - b) * cycle;
	return WaveTaps(vec4f(uv_a, uv_b), vec2f(1.0 - abs(1.0 - 2.0 * a), 1.0 - abs(1.0 - 2.0 * b)));
}

// one wave layer's normal (xy scaled by `strength`, z from the unscaled xy, as the game does)
fn wave_normal(rg: vec2f, strength: f32) -> vec3f {
	let xy = rg * 2.0 - 1.0;
	return vec3f(xy * strength, max(1e-16, sqrt(1.0 - clamp(dot(xy, xy), 0.0, 1.0))));
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
	let n_geo = normalize(in.normal);
	let geo_n_dot_v = dot(v, n_geo);
	let time = post.up.w;
	// the waves (and the configured roughness's departure from a mirror) fade with distance, sooner at grazing
	// angles
	let near = max(0.0, 1.0 - clamp(surface_distance * clamp(1.0 - geo_n_dot_v, 0.0, 1.0) / max(c.fade.x, 1e-4), 0.0, 1.0));

	// the flow: rg the direction (green points along −z), b the foam, a the wave amplitude
	var flow = vec4f(0.5, 0.5, 0.0, 1.0);
	{
		let uv = (world.xz - water[1].xy) / max(water[0].z, 1.0) + 0.5;
		let sampled = textureSampleLevel(flow_map, repeat_sampler, uv, 0.0);
		flow = select(flow, sampled, water[0].y > 0.5);
	}
	let amplitude = select(flow.a, 1.0, c.flow.w == 1.0);
	let direction = (mix(c.flow.xy, flow.rg, c.flow.z) * 2.0 - 1.0) * vec2f(1.0, -1.0);
	let flowing = c.flow.z > 0.0;
	let bias = c.fade.z;

	// the waves, sampled in uniform control flow
	let small_taps = wave_taps(world.xz, direction * c.small.x, c.small.y, c.small.w, time * c.small.w, flowing);
	let large_taps =
		wave_taps(world.xz, direction * c.large.x, c.large.y, c.large.w, time * c.large.w + 0.5, flowing);
	let small_layer = i32(c.layers.x);
	let large_layer = i32(c.layers.y);
	let small = textureSampleBias(wave_normals, repeat_sampler, small_taps.uv.xy, small_layer, bias) * small_taps.weights.x +
		textureSampleBias(wave_normals, repeat_sampler, small_taps.uv.zw, small_layer, bias) * small_taps.weights.y;
	let large = textureSampleBias(wave_normals, repeat_sampler, large_taps.uv.xy, large_layer, bias) * large_taps.weights.x +
		textureSampleBias(wave_normals, repeat_sampler, large_taps.uv.zw, large_layer, bias) * large_taps.weights.y;
	var n = n_geo;
	if (water[0].x > 0.5) {
		// reoriented normal mapping of the two layers, in the surface's tangent frame
		let t = wave_normal(small.rg, c.small.z * near * amplitude * geo_n_dot_v) + vec3f(0.0, 0.0, 1.0);
		let u = wave_normal(large.rg, c.large.z * amplitude * max(c.fade.y, near)) * vec3f(-1.0, -1.0, 1.0);
		let m = normalize(t * dot(t, u) / max(t.z, 1e-5) - u);
		let tangent = vec3f(1.0, 0.0, 0.0);
		n = normalize(tangent * m.x + cross(tangent, n_geo) * m.y + n_geo * m.z);
	}
	// foam where the flow map marks it, shaped by the small waves' alpha
	let foam = flow.b * clamp(small.a - c.foam_shape.x, 0.0, 1.0) * c.foam.w *
		(1.0 - clamp(surface_distance * c.foam_shape.y, 0.0, 1.0)) * max(0.5, clamp(geo_n_dot_v, 0.0, 1.0));
	let foam_albedo = c.foam.rgb * foam;
	// a mirror near the camera, the configured roughness where the waves have faded, foam's own roughness
	let roughness = clamp(mix(mix(c.surface.x, 0.01, near), c.fade.w, foam), 0.0, 1.0);

	// the ground under the surface, straight through and through the distorting waves
	let uv_straight = in.position.xy / size;
	var ground_straight = 100000.0;
	{
		let depth = textureLoad(depth_texture, px, 0);
		if (depth > 0.0) {
			ground_straight = length(view_ray(uv_straight) * view_depth(depth));
		}
	}
	let straight = max(ground_straight - surface_distance, 0.0);
	var uv = uv_straight;
	var ground_rel = in.rel - v * straight;
	var ground_v = v;
	var thickness = straight;
	{
		// the game pushes the water point sideways by the waves, at most 0.5 m, less at the screen's edges and
		// within a metre of the camera, and looks at what lies under the pushed point
		let ndc = uv_straight * 2.0 - 1.0;
		let edge = min(1.0 - abs(ndc.x), 1.0 - abs(ndc.y));
		let k = mix(clamp((0.2 - edge) * 5.0, 0.0, 1.0), clamp(1.25 - edge, 0.0, 1.0),
			1.0 - clamp((surface_distance - 0.75) * 4.0, 0.0, 1.0));
		let bent = mix(normalize(vec3f(n.x * c.surface.z, n.y, n.z * c.surface.z)), vec3f(0.0, 1.0, 0.0), k);
		let pushed = in.rel + bent * vec3f(-1.0, 0.0, -1.0) * min(straight, 0.5);
		let projected = clamp(ssr_project(pushed).xy, vec2f(0.0), vec2f(1.0) - post.viewport.zw);
		let depth = ssr_device_depth(projected);
		var refracted = view_ray(projected) * 100000.0;
		if (depth > 0.0) {
			refracted = view_ray(projected) * view_depth(depth);
		}
		// unless that lands on something in front of the water
		if (dot(refracted - in.rel, v) <= 0.0) {
			let along = select(1000.0, length(refracted - in.rel), depth > 0.0);
			uv = projected;
			ground_rel = refracted;
			ground_v = normalize(-refracted);
			thickness = mix(along, mix(straight, along, clamp(straight - 0.5, 0.0, 1.0)),
				clamp(surface_distance - 20.0, 0.0, 1.0));
		}
	}
	thickness = min(thickness, 10000.0);

	// caustics on the ground, from the sun the atmosphere fog is lit by
	var caustics = vec3f(0.0);
	{
		let k = 0.02 / max(c.caustics.x, 1e-4);
		let distort = n.xz * c.caustics.z * 20.0 * k;
		let scroll = vec2f(time * 0.05 * k * c.caustics.w);
		let p = (ground_rel.xz + post.eye.xz) * c.caustics.x;
		let a = textureSample(caustic_map, repeat_sampler, p + distort + scroll).rgb;
		let b = textureSample(caustic_map, repeat_sampler, p * vec2f(1.0, -1.0) - distort + scroll).rgb;
		let view_z = surface_distance * dot(-v, post.forward.xyz);
		caustics = (max(a, b) + a * b * 100.0) * water[2].rgb * frame.sun.w * c.caustics.y *
			clamp(thickness - c.caustic_depths.x, 0.0, 1.0) * (1.0 - clamp(view_z * 0.02, 0.0, 1.0)) *
			(1.0 - clamp(thickness - c.caustic_depths.y, 0.0, 1.0)) * water[0].w;
	}

	if (ground_straight < surface_distance - 0.02) {
		discard;
	}

	let froxels = froxels_at(uv_straight, surface_distance * dot(-v, post.forward.xyz));
	let fog = fog_over(-v, surface_distance, froxels);
	let behind_raw = textureLoad(background, vec2i(uv * size), 0).rgb;
	let behind = behind_raw * (vec3f(1.0) + caustics * fog.transmittance);

	// the sun through the shadow, looked up where the waves bend it, and the irradiance volume
	let l = frame.sun.xyz;
	let visibility = sun_visibility(in.rel + vec3f(n.x, 0.0, n.z) * 2.0, n_geo, in.position.xy) * frame.sun.w;
	let irradiance = ambient_irradiance(world, n);

	// the sun on the surface: a highlight off a flattened normal, which widens the glitter path, plus the foam's
	// diffuse and see-through light. the game leaves out the 1 / π the viewer's sun takes everywhere
	var direct = vec3f(0.0);
	{
		let ns = normalize(vec3f(n.x, n.y * c.layers.z, n.z));
		let lp = l;
		let h_raw = lp + v;
		let h = h_raw * inverseSqrt(max(6.1e-5, dot(h_raw, h_raw)));
		let n_dot_l = clamp(dot(lp, ns), 0.0, 1.0);
		let n_dot_h = clamp(dot(ns, h), 0.0, 1.0);
		let n_dot_v = clamp(dot(ns, v), 0.0, 1.0);
		let a = roughness * roughness;
		let a2 = a * a;
		let dd = (n_dot_h * a2 - n_dot_h) * n_dot_h + 1.0;
		let f0 = 0.08 * c.surface.y;
		let fresnel = fresnel_schlick(vec3f(f0), clamp(dot(v, h), 0.0, 1.0));
		let visible = 0.5 / (n_dot_l * sqrt((-n_dot_v * a2 + n_dot_v) * n_dot_v + a2) +
			n_dot_v * sqrt((-n_dot_l * a2 + n_dot_l) * n_dot_l + a2) + 1e-4);
		let specular = clamp(min(fresnel * (a2 / (dd * dd)) * visible, vec3f(2048.0)) * frame.sun_color.w,
			vec3f(0.0), vec3f(1000.0)) * n_dot_l;
		// the foam glows through when lit from behind
		let hsv = rgb_to_hsv(foam_albedo);
		let value = hsv.z * c.foam_shape.z;
		let k = clamp(1.0 - value, 0.0, 1.0);
		let wrap = clamp(dot(ns, lp) * (2.0 / 3.0) + 1.0 / 3.0, 0.0, 1.0);
		let through = mix(mix(1.0, wrap * sqrt(wrap) * (5.0 / 3.0), k) / (2.0 * PI), 1.0,
			pow(clamp(-dot(v, lp), 0.0, 1.0), 12.0) * mix(3.0, 0.1, k));
		let subsurface = mix(vec3f(1.0), hue(hsv.x), hsv.y) * value * through;
		direct = (specular + subsurface + foam_albedo * n_dot_l) * frame.sun_color.rgb / PI * visibility;
	}

	// reflection: what the screen-space march finds, else the sky reflection
	let n_dot_v = clamp(dot(n, v), 0.0, 1.0);
	let r = reflect(-v, n);
	var sky = ambient_probe(r);
	if (frame.ambient.z > 0.5) {
		sky = textureSampleLevel(reflection_map, reflection_sampler, r, roughness * frame.ambient.w).rgb;
	}
	sky *= reflection_normalisation(irradiance, n) * frame.ambient.x * c.surface.w;
	var reflection = sky;
	var found = 0.0;
	if (post.reflections.x > 0.5) {
		let hit = ssr_trace(in.rel, r, n, in.position.xy);
		if (hit.confidence > 0.0) {
			reflection = mix(sky, textureLoad(background, vec2i(hit.uv * size), 0).rgb, hit.confidence);
			found = hit.confidence;
		}
	}
	let specular_weight = water_environment_brdf(0.08 * c.surface.y, clamp(4.0 * c.surface.y, 0.0, 1.0), roughness, n_dot_v);

	// the water column: each light's path through it lengthens with its slant
	let depth = min(thickness, 50.0);
	let extinction = max(c.scattering.rgb + mix(c.absorption_shallow.rgb, c.absorption_deep.rgb,
		clamp(depth / max(c.optics.x, 0.01), 0.0, 1.0)), vec3f(1e-4));
	let transmittance = exp(-extinction * depth);
	// the scene behind lights the column too
	let feed = behind * c.layers.w;
	let ambient_in = column_inscatter(extinction * (1.0 + abs(v.y) * 1.394), depth) * (irradiance + feed) *
		(0.717 * c.optics.y);
	let cos_theta = dot(-ground_v, l);
	let phase = mix(water_mie_phase(cos_theta), rayleigh_phase(cos_theta), c.optics.w);
	// the sun's light that the surface lets in; its slant uses the game's −20 · v.y for a risen sun
	let slant = 1.0 - dot(l, n);
	let entry = max(abs(0.98 - 0.98 * slant * slant * slant * slant * slant), 0.1);
	let sun_extinction = extinction * (1.0 + abs(v.y / max(0.05, -l.y)));
	let sun_in = column_inscatter(sun_extinction, depth) * phase * water[2].rgb * frame.sun.w * (vec3f(1.0) + feed) *
		entry * visibility;
	let inscatter = c.scattering.rgb * (ambient_in + sun_in);

	// the surface's own light is fogged at its distance; the scene behind already is, so only the fog's
	// in-scatter stands in for what the water hides of it
	let own = direct + reflection * specular_weight + irradiance * foam_albedo + inscatter;
	var color = own * fog.transmittance + behind * transmittance + fog.inscatter * (vec3f(1.0) - transmittance);
	// where the march found something, lean towards it over deep water
	color = mix(color, reflection, specular_weight * (vec3f(1.0) - transmittance) * found * fog.transmittance);
	color += c.foam.rgb * c.foam_shape.w * foam_albedo;
	// the shore: shallow water fades into what's under it, more so at a distance seen from the side
	let edge = thickness * mix(1.0, abs(dot(v, n)), clamp(surface_distance * 0.05, 0.0, 1.0));
	return vec4f(mix(behind, color, clamp(edge * c.optics.z, 0.0, 1.0)), 1.0);
}
