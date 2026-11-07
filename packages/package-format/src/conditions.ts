import type { RuleReference, StatesInfo } from './states.ts';

/**
 * @param rule a control's rule (a `RuleText`, or a rule naming its references some other way)
 * @param name names a reference; defaults to its own text
 * @returns the rule as one string
 */
export const ruleText = <R extends Pick<RuleReference, 'text'>>(
	rule: readonly (string | R)[],
	name: (reference: R) => string = (reference) => reference.text,
): string => rule.map((part) => (typeof part === 'string' ? part : name(part))).join('');

/**
 * @param states exported scene controls
 * @param picks values the user picked, by control index; a pick overrides a control's source
 * @param automatic values set from outside the package (the camera's, see `cameraValues`), by control index;
 *   they stand in for a camera control's default
 * @returns every control's value by index: a pick, else a derived control's formula (evaluated in stored
 *   order) or the automatic value, else the default
 */
export const resolveSceneValues = (
	states: Pick<StatesInfo, 'controls' | 'conditionalSets'>,
	picks: ReadonlyMap<number, number>,
	automatic: ReadonlyMap<number, number> = new Map(),
): number[] => {
	const values: number[] = [];
	for (const [index, control] of states.controls.entries()) {
		if (control.source.kind === 'derived') {
			const formula = states.conditionalSets[control.source.condition];
			values[index] = picks.get(index) ?? Number(formula !== undefined && conditionVisible(formula, values));
		} else {
			values[index] = picks.get(index) ?? automatic.get(index) ?? control.default;
		}
	}
	return values;
};

/**
 * generic over how controls are named, so code holding requirements by control id can test them too
 *
 * @param condition alternatives of required control values
 * @param values selected values, including defaults, by the key requirements name controls by
 * @returns whether any complete alternative is satisfied; unknown controls fail closed
 */
export const conditionVisible = <K extends string | number>(
	condition: {
		readonly alternatives: readonly (readonly { readonly control: K; readonly mask: number }[])[];
	},
	values: { readonly [key in K]?: number },
): boolean =>
	condition.alternatives.some((requirements) =>
		requirements.every(({ control, mask }) => {
			const value = values[control];
			return (
				value !== undefined &&
				Number.isInteger(value) &&
				value >= 0 &&
				value < 32 &&
				((mask >>> value) & 1) !== 0
			);
		}),
	);

/**
 * @param states exported scene controls
 * @param values every control's value (from {@link resolveSceneValues})
 * @returns per conditional set, whether the values satisfy it
 */
export const conditionResults = (states: StatesInfo, values: readonly number[]): boolean[] =>
	states.conditionalSets.map((condition) => conditionVisible(condition, values));

/**
 * every level of a package shows at once, so a group's level doesn't decide whether it shows
 *
 * @param states exported scene controls
 * @param conditions per conditional set, whether it holds (from {@link conditionResults})
 * @returns per visibility group, whether its content shows: loaded by the current scene values
 */
export const groupsShown = (states: StatesInfo, conditions: readonly boolean[]): boolean[] =>
	states.groups.map(({ condition }) => condition === null || (conditions[condition] ?? false));
