// the sun's lens flare (SRP core's data-driven lens flare, as the game ports it): one quad per element copy,
// laid out by lens-flare.ts in SRP core's screen frame (x right, y down, −1 to 1), faded by how much of a disc
// around the sun shows sky, and blended onto the composited scene.

struct FlareFrame {
	// occlusion disc radius (viewport units), sample count, 1 with the occlusion test, height / width
	occlusion: vec4f,
}

// one quad: SRP core's _FlareData0, _FlareData2, _FlareColorValue and _FlareData3
struct FlareQuad {
	// the quad's rotation (cos, sin) and its offset from the sun
	data0: vec4f,
	// the sun's position, the quad's half size (in units of the screen's height)
	data2: vec4f,
	color: vec4f,
	// off-screen (1 allowed, −1 hidden), circle edge, circle falloff exponent, 1 / side count
	data3: vec4f,
}

@group(0) @binding(0) var<uniform> frame: FlareFrame;
@group(0) @binding(1) var<storage, read> quads: array<FlareQuad>;
@group(0) @binding(2) var depth_texture: texture_depth_2d;
@group(1) @binding(0) var flare_texture: texture_2d<f32>;
@group(1) @binding(1) var flare_sampler: sampler;

struct FlareOut {
	@builtin(position) position: vec4f,
	@location(0) uv: vec2f,
	@location(1) @interpolate(flat) quad: u32,
	@location(2) occlusion: f32,
}

// SRP core's lens flare hash: a float in [0, 1) from an integer
fn flare_hash(seed: u32) -> f32 {
	var s = seed ^ 2747636419u;
	s *= 2654435769u;
	s ^= s >> 16u;
	s *= 2654435769u;
	s ^= s >> 16u;
	s *= 2654435769u;
	return f32(s) / 4294967296.0;
}

// the share of samples on a disc around the sun that land on sky; samples off screen count when the flare
// may show off screen
fn sun_visibility(sun: vec2f, allow_off_screen: bool) -> f32 {
	let samples = u32(frame.occlusion.y);
	if (frame.occlusion.z < 0.5 || samples == 0u) {
		return 1.0;
	}
	let size = vec2f(textureDimensions(depth_texture));
	var visible = 0.0;
	for (var i = 0u; i < samples; i++) {
		let r = sqrt(flare_hash(2u * i + 1u));
		let phi = 2.0 * PI * flare_hash(2u * i + 2u);
		let uv = (sun + frame.occlusion.x * r * vec2f(cos(phi), sin(phi))) * 0.5 + 0.5;
		if (all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0))) {
			let texel = vec2i(min(uv * size, size - 1.0));
			// reversed-Z: the sky is cleared to 0, behind everything drawn
			if (textureLoad(depth_texture, texel, 0) <= 0.0) {
				visible += 1.0;
			}
		} else if (allow_off_screen) {
			visible += 1.0;
		}
	}
	return visible / f32(samples);
}

const PI = 3.14159265358979;

@vertex
fn vs_flare(@builtin(vertex_index) vi: u32, @builtin(instance_index) instance: u32) -> FlareOut {
	let quad = quads[instance];
	let corner = vec2f(f32(vi & 1u), f32(vi >> 1u));
	let local_xy = (corner * 2.0 - 1.0) * quad.data2.zw;
	var local = vec2f(local_xy.x * quad.data0.x - local_xy.y * quad.data0.y,
		local_xy.x * quad.data0.y + local_xy.y * quad.data0.x);
	local.x *= frame.occlusion.w;
	let position = local + quad.data2.xy + quad.data0.zw;
	var out: FlareOut;
	// SRP core's frame has y down; clip space has it up
	out.position = vec4f(position.x, -position.y, 0.0, 1.0);
	// v runs with the frame's y, as Unity's quad texture coordinates do on Direct3D
	out.uv = corner;
	out.quad = instance;
	let allow_off_screen = quad.data3.x > 0.0;
	var occlusion = sun_visibility(quad.data2.xy, allow_off_screen);
	if (!allow_off_screen && (any(quad.data2.xy < vec2f(-1.0)) || any(quad.data2.xy >= vec2f(1.0)))) {
		occlusion = 0.0;
	}
	out.occlusion = occlusion;
	return out;
}

@fragment
fn fs_image(in: FlareOut) -> @location(0) vec4f {
	let quad = quads[in.quad];
	return textureSample(flare_texture, flare_sampler, in.uv) * quad.color * in.occlusion;
}

// a disc fading from its edge offset out to its rim, shaped by the falloff exponent
@fragment
fn fs_circle(in: FlareOut) -> @location(0) vec4f {
	let quad = quads[in.quad];
	let x = length(in.uv * 2.0 - 1.0);
	let sdf = clamp((x - 1.0) / (quad.data3.y - 1.0 + 1e-4), 0.0, 1.0);
	return pow(sdf, quad.data3.z) * quad.color * in.occlusion;
}
