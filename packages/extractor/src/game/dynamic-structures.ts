import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	dynamicResourceSlice,
	readDynamicResources,
	type DynamicModel,
	type DynamicResourceEntity,
	type DynamicResourceGrid,
} from '@endfield-noclip/formats/endfield/dynamic-resources';
import {
	parseDynamicChunk,
	readChunkEntities,
	type ChunkEntity,
} from '@endfield-noclip/formats/endfield/init-chunk-data';
import type { LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import { unpackHgPayload } from '@endfield-noclip/formats/hg/payload';
import type {
	ConditionalSetInfo,
	SceneRequirement,
	SceneToggleInfo,
} from '@endfield-noclip/package-format/format';

import type { Context } from '../context.ts';
import { VfsGroup } from '../hg/vfs.ts';

import { sceneStateControl } from './scene-conditions.ts';
import { controllerKey, progressionId } from './scene-states.ts';

/** a prefab placement and its owning level */
export interface StructureModel {
	model: DynamicModel;
	levelTag: number;
	source: string;
	visibility: ConditionalSetInfo;
}

/** structures and their visibility decoded from dynamic resources */
export interface DynamicStructures {
	entities: { entity: ChunkEntity; visibility: ConditionalSetInfo }[];
	toggles: SceneToggleInfo[];
	/** MapConfig scene state indices the visibility expressions require, as `sceneStateControl` controls */
	sceneStates: Set<number>;
	models: StructureModel[];
	/** selections and exclusions, for the pack report */
	counts: Record<string, number>;
}

/**
 * resolves dynamic scenery and preserves progression masks and manual script/state gates
 *
 * @param context install readers
 * @param scene streaming scene id
 * @param partition level ownership, when available
 * @returns ECS renderers and prefab placements, deduplicated by their stored resource references
 * @throws {FormatError} if a selected resource has no grid, chunk or group
 */
export const loadDynamicStructures = async (
	context: Pick<Context, 'vfs'>,
	scene: string,
	partition: LevelPartition | undefined,
): Promise<DynamicStructures> => {
	const { vfs } = context;
	const prefix = `Data/DynamicStreaming/PC/Scene/${scene}/`;
	const names = [...(await vfs.group(VfsGroup.DynamicStreaming)).files.keys()]
		.filter((name) => name.startsWith(`${prefix}fb_main_`))
		.toSorted();
	const read = async (name: string): Promise<Uint8Array> => {
		const file = await vfs.find(VfsGroup.DynamicStreaming, name);
		if (file === undefined) {
			throw new FormatError(`missing dynamic resource ${name}`);
		}
		return vfs.readVerified(file);
	};
	const grids = new Map<number, DynamicResourceGrid>();
	const owners: DynamicResourceEntity[] = [];
	for (const name of names) {
		// oxlint-disable-next-line no-await-in-loop -- main files are small and released after decoding
		const decoded = readDynamicResources(await read(name));
		for (const grid of decoded.grids) {
			if (grids.has(grid.id)) {
				throw new FormatError(`duplicate dynamic grid ${grid.id}`);
			}
			grids.set(grid.id, grid);
		}
		owners.push(...decoded.entities);
	}
	const result: DynamicStructures = {
		entities: [],
		models: [],
		toggles: [],
		sceneStates: new Set(),
		counts: { owners: owners.length, ecsGroups: 0, models: 0, effects: 0 },
	};
	const toggles = new Map<string, SceneToggleInfo>();
	const chunks = new Map<string, Map<number, ConditionalSetInfo>>();
	const models = new Map<string, StructureModel>();
	const ordinals = new Map<number, number>();
	const addToggle = (id: string, kind: SceneToggleInfo['kind'], enabled: boolean, tags: number[]): void => {
		const current = toggles.get(id);
		if (current) {
			current.levels = [...new Set([...current.levels, ...tags])];
		} else {
			toggles.set(id, { id, name: id, kind, levels: tags, defaultEnabled: enabled, condition: null });
		}
	};
	for (const owner of owners) {
		const { entity } = owner;
		const ordinal = ordinals.get(entity.grid) ?? 0;
		ordinals.set(entity.grid, ordinal + 1);
		const scriptId = `script:${entity.grid}:${ordinal}`;
		const controller = entity.controllers[0];
		for (const [i, group] of entity.resourceGroups.entries()) {
			const ref = group.resources;
			if (ref.count === 0 || ref.type === 6) {
				result.counts.effects += ref.type === 6 ? ref.count : 0;
				continue;
			}
			const tag = partition?.levels.find((level) => level.idNum === group.levelNum)?.tag ?? 0;
			const requirements: SceneRequirement[] = [];
			if (owner.scriptDefaultLoad !== null) {
				addToggle(scriptId, 'script', owner.scriptDefaultLoad, [tag]);
				requirements.push({ control: scriptId, mask: 2 });
			}
			// visible-state lists hold MapConfig scene state indices; the entity and the group each need one of
			// theirs active
			const stateLists = [owner.states, owner.groupStates[i]].filter((states) => states.length > 0);
			for (const states of stateLists) {
				for (const index of states) {
					result.sceneStates.add(index);
				}
			}
			if (group.logicState !== 0) {
				if (controller) {
					requirements.push({
						control: progressionId(controller.kind, controllerKey(controller)),
						mask: group.logicState,
					});
				} else if ((group.logicState & 1) === 0) {
					const id = `state:logic:${entity.grid}:${ordinal}:${group.logicState}`;
					addToggle(id, 'state', false, [tag]);
					requirements.push({ control: id, mask: 2 });
				}
			}
			const alternatives = stateLists.reduce<SceneRequirement[][]>(
				(partial, states) =>
					partial.flatMap((chosen) =>
						states.map((index) => [...chosen, { control: sceneStateControl(index), mask: 2 }]),
					),
				[requirements],
			);
			const grid = grids.get(ref.grid);
			if (!grid) {
				throw new FormatError(`missing dynamic grid ${ref.grid}`);
			}
			switch (ref.type) {
				case 5: {
					for (const [index, model] of dynamicResourceSlice(grid.models, ref).entries()) {
						const key = `${ref.grid}/${ref.index + index}`;
						const current = models.get(key);
						if (current) {
							current.visibility.alternatives.push(...alternatives);
						} else {
							models.set(key, {
								model,
								levelTag: tag,
								source: key,
								visibility: { alternatives: [...alternatives] },
							});
						}
					}
					break;
				}
				case 7: {
					for (const ecs of dynamicResourceSlice(grid.ecs, ref)) {
						const key = `${ecs.sceneIndex.toString().padStart(2, '0')}_${ecs.chunk.toString().padStart(8, '0')}`;
						const indices = chunks.get(key) ?? new Map<number, ConditionalSetInfo>();
						const visibility = indices.get(ecs.index) ?? { alternatives: [] };
						visibility.alternatives.push(...alternatives);
						indices.set(ecs.index, visibility);
						chunks.set(key, indices);
					}
					break;
				}
				default: {
					throw new FormatError(`unsupported dynamic resource type ${ref.type}`);
				}
			}
		}
	}
	const entities = new Map<number, { entity: ChunkEntity; visibility: ConditionalSetInfo }>();
	for (const [key, indices] of chunks) {
		// oxlint-disable-next-line no-await-in-loop -- release each pair after its renderer groups are decoded
		const [init, streaming] = await Promise.all([
			read(`${prefix}fb_init_${key}.bytes`),
			read(`${prefix}fb_streaming_${key}.bytes`),
		]);
		const chunk = parseDynamicChunk(unpackHgPayload(init), unpackHgPayload(streaming));
		for (const [index, visibility] of indices) {
			const group = chunk.groups[index];
			if (!group) {
				throw new FormatError(`missing ECS group ${key}/${index}`);
			}
			result.counts.ecsGroups++;
			for (const entity of readChunkEntities({ ...chunk, groups: [group] })) {
				const current = entities.get(entity.id);
				if (current) {
					current.visibility.alternatives.push(...visibility.alternatives);
				} else {
					entities.set(entity.id, { entity, visibility: { alternatives: [...visibility.alternatives] } });
				}
			}
		}
	}
	// representative renderer names identify manual groups without assigning an invented event condition.
	const labels = new Map<string, Map<string, number>>();
	for (const { entity, visibility } of entities.values()) {
		const name = entity.name.replace(/#.*$/, '').replace(/ \(\d+\)(?:_ECSMerged)?$/, '');
		for (const control of new Set(
			visibility.alternatives.flatMap((requirements) =>
				requirements.map((requirement) => requirement.control),
			),
		)) {
			const frequencies = labels.get(control) ?? new Map<string, number>();
			frequencies.set(name, (frequencies.get(name) ?? 0) + 1);
			labels.set(control, frequencies);
		}
	}
	for (const toggle of toggles.values()) {
		const ranked = [...(labels.get(toggle.id) ?? [])].toSorted((a, b) => b[1] - a[1]);
		toggle.name =
			ranked
				.slice(0, 2)
				.map(([name]) => name)
				.join(' / ') || toggle.id;
	}
	result.entities = [...entities.values()];
	result.models = [...models.values()];
	result.toggles = [...toggles.values()];
	result.counts.models = result.models.length;
	return result;
};
