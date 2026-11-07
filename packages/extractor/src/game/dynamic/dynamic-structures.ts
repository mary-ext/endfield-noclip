import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { readChunkLights, type ChunkLight } from '@endfield-noclip/formats/endfield/chunk-lights';
import {
	dynamicResourceSlice,
	readDynamicResources,
	type DynamicEcs,
	type DynamicModel,
	type DynamicResourceEntity,
	type DynamicResourceGrid,
} from '@endfield-noclip/formats/endfield/dynamic-resources';
import type {
	DynamicDataRef,
	DynamicEntity as DynamicSceneEntity,
	DynamicGate,
	DynamicVariable,
	ExtraSceneSlot,
} from '@endfield-noclip/formats/endfield/dynamic-scene';
import {
	parseDynamicChunk,
	readChunkEntities,
	type ChunkEntity,
} from '@endfield-noclip/formats/endfield/init-chunk-data';
import type { LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import {
	assetProperty,
	parseStreamingChunk,
	RECT_DECAL_MATERIAL_KEY,
} from '@endfield-noclip/formats/endfield/streaming-chunk-data';
import { unpackHgPayload } from '@endfield-noclip/formats/hg/payload';

import { mapDefined } from '@mary-ext/array-fns';

import type { Context } from '../../context.ts';
import { type Vfs, VfsGroup } from '../../hg/vfs.ts';
import {
	readViewStates,
	settledPose,
	testedValues,
	type ViewStates,
} from '../interactives/view-state-poses.ts';
import type { PrefabPose } from '../prefabs/prefab.ts';
import {
	allOf,
	gateCondition,
	type Alternatives,
	type GameCondition,
	type GameState,
} from '../state/game-state.ts';
import { sceneStateControl } from '../state/scene-conditions.ts';
import {
	type Visibility,
	type DraftControl,
	sceneControl,
	scriptControl,
	streamAreaControl,
	switchValues,
	SWITCH_VALUES,
} from '../state/scene-control.ts';
import { controllerKey, progressionId } from '../state/scenery-variants.ts';

// the scene's DynamicStreaming content (docs/extraction/prefabs-and-interactives.md#dynamic-structures): the
// `fb_main` files list resource owners, each owner's resource groups name rows of prefab placements or ECS
// groups, and every row loads under its owner's and group's gates, controllers, scene states and stream
// areas. `loadDynamicStructures` reads the owners, claims the blight variables, notes every condition, gates
// and places each owner's rows, then decodes the ECS groups those rows reference.

/** `EDynamicSceneEntityType.Tree`: harvestable trees, whose logic state is standing or felled */
const TREE_ENTITY = 19;

/** a prefab placement and its owning level */
export interface StructureModel {
	model: DynamicModel;
	levelTag: number;
	source: string;
	/** the level logic id of the interactive it draws, absent for other placements */
	logicId?: string;
	/** the global id level scripts address its dynamic structure by, absent for other placements */
	owner?: string;
	visibility: Visibility;
	/** the pose to draw the prefab in, `null` for the saved one */
	pose: PrefabPose | null;
	/** whether the placement starts locked, drawing its model's locked look; absent for placements without locks */
	locked?: boolean;
	/** the `fb_main` grid storing the row, whose level sets its load distance; absent for other placements */
	grid?: number;
}

/** an ECS entity of a dynamic structure */
export interface DynamicEntity {
	entity: ChunkEntity;
	/** a rect decal's material key, from its chunk's `fb_streaming` payload; `null` for other entities */
	decalMaterial: bigint | null;
	visibility: Visibility;
	/** the coarsest `fb_main` grid referencing the entity's group, whose level sets its load distance */
	grid: number;
}

/** structures and their visibility decoded from dynamic resources */
export interface DynamicStructures {
	entities: DynamicEntity[];
	/** local lights in the ECS groups, under their structure's visibility */
	lights: { light: ChunkLight; visibility: Visibility }[];
	/** script-group and logic-gate controls; load gates read controls of the game state instead */
	controls: DraftControl[];
	/** MapConfig scene state indices the visibility expressions require, as `sceneStateControl` controls */
	sceneStates: Set<number>;
	/** stream areas the visibility expressions require, as `streamAreaControl` controls */
	areas: Set<number>;
	/** slots for separately stored scenes (Dijiang cabins), one per distinct slot, with the first owner's id */
	slots: { id: string; slot: ExtraSceneSlot }[];
	models: StructureModel[];
	/**
	 * by blight core logic id (erosion and sludge cores), the control values its blight loads under, which the
	 * core itself follows
	 */
	erosionCores: Map<string, Alternatives>;
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
	context: Pick<Context, 'vfs' | 'memoryPack' | 'world' | 'resolver'>,
	scene: string,
	partition: LevelPartition | undefined,
	game: GameState,
): Promise<DynamicStructures> => {
	const files = new DynamicFiles(context.vfs, scene);
	const { grids, owners } = await files.readOwners();
	const blights = claimBlights(owners, game);
	const driven = await drivenViewStates(context, owners, blights);
	noteOwnerConditions(game, owners, blights, driven);

	const pass = new OwnerPass(context, { game, partition, grids, owners: owners.length, blights, driven });
	for (const owner of owners) {
		// oxlint-disable-next-line no-await-in-loop -- owners in order; poses are cached per model and value
		await pass.place(owner);
	}
	return pass.finish(await files.readEcsGroups(pass.ecsGroups, pass.result.counts));
};

// #region blight

/** `ErosionCoreComponent.STATE_EROSION_DIE`: the core is destroyed and its blight cleansed */
const CORE_DESTROYED = 2;
/** `CompareOperator.Equal` */
const EQUAL = 0;
/** `CompareOperator.NotEqual` */
const NOT_EQUAL = 1;
/**
 * blight control values: the core alive or destroyed. an erosion root loads while its variable isn't 2 and a
 * sludge patch while its variable is 0; while an erosion root's variable is unset neither loads, a state the
 * control leaves out
 */
const BLIGHT_PRESENT = 0;
const BLIGHT_CLEANSED = 1;

/** a blight patch's core and the load gate that shows the patch until the core is destroyed */
interface BlightLink {
	/** the core's level-data logic id */
	core: bigint;
	/** where to name the blight after */
	position: readonly [number, number, number];
	gate: DynamicGate;
}

/** a blight patch's link to its core, and the control its variable is claimed for */
interface Blight {
	link: BlightLink;
	control: DraftControl;
}

/**
 * @returns an erosion root's or sludge patch's core and its load gate on the core; `null` for other entities,
 *   and for a patch gated some other way (left to its variable's control)
 */
const blightLink = (entity: DynamicSceneEntity): BlightLink | null => {
	const { erosionCore, sludgeCore } = entity;
	const link = erosionCore ?? sludgeCore;
	if (link === null) {
		return null;
	}
	const gate = entity.gates.find((candidate) => {
		if (candidate.kind !== 'mapVar') {
			return false;
		}
		if (erosionCore !== null) {
			return candidate.compare === NOT_EQUAL && candidate.value === CORE_DESTROYED;
		}
		return candidate.compare === EQUAL && candidate.value === 0;
	});
	return gate === undefined ? null : { core: link.id, position: link.position, gate };
};

/**
 * @param id the control id of the blight's variable
 * @param position its core's position
 * @returns the control of one blight and its core: its variable, told apart only as the core destroyed or not
 */
const blightControl = (id: string, position: readonly [number, number, number]): DraftControl =>
	sceneControl({
		kind: 'mapVar',
		id,
		name: 'Blight core',
		position,
		values: [
			{ value: BLIGHT_PRESENT, label: 'present' },
			{ value: BLIGHT_CLEANSED, label: 'cleansed' },
		],
		default: BLIGHT_CLEANSED,
		assumption: 'cleansed, as in a finished world: its core destroyed',
	});

/**
 * gives each blight's variable a control describing it, claimed before the other gates are noted
 *
 * @param owners the scene's resource owners
 * @param game the scene's game state; the variables are claimed in it
 * @returns by blight patch, its link and control
 */
const claimBlights = (
	owners: readonly DynamicResourceEntity[],
	game: GameState,
): Map<DynamicSceneEntity, Blight> => {
	const blights = new Map<DynamicSceneEntity, Blight>();
	for (const { entity } of owners) {
		const link = blightLink(entity);
		const condition = link === null ? null : gateCondition(link.gate);
		if (link === null || condition?.kind !== 'mapVar') {
			continue;
		}
		const id = game.claimVariable(condition);
		if (id !== null) {
			blights.set(entity, { link, control: blightControl(id, link.position) });
		}
	}
	return blights;
};

// #endregion

// #region variables

/** an entity whose view states a variable drives */
interface DrivenViewStates {
	variable: DynamicVariable;
	states: ViewStates;
	/** the `state` values the view states tell apart */
	values: number[];
}

/**
 * @param variable a variable an entity reads
 * @param value one of its values
 * @returns the condition that it holds that value, named as load gates name the variable, so both read one
 *   control
 */
const variableIs = (variable: DynamicVariable, value: number): GameCondition =>
	variable.kind === 'mapVar'
		? { kind: 'mapVar', mapId: String(variable.mapId), name: `#${variable.key}`, compare: 0, target: value }
		: { kind: 'globalVar', name: `#${variable.key}`, compare: 0, target: value };

/**
 * finds the entities whose view states a variable drives
 * (docs/game-data/scene-states.md#view-states-on-dynamic-entities): a view-state controller of the current
 * version and a variable, whose value the state machine reads as `state`. an entity with several variables is
 * driven by its first; a controller file that's missing, can't be read or tests no `state` value leaves its
 * entity as saved
 *
 * @param context install readers
 * @param owners the scene's dynamic entities
 * @param blights entities whose variable a blight control holds, left out
 * @returns by entity, its variable, view states and the `state` values they tell apart
 */
const drivenViewStates = async (
	context: Pick<Context, 'vfs' | 'memoryPack'>,
	owners: readonly DynamicResourceEntity[],
	blights: ReadonlyMap<DynamicSceneEntity, unknown>,
): Promise<Map<DynamicSceneEntity, DrivenViewStates>> => {
	const files = new Map<string, Promise<ViewStates | null>>();
	const driven = new Map<DynamicSceneEntity, DrivenViewStates>();
	for (const { entity } of owners) {
		const model = entity.viewState?.oldVersion === false ? entity.viewState.model : null;
		const [variable] = entity.variables;
		if (model === null || variable === undefined || blights.has(entity)) {
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop -- one read per controller file
		const states = await files.getOrInsertComputed(model, () =>
			readViewStates(context, { model, source: model }).catch((error: unknown) => {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				return null;
			}),
		);
		const values = states === null ? [] : testedValues(states, 'state');
		if (states !== null && values.length > 0) {
			driven.set(entity, { variable, states, values });
		}
	}
	return driven;
};

/**
 * a variable sets a controller-less entity's level too, which selects its groups by their logic-state bits
 *
 * @param entity a resource owner's entity
 * @param mask a resource group's logic-state bits
 * @param blights entities whose variable a blight control holds, left out
 * @returns the condition that the entity's variable selects the group, or `null` if no variable selects it
 */
const levelCondition = (
	entity: DynamicSceneEntity,
	mask: number,
	blights: ReadonlyMap<DynamicSceneEntity, unknown>,
): GameCondition | null => {
	const [variable] = entity.variables;
	if (
		variable === undefined ||
		entity.controllers.length > 0 ||
		entity.entityType === TREE_ENTITY ||
		blights.has(entity)
	) {
		return null;
	}
	const bits = [...Array.from({ length: 32 }).keys()].filter((bit) => ((mask >>> bit) & 1) !== 0);
	// a mask of most levels reads as "none of the others", keeping the variable's values few
	if (bits.length <= 16) {
		return { kind: 'any', reverse: false, conditions: bits.map((bit) => variableIs(variable, bit)) };
	}
	const others = [...Array.from({ length: 32 }).keys()].filter((bit) => !bits.includes(bit));
	return { kind: 'any', reverse: true, conditions: others.map((bit) => variableIs(variable, bit)) };
};

/** notes in the game state every condition the owners' load gates, view states and levels read */
const noteOwnerConditions = (
	game: GameState,
	owners: readonly DynamicResourceEntity[],
	blights: ReadonlyMap<DynamicSceneEntity, Blight>,
	driven: ReadonlyMap<DynamicSceneEntity, DrivenViewStates>,
): void => {
	game.note(
		owners.flatMap(({ entity }) => {
			const blight = blights.get(entity)?.link.gate;
			return entity.gates.filter((gate) => gate !== blight).map(gateCondition);
		}),
	);
	game.note(
		[...driven.values()].flatMap(({ variable, values }) => values.map((v) => variableIs(variable, v))),
	);
	game.note(
		owners.flatMap(({ entity }) =>
			mapDefined(entity.resourceGroups, (group) =>
				group.logicState === 0 ? undefined : (levelCondition(entity, group.logicState, blights) ?? undefined),
			),
		),
	);
};

// #endregion

// #region files

/** by `fb_init` chunk key and group index, when an ECS group loads and the coarsest grid referencing it */
type EcsGroups = Map<string, Map<number, { visibility: Visibility; grid: number }>>;

/** a scene's DynamicStreaming files */
class DynamicFiles {
	readonly #vfs: Vfs;
	readonly #prefix: string;

	constructor(vfs: Vfs, scene: string) {
		this.#vfs = vfs;
		this.#prefix = `Data/DynamicStreaming/PC/Scene/${scene}/`;
	}

	#read(name: string): Promise<Uint8Array> {
		return this.#vfs.readFile(VfsGroup.DynamicStreaming, `${this.#prefix}${name}`);
	}

	/**
	 * @returns the resource grids by id and the resource owners, from the `fb_main` files in name order
	 * @throws {FormatError} on a grid id two files share
	 */
	async readOwners(): Promise<{ grids: Map<number, DynamicResourceGrid>; owners: DynamicResourceEntity[] }> {
		const names = [...(await this.#vfs.group(VfsGroup.DynamicStreaming)).files.keys()]
			.filter((name) => name.startsWith(`${this.#prefix}fb_main_`))
			.map((name) => name.slice(this.#prefix.length))
			.toSorted();
		const grids = new Map<number, DynamicResourceGrid>();
		const owners: DynamicResourceEntity[] = [];
		for (const name of names) {
			// oxlint-disable-next-line no-await-in-loop -- main files are small and released after decoding
			const decoded = readDynamicResources(await this.#read(name));
			for (const grid of decoded.grids) {
				if (grids.has(grid.id)) {
					throw new FormatError(`duplicate dynamic grid ${grid.id}`);
				}
				grids.set(grid.id, grid);
			}
			owners.push(...decoded.entities);
		}
		return { grids, owners };
	}

	/**
	 * decodes the referenced ECS groups' entities and lights, each under every row's visibility that loads it
	 *
	 * @param groups the referenced groups
	 * @param counts the report's counts; `ecsGroups` is added to
	 * @returns the entities and lights by id, in chunk and group order
	 * @throws {FormatError} if a chunk lacks a referenced group
	 */
	async readEcsGroups(
		groups: EcsGroups,
		counts: Record<string, number>,
	): Promise<{
		entities: Map<number, DynamicEntity>;
		lights: Map<number, { light: ChunkLight; visibility: Visibility }>;
	}> {
		const entities = new Map<number, DynamicEntity>();
		const lights = new Map<number, { light: ChunkLight; visibility: Visibility }>();
		for (const [key, indices] of groups) {
			// oxlint-disable-next-line no-await-in-loop -- release each pair after its renderer groups are decoded
			const [init, streaming] = await Promise.all([
				this.#read(`fb_init_${key}.bytes`),
				this.#read(`fb_streaming_${key}.bytes`),
			]);
			const initPayload = unpackHgPayload(init);
			const streamingPayload = unpackHgPayload(streaming);
			const chunk = parseDynamicChunk(initPayload, streamingPayload);
			const chunkLights = new Map(readChunkLights(initPayload, chunk).map((light) => [light.id, light]));
			// the streaming payload binds rect decals' materials as StreamingChunkData does
			let decalMaterials: Map<number, bigint> | null = null;
			const decalMaterial = (id: number): bigint | null => {
				decalMaterials ??= new Map(
					mapDefined(
						parseStreamingChunk(streamingPayload).records,
						(record): [number, bigint] | undefined => {
							const material = assetProperty(record, RECT_DECAL_MATERIAL_KEY);
							return material === undefined ? undefined : [record.id, material];
						},
					),
				);
				return decalMaterials.get(id) ?? null;
			};
			for (const [index, { visibility, grid }] of indices) {
				const group = chunk.groups[index];
				if (!group) {
					throw new FormatError(`missing ECS group ${key}/${index}`);
				}
				counts.ecsGroups++;
				for (const entity of readChunkEntities({ ...chunk, groups: [group] })) {
					const placed = entities.getOrInsertComputed(entity.id, () => ({
						entity,
						decalMaterial: entity.decal === null ? null : decalMaterial(entity.id),
						visibility: { alternatives: [] },
						grid,
					}));
					placed.visibility.alternatives.push(...visibility.alternatives);
					if (grid >>> 16 > placed.grid >>> 16) {
						placed.grid = grid;
					}
				}
				for (const id of group.ids) {
					const light = chunkLights.get(id);
					if (light !== undefined) {
						lights
							.getOrInsertComputed(id, () => ({ light, visibility: { alternatives: [] } }))
							.visibility.alternatives.push(...visibility.alternatives);
					}
				}
			}
		}
		return { entities, lights };
	}
}

// #endregion

// #region owners

/** the install readers the owner pass needs, for view-state poses */
type OwnerContext = Pick<Context, 'vfs' | 'memoryPack' | 'world' | 'resolver'>;

/** what the owner pass reads of the scene */
interface OwnerScene {
	game: GameState;
	partition: LevelPartition | undefined;
	grids: ReadonlyMap<number, DynamicResourceGrid>;
	/** how many resource owners the scene has */
	owners: number;
	blights: ReadonlyMap<DynamicSceneEntity, Blight>;
	driven: ReadonlyMap<DynamicSceneEntity, DrivenViewStates>;
}

/** gates each owner's resource groups and places their rows, in owner order */
class OwnerPass {
	readonly result: DynamicStructures = {
		entities: [],
		lights: [],
		models: [],
		controls: [],
		sceneStates: new Set(),
		areas: new Set(),
		slots: [],
		erosionCores: new Map(),
		counts: { owners: 0, ecsGroups: 0, models: 0, effects: 0 },
	};
	/** the ECS groups the rows reference */
	readonly ecsGroups: EcsGroups = new Map();
	readonly #context: OwnerContext;
	readonly #scene: OwnerScene;
	/** the controls the owners need, by id in first-use order */
	readonly #controls = new Map<string, DraftControl>();
	/** placed prefabs by row key */
	readonly #models = new Map<string, StructureModel>();
	/** by grid, how many owners without a global id it has had, which ids the next one */
	readonly #ordinals = new Map<number, number>();
	/** by model and value, the pose the state machine settles in with `state` at that value */
	readonly #settled = new Map<string, Promise<PrefabPose | null>>();

	constructor(context: OwnerContext, scene: OwnerScene) {
		this.#context = context;
		this.#scene = scene;
		this.result.counts.owners = scene.owners;
		this.result.counts.viewStateEntities = scene.driven.size;
		this.result.counts.viewStatesUnsettled = 0;
	}

	/** gates an owner's resource groups and places their rows */
	async place(owner: DynamicResourceEntity): Promise<void> {
		const { entity } = owner;
		const { game, partition, grids, blights } = this.#scene;
		const ordinal = this.#ordinals.get(entity.grid) ?? 0;
		this.#ordinals.set(entity.grid, ordinal + 1);
		// level scripts address script-controlled entities by their global id, which holds across builds
		const owned = entity.uid === null ? `${entity.grid}:${ordinal}` : String(entity.uid);
		// a slot is stored on two entities with identical components
		const { extraScene } = entity;
		if (
			extraScene !== null &&
			!this.result.slots.some(({ slot }) => slot.position.every((v, i) => v === extraScene.position[i]))
		) {
			this.result.slots.push({ id: owned, slot: extraScene });
		}
		const blight = blights.get(entity);
		let gates = entity.gates.reduce<Alternatives>(
			(partial, gate) =>
				gate === blight?.link.gate ? partial : allOf(partial, game.requirements(gateCondition(gate))),
			[[]],
		);
		if (blight !== undefined) {
			this.#controls.set(blight.control.id, blight.control);
			gates = allOf(gates, [[{ control: blight.control.id, mask: 1 << BLIGHT_PRESENT }]]);
			this.result.erosionCores.set(String(blight.link.core), gates);
		}
		for (const [i, group] of entity.resourceGroups.entries()) {
			const ref = group.resources;
			if (ref.count === 0) {
				continue;
			}
			const tag = partition?.levels.find((level) => level.idNum === group.levelNum)?.tag ?? 0;
			const alternatives = this.#groupAlternatives(owner, { owned, index: i, tag, gates });
			const grid = grids.get(ref.grid);
			if (!grid) {
				throw new FormatError(`missing dynamic grid ${ref.grid}`);
			}
			switch (ref.type) {
				// effect rows place prefabs like model rows, from their own vector
				case 5:
				case 6: {
					// oxlint-disable-next-line no-await-in-loop -- rows in order; poses are cached
					await this.#placeModels(entity, { ref, grid, tag, alternatives, owned });
					break;
				}
				case 7: {
					this.#noteEcsGroups(dynamicResourceSlice(grid.ecs, ref), ref.grid, alternatives);
					break;
				}
				default: {
					throw new FormatError(`unsupported dynamic resource type ${ref.type}`);
				}
			}
		}
	}

	/**
	 * @returns when one of an owner's resource groups loads: the owner's gates, its script switch, the group's
	 *   logic-state bits by whatever sets them, and the owner's and group's scene states and stream areas
	 */
	#groupAlternatives(
		owner: DynamicResourceEntity,
		group: { owned: string; index: number; tag: number; gates: Alternatives },
	): Alternatives {
		const { entity } = owner;
		const { game, blights } = this.#scene;
		const { logicState } = entity.resourceGroups[group.index];
		let alternatives = group.gates;
		if (owner.scriptDefaultLoad !== null) {
			this.#addSwitch('script', scriptControl(group.owned), owner.scriptDefaultLoad);
			alternatives = allOf(alternatives, [[{ control: scriptControl(group.owned), mask: 2 }]]);
		}
		if (logicState !== 0) {
			const controller = entity.controllers[0];
			const level = levelCondition(entity, logicState, blights);
			if (controller) {
				alternatives = allOf(alternatives, [
					[{ control: progressionId(controller.kind, controllerKey(controller)), mask: logicState }],
				]);
			} else if (entity.entityType === TREE_ENTITY) {
				alternatives = allOf(alternatives, [
					[{ control: this.#harvestControl(group.tag), mask: logicState }],
				]);
			} else if (level !== null) {
				alternatives = allOf(alternatives, game.requirements(level));
			} else if ((logicState & 1) === 0) {
				const id = `logic:${group.owned}:${logicState}`;
				this.#addSwitch('logic', id, false);
				alternatives = allOf(alternatives, [[{ control: id, mask: 2 }]]);
			}
		}
		// visible-state lists hold MapConfig scene state indices; the entity and the group each need one of
		// theirs active
		for (const states of [owner.states, owner.groupStates[group.index]]) {
			if (states.length === 0) {
				continue;
			}
			for (const index of states) {
				this.result.sceneStates.add(index);
			}
			alternatives = allOf(
				alternatives,
				states.map((index) => [{ control: sceneStateControl(index), mask: 2 }]),
			);
		}
		// visible-area lists hold stream areas, shown while the camera is in a trigger zone listing one; area 0
		// is shown everywhere
		for (const areas of [owner.areas, owner.groupAreas[group.index]]) {
			if (areas.length === 0 || areas.includes(0)) {
				continue;
			}
			for (const area of areas) {
				this.result.areas.add(area);
			}
			alternatives = allOf(
				alternatives,
				areas.map((area) => [{ control: streamAreaControl(area), mask: 2 }]),
			);
		}
		return alternatives;
	}

	/** registers a script or logic switch the first time it's needed */
	#addSwitch(kind: 'script' | 'logic', id: string, enabled: boolean): void {
		if (this.#controls.has(id)) {
			return;
		}
		let assumption = 'no recovered controller, so off';
		if (kind === 'script') {
			assumption = enabled
				? 'authored to load until a script hides it'
				: 'loads only when a level script shows it';
		}
		this.#controls.set(
			id,
			sceneControl({ kind, id, name: id, values: SWITCH_VALUES, default: Number(enabled), assumption }),
		);
	}

	/**
	 * bit 0 standing, bit 1 the stump: the player fells each tree at runtime, so one control per level previews
	 * them all
	 *
	 * @returns the id of the level's harvest control, registered the first time
	 */
	#harvestControl(tag: number): string {
		const id = `harvest:${tag}`;
		this.#controls.getOrInsertComputed(id, () =>
			sceneControl({
				kind: 'harvest',
				id,
				name: 'Harvestable trees',
				values: switchValues('standing', 'felled'),
				default: 0,
				assumption: 'standing, as before the player fells them',
			}),
		);
		return id;
	}

	/**
	 * places a group's model or effect rows. a model whose view states a variable drives is placed once per
	 * value its state machine tells apart, posed as it settles there, and as saved for the other values
	 */
	async #placeModels(
		entity: DynamicSceneEntity,
		rows: {
			ref: DynamicDataRef;
			grid: DynamicResourceGrid;
			tag: number;
			alternatives: Alternatives;
			/** the owner's global id */
			owned: string;
		},
	): Promise<void> {
		const { ref, grid, tag, alternatives, owned } = rows;
		const { game } = this.#scene;
		const effect = ref.type === 6;
		const models = dynamicResourceSlice(effect ? grid.effects : grid.models, ref);
		if (effect) {
			this.result.counts.effects += models.length;
		}
		const view = effect ? undefined : this.#scene.driven.get(entity);
		const looks: { suffix: string; when: Alternatives; pose: PrefabPose | null }[] = [];
		if (view === undefined) {
			looks.push({ suffix: '', when: [[]], pose: null });
		} else {
			const { variable, states, values } = view;
			for (const value of values) {
				looks.push({
					suffix: `@state=${value}`,
					when: game.requirements(variableIs(variable, value)),
					// oxlint-disable-next-line no-await-in-loop -- poses are cached per model and value
					pose: await this.#poseAt(states, value),
				});
			}
			looks.push({
				suffix: '@saved',
				when: game.requirements({
					kind: 'any',
					reverse: true,
					conditions: values.map((value) => variableIs(variable, value)),
				}),
				pose: null,
			});
		}
		for (const [index, model] of models.entries()) {
			for (const { suffix, when, pose } of looks) {
				const key = `${effect ? 'effect:' : ''}${ref.grid}/${ref.index + index}${suffix}`;
				this.#models
					.getOrInsertComputed(key, () => ({
						model,
						levelTag: tag,
						source: key,
						owner: owned,
						visibility: { alternatives: [] },
						pose,
						grid: ref.grid,
					}))
					.visibility.alternatives.push(...allOf(alternatives, when));
			}
		}
	}

	/** @returns the pose `states` settle in with `state` at `value`, or `null` if they don't settle */
	#poseAt(states: ViewStates, value: number): Promise<PrefabPose | null> {
		return this.#settled.getOrInsertComputed(`${states.model}:${value}`, () =>
			settledPose(this.#context, states, `state=${value}`, new Map([['state', value]])).then(
				({ pose }) => pose,
				(error: unknown) => {
					if (!(error instanceof FormatError)) {
						throw error;
					}
					this.result.counts.viewStatesUnsettled++;
					return null;
				},
			),
		);
	}

	/** notes the ECS groups a row slice references, loading under `alternatives` */
	#noteEcsGroups(rows: readonly DynamicEcs[], grid: number, alternatives: Alternatives): void {
		for (const ecs of rows) {
			const key = `${ecs.sceneIndex.toString().padStart(2, '0')}_${ecs.chunk.toString().padStart(8, '0')}`;
			const group = this.ecsGroups
				.getOrInsertComputed(key, () => new Map())
				.getOrInsertComputed(ecs.index, () => ({ visibility: { alternatives: [] }, grid }));
			group.visibility.alternatives.push(...alternatives);
			// the coarsest grid loads the group from farthest
			if (grid >>> 16 > group.grid >>> 16) {
				group.grid = grid;
			}
		}
	}

	/**
	 * @param decoded the ECS groups' entities and lights
	 * @returns the structures, with script and logic switches named after what they show
	 */
	finish(decoded: Awaited<ReturnType<DynamicFiles['readEcsGroups']>>): DynamicStructures {
		const { result } = this;
		nameSwitches(this.#controls.values(), decoded.entities.values());
		result.entities = [...decoded.entities.values()];
		result.lights = [...decoded.lights.values()];
		result.models = [...this.#models.values()];
		result.controls = [...this.#controls.values()];
		result.counts.models = result.models.length;
		return result;
	}
}

/**
 * names script and logic switches after the two most frequent renderer names they gate, so manual groups are
 * identified without inventing an event condition; other controls carry their own names
 */
const nameSwitches = (controls: Iterable<DraftControl>, entities: Iterable<DynamicEntity>): void => {
	const labels = new Map<string, Map<string, number>>();
	for (const { entity, visibility } of entities) {
		const name = entity.name.replace(/#.*$/, '').replace(/ \(\d+\)(?:_ECSMerged)?$/, '');
		for (const control of new Set(
			visibility.alternatives.flatMap((requirements) =>
				requirements.map((requirement) => requirement.control),
			),
		)) {
			const frequencies = labels.getOrInsertComputed(control, () => new Map());
			frequencies.set(name, (frequencies.get(name) ?? 0) + 1);
		}
	}
	for (const control of controls) {
		if (control.kind !== 'script' && control.kind !== 'logic') {
			continue;
		}
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
		const ranked = [...(labels.get(control.id) ?? [])].sort((a, b) => b[1] - a[1]);
		control.name =
			ranked
				.slice(0, 2)
				.map(([name]) => name)
				.join(' / ') || control.id;
	}
};

// #endregion
