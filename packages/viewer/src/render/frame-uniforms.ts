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
	viewProj: 0,
	eye: 16,
	sun: 20,
	sunColor: 24,
	/** 7 vec4s */
	sh: 28,
	ambient: 56,
	viewport: 60,
	terrain: 64,
	/** u32 */
	flags: 68,
	params: 72,
	/** four mat4s */
	shadowMatrices: 76,
	shadowFade: 140,
	shadowPenumbra: 144,
	/** four vec4s */
	shadowSpheres: 148,
	shadowLook: 164,
	/** three vec4s: irradiance clipmap centres, w = filled */
	irradiance: 168,
	/** light count, tiles across and down, near plane */
	localLights: 180,
	viewForward: 184,
	renderSize: 188,
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
