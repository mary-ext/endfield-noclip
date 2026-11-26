import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	EnvironmentVolumeType,
	type EnvironmentVolume,
	type PolyLineShape,
} from '@endfield-noclip/formats/endfield/environment-volume';
import type { LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import type { Context } from '../install/context.ts';
import { VfsGroup } from '../install/vfs.ts';

import type { SceneEnvironmentVolume } from './environment.ts';

const ROOT = 'Beyond_Gameplay_LevelDataForMemoryPack';
const ENV_FIELDS = new Set(['environmentVolumes']);

type Obj = Record<string, MemoryPackValue>;

const asObj = (value: MemoryPackValue | undefined): Obj | null =>
	value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;

const asNum = (value: MemoryPackValue | undefined, fallback = 0): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const asVec3 = (value: MemoryPackValue | undefined): Vec3 =>
	Array.isArray(value) && value.length === 3
		? [asNum(value[0]), asNum(value[1]), asNum(value[2])]
		: [0, 0, 0];

const readPolyLineShape = (raw: MemoryPackValue | undefined): PolyLineShape | null => {
	const obj = asObj(raw);
	if (obj === null || !Array.isArray(obj.m_posList) || obj.m_posList.length < 3) {
		return null;
	}
	const position = asVec3(obj.m_position);
	const rotation = asVec3(obj.m_rotation);
	const yaw = (rotation[1] * Math.PI) / 180;
	const c = Math.cos(yaw);
	const s = Math.sin(yaw);
	const points: [number, number][] = [];
	for (const pt of obj.m_posList) {
		if (!Array.isArray(pt) || pt.length < 2) {
			return null;
		}
		const lx = asNum(pt[0]);
		const lz = asNum(pt[1]);
		points.push([position[0] + lx * c + lz * s, position[2] - lx * s + lz * c]);
	}
	return {
		position,
		rotation,
		points,
		height: asNum(obj.m_height),
		baseHeightOffset: asNum(obj.m_baseHeightOffset),
	};
};

const phaseBaseName = (path: string): string => {
	const slash = path.lastIndexOf('/');
	const file = slash >= 0 ? path.slice(slash + 1) : path;
	return file.replace(/\.asset$/i, '');
};

/**
 * reads script-activated dynamic environment volumes (`environmentVolumes`) from the scene's LevelData files
 * (e.g. quest rain and Energy Point storm volumes). each volume defaults off in the viewer and is excluded
 * from the level's base-environment vote.
 *
 * @param context vfs, world index, and MemoryPack reader
 * @param scene the scene id (e.g. `map02`)
 * @param level single level id when packing one level, or `null` for the whole scene
 * @param partition the scene's level partition, for level tags
 * @returns deduplicated dynamic environment volumes in level/file order
 */
export const readDynamicEnvironmentVolumes = async (
	context: Pick<Context, 'vfs' | 'world' | 'memoryPack'>,
	scene: string,
	level: string | null,
	partition: LevelPartition | undefined,
): Promise<SceneEnvironmentVolume[]> => {
	const { vfs, world } = context;
	const [reader, pathOf, configs] = await Promise.all([
		context.memoryPack(),
		world.pathLookup(),
		world.levelConfigs(),
	]);
	const hashCache = new Map<string, bigint | null>();
	const hashOf = async (path: string): Promise<bigint | null> => {
		const cached = hashCache.get(path);
		if (cached !== undefined) {
			return cached;
		}
		const [hash] = await world.hashesOf(path);
		const result = hash ?? null;
		hashCache.set(path, result);
		return result;
	};
	const seen = new Set<string>();
	const out: SceneEnvironmentVolume[] = [];
	for (const config of configs.values()) {
		if (config.mapId !== scene || (level !== null && config.id !== level)) {
			continue;
		}
		const tag = partition?.levels.find((entry) => entry.id === config.id)?.tag ?? 0;
		for (const hash of config.levelDataPathHashes ?? []) {
			const path = pathOf(hash);
			if (!path) {
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop -- one level file at a time bounds memory
			const bytes = await vfs.read(VfsGroup.JsonData, path);
			let data: MemoryPackValue;
			try {
				data = reader.decodeFields(bytes, ROOT, ENV_FIELDS);
			} catch (error) {
				if (error instanceof FormatError) {
					continue;
				}
				throw error;
			}
			const root = asObj(data);
			const rows = Array.isArray(root?.environmentVolumes) ? root.environmentVolumes : [];
			for (const entry of rows) {
				const row = asObj(entry);
				if (row === null) {
					continue;
				}
				const rawId = row.volumeId;
				const volumeId = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : '';
				if (volumeId !== '' && seen.has(volumeId)) {
					continue;
				}
				if (volumeId !== '') {
					seen.add(volumeId);
				}
				const phasePath = typeof row.envPhasePath === 'string' ? row.envPhasePath : '';
				// oxlint-disable-next-line no-await-in-loop -- cached per unique dynamic phase path
				const envPhase = phasePath === '' ? null : await hashOf(phasePath);
				const volumeType = asNum(row.volumeType, -1);
				const volume: EnvironmentVolume = {
					id: Number(volumeId) || 0,
					name: phasePath === '' ? `dynamic_${volumeId}` : `${phaseBaseName(phasePath)} (dynamic)`,
					transform: {
						position: asVec3(row.position),
						rotation: asVec3(row.rotation),
						scale: asVec3(row.scale),
					},
					volumeType,
					blendMode: asNum(row.blendMode, 2),
					blendDistance: asNum(row.blendDistance, 0),
					fadeInDuration: asNum(row.fadeInDuration, 0),
					fadeOutDuration: asNum(row.fadeOutDuration, 0),
					priority: asNum(row.priority, 0),
					envPhase,
					shape: volumeType === EnvironmentVolumeType.PolyArea ? readPolyLineShape(row.polyLineShape) : null,
				};
				out.push({
					tag,
					sceneStates: [],
					volume,
					phaseObject: null,
					condition: null,
					loadedByDefault: false,
					dynamic: true,
				});
			}
		}
	}
	return out;
};
