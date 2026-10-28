import { BinaryReader, FormatError } from '../binary/binary-reader.ts';

// `Data/Json/LevelConfig/<level>.json` (JsonData group; despite the name, a binary MemoryPack-style payload
// with pooled strings). member order per Variante/endfield_research_kit (MIT,
// `scripts/game_data/levelconfig_binary.py`): u8 18 members, then a 3-member defaultState, then the rest.

const ROOT_MEMBERS = 18;
const STATE_MEMBERS = 3;

/** a 128 m streaming cell coordinate, `floor(world / 128)` */
export interface CellCoord {
	x: number;
	z: number;
}

/** a decoded LevelConfig */
export interface LevelConfig {
	/** e.g. `map02_lv001` */
	id: string;
	/** numeric id, as stored in MapConfig's ownership grid */
	idNum: number;
	/** streaming world this level lives in, e.g. `map02` */
	mapId: string | null;
	defaultState: {
		/** streaming scene asset, e.g. `map02/map02_streaming.asset` */
		exportedSceneConfigPath: string | null;
		name: string | null;
		/** art sub-scene, e.g. `map02_lv001_art` */
		sourceSceneName: string | null;
	};
	dimensionSourceLevelId: string | null;
	enableFactoryBuildingSnowCoverage: boolean;
	isDimensionLevel: boolean;
	isSeamless: boolean;
	/** StringPathHash keys of the level's LevelData files */
	levelDataPathHashes: bigint[] | null;
	/** cells the level owns */
	levelGrids: CellCoord[] | null;
	playerInitPos: [number, number, number];
	playerInitRot: [number, number, number];
	rectLeftBottom: [number, number];
	rectRightTop: [number, number];
	scope: number;
	startPos: [number, number, number];
	waterStartAudio: string | null;
	waterStopAudio: string | null;
}

/**
 * decodes a LevelConfig payload
 *
 * @param bytes the decrypted file
 * @param resolveString maps a pooled string id to its string (see `StringPool.get`)
 * @returns the config
 * @throws {FormatError} if the payload doesn't decode exactly to its end
 */
export const parseLevelConfig = (
	bytes: Uint8Array,
	resolveString: (id: number) => string | null,
): LevelConfig => {
	const r = new BinaryReader(bytes, { littleEndian: true });
	if (r.u8() !== ROOT_MEMBERS) {
		throw new FormatError('level config member count mismatch');
	}
	if (r.u8() !== STATE_MEMBERS) {
		throw new FormatError('level config defaultState member count mismatch');
	}
	const string = (): string | null => resolveString(r.i32());
	const bool = (): boolean => {
		const value = r.u8();
		if (value > 1) {
			throw new FormatError(`level config has an invalid bool ${value}`);
		}
		return value === 1;
	};
	const count = (): number | null => {
		const value = r.i32();
		if (value === -1) {
			return null;
		}
		if (value < 0 || value > 65536) {
			throw new FormatError(`level config has an invalid count ${value}`);
		}
		return value;
	};
	const vec2 = (): [number, number] => [r.f32(), r.f32()];
	const vec3 = (): [number, number, number] => [r.f32(), r.f32(), r.f32()];

	const defaultState = {
		exportedSceneConfigPath: string(),
		name: string(),
		sourceSceneName: string(),
	};
	const dimensionSourceLevelId = string();
	const enableFactoryBuildingSnowCoverage = bool();
	const id = string();
	if (!id) {
		throw new FormatError('level config has no id');
	}
	const idNum = r.i32();
	const isDimensionLevel = bool();
	const isSeamless = bool();

	let levelDataPathHashes: bigint[] | null = null;
	{
		const n = count();
		if (n !== null) {
			levelDataPathHashes = Array.from({ length: n }, () => r.u64());
		}
	}
	let levelGrids: CellCoord[] | null = null;
	{
		const n = count();
		if (n !== null) {
			levelGrids = Array.from({ length: n }, () => ({ x: r.i32(), z: r.i32() }));
		}
	}

	const config: LevelConfig = {
		id,
		idNum,
		mapId: string(),
		defaultState,
		dimensionSourceLevelId,
		enableFactoryBuildingSnowCoverage,
		isDimensionLevel,
		isSeamless,
		levelDataPathHashes,
		levelGrids,
		playerInitPos: vec3(),
		playerInitRot: vec3(),
		rectLeftBottom: vec2(),
		rectRightTop: vec2(),
		scope: r.i32(),
		startPos: vec3(),
		waterStartAudio: string(),
		waterStopAudio: string(),
	};
	if (r.remaining !== 0) {
		throw new FormatError(`level config ${id} has ${r.remaining} trailing bytes`);
	}
	return config;
};
