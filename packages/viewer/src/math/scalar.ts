/**
 * @param x a value
 * @param lo the lower bound
 * @param hi the upper bound, at least `lo`
 * @returns `x` limited to `[lo, hi]`
 */
export const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

/**
 * @param index the element, from 1
 * @param base the sequence's base, a prime
 * @returns element `index` of the Halton sequence in `base`, in [0, 1)
 */
export const halton = (index: number, base: number): number => {
	let result = 0;
	let fraction = 1 / base;
	for (let i = index; i > 0; i = Math.floor(i / base)) {
		result += (i % base) * fraction;
		fraction /= base;
	}
	return result;
};

/**
 * @param time seconds of the viewer's clock
 * @param frameCount the animation's frames
 * @param frameRate its frames per second
 * @returns the two frames to blend and how far between them: the animation loops, the last frame blending
 *   into the first
 */
export const skinFrame = (
	time: number,
	frameCount: number,
	frameRate: number,
): { a: number; b: number; blend: number } => {
	const position = (((time * frameRate) % frameCount) + frameCount) % frameCount;
	const a = Math.min(Math.floor(position), frameCount - 1);
	return { a, b: (a + 1) % frameCount, blend: position - a };
};
