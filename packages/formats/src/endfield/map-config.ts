import { FormatError } from '../binary/binary-reader.ts';
import { isObject } from '../unity/values.ts';

// `Data/Json/MapConfig/<map>.json` (JsonData group): plain JSON (UTF-8 with BOM). the parts a viewer needs are
// the level ownership grid (`levelIds` is row-major over `sideGridNum²` 128 m cells centred on the origin,
// holding LevelConfig idNums, 0 = no level) and the scene states with the conditions that switch them
// (`BaseGameScene.CalculateSceneStateMask`).

/** streaming cell size in metres */
export const CELL_SIZE = 128;

/** the fields of a MapConfig this project uses */
export interface MapConfig {
	/** e.g. `map02` */
	mapId: string;
	mapIdNum: number;
	isSeamless: boolean;
	/** cells per side of the ownership grid */
	sideGridNum: number;
	/** row-major level idNums, index `(z + N/2)·N + (x + N/2)` for cell (x, z) */
	levelIds: number[];
	/** level ids listed by the map, in stored order */
	levelStrIds: string[];
	/** streaming scene asset, e.g. `map02/map02_streaming.asset` */
	streamingMapConfigPath: string | null;
	/** scene state name → state index (weather/story variants) */
	sceneStates: Record<string, number>;
	/**
	 * the conditions the client switches states by (`sceneStateConditions`), in stored order. a state without
	 * one only changes when the game sets it by name
	 */
	sceneStateConditions: { state: string; condition: SceneCondition }[];
}

/** `CompareOperator`: Equal, NotEqual, GreaterThan, GreaterEqual, LessThan, LessEqual */
export type CompareOperator = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * a `ConditionRuntimeBase` of a scene state. quest and mission targets are `QuestState` / `MissionState`
 * values (None 0, Available 1 (missions only), Processing 2, Completed 3, Failed 4, Disabled 5); variables
 * compare as numbers
 */
export type SceneCondition =
	| { kind: 'quest'; questId: string; compare: CompareOperator; target: number }
	| { kind: 'mission'; missionId: string; compare: CompareOperator; target: number }
	| { kind: 'mapVar'; mapId: string; name: string; compare: CompareOperator; target: number }
	| { kind: 'globalVar'; name: string; compare: CompareOperator; target: number }
	/** `CombinedConditionRuntime`; `reverse` negates the combined result */
	| { kind: 'all' | 'any'; reverse: boolean; conditions: SceneCondition[] };

/**
 * @param text the file decoded as UTF-8 (a leading BOM is tolerated)
 * @returns the typed subset of the config
 * @throws {FormatError} if required fields are missing or the grid has the wrong size
 */
export const parseMapConfig = (text: string): MapConfig => {
	const raw: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
	if (!isObject(raw)) {
		throw new FormatError('map config is not an object');
	}

	const { mapIdStr: mapId, sideGridNum, levelIds } = raw;
	if (typeof mapId !== 'string' || typeof sideGridNum !== 'number' || !isNumberArray(levelIds)) {
		throw new FormatError('map config lacks mapIdStr, sideGridNum or levelIds');
	}
	if (levelIds.length !== sideGridNum * sideGridNum || !levelIds.every((id) => Number.isInteger(id))) {
		throw new FormatError(`map config ${mapId} grid is not ${sideGridNum}² integers`);
	}

	const { levelStrIds, sceneStates, streamingMapConfigPath, mapId: mapIdNum } = raw;
	const states: Record<string, number> = {};
	if (isObject(sceneStates)) {
		for (const [name, index] of Object.entries(sceneStates)) {
			if (typeof index === 'number') {
				states[name] = index;
			}
		}
	}
	return {
		mapId,
		mapIdNum: typeof mapIdNum === 'number' ? mapIdNum : 0,
		isSeamless: raw.isSeamless === true,
		sideGridNum,
		levelIds,
		levelStrIds: Array.isArray(levelStrIds)
			? levelStrIds.filter((id): id is string => typeof id === 'string')
			: [],
		streamingMapConfigPath: typeof streamingMapConfigPath === 'string' ? streamingMapConfigPath : null,
		sceneStates: states,
		sceneStateConditions: Array.isArray(raw.sceneStateConditions)
			? raw.sceneStateConditions.map((entry: unknown) => {
					if (!isObject(entry) || typeof entry.stateName !== 'string') {
						throw new FormatError(`map config ${mapId} has a scene state condition without a state`);
					}
					return { state: entry.stateName, condition: sceneCondition(entry.condition) };
				})
			: [],
	};
};

/** `$type` names of the condition classes, without the assembly suffix */
const CONDITION_TYPE = /^Beyond\.Gameplay\.(\w+), Gameplay\.Beyond$/;

/**
 * @param value a serialized `ConditionRuntimeBase`
 * @returns the typed condition
 * @throws {FormatError} on a class or field this reader doesn't know, rather than guessing its truth
 */
const sceneCondition = (value: unknown): SceneCondition => {
	if (!isObject(value) || typeof value.$type !== 'string') {
		throw new FormatError('scene state condition has no $type');
	}
	const type = CONDITION_TYPE.exec(value.$type)?.[1];
	const comparison = (): { compare: CompareOperator; target: number } => {
		const { compareOperator: compare, compareTarget: target } = value;
		if (!isCompareOperator(compare) || typeof target !== 'number') {
			throw new FormatError(`${type} has an invalid comparison`);
		}
		return { compare, target };
	};
	const text = (field: string): string => {
		const v = value[field];
		if (typeof v !== 'string') {
			throw new FormatError(`${type} lacks ${field}`);
		}
		return v;
	};
	switch (type) {
		case 'SimpleConditionCheckQuestState': {
			return { kind: 'quest', questId: text('questId'), ...comparison() };
		}
		case 'SimpleConditionCheckMissionState': {
			return { kind: 'mission', missionId: text('missionId'), ...comparison() };
		}
		case 'SimpleConditionCheckMapVar': {
			return { kind: 'mapVar', mapId: text('belongMapId'), name: text('mapVarName'), ...comparison() };
		}
		case 'SimpleConditionCheckGlobalVar': {
			return { kind: 'globalVar', name: text('globalVarName'), ...comparison() };
		}
		case 'CombinedConditionRuntime': {
			const { conditionOperator, reverse, subConditions } = value;
			if ((conditionOperator !== 0 && conditionOperator !== 1) || !Array.isArray(subConditions)) {
				throw new FormatError('CombinedConditionRuntime has an invalid operator or no subConditions');
			}
			return {
				kind: conditionOperator === 0 ? 'all' : 'any',
				reverse: reverse === true,
				conditions: subConditions.map(sceneCondition),
			};
		}
		default: {
			throw new FormatError(`unsupported scene state condition ${value.$type}`);
		}
	}
};

const isCompareOperator = (value: unknown): value is CompareOperator =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5;

const isNumberArray = (value: unknown): value is number[] => {
	return Array.isArray(value) && value.every((item) => typeof item === 'number');
};

/**
 * @param config map config
 * @param x cell x, `floor(worldX / 128)`
 * @param z cell z, `floor(worldZ / 128)`
 * @returns the owning level's idNum, 0 if unowned, or `undefined` outside the grid
 */
export const cellOwnerIdNum = (config: MapConfig, x: number, z: number): number | undefined => {
	const half = config.sideGridNum / 2;
	const ix = x + half;
	const iz = z + half;
	if (ix < 0 || iz < 0 || ix >= config.sideGridNum || iz >= config.sideGridNum) {
		return undefined;
	}
	return config.levelIds[iz * config.sideGridNum + ix];
};
