import { FormatError } from '../binary/binary-reader.ts';

import type { LevelConfig } from './level-config.ts';
import { CELL_SIZE, cellOwnerIdNum, type MapConfig } from './map-config.ts';

// level membership for a map from MapConfig.levelIds, LevelConfig.levelGrids and the entity id's level tag
// (`id >>> 27`). in a multi-level map the tag is the 1-based ordinal of the level among the map's grid-owning
// levels sorted by id; a single-level map's one level owns tag 0. content ownership follows the tag, not
// position (docs/game-data/world.md#the-level-partition).

// #region types

/** an open-world level with its ownership data */
export interface PartitionLevel {
	/** e.g. `map02_lv001` */
	id: string;
	idNum: number;
	/** entity-id level tag owned by this level */
	tag: number;
	config: LevelConfig;
	/** owned cells as `cellKey(x, z)` */
	cells: Set<number>;
}

/** where an entity's tag puts it */
export type MembershipBucket =
	/** tag maps to a level */
	| 'level'
	/** tag 0: shared by the whole map */
	| 'shared'
	/** non-zero tag with no level (e.g. engine-reserved ids) */
	| 'unassigned';

/** where an entity's pivot lies relative to the ownership grid */
export type Placement =
	/** in a cell owned by the entity's own level */
	| 'own'
	/** in a cell owned by another level */
	| 'neighbour'
	/** in a cell no level owns */
	| 'backdrop'
	/** the entity has no position (e.g. collider-only entities carry neither matrix nor bounds) */
	| 'unplaced';

/** an entity's membership */
export interface Membership {
	bucket: MembershipBucket;
	/** the owning level, for bucket `level` */
	level: PartitionLevel | null;
	placement: Placement;
	/** level owning the pivot's cell, if any */
	cellOwner: PartitionLevel | null;
}

/** a cross-check failure between the sources */
export interface PartitionIssue {
	level: string;
	message: string;
}

/** per-map level partition */
export interface LevelPartition {
	mapId: string;
	map: MapConfig;
	/** levels in tag order */
	levels: PartitionLevel[];
	/** disagreements found while building; empty when MapConfig and LevelConfigs agree */
	issues: PartitionIssue[];
}

// #endregion

/**
 * @param x cell x
 * @param z cell z
 * @returns a number key for a cell, unique for |x|, |z| < 32768
 */
export const cellKey = (x: number, z: number): number => (x + 32768) * 65536 + (z + 32768);

/**
 * @param worldX world x in metres
 * @param worldZ world z in metres
 * @returns the 128 m cell containing the point
 */
export const cellOf = (worldX: number, worldZ: number): { x: number; z: number } => ({
	x: Math.floor(worldX / CELL_SIZE),
	z: Math.floor(worldZ / CELL_SIZE),
});

/** @returns the entity-id level tag */
export const levelTagOf = (entityId: number): number => entityId >>> 27;

/**
 * builds the partition of a map from its configs and cross-checks the cell sources
 *
 * @param map the map's MapConfig
 * @param configs any set of LevelConfigs; those of other maps are ignored
 * @returns the partition, with issues listed rather than thrown
 */
export const buildLevelPartition = (map: MapConfig, configs: Iterable<LevelConfig>): LevelPartition => {
	// a level belongs to the partition when it owns cells of this map's grid
	const gridIds = new Set(map.levelIds);
	const own = [...configs]
		.filter((config) => config.mapId === map.mapId && config.idNum !== 0 && gridIds.has(config.idNum))
		.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	const issues: PartitionIssue[] = [];
	const levels: PartitionLevel[] = own.map((config, index) => {
		const cells = new Set<number>();
		for (const cell of config.levelGrids ?? []) {
			cells.add(cellKey(cell.x, cell.z));
			const owner = cellOwnerIdNum(map, cell.x, cell.z);
			if (owner !== config.idNum) {
				issues.push({
					level: config.id,
					message: `cell ${cell.x},${cell.z} is owned by idNum ${owner} in MapConfig`,
				});
			}
		}
		const tag = own.length === 1 ? 0 : index + 1;
		return { id: config.id, idNum: config.idNum, tag, config, cells };
	});
	if (levels.length > 31) {
		throw new FormatError(`${map.mapId} has more levels than a 5-bit tag can name`);
	}

	// every grid cell must be listed by its level
	const byIdNum = new Map(levels.map((level) => [level.idNum, level]));
	const half = map.sideGridNum / 2;
	for (let iz = 0; iz < map.sideGridNum; iz++) {
		for (let ix = 0; ix < map.sideGridNum; ix++) {
			const idNum = map.levelIds[iz * map.sideGridNum + ix];
			if (idNum === 0) {
				continue;
			}
			const level = byIdNum.get(idNum);
			if (level === undefined) {
				issues.push({
					level: `idNum ${idNum}`,
					message: `owns cell ${ix - half},${iz - half} but has no config`,
				});
			} else if (!level.cells.has(cellKey(ix - half, iz - half))) {
				issues.push({
					level: level.id,
					message: `MapConfig cell ${ix - half},${iz - half} isn't in levelGrids`,
				});
			}
		}
	}

	return { mapId: map.mapId, map, levels, issues };
};

