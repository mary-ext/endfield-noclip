import type { CompareOperator, SceneCondition } from '@endfield-noclip/formats/endfield/map-config';
import type { SceneToggleInfo } from '@endfield-noclip/package-format/format';

import type { WorldIndex } from './world-index.ts';

// MapConfig scene states and the conditions that switch them. `BaseGameScene.FlushStreamingSceneState` enables
// streaming scene state 0 unconditionally, then, per `sceneStateConditions` entry, state `index + 1` by the
// condition's result; states without a condition change only when the game sets them by name (dungeons and
// scripts reusing the map). the same index is what dynamic entities' visible-state lists hold.
//
// the defaults are those of a player who finished the story: every quest and mission is completed. map and
// global variables come from the server and the client ships no defaults for them, so they are taken as 0.

/** `QuestState` / `MissionState` value of a completed quest or mission */
const COMPLETED = 3;

/** a variable's assumed value, the server's being unknown */
const ASSUMED_VARIABLE = 0;

const STATE_NAMES = ['none', 'available', 'processing', 'completed', 'failed', 'disabled'];
const OPERATORS = ['=', '≠', '>', '≥', '<', '≤'];

/**
 * @param index a MapConfig scene state index
 * @returns the id of its scene control
 */
export const sceneStateControl = (index: number): string => `sceneState:${index}`;

/**
 * @param world world index
 * @param map the scene's MapConfig id
 * @returns one control per scene state, by index, with its story-completed default; empty without a MapConfig
 * @throws {FormatError} if the MapConfig's conditions use a class the reader doesn't know
 */
export const loadSceneStateControls = async (world: WorldIndex, map: string): Promise<SceneToggleInfo[]> => {
	const config = await world.mapConfig(map);
	if (config === undefined) {
		return [];
	}
	const conditions = new Map(config.sceneStateConditions.map(({ state, condition }) => [state, condition]));
	return Object.entries(config.sceneStates)
		.toSorted((a, b) => a[1] - b[1])
		.map(([name, index]) => {
			const condition = conditions.get(name);
			return {
				id: sceneStateControl(index),
				name,
				kind: 'sceneState',
				levelTags: [0],
				defaultEnabled: condition !== undefined && evaluate(condition),
				condition:
					condition === undefined
						? `no condition: only set by name (dungeons, scripts), so off`
						: describeWithAssumption(condition),
			};
		});
};

/**
 * @param controls scene state controls from {@link loadSceneStateControls}
 * @returns the MapConfig indices of those on by default
 */
export const defaultSceneStates = (controls: readonly SceneToggleInfo[]): Set<number> =>
	new Set(
		controls
			.filter((control) => control.defaultEnabled && control.id.startsWith('sceneState:'))
			.map((control) => Number(control.id.slice('sceneState:'.length))),
	);

/**
 * @param index a scene state index no MapConfig names
 * @returns a control for it, off
 */
export const unnamedSceneStateControl = (index: number): SceneToggleInfo => ({
	id: sceneStateControl(index),
	name: `scene state ${index}`,
	kind: 'sceneState',
	levelTags: [0],
	defaultEnabled: false,
	condition: `not in the MapConfig`,
});

/**
 * @param condition a scene state condition
 * @param variable the value every map and global variable is taken to hold
 * @returns its result for a player who finished the story
 */
export const evaluate = (condition: SceneCondition, variable = ASSUMED_VARIABLE): boolean => {
	switch (condition.kind) {
		case 'quest':
		case 'mission': {
			return compare(COMPLETED, condition.compare, condition.target);
		}
		case 'mapVar':
		case 'globalVar': {
			return compare(variable, condition.compare, condition.target);
		}
		case 'all':
		case 'any': {
			const results = condition.conditions.map((child) => evaluate(child, variable));
			const result = condition.kind === 'all' ? results.every(Boolean) : results.some(Boolean);
			return result !== condition.reverse;
		}
	}
};

const compare = (value: number, operator: CompareOperator, target: number): boolean => {
	switch (operator) {
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

/**
 * @param condition a scene state condition
 * @returns it in words
 */
export const describe = (condition: SceneCondition): string => {
	switch (condition.kind) {
		case 'quest': {
			return `quest ${condition.questId} ${OPERATORS[condition.compare]} ${stateName(condition.target)}`;
		}
		case 'mission': {
			return `mission ${condition.missionId} ${OPERATORS[condition.compare]} ${stateName(condition.target)}`;
		}
		case 'mapVar': {
			return `map variable ${condition.name} ${OPERATORS[condition.compare]} ${condition.target}`;
		}
		case 'globalVar': {
			return `global variable ${condition.name} ${OPERATORS[condition.compare]} ${condition.target}`;
		}
		case 'all':
		case 'any': {
			const joined = condition.conditions.map(describe).join(condition.kind === 'all' ? ' and ' : ' or ');
			return condition.reverse ? `not (${joined})` : `(${joined})`;
		}
	}
};

const stateName = (value: number): string => STATE_NAMES[value] ?? String(value);

const describeWithAssumption = (condition: SceneCondition): string => {
	const kinds = new Set<SceneCondition['kind']>();
	const collect = (node: SceneCondition): void => {
		kinds.add(node.kind);
		if (node.kind === 'all' || node.kind === 'any') {
			node.conditions.forEach(collect);
		}
	};
	collect(condition);
	const assumptions = [
		...(kinds.has('quest') || kinds.has('mission') ? [`story finished`] : []),
		...(kinds.has('mapVar') || kinds.has('globalVar') ? [`variables assumed ${ASSUMED_VARIABLE}`] : []),
	];
	return `${describe(condition)}; default: ${assumptions.join(', ')}`;
};
