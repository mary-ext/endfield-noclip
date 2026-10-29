import {
	resourceGroupShown,
	type DynamicController,
	type DynamicEntity,
	type DynamicResourceGroup,
} from '@endfield-noclip/formats/endfield/dynamic-scene';
import { levelOfTag, type LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import type { StreamAreaTable } from '@endfield-noclip/formats/endfield/stream-area';

import { mapPool } from '../pool.ts';

import type { ChunkFile, WorldIndex } from './world-index.ts';

// scenery variants of an open-world map come from three independent mechanisms:
//
// - stream areas: static InitChunkData files whose `<areaId>` (last) suffix is non-zero belong to that stream
//   area. which areas are shown depends on where the camera is (FBStreamArea triggers), not on progress. they
//   only add entities to area 0; none of their ids or placements repeat an area-0 entity.
// - progression controllers: DynamicStreaming entities whose resource groups carry LogicState bitmasks. the
//   entity's logic state is its level (outpost/settlement level, POI facility level, factory region level), so a
//   group with bit n set is shown at level n. all variants are stored side by side; nothing is a file swap.
// - scene states: MapConfig states switched by quest/mission/variable conditions (see `scene-conditions.ts`).
//   static files carry them as the `<sceneStateId>` suffix, dynamic entities as state-index lists.

// #region types

/** where a stream area sits: its owning level and when the client shows it */
interface AreaLabel {
	/** level owning most of its entities, by id tag */
	levelId: string | null;
	/** shown while the camera is in no trigger */
	rootVisible: boolean;
	/**
	 * trigger zones (themselves area ids, usually without chunks of their own) whose visible slice includes
	 * this area; entering a zone replaces the root set with its slice
	 */
	shownInside: number[];
}

/** a stream area and what the static scenery of that area holds */
export interface StreamAreaInfo extends AreaLabel {
	/** the `<areaId>` of its chunk files */
	id: number;
	levelName: string | null;
	chunkFiles: number;
	/** unique entities in its chunk files */
	entities: number;
}

/** how a progression controller is labelled */
export type ProgressionKind = DynamicController['kind'];

/** one selectable progression (an outpost, a POI facility, a factory region) and its levels */
export interface SceneProgression {
	kind: ProgressionKind;
	/** settlement id, POI id or region level id, unique per kind within a map */
	key: string;
	/** level its resource groups belong to (LevelConfig id) */
	levelId: string | null;
	levelName: string | null;
	/** levels (logic-state bits) at least one group is shown at, ascending */
	levels: number[];
	/** the lowest authored level, used for the initial appearance */
	defaultLevel: number;
	/** controlling entities (settlements have a main and a secondary one) */
	entities: number;
	/** resource groups shown at each level */
	groupsPerLevel: Record<number, number>;
}

/** every selectable scenery state of a map */
export interface SceneStates {
	map: string;
	areas: StreamAreaInfo[];
	progressions: SceneProgression[];
}

/** a choice of states to show */
export interface StateSelection {
	/**
	 * `all` shows every area (the whole world revealed); `root` what the client shows outside any trigger; a
	 * list shows state 0 plus exactly those areas
	 */
	areas: 'all' | 'root' | number[];
	/** progression level by {@link progressionId}; unset progressions use their default level */
	levels: Record<string, number>;
}

// #endregion

// #region loading

/** chunk files read at once */
const READ_CONCURRENCY = 16;

/**
 * catalogues a map's stream areas and progression controllers. reads every non-zero-area chunk file and every
 * `fb_main` file of the scene, so it takes a few seconds
 *
 * @param world world index
 * @param scene streaming scene, e.g. `map02`
 * @returns the scene's selectable states
 */
export const loadSceneStates = async (world: WorldIndex, scene: string): Promise<SceneStates> => {
	const names = await world.names();
	const partition = await world.partition(scene);
	const table = await world.streamAreas(scene);

	const areaFiles = new Map<number, ChunkFile[]>();
	for (const file of await world.chunkFiles()) {
		if (file.scene === scene && file.area !== 0) {
			const list = areaFiles.get(file.area) ?? [];
			list.push(file);
			areaFiles.set(file.area, list);
		}
	}
	const allFiles = [...areaFiles.values()].flat();
	// keep only what the tally needs, so all files' entities needn't stay in memory at once
	const perFile = await mapPool(allFiles, READ_CONCURRENCY, async (file) =>
		(await world.readChunk(file, undefined)).map(({ id, levelTag }) => ({ id, levelTag })),
	);
	const entitiesOf = new Map(allFiles.map((file, i) => [file, perFile[i]]));
	const areas: StreamAreaInfo[] = [];
	for (const [id, files] of [...areaFiles].toSorted((a, b) => a[0] - b[0])) {
		const seen = new Set<number>();
		const tags = new Map<number, number>();
		for (const file of files) {
			for (const entity of entitiesOf.get(file) ?? []) {
				if (!seen.has(entity.id)) {
					seen.add(entity.id);
					tags.set(entity.levelTag, (tags.get(entity.levelTag) ?? 0) + 1);
				}
			}
		}
		const { levelId, rootVisible, shownInside } = labelArea(id, tags, partition, table);
		areas.push({
			id,
			levelId,
			levelName: (levelId && names.get(levelId)) ?? null,
			rootVisible,
			shownInside,
			chunkFiles: files.length,
			entities: seen.size,
		});
	}

	return { map: scene, areas, progressions: await loadProgressions(world, scene) };
};

/**
 * @param world world index
 * @param scene streaming scene
 * @returns the scene's progression controllers with their levels named, sorted by kind then key
 */
export const loadProgressions = async (world: WorldIndex, scene: string): Promise<SceneProgression[]> => {
	const names = await world.names();
	const byIdNum = new Map(
		[...(await world.levelConfigs()).values()].map((config) => [config.idNum, config.id]),
	);
	return summarizeProgressions(await world.dynamicEntities(scene)).map((summary) => {
		const levelId = summary.levelNum === null ? null : (byIdNum.get(summary.levelNum) ?? null);
		return labelProgression(summary, levelId, (levelId && names.get(levelId)) ?? null);
	});
};

// #endregion

// #region pure helpers

/**
 * @param id area id
 * @param tags level-tag vote counts of the area's entities, or `undefined` if none were counted
 * @param partition the map's partition, if it has levels
 * @param table the scene's stream-area table, if it has one
 * @returns the area's owning level (the tag with the most votes, earliest on ties) and visibility
 */
const labelArea = (
	id: number,
	tags: ReadonlyMap<number, number> | undefined,
	partition: LevelPartition | undefined,
	table: StreamAreaTable | undefined,
): AreaLabel => {
	let majority: number | undefined;
	let best = 0;
	for (const [tag, count] of tags ?? []) {
		if (count > best) {
			majority = tag;
			best = count;
		}
	}
	return {
		levelId: (partition && majority !== undefined && levelOfTag(partition, majority)?.id) || null,
		rootVisible: table?.rootVisible.includes(id) ?? false,
		shownInside: table ? revealingAreas(table, id) : [],
	};
};

/**
 * @param table stream-area table
 * @param area area id
 * @returns ids of areas whose trigger slice includes `area`, excluding itself
 */
const revealingAreas = (table: StreamAreaTable, area: number): number[] => {
	const ids: number[] = [];
	for (const [id, visible] of table.visibleWhileInside) {
		if (id !== area && visible.includes(area)) {
			ids.push(id);
		}
	}
	return ids.toSorted((a, b) => a - b);
};

/**
 * @param kind progression kind
 * @param key its key within the kind
 * @returns the progression's id: `${kind}:${key}`, its key in {@link StateSelection.levels}
 */
export const progressionId = (kind: ProgressionKind, key: string): string => `${kind}:${key}`;

/**
 * @param controller a decoded progression controller
 * @returns the key of the progression it drives, within its kind
 */
export const controllerKey = (controller: DynamicController): string => {
	switch (controller.kind) {
		case 'settlement': {
			return controller.settlementId;
		}
		case 'poi': {
			return controller.poiId;
		}
		case 'factoryRegion': {
			return controller.regionId;
		}
	}
};

/** a {@link SceneProgression} before its level is named */
export type ProgressionSummary = Omit<SceneProgression, 'levelId' | 'levelName'> & {
	/** LevelConfig idNum shared by its gated groups, `null` if they disagree */
	levelNum: number | null;
};

/**
 * groups progression-controlled entities by controller and collects the levels their resource groups use
 *
 * @param entities DynamicStreaming entities
 * @returns one entry per controller key, sorted by kind then key
 */
export const summarizeProgressions = (entities: Iterable<DynamicEntity>): ProgressionSummary[] => {
	const byId = new Map<
		string,
		{
			kind: ProgressionKind;
			key: string;
			entities: number;
			levelNums: Set<number>;
			perLevel: Map<number, number>;
		}
	>();
	for (const entity of entities) {
		for (const controller of entity.controllers) {
			const key = controllerKey(controller);
			const id = progressionId(controller.kind, key);
			const entry = byId.get(id) ?? {
				kind: controller.kind,
				key,
				entities: 0,
				levelNums: new Set<number>(),
				perLevel: new Map<number, number>(),
			};
			entry.entities++;
			for (const group of entity.resourceGroups) {
				if (group.logicState === 0) {
					continue;
				}
				entry.levelNums.add(group.levelNum);
				for (const level of maskLevels(group.logicState)) {
					entry.perLevel.set(level, (entry.perLevel.get(level) ?? 0) + 1);
				}
			}
			byId.set(id, entry);
		}
	}
	return [...byId.values()]
		.filter((entry) => entry.perLevel.size > 0)
		.map((entry) => {
			const levels = [...entry.perLevel.keys()].toSorted((a, b) => a - b);
			return {
				kind: entry.kind,
				key: entry.key,
				levels,
				defaultLevel: levels[0],
				entities: entry.entities,
				groupsPerLevel: Object.fromEntries(levels.map((level) => [level, entry.perLevel.get(level) ?? 0])),
				levelNum: entry.levelNums.size === 1 ? [...entry.levelNums][0] : null,
			};
		})
		.toSorted((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
};

/**
 * @param summary a progression summary
 * @param levelId its level's LevelConfig id
 * @param levelName its level's display name
 * @returns the summary as a catalogue entry
 */
export const labelProgression = (
	summary: ProgressionSummary,
	levelId: string | null,
	levelName: string | null,
): SceneProgression => ({
	kind: summary.kind,
	key: summary.key,
	levelId,
	levelName,
	levels: summary.levels,
	defaultLevel: summary.defaultLevel,
	entities: summary.entities,
	groupsPerLevel: summary.groupsPerLevel,
});

/** @returns the bit indices set in a LogicState mask, ascending */
export const maskLevels = (mask: number): number[] => {
	const levels: number[] = [];
	for (let bit = 0; bit < 32; bit++) {
		if ((mask >>> bit) & 1) {
			levels.push(bit);
		}
	}
	return levels;
};

/**
 * @param states the map's catalogue
 * @param table its stream-area table, for `root`
 * @param selection what to show
 * @returns area ids to load, always including 0
 */
export const selectedAreas = (
	states: SceneStates,
	table: StreamAreaTable | undefined,
	selection: StateSelection,
): Set<number> => {
	const ids = new Set<number>([0]);
	if (selection.areas === 'all') {
		for (const area of states.areas) {
			ids.add(area.id);
		}
	} else if (selection.areas === 'root') {
		for (const id of table?.rootVisible ?? []) {
			ids.add(id);
		}
	} else {
		for (const id of selection.areas) {
			ids.add(id);
		}
	}
	return ids;
};

/**
 * @param files candidate InitChunkData files (any scenes)
 * @param scene streaming scene
 * @param areas area ids to show, from {@link selectedAreas}
 * @returns the scene's files belonging to those areas, in input order
 */
export const resolveChunkFiles = (
	files: readonly ChunkFile[],
	scene: string,
	areas: ReadonlySet<number>,
): ChunkFile[] => {
	return files.filter((file) => file.scene === scene && areas.has(file.area));
};

/**
 * @returns the logic state to evaluate the entity's resource groups with: the selected (else default) level
 *   of its first progression controller, or 0 for entities without one
 */
const entityLogicState = (entity: DynamicEntity, states: SceneStates, selection: StateSelection): number => {
	for (const controller of entity.controllers) {
		const key = controllerKey(controller);
		const chosen = selection.levels[progressionId(controller.kind, key)];
		if (chosen !== undefined) {
			return chosen;
		}
		const progression = states.progressions.find((p) => p.kind === controller.kind && p.key === key);
		if (progression) {
			return progression.defaultLevel;
		}
	}
	return 0;
};

/**
 * @param entity a DynamicStreaming entity
 * @param states the map's catalogue
 * @param selection chosen levels
 * @returns the entity's resource groups shown under the selection
 */
export const shownResourceGroups = (
	entity: DynamicEntity,
	states: SceneStates,
	selection: StateSelection,
): DynamicResourceGroup[] => {
	const state = entityLogicState(entity, states, selection);
	return entity.resourceGroups.filter((group) => resourceGroupShown(group, state));
};

// #endregion