/**
 * @param partition map partition
 * @param tag entity-id level tag
 * @returns the level owning the tag, if any
 */
export const levelOfTag = (partition: LevelPartition, tag: number): PartitionLevel | undefined => {
	return partition.levels.find((level) => level.tag === tag);
};

/**
 * @param partition map partition
 * @param x cell x
 * @param z cell z
 * @returns the level owning the cell, if any
 */
export const levelOfCell = (partition: LevelPartition, x: number, z: number): PartitionLevel | undefined => {
	const idNum = cellOwnerIdNum(partition.map, x, z);
	return idNum ? partition.levels.find((level) => level.idNum === idNum) : undefined;
};

/**
 * classifies an entity by its id and pivot
 *
 * @param partition map partition
 * @param entityId full entity id
 * @param pivot world position (x, z used), or `null` if the entity has none
 * @returns its membership
 */
export const classifyEntity = (
	partition: LevelPartition,
	entityId: number,
	pivot: { x: number; z: number } | null,
): Membership => {
	const tag = levelTagOf(entityId);
	const level = levelOfTag(partition, tag) ?? null;
	let cellOwner: PartitionLevel | null = null;
	if (pivot !== null) {
		const cell = cellOf(pivot.x, pivot.z);
		cellOwner = levelOfCell(partition, cell.x, cell.z) ?? null;
	}

	let bucket: MembershipBucket;
	if (level !== null) {
		bucket = 'level';
	} else if (tag === 0) {
		bucket = 'shared';
	} else {
		bucket = 'unassigned';
	}

	let placement: Placement;
	if (pivot === null) {
		placement = 'unplaced';
	} else if (cellOwner === null) {
		placement = 'backdrop';
	} else if (cellOwner === level) {
		placement = 'own';
	} else {
		placement = 'neighbour';
	}

	return { bucket, level, placement, cellOwner };
};

/**
 * checks the ordinal tag rule against where entities actually sit: for each tag, the level whose cells hold
 * most of its pivots should be the level the rule assigns
 *
 * @param partition map partition
 * @param samples entity tags with pivots
 * @returns per tag: the rule's level, the majority cell owner, and the share of pivots in it
 */
export const voteLevelTags = (
	partition: LevelPartition,
	samples: Iterable<{ tag: number; x: number; z: number }>,
): { tag: number; rule: string | null; majority: string | null; share: number; count: number }[] => {
	const votes = new Map<number, Map<string | null, number>>();
	for (const sample of samples) {
		const cell = cellOf(sample.x, sample.z);
		const owner = levelOfCell(partition, cell.x, cell.z)?.id ?? null;
		const tally = votes.get(sample.tag) ?? new Map<string | null, number>();
		tally.set(owner, (tally.get(owner) ?? 0) + 1);
		votes.set(sample.tag, tally);
	}
	return [...votes.entries()]
		.toSorted((a, b) => a[0] - b[0])
		.map(([tag, tally]) => {
			let majority: string | null = null;
			let best = 0;
			let count = 0;
			for (const [owner, n] of tally) {
				count += n;
				// the backdrop doesn't vote: off-level skyline props would otherwise outvote small levels
				if (owner !== null && n > best) {
					majority = owner;
					best = n;
				}
			}
			return { tag, rule: levelOfTag(partition, tag)?.id ?? null, majority, share: best / count, count };
		});
};
