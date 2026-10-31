import type { StreamAreasInfo } from './stream-areas.ts';

/**
 * scenery variants. the game's stream areas (`<areaId>` chunk suffixes: interiors, caves, off-map places)
 * load by where the camera is, through `area:<id>` requirements (see {@link StreamAreasInfo}). scene states
 * (MapConfig states, the `<sceneStateId>` chunk suffix and dynamic state lists) are toggles whose defaults
 * evaluate the game's conditions for a player who finished the story. progressions (outpost/settlement
 * levels, POI facility levels, factory regions) are selected per progression, with mutually exclusive levels,
 * and manual gates for unrecovered script/logic conditions
 */
export interface StatesInfo {
	progressions: ProgressionInfo[];
	/** independent controls for scene states, scripts and logic gates */
	toggles: SceneToggleInfo[];
	/** visibility expressions; {@link VisibilityGroup.condition} indexes this list */
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

/** a selectable progression */
export interface ProgressionInfo {
	/** `${kind}:${key}`, e.g. `settlement:stm_hongs_1` */
	id: string;
	/** `doodadGroups`: one per level, the group level (1 to 4) of its resource nodes (ore, plants) */
	kind: 'settlement' | 'poi' | 'factoryRegion' | 'facility' | 'doodadGroups';
	/** display label when resolved */
	name?: string;
	key: string;
	levelId: string | null;
	/** levels at least one variant is shown at, ascending */
	levels: number[];
	/** the authored initial visual form, or lowest progression level, shown unless the user picks another */
	defaultLevel: number;
}

/** an on/off scene control; no runtime script or server condition is simulated */
export interface SceneToggleInfo {
	/** `sceneState:<MapConfig index>` for scene states; other ids are install-specific */
	id: string;
	name: string;
	/**
	 * `sceneState`: a MapConfig scene state. `mission` / `variable`: a dynamic entity load gate on quest and
	 * mission states / on a map or global variable; on means the gate passes. `script`: a script-loaded entity
	 * group. `logic`: a logic-state gate (the game's `LogicState`) whose condition is not recovered
	 */
	kind: 'sceneState' | 'mission' | 'variable' | 'script' | 'logic';
	/** level tags whose controls list it; 0 lists it everywhere */
	levelTags: number[];
	defaultEnabled: boolean;
	/**
	 * for scene states and gates, the game's condition in words and the assumption the default rests on; `null`
	 * for other kinds
	 */
	condition: string | null;
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
