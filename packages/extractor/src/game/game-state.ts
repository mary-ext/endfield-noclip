import type { DynamicGate } from '@endfield-noclip/formats/endfield/dynamic-scene';
import type { CompareOperator, SceneCondition } from '@endfield-noclip/formats/endfield/map-config';
import { conditionVisible } from '@endfield-noclip/package-format/conditions';
import type {
	SceneControl,
	SceneControlValue,
	SceneRequirement,
} from '@endfield-noclip/package-format/states';

// the game state that MapConfig conditions and dynamic load gates read, as one control per quest, mission and
// variable. a condition becomes a disjunction of conjunctions of required control values, so conditions that
// read the same quest stay consistent with each other: no selection makes `quest = completed` and
// `quest ≠ completed` both hold.
//
// defaults are those of a player who finished the story: every quest and mission is completed. variables are
// server state and the client ships no values for them; a variable is assumed to hold the highest value the
// scene compares it against, on the reading that the story moves these variables forward (erosion cleansed,
// machines repaired, the last stage of a staged change). MapConfig names its variables while load gates use
// numeric game-variable ids, so the two never share a control.

// #region conditions

/**
 * a condition on game state: a MapConfig condition or a load gate. `unsetFails` marks a load gate's variable
 * test, which fails while the variable is unset; MapConfig tests read an unset variable as 0 (an assumption)
 */
export type GameCondition =
	| { kind: 'quest' | 'mission'; id: string; compare: CompareOperator; target: number }
	| {
			kind: 'mapVar';
			mapId: string;
			name: string;
			compare: CompareOperator;
			target: number;
			unsetFails: boolean;
	  }
	| { kind: 'globalVar'; name: string; compare: CompareOperator; target: number; unsetFails: boolean }
	| { kind: 'all' | 'any'; reverse: boolean; conditions: GameCondition[] };

/**
 * @param condition a MapConfig scene state condition
 * @returns it as a game condition
 */
export const mapConfigCondition = (condition: SceneCondition): GameCondition => {
	switch (condition.kind) {
		case 'quest': {
			return { kind: 'quest', id: condition.questId, compare: condition.compare, target: condition.target };
		}
		case 'mission': {
			return {
				kind: 'mission',
				id: condition.missionId,
				compare: condition.compare,
				target: condition.target,
			};
		}
		case 'mapVar':
		case 'globalVar': {
			return { ...condition, unsetFails: false };
		}
		case 'all':
		case 'any': {
			return { ...condition, conditions: condition.conditions.map(mapConfigCondition) };
		}
	}
};

/**
 * @param gate a dynamic entity load gate
 * @returns the condition under which it lets the entity load
 * @throws {RangeError} if a variable gate's compare type isn't a `CompareOperator`
 */
export const gateCondition = (gate: DynamicGate): GameCondition => {
	switch (gate.kind) {
		case 'mission': {
			return {
				kind: gate.all ? 'all' : 'any',
				reverse: !gate.loadWhen,
				conditions: gate.conditions.map(({ id, isQuest, state, same }) => ({
					kind: isQuest ? 'quest' : 'mission',
					id,
					compare: same ? 0 : 1,
					target: state,
				})),
			};
		}
		case 'globalVar': {
			return {
				kind: 'globalVar',
				name: `#${gate.key}`,
				compare: operator(gate.compare),
				target: gate.value,
				unsetFails: true,
			};
		}
		case 'mapVar': {
			return {
				kind: 'mapVar',
				mapId: String(gate.mapId),
				name: `#${gate.key}`,
				compare: operator(gate.compare),
				target: gate.value,
				unsetFails: true,
			};
		}
	}
};

const operator = (value: number): CompareOperator => {
	switch (value) {
		case 0:
		case 1:
		case 2:
		case 3:
		case 4:
		case 5: {
			return value;
		}
		default: {
			throw new RangeError(`compare operator ${value}`);
		}
	}
};

const OPERATORS = ['=', '≠', '>', '≥', '<', '≤'];

/** `QuestState` / `MissionState` names by value; quests have no "available" */
const STATE_NAMES = ['none', 'available', 'processing', 'completed', 'failed', 'disabled'];

/**
 * @param condition a game condition
 * @returns it in words
 */
export const describeCondition = (condition: GameCondition): string => {
	switch (condition.kind) {
		case 'quest':
		case 'mission': {
			return `${condition.kind} ${condition.id} ${OPERATORS[condition.compare]} ${STATE_NAMES[condition.target] ?? condition.target}`;
		}
		case 'mapVar':
		case 'globalVar': {
			const scope = condition.kind === 'mapVar' ? `map ${condition.mapId} variable` : 'global variable';
			return `${scope} ${condition.name} ${OPERATORS[condition.compare]} ${condition.target}`;
		}
		case 'all':
		case 'any': {
			const joined = condition.conditions
				.map(describeCondition)
				.join(condition.kind === 'all' ? ' and ' : ' or ');
			return condition.reverse ? `not (${joined})` : `(${joined})`;
		}
	}
};

