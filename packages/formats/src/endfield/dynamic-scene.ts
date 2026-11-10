import { FormatError } from '../binary/binary-reader.ts';
import { FlatBuffer } from '../binary/flatbuffer.ts';

// DynamicStreaming main grids: `Data/DynamicStreaming/PC/Scene/<scene>/fb_main_<L>_<i>_<j>.bytes`. this reads
// what state selection needs: each entity's id, controller, gate and view-state components, its resource
// groups with their LogicState masks, and its extra-scene, erosion and sludge links.
// field indices and record layouts follow Variante/endfield_research_kit (MIT,
// `scripts/game_data/contracts/dynamic_{main_vector,root_comp,resource_comp,scalar_components}_native.json`);
// the ResourceComp stride (132, not the contract's 124) and the DataIndex type → vector pairing were measured
// on the client.
//
//   root: 3 [SingleGrid table]   4 [string] (root string table: settlement ids, POI ids, level ids …)
//   grid: 0 u32 uniqueId (L<<16 | i<<8 | j), then vectors of fixed-width records (`Slot`, `Width`)
//   DataGroup (24 B) = i32 invalid, i32 type, u32 grid, i32 index, i32 num, i32 total: a typed slice of the vector
//     `type` selects, in grid `grid`
//   DataIndex (16 B) = the first four DataGroup fields
//   RootComp: u32 entityType @0, u32 state @4, Comps DataGroup @8 (slice of DataIndex: the entity's components)
//
// each record's fields are in docs/game-data/assets.md#fb_main-grids; how the gates load an entity, in
// docs/game-data/scene-states.md#dynamic-load-gates

// #region types

/** EDynamicSceneData values this reader uses (DataIndex/DataGroup `type`) */
export const DynamicData = {
	Model: 5,
	Effect: 6,
	Ecs: 7,
	ResourceGroupWithStateDesc: 10,
	MissionCondition: 14,
	IdComp: 15,
	MissionControlComp: 25,
	GlobalVarControlComp: 26,
	SettlementControlComp: 27,
	FactoryRegionControlComp: 28,
	ResourceComp: 30,
	ErosionRootComp: 34,
	ModelViewStateControllerNewComp: 35,
	SludgeComp: 42,
	ExtraSceneComp: 44,
	MapVarControlComp: 51,
	PoiControlComp: 55,
} as const;

/** a typed slice of a grid vector */
export interface DynamicDataRef {
	type: number;
	/** unique id of the grid holding the rows */
	grid: number;
	index: number;
	count: number;
}

/** a set of resources an entity shows in some of its logic states */
export interface DynamicResourceGroup {
	resources: DynamicDataRef;
	sceneState: number;
	/**
	 * bit `n` set: the group is shown while the entity's logic state is `n`; 0 means the group ignores logic
	 * state. progression entities use the bit index as their level
	 */
	logicState: number;
	/** LevelConfig idNum of the level the group belongs to */
	levelNum: number;
	factoryIndex: number;
}

/** what drives an entity's logic state */
export type DynamicController =
	| { kind: 'settlement'; settlementId: string; isMain: boolean }
	| { kind: 'factoryRegion'; regionId: string }
	| { kind: 'poi'; poiId: string; domainType: number };

/** one quest or mission state test of a mission gate */
export interface DynamicMissionCondition {
	/** quest or mission id */
	id: string;
	isQuest: boolean;
	/** `QuestState` / `MissionState` value */
	state: number;
	/** true: the state must equal `state`; false: it must differ */
	same: boolean;
}

/** a condition the game loads an entity by */
export type DynamicGate =
	| {
			kind: 'mission';
			/** true: every condition must hold; false: one is enough */
			all: boolean;
			/** the entity loads while the combined result equals this */
			loadWhen: boolean;
			conditions: DynamicMissionCondition[];
	  }
	| {
			kind: 'globalVar' | 'mapVar';
			/** variable id; ids aren't names and the client tables that name them aren't read */
			key: number;
			/** `CompareOperator` (Equal 0 … LessEqual 5) applied as `variable <op> value` */
			compare: number;
			value: number;
			/** MapVarControlComp mapId; `null` for global variables */
			mapId: number | null;
	  };

/** a variable an entity reads */
export interface DynamicVariable {
	kind: 'globalVar' | 'mapVar';
	/** variable id */
	key: number;
	/** MapVarControlComp mapId; `null` for global variables */
	mapId: number | null;
}

/** an entity's view-state controller (`ModelViewStateControllerNewComp`) */
export interface DynamicViewState {
	/** the `ModelViewStateControllerData` file it runs, by name; `null` for an old controller without one */
	model: string | null;
	/** whether it runs the old controller, keyed by its own state-to-name map, rather than {@link model} */
	oldVersion: boolean;
}

