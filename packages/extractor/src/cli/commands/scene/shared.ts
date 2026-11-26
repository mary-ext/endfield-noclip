import { type ChunkEntity, StreamingLayer } from '@endfield-noclip/formats/endfield/init-chunk-data';
import { cellKey, levelOfTag, type LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import { CELL_SIZE } from '@endfield-noclip/formats/endfield/map-config';
import type { HlodLink } from '@endfield-noclip/formats/endfield/streaming-chunk-data';

import type { ChunkFile, IndexedEntity, WorldIndex } from '../../../game/world/world-index.ts';

/** hash-to-path/bundle lookup callbacks for formatting scene rows */
export interface AssetNames {
	pathOf: (hash: bigint) => string | undefined;
	assetPathOf: (hash: bigint) => string | undefined;
	bundleOf: (hash: bigint) => string | null;
}

/**
 * loads a map's level partition or throws if absent
 *
 * @param world world index
 * @param mapId map identifier
 * @returns level partition
 */
export const requirePartition = async (world: WorldIndex, mapId: string): Promise<LevelPartition> => {
	const partition = await world.partition(mapId);
	if (partition === undefined) {
		throw new Error(`${mapId} has no MapConfig, so it has no level partition`);
	}
	return partition;
};

/**
 * resolves a level id to its owning map partition and level entry
 *
 * @param world world index
 * @param levelId level identifier
 * @returns owning partition and level entry
 */
export const findLevel = async (world: WorldIndex, levelId: string) => {
	const mapId = (await world.levelConfigs()).get(levelId)?.mapId;
	if (!mapId) {
		throw new Error(`${levelId} has no LevelConfig`);
	}
	const partition = await requirePartition(world, mapId);
	const level = partition.levels.find((candidate) => candidate.id === levelId);
	if (level === undefined) {
		throw new Error(`${levelId} owns no cells of ${mapId}'s grid`);
	}
	return { partition, level };
};

/**
 * returns levels owning any cell within `reach` cells of `point`
 *
 * @param partition map level partition
 * @param point Unity world coordinates
 * @param radius optional search radius
 * @returns matching levels
 */
export const levelsNear = (
	partition: LevelPartition,
	point: readonly number[],
	radius: number | undefined,
): LevelPartition['levels'] => {
	const cx = Math.floor(point[0] / CELL_SIZE);
	const cz = Math.floor(point[2] / CELL_SIZE);
	const reach = radius === undefined ? 1 : Math.ceil(radius / CELL_SIZE) + 1;
	const matched = new Set<LevelPartition['levels'][number]>();
	for (let dx = -reach; dx <= reach; dx++) {
		for (let dz = -reach; dz <= reach; dz++) {
			const key = cellKey(cx + dx, cz + dz);
			for (const level of partition.levels) {
				if (level.cells.has(key)) {
					matched.add(level);
				}
			}
		}
	}
	return [...matched];
};

/**
 * creates a chunk-file cell filter around `near` within `radius`
 *
 * @param near optional Unity world coordinates
 * @param radius optional search radius
 * @returns predicate or undefined when `near` is omitted
 */
export const nearCellFilter = (
	near: readonly number[] | undefined,
	radius: number | undefined,
): ((file: ChunkFile) => boolean) | undefined => {
	if (near === undefined) {
		return undefined;
	}
	const cx = Math.floor(near[0] / CELL_SIZE);
	const cz = Math.floor(near[2] / CELL_SIZE);
	const reach = radius === undefined ? 1 : Math.ceil(radius / CELL_SIZE) + 1;
	return (file) =>
		file.cell === null || (Math.abs(file.cell.x - cx) <= reach && Math.abs(file.cell.z - cz) <= reach);
};

/**
 * formats an HLOD link for text output
 *
 * @param link HLOD link or null
 * @returns human-readable summary
 */
export const formatHlodLink = (link: HlodLink | null): string => {
	if (link === null) {
		return 'hlod:none';
	}
	const parts: string[] = [];
	if (link.parent !== null) {
		parts.push(`parent=${link.parent}`);
	}
	if (link.childCount > 0) {
		parts.push(`children=${link.childCount}`);
	}
	return parts.length === 0 ? 'hlod:none' : `hlod:${parts.join(',')}`;
};

/**
 * returns a display name for a streaming layer id
 *
 * @param layer streaming layer enum value
 * @returns layer name
 */
export const layerName = (layer: number): string => {
	return Object.entries(StreamingLayer).find(([, value]) => value === layer)?.[0] ?? String(layer);
};

/**
 * formats an indexed chunk entity for JSON output
 *
 * @param entity indexed chunk entity
 * @param partition optional level partition
 * @param names asset name lookup
 * @returns plain JSON-friendly object
 */
export const entityJson = (
	entity: IndexedEntity,
	partition: LevelPartition | undefined,
	names: AssetNames,
): object => ({
	id: entity.id,
	levelTag: entity.levelTag,
	level: entity.membership.level?.id ?? (partition && levelOfTag(partition, entity.levelTag)?.id) ?? null,
	bucket: entity.membership.bucket,
	placement: entity.membership.placement,
	cellOwner: entity.membership.cellOwner?.id ?? null,
	name: entity.name,
	layer: layerName(entity.layer),
	source: entity.source.name,
	sceneState: entity.source.sceneState,
	area: entity.source.area,
	pivot: entity.pivot,
	...chunkEntityJson(entity, names),
});

/**
 * formats a raw chunk entity's transform, bounds, components, and draws for JSON output
 *
 * @param entity chunk entity
 * @param names asset name lookup
 * @returns plain JSON-friendly object
 */
export const chunkEntityJson = (entity: ChunkEntity, { pathOf, bundleOf }: AssetNames): object => {
	let renderer = null;
	if (entity.renderer !== null) {
		renderer = {
			lodCount: entity.renderer.lodCount,
			draws: entity.renderer.draws.map((draw) => ({
				lod: draw.lod,
				mesh: pathOf(draw.meshHash) ?? `0x${draw.meshHash.toString(16)}`,
				meshBundle: bundleOf(draw.meshHash),
				material: pathOf(draw.materialHash) ?? `0x${draw.materialHash.toString(16)}`,
				materialBundle: bundleOf(draw.materialHash),
				submesh: draw.submesh,
				flags: draw.flags,
				lodMaxSquared: draw.lodMaxSquared,
				lodMinSquared: draw.lodMinSquared,
			})),
		};
	}
	return {
		matrix: entity.matrix === null ? null : [...entity.matrix],
		bounds: entity.bounds,
		decal: entity.decal,
		waterDecal: entity.waterDecal,
		components: entity.components,
		renderer,
	};
};
