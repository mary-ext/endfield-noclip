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
//         17 [IdComp u64]   29 [SettlementControlComp 20 B]   30 [FactoryRegionControlComp 8 B]
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
//   FactoryRegionControlComp: i32 region (root string, a level id) @0, i32 @4
//   PoiControlComp: i32 poi (root string) @0, i32 domainType @4

// #region types

/** EDynamicSceneData values this reader uses (DataIndex/DataGroup `type`) */
export const DynamicData = {
	Model: 5,
	Effect: 6,
	Ecs: 7,
	ResourceGroupWithStateDesc: 10,
	IdComp: 15,
	SettlementControlComp: 27,
	FactoryRegionControlComp: 28,
	ResourceComp: 30,
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
	resourceGroups: DynamicResourceGroup[];
}

// #endregion

const Slot = {
	RootGrids: 3,
	RootStrings: 4,
	GridUniqueId: 0,
	DataIndex: 5,
	ResourceGroupWithStateDesc: 12,
	IdComp: 17,
	SettlementControlComp: 29,
	FactoryRegionControlComp: 30,
	ResourceComp: 32,
	RootComp: 33,
	PoiControlComp: 55,
} as const;

const Width = {
	DataIndex: 16,
	ResourceGroupWithStateDesc: 88,
	IdComp: 8,
	SettlementControlComp: 20,
	FactoryRegionControlComp: 8,
	ResourceComp: 132,
	RootComp: 84,
	PoiControlComp: 8,
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
	for (let g = 0; g < grids.length; g++) {
		const grid = fb.tableAt(grids.start, g);
		const uniqueIdAt = fb.field(grid, Slot.GridUniqueId);
		const gridId = uniqueIdAt === undefined ? 0 : fb.u32(uniqueIdAt);
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
				resourceGroups: [],
			};
			for (let c = 0; c < comps.count; c++) {
				const di = row(vectors.dataIndex, comps.index + c, Width.DataIndex, 'DataIndex');
				const type = fb.i32(di + 4);
				const index = fb.i32(di + 12);
				entity.components.push(type);
				switch (type) {
					case DynamicData.IdComp: {
						const id = row(vectors.ids, index, Width.IdComp, 'IdComp');
						entity.uid = fb.u64(id);
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