/** a DynamicStreaming entity */
export interface DynamicEntity {
	/** grid unique id */
	grid: number;
	/** global entity id from IdComp, or `null` without one */
	uid: bigint | null;
	entityType: number;
	/** DataIndex types of its components */
	components: number[];
	controllers: DynamicController[];
	/** load conditions; all must hold. variable components that don't control loading aren't listed */
	gates: DynamicGate[];
	/**
	 * every variable component, whether or not it controls loading: each applies its variable's value to the
	 * entity's level and view-state key `state`
	 */
	variables: DynamicVariable[];
	/** the entity's view-state controller, or `null` without one */
	viewState: DynamicViewState | null;
	resourceGroups: DynamicResourceGroup[];
	/** an `ExtraSceneSlot`'s slot, where a separately stored scene (a Dijiang cabin) is placed; `null` otherwise */
	extraScene: ExtraSceneSlot | null;
	/** the blight core whose blight this entity is, `null` for other entities */
	erosionCore: ErosionCoreLink | null;
	/** the erosion sludge core whose sludge this entity is, `null` for other entities */
	sludgeCore: SludgeCoreLink | null;
}

/** the blight core an erosion root belongs to */
export interface ErosionCoreLink {
	/** the core's logic id in level data */
	id: bigint;
	position: [number, number, number];
}

/** the erosion sludge core a sludge patch belongs to */
export interface SludgeCoreLink {
	/** the core's logic id in level data */
	id: bigint;
	/** the patch's position */
	position: [number, number, number];
}

/** a slot for a separately stored scene, in world space */
export interface ExtraSceneSlot {
	/** the slot's box */
	min: [number, number, number];
	max: [number, number, number];
	/** where the placed scene's origin goes */
	position: [number, number, number];
	/** the placed scene's turn about the vertical axis, in quarter turns */
	direction: number;
}

// #endregion

/** FlatBuffer field slots: the root's two, then a grid's id and record vectors */
const Slot = {
	RootGrids: 3,
	RootStrings: 4,
	GridUniqueId: 0,
	DataIndex: 5,
	ResourceGroupWithStateDesc: 12,
	MissionCondition: 16,
	IdComp: 17,
	MissionControlComp: 27,
	GlobalVarControlComp: 28,
	SettlementControlComp: 29,
	FactoryRegionControlComp: 30,
	ResourceComp: 32,
	RootComp: 33,
	ErosionRootComp: 36,
	ModelViewStateControllerNewComp: 37,
	SludgeComp: 44,
	ExtraSceneComp: 46,
	MapVarControlComp: 52,
	PoiControlComp: 55,
} as const;

/** record strides, in bytes */
const Width = {
	DataIndex: 16,
	ResourceGroupWithStateDesc: 88,
	MissionCondition: 16,
	IdComp: 16,
	MissionControlComp: 32,
	GlobalVarControlComp: 40,
	SettlementControlComp: 20,
	FactoryRegionControlComp: 8,
	ResourceComp: 132,
	RootComp: 84,
	MapVarControlComp: 48,
	PoiControlComp: 8,
	ExtraSceneComp: 40,
	ErosionRootComp: 48,
	ModelViewStateControllerNewComp: 36,
	SludgeComp: 264,
} as const;

/**
 * @param bytes an `fb_main_*` file
 * @returns every entity of every grid, in storage order
 * @throws {FormatError} if a component reference points outside its vector or a ResourceComp's Res slice is
 *   not typed as ResourceGroupWithStateDesc (a layout change)
 */
