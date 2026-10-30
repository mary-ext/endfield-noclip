/**
 * instance rows of every resident block live in one mega storage buffer, sub-allocated per block. each row
 * names its block's slot in a small origin table that is rebased to the eye every frame (camera-relative), so
 * no draw needs per-instance bindings.
 *
 * two ways to draw rows as boxes:
 *
 * - row ranges (packages without geometry): the traversal's ranges are merged and drawn with `firstInstance`
 *   straight into the rows, culling small boxes in the vertex shader.
 * - a visible list (packages with geometry): {@link MeshSelector} picks instances on the CPU and writes their
 *   row indices into a per-frame list; meshes and the boxes of instances whose geometry is still streaming
 *   both index rows through it. a GPU cull pass would write the same list plus indirect arguments.
 *
 * @module
 */

import type { BindLayouts } from '../gfx/bind-layouts.ts';
import type { PipelineCache } from '../gfx/pipeline-cache.ts';
import { RangeAllocator } from '../gfx/range-allocator.ts';
import { DEPTH_COMPARE, DEPTH_FORMAT, type MainPassFormat } from '../gfx/render-targets.ts';
import type { DecodedInstances } from '../package/decode-protocol.ts';
import type { Vec3 } from '../scene/camera.ts';
import type { InstanceRange } from '../streaming/selection.ts';
import type { ResidentInstances } from '../streaming/stream-manager.ts';

import { FRAME_WGSL } from './frame-uniforms.ts';
import { ROW_BYTES, assignBlockSlot } from './instance-rows.ts';
import boxesWgsl from './shaders/instance-boxes.wgsl?raw';

const BLOCK_SLOTS = 16_384;
/** entries of the visible list */
export const LIST_CAPACITY = 1 << 20;
const BOX_FILL_VERTICES = 36;
const BOX_WIRE_VERTICES = 24;

/** rows to place in the visible list; {@link InstanceRenderer.prepareList} sets where they landed */
export interface ListedRows {
	readonly rows: readonly number[];
	/** list offset of the rows */
	first: number;
	/** rows that fit into the list */
	count: number;
}

type DrawMode = 'ranges' | 'list';

/** owns the instance mega buffer, the block origin table, the visible list and the box pipelines */
export class InstanceRenderer {
	readonly capacityRows: number;
	/** box instances submitted last frame */
	instanceCount = 0;

	#device: GPUDevice;
	#rows: GPUBuffer;
	#allocator: RangeAllocator;
	#blocks: GPUBuffer;
	#blockOrigins = new Float64Array(BLOCK_SLOTS * 3);
	#blockData = new Float32Array(BLOCK_SLOTS * 4);
	#freeSlots: number[] = [];
	#liveSlots = 0;
	#list: GPUBuffer;
	#listData = new Uint32Array(LIST_CAPACITY);
	#mode: DrawMode = 'ranges';
	#bindGroup: GPUBindGroup;
	#draws = new Uint32Array(2 * 65_536);
	#drawCount = 0;
	#pipelines: PipelineCache;
	/** pipeline keys by mode: filled boxes, and box edges */
	#keys: Record<DrawMode, { fill: string; wire: string }>;

