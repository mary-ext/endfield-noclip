import type { MaterialMotion, MaterialTrack } from '@endfield-noclip/package-format/materials';
import type { MaterialSurface } from '@endfield-noclip/package-format/surfaces';

type Path = (string | number)[];

/** appends every number of a value to `out` with its path, in a fixed order */
const collectNumbers = (value: unknown, path: Path, out: { path: Path; value: number }[]): void => {
	if (typeof value === 'number') {
		out.push({ path, value });
	} else if (Array.isArray(value)) {
		for (const [i, item] of value.entries()) {
			collectNumbers(item, [...path, i], out);
		}
	} else if (typeof value === 'object' && value !== null) {
		for (const [key, item] of Object.entries(value)) {
			collectNumbers(item, [...path, key], out);
		}
	}
};

/** a value's shape: itself with its numbers taken out */
const shapeOf = (value: unknown): string =>
	JSON.stringify(value, (_, item: unknown) => (typeof item === 'number' ? 0 : item));

/**
 * turns the material floats a looping clip plays into the numbers of the surface they change, by describing
 * the surface at every frame
 *
 * @param base the surface at the clip's end, which the entry keeps
 * @param motion the floats at each frame of the loop, by property name
 * @param describe describes the surface with the given floats replaced
 * @returns the surface's changing numbers, `null` when none changes, or `'reshaped'` when a frame's surface
 *   differs by more than its numbers (another kind, a part that comes and goes), which tracks can't hold
 */
export const surfaceMotion = (
	base: MaterialSurface,
	motion: { duration: number; floats: Record<string, number[]> },
	describe: (floats: Record<string, number>) => MaterialSurface,
): MaterialMotion | 'reshaped' | null => {
	const names = Object.keys(motion.floats);
	const frameCount = Math.min(...names.map((name) => motion.floats[name].length));
	if (names.length === 0 || frameCount === 0) {
		return null;
	}
	const shape = shapeOf(base);
	const numbers: { path: Path; value: number }[] = [];
	collectNumbers(base, [], numbers);
	const tracks: MaterialTrack[] = numbers.map(({ path }) => ({ path, values: [] }));
	const frame: { path: Path; value: number }[] = [];
	for (let f = 0; f < frameCount; f++) {
		const surface = describe(Object.fromEntries(names.map((name) => [name, motion.floats[name][f]])));
		if (shapeOf(surface) !== shape) {
			return 'reshaped';
		}
		frame.length = 0;
		collectNumbers(surface, [], frame);
		for (const [i, { value }] of frame.entries()) {
			tracks[i].values.push(value);
		}
	}
	const moving = tracks.filter(({ values }) => values.some((value) => value !== values[0]));
	return moving.length === 0 ? null : { duration: motion.duration, tracks: moving };
};
