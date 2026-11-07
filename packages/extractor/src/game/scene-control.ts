import type {
	ControlCategory,
	ControlDriver,
	ControlSource,
	RuleText,
	SceneControl,
	SceneControlValue,
} from '@endfield-noclip/package-format/states';
import type { Vec3 } from '@endfield-noclip/package-format/values';

// the package's control sections, and which mechanism (control kind) lists under which; see
// docs/extraction/scene-controls.md. a new mechanism adds its kind here

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
export const derivedSource = (condition: number, rule: RuleText): ControlSource => ({
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
	source?: ControlSource;
	drivers?: ControlDriver[];
	position?: Readonly<Vec3>;
}): SceneControl => {
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
