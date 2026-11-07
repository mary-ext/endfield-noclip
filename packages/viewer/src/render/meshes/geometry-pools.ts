/**
 * shared vertex and index buffers that still geometries are sub-allocated from, so draws of different
 * geometries bind the same buffers and pick their data through `baseVertex` and `firstIndex`
 *
 * @module
 */

import { type RangeAllocation, RangeAllocator } from '../../gfx/range-allocator.ts';

import { UV_FORMATS, type UvFormat } from './pipeline-variants.ts';

/** a geometry's vertex streams, in the order the widest mesh layout binds them */
export const STREAMS = ['position', 'normal', 'uv0', 'uv1', 'tangent', 'color'] as const;
export type Stream = (typeof STREAMS)[number];

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
	/** per {@link STREAMS} entry */
	streams: StreamBinding[];
	/** where draws bound from these buffers sort among a pipeline's: compact pools, full pools, own buffers */
	order: number;
}

/** the buffer a geometry's indices are bound from, shared like {@link GeometryVertices} */
export interface GeometryIndices {
	buffer: GPUBuffer;
	format: GPUIndexFormat;
}

/** bytes per vertex of each stream: UV sets take their format's */
const strideOf = (stream: Stream, uvFormat: UvFormat): number => {
	switch (stream) {
		case 'position': {
			return 8;
		}
		case 'uv0':
		case 'uv1': {
			return uvFormat === 'unorm16x2' ? 4 : 8;
		}
		case 'normal':
		case 'tangent':
		case 'color': {
			return 4;
		}
	}
};

/**
 * vertices a vertex pool starts with: few geometries have float UVs or colours, so most pools stay small,
 * while the compact 16-bit one grows to a few million
 */
const INITIAL_VERTICES = 1 << 16;
/** 4-byte index units an index pool starts with (512k 16-bit or 256k 32-bit indices) */
const INITIAL_INDEX_UNITS = 1 << 18;
/** how much a full pool grows by, which bounds its unused tail */
const GROWTH = 1.5;

/** buffers sub-allocated together by one range allocator, each with its own bytes per unit */
class PoolBuffers {
	buffers: GPUBuffer[];
	readonly #device: GPUDevice;
	readonly #label: string;
	readonly #usage: GPUBufferUsageFlags;
	readonly #unitBytes: readonly number[];
	readonly #maxUnits: number;
	readonly #allocator: RangeAllocator;

	constructor(
		device: GPUDevice,
		options: {
			label: string;
			usage: GPUBufferUsageFlags;
			unitBytes: readonly number[];
			initialUnits: number;
		},
	) {
		this.#device = device;
		this.#label = options.label;
		this.#usage = options.usage | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
		this.#unitBytes = options.unitBytes;
		this.#maxUnits = Math.floor(device.limits.maxBufferSize / Math.max(...options.unitBytes));
		const units = Math.min(options.initialUnits, this.#maxUnits);
		this.#allocator = new RangeAllocator(units);
		this.buffers = this.#create(units);
	}

	get bytes(): number {
		let bytes = 0;
		for (const buffer of this.buffers) {
			bytes += buffer.size;
		}
		return bytes;
	}

	/** @returns `count` units, growing the buffers when no free range fits, or `null` past the device's limit */
	allocate(count: number): RangeAllocation | null {
		const allocation = this.#allocator.allocate(count);
		if (allocation !== null) {
			return allocation;
		}
		const capacity = this.#allocator.capacity;
		if (capacity >= this.#maxUnits) {
			return null;
		}
		// room for the request even if all free space is fragmented
		this.#grow(Math.min(this.#maxUnits, Math.max(Math.ceil(capacity * GROWTH), capacity + count)));
		return this.#allocator.allocate(count);
	}

	free(allocation: RangeAllocation): void {
		this.#allocator.free(allocation);
	}

	destroy(): void {
		for (const buffer of this.buffers) {
			buffer.destroy();
		}
	}

	#create(units: number): GPUBuffer[] {
		return this.#unitBytes.map((unitBytes, i) =>
			this.#device.createBuffer({
				label: `${this.#label} ${i}`,
				size: Math.max(4, units * unitBytes),
				usage: this.#usage,
			}),
		);
	}

	/**
	 * copies the buffers into larger ones. bindings recorded before stay valid only until submitted, so pools
	 * grow while uploading, before a frame encodes
	 */
	#grow(units: number): void {
		const previous = this.buffers;
		const next = this.#create(units);
		// queue order keeps writes made to the old buffers ahead of the copy
		const encoder = this.#device.createCommandEncoder({ label: `${this.#label} growth` });
		previous.forEach((buffer, i) => encoder.copyBufferToBuffer(buffer, 0, next[i], 0, buffer.size));
		this.#device.queue.submit([encoder.finish()]);
		for (const buffer of previous) {
			buffer.destroy();
		}
		this.buffers = next;
		this.#allocator.grow(units);
	}
}