	/**
	 * @param device the device
	 * @param layouts shared layouts
	 * @param pipelines pipeline cache
	 * @param format the main pass's targets
	 * @param capacityRows rows the mega buffer holds
	 */
	constructor(
		device: GPUDevice,
		layouts: BindLayouts,
		pipelines: PipelineCache,
		format: MainPassFormat,
		capacityRows: number,
	) {
		this.#device = device;
		this.#pipelines = pipelines;
		this.capacityRows = Math.min(
			capacityRows,
			Math.floor(device.limits.maxStorageBufferBindingSize / ROW_BYTES),
		);
		this.#allocator = new RangeAllocator(this.capacityRows);
		for (let slot = BLOCK_SLOTS - 1; slot >= 0; slot--) {
			this.#freeSlots.push(slot);
		}
		this.#rows = device.createBuffer({
			label: 'instance rows',
			size: this.capacityRows * ROW_BYTES,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#blocks = device.createBuffer({
			label: 'instance block origins',
			size: this.#blockData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#list = device.createBuffer({
			label: 'visible instance list',
			size: this.#listData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#bindGroup = device.createBindGroup({
			label: 'instances',
			layout: layouts.instances,
			entries: [
				{ binding: 0, resource: { buffer: this.#rows } },
				{ binding: 1, resource: { buffer: this.#blocks } },
				{ binding: 2, resource: { buffer: this.#list } },
			],
		});

		const module = pipelines.module('instance-boxes', FRAME_WGSL + boxesWgsl);
		this.#keys = {
			ranges: { fill: 'boxes/fill', wire: 'boxes/wire' },
			list: { fill: 'boxes/list-fill', wire: 'boxes/list-wire' },
		};
		const describe = (lines: boolean, list: boolean): GPURenderPipelineDescriptor => {
			const constants = { USE_LIST: list ? 1 : 0 };
			return {
				layout: layouts.instancesPipeline,
				vertex: { module, entryPoint: lines ? 'vs_wire' : 'vs_fill', constants },
				fragment: {
					module,
					entryPoint: lines ? 'fs_wire' : 'fs_fill',
					targets: format.targets,
				},
				// generated boxes aren't wound consistently; they're closed, so culling would only halve fill cost
				primitive: { topology: lines ? 'line-list' : 'triangle-list', cullMode: 'none' },
				depthStencil: {
					format: DEPTH_FORMAT,
					depthWriteEnabled: !lines,
					depthCompare: lines ? 'greater-equal' : DEPTH_COMPARE,
				},
			};
		};
		void pipelines.prepare(this.#keys.ranges.fill, () => describe(false, false));
		void pipelines.prepare(this.#keys.ranges.wire, () => describe(true, false));
		void pipelines.prepare(this.#keys.list.fill, () => describe(false, true));
		void pipelines.prepare(this.#keys.list.wire, () => describe(true, true));
	}

	/** @returns group 1 of the instance families (rows, block origins, visible list) */
	get bindGroup(): GPUBindGroup {
		return this.#bindGroup;
	}

	/** @returns bytes of the fixed GPU allocations */
	get poolBytes(): number {
		return this.capacityRows * ROW_BYTES + this.#blockData.byteLength + this.#listData.byteLength;
	}

	/**
	 * uploads an instance block's rows.
	 *
	 * @param decoded the rows; their block slot is assigned in place and they're kept for CPU-side selection
	 * @returns the residency, or `null` if there was no room
	 */
	upload(decoded: DecodedInstances): ResidentInstances | null {
		const alloc = decoded.count > 0 ? this.#allocator.allocate(decoded.count) : { start: 0, count: 0 };
		if (alloc === null) {
			return null;
		}
		const slot = this.#freeSlots.pop();
		if (slot === undefined) {
			if (alloc.count > 0) {
				this.#allocator.free(alloc);
			}
			return null;
		}
		assignBlockSlot(decoded.rows, slot);
		if (alloc.count > 0) {
			this.#device.queue.writeBuffer(this.#rows, alloc.start * ROW_BYTES, decoded.rows);
		}
		this.#blockOrigins.set(decoded.origin, slot * 3);
		this.#liveSlots = Math.max(this.#liveSlots, slot + 1);
		return {
			kind: 'instances',
			bytes: decoded.count * ROW_BYTES,
			alloc,
			blockSlot: slot,
			count: decoded.count,
			origin: decoded.origin,
			runs: decoded.runs,
			rowsF32: new Float32Array(decoded.rows.buffer),
			cull: decoded.cull,
		};
	}

	/** @param resident a block from {@link upload}; its rows and slot are freed */
	release(resident: ResidentInstances): void {
		if (resident.alloc.count > 0) {
			this.#allocator.free(resident.alloc);
		}
		this.#freeSlots.push(resident.blockSlot);
	}

	/**
	 * rebases block origins to the eye; call every rendered frame before drawing.
	 *
	 * @param eye camera position, f64
	 */
	rebase(eye: Vec3): void {
		const origins = this.#blockOrigins;
		const data = this.#blockData;
		for (let slot = 0; slot < this.#liveSlots; slot++) {
			data[slot * 4] = origins[slot * 3] - eye[0];
			data[slot * 4 + 1] = origins[slot * 3 + 1] - eye[1];
			data[slot * 4 + 2] = origins[slot * 3 + 2] - eye[2];
		}
		if (this.#liveSlots > 0) {
			this.#device.queue.writeBuffer(this.#blocks, 0, data, 0, this.#liveSlots * 4);
		}
	}

	/**
	 * row-range mode: turns the selection into merged row-range box draws.
	 *
	 * @param ranges selected ranges
	 */
	prepareRanges(ranges: readonly InstanceRange[]): void {
		this.#mode = 'ranges';
		const starts: [start: number, count: number][] = [];
		for (const { item, first, count } of ranges) {
			const instances = item.resident;
			if (instances?.kind === 'instances' && count > 0) {
				starts.push([instances.alloc.start + first, count]);
			}
		}
		starts.sort((a, b) => a[0] - b[0]);
		const draws = this.#draws;
		let drawCount = 0;
		let instanceCount = 0;
		for (const [start, count] of starts) {
			instanceCount += count;
			const last = (drawCount - 1) * 2;
			if (drawCount > 0 && draws[last] + draws[last + 1] >= start) {
				draws[last + 1] = Math.max(draws[last] + draws[last + 1], start + count) - draws[last];
				continue;
			}
			if (drawCount * 2 >= draws.length) {
				break;
			}
			draws[drawCount * 2] = start;
			draws[drawCount * 2 + 1] = count;
			drawCount++;
		}
		this.#drawCount = drawCount;
		this.instanceCount = instanceCount;
	}

	/**
	 * list mode: uploads this frame's visible list, boxes first, then each set of mesh rows, and records in
	 * each set where its rows landed. rows past the list capacity are dropped.
	 *
	 * @param boxes rows to draw as boxes
	 * @param sets rows of the mesh draws; their `first` and `count` are set
	 * @returns the end of the list
	 */
	prepareList(boxes: readonly number[], sets: readonly ListedRows[]): number {
		this.#mode = 'list';
		const list = this.#listData;
		let at = Math.min(boxes.length, LIST_CAPACITY);
		for (let i = 0; i < at; i++) {
			list[i] = boxes[i];
		}
		this.instanceCount = at;
		this.#drawCount = at > 0 ? 1 : 0;
		for (const set of sets) {
			const rows = set.rows;
			const count = Math.min(rows.length, LIST_CAPACITY - at);
			for (let i = 0; i < count; i++) {
				list[at + i] = rows[i];
			}
			set.first = at;
			set.count = count;
			at += count;
		}
		if (at > 0) {
			this.#device.queue.writeBuffer(this.#list, 0, list, 0, at);
		}
		return at;
	}

	/** @returns triangles submitted last frame as boxes (before GPU culling) */
	get triangles(): number {
		return this.instanceCount * 12;
	}

	/**
	 * draws filled boxes, except those too large to fill.
	 *
	 * @param pass the main pass, with group 0 bound
	 * @returns draw calls issued
	 */
	encode(pass: GPURenderPassEncoder): number {
		return this.#encode(pass, this.#keys[this.#mode].fill, BOX_FILL_VERTICES);
	}

	/**
	 * draws box edges: of every box in wireframe mode, otherwise only of boxes too large to fill.
	 *
	 * @param pass the main pass, with group 0 bound
	 * @returns draw calls issued
	 */
	encodeOutlines(pass: GPURenderPassEncoder): number {
		return this.#encode(pass, this.#keys[this.#mode].wire, BOX_WIRE_VERTICES);
	}

	#encode(pass: GPURenderPassEncoder, key: string, vertices: number): number {
		const pipeline = this.#pipelines.get(key);
		if (pipeline === undefined || this.#drawCount === 0) {
			return 0;
		}
		pass.setPipeline(pipeline);
		pass.setBindGroup(1, this.#bindGroup);
		if (this.#mode === 'list') {
			pass.draw(vertices, this.instanceCount, 0, 0);
			return 1;
		}
		const draws = this.#draws;
		for (let i = 0; i < this.#drawCount; i++) {
			pass.draw(vertices, draws[i * 2 + 1], 0, draws[i * 2]);
		}
		return this.#drawCount;
	}
}
