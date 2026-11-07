/**
 * instance rows of every resident block live in one mega storage buffer, sub-allocated per block and grown as
 * blocks stream in (a level holds a small fraction of the rows the buffer can grow to). each row names its
 * block's slot in a small origin table that is rebased to the eye every frame (camera-relative), so no draw
 * needs per-instance bindings.
 *
 * two ways to draw rows as boxes:
 *
 * - row ranges (packages without geometry): the traversal's ranges are merged and drawn with `firstInstance`
 *   straight into the rows, culling small boxes in the vertex shader.
 * - a visible list (packages with geometry): {@link MeshSelector} picks instances on the CPU and writes their
 *   row indices into a per-frame list; meshes and the boxes of instances whose geometry is still streaming
 *   both index rows through it.
 *
 * @module
 */

import type { Vec3 } from '@endfield-noclip/package-format/values';

import { BLOCK_SLOTS, ROW_BYTES, ROW_WORDS, assignBlockSlot } from '../../content/instance-rows.ts';
import { freeSlots } from '../../gfx/free-slots.ts';
import { GrowableBuffer } from '../../gfx/growable-buffer.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import type { RangeAllocation } from '../../gfx/range-allocator.ts';
import type { DecodedInstances } from '../../package/decode-protocol.ts';
import type { GpuRows } from '../../streaming/gpu-cull-work.ts';
import type { ResidentInstances } from '../../streaming/resident.ts';
import type { InstanceRange } from '../../streaming/selection.ts';
import type { BindLayouts } from '../frame/bind-layouts.ts';
import { describeFill, describeWire } from '../frame/fill-and-wire.ts';
import { FRAME_WGSL } from '../frame/frame-uniforms.ts';
import type { MainPassFormat } from '../frame/render-targets.ts';

import boxesWgsl from './instance-boxes.wgsl?raw';

/** rows the mega buffer starts with (10 MiB) */
const INITIAL_ROWS = 131_072;
/** bytes per decal placement (`DECAL_PLACEMENT_FLOATS`) */
const PLACEMENT_BYTES = 32;
/** decal placements the placement buffer starts with */
const INITIAL_PLACEMENTS = 4096;
/** decal placements it can grow to */
const MAX_PLACEMENTS = 1 << 20;
/** entries of the visible list */
export const LIST_CAPACITY = 1 << 20;
const BOX_FILL_VERTICES = 36;
const BOX_WIRE_VERTICES = 24;

/** where a set of rows landed in the visible list ({@link InstanceRenderer.prepareList}) */
export interface ListedSpan {
	/** list offset of the rows */
	first: number;
	/** rows that fit into the list */
	count: number;
	/** per group but the last, the listed rows up to the end of that group */
	layerCounts: number[];
}

type DrawMode = 'ranges' | 'list';

/** owns the instance mega buffer, the block origin table, the visible list and the box pipelines */
export class InstanceRenderer {
	/** box instances submitted last frame */
	instanceCount = 0;

