import { distanceInsideVolume } from './environment-volumes.ts';
import type { SceneControl, TriggerShape } from './states.ts';
import type { Vec3 } from './values.ts';

/**
 * what `triggers` tests carry from one camera position to the next, by control index: whether the camera was
 * inside each trigger, and the value the last crossing set
 */
export interface TriggerMemory {
	inside: ReadonlyMap<number, readonly boolean[]>;
	values: ReadonlyMap<number, number>;
}

/** the memory before the camera has been anywhere: outside every trigger, nothing set */
export const NO_TRIGGER_MEMORY: TriggerMemory = { inside: new Map(), values: new Map() };

/**
 * @param shape a trigger shape
 * @param eye a world position
 * @returns whether the shape holds it
 */
const shapeHolds = (shape: TriggerShape, eye: Readonly<Vec3>): boolean => {
	if (shape.kind === 'sphere') {
		const { center, radius } = shape;
		return Math.hypot(eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]) <= radius;
	}
	return distanceInsideVolume(shape, eye) > 0;
};

/**
 * @param controls a package's controls
 * @param eye where the camera stands in for the player, in Unity coordinates
 * @param areas the stream areas shown at the eye (by the game's trigger test, `areasShownIn`), or `null` when
 *   every area shows
 * @param memory what `triggers` tests remembered at the previous eye; {@link NO_TRIGGER_MEMORY} for a fresh
 *   camera, which then enters every trigger holding the eye
 * @returns by control index, each camera control's value there: an `area` test 1 while its area shows, a
 *   `near` test 1 within any of its reaches, 0 otherwise; a `triggers` test the value the last crossing set,
 *   or its default before any. with them the memory to pass at the next eye
 */
export const cameraValues = (
	controls: readonly SceneControl[],
	eye: Vec3,
	areas: ReadonlySet<number> | null,
	memory: TriggerMemory,
): { values: Map<number, number>; memory: TriggerMemory } => {
	const values = new Map<number, number>();
	const inside = new Map<number, boolean[]>();
	const set = new Map<number, number>();
	for (const [index, control] of controls.entries()) {
		const { source } = control;
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
			case 'triggers': {
				const was = memory.inside.get(index);
				const now = test.triggers.map(({ shapes }) => shapes.some((shape) => shapeHolds(shape, eye)));
				let value = memory.values.get(index);
				// crossings in one step apply leaving first, so stepping from one trigger into a neighbour ends at the
				// neighbour's value
				for (const [i, trigger] of test.triggers.entries()) {
					if ((was?.[i] ?? false) && !now[i] && trigger.leave !== null) {
						value = trigger.leave;
					}
				}
				for (const [i, trigger] of test.triggers.entries()) {
					if (!(was?.[i] ?? false) && now[i] && trigger.enter !== null) {
						value = trigger.enter;
					}
				}
				inside.set(index, now);
				if (value !== undefined) {
					set.set(index, value);
				}
				values.set(index, value ?? control.default);
				break;
			}
		}
	}
	return { values, memory: { inside, values: set } };
};
