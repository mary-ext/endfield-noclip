/**
 * the TS side of `frame.wgsl`'s `Frame` struct.
 *
 * @module
 */

import brdfWgsl from './shaders/brdf.wgsl?raw';
import frameWgsl from './shaders/frame.wgsl?raw';

/** WGSL source of the frame uniforms and shared lighting helpers, prepended to every family */
export const FRAME_WGSL = brdfWgsl + frameWgsl;

/** byte size of `Frame` */
export const FRAME_UNIFORM_BYTES = 880;

/** float offsets of `Frame` fields */
export const FrameOffsets = {
	// camera
	viewProj: 0,
	eye: 16,
	viewForward: 20,
	viewport: 24,
	renderSize: 28,
	// lighting
	sun: 32,
	sunColor: 36,
	/** 7 vec4s */
	sh: 40,
	ambient: 68,
	/** three vec4s: irradiance clipmap centres, w = filled */
	irradiance: 72,
	/** light count, tiles across and down, near plane */
	localLights: 84,
	// terrain and debug
	terrain: 88,
	/** u32 */
	flags: 92,
	params: 96,
	// shadows
	/** four mat4s */
	shadowMatrices: 100,
	shadowFade: 164,
	shadowPenumbra: 168,
	/** four vec4s */
	shadowSpheres: 172,
	shadowLook: 188,
	// weather
	/** four vec4s, see `Frame.cloud_shadow` */
	cloudShadow: 192,
	/** three vec4s, see `Frame.wetness` */
	wetness: 208,
} as const;

/**
 * what the viewer shows instead of the lit image, in the order of their `Frame.flags.y` codes: material
 * channels, and `clouds`, the raw cloud panorama in place of the sky
 */
export const DEBUG_VIEWS = ['lit', 'albedo', 'normals', 'roughness', 'ambient', 'clouds'] as const;

export type DebugView = (typeof DEBUG_VIEWS)[number];
