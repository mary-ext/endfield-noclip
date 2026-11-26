import type { LevelInteractive } from '@endfield-noclip/formats/endfield/level-interactives';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import { FIXABLE_ROBOT_COMPONENTS, fixableRobotInts } from './fixable-robots.ts';
import { hasComponent } from './template-data.ts';

/** the component of vertical rope lifts, which set their rope's length from their two ports */
export const VERTICAL_ROPE_COMPONENTS = ['_InteractiveVerticalRopeComponentDataForMemoryPack'];

/** the component of spore mushrooms, which sets view-state bool `Active` true on start */
export const SPORE_MUSHROOM_COMPONENTS = ['_SporeMushroomComponentDataForMemoryPack'];

/** the placement property naming the other port of a vertical rope */
const TARGET_KEY = 'target';

/**
 * @param row a vertical rope's port
 * @param rows placed interactives by id
 * @returns the float keys its rope component sets before its view states start: `RopeLength`, the height
 *   between it and the port its `target` property names; none without another placed port
 */
export const verticalRopeFloats = (
	row: LevelInteractive,
	rows: ReadonlyMap<bigint, LevelInteractive>,
): Map<string, number> => {
	const id = row.properties.find((param) => param.key === TARGET_KEY)?.values[0]?.bits;
	const target = id === undefined || id === row.id ? undefined : rows.get(id);
	return target === undefined
		? new Map()
		: new Map([['RopeLength', Math.abs(row.position[1] - target.position[1])]]);
};

/** context passed to a contributor's per-placement hook */
export interface BlackboardPlacementContext {
	template: MemoryPackValue;
	row: LevelInteractive;
	rows: ReadonlyMap<bigint, LevelInteractive>;
}

/**
 * a composable plugin that contributes initial view-state blackboard keys for interactive templates carrying
 * one of its {@link components}. add a new entry to {@link BLACKBOARD_CONTRIBUTORS} to support a component
 * whose `OnStart` initializes view-state keys without touching `template-traits.ts` or `rest-looks.ts`
 */
export interface BlackboardContributor {
	/** short identifier for diagnostics and tests */
	name: string;
	/** MemoryPack component suffixes that activate this contributor */
	components: readonly string[];
	/** view-state keys always set on start for matching templates */
	templateDefaults?: Readonly<Record<string, boolean | number>>;
	/** optional per-placement keys derived from the placed row and scene context */
	placementValues?(context: BlackboardPlacementContext): ReadonlyMap<string, boolean | number>;
}

/** a contributor matched against a specific decoded template */
export interface MatchedBlackboardContributor {
	contributor: BlackboardContributor;
	template: MemoryPackValue;
}

/** registered view-state blackboard contributors, evaluated in order */
export const BLACKBOARD_CONTRIBUTORS: readonly BlackboardContributor[] = [
	{
		name: 'sporeMushroom',
		components: SPORE_MUSHROOM_COMPONENTS,
		templateDefaults: { Active: true },
	},
	{
		name: 'verticalRope',
		components: VERTICAL_ROPE_COMPONENTS,
		placementValues: ({ row, rows }) => verticalRopeFloats(row, rows),
	},
	{
		name: 'fixableRobot',
		components: FIXABLE_ROBOT_COMPONENTS,
		placementValues: ({ template, row }) => fixableRobotInts(template, row),
	},
];

/**
 * matches all registered {@link BLACKBOARD_CONTRIBUTORS} against a decoded template
 *
 * @param template decoded interactive template
 * @returns matched contributors in registration order
 */
export const matchBlackboardContributors = (template: MemoryPackValue): MatchedBlackboardContributor[] => {
	const matched: MatchedBlackboardContributor[] = [];
	for (const contributor of BLACKBOARD_CONTRIBUTORS) {
		if (hasComponent(template, contributor.components)) {
			matched.push({ contributor, template });
		}
	}
	return matched;
};

/**
 * collects template-level default blackboard values from matched contributors
 *
 * @param matched contributors matched on a template
 * @returns default blackboard keys and values
 */
export const collectTemplateDefaults = (
	matched: readonly MatchedBlackboardContributor[],
): Map<string, boolean | number> => {
	const defaults = new Map<string, boolean | number>();
	for (const { contributor } of matched) {
		if (contributor.templateDefaults !== undefined) {
			for (const [key, value] of Object.entries(contributor.templateDefaults)) {
				defaults.set(key, value);
			}
		}
	}
	return defaults;
};

/**
 * collects per-placement blackboard values from matched contributors
 *
 * @param matched contributors matched on the placement's template
 * @param row placed interactive row
 * @param rows all placed rows in the scene by id
 * @returns placement-specific blackboard keys and values
 */
export const collectPlacementValues = (
	matched: readonly MatchedBlackboardContributor[],
	row: LevelInteractive,
	rows: ReadonlyMap<bigint, LevelInteractive>,
): Map<string, boolean | number> => {
	const extra = new Map<string, boolean | number>();
	for (const { contributor, template } of matched) {
		if (contributor.placementValues !== undefined) {
			for (const [key, value] of contributor.placementValues({ template, row, rows })) {
				extra.set(key, value);
			}
		}
	}
	return extra;
};
