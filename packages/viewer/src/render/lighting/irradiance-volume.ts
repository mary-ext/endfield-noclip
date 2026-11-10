import type { IrradianceRegionInfo, IrradianceTable } from '@endfield-noclip/package-format/irradiance';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { createUniformBuffer } from '../../gfx/buffers.ts';
import { GrowableBuffer } from '../../gfx/growable-buffer.ts';
import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { LINEAR_CLAMP, LINEAR_REPEAT, sampler } from '../../gfx/samplers.ts';
import { vec3From } from '../../math/vec3.ts';
import type { DecodedIrradiance } from '../../package/decode-protocol.ts';
import type { ResidentIrradiance } from '../../streaming/resident.ts';
import type { StreamManager } from '../../streaming/stream-manager.ts';

import clipmapWgsl from './irradiance-clipmap.wgsl?raw';
import updateWgsl from './irradiance-update.wgsl?raw';

/** texels per clipmap level */
const SIZE = [128, 64, 128] as const;
/**
 * slices per level in the stacked textures: the level's, with a wrapped copy either side
 * (irradiance-clipmap.wgsl)
 */
const SLAB = SIZE[2] + 2;
/** metres between probes, per level */
const SPACING = [0.5, 2, 8] as const;
/** a level re-centres once the camera is this many texels from its centre (well within its fade margin) */
const RECENTRE = 4;
/**
 * cell buffer size to start with and at most (bytes). the windows around the camera hold tens of MB of cells,
 * and the streaming budget bounds what stays resident besides
 */
const CELL_BUFFER_INITIAL = 32 * 1024 ** 2;
const CELL_BUFFER_MAX = 192 * 1024 ** 2;
/** stream priority of cells; coarse levels first, all ahead of scenery */
const PRIORITY = [1e6, 2e6, 3e6] as const;

/** probe units (0.5 m) of `world`, with world 0 at this value */
const ORIGIN = 8192;
/** region bakes the finest level applies at once (Dijiang has four rooms) */
const MAX_REGIONS = 8;
/** words per region in the regions buffer: origin xyz, first cell word, size xyz, padding */
const REGION_WORDS = 8;
/** words of `Update` in irradiance-update.wgsl */
const UPDATE_WORDS = 12;
const PIPELINE_KEY = 'irradiance update';

interface Level {
	/** probe index of the centre, in this level's spacing; `null` before the first update */
	center: [number, number, number] | null;
	/** cell window: minimum cell index and size, and the slots last written */
	windowMin: [number, number, number];
	windowSize: [number, number, number];
	slots: Uint32Array;
	/** the window's first word in the windows buffer */
	windowBase: number;
	dirty: boolean;
	uniforms: GPUBuffer;
	group: GPUBindGroup | null;
}

/** a clipmap's A (L0 rgb) and B (three slabs along y of L1) */
interface Clipmap {
	a: GPUTexture;
	b: GPUTexture;
}

/** owns the cell buffer, the clipmaps and their update pass; holds one package's volume at a time */
export class IrradianceVolume {
	#device: GPUDevice;
	#pipelines: PipelineCache;
	#layout: GPUBindGroupLayout;
	/** each cell key's bakes in table order: the first whose group shows applies */
	#cells = new Map<number, { blob: number; group: number }[]>();
	/** the resident cells, in words */
	#buffer: GrowableBuffer;
	/** the cell buffer version the level groups bind */
	#bufferVersion = 0;
	#windows: GPUBuffer;
	/** the package's region bakes, and which visibility groups show */
	#regions: readonly IrradianceRegionInfo[] = [];
	#groupsShown: readonly boolean[] = [];
	/** the regions the finest level last applied, as written to {@link #regionBuffer} */
	#applied = new Int32Array(MAX_REGIONS * REGION_WORDS);
	#appliedCount = 0;
	/** the regions being gathered this frame, swapped with {@link #applied} when they differ */
	#gathered = new Int32Array(MAX_REGIONS * REGION_WORDS);
	#regionBuffer: GPUBuffer;
	#update = new Int32Array(UPDATE_WORDS);
	#levels: Level[];
	/** every level, stacked along z; the lighting and the update pass read these */
	#stacked: Clipmap;
	/** one level, which the update pass writes before it's copied into its slab */
	#scratch: Clipmap;
	/** whether {@link #stacked} and {@link #scratch} are the 1 × 1 × 1 stand-ins of a package without a volume */
	#placeholder = true;
	readonly sampler: GPUSampler;
	readonly clampSampler: GPUSampler;