/**
 * the vertex streams of geometries with one UV format and stream set, sub-allocated by vertex: a geometry's
 * range is at the same vertices of every stream's buffer, since `baseVertex` applies to all of them
 */
class VertexPool {
	readonly vertices: GeometryVertices;
	/** the streams with a buffer of their own */
	readonly stored: readonly Stream[];
	/** bytes per vertex over {@link stored} */
	readonly stride: number;
	readonly #buffers: PoolBuffers;
	/** per {@link STREAMS} entry, the index of the stored stream it's bound from */
	readonly #source: readonly number[];

	constructor(
		device: GPUDevice,
		{ uvFormat, compact, order }: { uvFormat: UvFormat; compact: boolean; order: number },
	) {
		// a compact geometry has neither UV set 1 nor colours: its set 1 binds set 0, which the game reads in its
		// place, and its colours bind its normals, which the shaders ignore without `HasColors`
		const stored = STREAMS.filter((stream) => !compact || (stream !== 'uv1' && stream !== 'color'));
		const sourceOf: Partial<Record<Stream, Stream>> = compact ? { uv1: 'uv0', color: 'normal' } : {};
		this.stored = stored;
		this.#source = STREAMS.map((stream) => stored.indexOf(sourceOf[stream] ?? stream));
		const unitBytes = stored.map((stream) => strideOf(stream, uvFormat));
		this.stride = unitBytes.reduce((sum, bytes) => sum + bytes, 0);
		this.#buffers = new PoolBuffers(device, {
			label: `geometry pool ${uvFormat}${compact ? ' compact' : ''}`,
			usage: GPUBufferUsage.VERTEX,
			unitBytes,
			initialUnits: INITIAL_VERTICES,
		});
		this.vertices = {
			streams: STREAMS.map(() => ({ buffer: null, offset: 0, size: undefined })),
			order,
		};
		this.#point();
	}

	get bytes(): number {
		return this.#buffers.bytes;
	}

	/** @returns `count` vertices of every stored stream, or `null` past the device's limit */
	allocate(count: number): RangeAllocation | null {
		const allocation = this.#buffers.allocate(count);
		this.#point();
		return allocation;
	}

	/** @returns a stored stream's buffer, for writing a geometry's range */
	buffer(stream: Stream): GPUBuffer {
		return this.#buffers.buffers[this.stored.indexOf(stream)];
	}

	free(allocation: RangeAllocation): void {
		this.#buffers.free(allocation);
	}

	destroy(): void {
		this.#buffers.destroy();
	}

	/** points the bindings at the current buffers, which growth replaces */
	#point(): void {
		const buffers = this.#buffers.buffers;
		this.vertices.streams.forEach((binding, i) => {
			binding.buffer = buffers[this.#source[i]];
		});
	}
}

/** indices of one format, sub-allocated in 4-byte units */
class IndexPool {
	readonly indices: GeometryIndices;
	readonly #buffers: PoolBuffers;

	constructor(device: GPUDevice, format: GPUIndexFormat) {
		this.#buffers = new PoolBuffers(device, {
			label: `geometry pool ${format} indices`,
			usage: GPUBufferUsage.INDEX,
			unitBytes: [4],
			initialUnits: INITIAL_INDEX_UNITS,
		});
		this.indices = { buffer: this.#buffers.buffers[0], format };
	}

	get bytes(): number {
		return this.#buffers.bytes;
	}

	/** @returns `count` units, or `null` past the device's limit */
	allocate(count: number): RangeAllocation | null {
		const allocation = this.#buffers.allocate(count);
		this.indices.buffer = this.#buffers.buffers[0];
		return allocation;
	}

	free(allocation: RangeAllocation): void {
		this.#buffers.free(allocation);
	}

	destroy(): void {
		this.#buffers.destroy();
	}
}

/** a pooled geometry's ranges, which {@link GeometryPools.free} returns */
export interface GeometryPlacement {
	pool: VertexPool;
	vertices: RangeAllocation;
	indexPool: IndexPool;
	indices: RangeAllocation;
}

