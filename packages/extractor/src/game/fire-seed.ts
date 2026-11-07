import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { ControlDriver } from '@endfield-noclip/package-format/states';

import type { Context } from '../context.ts';

import type { LevelScripts } from './script-drivers.ts';
import { type DraftControl, sceneControl } from './state/scene-control.ts';

// the fire seed the player carries in Yinglung Pass: level scripts set its level, and its level sets the global
// radii within which invisible bridges show around the player (docs/game-data/effects.md "invisible bridges")

/** a fire seed level a level script sets */
export interface ScriptFireSeedLevel {
	/** the script's id */
	script: string;
	/** the action's node id in the script */
	node: number;
	/** the level it sets, `null` when the script computes it */
	level: number | null;
}

/**
 * @param action a level a script sets
 * @returns the key its action's drivers are listed under
 */
export const fireSeedActionTarget = (action: Pick<ScriptFireSeedLevel, 'script' | 'node'>): string =>
	`fireSeed:${action.script}:${action.node}`;

/** the action type, as its MemoryPack wrapper names it */
const SET_LEVEL = /_Actions_SetFireSeedLevelForMemoryPack$/;

/**
 * @param levelScripts the scene's decoded level scripts
 * @returns the fire seed levels the scene's own levels' scripts set, by script and node id
 */
export const scriptFireSeedLevels = (levelScripts: LevelScripts): ScriptFireSeedLevel[] => {
	const found: ScriptFireSeedLevel[] = [];
	for (const script of levelScripts.scripts) {
		if (!levelScripts.ownLevels.has(script.level)) {
			continue;
		}
		for (const [id, node] of script.nodes) {
			if (typeof node.$type !== 'string' || !SET_LEVEL.test(node.$type)) {
				continue;
			}
			const param = node.fireSeedStackCnt;
			const constant =
				param !== null && typeof param === 'object' && !Array.isArray(param) && param.paramSource === 0
					? param.constValue
					: undefined;
			found.push({ script: script.id, node: id, level: typeof constant === 'number' ? constant : null });
		}
	}
	return found.toSorted((a, b) => (a.script === b.script ? a.node - b.node : a.script < b.script ? -1 : 1));
};

/** the id of the fire seed's control */
export const FIRE_SEED_CONTROL = 'fireSeed:player';

/**
 * @param radii per level from 0, the reveal radii ({@link loadFireSeedRadii})
 * @param actions the levels the scene's scripts set
 * @param drivers by {@link fireSeedActionTarget}, what runs each action
 * @returns the fire seed's control: a level per radius, without a seed by default, as before any script
 *   lights it, and the drivers of each level the scripts set
 */
export const fireSeedControl = (
	radii: readonly (readonly [number, number])[],
	actions: readonly ScriptFireSeedLevel[],
	drivers: ReadonlyMap<string, readonly ControlDriver[]>,
): DraftControl => {
	const found: ControlDriver[] = [];
	const known = new Set<string>();
	for (const action of actions) {
		for (const driver of drivers.get(fireSeedActionTarget(action)) ?? []) {
			const set = { ...driver, value: action.level };
			const key = JSON.stringify(set);
			if (!known.has(key)) {
				known.add(key);
				found.push(set);
			}
		}
	}
	return sceneControl({
		kind: 'fireSeed',
		id: FIRE_SEED_CONTROL,
		name: 'Fire seed',
		values: radii.map(([inner], value) => ({
			value,
			label:
				value === 0 ? 'not carried, invisible bridges hidden' : `level ${value}, reveals within ${inner} m`,
		})),
		default: 0,
		assumption: 'not carried, as before a level script lights it',
		drivers: found,
	});
};

/** the asset holding the fire seed's radii */
const CONFIG_PATH = 'Assets/Beyond/DynamicAssets/GameData/GameplayConfig/FireSeedGameplayConfig.asset';

/**
 * the global reveal radii by fire seed level, as `FireSeedBrain.SetFireSeedLevel` sets them: without a seed
 * (level 0) the config's invisible radii, which leave every revealed effect hidden; at level n the nth effect
 * radius, and that plus the rim's thickness
 *
 * @param context install readers
 * @returns per level from 0, the inner and outer radius
 * @throws {Error} if the config isn't where expected or lacks its fields
 */
export const loadFireSeedRadii = async (
	context: Pick<Context, 'world' | 'resolver'>,
): Promise<[inner: number, outer: number][]> => {
	const [hash] = await context.world.hashesOf(CONFIG_PATH);
	if (hash === undefined) {
		throw new Error(`no path hash for ${CONFIG_PATH}`);
	}
	const resolver = await context.resolver();
	const ref = await resolver.findUnique({ hash, path: CONFIG_PATH }, UnityClass.MonoBehaviour);
	const config = await resolver.read(ref);
	const { effectRadius, radiusThickness, invisibleBrightInnerRadius, invisibleBrightOuterRadius } = config;
	// float lists decode as typed arrays
	if (
		!(effectRadius instanceof Float32Array) ||
		typeof radiusThickness !== 'number' ||
		typeof invisibleBrightInnerRadius !== 'number' ||
		typeof invisibleBrightOuterRadius !== 'number'
	) {
		throw new Error(`${CONFIG_PATH} lacks the fire seed's radii`);
	}
	return [
		[invisibleBrightInnerRadius, invisibleBrightOuterRadius],
		...Array.from(effectRadius, (radius): [number, number] => [
			radius,
			Math.fround(radius + radiusThickness),
		]),
	];
};