const compare = (value: number, op: CompareOperator, target: number): boolean => {
	switch (op) {
		case 0: {
			return value === target;
		}
		case 1: {
			return value !== target;
		}
		case 2: {
			return value > target;
		}
		case 3: {
			return value >= target;
		}
		case 4: {
			return value < target;
		}
		case 5: {
			return value <= target;
		}
	}
};

// #endregion

// #region requirement algebra

/** a disjunction of conjunctions of required control values; `[]` is false, `[[]]` true */
export type Alternatives = SceneRequirement[][];

/** beyond this, a condition is reported rather than expanded */
const MAX_ALTERNATIVES = 4096;

/**
 * @param a alternatives
 * @param b alternatives
 * @returns alternatives holding when both hold; requirements on one control merge
 * @throws {RangeError} if the product grows past {@link MAX_ALTERNATIVES}
 */
export const allOf = (a: Alternatives, b: Alternatives): Alternatives => {
	const result: Alternatives = [];
	for (const left of a) {
		for (const right of b) {
			const merged = new Map(left.map(({ control, mask }) => [control, mask]));
			for (const { control, mask } of right) {
				merged.set(control, (merged.get(control) ?? -1) & mask);
			}
			if ([...merged.values()].every((mask) => mask !== 0)) {
				result.push([...merged].map(([control, mask]) => ({ control, mask: mask >>> 0 })));
			}
			if (result.length > MAX_ALTERNATIVES) {
				throw new RangeError(`condition expands past ${MAX_ALTERNATIVES} alternatives`);
			}
		}
	}
	return result;
};

// #endregion

// #region game state

interface Variable {
	kind: 'mapVar' | 'globalVar';
	name: string;
	mapId: string | null;
	targets: Set<number>;
	/** whether a test tells an unset variable apart from 0 */
	unset: boolean;
	/** fixed on first use; `null` until then */
	ranges: Range[] | null;
}

/** a range of variable values between compared targets; `value` is a representative, `null` for unset */
interface Range {
	label: string;
	value: number | null;
}

/** the game state a scene's conditions read, as controls */
export class GameState {
	readonly #quests = new Map<string, 'quest' | 'mission'>();
	readonly #variables = new Map<string, Variable>();