	/**
	 * starts without a volume; see {@link setPackage}.
	 *
	 * @param device the device
	 * @param pipelines the pipeline cache, which compiles the update pass
	 */
	constructor(device: GPUDevice, pipelines: PipelineCache) {
		this.#device = device;
		this.#pipelines = pipelines;
		this.#regionBuffer = device.createBuffer({
			label: 'irradiance regions',
			size: MAX_REGIONS * REGION_WORDS * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#buffer = cellBuffer(device, true);
		this.sampler = sampler(device, LINEAR_REPEAT);
		this.clampSampler = sampler(device, LINEAR_CLAMP);
		{
			const compute = GPUShaderStage.COMPUTE;
			const storage = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({
				binding,
				visibility: compute,
				storageTexture: { access: 'write-only', format, viewDimension: '3d' },
			});
			const sampled = (binding: number): GPUBindGroupLayoutEntry => ({
				binding,
				visibility: compute,
				texture: { viewDimension: '3d' },
			});
			const cells = (binding: number): GPUBindGroupLayoutEntry => ({
				binding,
				visibility: compute,
				buffer: { type: 'read-only-storage' },
			});
			this.#layout = device.createBindGroupLayout({
				label: 'irradiance update',
				entries: [
					{ binding: 0, visibility: compute, buffer: { type: 'uniform' } },
					cells(1),
					cells(2),
					storage(3, 'rgba16float'),
					storage(4, 'rgba8unorm'),
					sampled(5),
					sampled(6),
					{ binding: 7, visibility: compute, sampler: {} },
					{ binding: 8, visibility: compute, sampler: {} },
					cells(9),
				],
			});
		}
		const layout = this.#layout;
		void pipelines.prepareCompute(PIPELINE_KEY, () => ({
			layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
			compute: {
				module: pipelines.module('irradiance update', clipmapWgsl + updateWgsl),
				entryPoint: 'cs_update',
			},
		}));

		// each level's window spans the cells its probes fall in: size · spacing / cell size, plus one
		const windowSizes = SPACING.map((spacing, level) =>
			vec3From((axis) => Math.floor((SIZE[axis] * spacing) / (32 << level)) + 1),
		);
		const windowWords = windowSizes.map(([x, y, z]) => x * y * z);
		this.#windows = device.createBuffer({
			label: 'irradiance windows',
			size: windowWords.reduce((sum, n) => sum + n, 0) * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		[this.#stacked, this.#scratch] = clipmaps(device, true);
		let windowBase = 0;
		this.#levels = SPACING.map((_, level) => {
			const out: Level = {
				center: null,
				windowMin: [0, 0, 0],
				windowSize: windowSizes[level],
				slots: new Uint32Array(windowWords[level]),
				windowBase,
				dirty: true,
				uniforms: createUniformBuffer(device, `irradiance update ${level}`, UPDATE_WORDS * 4),
				group: null,
			};
			windowBase += windowWords[level];
			return out;
		});
		this.#rebindLevels();
	}

	/**
	 * replaces the volume with a package's, dropping its resident cells: the caller drops the stream holding
	 * them first. rebind {@link views} and the samplers afterwards.
	 *
	 * @param table the package's cells (empty for none), each bake applying while its group shows
	 * @param regions the package's region bakes, which apply while their groups show (see
	 *   {@link setGroupsShown})
	 */
	setPackage(table: IrradianceTable, regions: readonly IrradianceRegionInfo[]): void {
		const device = this.#device;
		this.#regions = regions;
		this.#cells.clear();
		for (let i = 0; i < table.keys.length; i++) {
			this.#cells
				.getOrInsertComputed(table.keys[i], () => [])
				.push({ blob: table.blobs[i], group: table.groups[i] });
		}
		const empty = table.keys.length === 0;
		this.#buffer.destroy();
		this.#buffer = cellBuffer(device, empty);
		if (empty !== this.#placeholder) {
			for (const texture of [this.#stacked.a, this.#stacked.b, this.#scratch.a, this.#scratch.b]) {
				texture.destroy();
			}
			[this.#stacked, this.#scratch] = clipmaps(device, empty);
			this.#placeholder = empty;
		}
		this.#applied.fill(0);
		this.#appliedCount = 0;
		for (const level of this.#levels) {
			level.center = null;
			level.windowMin = [0, 0, 0];
			level.slots.fill(0);
			level.dirty = true;
		}
		this.#rebindLevels();
	}

	/** points the levels' update groups at the current cell buffer and clipmaps */
	#rebindLevels(): void {
		this.#bufferVersion = this.#buffer.version;
		for (const level of this.#levels) {
			level.group = this.#device.createBindGroup({
				layout: this.#layout,
				entries: [
					{ binding: 0, resource: { buffer: level.uniforms } },
					{ binding: 1, resource: { buffer: this.#buffer.buffer } },
					{ binding: 2, resource: { buffer: this.#windows } },
					{ binding: 3, resource: this.#scratch.a.createView() },
					{ binding: 4, resource: this.#scratch.b.createView() },
					{ binding: 5, resource: this.#stacked.a.createView() },
					{ binding: 6, resource: this.#stacked.b.createView() },
					{ binding: 7, resource: this.sampler },
					{ binding: 8, resource: this.clampSampler },
					{ binding: 9, resource: { buffer: this.#regionBuffer } },
				],
			});
		}
	}

	/**
	 * @param shown per visibility group, whether it shows; a cell's bake or a region bake applies while its
	 *   group does
	 */
	setGroupsShown(shown: readonly boolean[]): void {
		this.#groupsShown = shown;
	}

	/** whether the package has a volume at all */
	get active(): boolean {
		return this.#cells.size > 0;
	}

	/** @returns views of the clipmaps with the levels stacked along z, A (L0) and B (L1 slabs) */
	views(): { a: GPUTextureView; b: GPUTextureView } {
		return { a: this.#stacked.a.createView(), b: this.#stacked.b.createView() };
	}

	/**
	 * @returns the world position (m) of each level's clipmap centre, or `null` for a level not filled yet,
	 *   counting levels {@link encode} fills this frame as filled
	 */
	centers(): (Vec3 | null)[] {
		const compiled = this.#pipelines.getCompute(PIPELINE_KEY) !== undefined;
		return this.#levels.map((level, i) =>
			level.center === null || !compiled
				? null
				: [level.center[0] * SPACING[i], level.center[1] * SPACING[i], level.center[2] * SPACING[i]],
		);
	}

	/**
	 * copies a streamed cell into the cell buffer, growing it if needed.
	 *
	 * @param decoded the cell
	 * @returns its residency, or `null` if the buffer is full at its largest
	 */
	upload(decoded: DecodedIrradiance): ResidentIrradiance | null {
		const words = decoded.data.byteLength >> 2;
		const alloc = this.#buffer.allocate(words);
		if (alloc === null) {
			return null;
		}
		this.#device.queue.writeBuffer(this.#buffer.buffer, alloc.start * 4, decoded.data);
		return { kind: 'irradiance', bytes: decoded.data.byteLength, alloc };
	}

	/** @param resident a cell's residency, freed */
	release(resident: ResidentIrradiance): void {
		this.#buffer.free(resident.alloc);
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
		const groupsShown = this.#groupsShown;
		for (const [index, level] of this.#levels.entries()) {
			const spacing = SPACING[index];
			const wanted = vec3From((axis) => Math.round(eye[axis] / spacing));
			if (level.center === null || wanted.some((v, axis) => Math.abs(v - level.center![axis]) > RECENTRE)) {
				level.center = wanted;
				level.dirty = true;
			}
			const center = level.center;
			// the cells the level's probes fall in
			const step = 1 << (2 * index);
			const shift = 6 + index;
			const min = vec3From((axis) => ((center[axis] - SIZE[axis] / 2) * step + ORIGIN) >> shift);
			if (min.some((v, axis) => v !== level.windowMin[axis])) {
				level.windowMin = min;
				level.dirty = true;
			}
			const [sx, sy, sz] = level.windowSize;
			for (let z = 0; z < sz; z++) {
				const cz = (min[2] + z) << index;
				for (let y = 0; y < sy; y++) {
					const cy = (min[1] + y) << index;
					for (let x = 0; x < sx; x++) {
						const cx = (min[0] + x) << index;
						let slot = 0;
						if (cx >= 0 && cx < 256 && cy >= 0 && cy < 256 && cz >= 0 && cz < 256) {
							const key = (cx | (cy << 8) | (cz << 16) | (index << 24)) >>> 0;
							const bakes = this.#cells.get(key);
							if (bakes !== undefined) {
								for (const { blob, group } of bakes) {
									if (!(groupsShown[group] ?? false)) {
										continue;
									}
									const item = stream.want(blob, PRIORITY[index]);
									if (item?.resident?.kind === 'irradiance') {
										slot = item.resident.alloc.start + 1;
									}
									break;
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
		this.#prepareRegions(stream);
	}

	/** wants the shown region bakes the finest level overlaps, and marks it dirty when the resident set changes */
	#prepareRegions(stream: StreamManager): void {
		const finest = this.#levels[0];
		const center = finest.center;
		if (center === null) {
			return;
		}
		const gathered = this.#gathered;
		gathered.fill(0);
		let count = 0;
		for (const region of this.#regions) {
			if (count === MAX_REGIONS || !(this.#groupsShown[region.group] ?? false)) {
				continue;
			}
			const { origin, size } = region;
			let overlaps = true;
			for (let axis = 0; axis < 3; axis++) {
				const half = SIZE[axis] / 2;
				if (!(origin[axis] < center[axis] + half && origin[axis] + size[axis] > center[axis] - half)) {
					overlaps = false;
					break;
				}
			}
			if (!overlaps) {
				continue;
			}
			const item = stream.want(region.blob, PRIORITY[0]);
			if (item?.resident?.kind !== 'irradiance') {
				continue;
			}
			const at = count * REGION_WORDS;
			gathered[at] = origin[0];
			gathered[at + 1] = origin[1];
			gathered[at + 2] = origin[2];
			gathered[at + 3] = item.resident.alloc.start;
			gathered[at + 4] = size[0];
			gathered[at + 5] = size[1];
			gathered[at + 6] = size[2];
			count++;
		}
		let changed = count !== this.#appliedCount;
		for (let i = 0; !changed && i < gathered.length; i++) {
			changed = gathered[i] !== this.#applied[i];
		}
		if (changed) {
			this.#gathered = this.#applied;
			this.#applied = gathered;
			this.#appliedCount = count;
			finest.dirty = true;
		}
	}

	/**
	 * refills the levels {@link prepare} found changed, and every finer level after them, once the update pass
	 * has compiled.
	 *
	 * @param encoder this frame's encoder, before the main pass
	 */
	encode(encoder: GPUCommandEncoder): void {
		const pipeline = this.#pipelines.getCompute(PIPELINE_KEY);
		if (pipeline === undefined) {
			return;
		}
		const device = this.#device;
		if (this.#bufferVersion !== this.#buffer.version) {
			this.#rebindLevels();
		}
		// coarse to fine, since finer levels copy coarser ones
		let coarserChanged = false;
		for (let index = this.#levels.length - 1; index >= 0; index--) {
			const level = this.#levels[index];
			if (coarserChanged) {
				level.dirty = true;
			}
			if (!level.dirty || level.center === null) {
				continue;
			}
			level.dirty = false;
			coarserChanged = true;
			const [sx, sy, sz] = level.windowSize;
			device.queue.writeBuffer(this.#windows, level.windowBase * 4, level.slots);
			const regions = index === 0 ? this.#appliedCount : 0;
			if (regions > 0) {
				device.queue.writeBuffer(this.#regionBuffer, 0, this.#applied);
			}
			const update = this.#update;
			update.set(level.center, 0);
			update[3] = index;
			update.set(level.windowMin, 4);
			update[7] = level.windowBase;
			update[8] = sx;
			update[9] = sy;
			update[10] = sz;
			update[11] = regions;
			device.queue.writeBuffer(level.uniforms, 0, update);
			const pass = encoder.beginComputePass({ label: `irradiance update ${index}` });
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, level.group);
			pass.dispatchWorkgroups(SIZE[0] / 4, SIZE[1] / 4, SIZE[2] / 4);
			pass.end();
			this.#copyToSlab(encoder, index);
		}
	}

	/** copies the scratch level into level `index`'s slab, with A's wrapped slices either side */
	#copyToSlab(encoder: GPUCommandEncoder, index: number): void {
		const base = index * SLAB;
		const last = SIZE[2] - 1;
		const { a, b } = this.#scratch;
		encoder.copyTextureToTexture(
			{ texture: a },
			{ texture: this.#stacked.a, origin: [0, 0, base + 1] },
			SIZE,
		);
		encoder.copyTextureToTexture(
			{ texture: a, origin: [0, 0, last] },
			{ texture: this.#stacked.a, origin: [0, 0, base] },
			[SIZE[0], SIZE[1], 1],
		);
		encoder.copyTextureToTexture(
			{ texture: a, origin: [0, 0, 0] },
			{ texture: this.#stacked.a, origin: [0, 0, base + SLAB - 1] },
			[SIZE[0], SIZE[1], 1],
		);
		// B samples clamped, so its wrapped slices stay unread
		encoder.copyTextureToTexture({ texture: b }, { texture: this.#stacked.b, origin: [0, 0, base + 1] }, [
			SIZE[0],
			SIZE[1] * 3,
			SIZE[2],
		]);
	}

	/** frees the GPU resources */
	destroy(): void {
		this.#buffer.destroy();
		this.#windows.destroy();
		this.#regionBuffer.destroy();
		for (const texture of [this.#stacked.a, this.#stacked.b, this.#scratch.a, this.#scratch.b]) {
			texture.destroy();
		}
		for (const level of this.#levels) {
			level.uniforms.destroy();
		}
	}
}

/** @returns a cell buffer, a minimal one for a package without a volume */
const cellBuffer = (device: GPUDevice, empty: boolean): GrowableBuffer =>
	new GrowableBuffer(device, {
		label: 'irradiance cells',
		unitBytes: 4,
		initialUnits: empty ? 4 : CELL_BUFFER_INITIAL / 4,
		maxUnits: empty ? 4 : CELL_BUFFER_MAX / 4,
		usage: GPUBufferUsage.STORAGE,
	});

/** @returns the stacked and scratch clipmaps, 1 × 1 × 1 stand-ins for a package without a volume */
const clipmaps = (device: GPUDevice, empty: boolean): [stacked: Clipmap, scratch: Clipmap] => {
	const clipmap = (label: string, depth: number, usage: number): Clipmap => {
		const texture = (part: 'a' | 'b'): GPUTexture =>
			device.createTexture({
				label: `irradiance ${label} ${part}`,
				size: empty ? [1, 1, 1] : [SIZE[0], part === 'a' ? SIZE[1] : SIZE[1] * 3, depth],
				dimension: '3d',
				format: part === 'a' ? 'rgba16float' : 'rgba8unorm',
				usage,
			});
		return { a: texture('a'), b: texture('b') };
	};
	return [
		clipmap('stacked', SLAB * SPACING.length, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST),
		clipmap('scratch', SIZE[2], GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC),
	];
};
