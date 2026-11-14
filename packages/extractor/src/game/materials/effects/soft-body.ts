/**
 * `_VAT_SOFTBODY`, the Houdini vertex animation VFXBaseV2 and VFXWater share
 * (`docs/game-data/effects.md#soft-body-animation`)
 */

import type { EffectSoftBody, UnsupportedSurface } from '@endfield-noclip/package-format/surfaces';

import { type MaterialReader, unsupported } from '../material-values.ts';

/**
 * the factor a Houdini VAT bound encodes in its digits, as the shader computes it in f32: `1 + x − ceil(x)`
 * for `x = 10 · bound`, which is 1 for the bounds seen
 */
const vatPadding = (bound: number): number => {
	const x = Math.fround(Math.fround(bound) * 10);
	return Math.fround(Math.fround(1 - Math.ceil(x)) + x);
};

/**
 * @param reader a material with `_VAT_SOFTBODY`
 * @returns whether its textures store the values themselves (`_TextureFormat` 1) rather than 8-bit fractions
 */
export const softBodyHdr = (reader: MaterialReader): boolean => reader.float('_TextureFormat', 0) !== 0;

/**
 * `_VAT_SOFTBODY`'s animation: the position texture's offset at UV1's column and the frame's row
 *
 * @param reader a material with the keyword
 * @returns the animation, or `unsupported` when particle data drives it or its position texture is unset
 */
export const softBodyOf = (reader: MaterialReader): EffectSoftBody | UnsupportedSurface => {
	const { float } = reader;
	if (float('_HoudiniVATInParticle', 0) !== 0) {
		return unsupported('a soft-body animation driven by particle data');
	}
	const position = reader.slot('_PositionTexture');
	if (position === undefined) {
		return unsupported('a soft-body animation without its position texture');
	}
	const frameCount = Math.max(Math.round(float('_frameCount', 0)), 1);
	const min: [number, number, number] = [
		float('_boundMinX', 0),
		float('_boundMinY', 0),
		float('_boundMinZ', 0),
	];
	const max = [float('_boundMaxX', 0), float('_boundMaxY', 0), float('_boundMaxZ', 0)];
	// HDR textures store the offsets themselves; 8-bit ones a fraction of the bounds
	const hdr = softBodyHdr(reader);
	// the shader takes the frame from `_displayFrame` (1-based) unless it plays back on its own
	let fixedFrame: number | null = null;
	if (float('_B_autoPlayback', 0) === 0) {
		const frame = Math.floor(float('_displayFrame', 0)) - 1;
		fixedFrame = ((frame % frameCount) + frameCount) % frameCount;
	}
	return {
		texture: position.texture,
		min: hdr ? [0, 0, 0] : min,
		range: hdr ? [1, 1, 1] : [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
		frameCount,
		cycleRate: (float('_houdiniFPS', 0) / (frameCount - 0.01)) * float('_playbackSpeed', 1),
		cycleStart: float('_gameTimeAtFirstFrame', 0),
		fixedFrame,
		uScale: vatPadding(min[2]),
		vScale: vatPadding(max[0]),
	};
};
