import type { ConditionalSetInfo, SceneControl } from '@endfield-noclip/package-format/states';

import { describeCondition, mapConfigCondition, type GameCondition, type GameState } from './game-state.ts';
import type { WorldIndex } from './world-index.ts';

// MapConfig scene states and the conditions that switch them. `BaseGameScene.FlushStreamingSceneState` enables
// streaming scene state 0 unconditionally, then, per `sceneStateConditions` entry, state `index + 1` by the
// condition's result; states without a condition change only when the game sets them by name (dungeons and
// scripts reusing the map). the same index is what dynamic entities' visible-state lists hold. a state with a
// condition is a control derived from the quests and variables it reads (see game-state.ts for their
// defaults); a state without one is off.

/** a MapConfig scene state */
export interface SceneStateDefinition {
	index: number;
	name: string;
	/** the condition the game sets it by, or `null` when only set by name */
	condition: GameCondition | null;
}

/**
 * @param index a MapConfig scene state index
 * @returns the id of its scene control
 */
export const sceneStateControl = (index: number): string => `sceneState:${index}`;

/**
 * @param world world index
 * @param map the scene's MapConfig id
 * @returns the MapConfig's scene states by index; empty without a MapConfig
 * @throws {FormatError} if the MapConfig's conditions use a class the reader doesn't know
 */
export const loadSceneStates = async (world: WorldIndex, map: string): Promise<SceneStateDefinition[]> => {
	const config = await world.mapConfig(map);
	if (config === undefined) {
		return [];
	}
	const conditions = new Map(config.sceneStateConditions.map(({ state, condition }) => [state, condition]));
	return Object.entries(config.sceneStates)
		.toSorted((a, b) => a[1] - b[1])
		.map(([name, index]) => {
			const condition = conditions.get(name);
			return { index, name, condition: condition === undefined ? null : mapConfigCondition(condition) };
		});
};

/**
 * @param states the MapConfig's scene states, their conditions noted in `game`
 * @param game the scene's game state
 * @returns the indices of the states on under the default game state
 */
export const defaultSceneStates = (states: readonly SceneStateDefinition[], game: GameState): Set<number> =>
	new Set(
		states
			.filter(({ condition }) => condition !== null && game.evaluate(condition))
			.map(({ index }) => index),
	);

/**
 * @param states the MapConfig's scene states, their conditions noted in `game`
 * @param game the scene's game state
 * @param intern stores a formula, returning its conditional set index
 * @returns one control per state: derived from its condition, or off when it has none
 */
export const sceneStateControls = (
	states: readonly SceneStateDefinition[],
	game: GameState,
	intern: (formula: ConditionalSetInfo) => number,
): SceneControl[] =>
	states.map(({ index, name, condition }) => ({
		kind: 'sceneState',
		id: sceneStateControl(index),
		name,
		rule: condition === null ? null : describeCondition(condition),
		assumption:
			condition === null
				? 'no condition: only set by name (dungeons, scripts), so off'
				: 'follows the quests and variables it reads',
		story: null,
		drivers: [],
		levelTags: [],
		values: SWITCH_VALUES,
		default: Number(condition !== null && game.evaluate(condition)),
		derived: condition === null ? null : intern({ alternatives: game.requirements(condition) }),
	}));

/**
 * @param index a scene state index no MapConfig names
 * @returns a control for it, off
 */
export const unnamedSceneStateControl = (index: number): SceneControl => ({
	kind: 'sceneState',
	id: sceneStateControl(index),
	name: `scene state ${index}`,
	rule: null,
	assumption: 'not in the MapConfig, so off',
	story: null,
	drivers: [],
	levelTags: [],
	values: SWITCH_VALUES,
	default: 0,
	derived: null,
});

/** the values of an on/off control */
export const SWITCH_VALUES = [
	{ value: 0, label: 'off' },
	{ value: 1, label: 'on' },
];
