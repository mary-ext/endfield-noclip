import type { SceneControl } from './states.ts';
import type { Vec3 } from './values.ts';

/**
 * @param controls a package's controls
 * @param eye where the camera stands in for the player, in Unity coordinates
 * @param areas the stream areas shown at the eye (by the game's trigger test, `areasShownIn`), or `null` when
 *   every area shows
 * @returns by control index, each camera control's value there: an `area` test 1 while its area shows, a
 *   `near` test 1 within any of its reaches; 0 otherwise
 */
export const cameraValues = (
	controls: readonly SceneControl[],
	eye: Vec3,
	areas: ReadonlySet<number> | null,
): Map<number, number> => {
	const values = new Map<number, number>();
	for (const [index, { source }] of controls.entries()) {
		if (source.kind !== 'camera') {
			continue;
		}
		const { test } = source;
		switch (test.kind) {
			case 'area': {
				values.set(index, Number(areas === null || areas.has(test.area)));
				break;
			}
			case 'near': {
				values.set(
					index,
					Number(
						test.reaches.some(
							({ position, radius }) =>
								Math.hypot(eye[0] - position[0], eye[1] - position[1], eye[2] - position[2]) <= radius,
						),
					),
				);
				break;
			}
		}
	}
	return values;
};
