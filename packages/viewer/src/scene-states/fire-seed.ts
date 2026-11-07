import type { FireSeedInfo } from '@endfield-noclip/package-format/manifest';

/**
 * the global reveal radii without a fire seed in the scene. the game's value before any level script sets one
 * isn't recovered; zero leaves the materials' own radii about the player
 */
export const NO_REVEAL: readonly [inner: number, outer: number] = [0, 0];

/**
 * @param info the package's fire seed, `null` without one
 * @param values every scene control's value, by index
 * @returns the global reveal radii the fire seed's current level sets (`Frame.render_size.zw`)
 */
export const revealRadii = (
	info: FireSeedInfo | null,
	values: readonly number[],
): readonly [inner: number, outer: number] => {
	if (info === null) {
		return NO_REVEAL;
	}
	return info.radii[values[info.control] ?? 0] ?? NO_REVEAL;
};
