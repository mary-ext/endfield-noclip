import { FormatError } from '../binary/binary-reader.ts';
import { FlatBuffer } from '../binary/flatbuffer.ts';

// DynamicStreaming main grids: `Data/DynamicStreaming/PC/Scene/<scene>/fb_main_<L>_<i>_<j>.bytes`. this reads only
// what state selection needs: each entity's id, controller components and resource groups with their
// LogicState masks. field indices and record layouts follow Variante/endfield_research_kit (MIT,
// `scripts/game_data/contracts/dynamic_{main_vector,root_comp,resource_comp,scalar_components}_native.json`);
// the ResourceComp stride (132, not the contract's 124) and the DataIndex type → vector pairing were measured on
// the current client.
//
//   root: 3 [SingleGrid table]   4 [string] (root string table: settlement ids, POI ids, level ids …)
//   grid: 0 u32 uniqueId (L<<16 | i<<8 | j)   5 [DataIndex 16 B]   12 [ResourceGroupWithStateDesc 88 B]
//         17 [IdComp 16 B]   29 [SettlementControlComp 20 B]   30 [FactoryRegionControlComp 8 B]
//         32 [ResourceComp 132 B]   33 [RootComp 84 B, one per entity]   55 [PoiControlComp 8 B]
//   DataGroup (24 B) = i32 invalid, i32 type, u32 grid, i32 index, i32 num, i32 total: a typed slice of the vector
//     `type` selects, in grid `grid`
//   DataIndex (16 B) = the first four DataGroup fields
//   RootComp: u32 entityType @0, u32 state @4, Comps DataGroup @8 (slice of DataIndex: the entity's components)
//   ResourceComp: Res DataGroup @0 (slice of ResourceGroupWithStateDesc)
//   ResourceGroupWithStateDesc: Group DataGroup @0 (Model 5 / Effect 6 / Ecs 7 rows, possibly in another grid),
//     u32 sceneState @24, u32 logicState @28, i32 levelNum @32 (LevelConfig idNum), i32 factoryIndex @36
//   SettlementControlComp: i32 settlement (root string) @0, bool controlLoad @4, i32 compareType @8,
//     i32 compareValue @12, bool isMain @16
//   IdComp: u64 uniqueId @0, u64 overrideId @8 (0 on every entity seen; IL2CPP `FBDynamicSceneIdComp`)
//   FactoryRegionControlComp: i32 region (root string, a level id) @0, i32 @4
//   PoiControlComp: i32 poi (root string) @0, i32 domainType @4
//   46 [ExtraSceneComp 40 B] = Vector3 minPos @0, maxPos @12, currentPos @24, u32 direction @36
//   16 [MissionCondition 16 B] = i32 id (root string), i32 isQuest, i32 state, i32 isSame
//   27 [MissionControlComp 32 B] = Conditions DataGroup @0 (MissionCondition rows), i32 compareType @24,
//     i32 toBeTrue @28
//   28 [GlobalVarControlComp 40 B] = i32 globalKey @0 (a client game variable id, not a root string),
//     u8 controlLoad @4, i32 compareType @8, i64 compareValue @16, i32 extra1–4 @24
//   52 [MapVarControlComp 48 B] = i32 mapKey @0 (an id like globalKey), u8 controlLoad @4, i32 compareType @8,
//     i64 compareValue @16, i32 extra1–4 @24, i32 mapId @40
//
// gate semantics (DynamicSceneMissionControlSystem._UpdateConditionValue / _GetCurrentConditionCompValue,
// DynamicSceneVarControlSystemBase.EvaluateCompare): a mission condition holds when the quest/mission state
// equals `state` (isSame 1) or differs from it (otherwise); compareType 0 needs all conditions, any other value
// one; the entity loads while the result equals toBeTrue == 1. a variable gate with controlLoad loads while the
// variable compares true (`CompareOperator` order) and not while it's unset; without controlLoad the variable
// only drives the entity's level and animator state.

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
	resourceGroups: DynamicResourceGroup[];
	/** an `ExtraSceneSlot`'s slot, where a separately stored scene (a Dijiang cabin) is placed; `null` otherwise */
	extraScene: ExtraSceneSlot | null;
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
	ExtraSceneComp: 46,
	MapVarControlComp: 52,
	PoiControlComp: 55,
} as const;

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
	const variableGate = (kind: 'globalVar' | 'mapVar', at: number): DynamicGate | null => {
		const controlLoad = fb.u8(at + 4);
		const compare = fb.i32(at + 8);
		if (controlLoad > 1 || compare < 0 || compare > 5) {
			throw new FormatError(`invalid ${kind} control (load ${controlLoad}, compare ${compare})`);
		}
		if (controlLoad === 0) {
			return null;
		}
		return {
			kind,
			key: fb.i32(at),
			compare,
			value: Number(fb.i64(at + 16)),
			mapId: kind === 'mapVar' ? fb.i32(at + 40) : null,
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
				resourceGroups: [],
				extraScene: null,
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
						const gate = variableGate(
							'globalVar',
							rowIn(
								fb.u32(di + 8),
								Slot.GlobalVarControlComp,
								index,
								Width.GlobalVarControlComp,
								'GlobalVarControlComp',
							),
						);
						if (gate) {
							entity.gates.push(gate);
						}
						break;
					}
					case DynamicData.MapVarControlComp: {
						const gate = variableGate(
							'mapVar',
							rowIn(
								fb.u32(di + 8),
								Slot.MapVarControlComp,
								index,
								Width.MapVarControlComp,
								'MapVarControlComp',
							),
						);
						if (gate) {
							entity.gates.push(gate);
						}
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

/**
 * @param group resource group
 * @param logicState the owning entity's logic state (a progression entity's level)
 * @returns whether the client shows the group in that state
 */
export const resourceGroupShown = (group: DynamicResourceGroup, logicState: number): boolean => {
	if (group.logicState === 0) {
		return true;
	}
	return logicState >= 0 && logicState < 32 && ((group.logicState >>> logicState) & 1) === 1;
};
