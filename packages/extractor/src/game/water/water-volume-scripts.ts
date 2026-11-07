import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import type { LevelScripts } from '../script-drivers.ts';

// the fills level scripts set water volumes to: `WaterVolumeInfiniteSetHeight` sets a fraction of the volume's
// height, `WaterVolumeSetAmount` an amount out of its maximum, and a `WaterVolumeSetFillSpeed` run just before
// a smooth set-height gives the speed it moves at. see docs/game-data/water.md "water volumes".

/** a fill a level script sets a water volume to */
export interface ScriptWaterLevel {
	/** the volume's id, decimal */
	volume: string;
	/** the script's id */
	script: string;
	/** the action's node id in the script */
	node: number;
	/** `fraction` of the volume's height, or `amount` out of its maximum */
	kind: 'fraction' | 'amount';
	value: number;
	/** whether the surface moves there rather than snapping */
	smooth: boolean;
	/** metres per second a fill-speed action just before sets, or `null` */
	speed: number | null;
}

/**
 * @param level a fill a script sets
 * @returns the key its action's drivers are listed under
 */
export const waterActionTarget = (level: Pick<ScriptWaterLevel, 'script' | 'node'>): string =>
	`water:${level.script}:${level.node}`;

/** a script's file name under its level directory, the order fills are listed in */
const scriptFile = ({ level, id }: { level: string; id: string }): string => `${level}/${id}.json`;

/**
 * @param levelScripts the scene's decoded level scripts
 * @returns the constant water volume fills of the scene's own levels' scripts, in script order (by level,
 *   then id), and how many water actions compute their volume or value at runtime, which aren't listed
 */
export const scriptWaterLevels = (
	levelScripts: LevelScripts,
): { levels: ScriptWaterLevel[]; computed: number } => {
	const levels: ScriptWaterLevel[] = [];
	let computed = 0;
	const own = levelScripts.scripts
		.filter((script) => levelScripts.ownLevels.has(script.level))
		.toSorted((a, b) => (scriptFile(a) < scriptFile(b) ? -1 : 1));
	for (const script of own) {
		const found = scriptLevels(script.id, script.data);
		levels.push(...found.levels);
		computed += found.computed;
	}
	return { levels, computed };
};

type Node = { [key: string]: MemoryPackValue };

const isNode = (value: MemoryPackValue | undefined): value is Node =>
	value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);

/** @returns a `Param<T>`'s constant, or `undefined` when the script computes it */
const constant = (param: MemoryPackValue | undefined): MemoryPackValue | undefined =>
	isNode(param) && param.paramSource === 0 ? param.constValue : undefined;

const targetOf = (node: Node): string | null => {
	const target = constant(node.target);
	return isNode(target) && (typeof target.id === 'string' || typeof target.id === 'number')
		? String(target.id)
		: null;
};

/**
 * @param script the script's id
 * @param decoded the decoded `LevelScriptData`
 * @returns its constant water volume fills, and how many of its water actions compute their volume or value
 */
export const scriptLevels = (
	script: string,
	decoded: MemoryPackValue,
): { levels: ScriptWaterLevel[]; computed: number } => {
	const actions: { type: string; node: Node }[] = [];
	const walk = (value: MemoryPackValue): void => {
		if (Array.isArray(value)) {
			value.forEach(walk);
			return;
		}
		if (!isNode(value)) {
			return;
		}
		const match =
			typeof value.$type === 'string'
				? /_Actions_WaterVolume(InfiniteSetHeight|SetAmount|SetFillSpeed)ForMemoryPack$/.exec(value.$type)
				: null;
		if (match !== null) {
			actions.push({ type: match[1], node: value });
		}
		Object.values(value).forEach(walk);
	};
	walk(decoded);
	const result: ScriptWaterLevel[] = [];
	let computed = 0;
	for (const { type, node } of actions) {
		const volume = targetOf(node);
		const value = constant(node[type === 'SetFillSpeed' ? 'speed' : 'value']);
		if (volume === null || typeof value !== 'number') {
			computed++;
			continue;
		}
		if (type === 'InfiniteSetHeight') {
			const smooth = constant(node.isSmooth) === true;
			// the fill speed action whose next node this is, on the same volume
			const before = actions.find(
				(other) =>
					other.type === 'SetFillSpeed' && other.node.nextID === node.ID && targetOf(other.node) === volume,
			);
			const speed = before === undefined ? undefined : constant(before.node.speed);
			result.push({
				volume,
				script,
				node: Number(node.ID),
				kind: 'fraction',
				value,
				smooth,
				speed: smooth && typeof speed === 'number' ? speed : null,
			});
		} else if (type === 'SetAmount') {
			// whether a set amount moves or snaps the surface isn't recovered; it's listed as moving at the volume's speed
			result.push({
				volume,
				script,
				node: Number(node.ID),
				kind: 'amount',
				value,
				smooth: true,
				speed: null,
			});
		}
	}
	return { levels: result, computed };
};
