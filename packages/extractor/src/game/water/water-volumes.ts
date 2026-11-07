import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import { isMemoryPackObject, type MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';

import type { Context } from '../../context.ts';
import { VfsGroup } from '../../hg/vfs.ts';

// gameplay water volumes: LevelData `waterVolumes`, polygons whose surface level scripts raise and lower, and
// the interactives that float on them (`BelongToWaterVolume`, interactive component 39). see
// docs/game-data/water.md "water volumes".

/** a LevelData water volume */
export interface LevelWaterVolume {
	/** the game's id, decimal */
	id: string;
	levelId: string;
	levelTag: number;
	/** the floor of the volume; its surface is `pivot.y + heightMax · fraction` */
	pivot: [x: number, y: number, z: number];
	/** outline, world x, z, as authored (the game triangulates it in x, z) */
	points: [x: number, z: number][];
	/** metres from the pivot to a full volume */
	heightMax: number;
	/** the initial fill, `amountCurrent / amountMax` */
	fraction: number;
	/** the amount of a full volume, which scripts' set amounts are out of */
	amountMax: number;
	/** metres per second the surface moves at when scripts move it at a fixed speed */
	fillSpeed: number;
	/** the liquid's factory item id, e.g. `item_liquid_acid`, which picks its surface when it names no config */
	itemType: string;
	/** the surface `WaterConfig` the volume draws with, or `null` when it names none */
	configHash: bigint | null;
	/**
	 * whether it's factory water (`isPrototype` false): the server holds its amount, which the player's fluid
	 * pumps drain
	 */
	factory: boolean;
	/** whether its fill is a fraction scripts set (`isInfinite`) rather than an amount of water */
	infinite: boolean;
	/** the volume whose surface it follows, within its own depth (`parentId`), or `null` */
	parent: string | null;
	/** `<LevelData path>#<id>` */
	source: string;
}

/** an interactive that rides a water volume's surface */
export interface WaterVolumeFloater {
	/** the interactive's level logic id, decimal */
	id: string;
	/** the volume's id, decimal */
	volume: string;
}

/** the component whose parameters bind an interactive to a water volume */
const BELONG_TO_WATER_VOLUME = 39;

const ROOT = 'Beyond_Gameplay_LevelDataForMemoryPack';

/**
 * reads the water volumes and floating interactives of a scene's levels. a LevelData file the schema can't
 * decode is reported and skipped whole
 *
 * @param context install readers
 * @param scene owning map
 * @param level restricts reading to one level, or `null` for the map
 * @param partition numeric level tags
 * @returns volumes and floaters in file order, deduplicated by id, and the files that couldn't be read
 * @throws {FormatError} for a decoded volume missing a field it must have
 */
export const readWaterVolumes = async (
	context: Pick<Context, 'vfs' | 'world' | 'memoryPack'>,
	scene: string,
	level: string | null,
	partition: LevelPartition | undefined,
): Promise<{
	volumes: LevelWaterVolume[];
	floaters: WaterVolumeFloater[];
	unsupported: { path: string; reason: string }[];
}> => {
	const { vfs, world } = context;
	const reader = await context.memoryPack();
	const pathOf = await world.pathLookup();
	const volumes = new Map<string, LevelWaterVolume>();
	const floaters = new Map<string, WaterVolumeFloater>();
	const unsupported: { path: string; reason: string }[] = [];
	for (const config of (await world.levelConfigs()).values()) {
		if (config.mapId !== scene || (level !== null && config.id !== level)) {
			continue;
		}
		const levelTag = partition?.levels.find((entry) => entry.id === config.id)?.tag ?? 0;
		for (const hash of config.levelDataPathHashes ?? []) {
			const path = pathOf(hash);
			if (!path) {
				throw new FormatError(`missing LevelData path ${hash}`);
			}
			// oxlint-disable-next-line no-await-in-loop -- one level file at a time bounds memory
			const file = await vfs.find(VfsGroup.JsonData, path);
			if (!file) {
				throw new FormatError(`missing LevelData ${path}`);
			}
			let data: MemoryPackValue;
			try {
				// oxlint-disable-next-line no-await-in-loop -- as above
				data = reader.decode(await vfs.readVerified(file), ROOT);
			} catch (error) {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				unsupported.push({ path, reason: error.message });
				continue;
			}
			for (const row of listField(data, 'waterVolumes')) {
				const volume = toVolume(row, { levelId: config.id, levelTag, path });
				if (!volumes.has(volume.id)) {
					volumes.set(volume.id, volume);
				}
			}
			for (const row of listField(data, 'interactives')) {
				const floater = toFloater(row);
				if (floater !== null && !floaters.has(floater.id)) {
					floaters.set(floater.id, floater);
				}
			}
		}
	}
	return { volumes: [...volumes.values()], floaters: [...floaters.values()], unsupported };
};

// #region decoded values

type Record_ = { [key: string]: MemoryPackValue };

const listField = (value: MemoryPackValue, key: string): MemoryPackValue[] => {
	const field = isMemoryPackObject(value) ? value[key] : undefined;
	return Array.isArray(field) ? field : [];
};

const numberOf = (row: Record_, key: string): number => {
	const value = row[key];
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new FormatError(`water volume ${key} is ${JSON.stringify(value)}`);
	}
	return value;
};

