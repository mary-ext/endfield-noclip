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
export const FRAME_UNIFORM_BYTES = 576;

/** float offsets of `Frame` fields */
export const FrameOffsets = {
	viewProj: 0,
	eye: 16,
	sun: 20,
	sunColour: 24,
	/** 7 vec4s */
	sh: 28,
	ambient: 56,
	viewport: 60,
	terrain: 64,
	/** u32 */
	flags: 68,
	params: 72,
	/** three mat4s */
	shadowMatrices: 76,
	shadowSplits: 124,
	shadowParams: 128,
	/** three vec4s: irradiance clipmap centres, w = filled */
	irradiance: 132,
} as const;

/**
 * what the viewer shows instead of the lit image, in the order of their `Frame.flags.y` codes: material
 * channels, and `clouds`, the raw cloud panorama in place of the sky
 */
export const DEBUG_VIEWS = ['lit', 'albedo', 'normals', 'roughness', 'ambient', 'clouds'] as const;

export type DebugView = (typeof DEBUG_VIEWS)[number];
