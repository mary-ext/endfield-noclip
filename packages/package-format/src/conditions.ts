import type { ConditionalSetInfo, StatesInfo } from './states.ts';

/**
 * @param states exported scene controls
 * @returns the authored initial progression and script defaults, with unrecovered state gates off
 */
export const defaultSceneValues = (states: StatesInfo): Record<string, number> =>
	Object.fromEntries([
		...states.progressions.map((progression) => [progression.id, progression.defaultLevel]),
		...states.toggles.map((toggle) => [toggle.id, Number(toggle.defaultEnabled)]),
	]);

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
 * @param values selected values, including defaults
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
