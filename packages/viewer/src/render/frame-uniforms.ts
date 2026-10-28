/**
 * the TS side of `frame.wgsl`'s `Frame` struct.
 *
 * @module
 */

import frameWgsl from './shaders/frame.wgsl?raw';

/** WGSL source of the frame uniforms and shared lighting helpers, prepended to every family */
export const FRAME_WGSL = frameWgsl;

/** byte size of `Frame` */
export const FRAME_UNIFORM_BYTES = 192;

/** float offsets of `Frame` fields */
export const FrameOffsets = {
	viewProj: 0,
	eye: 16,
	sun: 20,
	viewport: 24,
	terrain: 28,
	cells: 32,
	fog: 36,
	/** u32 */
	flags: 40,
	params: 44,
} as const;

/** fog colour, linear */
export const FOG_COLOUR: [r: number, g: number, b: number] = [0.52, 0.62, 0.74];

/** @returns the clear colour matching the fog after display encoding */
export const clearColour = (): GPUColor => {
	const [r, g, b] = FOG_COLOUR.map((c) => c ** (1 / 2.2));
	return { r, g, b, a: 1 };
};
