/**
 * the baked irradiance volume around the camera, as the game's renderer keeps it: three toroidal clipmaps of
 * L1 probes (0.5 m, 2 m and 8 m apart, 128 × 64 × 128 each) filled by a compute pass from the streamed cells.
 * a texel without a probe of its own copies the next coarser level. the lighting (`frame.wgsl`) samples them
 * and adds the environment's ambient probe by their validity and reach.
 *
 * @module
 */

import type { IrradianceTable } from '@endfield-noclip/package-format/format';

import { RangeAllocator } from '../gfx/range-allocator.ts';
import type { DecodedIrradiance } from '../package/decode-protocol.ts';
import type { Vec3 } from '../scene/camera.ts';
import type { ResidentIrradiance, StreamManager } from '../streaming/stream-manager.ts';

import updateWgsl from './shaders/irradiance-update.wgsl?raw';

/** texels per clipmap level */
const SIZE = [128, 64, 128] as const;
/** metres between probes, per level */
const SPACING = [0.5, 2, 8] as const;
/** a level re-centres once the camera is this many texels from its centre (well within its fade margin) */
const RECENTRE = 4;
/** cell buffer size at most (bytes); the window of cells around the camera needs ~40 MB on map02 */
const CELL_BUFFER_BYTES = 192 * 1024 ** 2;
/** stream priority of cells; coarse levels first, all ahead of scenery */
const PRIORITY = [1e6, 2e6, 3e6] as const;

/** probe units (0.5 m) of `world`, with world 0 at this value */
const ORIGIN = 8192;

/** @returns `f` over the three axes */
const vec3 = (f: (axis: number) => number): [number, number, number] => [f(0), f(1), f(2)];

interface Level {
	/** probe index of the centre, in this level's spacing; `null` before the first update */
	centre: [number, number, number] | null;
	/** cell window: minimum cell index and size, and the slots last written */
	windowMin: [number, number, number];
	windowSize: [number, number, number];
	slots: Uint32Array;
	/** the window's first word in the windows buffer */
	windowBase: number;
	dirty: boolean;
	a: GPUTexture;
	b: GPUTexture;
	uniforms: GPUBuffer;
	group: GPUBindGroup;
}

/** owns the cell buffer, the clipmaps and their update pass */
export class IrradianceVolume {
	#device: GPUDevice;
	/** blob index by cell key */
	#cells: Map<number, number>;
	#buffer: GPUBuffer;
	#allocator: RangeAllocator;
	#windows: GPUBuffer;
	#pipeline: GPUComputePipeline;
	#levels: Level[];
	readonly sampler: GPUSampler;
	readonly clampSampler: GPUSampler;

