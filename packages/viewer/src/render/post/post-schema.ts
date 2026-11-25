/**
 * TypeGPU schema, bind group layout and helpers for the shared `Post` uniform buffer (group 0, binding 0).
 *
 * @module
 */

import tgpu, { d, std } from 'typegpu';

/** GPU schema of the shared `Post` uniform block */
export const PostSchema = d.struct({
	/** forward (unit), w = near plane (m) */
	forward: d.vec4f,
	/** right * aspect * tan(fovY / 2), w = pixels per metre at 1 m */
	right: d.vec4f,
	/** up * tan(fovY / 2), w = time (s) */
	up: d.vec4f,
	/** camera world position (m), w = frame index */
	eye: d.vec4f,
	/** width, height, 1 / width, 1 / height (px) */
	viewport: d.vec4f,
	/** towards the sun that lights the scene; w = 1 when it shines */
	sun: d.vec4f,
	/** the scene sun's pre-exposed illuminance, linear rgb */
	sunIlluminance: d.vec4f,
	/** towards the sun the sky is lit by */
	skySun: d.vec4f,
	/** what the sky-view LUT is multiplied by (pre-exposed), w unused */
	skyIlluminance: d.vec4f,
	/** atmosphere (km): bottom radius, top radius, Mie anisotropy, multiple-scattering factor */
	planet: d.vec4f,
	/** Rayleigh scattering (per km), w = exponential distribution (km) */
	rayleigh: d.vec4f,
	/** Mie scattering (per km), w = exponential distribution (km) */
	mieScattering: d.vec4f,
	/** Mie extinction (per km) */
	mieExtinction: d.vec4f,
	/** ozone absorption (per km), w = tent tip altitude (km) */
	ozone: d.vec4f,
	/** x = tent tip value, y = tent width (km) */
	ozoneTent: d.vec4f,
	groundAlbedo: d.vec4f,
	/** height fog layers in the game's base-2 units: density, falloff, height (m), unused */
	fogLayer0: d.vec4f,
	fogLayer1: d.vec4f,
	/** fog inscattered radiance (pre-exposed), w = least transmittance (1 - max opacity) */
	fogColor: d.vec4f,
	/** start distance (m), start transition (per m), cutoff distance (m), cutoff transition (per m) */
	fogRange: d.vec4f,
	/** directional inscattered radiance (pre-exposed), w = exponent */
	fogDirectional: d.vec4f,
	unused21: d.vec4f,
	unused22: d.vec4f,
	/** ambient occlusion: radius (m), intensity, power, enabled */
	ao: d.vec4f,
	/** bloom threshold: linear threshold t, t - knee, 2 * knee, 1 / (4 * knee) */
	bloom: d.vec4f,
	/** bloom tint (luminance 1), w = intensity (2^intensity - 1) */
	bloomTint: d.vec4f,
	/** exposure multiplier, vignette intensity, vignette smoothness, tonemapper (0 game, 1 PBR Neutral, 2 none) */
	grade: d.vec4f,
	/** x = sky, y = height fog, z = atmosphere fog, w = bloom */
	flags: d.vec4u,
	/** ambient occlusion falloff (fraction of radius), sample distribution power, thin-occluder compensation */
	aoShape: d.vec4f,
	/** vignette colour (linear), w = roundness */
	vignetteColor: d.vec4f,
	/** vignette centre (uv), z = 1 when rounded */
	vignetteCenter: d.vec4f,
	/** cloud layer: rotation (rad), contrast, 1 = singleChannel, w = 1 with cloud layer */
	cloud: d.vec4f,
	/** multiplies the cloud texel (`_CloudTint`) */
	cloudTint: d.vec4f,
	/** opacity of R and G layers, z = 1 when clouds cover planets, w = 1 to show raw texture */
	cloudShape: d.vec4f,
	/** towards the light the fog's directional inscattering comes from, w = start distance (m) */
	fogDirectionalDirection: d.vec4f,
	/** atmosphere fog: towards its sun, w = Mie anisotropy */
	atmoSun: d.vec4f,
	/** extinction (per km), w = fog-free distance (km) */
	atmoExtinction: d.vec4f,
	/** Rayleigh-scattered sun over extinction (pre-exposed), w = km of fog per metre of distance */
	atmoRayleigh: d.vec4f,
	/** Mie-scattered sun over extinction, w = 1 / falloff height (per m) */
	atmoMie: d.vec4f,
	/** scattered ambient over extinction, w = start height / falloff height */
	atmoAmbient: d.vec4f,
	/** sky dome distance (m), atmosphere fog on, unused, unused */
	skyFog: d.vec4f,
	/** colour grading (`_ColorGradingCB`): white balance (LMS), w = post exposure multiplier */
	colorBalance: d.vec4f,
	/** linear colour filter */
	colorFilter: d.vec4f,
	/** hue shift (turns), saturation, contrast */
	hueSatCon: d.vec4f,
	/** rows of the channel mixer */
	mixerRed: d.vec4f,
	mixerGreen: d.vec4f,
	mixerBlue: d.vec4f,
	shadows: d.vec4f,
	midtones: d.vec4f,
	highlights: d.vec4f,
	/** shadows start and end, highlights start and end */
	shaHiLimits: d.vec4f,
	lift: d.vec4f,
	gamma: d.vec4f,
	gain: d.vec4f,
	/** split toning tints; w = balance */
	splitShadows: d.vec4f,
	splitHighlights: d.vec4f,
	/** bloom: 1 to take thresholded part out of scene, scatter */
	bloomShape: d.vec4f,
	/** xy = main pass subpixel jitter (NDC) for TAA, z = CAS sharpening, w unused */
	jitter: d.vec4f,
	/** volumetric fog: w = depth it covers (m), 0 when off */
	froxelSlices: d.vec4f,
	/** x = view depth (m) nearer than which there is no volumetric fog, yzw unused */
	froxelRange: d.vec4f,
	/** x = 1 with screen-space reflections, yzw unused */
	reflections: d.vec4f,
	/** height fog flow noise: scrolled repeats, w = intensity (0 when off) */
	flowNoise: d.vec4f,
	/** x = texture repeats per metre, y = 1 / fadeout distance (m), zw unused */
	flowNoiseScale: d.vec4f,
});

