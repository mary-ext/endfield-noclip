import type { RowFloaters, RowRides, RowSpins } from '../content/instance-rows.ts';
import type { RangeAllocation } from '../gfx/range-allocator.ts';
import type { UvTransform } from '../package/decode-protocol.ts';
import type {
	GeometryIndices,
	GeometryPlacement,
	GeometryVertices,
} from '../render/meshes/geometry-pools.ts';
import type { ResidentSkin } from '../render/meshes/skin-animation.ts';

/** GPU residency of a height page */
export interface ResidentHeights {
	kind: 'heights';
	/** GPU bytes */
	bytes: number;
	/** height pool slot */
	slot: number;
	/** the samples kept on the CPU for ground-height queries (pinned pages only) */
	samples: Uint16Array | null;
}

/** GPU residency of a terrain surface page */
export interface ResidentSurface {
	kind: 'surface';
	/** GPU bytes */
	bytes: number;
	/** layer of the surface texture arrays */
	slot: number;
}

/** GPU residency of a terrain splat page */
export interface ResidentSplat {
	kind: 'splat';
	/** GPU bytes */
	bytes: number;
	/** layer of the detail texture arrays */
	slot: number;
}

/** GPU residency of a terrain layer texture (the terrain renderer owns the array) */
export interface ResidentLayer {
	kind: 'layer';
	/** GPU bytes */
	bytes: number;
}

/** GPU residency of an instance block */
export interface ResidentInstances {
	kind: 'instances';
	/** GPU bytes */
	bytes: number;
	/** its rows' range of the instance buffer, one row per instance */
	alloc: RangeAllocation;
	/** its rect decal placements' range of the placement buffer */
	placements: RangeAllocation;
	blockSlot: number;
	/** world origin of the rows, f64 */
	origin: [x: number, y: number, z: number];
	/** (chain, first, count) runs */
	runs: Uint32Array;
	/** the rows as uploaded, kept for CPU-side LOD selection */
	rowsF32: Float32Array<ArrayBuffer>;
	/** per-row cull data, see {@link InstanceRows.cull} */
	cull: Float32Array;
	/** the spinning rows, which turn {@link rowsF32} in place by the clock; `null` when every row holds still */
	spins: RowSpins | null;
	/** the rows floating on water volumes, which follow their surfaces; `null` when none does */
	floaters: RowFloaters | null;
	/** the rows riding paths, which move {@link rowsF32} in place by the clock; `null` when none does */
	rides: RowRides | null;
}

/** GPU residency of a geometry */
export interface ResidentGeometry {
	kind: 'geometry';
	/** GPU bytes */
	bytes: number;
	/**
	 * where its vertex streams bind from: a geometry pool's buffers, shared with other geometries, or its own.
	 * a stream it lacks binds zeros, except UV set 1, which binds set 0 as the game reads a missing set
	 */
	vertices: GeometryVertices;
	/** where its indices bind from, shared like {@link vertices} */
	indices: GeometryIndices;
	/** `GeometryFlags` of the normals, tangents and colours it has, which shaders read only where present */
	streamFlags: number;
	/** the UV streams' vertex format */
	uvFormat: 'unorm16x2' | 'float32x2';
	/** each UV set's dequantization */
	uvTransforms: [uv0: UvTransform, uv1: UvTransform];
	positionOffset: [x: number, y: number, z: number];
	positionScale: [x: number, y: number, z: number];
	/** index and vertex ranges in {@link indices} and {@link vertices}, a pooled geometry's offset to its own */
	submeshes: { firstIndex: number; indexCount: number; baseVertex: number }[];
	/** its ranges of the geometry pools, or `null` when it has buffers of its own */
	placement: GeometryPlacement | null;
	/** the skeletal animation skinned into its own vertex buffer each frame, or `null` for a still geometry */
	skin: ResidentSkin | null;
	/** its own vertex and index buffers when it isn't pooled, destroyed with it */
	buffers: GPUBuffer[];
}

/** GPU residency of a texture piece (the texture store owns the texture) */
export interface ResidentTexture {
	kind: 'texture';
	/** GPU bytes */
	bytes: number;
}

/** GPU residency of an irradiance cell in the volume's cell buffer */
export interface ResidentIrradiance {
	kind: 'irradiance';
	/** GPU bytes */
	bytes: number;
	/** u32 words of the cell buffer */
	alloc: RangeAllocation;
}

/** what a ready blob holds on the GPU */
export type Resident =
	| ResidentHeights
	| ResidentSurface
	| ResidentSplat
	| ResidentLayer
	| ResidentInstances
	| ResidentGeometry
	| ResidentTexture
	| ResidentIrradiance;