	/**
	 * @param device the device
	 * @param table the package's cells (empty for none)
	 */
	constructor(device: GPUDevice, table: IrradianceTable) {
		this.#device = device;
		this.#cells = new Map();
		for (let i = 0; i < table.keys.length; i++) {
			this.#cells.set(table.keys[i], table.blobs[i]);
		}
		const bytes =
			table.keys.length === 0 ? 16 : Math.min(CELL_BUFFER_BYTES, device.limits.maxStorageBufferBindingSize);
		this.#buffer = device.createBuffer({
			label: 'irradiance cells',
			size: bytes & ~3,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#allocator = new RangeAllocator(bytes >> 2);
		const module = device.createShaderModule({ label: 'irradiance update', code: updateWgsl });
		this.#pipeline = device.createComputePipeline({
			label: 'irradiance update',
			layout: 'auto',
			compute: { module, entryPoint: 'cs_update' },
		});
		this.sampler = device.createSampler({
			label: 'irradiance repeat',
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'repeat',
			addressModeV: 'repeat',
			addressModeW: 'repeat',
		});
		this.clampSampler = device.createSampler({
			label: 'irradiance clamp',
			magFilter: 'linear',
			minFilter: 'linear',
		});

		// each level's window spans the cells its probes fall in: size · spacing / cell size, plus one
		const windowSizes = SPACING.map((spacing, level) =>
			vec3((axis) => Math.floor((SIZE[axis] * spacing) / (32 << level)) + 1),
		);
		const windowWords = windowSizes.map(([x, y, z]) => x * y * z);
		this.#windows = device.createBuffer({
			label: 'irradiance windows',
			size: windowWords.reduce((sum, n) => sum + n, 0) * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		const empty = table.keys.length === 0;
		const textures = SPACING.map((_, level) => {
			const texture = (label: string, height: number): GPUTexture =>
				device.createTexture({
					label: `irradiance ${label} ${level}`,
					size: empty ? [1, 1, 1] : [SIZE[0], height, SIZE[2]],
					dimension: '3d',
					format: label === 'a' ? 'rgba16float' : 'rgba8unorm',
					usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
				});
			return { a: texture('a', SIZE[1]), b: texture('b', SIZE[1] * 3) };
		});
		let windowBase = 0;
		this.#levels = textures.map(({ a, b }, level) => {
			const uniforms = device.createBuffer({
				label: `irradiance update ${level}`,
				size: 48,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			});
			// the coarsest level has no coarser one and never reads it; any other level's textures fill the slot
			const coarse = textures[level + 1] ?? textures[level - 1];
			const group = device.createBindGroup({
				layout: this.#pipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: uniforms } },
					{ binding: 1, resource: { buffer: this.#buffer } },
					{ binding: 2, resource: { buffer: this.#windows } },
					{ binding: 3, resource: a.createView() },
					{ binding: 4, resource: b.createView() },
					{ binding: 5, resource: coarse.a.createView() },
					{ binding: 6, resource: coarse.b.createView() },
					{ binding: 7, resource: this.sampler },
					{ binding: 8, resource: this.clampSampler },
				],
			});
			const size = windowSizes[level];
			const out: Level = {
				centre: null,
				windowMin: [0, 0, 0],
				windowSize: size,
				slots: new Uint32Array(windowWords[level]),
				windowBase,
				dirty: true,
				a,
				b,
				uniforms,
				group,
			};
			windowBase += windowWords[level];
			return out;
		});
	}

	/** whether the package has a volume at all */
	get active(): boolean {
		return this.#cells.size > 0;
	}

	/** @returns each level's clipmap views, A (L0) then B (L1 slabs) */
	views(): { a: GPUTextureView; b: GPUTextureView }[] {
		return this.#levels.map((level) => ({ a: level.a.createView(), b: level.b.createView() }));
	}

	/** @returns the world position (m) of each level's clipmap centre, or `null` for a level not filled yet */
	centres(): (Vec3 | null)[] {
		return this.#levels.map((level, i) =>
			level.centre === null
				? null
				: [level.centre[0] * SPACING[i], level.centre[1] * SPACING[i], level.centre[2] * SPACING[i]],
		);
	}

	/**
	 * copies a streamed cell into the cell buffer.
	 *
	 * @param decoded the cell
	 * @returns its residency, or `null` if the buffer is full
	 */
	upload(decoded: DecodedIrradiance): ResidentIrradiance | null {
		const words = decoded.data.byteLength >> 2;
		const alloc = this.#allocator.allocate(words);
		if (alloc === null) {
			return null;
		}
		this.#device.queue.writeBuffer(this.#buffer, alloc.start * 4, decoded.data);
		return { kind: 'irradiance', bytes: decoded.data.byteLength, alloc };
	}

	/** @param resident a cell's residency, freed */
	release(resident: ResidentIrradiance): void {
		this.#allocator.free(resident.alloc);
	}

	/**
	 * re-centres the levels on the camera and wants the cells they cover; call before the stream update. levels
	 * whose centre or resident cells changed are refilled by the next {@link encode}.
	 *
	 * @param stream the stream manager holding the cells
	 * @param eye the camera's world position
	 */
	prepare(stream: StreamManager, eye: Readonly<Vec3>): void {
		if (!this.active) {
			return;
		}
		for (const [index, level] of this.#levels.entries()) {
			const spacing = SPACING[index];
			const wanted = vec3((axis) => Math.round(eye[axis] / spacing));
			if (level.centre === null || wanted.some((v, axis) => Math.abs(v - level.centre![axis]) > RECENTRE)) {
				level.centre = wanted;
				level.dirty = true;
			}
			const centre = level.centre;
			// the cells the level's probes fall in
			const step = 1 << (2 * index);
			const shift = 6 + index;
			const min = vec3((axis) => ((centre[axis] - SIZE[axis] / 2) * step + ORIGIN) >> shift);
			if (min.some((v, axis) => v !== level.windowMin[axis])) {
				level.windowMin = min;
				level.dirty = true;
			}
			const [sx, sy, sz] = level.windowSize;
			for (let z = 0; z < sz; z++) {
				for (let y = 0; y < sy; y++) {
					for (let x = 0; x < sx; x++) {
						const cell = [min[0] + x, min[1] + y, min[2] + z].map((v) => v << index);
						let slot = 0;
						if (cell.every((v) => v >= 0 && v < 256)) {
							const key = (cell[0] | (cell[1] << 8) | (cell[2] << 16) | (index << 24)) >>> 0;
							const blob = this.#cells.get(key);
							if (blob !== undefined) {
								const item = stream.want(blob, PRIORITY[index]);
								if (item?.resident?.kind === 'irradiance') {
									slot = item.resident.alloc.start + 1;
								}
							}
						}
						const at = x + y * sx + z * sx * sy;
						if (level.slots[at] !== slot) {
							level.slots[at] = slot;
							level.dirty = true;
						}
					}
				}
			}
		}
	}

	/**
	 * refills the levels {@link prepare} found changed, and every finer level after them.
	 *
	 * @param encoder this frame's encoder, before the main pass
	 */
	encode(encoder: GPUCommandEncoder): void {
		const device = this.#device;
		// coarse to fine, since finer levels copy coarser ones
		let coarserChanged = false;
		for (let index = this.#levels.length - 1; index >= 0; index--) {
			const level = this.#levels[index];
			if (coarserChanged) {
				level.dirty = true;
			}
			if (!level.dirty || level.centre === null) {
				continue;
			}
			level.dirty = false;
			coarserChanged = true;
			const [sx, sy, sz] = level.windowSize;
			device.queue.writeBuffer(this.#windows, level.windowBase * 4, level.slots);
			device.queue.writeBuffer(
				level.uniforms,
				0,
				new Int32Array([...level.centre, index, ...level.windowMin, level.windowBase, sx, sy, sz, 0]),
			);
			const pass = encoder.beginComputePass({ label: `irradiance update ${index}` });
			pass.setPipeline(this.#pipeline);
			pass.setBindGroup(0, level.group);
			pass.dispatchWorkgroups(SIZE[0] / 4, SIZE[1] / 4, SIZE[2] / 4);
			pass.end();
		}
	}

	/** frees the GPU resources */
	destroy(): void {
		this.#buffer.destroy();
		this.#windows.destroy();
		for (const level of this.#levels) {
			level.a.destroy();
			level.b.destroy();
			level.uniforms.destroy();
		}
	}
}
