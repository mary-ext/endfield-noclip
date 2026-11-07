import type { PartitionLevel } from '@endfield-noclip/formats/endfield/level-partition';
import type { LevelEnvironment, LevelInfo } from '@endfield-noclip/package-format/manifest';
import type { StatesInfo } from '@endfield-noclip/package-format/states';
import type { StreamAreasInfo } from '@endfield-noclip/package-format/stream-areas';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { loadInteractiveVariables, nameInteractiveVariable } from '../game/state/interactive-variables.ts';
import {
	defaultSceneStates,
	sceneStateControl,
	sceneStateControls,
	unnamedSceneStateControl,
} from '../game/state/scene-conditions.ts';
import {
	type DraftControl,
	sceneControl,
	streamAreaControl,
	switchValues,
} from '../game/state/scene-control.ts';
import { loadProgressions, progressionControl, progressionId } from '../game/state/scenery-variants.ts';
import { labelStory, mainStoryOrder } from '../game/state/story.ts';
import { Locator } from '../game/world/map-labels.ts';
import type { WorldIndex } from '../game/world/world-index.ts';

import type { ControlRegistry } from './control-registry.ts';
import type { Collector } from './instances/collector.ts';
import { cellTile, type SceneIndex } from './scene-index.ts';

// the manifest's levels and scene controls: the controls every mechanism registered, plus the ones the scene
// itself has (quests and variables, progressions, stream areas, MapConfig scene states), finished, labelled
// and indexed (docs/extraction/scene-controls.md)

/**
 * @param world the world index
 * @param scene streaming scene id
 * @returns one control per progression of the scene, at its highest authored level as in a finished world,
 *   like quests at completed; an outpost's completed upgrade missions agree with that level
 */
export const progressionControls = async (world: WorldIndex, scene: string): Promise<DraftControl[]> =>
	(await loadProgressions(world, scene)).map((progression) =>
		progressionControl(
			progression.kind,
			progressionId(progression.kind, progression.key),
			progression.key,
			progression.levels,
			progression.defaultLevel,
			'the highest authored level, as in a finished world',
		),
	);

/**
 * every control's default as the entity pass knows it, resolved like the viewer resolves the package's:
 * quests, missions and variables, MapConfig scene states (at their conditions' defaults, as their derived
 * controls aren't built yet), progressions, and script, logic and facility controls. stream areas aren't
 * included, so content that needs one doesn't count as loaded
 *
 * @param scene the scene's MapConfig states and game state
 * @param controls the controls registered so far
 * @param progressions the scene's progression controls
 * @returns by control id, its default value
 */
export const defaultValues = (
	scene: Pick<SceneIndex, 'sceneStates' | 'game'>,
	controls: ControlRegistry,
	progressions: readonly DraftControl[],
): Record<string, number> => {
	const enabled = defaultSceneStates(scene.sceneStates, scene.game);
	const states = new Set([...controls.sceneStates, ...scene.sceneStates.map(({ index }) => index)]);
	return controls.defaults([
		...scene.game.controls(),
		...[...states].map((index) =>
			Object.assign(unnamedSceneStateControl(index), { default: Number(enabled.has(index)) }),
		),
		...progressions,
	]);
};

/**
 * adds the scene state controls: one per MapConfig state, derived from its condition, plus any state an
 * expression requires that the MapConfig doesn't name. runs once every mechanism has named the states it
 * requires
 *
 * @param controls the package's controls; extended
 * @param scene the scene's MapConfig states and game state
 */
export const addSceneStateControls = (
	controls: ControlRegistry,
	scene: Pick<SceneIndex, 'sceneStates' | 'game'>,
): void => {
	const named = sceneStateControls(scene.sceneStates, scene.game, (formula) => controls.condition(formula));
	const ids = new Set(named.map((control) => control.id));
	const unnamed = [...controls.sceneStates]
		.filter((index) => !ids.has(sceneStateControl(index)))
		.toSorted((a, b) => a - b)
		.map(unnamedSceneStateControl);
	controls.add(...named, ...unnamed);
};

/** the manifest's levels and scenery states */
export interface SceneStateInfo extends StatesInfo {
	levels: LevelInfo[];
	/** by control id, the index of each of the package's controls */
	controlIndex: ReadonlyMap<string, number>;
}

