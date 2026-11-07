import type { Vec3 } from '@endfield-noclip/package-format/values';

import type { MapVariables } from './game-state.ts';
import type { DraftControl } from './scene-control.ts';
import type { WorldIndex } from './world-index.ts';

// map variables that are an interactive's saved property (docs/game-data/scene-states.md#variables): the
// AutoNameMapVarTable joins each to its interactive, so its control is named and placed after it

/** a map variable holding an interactive's saved property */
export interface InteractiveVariable {
	/** the interactive's LevelData logic id, decimal */
	interactive: string;
	/** e.g. `state` */
	property: string;
	/** a fresh world's value */
	initial: number;
}

const TABLE = 'Data/Json/GameplayConfig/AutoNameMapVarTable.json';

/**
 * what the `useMapVar` templates are, by lowercase template id prefix, longest first; a template not listed
 * keeps its id
 */
const NOUNS: readonly (readonly [prefix: string, noun: string])[] = [
	['int_hyper_erosion_sludge_core', 'Hyper sludge core'],
	['int_erosion_sludge_core', 'Sludge core'],
	['int_erosion_core', 'Blight core'],
	['int_anchor_wave_core', 'Anchor wave core'],
	['int_bridge_wuling', 'Wuling bridge'],
	['int_drawing_puzzle', 'Drawing puzzle'],
	['int_big_waterwheel', 'Big waterwheel'],
	['int_waterwheel', 'Waterwheel'],
	['int_aquapipeline', 'Aqua pipeline'],
	['int_outfall', 'Outfall'],
	['int_monster_heart', 'Monster heart'],
	['int_tianshizhuang_blue_sword', 'Blue sword'],
	['int_rift', 'Rift'],
];

/**
 * @param world world index
 * @param variables how the scene's MapConfig names its map's variables
 * @returns by control id (`mapVar:<map id>:#<key>`), the interactive property each of the map's
 *   interactive-backed variables holds; empty when the table lists none for the map
 * @throws {Error} if the map's lists don't line up
 */
export const loadInteractiveVariables = async (
	world: WorldIndex,
	variables: Pick<MapVariables, 'map' | 'mapId'>,
): Promise<Map<string, InteractiveVariable>> => {
	const table = await world.json(TABLE);
	const list = (field: string): unknown[] => {
		const byMap = isRecord(table) ? table[field] : undefined;
		const entries = isRecord(byMap) ? byMap[variables.map] : undefined;
		return Array.isArray(entries) ? entries : [];
	};
	const keys = list('mapVarIntKeyList');
	const interactives = list('mapVarBelongEntityList');
	const names = list('mapVarAutoNameList');
	const initials = list('mapVarDefaultValueList');
	if (
		interactives.length !== keys.length ||
		names.length !== keys.length ||
		initials.length !== keys.length
	) {
		throw new Error(`${TABLE}: ${variables.map}'s lists differ in length`);
	}
	const found = new Map<string, InteractiveVariable>();
	for (const [i, key] of keys.entries()) {
		const interactive = interactives[i];
		const name = names[i];
		const initial = initials[i];
		if (
			typeof key !== 'number' ||
			(typeof interactive !== 'number' && typeof interactive !== 'string') ||
			typeof name !== 'string' ||
			typeof initial !== 'number'
		) {
			throw new Error(`${TABLE}: ${variables.map} entry ${i} is malformed`);
		}
		// `__mapVar_interactive_<logic id>_<property>`; a property can hold underscores (`hp_ratio`)
		const prefix = `__mapVar_interactive_${interactive}_`;
		if (!name.startsWith(prefix)) {
			throw new Error(`${TABLE}: ${variables.map} entry ${i} is named ${name}`);
		}
		const property = name.slice(prefix.length);
		found.set(`mapVar:${variables.mapId}:#${key}`, { interactive: String(interactive), property, initial });
	}
	return found;
};

/**
 * names a variable control after the interactive whose property it holds and places it there; the control is
 * modified in place
 *
 * @param control a map variable's control
 * @param variable the property it holds
 * @param placement the interactive's template and position, or `undefined` when it isn't placed in the scene
 */
export const nameInteractiveVariable = (
	control: DraftControl,
	variable: InteractiveVariable,
	placement: { template: string; position: Readonly<Vec3> } | undefined,
): void => {
	if (placement !== undefined) {
		const template = placement.template.toLowerCase();
		const noun = NOUNS.find(([prefix]) => template.startsWith(prefix))?.[1] ?? placement.template;
		control.name = variable.property === 'state' ? noun : `${noun} ${variable.property}`;
		control.place ??= { position: [...placement.position], bounds: null, label: null };
	}
	control.assumption = `${control.assumption}; the variable is interactive ${variable.interactive}’s ${variable.property}, which a fresh world starts at ${variable.initial}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
