import type { DynamicGate } from '@endfield-noclip/formats/endfield/dynamic-scene';
import type {
	CompareOperator,
	MapConfig,
	SceneCondition,
} from '@endfield-noclip/formats/endfield/map-config';
import { conditionVisible } from '@endfield-noclip/package-format/conditions';
import type { SceneControlValue } from '@endfield-noclip/package-format/states';

import { sceneControl, type DraftControl, type DraftRuleText, type Requirement } from './scene-control.ts';

// shares quest, mission and variable controls across MapConfig conditions and dynamic load gates.
// conditions are disjunctions of conjunctions. defaults: docs/extraction/scene-controls.md#defaults.

// #region conditions

/**
 * a condition on game state: a MapConfig condition or a load gate. a variable test fails while the variable
 * is unset, whatever its operator, in both
 */
export type GameCondition =
	| { kind: 'quest' | 'mission'; id: string; compare: CompareOperator; target: number }
	| { kind: 'mapVar'; mapId: string; name: string; compare: CompareOperator; target: number }
	| { kind: 'globalVar'; name: string; compare: CompareOperator; target: number }
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
			return condition;
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
			};
		}
		case 'mapVar': {
			return {
				kind: 'mapVar',
				mapId: String(gate.mapId),
				name: `#${gate.key}`,
				compare: operator(gate.compare),
				target: gate.value,
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
export type Alternatives = Requirement[][];

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
	/** the control's name */
	label: string;
	targets: Set<number>;
	/** fixed on first use; `null` until then */
	ranges: Range[] | null;
}

/** a range of variable values between compared targets; `value` is a representative, `null` for unset */
interface Range {
	label: string;
	value: number | null;
}

/** a mission whose completion a progression level stands for, e.g. an outpost's level-up mission */
export interface ProgressionLink {
	/** the progression's control id */
	control: string;
	/** its selectable levels, ascending */
	levels: readonly number[];
	/** the mission is complete at this level and above */
	completedFrom: number;
}

/**
 * how a MapConfig names its map's variables. MapConfig conditions name a variable (`map02`, `stateflower`)
 * while load gates give numeric ids (`85`, `#125`); both name the same game variable
 */
export interface MapVariables {
	/** the map's string id, as MapConfig conditions give it */
	map: string;
	/** its numeric id, as load gates give it */
	mapId: number;
	/** name → numeric variable id */
	ids: Readonly<Record<string, number>>;
	/** numeric variable id → name */
	names: Readonly<Record<number, string>>;
}

/**
 * @param config the scene's MapConfig
 * @returns how it names its map's variables
 */
export const mapVariables = (config: MapConfig): MapVariables => ({
	map: config.mapId,
	mapId: config.mapIdNum,
	ids: config.mapVarIds,
	names: config.mapVarNames,
});

/** the game state a scene's conditions read, as controls */
export class GameState {
	readonly #quests = new Map<string, 'quest' | 'mission'>();
	readonly #variables = new Map<string, Variable>();
	/** variables handed to controls their callers describe */
	readonly #claimed = new Set<string>();
	readonly #links: ReadonlyMap<string, ProgressionLink>;
	readonly #mapVariables: MapVariables | null;

	/**
	 * @param options.links by mission id, the progression level its completion stands for. a test that only
	 *   tells that mission's completion apart reads the progression's control instead of a mission control
	 * @param options.variables how the scene's MapConfig names its map's variables, so a variable a condition
	 *   names and one a gate numbers share a control
	 */
	constructor(
		options: {
			links?: ReadonlyMap<string, ProgressionLink>;
			variables?: MapVariables | null;
		} = {},
	) {
		this.#links = options.links ?? new Map();
		this.#mapVariables = options.variables ?? null;
	}

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
					const { id, label } = this.#variable(condition);
					if (this.#claimed.has(id)) {
						throw new Error(`variable ${id} has a control of its own`);
					}
					const variable = this.#variables.getOrInsertComputed(id, () => ({
						kind: condition.kind,
						label,
						targets: new Set(),
						ranges: null,
					}));
					if (variable.ranges !== null && !variable.targets.has(condition.target)) {
						throw new Error(`variable ${id} noted after its values were fixed`);
					}
					variable.targets.add(condition.target);
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
	 * hands a variable no noted condition reads to a control the caller describes, for a variable whose values
	 * mean something the generic ranges don't say. noting a condition on it afterwards throws
	 *
	 * @param condition a condition on the variable
	 * @returns the id the caller's control takes, or `null` if a noted condition reads the variable
	 */
	claimVariable(condition: Extract<GameCondition, { kind: 'mapVar' | 'globalVar' }>): string | null {
		const { id } = this.#variable(condition);
		if (this.#variables.has(id)) {
			return null;
		}
		this.#claimed.add(id);
		return id;
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
	 * @param condition a game condition
	 * @returns it in words, referring to the controls it reads: a quest's or mission's, a variable's, or the
	 *   progression a linked mission stands for
	 */
	describe(condition: GameCondition): DraftRuleText {
		switch (condition.kind) {
			case 'quest':
			case 'mission': {
				const link = condition.kind === 'mission' ? this.#links.get(condition.id) : undefined;
				return [
					{
						control: link?.control ?? `${condition.kind}:${condition.id}`,
						text: `${condition.kind} ${condition.id}`,
					},
					` ${OPERATORS[condition.compare]} ${STATE_NAMES[condition.target] ?? condition.target}`,
				];
			}
			case 'mapVar':
			case 'globalVar': {
				const scope = condition.kind === 'mapVar' ? `map ${condition.mapId} variable` : 'global variable';
				return [
					{ control: this.#variable(condition).id, text: `${scope} ${condition.name}` },
					` ${OPERATORS[condition.compare]} ${condition.target}`,
				];
			}
			case 'all':
			case 'any': {
				const parts: DraftRuleText = [condition.reverse ? 'not (' : '('];
				for (const [i, child] of condition.conditions.entries()) {
					if (i > 0) {
						parts.push(condition.kind === 'all' ? ' and ' : ' or ');
					}
					parts.push(...this.describe(child));
				}
				parts.push(')');
				return parts;
			}
		}
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
	controls(): DraftControl[] {
		const controls: DraftControl[] = [];
		for (const [id, kind] of this.#quests) {
			const values = STATE_NAMES.map((label, value) => ({ value, label })).filter(
				({ value }) => kind === 'mission' || value !== 1,
			);
			controls.push(
				sceneControl({
					kind,
					id: `${kind}:${id}`,
					name: id,
					values,
					default: COMPLETED,
					assumption: 'story finished',
				}),
			);
		}
		for (const [id, variable] of this.#variables) {
			if (variable.ranges === null) {
				continue;
			}
			const highest = Math.max(...variable.targets);
			controls.push(
				sceneControl({
					kind: variable.kind,
					id,
					name: variable.label,
					values: variable.ranges.map(({ label }, value): SceneControlValue => ({ value, label })),
					default: variable.ranges.findIndex(({ value }) => value === highest),
					assumption: `assumed ${highest}, the highest value the scene compares it against`,
				}),
			);
		}
		return controls.toSorted((a, b) => a.id.localeCompare(b.id));
	}

	#expand(condition: GameCondition, negate: boolean): Alternatives {
		switch (condition.kind) {
			case 'quest':
			case 'mission': {
				const link = condition.kind === 'mission' ? this.#links.get(condition.id) : undefined;
				if (link !== undefined) {
					const done = compare(COMPLETED, condition.compare, condition.target);
					const pending = [0, 1, 2, 4, 5].map((value) => compare(value, condition.compare, condition.target));
					// a test that holds for some unfinished states but not others still needs the mission's own state
					if (pending.every((result) => result === pending[0])) {
						return leaf(
							link.control,
							link.levels.map((level) => (level >= link.completedFrom ? done : pending[0])),
							[...link.levels],
							negate,
						);
					}
				}
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
				const { id } = this.#variable(condition);
				const ranges = this.#ranges(id);
				return leaf(
					id,
					ranges.map(({ value }) => value !== null && compare(value, condition.compare, condition.target)),
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

	/** @returns the variable's control id and name, by numeric id where the MapConfig names it */
	#variable(condition: Extract<GameCondition, { kind: 'mapVar' | 'globalVar' }>): {
		id: string;
		label: string;
	} {
		if (condition.kind === 'globalVar') {
			return { id: `globalVar:${condition.name}`, label: condition.name };
		}
		const known = this.#mapVariables;
		let numeric: number | undefined;
		if (known !== null) {
			if (condition.mapId === known.map && Object.hasOwn(known.ids, condition.name)) {
				numeric = known.ids[condition.name];
			} else if (condition.mapId === String(known.mapId) && /^#\d+$/.test(condition.name)) {
				numeric = Number(condition.name.slice(1));
			}
		}
		if (known === null || numeric === undefined) {
			return {
				id: `mapVar:${condition.mapId}:${condition.name}`,
				label: `${condition.name} (map ${condition.mapId})`,
			};
		}
		const name = known.names[numeric]?.trim();
		return {
			id: `mapVar:${known.mapId}:#${numeric}`,
			label: `${name ?? `#${numeric}`} (map ${known.map}${name === undefined ? '' : `, #${numeric}`})`,
		};
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

/**
 * @returns the variable's distinguishable ranges: unset, which fails every test, then below, at and between
 *   the compared targets, and above the highest
 * @throws {RangeError} past 32 values
 */
const variableRanges = (variable: Variable): Range[] => {
	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
	const targets = [...variable.targets].sort((a, b) => a - b);
	const ranges: Range[] = [{ label: 'unset', value: null }];
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
		throw new RangeError(`variable ${variable.label} has ${ranges.length} distinguishable values`);
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