/** where {@link GeometryPools.place} put a geometry */
export interface PlacedGeometry {
	vertices: GeometryVertices;
	indices: GeometryIndices;
	/** its first vertex and index in the bound buffers, added to its submeshes' */
	baseVertex: number;
	firstIndex: number;
	/** bytes of its ranges */
	bytes: number;
	placement: GeometryPlacement;
}

/** what {@link GeometryPools.place} uploads: a decoded geometry's streams and indices */
export interface PoolableGeometry {
	vertexCount: number;
	uvFormat: UvFormat;
	streams: Record<Stream, ArrayBuffer | null>;
	/** a multiple of 4 bytes */
	indices: ArrayBuffer;
	indexFormat: GPUIndexFormat;
}

/**
 * the vertex pools, one per UV format and stream set (compact: without UV set 1 and colours, as most geometry
 * is; full: every stream), and an index pool per index format. pools grow by copying into larger buffers and
 * never shrink; the streaming budget bounds them
 */
export class GeometryPools {
	readonly #device: GPUDevice;
	/** by UV format, then compact and full; created on first use */
	readonly #vertexPools: (VertexPool | null)[] = [null, null, null, null];
	readonly #indexPools = new Map<GPUIndexFormat, IndexPool>();
	/** zeros written over streams a geometry lacks, grown as needed */
	#zeros = new Uint8Array(0);

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.#device = device;
	}

	/** @returns bytes of every pool's buffers */
	get bytes(): number {
		let bytes = 0;
		for (const pool of [...this.#vertexPools, ...this.#indexPools.values()]) {
			bytes += pool?.bytes ?? 0;
		}
		return bytes;
	}

	/**
	 * uploads a geometry's streams and indices into ranges of the pools. a stream the geometry lacks but its
	 * pool stores is written as the zeros an unpooled geometry binds for it, and UV set 1 as set 0
	 *
	 * @param geometry the decoded streams and indices
	 * @returns where it went, or `null` when a pool would outgrow the device's largest buffer
	 */
	place(geometry: PoolableGeometry): PlacedGeometry | null {
		const { streams } = geometry;
		const compact = streams.uv1 === null && streams.color === null;
		const p = UV_FORMATS.indexOf(geometry.uvFormat) * 2 + (compact ? 0 : 1);
		const pool = (this.#vertexPools[p] ??= new VertexPool(this.#device, {
			uvFormat: geometry.uvFormat,
			compact,
			order: compact ? 0 : 1,
		}));
		const indexPool = this.#indexPools.getOrInsertComputed(
			geometry.indexFormat,
			(format) => new IndexPool(this.#device, format),
		);
		const vertexCount = Math.max(1, geometry.vertexCount);
		const vertices = pool.allocate(vertexCount);
		if (vertices === null) {
			return null;
		}
		const indexUnits = Math.max(1, geometry.indices.byteLength / 4);
		const indices = indexPool.allocate(indexUnits);
		if (indices === null) {
			pool.free(vertices);
			return null;
		}
		const queue = this.#device.queue;
		for (const stream of pool.stored) {
			const buffer = pool.buffer(stream);
			const bytes = strideOf(stream, geometry.uvFormat);
			const offset = vertices.start * bytes;
			const data = streams[stream] ?? (stream === 'uv1' ? streams.uv0 : null);
			if (data === null) {
				queue.writeBuffer(buffer, offset, this.#zeroes(geometry.vertexCount * bytes));
			} else {
				queue.writeBuffer(buffer, offset, data);
			}
		}
		queue.writeBuffer(indexPool.indices.buffer, indices.start * 4, geometry.indices);
		return {
			vertices: pool.vertices,
			indices: indexPool.indices,
			baseVertex: vertices.start,
			firstIndex: geometry.indexFormat === 'uint16' ? indices.start * 2 : indices.start,
			bytes: vertexCount * pool.stride + indexUnits * 4,
			placement: { pool, vertices, indexPool, indices },
		};
	}

	/** @param placement a live placement from {@link place}; its ranges are reused by later geometries */
	free(placement: GeometryPlacement): void {
		placement.pool.free(placement.vertices);
		placement.indexPool.free(placement.indices);
	}

	/** destroys every pool; placements and bindings become unusable */
	destroy(): void {
		for (const pool of [...this.#vertexPools, ...this.#indexPools.values()]) {
			pool?.destroy();
		}
	}

	/** @returns `bytes` zeros, a view of a buffer shared across calls */
	#zeroes(bytes: number): Uint8Array {
		if (this.#zeros.byteLength < bytes) {
			this.#zeros = new Uint8Array(bytes);
		}
		return this.#zeros.subarray(0, bytes);
	}
}
