import { FormatError } from '../binary/binary-reader.ts';
import { FlatBuffer } from '../binary/flatbuffer.ts';

// `Data/DynamicStreaming/PC/Scene/<scene>/FBStreamArea.bytes` (DynamicStreaming group): the stream-area table.
// its area ids are the `<areaId>` suffix of `InitChunkData_<x>_<z>_<sceneStateId>_<areaId>.bytes`, and the
// `VisibleAreaGroup` values of DynamicStreaming entities. layout from Variante/endfield_research_kit (MIT,
// `scripts/game_data/contracts/dynamic_stream_area_native.json`), checked against map02's file:
//
//   root (FBStreamAreaTotalData)
//     0 [i32] TotalAreas         1 [i32] RootVisible        2 [i32] AreaVisibleGroups
//     3 Bounds (inline, 24 B)    4 [Area, 12 B]             5 [Trigger, 36 B]         6 [Coord, 8 B]
//   Area    = i32 areaId, i32 visibleStart, i32 visibleNum       (slice of AreaVisibleGroups)
//   Trigger = i32 areaId, i32 pointStart, i32 pointNum, Bounds   (slice of Points: a closed XZ ring)
//   Bounds  = Coord min, Coord max, f32 minHeight, f32 maxHeight;  Coord = f32 x, f32 y (world x, z)
// slots 7–9 (`HlodUnloadBounds`, `HlodUnloadTriggers`, `HlodUnloadPoints`) are not decoded.
//
// while the streaming centre is inside one or more triggers the client shows the union of those areas' visible
// slices, otherwise RootVisible (docs/game-data/world.md#stream-areas). area 0 is the default scenery.

// #region types

/** an inclusive XZ box with a height range */
export interface StreamAreaBounds {
	min: { x: number; z: number };
	max: { x: number; z: number };
	minHeight: number;
	maxHeight: number;
}

/** a trigger volume that activates its area */
export interface StreamAreaTrigger {
	areaId: number;
	bounds: StreamAreaBounds;
	/** closed polygon ring in world XZ */
	polygon: { x: number; z: number }[];
}

/** a decoded stream-area table */
export interface StreamAreaTable {
	/** every area id the scene knows, including 0 */
	totalAreas: number[];
	/** areas visible while the streaming centre is in no trigger */
	rootVisible: number[];
	/** area id → areas visible while inside that area's trigger */
	visibleWhileInside: Map<number, number[]>;
	triggers: StreamAreaTrigger[];
	/** scene bounds; inverted (min > max) when the scene has no areas */
	bounds: StreamAreaBounds;
}

// #endregion

const AREA_WIDTH = 12;
const TRIGGER_WIDTH = 36;
const COORD_WIDTH = 8;

/**
 * @param bytes the file
 * @returns its areas, visibility slices and triggers
 * @throws {FormatError} if a slice reaches outside its vector
 */
export const parseStreamAreas = (bytes: Uint8Array): StreamAreaTable => {
	const fb = new FlatBuffer(bytes);
	const root = fb.root();
	const ints = (slot: number): number[] => {
		const { start, length } = fb.vector(root, slot);
		return Array.from({ length }, (_, i) => fb.i32(start + i * 4));
	};
	const bounds = (at: number): StreamAreaBounds => ({
		min: { x: fb.f32(at), z: fb.f32(at + 4) },
		max: { x: fb.f32(at + 8), z: fb.f32(at + 12) },
		minHeight: fb.f32(at + 16),
		maxHeight: fb.f32(at + 20),
	});

	const groups = ints(2);
	const visibleWhileInside = new Map<number, number[]>();
	{
		const { start, length } = fb.vector(root, 4);
		for (let i = 0; i < length; i++) {
			const at = start + i * AREA_WIDTH;
			const areaId = fb.i32(at);
			const first = fb.i32(at + 4);
			const count = fb.i32(at + 8);
			if (first < 0 || count < 0 || first + count > groups.length) {
				throw new FormatError(
					`stream area ${areaId} visible slice ${first}+${count} exceeds ${groups.length}`,
				);
			}
			visibleWhileInside.set(areaId, groups.slice(first, first + count));
		}
	}

	const points = fb.vector(root, 6);
	const triggers: StreamAreaTrigger[] = [];
	{
		const { start, length } = fb.vector(root, 5);
		for (let i = 0; i < length; i++) {
			const at = start + i * TRIGGER_WIDTH;
			const areaId = fb.i32(at);
			const first = fb.i32(at + 4);
			const count = fb.i32(at + 8);
			if (first < 0 || count < 0 || first + count > points.length) {
				throw new FormatError(
					`stream area trigger ${i} point slice ${first}+${count} exceeds ${points.length}`,
				);
			}
			const polygon = Array.from({ length: count }, (_, p) => {
				const coord = points.start + (first + p) * COORD_WIDTH;
				return { x: fb.f32(coord), z: fb.f32(coord + 4) };
			});
			triggers.push({ areaId, bounds: bounds(at + 12), polygon });
		}
	}

	const boundsAt = fb.field(root, 3);
	return {
		totalAreas: ints(0),
		rootVisible: ints(1),
		visibleWhileInside,
		triggers,
		bounds:
			boundsAt === undefined
				? {
						min: { x: Infinity, z: Infinity },
						max: { x: -Infinity, z: -Infinity },
						minHeight: 0,
						maxHeight: 0,
					}
				: bounds(boundsAt),
	};
};
