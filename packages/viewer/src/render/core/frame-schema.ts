/**
 * TypeGPU schema for the per-pass `Frame` uniform buffer shared by every rendering family (group 0, binding
 * 0).
 *
 * @module
 */

import { d } from 'typegpu';

/** GPU schema of the per-pass `Frame` uniform block */
export const FrameSchema = d.struct({
	// #region camera
	/** camera-relative view-projection: reversed-Z, infinite far plane */
	viewProj: d.mat4x4f,
	/** camera world position (f32, for world-space lookups only), w = time (s) */
	eye: d.vec4f,
	/** the camera's unit forward, right and up vectors, w unused */
	viewForward: d.vec4f,
	viewRight: d.vec4f,
	viewUp: d.vec4f,
	/**
	 * output width, height (px), pixel factor (output px per metre at 1 m), minimum projected instance size
	 * (px)
	 */
	viewport: d.vec4f,
	/** render width, height (px), then inner and outer fire-seed reveal radii (m) */
	renderSize: d.vec4f,
	// #endregion
	// #region lighting
	/** direction towards the sun, w = 1 when the sun casts light */
	sun: d.vec4f,
	/** sun illuminance (pre-exposed lux, linear rgb), w = specular intensity */
	sunColor: d.vec4f,
	/** the ambient probe in Unity's shader form: SHAr, SHAg, SHAb, SHBr, SHBg, SHBb, SHC */
	sh: d.arrayOf(d.vec4f, 7),
	/** x = indirect specular factor, y = 1 / post exposure, z = 1 with reflection cubemap, w = max mip */
	ambient: d.vec4f,
	/** world position of each irradiance clipmap level's centre (0.5 m, 2 m, 8 m), w = 1 once filled */
	irradiance: d.arrayOf(d.vec4f, 3),
	/** this frame's local lights: count, screen tiles across and down, near plane (m) */
	localLights: d.vec4f,
	// #endregion
	// #region terrain and debug
	/** terrain: zero-sample height relative to eye, metres per height unit, hole bit (u32 bits), 0 */
	terrain: d.vec4f,
	/** x = wireframe, y = debug view, z, w reserved */
	flags: d.vec4u,
	/** x = outline threshold (m), y = material mip bias, z = indirectDiffuseFactor, w = TAA jitter phase */
	params: d.vec4f,
	// #endregion
	// #region shadows
	/** camera-relative position -> shadow map [0, 1]^2 x depth, per layer (3 sharp cascades + far) */
	shadowMatrices: d.arrayOf(d.mat4x4f, 4),
	/** x = sharp cascades' reach^2 (m^2), y = 1 / (reach^2 - fade start^2), z reserved, w = 1 when shadows on */
	shadowFade: d.vec4f,
	/** xyz = each sharp cascade's filter radius (shadow map uv), w reserved */
	shadowPenumbra: d.vec4f,
	/** each layer's bounding sphere: camera-relative centre, w = radius^2 */
	shadowSpheres: d.arrayOf(d.vec4f, 4),
	/** x = strength, y = fixed attenuation blend, z = fixed attenuation, w = 1 with penumbra ramp */
	shadowLook: d.vec4f,
	// #endregion
	// #region weather
	/** cloud shadow parameters (`Environment.cloudShadow`) */
	cloudShadow: d.arrayOf(d.vec4f, 4),
	/** rain wetness parameters (`wetness.ts`) */
	wetness: d.arrayOf(d.vec4f, 3),
	/** wind (`_WindGlobalParams0`): x = wind clock, y = main intensity, zw = unit XZ direction */
	wind: d.vec4f,
	/** irradiance volume default L1 SH (`_IVDefaultSHAr/g/b`), pre-scaled */
	ivDefaultSh: d.arrayOf(d.vec4f, 3),
	/** luminance L1 SH of `skyAmbientSH` (`_ReflectionProbeGlobalParam3`) */
	reflectionProbeSh: d.vec4f,
	/** local reflection probes: x = active count (0..32), y = cube-array max mip level, zw unused */
	reflectionProbes: d.vec4f,
	// #endregion
	// #region previous frame (dynamic motion vectors)
	/** last frame's unjittered camera-relative view-projection */
	prevViewProj: d.mat4x4f,
	/** this frame's eye minus last frame's (m); w = 1 when there is no previous frame */
	prevEyeDelta: d.vec4f,
	/** x = last frame's animation time (s), y = last frame's wind clock, zw unused */
	prevTime: d.vec4f,
	// #endregion
});

/** byte size of {@link FrameSchema} */
export const FRAME_UNIFORM_BYTES = d.sizeOf(FrameSchema);

const wordOffset = (key: keyof typeof FrameSchema.propTypes): number =>
	d.memoryLayoutOf(FrameSchema, (s) => s[key]).offset / 4;

/** float (4-byte word) offsets of {@link FrameSchema} fields, derived from the GPU layout */
export const FrameOffsets = {
	viewProj: wordOffset('viewProj'),
	eye: wordOffset('eye'),
	viewForward: wordOffset('viewForward'),
	viewRight: wordOffset('viewRight'),
	viewUp: wordOffset('viewUp'),
	viewport: wordOffset('viewport'),
	renderSize: wordOffset('renderSize'),
	sun: wordOffset('sun'),
	sunColor: wordOffset('sunColor'),
	sh: wordOffset('sh'),
	ambient: wordOffset('ambient'),
	irradiance: wordOffset('irradiance'),
	localLights: wordOffset('localLights'),
	terrain: wordOffset('terrain'),
	flags: wordOffset('flags'),
	params: wordOffset('params'),
	shadowMatrices: wordOffset('shadowMatrices'),
	shadowFade: wordOffset('shadowFade'),
	shadowPenumbra: wordOffset('shadowPenumbra'),
	shadowSpheres: wordOffset('shadowSpheres'),
	shadowLook: wordOffset('shadowLook'),
	cloudShadow: wordOffset('cloudShadow'),
	wetness: wordOffset('wetness'),
	wind: wordOffset('wind'),
	ivDefaultSh: wordOffset('ivDefaultSh'),
	reflectionProbeSh: wordOffset('reflectionProbeSh'),
	reflectionProbes: wordOffset('reflectionProbes'),
	prevViewProj: wordOffset('prevViewProj'),
	prevEyeDelta: wordOffset('prevEyeDelta'),
	prevTime: wordOffset('prevTime'),
} as const;
