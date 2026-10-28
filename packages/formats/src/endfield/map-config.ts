import { FormatError } from '../binary/binary-reader.ts';
import { isObject } from '../unity/values.ts';

// `Data/Json/MapConfig/<map>.json` (JsonData group): plain JSON (UTF-8 with BOM). the part a viewer needs is the
// level ownership grid: `levelIds` is row-major over `sideGridNum²` 128 m cells centred on the origin, holding
// LevelConfig idNums (0 = no level).

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
}

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
	};
};

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
