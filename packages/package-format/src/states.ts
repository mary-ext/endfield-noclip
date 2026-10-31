import type { StreamAreasInfo } from './stream-areas.ts';

/**
 * what decides whether placed content shows. controls hold the game's own state (a quest's state, a variable,
 * a progression level, a script group's flag), so every combination the controls allow is one the game's
 * state model can produce. scene states are derived from those controls by their MapConfig condition. content
 * names a visibility group, whose condition requires control values. stream areas (`<areaId>` chunk suffixes:
 * interiors, caves, off-map places) load by where the camera is, through `area:<id>` controls a viewer sets
 * from the camera unless the user pins them (see {@link StreamAreasInfo})
 */
export interface StatesInfo {
	/**
	 * every control some visibility group or derived control requires, inputs before the controls derived from
	 * them
	 */
	controls: SceneControl[];
	/** visibility expressions; {@link VisibilityGroup.condition} and {@link SceneControl.derived} index this list */
	conditionalSets: ConditionalSetInfo[];
	/**
	 * who owns placed content and when it loads, deduplicated. every instance block, light, water surface and
	 * environment volume names one group, so a viewer evaluates visibility once per group (see `groupsShown`)
	 * rather than per kind of content
	 */
	groups: VisibilityGroup[];
	/** the scene's stream areas, or `null` when no packed content belongs to a non-default area */
	streamAreas: StreamAreasInfo | null;
}

/** an owner and a load condition shared by placed content */
export interface VisibilityGroup {
	/** the owning level's tag, matching `LevelInfo.tag`; 0 for content every level shows */
	levelTag: number;
	/** index into {@link StatesInfo.conditionalSets}, or `null` for content that always loads */
	condition: number | null;
}

/**
 * what a control holds:
 *
 * - `quest` / `mission`: a quest's or mission's state (`QuestState` / `MissionState` values)
 * - `mapVar` / `globalVar`: a map or global variable. values are ranges between the values the scene compares
 *   it against, plus "unset" where a load gate treats an unset variable differently from any value
 * - `sceneState`: a MapConfig scene state, on or off; derived from its condition when it has one, else only set
 *   by name (dungeons, scripts)
 * - `script`: whether a script-controlled entity group is shown; level scripts and the server set it
 * - `logic`: a logic-state gate with no recovered controller
 * - `harvest`: one level's harvestable trees, standing (0) or felled (1); each tree's state is the player's, at
 *   runtime
 * - `area`: a stream area, shown (1) or hidden (0). unless the user picks a value, a viewer sets it from the
 *   camera (see {@link StreamAreasInfo}); its `default` is only what holds without a camera
 * - `settlement` / `poi` / `factoryRegion`: a progression level; `facility`: an interactive's visual form;
 *   `doodadGroups`: one level's resource node group level (1 to 4)
 */
export type SceneControlKind =
	| 'quest'
	| 'mission'
	| 'mapVar'
	| 'globalVar'
	| 'sceneState'
	| 'script'
	| 'logic'
	| 'harvest'
	| 'area'
	| 'settlement'
	| 'poi'
	| 'factoryRegion'
	| 'facility'
	| 'doodadGroups';

/** one selectable piece of game state */
export interface SceneControl {
	kind: SceneControlKind;
	/** `<kind>:<key>`, e.g. `quest:e1m8_q#3`, `sceneState:0`, `script:<entity id>`; keys are the game's ids */
	id: string;
	name: string;
	/** for derived controls, the game's condition in words; `null` otherwise */
	rule: string | null;
	/** what the default assumes, e.g. "story finished" */
	assumption: string;
	/** level tags whose content (or derived controls) this control gates; 0 means content every level shows */
	levelTags: number[];
	/** the selectable values, ascending; each below 32 */
	values: SceneControlValue[];
	/** the value shown unless the user picks one; for a derived control, its value under the other defaults */
	default: number;
	/**
	 * index into {@link StatesInfo.conditionalSets}: unless the user picks a value, the control is 1 while that
	 * set holds and 0 otherwise. `null` for controls only the user sets. derived controls require only controls
	 * listed before them
	 */
	derived: number | null;
}

/** a value of a {@link SceneControl} */
export interface SceneControlValue {
	value: number;
	label: string;
}

/** one required value of a scene control */
export interface SceneRequirement {
	control: string;
	/** bit n set means selected value n satisfies this requirement */
	mask: number;
}

/** a resource is visible if any alternative has all its requirements satisfied */
export interface ConditionalSetInfo {
	alternatives: SceneRequirement[][];
}