/**
 * finishes the package's controls and builds its levels
 *
 * @param world the world index
 * @param scene the scene being packed
 * @param inputs the registered controls, the collected instances, per partition level its base environment,
 *   the scene's progression controls, and every placed interactive's template and position by logic id
 * @returns the manifest's levels and states, and each control's index
 * @throws {Error} if content needs stream areas but the scene has no stream-area table
 */
export const buildSceneStates = async (
	world: WorldIndex,
	scene: SceneIndex,
	inputs: {
		controls: ControlRegistry;
		collector: Collector;
		environments: readonly (LevelEnvironment | null)[];
		progressions: readonly DraftControl[];
		placements: ReadonlyMap<string, { template: string; position: Vec3 }>;
	},
): Promise<SceneStateInfo> => {
	const { controls, collector } = inputs;
	const { partition } = scene;
	const levels = (partition?.levels ?? []).map((level, i) =>
		levelInfo(level, scene, collector, inputs.environments[i] ?? null),
	);
	const areas = [...controls.areas]
		.toSorted((a, b) => a - b)
		.map((area) =>
			sceneControl({
				kind: 'area',
				id: streamAreaControl(area),
				name: `Stream area ${area}`,
				values: switchValues('hidden', 'shown'),
				default: 1,
				assumption: 'follows the camera, like the game',
				source: { kind: 'camera', test: { kind: 'area', area } },
			}),
		);
	controls.add(...scene.game.controls(), ...inputs.progressions, ...areas);
	if (scene.variables !== null) {
		// a map variable holding an interactive's saved property is named and placed after the interactive
		for (const [id, variable] of await loadInteractiveVariables(world, scene.variables)) {
			const control = controls.get(id);
			if (control !== undefined) {
				nameInteractiveVariable(control, variable, inputs.placements.get(variable.interactive));
			}
		}
	}
	const locator = await Locator.load(world, partition);
	const finished = controls.finish({
		groupBounds: collector.groupBounds(),
		locate: (position) => locator.locate(position),
	});
	const missions = await labelStory(world, finished.controls);
	const indexed = controls.index(finished, {
		levelTags: (partition?.levels ?? []).map(({ tag }) => tag),
		missions,
		mainStory: mainStoryOrder(missions),
	});
	return {
		levels,
		...indexed.states,
		streamAreas: await streamAreasInfo(world, scene.id, controls.areas),
		controlIndex: indexed.controlIndex,
	};
};

/**
 * @param world world index
 * @param scene streaming scene id
 * @param areas stream areas packed content requires
 * @returns the scene's stream-area table for the viewer, or `null` when no content needs it
 * @throws {Error} if content needs areas but the scene has no stream-area table
 */
const streamAreasInfo = async (
	world: WorldIndex,
	scene: string,
	areas: ReadonlySet<number>,
): Promise<StreamAreasInfo | null> => {
	if (areas.size === 0) {
		return null;
	}
	const table = await world.streamAreas(scene);
	if (table === undefined) {
		throw new Error(`${scene} has stream-area content but no stream-area table`);
	}
	return {
		rootVisible: table.rootVisible,
		shownInside: [...table.visibleWhileInside].map(([zone, shown]) => ({ zone, areas: shown })),
		triggers: table.triggers.map(({ areaId, bounds, polygon }) => ({
			zone: areaId,
			min: [bounds.min.x, bounds.min.z],
			max: [bounds.max.x, bounds.max.z],
			minHeight: bounds.minHeight,
			maxHeight: bounds.maxHeight,
			polygon: polygon.map(({ x, z }): [number, number] => [x, z]),
		})),
	};
};

const levelInfo = (
	level: PartitionLevel,
	scene: SceneIndex,
	collector: Collector,
	environment: LevelEnvironment | null,
): LevelInfo => {
	const { config } = level;
	return {
		id: level.id,
		name: scene.names.get(level.id) ?? null,
		rect: {
			minX: config.rectLeftBottom[0],
			minZ: config.rectLeftBottom[1],
			maxX: config.rectRightTop[0],
			maxZ: config.rectRightTop[1],
		},
		playerInitPos: config.playerInitPos,
		cells: (config.levelGrids ?? [])
			.map((cell) => cellTile(scene.grid, cell))
			.map((key): [number, number] => [key.x, key.z])
			.toSorted((a, b) => a[1] - b[1] || a[0] - b[0]),
		instances: collector.tagInstances.get(level.tag) ?? 0,
		contentBounds: collector.tagBounds.get(level.tag) ?? null,
		environment,
	};
};