	#device: GPUDevice;
	#layout: GPUBindGroupLayout;
	/** the rows and placement buffer versions {@link #bindGroup} binds */
	#rowsVersion = -1;
	#placementsVersion = -1;
	#pool: GrowableBuffer;
	/** the resident blocks' rect decal placements, each block's run starting at its block table entry's w */
	#placements: GrowableBuffer;
	#blocks: GPUBuffer;
	#blockOrigins = new Float64Array(BLOCK_SLOTS * 3);
	#blockData = new Float32Array(BLOCK_SLOTS * 4);
	#freeSlots = freeSlots(BLOCK_SLOTS);
	#liveSlots = 0;
	#list: GPUBuffer;
	#listData = new Uint32Array(LIST_CAPACITY);
	/** where {@link prepareList}'s sets landed, reused across frames */
	#spans: ListedSpan[] = [];
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
	 * @param maxRows rows the mega buffer can grow to
	 */
	constructor(
		device: GPUDevice,
		layouts: BindLayouts,
		pipelines: PipelineCache,
		format: MainPassFormat,
		maxRows: number,
	) {
		this.#device = device;
		this.#pipelines = pipelines;
		this.#layout = layouts.instances;
		this.#pool = new GrowableBuffer(device, {
			label: 'instance rows',
			unitBytes: ROW_BYTES,
			initialUnits: INITIAL_ROWS,
			maxUnits: maxRows,
			usage: GPUBufferUsage.STORAGE,
		});
		this.#placements = new GrowableBuffer(device, {
			label: 'decal placements',
			unitBytes: PLACEMENT_BYTES,
			initialUnits: INITIAL_PLACEMENTS,
			maxUnits: MAX_PLACEMENTS,
			usage: GPUBufferUsage.STORAGE,
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
		this.#bindGroup = this.#createBindGroup();

		const module = pipelines.module('instance-boxes', FRAME_WGSL + boxesWgsl);
		this.#keys = {
			ranges: { fill: 'boxes/fill', wire: 'boxes/wire' },
			list: { fill: 'boxes/list-fill', wire: 'boxes/list-wire' },
		};
		const layout = layouts.instancesPipeline;
		const targets = format.targets;
		for (const mode of ['ranges', 'list'] as const) {
			const constants = { USE_LIST: mode === 'list' ? 1 : 0 };
			void pipelines.prepare(this.#keys[mode].fill, () =>
				describeFill(
					format,
					{
						layout,
						vertex: { module, entryPoint: 'vs_fill', constants },
						fragment: { module, entryPoint: 'fs_fill', targets },
					},
					// generated boxes aren't wound consistently; they're closed, so culling would only halve fill cost
					{ cullMode: 'none' },
				),
			);
			void pipelines.prepare(this.#keys[mode].wire, () =>
				describeWire(format, {
					layout,
					vertex: { module, entryPoint: 'vs_wire', constants },
					fragment: { module, entryPoint: 'fs_wire', targets },
				}),
			);
		}
	}

	#createBindGroup(): GPUBindGroup {
		this.#rowsVersion = this.#pool.version;
		this.#placementsVersion = this.#placements.version;
		return this.#device.createBindGroup({
			label: 'instances',
			layout: this.#layout,
			entries: [
				{ binding: 0, resource: { buffer: this.#pool.buffer } },
				{ binding: 1, resource: { buffer: this.#blocks } },
				{ binding: 2, resource: { buffer: this.#list } },
				{ binding: 3, resource: { buffer: this.#placements.buffer } },
			],
		});
	}

	/**
	 * @returns group 1 of the instance families (rows, block table, visible list, decal placements); a new
	 *   group after the rows or placements grew, so fetch it every frame
	 */
	get bindGroup(): GPUBindGroup {
		if (this.#rowsVersion !== this.#pool.version || this.#placementsVersion !== this.#placements.version) {
			this.#bindGroup = this.#createBindGroup();
		}
		return this.#bindGroup;
	}

	/**
	 * @returns the rows (replaced when they grow, as `rowsVersion` counts), the block origins and the visible
	 *   list
	 */
	get buffers(): { rows: GPUBuffer; rowsVersion: number; blocks: GPUBuffer; list: GPUBuffer } {
		return {
			rows: this.#pool.buffer,
			rowsVersion: this.#pool.version,
			blocks: this.#blocks,
			list: this.#list,
		};
	}

	/** @returns bytes of the GPU allocations */
	get bytes(): number {
		return this.#pool.bytes + this.#placements.bytes + this.#blockData.byteLength + this.#listData.byteLength;
	}

	/** destroys the GPU allocations; the renderer can't be used after */
	destroy(): void {
		this.#pool.destroy();
		this.#placements.destroy();
		this.#blocks.destroy();
		this.#list.destroy();
	}

	/**
	 * uploads an instance block's rows.
	 *
	 * @param decoded the rows; their block slot is assigned in place and they're kept for CPU-side selection
	 * @returns the residency, or `null` if there was no room
	 */
	upload(decoded: DecodedInstances): ResidentInstances | null {
		const placementCount = decoded.placements.length / (PLACEMENT_BYTES / 4);
		const alloc = decoded.count > 0 ? this.#pool.allocate(decoded.count) : { start: 0, count: 0 };
		if (alloc === null) {
			return null;
		}
		const placements =
			placementCount > 0 ? this.#placements.allocate(placementCount) : { start: 0, count: 0 };
		const slot = placements === null ? undefined : this.#freeSlots.pop();
		if (placements === null || slot === undefined) {
			if (alloc.count > 0) {
				this.#pool.free(alloc);
			}
			if (placements !== null && placements.count > 0) {
				this.#placements.free(placements);
			}
			return null;
		}
		assignBlockSlot(decoded.rows, slot);
		if (alloc.count > 0) {
			this.#device.queue.writeBuffer(this.#pool.buffer, alloc.start * ROW_BYTES, decoded.rows);
		}
		if (placements.count > 0) {
			this.#device.queue.writeBuffer(
				this.#placements.buffer,
				placements.start * PLACEMENT_BYTES,
				decoded.placements,
			);
		}
		this.#blockOrigins.set(decoded.origin, slot * 3);
		// a row's placement index counts from 1 (`row_placement` in frame.wgsl)
		this.#blockData[slot * 4 + 3] = placements.start - 1;
		this.#liveSlots = Math.max(this.#liveSlots, slot + 1);
		return {
			kind: 'instances',
			bytes: decoded.count * ROW_BYTES + placements.count * PLACEMENT_BYTES,
			alloc,
			placements,
			blockSlot: slot,
			origin: decoded.origin,
			runs: decoded.runs,
			rowsF32: new Float32Array(decoded.rows.buffer),
			cull: decoded.cull,
			spins: decoded.spins,
			floaters: decoded.floaters,
		};
	}

	/**
	 * reserves rows outside any block, for rows the viewer writes itself (particles). they use the block origin
	 * of whichever slot their words name
	 *
	 * @param count rows
	 * @returns the range, or `null` if the buffer is full
	 */
	allocateRows(count: number): RangeAllocation | null {
		return this.#pool.allocate(count);
	}

	/** @param alloc rows from {@link allocateRows} */
	freeRows(alloc: RangeAllocation): void {
		this.#pool.free(alloc);
	}

	/**
	 * @param start the first row to write
	 * @param rows {@link ROW_WORDS} words per row
	 * @param count rows to write
	 */
	writeRows(start: number, rows: Uint32Array<ArrayBuffer>, count: number): void {
		this.#device.queue.writeBuffer(this.#pool.buffer, start * ROW_BYTES, rows, 0, count * ROW_WORDS);
	}

	/** @param resident a block from {@link upload}; its rows and slot are freed */
	release(resident: ResidentInstances): void {
		if (resident.alloc.count > 0) {
			this.#pool.free(resident.alloc);
		}
		if (resident.placements.count > 0) {
			this.#placements.free(resident.placements);
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
	 * list mode: uploads this frame's visible list, boxes first, then each set of mesh rows, each set's groups
	 * one after another, then room for the sets the GPU culls, which it writes itself (`InstanceCuller`). rows
	 * past the list capacity are dropped.
	 *
	 * @param boxes rows to draw as boxes
	 * @param sets rows of the mesh draws, in groups, or the room a GPU-culled set needs
	 * @returns where each set's rows landed, by index into `sets`, valid until the next call; entries past the
	 *   sets are left from earlier calls. a GPU-culled set's span is its room, its rows in view first
	 */
	prepareList(
		boxes: readonly number[],
		sets: readonly { readonly rows: readonly (readonly number[])[]; readonly gpu: GpuRows | null }[],
	): readonly ListedSpan[] {
		this.#mode = 'list';
		const list = this.#listData;
		let at = Math.min(boxes.length, LIST_CAPACITY);
		for (let i = 0; i < at; i++) {
			list[i] = boxes[i];
		}
		this.instanceCount = at;
		this.#drawCount = at > 0 ? 1 : 0;
		const spans = this.#spans;
		for (let s = 0; s < sets.length; s++) {
			if (sets[s].gpu !== null) {
				continue;
			}
			const groups = sets[s].rows;
			const span = (spans[s] ??= { first: 0, count: 0, layerCounts: [] });
			span.first = at;
			span.layerCounts.length = Math.max(groups.length - 1, 0);
			for (let g = 0; g < groups.length; g++) {
				const rows = groups[g];
				const count = Math.min(rows.length, LIST_CAPACITY - at);
				for (let i = 0; i < count; i++) {
					list[at + i] = rows[i];
				}
				at += count;
				if (g < span.layerCounts.length) {
					span.layerCounts[g] = at - span.first;
				}
			}
			span.count = at - span.first;
		}
		if (at > 0) {
			this.#device.queue.writeBuffer(this.#list, 0, list, 0, at);
		}
		for (let s = 0; s < sets.length; s++) {
			const gpu = sets[s].gpu;
			if (gpu === null) {
				continue;
			}
			const span = (spans[s] ??= { first: 0, count: 0, layerCounts: [] });
			span.first = at;
			let room = gpu.rows;
			for (const rows of gpu.layerRows) {
				room += rows;
			}
			span.count = Math.min(room, LIST_CAPACITY - at);
			span.layerCounts.length = 0;
			at += span.count;
		}
		return spans;
	}

	/** @returns triangles submitted last frame as boxes (before the vertex shader's culling) */
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
		pass.setBindGroup(1, this.bindGroup);
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