	/**
	 * notes the values conditions compare variables against. a variable's values are fixed when a condition on
	 * it is first translated, so note every condition on a variable before translating any
	 *
	 * @param conditions conditions to be translated later
	 * @throws {Error} if a variable's values were already fixed
	 */
	note(conditions: Iterable<GameCondition>): void {
		const visit = (condition: GameCondition): void => {
			switch (condition.kind) {
				case 'quest':
				case 'mission': {
					break;
				}
				case 'mapVar':
				case 'globalVar': {
					const id = variableId(condition);
					const variable = this.#variables.get(id) ?? {
						kind: condition.kind,
						name: condition.name,
						mapId: condition.kind === 'mapVar' ? condition.mapId : null,
						targets: new Set(),
						unset: false,
						ranges: null,
					};
					if (
						variable.ranges !== null &&
						(!variable.targets.has(condition.target) || (condition.unsetFails && !variable.unset))
					) {
						throw new Error(`variable ${id} noted after its values were fixed`);
					}
					variable.targets.add(condition.target);
					variable.unset ||= condition.unsetFails;
					this.#variables.set(id, variable);
					break;
				}
				case 'all':
				case 'any': {
					condition.conditions.forEach(visit);
					break;
				}
			}
		};
		for (const condition of conditions) {
			visit(condition);
		}
	}

	/**
	 * @param condition a noted condition
	 * @returns the control values under which it holds
	 * @throws {Error} if it reads a variable that wasn't noted
	 */
	requirements(condition: GameCondition): Alternatives {
		return this.#expand(condition, false);
	}

	/**
	 * @param condition a noted condition
	 * @returns whether it holds under the default values
	 */
	evaluate(condition: GameCondition): boolean {
		return conditionVisible({ alternatives: this.requirements(condition) }, this.defaults());
	}

	/** @returns the default value of every control a translated condition reads */
	defaults(): Record<string, number> {
		return Object.fromEntries(this.controls().map((control) => [control.id, control.default]));
	}

	/** @returns one control per quest, mission and variable a translated condition reads, by id */
	controls(): SceneControl[] {
		const controls: SceneControl[] = [];
		for (const [id, kind] of this.#quests) {
			const values = STATE_NAMES.map((label, value) => ({ value, label })).filter(
				({ value }) => kind === 'mission' || value !== 1,
			);
			controls.push({
				kind,
				id: `${kind}:${id}`,
				name: id,
				rule: null,
				assumption: 'story finished',
				levelTags: [],
				values,
				default: COMPLETED,
				derived: null,
			});
		}
		for (const [id, variable] of this.#variables) {
			if (variable.ranges === null) {
				continue;
			}
			const highest = Math.max(...variable.targets);
			controls.push({
				kind: variable.kind,
				id,
				name: variable.kind === 'mapVar' ? `${variable.name} (map ${variable.mapId})` : variable.name,
				rule: null,
				assumption: `assumed ${highest}, the highest value the scene compares it against`,
				levelTags: [],
				values: variable.ranges.map(({ label }, value): SceneControlValue => ({ value, label })),
				default: variable.ranges.findIndex(({ value }) => value === highest),
				derived: null,
			});
		}
		return controls.toSorted((a, b) => a.id.localeCompare(b.id));
	}

	#expand(condition: GameCondition, negate: boolean): Alternatives {
		switch (condition.kind) {
			case 'quest':
			case 'mission': {
				const known = this.#quests.get(condition.id);
				if (known !== undefined && known !== condition.kind) {
					throw new Error(`${condition.id} is read both as a quest and as a mission`);
				}
				this.#quests.set(condition.id, condition.kind);
				const domain = condition.kind === 'mission' ? [0, 1, 2, 3, 4, 5] : [0, 2, 3, 4, 5];
				return leaf(
					`${condition.kind}:${condition.id}`,
					domain.map((value) => compare(value, condition.compare, condition.target)),
					domain,
					negate,
				);
			}
			case 'mapVar':
			case 'globalVar': {
				const id = variableId(condition);
				const ranges = this.#ranges(id);
				return leaf(
					id,
					ranges.map(({ value }) =>
						value === null
							? !condition.unsetFails && compare(0, condition.compare, condition.target)
							: compare(value, condition.compare, condition.target),
					),
					ranges.map((_, index) => index),
					negate,
				);
			}
			case 'all':
			case 'any': {
				// De Morgan: a negated conjunction is a disjunction of negated children, and the reverse
				const flip = negate !== condition.reverse;
				const children = condition.conditions.map((child) => this.#expand(child, flip));
				const conjunction = (condition.kind === 'all') !== flip;
				return conjunction ? children.reduce(allOf, [[]]) : dedupe(children.flat());
			}
		}
	}

	#ranges(id: string): Range[] {
		const variable = this.#variables.get(id);
		if (variable === undefined) {
			throw new Error(`variable ${id} was not noted`);
		}
		variable.ranges ??= variableRanges(variable);
		return variable.ranges;
	}
}

/** `QuestState.Completed` / `MissionState.Completed` */
const COMPLETED = 3;

const variableId = (condition: Extract<GameCondition, { kind: 'mapVar' | 'globalVar' }>): string =>
	condition.kind === 'mapVar' ? `mapVar:${condition.mapId}:${condition.name}` : `globalVar:${condition.name}`;

/**
 * @returns the variable's distinguishable ranges: unset when a test tells it apart, then below, at and
 *   between the compared targets, and above the highest
 * @throws {RangeError} past 32 values
 */
const variableRanges = (variable: Variable): Range[] => {
	const targets = [...variable.targets].toSorted((a, b) => a - b);
	const ranges: Range[] = variable.unset ? [{ label: 'unset', value: null }] : [];
	ranges.push({ label: `< ${targets[0]}`, value: targets[0] - 1 });
	for (const [i, target] of targets.entries()) {
		ranges.push({ label: `= ${target}`, value: target });
		const next = targets[i + 1];
		if (next === undefined) {
			ranges.push({ label: `> ${target}`, value: target + 1 });
		} else if (next - target > 1) {
			ranges.push({ label: `${target} < … < ${next}`, value: target + 1 });
		}
	}
	if (ranges.length > 32) {
		throw new RangeError(`variable ${variable.name} has ${ranges.length} distinguishable values`);
	}
	return ranges;
};

/** @returns alternatives for a test with the given result per domain value */
const leaf = (control: string, results: boolean[], domain: number[], negate: boolean): Alternatives => {
	let mask = 0;
	let full = 0;
	for (const [i, value] of domain.entries()) {
		full |= 1 << value;
		if (results[i] !== negate) {
			mask |= 1 << value;
		}
	}
	if (mask === 0) {
		return [];
	}
	return mask === full ? [[]] : [[{ control, mask: mask >>> 0 }]];
};

const dedupe = (alternatives: Alternatives): Alternatives => {
	if (alternatives.some((requirements) => requirements.length === 0)) {
		return [[]];
	}
	return [
		...new Map(alternatives.map((requirements) => [JSON.stringify(requirements), requirements])).values(),
	];
};

// #endregion
