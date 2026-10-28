/**
 * CDLOD terrain: height pages live in a slot pool (one storage buffer), and every selected page quadrant is
 * an instance of one shared 33×33 grid, so terrain is a single draw.
 *
 * @module
 */

import type { BindLayouts } from '../gfx/bind-layouts.ts';
import type { PipelineCache } from '../gfx/pipeline-cache.ts';
import { DEPTH_COMPARE, DEPTH_FORMAT } from '../gfx/render-targets.ts';
import type { DecodedHeights } from '../package/decode-protocol.ts';
import type { Vec3 } from '../scene/camera.ts';
import type { TerrainPatch } from '../streaming/selection.ts';
import type { ResidentHeights } from '../streaming/stream-manager.ts';

import { FRAME_WGSL } from './frame-uniforms.ts';
import terrainWgsl from './shaders/terrain.wgsl?raw';

/** samples per page edge the shader is written for (its `SIDE`) */
export const PAGE_SIDE = 65;
const QUADS = PAGE_SIDE - 1;
const GRID = QUADS / 2 + 1;
/** u32 words per page slot (two samples per word) */
const PAGE_WORDS = Math.ceil((PAGE_SIDE * PAGE_SIDE) / 2);
const PAGE_BYTES = PAGE_WORDS * 4;
const PATCH_FLOATS = 12;

const vertexAt = (x: number, z: number): number => z * GRID + x;

const gridIndices = (): { fill: Uint16Array; wire: Uint16Array } => {
	const fill: number[] = [];
	const wire: number[] = [];
	for (let z = 0; z < GRID - 1; z++) {
		for (let x = 0; x < GRID - 1; x++) {
			// clockwise seen from above in Unity's frame, i.e. front-facing like Unity geometry
			fill.push(
				vertexAt(x, z),
				vertexAt(x, z + 1),
				vertexAt(x + 1, z),
				vertexAt(x + 1, z),
				vertexAt(x, z + 1),
				vertexAt(x + 1, z + 1),
			);
			wire.push(
				vertexAt(x, z),
				vertexAt(x + 1, z),
				vertexAt(x, z),
				vertexAt(x, z + 1),
				vertexAt(x + 1, z),
				vertexAt(x, z + 1),
			);
		}
	}
	for (let i = 0; i < GRID - 1; i++) {
		wire.push(
			vertexAt(GRID - 1, i),
			vertexAt(GRID - 1, i + 1),
			vertexAt(i, GRID - 1),
			vertexAt(i + 1, GRID - 1),
		);
	}
	return { fill: new Uint16Array(fill), wire: new Uint16Array(wire) };
};

/** owns the height pool, patch buffer and terrain pipelines */
export class TerrainRenderer {
	readonly capacity: number;
	/** patches drawn last frame */
	patchCount = 0;
	/** triangles per patch */
	readonly patchTriangles = (GRID - 1) * (GRID - 1) * 2;

	#device: GPUDevice;
	#heights: GPUBuffer;
	#patches: GPUBuffer;
	#patchCapacity: number;
	#patchData: Float32Array;
	#patchWords: Uint32Array;
	#fillIndices: GPUBuffer;
	#wireIndices: GPUBuffer;
	#fillCount: number;
	#wireCount: number;
	#bindGroup: GPUBindGroup;
	#freeSlots: number[] = [];
	#pipelines: PipelineCache;
	#fillKey: string;
	#wireKey: string;

