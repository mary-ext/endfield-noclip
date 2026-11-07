import type {
	CameraTest,
	ControlCategory,
	ControlDriver,
	SceneControl,
	SceneControlValue,
	StoryPlace,
} from '@endfield-noclip/package-format/states';
import type { Vec3 } from '@endfield-noclip/package-format/values';

// the package's control sections, and which mechanism (control kind) lists under which; see
// docs/extraction/scene-controls.md. a new mechanism adds its kind here

// #region drafts

// mechanisms build controls and visibility naming controls by id, levels by tag and categories and missions by
// id, since which controls a package keeps and in what order is only known once they are all registered. the
// control registry turns the drafts into the package's indexed form

/** a required value of a control named by id */
export interface Requirement {
	control: string;
	/** bit n set means value n satisfies it */
	mask: number;
}

/** a visibility expression over controls named by id: any alternative with every requirement met holds */
export interface Visibility {
	alternatives: Requirement[][];
}

/** a rule in words, its references naming controls by id */
export type DraftRuleText = (string | { control: string; text: string })[];

/** a control's source; a derived control's `condition` indexes the registry's conditions */
export type DraftControlSource =
	| { kind: 'user' }
	| { kind: 'derived'; condition: number; rule: DraftRuleText }
	| { kind: 'camera'; test: CameraTest };

/** a scene control before indexing: category and mission by id, levels by tag */
export interface DraftControl extends Omit<SceneControl, 'category' | 'source' | 'levels' | 'story'> {
	/** a {@link CONTROL_CATEGORIES} id */
	category: string;
	source: DraftControlSource;
	/** level tags whose content (or derived controls) it gates; the registry fills them in */
	levelTags: number[];
	story: (Omit<StoryPlace, 'mission'> & { mission: string }) | null;
}

// #endregion

/** the package's control sections, in listing order */
export const CONTROL_CATEGORIES: readonly ControlCategory[] = [
	{
		id: 'sceneStates',
		title: 'Scene states',
		note: 'States without a condition are only set by dungeons and scripts.',
	},
	{ id: 'story', title: 'Quests and missions', note: 'Story finished by default.' },
	{
		id: 'variables',
		title: 'Variables',
		note: 'Held by the server; each defaults to the highest value the scene checks.',
	},
	{ id: 'progression', title: 'Progression', note: null },
	{ id: 'dijiang', title: 'Dijiang', note: null },
	{
		id: 'created',
		title: 'Created during play',
		note: 'Interactives the server or a level script adds after the level loads, hidden by default.',
	},
	{
		id: 'events',
		title: 'Limited-time events',
		note: 'Placed only while the server runs an event, hidden by default.',
	},
	{ id: 'doors', title: 'Doors and bridges', note: null },
	{ id: 'streaming', title: 'Stream areas', note: null },
	{
		id: 'nearby',
		title: 'Player nearby',
		note: 'Things that change as the player approaches; the camera stands in for the player.',
	},
	{ id: 'harvest', title: 'Harvest', note: 'One choice covers every tree.' },
	{ id: 'scripts', title: 'Script / event scenery', note: null },
	{ id: 'logic', title: 'Logic-gate previews', note: 'Gates with no recovered controller.' },
	{ id: 'water', title: 'Water levels', note: null },
	{ id: 'environment', title: 'Lighting / environment volumes', note: null },
];

/** by control kind, its category's id */
const CATEGORY_OF_KIND: Readonly<Record<string, string>> = {
	sceneState: 'sceneStates',
	quest: 'story',
	mission: 'story',
	mapVar: 'variables',
	globalVar: 'variables',
	settlement: 'progression',
	poi: 'progression',
	factoryRegion: 'progression',
	facility: 'progression',
	doodadGroups: 'progression',
	activation: 'progression',
	controlNexus: 'dijiang',
	cabin: 'dijiang',
	cabinLevel: 'dijiang',
	created: 'created',
	activity: 'events',
	door: 'doors',
	bridge: 'doors',
	area: 'streaming',
	proximity: 'nearby',
	fireSeed: 'nearby',
	harvest: 'harvest',
	script: 'scripts',
	logic: 'logic',
	waterLevel: 'water',
	environmentVolume: 'environment',
};

/**
 * @param area a stream area id
 * @returns the id of the camera control whose value is 1 while the area is shown
 */
export const streamAreaControl = (area: number): string => `area:${area}`;

/**
 * @param logicId the global id of what level scripts show and hide: a script group or an interactive
 * @returns the id of its `script` control
 */
export const scriptControl = (logicId: string): string => `script:${logicId}`;

/**
 * @param control a `script` control
 * @returns the global id it switches
 */
export const scriptControlTarget = (control: DraftControl): string => control.id.slice('script:'.length);

/** the values of an on/off control */
export const SWITCH_VALUES: readonly SceneControlValue[] = [
	{ value: 0, label: 'off' },
	{ value: 1, label: 'on' },
];

/**
 * @param off the label of value 0
 * @param on the label of value 1
 * @returns an on/off control's values
 */
export const switchValues = (off: string, on: string): SceneControlValue[] => [
	{ value: 0, label: off },
	{ value: 1, label: on },
];

/**
 * @param condition the conditional set index of its formula
 * @param rule the game's rule in words
 * @returns the source of a control that follows that formula
 */
export const derivedSource = (condition: number, rule: DraftRuleText): DraftControlSource => ({
	kind: 'derived',
	condition,
	rule,
});

/**
 * @param fields the control's own fields; a control only the user sets unless `source` says otherwise.
 *   `position` is the spot it stands for (an interactive's placement), when it has one
 * @returns the control, in its kind's category, with no level tags yet and its place only as far as its
 *   position (the registry fills both in), no story place and the drivers given
 * @throws {Error} if its kind has no category
 */
export const sceneControl = (fields: {
	kind: string;
	id: string;
	name: string;
	values: readonly SceneControlValue[];
	default: number;
	assumption: string;
	source?: DraftControlSource;
	drivers?: ControlDriver[];
	position?: Readonly<Vec3>;
}): DraftControl => {
	const category = CATEGORY_OF_KIND[fields.kind];
	if (category === undefined) {
		throw new Error(`scene control kind ${fields.kind} has no category`);
	}
	return {
		id: fields.id,
		kind: fields.kind,
		name: fields.name,
		category,
		values: [...fields.values],
		default: fields.default,
		assumption: fields.assumption,
		source: fields.source ?? { kind: 'user' },
		levelTags: [],
		story: null,
		drivers: fields.drivers ?? [],
		place:
			fields.position === undefined ? null : { position: [...fields.position], bounds: null, label: null },
	};
};
