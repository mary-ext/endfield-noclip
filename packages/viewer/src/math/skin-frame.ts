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
