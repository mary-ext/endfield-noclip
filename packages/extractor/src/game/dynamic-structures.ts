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
import type { ConditionalSetInfo, SceneControl } from '@endfield-noclip/package-format/states';

import type { Context } from '../context.ts';
import { VfsGroup } from '../hg/vfs.ts';

import { allOf, gateCondition, type Alternatives, type GameState } from './game-state.ts';
import { sceneStateControl, SWITCH_VALUES } from './scene-conditions.ts';
import { controllerKey, progressionId } from './scenery-variants.ts';

/** `EDynamicSceneEntityType.Tree`: harvestable trees, whose logic state is standing or felled */
const TREE_ENTITY = 19;

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
	/** script-group and logic-gate controls; load gates read controls of the game state instead */
	controls: SceneControl[];
	/** MapConfig scene state indices the visibility expressions require, as `sceneStateControl` controls */
	sceneStates: Set<number>;
	models: StructureModel[];
	/** selections and exclusions, for the pack report */
	counts: Record<string, number>;
}

/**
 * resolves dynamic scenery and preserves progression masks, load gates and manual script/state gates
 *
 * @param context install readers
 * @param scene streaming scene id
 * @param partition level ownership, when available
 * @param game the scene's game state; the load gates' conditions are noted in it and read its controls
 * @returns ECS renderers and prefab placements, deduplicated by their stored resource references
 * @throws {FormatError} if a selected resource has no grid, chunk or group
 */
export const loadDynamicStructures = async (
	context: Pick<Context, 'vfs'>,
	scene: string,
	partition: LevelPartition | undefined,
	game: GameState,
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
		controls: [],
		sceneStates: new Set(),
		counts: { owners: owners.length, ecsGroups: 0, models: 0, effects: 0 },
	};
	const controls = new Map<string, SceneControl>();
	game.note(owners.flatMap((owner) => owner.entity.gates.map(gateCondition)));
	const chunks = new Map<string, Map<number, ConditionalSetInfo>>();
	const models = new Map<string, StructureModel>();
	const ordinals = new Map<number, number>();
	const addSwitch = (kind: 'script' | 'logic', id: string, enabled: boolean): void => {
		if (!controls.has(id)) {
			controls.set(id, {
				kind,
				id,
				name: id,
				rule: null,
				assumption:
					kind === 'logic'
						? 'no recovered controller, so off'
						: enabled
							? 'authored to load until a script hides it'
							: 'loads only when a level script shows it',
				story: null,
				drivers: [],
				levelTags: [],
				values: SWITCH_VALUES,
				default: Number(enabled),
				derived: null,
			});
		}
	};
	for (const owner of owners) {
		const { entity } = owner;
		const ordinal = ordinals.get(entity.grid) ?? 0;
		ordinals.set(entity.grid, ordinal + 1);
		// level scripts address script-controlled entities by their global id, which holds across builds
		const owned = entity.uid === null ? `${entity.grid}:${ordinal}` : String(entity.uid);
		const controller = entity.controllers[0];
		const gates = entity.gates.reduce<Alternatives>(
			(partial, gate) => allOf(partial, game.requirements(gateCondition(gate))),
			[[]],
		);
		for (const [i, group] of entity.resourceGroups.entries()) {
			const ref = group.resources;
			if (ref.count === 0) {
				continue;
			}
			const tag = partition?.levels.find((level) => level.idNum === group.levelNum)?.tag ?? 0;
			let alternatives = gates;
			if (owner.scriptDefaultLoad !== null) {
				addSwitch('script', `script:${owned}`, owner.scriptDefaultLoad);
				alternatives = allOf(alternatives, [[{ control: `script:${owned}`, mask: 2 }]]);
			}
			if (group.logicState !== 0) {
				if (controller) {
					alternatives = allOf(alternatives, [
						[{ control: progressionId(controller.kind, controllerKey(controller)), mask: group.logicState }],
					]);
				} else if (entity.entityType === TREE_ENTITY) {
					// bit 0 standing, bit 1 the stump: the player fells each tree at runtime, so one control per
					// level previews them all
					const id = `harvest:${tag}`;
					if (!controls.has(id)) {
						controls.set(id, {
							kind: 'harvest',
							id,
							name: 'Harvestable trees',
							rule: null,
							assumption: 'standing, as before the player fells them',
							story: null,
							drivers: [],
							levelTags: [],
							values: [
								{ value: 0, label: 'standing' },
								{ value: 1, label: 'felled' },
							],
							default: 0,
							derived: null,
						});
					}
					alternatives = allOf(alternatives, [[{ control: id, mask: group.logicState }]]);
				} else if ((group.logicState & 1) === 0) {
					const id = `logic:${owned}:${group.logicState}`;
					addSwitch('logic', id, false);
					alternatives = allOf(alternatives, [[{ control: id, mask: 2 }]]);
				}
			}
			// visible-state lists hold MapConfig scene state indices; the entity and the group each need one of
			// theirs active
			for (const states of [owner.states, owner.groupStates[i]]) {
				if (states.length === 0) {
					continue;
				}
				for (const index of states) {
					result.sceneStates.add(index);
				}
				alternatives = allOf(
					alternatives,
					states.map((index) => [{ control: sceneStateControl(index), mask: 2 }]),
				);
			}
			const grid = grids.get(ref.grid);
			if (!grid) {
				throw new FormatError(`missing dynamic grid ${ref.grid}`);
			}
			switch (ref.type) {
				// effect rows place prefabs like model rows, from their own vector
				case 5:
				case 6: {
					const effect = ref.type === 6;
					const rows = dynamicResourceSlice(effect ? grid.effects : grid.models, ref);
					if (effect) {
						result.counts.effects += rows.length;
					}
					for (const [index, model] of rows.entries()) {
						const key = `${effect ? 'effect:' : ''}${ref.grid}/${ref.index + index}`;
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
	for (const control of controls.values()) {
		if (control.kind === 'harvest') {
			continue;
		}
		const ranked = [...(labels.get(control.id) ?? [])].toSorted((a, b) => b[1] - a[1]);
		control.name =
			ranked
				.slice(0, 2)
				.map(([name]) => name)
				.join(' / ') || control.id;
	}
	result.entities = [...entities.values()];
	result.models = [...models.values()];
	result.controls = [...controls.values()];
	result.counts.models = result.models.length;
	return result;
};
