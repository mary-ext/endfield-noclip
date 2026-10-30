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
