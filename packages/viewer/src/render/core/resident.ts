import type { AnimationBlob } from '@endfield-noclip/package-format/animation';

import type { TgpuBindGroup } from 'typegpu';

import type { RowFloaters, RowMotions, RowRides, RowSpins } from '../../content/instance-rows.ts';
import type { RowBounds } from '../../content/row-groups.ts';
import type { RangeAllocation } from '../../gfx/range-allocator.ts';
import type { UvTransform } from '../../package/decode-protocol.ts';

/** where one of a geometry's vertex streams is bound from */
export interface StreamBinding {
	/** the buffer, or `null` for zeros (`VertexBindings` owns them) */
	buffer: GPUBuffer | null;
	offset: number;
	/** bytes bound from `offset`, or `undefined` for the rest of the buffer */
	size: number | undefined;
}

/**
 * the buffers a geometry's vertex streams are bound from: a pool's, shared by every geometry in it and
 * repointed when the pool grows, or a geometry's own. compare by identity to skip rebinding
 */
export interface GeometryVertices {
	/** per `STREAMS` entry */
	streams: StreamBinding[];
	/** where draws bound from these buffers sort among a pipeline's: compact pools, full pools, own buffers */
	order: number;
}

/** the buffer a geometry's indices are bound from, shared like {@link GeometryVertices} */
export interface GeometryIndices {
	buffer: GPUBuffer;
	format: GPUIndexFormat;
}

/** a range-allocated geometry pool that frees a range on release */
export interface GeometryPoolHandle {
	free(allocation: RangeAllocation): void;
}

/** a pooled geometry's ranges, which `GeometryPools.free` returns */
export interface GeometryPlacement {
	pool: GeometryPoolHandle;
	vertices: RangeAllocation;
	indexPool: GeometryPoolHandle;
	indices: RangeAllocation;
}

/** an animated geometry's GPU side: its bind pose, frames and the pass that skins it into its vertices */
export interface ResidentSkin {
	vertexCount: number;
	frameCount: number;
	frameRate: number;
	/** `SkinParamsSchema`; the frame fields change with the frame */
	params: GPUBuffer;
	/** the params as last written, as words and as floats */
	paramWords: Uint32Array<ArrayBuffer>;
	paramFloats: Float32Array<ArrayBuffer>;
	/** whether the vertices hold the frame the params name; `false` until first skinned */
	skinned: boolean;
	group: TgpuBindGroup;
	/** GPU bytes of the bind pose and frames */
	bytes: number;
	/** buffers the skin owns, destroyed with it */
	buffers: GPUBuffer[];
}

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
	/** what the mesh selection culls the rows by, as the decode worker built it */
	bounds: RowBounds;
	/** the spinning rows, which turn {@link rowsF32} in place by the clock; `null` when every row holds still */
	spins: RowSpins | null;
	/** the rows floating on water volumes, which follow their surfaces; `null` when none does */
	floaters: RowFloaters | null;
	/** the rows riding paths, which move {@link rowsF32} in place by the clock; `null` when none does */
	rides: RowRides | null;
	/** `.anim` clip bindings from `MOTN`, or `null` when none */
	motions?: RowMotions | null;
	/** packed `(firstRow, count, float32Bits(sparsity))` triples for `.fol` grass blocks, or `null` */
	foliageClusters?: Uint32Array<ArrayBuffer> | null;
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
	/** the position stream's vertex format */
	positionFormat: 'unorm16x4' | 'float32x4';
	/** the UV streams' vertex format */
	uvFormat: 'unorm16x2' | 'float32x2';
	/** precomputed `positionFormatIndex * 2 + uvFormatIndex` (0..3) for pipeline variant lookup */
	formatVariant: number;
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

/** CPU residency of a decoded `.anim` clip */
export interface ResidentAnimation {
	kind: 'animation';
	/** approximate decoded bytes */
	bytes: number;
	clip: AnimationBlob;
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
	| ResidentIrradiance
	| ResidentAnimation;
