import type { VertexStreams } from './draw-ranges.ts';
import type { GeometryVertices, StreamBinding } from './geometry-pools.ts';

/** a geometry's quantized positions, at location 0 */
export const POSITION_STREAM: GPUVertexBufferLayout = {
	arrayStride: 8,
	attributes: [{ shaderLocation: 0, offset: 0, format: 'unorm16x4' }],
};

/** a geometry's octahedral normals, at location 1 */
export const NORMAL_STREAM: GPUVertexBufferLayout = {
	arrayStride: 4,
	attributes: [{ shaderLocation: 1, offset: 0, format: 'snorm16x2' }],
};

/** bytes per vertex of the zero buffer bound in place of missing streams (the widest are float UVs) */
const ZERO_STRIDE = 8;
/** vertices the zero buffer starts with */
const INITIAL_ZERO_VERTICES = 65_536;

/** per vertex buffer slot of each phase's layout, the {@link GeometryVertices.streams} entry it binds */
const SLOT_STREAMS: Record<VertexStreams, readonly number[]> = {
	position: [0],
	uv: [0, 2, 3],
	all: [0, 1, 2, 3, 4, 5],
};

/**
 * binds geometries' vertex streams in a pass, skipping a buffer already bound at the same range, and owns the
 * zeros bound in place of streams a geometry with its own buffers lacks
 */
export class VertexBindings {
	#device: GPUDevice;
	#zeros: GPUBuffer;
	// one per vertex buffer slot of the widest layout
	#buffers: (GPUBuffer | null)[] = [null, null, null, null, null, null];
	#offsets: number[] = [0, 0, 0, 0, 0, 0];
	#sizes: (number | undefined)[] = [undefined, undefined, undefined, undefined, undefined, undefined];

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.#device = device;
		this.#zeros = this.#zeroBuffer(ZERO_STRIDE * INITIAL_ZERO_VERTICES);
	}

	#zeroBuffer(size: number): GPUBuffer {
		return this.#device.createBuffer({ label: 'zero streams', size, usage: GPUBufferUsage.VERTEX });
	}

	/** @returns bytes of the zero buffer */
	get bytes(): number {
		return this.#zeros.size;
	}

	/**
	 * grows the zeros to cover a geometry with its own buffers that lacks a stream
	 *
	 * @param vertexCount the geometry's vertices
	 */
	fitZeros(vertexCount: number): void {
		if (vertexCount * ZERO_STRIDE > this.#zeros.size) {
			this.#zeros.destroy();
			this.#zeros = this.#zeroBuffer(vertexCount * ZERO_STRIDE);
		}
	}

	/** forgets what's bound (at the start of each encode, since other families bind in between) */
	reset(): void {
		this.#buffers.fill(null);
	}

	/**
	 * binds a geometry's vertex streams in the slots a phase's pipelines read; slots already bound to the same
	 * range, as for every geometry of a pool, are skipped
	 *
	 * @param pass the pass
	 * @param vertices the geometry's vertex buffers
	 * @param streams the streams the phase reads
	 */
	bind(pass: GPURenderPassEncoder, vertices: GeometryVertices, streams: VertexStreams): void {
		const slots = SLOT_STREAMS[streams];
		for (let slot = 0; slot < slots.length; slot++) {
			this.#set(pass, slot, vertices.streams[slots[slot]]);
		}
	}

	/** destroys the zero buffer */
	destroy(): void {
		this.#zeros.destroy();
	}

	#set(pass: GPURenderPassEncoder, slot: number, { buffer, offset, size }: StreamBinding): void {
		const bound = buffer ?? this.#zeros;
		if (this.#buffers[slot] === bound && this.#offsets[slot] === offset && this.#sizes[slot] === size) {
			return;
		}
		pass.setVertexBuffer(slot, bound, offset, size);
		this.#buffers[slot] = bound;
		this.#offsets[slot] = offset;
		this.#sizes[slot] = size;
	}
}