export const readDynamicEntities = (bytes: Uint8Array): DynamicEntity[] => {
	const fb = new FlatBuffer(bytes);
	const root = fb.root();
	const strings = fb.vector(root, Slot.RootStrings);
	const decoder = new TextDecoder();
	const rootString = (index: number): string => {
		if (index < 0 || index >= strings.length) {
			throw new FormatError(`root string ${index} outside ${strings.length}`);
		}
		const at = fb.deref(strings.start + index * 4);
		const length = fb.u32(at);
		return decoder.decode(bytes.subarray(at + 4, at + 4 + length));
	};
	const dataRef = (at: number): DynamicDataRef => ({
		type: fb.i32(at + 4),
		grid: fb.u32(at + 8),
		index: fb.i32(at + 12),
		count: fb.i32(at + 16),
	});

	const entities: DynamicEntity[] = [];
	const grids = fb.vector(root, Slot.RootGrids);
	const gridTables = new Map<number, number>();
	for (let g = 0; g < grids.length; g++) {
		const grid = fb.tableAt(grids.start, g);
		const uniqueIdAt = fb.field(grid, Slot.GridUniqueId);
		const gridId = uniqueIdAt === undefined ? 0 : fb.u32(uniqueIdAt);
		if (gridTables.has(gridId)) {
			throw new FormatError(`duplicate grid ${gridId}`);
		}
		gridTables.set(gridId, grid);
	}
	// gate components and their condition rows may live in another grid of the file
	const rowIn = (gridId: number, slot: number, index: number, width: number, what: string): number => {
		const grid = gridTables.get(gridId);
		if (grid === undefined) {
			throw new FormatError(`${what} in missing grid ${gridId}`);
		}
		const vector = fb.vector(grid, slot);
		if (index < 0 || index >= vector.length) {
			throw new FormatError(`${what} ${index} outside ${vector.length} in grid ${gridId}`);
		}
		return vector.start + index * width;
	};
	/** reads a variable component: the variable it reads, and its load gate when it controls loading */
	const variableComp = (
		kind: 'globalVar' | 'mapVar',
		at: number,
	): { variable: DynamicVariable; gate: DynamicGate | null } => {
		const controlLoad = fb.u8(at + 4);
		const compare = fb.i32(at + 8);
		if (controlLoad > 1 || compare < 0 || compare > 5) {
			throw new FormatError(`invalid ${kind} control (load ${controlLoad}, compare ${compare})`);
		}
		const variable = { kind, key: fb.i32(at), mapId: kind === 'mapVar' ? fb.i32(at + 40) : null };
		return {
			variable,
			gate: controlLoad === 0 ? null : { ...variable, compare, value: Number(fb.i64(at + 16)) },
		};
	};

	for (const [gridId, grid] of gridTables) {
		const vectors = {
			dataIndex: fb.vector(grid, Slot.DataIndex),
			groups: fb.vector(grid, Slot.ResourceGroupWithStateDesc),
			ids: fb.vector(grid, Slot.IdComp),
			settlements: fb.vector(grid, Slot.SettlementControlComp),
			regions: fb.vector(grid, Slot.FactoryRegionControlComp),
			resources: fb.vector(grid, Slot.ResourceComp),
			roots: fb.vector(grid, Slot.RootComp),
			pois: fb.vector(grid, Slot.PoiControlComp),
		};
		const row = (vector: { start: number; length: number }, index: number, width: number, what: string) => {
			if (index < 0 || index >= vector.length) {
				throw new FormatError(`${what} ${index} outside ${vector.length} in grid ${gridId}`);
			}
			return vector.start + index * width;
		};

		for (let r = 0; r < vectors.roots.length; r++) {
			const at = vectors.roots.start + r * Width.RootComp;
			const comps = dataRef(at + 8);
			const entity: DynamicEntity = {
				grid: gridId,
				uid: null,
				entityType: fb.u32(at),
				components: [],
				controllers: [],
				gates: [],
				variables: [],
				viewState: null,
				resourceGroups: [],
				extraScene: null,
				erosionCore: null,
				sludgeCore: null,
			};
			for (let c = 0; c < comps.count; c++) {
				const di = row(vectors.dataIndex, comps.index + c, Width.DataIndex, 'DataIndex');
				const type = fb.i32(di + 4);
				const index = fb.i32(di + 12);
				entity.components.push(type);
				switch (type) {
					case DynamicData.MissionControlComp: {
						const m = rowIn(
							fb.u32(di + 8),
							Slot.MissionControlComp,
							index,
							Width.MissionControlComp,
							'MissionControlComp',
						);
						const list = dataRef(m);
						const toBeTrue = fb.i32(m + 28);
						if (list.count > 0 && list.type !== DynamicData.MissionCondition) {
							throw new FormatError(`MissionControlComp ${index} has Conditions type ${list.type}`);
						}
						if (toBeTrue !== 0 && toBeTrue !== 1) {
							throw new FormatError(`invalid MissionControlComp toBeTrue ${toBeTrue}`);
						}
						const conditions: DynamicMissionCondition[] = [];
						for (let k = 0; k < list.count; k++) {
							const q = rowIn(
								list.grid,
								Slot.MissionCondition,
								list.index + k,
								Width.MissionCondition,
								'MissionCondition',
							);
							conditions.push({
								id: rootString(fb.i32(q)),
								isQuest: fb.i32(q + 4) !== 0,
								state: fb.i32(q + 8),
								same: fb.i32(q + 12) === 1,
							});
						}
						entity.gates.push({
							kind: 'mission',
							all: fb.i32(m + 24) === 0,
							loadWhen: toBeTrue === 1,
							conditions,
						});
						break;
					}
					case DynamicData.GlobalVarControlComp: {
						const { variable, gate } = variableComp(
							'globalVar',
							rowIn(
								fb.u32(di + 8),
								Slot.GlobalVarControlComp,
								index,
								Width.GlobalVarControlComp,
								'GlobalVarControlComp',
							),
						);
						entity.variables.push(variable);
						if (gate) {
							entity.gates.push(gate);
						}
						break;
					}
					case DynamicData.MapVarControlComp: {
						const { variable, gate } = variableComp(
							'mapVar',
							rowIn(
								fb.u32(di + 8),
								Slot.MapVarControlComp,
								index,
								Width.MapVarControlComp,
								'MapVarControlComp',
							),
						);
						entity.variables.push(variable);
						if (gate) {
							entity.gates.push(gate);
						}
						break;
					}
					case DynamicData.ModelViewStateControllerNewComp: {
						const s = rowIn(
							fb.u32(di + 8),
							Slot.ModelViewStateControllerNewComp,
							index,
							Width.ModelViewStateControllerNewComp,
							'ModelViewStateControllerNewComp',
						);
						const model = fb.i32(s);
						entity.viewState = {
							model: model < 0 ? null : rootString(model),
							oldVersion: fb.u8(s + 4) !== 0,
						};
						break;
					}
					case DynamicData.IdComp: {
						const id = row(vectors.ids, index, Width.IdComp, 'IdComp');
						entity.uid = fb.u64(id);
						break;
					}
					case DynamicData.ExtraSceneComp: {
						const s = rowIn(
							fb.u32(di + 8),
							Slot.ExtraSceneComp,
							index,
							Width.ExtraSceneComp,
							'ExtraSceneComp',
						);
						const vec3 = (offset: number): [number, number, number] => [
							fb.f32(s + offset),
							fb.f32(s + offset + 4),
							fb.f32(s + offset + 8),
						];
						entity.extraScene = {
							min: vec3(0),
							max: vec3(12),
							position: vec3(24),
							direction: fb.u32(s + 36),
						};
						break;
					}
					case DynamicData.ErosionRootComp: {
						const s = rowIn(
							fb.u32(di + 8),
							Slot.ErosionRootComp,
							index,
							Width.ErosionRootComp,
							'ErosionRootComp',
						);
						entity.erosionCore = {
							id: fb.u64(s),
							position: [fb.f32(s + 32), fb.f32(s + 36), fb.f32(s + 40)],
						};
						break;
					}
					case DynamicData.SludgeComp: {
						const s = rowIn(fb.u32(di + 8), Slot.SludgeComp, index, Width.SludgeComp, 'SludgeComp');
						entity.sludgeCore = {
							id: fb.u64(s + 248),
							position: [fb.f32(s + 96), fb.f32(s + 100), fb.f32(s + 104)],
						};
						break;
					}
					case DynamicData.SettlementControlComp: {
						const s = row(vectors.settlements, index, Width.SettlementControlComp, 'SettlementControlComp');
						entity.controllers.push({
							kind: 'settlement',
							settlementId: rootString(fb.i32(s)),
							isMain: fb.u8(s + 16) !== 0,
						});
						break;
					}
					case DynamicData.FactoryRegionControlComp: {
						const s = row(vectors.regions, index, Width.FactoryRegionControlComp, 'FactoryRegionControlComp');
						entity.controllers.push({ kind: 'factoryRegion', regionId: rootString(fb.i32(s)) });
						break;
					}
					case DynamicData.PoiControlComp: {
						const s = row(vectors.pois, index, Width.PoiControlComp, 'PoiControlComp');
						entity.controllers.push({ kind: 'poi', poiId: rootString(fb.i32(s)), domainType: fb.i32(s + 4) });
						break;
					}
					case DynamicData.ResourceComp: {
						const res = dataRef(row(vectors.resources, index, Width.ResourceComp, 'ResourceComp'));
						if (res.count > 0 && res.type !== DynamicData.ResourceGroupWithStateDesc) {
							throw new FormatError(`ResourceComp ${index} in grid ${gridId} has Res type ${res.type}`);
						}
						for (let k = 0; k < res.count; k++) {
							const desc = row(
								vectors.groups,
								res.index + k,
								Width.ResourceGroupWithStateDesc,
								'ResourceGroupWithStateDesc',
							);
							entity.resourceGroups.push({
								resources: dataRef(desc),
								sceneState: fb.u32(desc + 24),
								logicState: fb.u32(desc + 28),
								levelNum: fb.i32(desc + 32),
								factoryIndex: fb.i32(desc + 36),
							});
						}
						break;
					}
				}
			}
			entities.push(entity);
		}
	}
	return entities;
};
