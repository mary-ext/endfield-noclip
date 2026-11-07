// the fog as the game's deferred lighting and sky apply it (docs/game-data/sky-and-fog.md#fog), and as its
// transparent shaders apply it to themselves: the atmosphere fog, then the two-layer height fog, in the game's
// own units, with the volumetric fog (volumetric-fog.wgsl) in front when it's on. the froxels then cover the ray
// out to the fog's distance in view depth, and the height fog only what lies beyond. needs post-common.wgsl and
// a filtering `lut_sampler`; `fogSource` in fog-source.ts places the froxels' binding.

// the volumetric fog integrated up to each slice: scattered light (rgb) and transmittance (a)
@group(1) @binding(5) var froxel_texture: texture_3d<f32>;

// one height-fog layer's density along a ray from `base_y`, per metre of ray: Unreal's base-2 form of the
// line integral, with its series near zero
fn fog_layer_density(layer: vec4f, base_y: f32, delta_y: f32) -> f32 {
	let x = max(-127.0, layer.y * delta_y);
	var integral = 0.693147182 - 0.240226507 * x;
	if (abs(x) > 5.96e-8) {
		integral = (1.0 - exp2(-x)) / x;
	}
	return layer.x * exp2(-max(-127.0, layer.y * (base_y - layer.z))) * integral;
}

struct Fog {
	// what the colour behind is multiplied by
	transmittance: vec3f,
	// what's added in front
	inscatter: vec3f,
}

// the volumetric fog in front of a point
struct Froxels {
	// scattered light (rgb) and transmittance (a)
	light: vec4f,
	// view depth (m) the froxels cover, which the height fog leaves out
	covered: f32,
}

// for rays the froxel grid doesn't hold (reflections): the height fog all the way
const NO_FROXELS = Froxels(vec4f(0.0, 0.0, 0.0, 1.0), 0.0);

// the volumetric fog in front of something `depth` metres of view depth away, at `uv` on screen
fn froxels_at(uv: vec2f, depth: f32) -> Froxels {
	if (post.froxel_slices.w <= 0.0) {
		return NO_FROXELS;
	}
	// as in the game, nothing nearer than the start distance
	if (depth < post.froxel_range.x) {
		return Froxels(vec4f(0.0, 0.0, 0.0, 1.0), post.froxel_slices.w);
	}
	let w = log2(depth * post.froxel_slices.x + post.froxel_slices.y) * post.froxel_slices.z;
	return Froxels(textureSampleLevel(froxel_texture, lut_sampler, vec3f(uv, w), 0.0), post.froxel_slices.w);
}

// the fog between the camera and something `distance` metres along unit `direction`
fn fog_over(direction: vec3f, distance: f32, froxels: Froxels) -> Fog {
	var fog = Fog(vec3f(1.0), vec3f(0.0));
	let point_y = post.eye.y + direction.y * distance;

	// atmosphere fog: density e^((start height − y) / H), integrated from the camera's height
	var atmosphere = vec3f(1.0);
	if (post.flags.z != 0u && post.sky_fog.y > 0.5) {
		let below = -point_y * post.atmo_mie.w;
		let a = max(0.01, below + post.eye.y * post.atmo_mie.w);
		let depth = max(0.0, distance * post.atmo_rayleigh.w - post.atmo_extinction.w) * ((1.0 - exp(-a)) / a) *
			exp(below + post.atmo_ambient.w);
		atmosphere = exp(-post.atmo_extinction.rgb * depth);
		let mu = dot(direction, post.atmo_sun.xyz);
		let g = post.atmo_sun.w;
		let hg_base = 1.0 + g * g - 2.0 * g * mu;
		let hg = (1.0 - g * g) / max(4.0 * PI * hg_base * sqrt(hg_base), 0.001);
		let rayleigh = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
		let scattered = clamp(post.atmo_rayleigh.rgb * rayleigh + post.atmo_ambient.rgb + post.atmo_mie.rgb * hg,
			vec3f(0.0), vec3f(255.0));
		fog = Fog(atmosphere, scattered * (vec3f(1.0) - atmosphere));
	}

	// height fog: fades in past the start distance and out past the cutoff, each over 1 / transition metres.
	// it integrates only the part of the ray past the froxels (a negative length leaves it clear); the ramps
	// and the opacity cap still measure the whole distance
	if (post.flags.y != 0u) {
		let cosine = dot(direction, post.forward.xyz);
		var covered = 0.0;
		if (cosine > 5.96e-8) {
			covered = froxels.covered / cosine / distance;
		}
		let delta_y = direction.y * distance;
		let base_y = post.eye.y + covered * delta_y;
		let rest_y = delta_y * (1.0 - covered);
		let rest = distance * (1.0 - covered);
		let density = fog_layer_density(post.fog_layer0, base_y, rest_y) +
			fog_layer_density(post.fog_layer1, base_y, rest_y);
		let range = post.fog_range;
		let before_start = clamp((range.x - distance) * range.y, 0.0, 1.0);
		let past_cutoff = clamp((distance - range.z) * range.w, 0.0, 1.0);
		let t = clamp(max(clamp(exp2(-density * rest), 0.0, 1.0), post.fog_color.w) + before_start + past_cutoff,
			0.0, 1.0);
		let toward_light = clamp(dot(direction, post.fog_directional_direction.xyz), 0.0, 1.0);
		let directional_depth = density * max(rest - post.fog_directional_direction.w, 0.0);
		let directional = post.fog_directional.rgb * pow(toward_light, post.fog_directional.w) *
			(1.0 - clamp(exp2(-directional_depth), 0.0, 1.0)) * (1.0 - past_cutoff);
		fog = Fog(fog.transmittance * t, fog.inscatter * t + post.fog_color.rgb * (1.0 - t) + directional);
	}
	// the froxels add in front of both
	let light = froxels.light;
	return Fog(fog.transmittance * light.a, fog.inscatter * light.a + light.rgb);
}

// a premultiplied layer of opacity `alpha` at camera-relative `rel`, drawn at `uv` on screen, fogged as the
// game's transparent shaders fog themselves: their straight colour `c` becomes `c · transmittance +
// inscatter` before it's weighted by `alpha`
fn fog_premultiplied(premultiplied: vec3f, alpha: f32, rel: vec3f, uv: vec2f) -> vec3f {
	let distance = length(rel);
	if (distance <= 0.0) {
		return premultiplied;
	}
	let direction = rel / distance;
	let fog = fog_over(direction, distance, froxels_at(uv, dot(rel, post.forward.xyz)));
	return premultiplied * fog.transmittance + fog.inscatter * alpha;
}
