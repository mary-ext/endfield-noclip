import { mapDefined } from '@mary-ext/array-fns';

import {
	mapConfigCondition,
	mapVariables,
	type GameCondition,
	type GameState,
	type MapVariables,
} from './game-state.ts';
import {
	type Visibility,
	type DraftControl,
	derivedSource,
	sceneControl,
	SWITCH_VALUES,
} from './scene-control.ts';
import type { WorldIndex } from './world-index.ts';

// MapConfig scene states and the conditions that switch them; see
// docs/game-data/scene-states.md#mapconfig-scene-states. controls are keyed by the MapConfig index, which
// dynamic visible-state lists hold directly and chunk file names hold plus one. a state with a condition is a
// control derived from the quests and variables it reads (defaults in game-state.ts); a state without one is
// off, since only the game sets it, by name.

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
 * @param world world index
 * @param map the scene's MapConfig id
 * @returns how the MapConfig names its map's variables, or `null` without a MapConfig
 */
export const loadMapVariables = async (world: WorldIndex, map: string): Promise<MapVariables | null> => {
	const config = await world.mapConfig(map);
	return config === undefined ? null : mapVariables(config);
};

/**
 * @param states the MapConfig's scene states, their conditions noted in `game`
 * @param game the scene's game state
 * @returns the indices of the states on under the default game state
 */
export const defaultSceneStates = (states: readonly SceneStateDefinition[], game: GameState): Set<number> =>
	new Set(
		mapDefined(states, ({ index, condition }) =>
			condition !== null && game.evaluate(condition) ? index : undefined,
		),
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
	intern: (formula: Visibility) => number,
): DraftControl[] =>
	states.map(({ index, name, condition }) =>
		sceneControl({
			kind: 'sceneState',
			id: sceneStateControl(index),
			name,
			values: SWITCH_VALUES,
			default: Number(condition !== null && game.evaluate(condition)),
			assumption:
				condition === null
					? 'no condition: only set by name (dungeons, scripts), so off'
					: 'follows the quests and variables it reads',
			source:
				condition === null
					? { kind: 'user' }
					: derivedSource(intern({ alternatives: game.requirements(condition) }), game.describe(condition)),
		}),
	);

/**
 * @param index a scene state index no MapConfig names
 * @returns a control for it, off
 */
export const unnamedSceneStateControl = (index: number): DraftControl =>
	sceneControl({
		kind: 'sceneState',
		id: sceneStateControl(index),
		name: `scene state ${index}`,
		values: SWITCH_VALUES,
		default: 0,
		assumption: 'not in the MapConfig, so off',
	});
