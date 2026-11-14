import type { ParticleEmitterMotion } from '@endfield-noclip/package-format/particles';

// an emitter a looping clip moves (docs/viewer/particles.md#moving-emitters): its frame at a clip time, relative
// to the frame its draw is placed in, as rows3x4 matrices

/**
 * @param motion the emitter's motion
 * @param time seconds of the viewer's clock, which the clip plays by from its start, as rigidly animated
 *   meshes do; it loops after its last frame
 * @param out written with the frame the clip holds then: frames step rather than blend, as the clip is kept
 *   at a rate where the emitter barely moves between them
 * @returns `out`
 */
export const emitterFrameInto = (
	motion: ParticleEmitterMotion,
	time: number,
	out: Float64Array,
): Float64Array => {
	const frames = motion.frames;
	const count = frames.length / 12;
	const position = (((Math.floor(time * motion.frameRate) % count) + count) % count) * 12;
	for (let i = 0; i < 12; i++) {
		out[i] = frames[position + i];
	}
	return out;
};

/**
 * multiplies two rows3x4 matrices, each an affine transform's three rows
 *
 * @param out written with `a · b`; may not be either
 * @param a the outer transform
 * @param b the inner transform
 * @returns `out`
 */
export const multiplyRowsInto = (
	out: Float64Array,
	a: Readonly<Float64Array>,
	b: Readonly<Float64Array>,
): Float64Array => {
	for (let row = 0; row < 3; row++) {
		const r = row * 4;
		for (let column = 0; column < 4; column++) {
			out[r + column] =
				a[r] * b[column] +
				a[r + 1] * b[4 + column] +
				a[r + 2] * b[8 + column] +
				(column === 3 ? a[r + 3] : 0);
		}
	}
	return out;
};