/** byte size of {@link PostSchema} */
export const POST_BYTES = d.sizeOf(PostSchema);

const slotOffset = (key: keyof typeof PostSchema.propTypes): number =>
	d.memoryLayoutOf(PostSchema, (s) => s[key]).offset / 16;

/** vec4 (16-byte row) index of each {@link PostSchema} field, derived from the GPU layout */
export const PostSlot = {
	forward: slotOffset('forward'),
	right: slotOffset('right'),
	up: slotOffset('up'),
	eye: slotOffset('eye'),
	viewport: slotOffset('viewport'),
	sun: slotOffset('sun'),
	sunIlluminance: slotOffset('sunIlluminance'),
	skySun: slotOffset('skySun'),
	skyIlluminance: slotOffset('skyIlluminance'),
	planet: slotOffset('planet'),
	rayleigh: slotOffset('rayleigh'),
	mieScattering: slotOffset('mieScattering'),
	mieExtinction: slotOffset('mieExtinction'),
	ozone: slotOffset('ozone'),
	ozoneTent: slotOffset('ozoneTent'),
	groundAlbedo: slotOffset('groundAlbedo'),
	fogLayer0: slotOffset('fogLayer0'),
	fogLayer1: slotOffset('fogLayer1'),
	fogColor: slotOffset('fogColor'),
	fogRange: slotOffset('fogRange'),
	fogDirectional: slotOffset('fogDirectional'),
	ao: slotOffset('ao'),
	bloom: slotOffset('bloom'),
	bloomTint: slotOffset('bloomTint'),
	grade: slotOffset('grade'),
	flags: slotOffset('flags'),
	aoShape: slotOffset('aoShape'),
	vignetteColor: slotOffset('vignetteColor'),
	vignetteCenter: slotOffset('vignetteCenter'),
	cloud: slotOffset('cloud'),
	cloudTint: slotOffset('cloudTint'),
	cloudShape: slotOffset('cloudShape'),
	fogDirectionalDirection: slotOffset('fogDirectionalDirection'),
	atmoSun: slotOffset('atmoSun'),
	atmoExtinction: slotOffset('atmoExtinction'),
	atmoRayleigh: slotOffset('atmoRayleigh'),
	atmoMie: slotOffset('atmoMie'),
	atmoAmbient: slotOffset('atmoAmbient'),
	skyFog: slotOffset('skyFog'),
	colorBalance: slotOffset('colorBalance'),
	colorFilter: slotOffset('colorFilter'),
	hueSatCon: slotOffset('hueSatCon'),
	mixerRed: slotOffset('mixerRed'),
	mixerGreen: slotOffset('mixerGreen'),
	mixerBlue: slotOffset('mixerBlue'),
	shadows: slotOffset('shadows'),
	midtones: slotOffset('midtones'),
	highlights: slotOffset('highlights'),
	shaHiLimits: slotOffset('shaHiLimits'),
	lift: slotOffset('lift'),
	gamma: slotOffset('gamma'),
	gain: slotOffset('gain'),
	splitShadows: slotOffset('splitShadows'),
	splitHighlights: slotOffset('splitHighlights'),
	bloomShape: slotOffset('bloomShape'),
	jitter: slotOffset('jitter'),
	froxelSlices: slotOffset('froxelSlices'),
	froxelRange: slotOffset('froxelRange'),
	reflections: slotOffset('reflections'),
	flowNoise: slotOffset('flowNoise'),
	flowNoiseScale: slotOffset('flowNoiseScale'),
} as const;

/** group 0 bind group layout for post-processing passes reading the shared `Post` uniform buffer */
export const postUniformLayout = tgpu.bindGroupLayout({
	post: { uniform: PostSchema },
});

/**
 * camera-relative direction through an unjittered NDC position, scaled so its forward component is 1.
 *
 * @param ndc unjittered NDC coordinates
 * @returns camera-relative view ray
 */
export const viewRayNdc = tgpu.fn(
	[d.vec2f],
	d.vec3f,
)((ndc) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	return std.add(std.add(post.forward.xyz, std.mul(ndc.x, post.right.xyz)), std.mul(ndc.y, post.up.xyz));
});

/**
 * direction through a position of the main pass's (jittered) targets.
 *
 * @param uv top-left screen UV in `[0, 1]^2`
 * @returns camera-relative view ray
 */
export const viewRay = tgpu.fn(
	[d.vec2f],
	d.vec3f,
)((uv) => {
	'use gpu';
	const post = postUniformLayout.$.post;
	return viewRayNdc(std.sub(d.vec2f(uv.x * 2 - 1, 1 - uv.y * 2), post.jitter.xy));
});

/**
 * converts reversed-Z infinite-far depth (`depth = near / viewDepth`) to linear view depth in metres.
 *
 * @param depth reversed-Z depth sample
 * @returns linear view depth in metres
 */
export const viewDepth = tgpu.fn(
	[d.f32],
	d.f32,
)((depth) => {
	'use gpu';
	return postUniformLayout.$.post.forward.w / std.max(depth, 1e-9);
});
