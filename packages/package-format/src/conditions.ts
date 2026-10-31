import type { ConditionalSetInfo, StatesInfo } from './states.ts';

/**
 * @param states exported scene controls
 * @param picks values the user picked, by control id; a pick on a derived control overrides its formula
 * @returns every control's value: picks, then the defaults of controls only the user sets, then derived
 *   controls evaluated in their stored order
 */
export const resolveSceneValues = (
	states: StatesInfo,
	picks: Readonly<Record<string, number>>,
): Record<string, number> => {
	const values: Record<string, number> = {};
	for (const control of states.controls) {
		if (control.derived === null) {
			values[control.id] = picks[control.id] ?? control.default;
		}
	}
	for (const control of states.controls) {
		if (control.derived !== null) {
			const formula = states.conditionalSets[control.derived];
			values[control.id] =
				picks[control.id] ?? Number(formula !== undefined && conditionVisible(formula, values));
		}
	}
	return values;
};

/**
 * @param condition alternatives of required control values
 * @param values selected values, including defaults
 * @returns whether any complete alternative is satisfied; unknown controls fail closed
 */
export const conditionVisible = (
	condition: ConditionalSetInfo,
	values: Readonly<Record<string, number>>,
): boolean =>
	condition.alternatives.some((requirements) =>
		requirements.every(({ control, mask }) => {
			const value = values[control];
			return Number.isInteger(value) && value >= 0 && value < 32 && ((mask >>> value) & 1) !== 0;
		}),
	);

/**
 * @param states exported scene controls
 * @param values every control's value (from {@link resolveSceneValues}), plus stream-area values
 * @returns per conditional set, whether the values satisfy it
 */
export const conditionResults = (states: StatesInfo, values: Readonly<Record<string, number>>): boolean[] =>
	states.conditionalSets.map((condition) => conditionVisible(condition, values));

/**
 * @param states exported scene controls
 * @param level the shown level's tag, or `null` to show every level's content
 * @param conditions per conditional set, whether it holds (from {@link conditionResults})
 * @returns per visibility group, whether its content shows: owned by the shown level or by every level (tag
 *   0), and loaded by the current scene values
 */
export const groupsShown = (
	states: StatesInfo,
	level: number | null,
	conditions: readonly boolean[],
): boolean[] =>
	states.groups.map(
		({ levelTag, condition }) =>
			(level === null || levelTag === level || levelTag === 0) &&
			(condition === null || (conditions[condition] ?? false)),
	);
