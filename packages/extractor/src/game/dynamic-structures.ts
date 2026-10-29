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

import type { Context } from '../context.ts';
import { VfsGroup } from '../hg/vfs.ts';

import { shownResourceGroups, summarizeProgressions, labelProgression } from './scene-states.ts';

/** an initial prefab placement and its owning level */
export interface StructureModel {
	model: DynamicModel;
	levelTag: number;
	source: string;
}

/** initial structures decoded from dynamic resources */
export interface DynamicStructures {
	entities: ChunkEntity[];
	models: StructureModel[];
	/** selections and exclusions, for the pack report */
	counts: Record<string, number>;
}

/**
 * resolves initial dynamic scenery from a scene's main grids and paired ECS chunks. story-gated resources
 * remain excluded until an authored initial story selection can be evaluated
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
		counts: {
			owners: owners.length,
			storyGated: 0,
			scriptGated: 0,
			laterForms: 0,
			effects: 0,
			ecsGroups: 0,
			models: 0,
		},
	};
	const chunks = new Map<string, Set<number>>();
	const selectedModels = new Set<string>();
	const states = {
		map: scene,
		areas: [],
		progressions: summarizeProgressions(owners.map(({ entity }) => entity)).map((summary) =>
			labelProgression(summary, null, null),
		),
	};
	for (const owner of owners) {
		const { entity } = owner;
		// scripted scenery is not initially loaded unless its stored default says so.
		if (owner.scriptDefaultLoad === false) {
			result.counts.scriptGated += entity.resourceGroups.length;
			continue;
		}
		const shown = new Set(shownResourceGroups(entity, states, { areas: 'all', levels: {} }));
		for (const [i, group] of entity.resourceGroups.entries()) {
			if (owner.states.length > 0 || owner.groupStates[i].length > 0) {
				result.counts.storyGated++;
				continue;
			}
			if (!shown.has(group)) {
				result.counts.laterForms++;
				continue;
			}
			const ref = group.resources;
			if (ref.count === 0) {
				continue;
			}
			const grid = grids.get(ref.grid);
			if (grid === undefined) {
				throw new FormatError(`missing dynamic grid ${ref.grid}`);
			}
			switch (ref.type) {
				case 5: {
					for (const [index, model] of dynamicResourceSlice(grid.models, ref).entries()) {
						const key = `${ref.grid}/${ref.index + index}`;
						if (!selectedModels.has(key)) {
							selectedModels.add(key);
							result.models.push({
								model,
								levelTag: partition?.levels.find((level) => level.idNum === group.levelNum)?.tag ?? 0,
								source: key,
							});
						}
					}
					break;
				}
				case 7: {
					for (const ecs of dynamicResourceSlice(grid.ecs, ref)) {
						const key = `${ecs.sceneIndex.toString().padStart(2, '0')}_${ecs.chunk.toString().padStart(8, '0')}`;
						const indices = chunks.get(key) ?? new Set<number>();
						indices.add(ecs.index);
						chunks.set(key, indices);
					}
					break;
				}
				case 6: {
					result.counts.effects += ref.count;
					break;
				}
				default: {
					throw new FormatError(`unsupported dynamic resource type ${ref.type}`);
				}
			}
		}
	}
	const seen = new Set<number>();
	for (const [key, indices] of chunks) {
		// oxlint-disable-next-line no-await-in-loop -- paired chunks are released after selected rows are decoded
		const [init, streaming] = await Promise.all([
			read(`${prefix}fb_init_${key}.bytes`),
			read(`${prefix}fb_streaming_${key}.bytes`),
		]);
		const chunk = parseDynamicChunk(unpackHgPayload(init), unpackHgPayload(streaming));
		const groups = [...indices]
			.toSorted((a, b) => a - b)
			.map((index) => {
				const group = chunk.groups[index];
				if (group === undefined) {
					throw new FormatError(`missing ECS group ${key}/${index}`);
				}
				return group;
			});
		result.counts.ecsGroups += groups.length;
		for (const entity of readChunkEntities({ ...chunk, groups })) {
			if (!seen.has(entity.id)) {
				seen.add(entity.id);
				result.entities.push(entity);
			}
		}
	}
	result.counts.models = result.models.length;
	return result;
};
