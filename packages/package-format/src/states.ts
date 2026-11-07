import type { EnvironmentVolumeShape } from './environment.ts';
import type { StreamAreasInfo } from './stream-areas.ts';
import type { Bounds, Vec3 } from './values.ts';

/**
 * what decides whether placed content shows. controls hold the game's own state (a quest's state, a variable,
 * a progression level, a script group's flag), so every combination the controls allow is one the game's
 * state model can produce. scene states are derived from those controls by their MapConfig condition. content
 * names a visibility group, whose condition requires control values. stream areas (`<areaId>` chunk suffixes:
 * interiors, caves, off-map places) load by where the camera is, through `area:<id>` controls a viewer sets
 * from the camera unless the user pins them (see {@link StreamAreasInfo})
 */
export interface StatesInfo {
	/** the sections controls are listed under, in listing order */
	categories: ControlCategory[];
	/**
	 * every control some visibility group, derived control or other consumer (a water volume) needs, each
	 * derived control after the controls it reads
	 */
	controls: SceneControl[];
	/**
	 * visibility expressions; {@link VisibilityGroup.condition} and a derived {@link ControlSource} index this
	 * list
	 */
	conditionalSets: ConditionalSetInfo[];
	/**
	 * who owns placed content and when it loads, deduplicated. every instance block, light, water surface and
	 * environment volume names one group, so a viewer evaluates visibility once per group (see `groupsShown`)
	 * rather than per kind of content
	 */
	groups: VisibilityGroup[];
	/** the scene's stream areas, or `null` when no packed content belongs to a non-default area */
	streamAreas: StreamAreasInfo | null;
	/** the missions quest and mission controls belong to, for labels and grouping */
	missions: MissionInfo[];
	/**
	 * the main story's missions as indices into {@link missions}, in story order, for one progress choice over
	 * all of them. the order is read from the mission ids (`e<episode>m<mission>[d<decimal>]`), not from game
	 * data
	 */
	mainStory: number[];
}

/** a mission, labelled from the game's text */
export interface MissionInfo {
	id: string;
	/** display name, or `null` for internal missions without one */
	name: string | null;
	/** the quest log tab it's listed under in game; internal and weekly missions are `other` */
	category: 'main' | 'side' | 'discovery' | 'activity' | 'other';
	/** e.g. "Chapter I · The Veiled Skies"; `null` outside the chapters */
	chapter: string | null;
	/** the main story episode, inferred from the mission id (`e<n>…`); `null` for other missions */
	episode: string | null;
	/**
	 * the level the mission takes place in (its quest log's level), or `null`. a quest can switch scenery of
	 * other levels, so this needn't be a level its controls are listed for
	 */
	levelId: string | null;
}

/** a section of controls, e.g. "Story" or "Doors and bridges" */
export interface ControlCategory {
	/** stable key, e.g. `story` */
	id: string;
	title: string;
	/** what the section's controls have in common that their rows don't say, or `null` */
	note: string | null;
}

/** a sphere the player can stand in: within `radius` metres of `position` (3D distance) */
export interface Reach {
	/** Unity coordinates */
	position: Vec3;
	radius: number;
}

/**
 * where a control's value comes from unless the user picks one:
 *
 * - `user`: only the user sets it; it holds its `default` otherwise
 * - `derived`: 1 while `conditionalSets[condition]` holds and 0 otherwise (derived controls are on/off), the
 *   game's rule in words in `rule`; it reads only controls listed before it
 * - `camera`: the camera stands in for the player, by a {@link CameraTest}; its `default` holds only without a
 *   camera
 */
export type ControlSource =
	| { kind: 'user' }
	| { kind: 'derived'; condition: number; rule: RuleText }
	| { kind: 'camera'; test: CameraTest };

/**
 * how the camera sets a control:
 *
 * - `area`: 1 while the stream area shows at the camera, by the game's trigger test over
 *   {@link StatesInfo.streamAreas}, 0 otherwise
 * - `near`: 1 while the camera is within any of the reaches, 0 beyond all
 * - `triggers`: the value the last {@link Trigger} the camera entered or left set, and the control's `default`
 *   until one does. unlike the other tests it depends on the camera's path, not only on where it is
 */
export type CameraTest =
	| { kind: 'area'; area: number }
	| { kind: 'near'; reaches: Reach[] }
	| { kind: 'triggers'; triggers: Trigger[] };

/**
 * a trigger volume that sets a control as the player crosses its boundary: the camera is inside while within
 * any of its shapes. `enter` and `leave` are the values the crossings set, `null` when that crossing sets
 * nothing
 */
export interface Trigger {
	shapes: TriggerShape[];
	enter: number | null;
	leave: number | null;
}

/**
 * a trigger volume's shape, in the Unity world frame: an environment volume's shapes (a `global` shape holds
 * everywhere), or a sphere holding points within `radius` of `center` (3D distance)
 */
export type TriggerShape = EnvironmentVolumeShape | { kind: 'sphere'; center: Vec3; radius: number };

/**
 * where a quest or mission control sits in the story. its values are then the game's `QuestState` /
 * `MissionState` values (none 0, available 1 for missions, processing 2, completed 3, failed 4, disabled 5),
 * which story progress picks set
 */
export interface StoryPlace {
	/** whether the control holds a quest's state or its mission's */
	role: 'quest' | 'mission';
	/** index into {@link StatesInfo.missions} */
	mission: number;
	/**
	 * position in the mission's flow: 1-based in its main flow (hidden steps included); a quest off it sits
	 * half a step after its predecessor, since it starts once that completes. `null` for missions and
	 * unplaceable quests. a story point "at step p" has quests before p completed, at p in progress and after p
	 * not started
	 */
	step: number | null;
}