const idOf = (row: Record_, key: string): string => {
	const value = row[key];
	if (typeof value !== 'string' && typeof value !== 'number') {
		throw new FormatError(`${key} is ${JSON.stringify(value)}`);
	}
	return String(value);
};

const vec3Of = (value: MemoryPackValue | undefined): [number, number, number] => {
	if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === 'number')) {
		throw new FormatError(`not a Vector3: ${JSON.stringify(value)}`);
	}
	return [value[0], value[1], value[2]] as [number, number, number];
};

const toVolume = (
	row: MemoryPackValue,
	owner: { levelId: string; levelTag: number; path: string },
): LevelWaterVolume => {
	if (!isMemoryPackObject(row)) {
		throw new FormatError(`${owner.path}: water volume is ${JSON.stringify(row)}`);
	}
	const id = idOf(row, 'id');
	const points = Array.isArray(row.points) ? row.points.map(vec3Of) : [];
	if (points.length < 3) {
		throw new FormatError(`${owner.path}: water volume ${id} has ${points.length} points`);
	}
	const amountMax = numberOf(row, 'amountMax');
	const configHash = row.isUseLunaConfig === true ? BigInt(idOf(row, 'lunaConfigPathHash')) : null;
	return {
		id,
		levelId: owner.levelId,
		levelTag: owner.levelTag,
		pivot: vec3Of(row.pivot),
		points: points.map(([x, , z]) => [x, z]),
		heightMax: numberOf(row, 'heightMax'),
		fraction: amountMax > 0 ? numberOf(row, 'amountCurrent') / amountMax : 0,
		amountMax,
		fillSpeed: numberOf(row, 'fillSpeed'),
		itemType: idOf(row, 'waterItemType'),
		configHash: configHash === 0n ? null : configHash,
		factory: !booleanOf(row, 'isPrototype'),
		infinite: booleanOf(row, 'isInfinite'),
		parent: row.parentId === undefined || idOf(row, 'parentId') === '0' ? null : idOf(row, 'parentId'),
		source: `${owner.path}#${id}`,
	};
};

const booleanOf = (row: Record_, key: string): boolean => {
	const value = row[key];
	if (typeof value !== 'boolean') {
		throw new FormatError(`water volume ${key} is ${JSON.stringify(value)}`);
	}
	return value;
};

const toFloater = (row: MemoryPackValue): WaterVolumeFloater | null => {
	if (!isMemoryPackObject(row) || !Array.isArray(row.componentProperties)) {
		return null;
	}
	for (const entry of row.componentProperties) {
		if (!Array.isArray(entry) || entry[0] !== BELONG_TO_WATER_VOLUME || !Array.isArray(entry[1])) {
			continue;
		}
		for (const param of entry[1]) {
			if (!isMemoryPackObject(param) || param.key !== 'water_volume' || !isMemoryPackObject(param.value)) {
				continue;
			}
			const [atom] = listField(param.value, 'valueArray');
			if (
				isMemoryPackObject(atom) &&
				(typeof atom.valueBit64 === 'string' || typeof atom.valueBit64 === 'number')
			) {
				const volume = String(atom.valueBit64);
				if (volume !== '0') {
					return { id: idOf(row, 'levelLogicId'), volume };
				}
			}
		}
	}
	return null;
};

// #endregion