	/**
	 * @param device the device
	 * @param layouts shared layouts
	 * @param pipelines pipeline cache
	 * @param targets color format and sample count of the main pass
	 * @param capacity height page slots
	 */
	constructor(
		device: GPUDevice,
		layouts: BindLayouts,
		pipelines: PipelineCache,
		targets: { colorFormat: GPUTextureFormat; sampleCount: number },
		capacity: number,
	) {
		this.#device = device;
		this.#pipelines = pipelines;
		this.capacity = capacity;
		for (let slot = capacity - 1; slot >= 0; slot--) {
			this.#freeSlots.push(slot);
		}
		this.#heights = device.createBuffer({
			label: 'terrain heights',
			size: capacity * PAGE_BYTES,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#patchCapacity = 8192;
		this.#patchData = new Float32Array(this.#patchCapacity * PATCH_FLOATS);
		this.#patchWords = new Uint32Array(this.#patchData.buffer);
		this.#patches = device.createBuffer({
			label: 'terrain patches',
			size: this.#patchData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		const { fill, wire } = gridIndices();
		this.#fillCount = fill.length;
		this.#wireCount = wire.length;
		this.#fillIndices = this.#indexBuffer('terrain fill indices', fill);
		this.#wireIndices = this.#indexBuffer('terrain wire indices', wire);
		this.#bindGroup = device.createBindGroup({
			label: 'terrain',
			layout: layouts.terrain,
			entries: [
				{ binding: 0, resource: { buffer: this.#heights } },
				{ binding: 1, resource: { buffer: this.#patches } },
			],
		});

		const module = pipelines.module('terrain', FRAME_WGSL + terrainWgsl);
		const constants = { SIDE: PAGE_SIDE };
		const suffix = `${targets.colorFormat}/x${targets.sampleCount}`;
		this.#fillKey = `terrain/fill/${suffix}`;
		this.#wireKey = `terrain/wire/${suffix}`;
		const describe = (lines: boolean): GPURenderPipelineDescriptor => ({
			layout: layouts.terrainPipeline,
			vertex: { module, entryPoint: 'vs_main', constants },
			fragment: {
				module,
				entryPoint: lines ? 'fs_wire' : 'fs_main',
				targets: [{ format: targets.colorFormat }],
			},
			primitive: lines
				? { topology: 'line-list' }
				: { topology: 'triangle-list', frontFace: 'cw', cullMode: 'back' },
			depthStencil: {
				format: DEPTH_FORMAT,
				depthWriteEnabled: !lines,
				depthCompare: lines ? 'greater-equal' : DEPTH_COMPARE,
			},
			multisample: { count: targets.sampleCount },
		});
		void pipelines.prepare(this.#fillKey, () => describe(false));
		void pipelines.prepare(this.#wireKey, () => describe(true));
	}

	#indexBuffer(label: string, data: Uint16Array): GPUBuffer {
		const buffer = this.#device.createBuffer({
			label,
			size: Math.ceil(data.byteLength / 4) * 4,
			usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
			mappedAtCreation: true,
		});
		new Uint16Array(buffer.getMappedRange()).set(data);
		buffer.unmap();
		return buffer;
	}

	/** @returns bytes of the fixed GPU allocations */
	get poolBytes(): number {
		return this.capacity * PAGE_BYTES + this.#patchData.byteLength;
	}

	/**
	 * uploads a height page into a free slot.
	 *
	 * @param decoded the page
	 * @param options `keepSamples` keeps the samples on the CPU, for ground-height queries
	 * @returns the residency, or `null` if no slot was free
	 * @throws {Error} if the page isn't {@link PAGE_SIDE} samples across
	 */
	upload(decoded: DecodedHeights, options: { keepSamples: boolean }): ResidentHeights | null {
		if (decoded.side !== PAGE_SIDE) {
			throw new Error(`height page side ${decoded.side} isn't ${PAGE_SIDE}`);
		}
		const slot = this.#freeSlots.pop();
		if (slot === undefined) {
			return null;
		}
		this.#device.queue.writeBuffer(this.#heights, slot * PAGE_BYTES, decoded.samples);
		return {
			kind: 'heights',
			bytes: PAGE_BYTES,
			slot,
			samples: options.keepSamples ? decoded.samples : null,
		};
	}

	/** @param resident a page from {@link upload}; its slot returns to the pool */
	release(resident: ResidentHeights): void {
		this.#freeSlots.push(resident.slot);
	}

	/**
	 * writes this frame's patches, relative to the eye.
	 *
	 * @param patches selected patches
	 * @param eye camera position, f64
	 */
	prepare(patches: readonly TerrainPatch[], eye: Vec3): void {
		const count = Math.min(patches.length, this.#patchCapacity);
		const data = this.#patchData;
		const words = this.#patchWords;
		for (let i = 0; i < count; i++) {
			const { item, node, quadrant, morphStart, morphEnd } = patches[i];
			const at = i * PATCH_FLOATS;
			data[at] = node.minX - eye[0];
			data[at + 1] = node.minZ - eye[2];
			data[at + 2] = node.size / QUADS;
			data[at + 3] = node.level;
			words[at + 4] = item.resident?.kind === 'heights' ? item.resident.slot : 0;
			words[at + 5] = quadrant < 0 ? 0 : (quadrant & 1) * (GRID - 1);
			words[at + 6] = quadrant < 0 ? 0 : (quadrant >> 1) * (GRID - 1);
			words[at + 7] = 0;
			data[at + 8] = Number.isFinite(morphStart) ? morphStart : 0;
			data[at + 9] = Number.isFinite(morphEnd) ? morphEnd : 0;
		}
		// a whole page is drawn as its four quadrants
		let expanded = count;
		for (let i = 0; i < count && expanded < this.#patchCapacity; i++) {
			if (patches[i].quadrant >= 0) {
				continue;
			}
			for (let q = 1; q < 4 && expanded < this.#patchCapacity; q++) {
				const from = i * PATCH_FLOATS;
				const at = expanded * PATCH_FLOATS;
				data.copyWithin(at, from, from + PATCH_FLOATS);
				words[at + 5] = (q & 1) * (GRID - 1);
				words[at + 6] = (q >> 1) * (GRID - 1);
				expanded++;
			}
		}
		this.patchCount = expanded;
		if (expanded > 0) {
			this.#device.queue.writeBuffer(this.#patches, 0, data, 0, expanded * PATCH_FLOATS);
		}
	}

	/**
	 * draws the shaded terrain.
	 *
	 * @param pass the main pass, with group 0 bound
	 * @returns draw calls issued
	 */
	encode(pass: GPURenderPassEncoder): number {
		return this.#encode(pass, this.#fillKey, this.#fillIndices, this.#fillCount);
	}

	/**
	 * draws the terrain's grid lines.
	 *
	 * @param pass the main pass, with group 0 bound
	 * @returns draw calls issued
	 */
	encodeWireframe(pass: GPURenderPassEncoder): number {
		return this.#encode(pass, this.#wireKey, this.#wireIndices, this.#wireCount);
	}

	#encode(pass: GPURenderPassEncoder, key: string, indices: GPUBuffer, indexCount: number): number {
		const pipeline = this.#pipelines.get(key);
		if (pipeline === undefined || this.patchCount === 0) {
			return 0;
		}
		pass.setPipeline(pipeline);
		pass.setBindGroup(1, this.#bindGroup);
		pass.setIndexBuffer(indices, 'uint16');
		pass.drawIndexed(indexCount, this.patchCount);
		return 1;
	}
}