/** an owner and a load condition shared by placed content */
export interface VisibilityGroup {
	/** index into `PackageManifest.levels` of the owning level, or `null` for content every level shows */
	level: number | null;
	/** index into {@link StatesInfo.conditionalSets}, or `null` for content that always loads */
	condition: number | null;
}

/**
 * one selectable piece of game state: a quest's state, a variable, a progression level, a door, a script
 * group's flag. a viewer treats every control alike: it lists it under its category, offers its values, and
 * follows its {@link ControlSource} unless the user picks a value
 */
export interface SceneControl {
	/** `<namespace>:<key>`, e.g. `quest:e1m8_q#3`, `sceneState:0`, `script:<entity id>`; keys are the game's ids */
	id: string;
	/**
	 * the game mechanism it stands for (`quest`, `door`, `script`, …), for search and debugging; a viewer
	 * doesn't branch on it. the mechanisms are listed in docs/extraction/scene-controls.md
	 */
	kind: string;
	name: string;
	/** index into {@link StatesInfo.categories} */
	category: number;
	/** the selectable values, ascending; each below 32 */
	values: SceneControlValue[];
	/** the value shown unless the user picks one; for a derived control, its value under the other defaults */
	default: number;
	/** what the default assumes, e.g. "story finished" */
	assumption: string;
	source: ControlSource;
	/**
	 * indices into `PackageManifest.levels` of the levels whose content (or derived controls) this control
	 * gates, ascending; every level when it gates content every level shows
	 */
	levels: number[];
	/** where it sits in the story, for a quest or mission control of a known mission; `null` otherwise */
	story: StoryPlace | null;
	/** what sets it in game according to the level scripts, deduplicated; empty when nothing found does */
	drivers: ControlDriver[];
	/**
	 * where it matters, or `null` for a control whose content is spread over the scene (a quest switching
	 * several levels' scenery) or that has none of its own
	 */
	place: ControlPlace | null;
}

/** where a control's content is */
export interface ControlPlace {
	/** the spot it stands for (an interactive, a cabin slot, a blight core), else the centre of its content */
	position: Vec3;
	/**
	 * a box around the content it shows, hides or poses, directly or through the controls derived from it;
	 * `null` when it gates no placed content of its own (a water level moves a surface instead)
	 */
	bounds: Bounds | null;
	/** where that is in the game's place names, e.g. "The Hub · Bridge Approach"; `null` outside every level */
	label: string | null;
}

/**
 * something that sets a control in game, found by following the level scripts that set it back to what starts
 * them. `value` is the control value the script sets (for a script control, 1 shows the group and 0 hides
 * it), `null` when the script computes it
 *
 * - `quest`: a quest or mission state the chain listens for or checks
 * - `switch`: an interactive's event (a switch, lever or other object the player uses), with its template and
 *   placement when known
 * - `area`: the player entering a trigger volume (centre and radius)
 * - `script`: the script running at all, which the server enables by progress while the player is inside its
 *   area (centre and radius when the script has one)
 * - `level`: a script of another level, e.g. a dungeon that reuses the map
 * - `server`: script stages, properties or events only the server sets
 * - `event`: another game event, by what sets it off ({@link ScriptEventKind}); `type` is the game's event name
 * - `unknown`: an event the extractor doesn't classify; `type` is the game's event name
 */
export type ControlDriver =
	| { kind: 'quest'; quests: QuestRef[]; value: number | null }
	| { kind: 'switch'; template: string | null; position: Vec3 | null; value: number | null }
	| { kind: 'area'; position: Vec3; radius: number; value: number | null }
	| { kind: 'script'; position: Vec3 | null; radius: number | null; value: number | null }
	| { kind: 'level'; levelId: string; name: string | null; value: number | null }
	| { kind: 'server'; value: number | null }
	| { kind: 'event'; event: ScriptEventKind; type: string; value: number | null }
	| { kind: 'unknown'; type: string; value: number | null };

/**
 * what sets off an `event` driver: `combat` (fights, spawners, damage, deaths), `dialog` (a dialogue or
 * cutscene starting or ending), `variable` (a map or global variable changing), `entity` (an entity starting,
 * raising a custom event or being entered)
 */
export type ScriptEventKind = 'combat' | 'dialog' | 'variable' | 'entity';

/**
 * a rule in words: text runs and references to the game state it reads, which a viewer may name as it names
 * those controls (see `ruleText`)
 */
export type RuleText = (string | RuleReference)[];

/** a reference in a {@link RuleText} */
export interface RuleReference {
	/** index into {@link StatesInfo.controls} of the control holding that state, or `null` when it isn't listed */
	control: number | null;
	/** how the reference reads on its own, e.g. `quest e1m8_q#3` */
	text: string;
}

/** a quest or mission named by a driver, labelled like quest controls */
export interface QuestRef {
	id: string;
	/** its mission's name, or `null` when the client lacks the mission */
	mission: string | null;
	/** the quest's text, or `null` for a mission or a hidden step */
	name: string | null;
}

/** a value of a {@link SceneControl} */
export interface SceneControlValue {
	value: number;
	label: string;
}

/** one required value of a scene control */
export interface SceneRequirement {
	/** index into {@link StatesInfo.controls} */
	control: number;
	/** bit n set means selected value n satisfies this requirement */
	mask: number;
}

/** a resource is visible if any alternative has all its requirements satisfied */
export interface ConditionalSetInfo {
	alternatives: SceneRequirement[][];
}
