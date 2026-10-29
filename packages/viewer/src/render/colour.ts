/**
 * colour-space helpers for the game's colour fields
 *
 * @module
 */

import type { Color } from '@endfield-noclip/package-format/format';

import type { Vec3 } from '../scene/camera.ts';

/**
 * converts a sRGB-encoded colour channel (Unity colour fields) to linear
 *
 * @param c channel value
 * @returns the linear value
 */
export const srgbToLinear = (c: number): number => {
	if (c <= 0.04045) {
		return c / 12.92;
	}
	// HDR values: like Unity's `Mathf.GammaToLinearSpace`, a plain 2.2 power past 1
	return c < 1 ? ((c + 0.055) / 1.055) ** 2.4 : c ** 2.2;
};

/**
 * @param c a sRGB-encoded colour (alpha ignored)
 * @returns its linear rgb
 */
export const linearRgb = (c: Readonly<Color>): Vec3 => [
	srgbToLinear(c[0]),
	srgbToLinear(c[1]),
	srgbToLinear(c[2]),
];
