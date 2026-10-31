/**
 * CDLOD terrain: height pages live in a slot pool (one storage buffer), and every selected page quadrant is
 * an instance of one shared 33×33 grid, so terrain is a single draw. baked surface pages (albedo, normal)
 * live in a second slot pool, a pair of BC3 texture arrays, one layer per page. leaves near the camera add a
 * splat page (splat control, tint, layer index) from a third pool, and blend the package's layer textures,
 * which stay resident in a pair of BC7 arrays.
 *
 * @module
 */

import type { TerrainSplatInfo } from '@endfield-noclip/package-format/terrain';

import type { BindLayouts } from '../gfx/bind-layouts.ts';
import { GrowableBuffer } from '../gfx/growable-buffer.ts';
import type { PipelineCache } from '../gfx/pipeline-cache.ts';
import { DEPTH_COMPARE, type MainPassFormat } from '../gfx/render-targets.ts';
import type {
	DecodedDetail,
	DecodedHeights,
	DecodedLayer,
	DecodedSurface,
} from '../package/decode-protocol.ts';
import type { Vec3 } from '../scene/camera.ts';
import type { TerrainPatch } from '../streaming/selection.ts';
import type {
	ResidentDetail,
	ResidentHeights,
	ResidentLayer,
	ResidentSurface,
} from '../streaming/stream-manager.ts';

import { FRAME_WGSL } from './frame-uniforms.ts';
import terrainWgsl from './shaders/terrain.wgsl?raw';
import { SHADOW_DEPTH_STATE } from './shadow-map.ts';

/** samples per page edge the shader is written for (its `SIDE`) */
export const PAGE_SIDE = 65;
const QUADS = PAGE_SIDE - 1;
const GRID = QUADS / 2 + 1;
/** u32 words per page slot (two samples per word) */
const PAGE_WORDS = Math.ceil((PAGE_SIDE * PAGE_SIDE) / 2);
const PAGE_BYTES = PAGE_WORDS * 4;
/** height page slots the pool starts with (8 MiB); a level's view holds a few hundred pages */
const INITIAL_HEIGHT_SLOTS = 1024;
const PATCH_FLOATS = 20;
const SHADOW_KEY = 'terrain/shadow';

/** splat page slots; leaves within `DETAIL_DISTANCE` need a few dozen */
const DETAIL_SLOTS = 256;
/** index cells per splat page edge the shader is written for */
const DETAIL_CELLS = 8;
/** f32 words per layer in the layer storage buffer (5 vec4) */
const LAYER_FLOATS = 20;
/** bytes of one BC7 layer level, levels under 4² padded to a block */
const bc7LevelBytes = (size: number): number => Math.ceil(size / 4) ** 2 * 16;

/** texels per surface page edge the renderer is written for, border included */
export const SURFACE_SIDE = 132;
/** texels of each surface page edge outside its tile */
export const SURFACE_BORDER = 2;
/** surface page slots at most; about 34 KiB each */
const SURFACE_SLOTS = 1024;
const SURFACE_FORMAT: GPUTextureFormat = 'bc3-rgba-unorm';
/** bytes of one BC3 surface image */
const SURFACE_IMAGE_BYTES = (SURFACE_SIDE / 4) ** 2 * 16;

const vertexAt = (x: number, z: number): number => z * GRID + x;

const array = (texture: GPUTexture): GPUTextureView => texture.createView({ dimension: '2d-array' });

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

/** owns the height and surface pools, patch buffer and terrain pipelines */
export class TerrainRenderer {
	/** whether surface pages can be drawn (the device has BC textures) */
	readonly surfaces: boolean;
	/** patches drawn last frame */
	patchCount = 0;
	/** triangles per patch */
	readonly patchTriangles = (GRID - 1) * (GRID - 1) * 2;

	#device: GPUDevice;
	#layout: GPUBindGroupLayout;
	/** height pages, one unit each */
	#heights: GrowableBuffer;
	/** the heights buffer version {@link #bindGroup} binds */
	#heightsVersion = -1;
	#albedo: GPUTexture;
	#normal: GPUTexture;
	#freeSurfaceSlots: number[] = [];
	#surfaceBytes: number;
	#surfaceSampler: GPUSampler;
	#detailControl: GPUTexture;
	#detailTint: GPUTexture;
	#detailIndex: GPUBuffer;
	#freeDetailSlots: number[] = [];
	#detailBytes: number;
	/** the package's layer textures, params and how many of the textures have arrived */
	#layers: {
		info: TerrainSplatInfo;
		diffuse: GPUTexture;
		normal: GPUTexture;
		params: GPUBuffer;
		/** layer blob → which arrays and layers it fills (identical textures share a blob) */
		targets: Map<number, { texture: GPUTexture; layer: number }[]>;
		uploaded: Set<number>;
	} | null = null;
	#layerSampler: GPUSampler;
	#patches: GPUBuffer;
	#patchCapacity: number;
	#patchData: Float32Array;
	#patchWords: Uint32Array;
	#fillIndices: GPUBuffer;
	#wireIndices: GPUBuffer;
	#fillCount: number;
	#wireCount: number;
	#bindGroup: GPUBindGroup;
	#pipelines: PipelineCache;
	#fillKey: string;
	#wireKey: string;

	/**
	 * @param device the device
	 * @param layouts shared layouts
	 * @param pipelines pipeline cache
	 * @param format the main pass's targets
	 * @param options `capacity`: height page slots the pool can grow to; `bc`: whether the device has BC
	 *   textures, without which surface pages aren't drawn
	 */
	constructor(
		device: GPUDevice,
		layouts: BindLayouts,
		pipelines: PipelineCache,
		format: MainPassFormat,
		options: { capacity: number; bc: boolean },
	) {
		this.#device = device;
		this.#pipelines = pipelines;
		this.surfaces = options.bc;
		this.#heights = new GrowableBuffer(device, {
			label: 'terrain heights',
			unitBytes: PAGE_BYTES,
			initialUnits: INITIAL_HEIGHT_SLOTS,
			maxUnits: options.capacity,
			usage: GPUBufferUsage.STORAGE,
		});
		// without BC the arrays are 1-layer placeholders, so the bind group stays valid
		const surfaceSlots = this.surfaces ? Math.min(SURFACE_SLOTS, device.limits.maxTextureArrayLayers) : 0;
		for (let slot = surfaceSlots - 1; slot >= 0; slot--) {
			this.#freeSurfaceSlots.push(slot);
		}
		const surfaceTexture = (label: string): GPUTexture =>
			device.createTexture({
				label,
				size: this.surfaces ? [SURFACE_SIDE, SURFACE_SIDE, surfaceSlots] : [4, 4, 1],
				format: this.surfaces ? SURFACE_FORMAT : 'rgba8unorm',
				dimension: '2d',
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
			});
		this.#albedo = surfaceTexture('terrain albedo pages');
		this.#normal = surfaceTexture('terrain normal pages');
		this.#surfaceBytes = this.surfaces ? surfaceSlots * SURFACE_IMAGE_BYTES * 2 : 0;
		this.#surfaceSampler = device.createSampler({
			label: 'terrain surface',
			magFilter: 'linear',
			minFilter: 'linear',
		});
		this.#layerSampler = device.createSampler({
			label: 'terrain layers',
			addressModeU: 'repeat',
			addressModeV: 'repeat',
			magFilter: 'linear',
			minFilter: 'linear',
			mipmapFilter: 'linear',
			maxAnisotropy: 8,
		});

		// splat pages need BC for the tint and the layer textures; without it the pool stays empty
		const detailSlots = this.surfaces ? Math.min(DETAIL_SLOTS, device.limits.maxTextureArrayLayers) : 0;
		for (let slot = detailSlots - 1; slot >= 0; slot--) {
			this.#freeDetailSlots.push(slot);
		}
		this.#detailControl = device.createTexture({
			label: 'terrain splat control',
			size: this.surfaces ? [SURFACE_SIDE, SURFACE_SIDE, detailSlots] : [4, 4, 1],
			format: 'rgba8unorm',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		this.#detailTint = device.createTexture({
			label: 'terrain splat tint',
			size: this.surfaces ? [SURFACE_SIDE, SURFACE_SIDE, detailSlots] : [4, 4, 1],
			format: this.surfaces ? 'bc3-rgba-unorm-srgb' : 'rgba8unorm',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		this.#detailIndex = device.createBuffer({
			label: 'terrain splat index',
			size: Math.max(1, detailSlots) * DETAIL_CELLS * DETAIL_CELLS * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#detailBytes = detailSlots * (SURFACE_SIDE * SURFACE_SIDE * 4 + SURFACE_IMAGE_BYTES);
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
		this.#layout = layouts.terrain;
		this.#bindGroup = this.#createBindGroup();

		const module = pipelines.module('terrain', FRAME_WGSL + terrainWgsl);
		const constants = { SIDE: PAGE_SIDE };
		this.#fillKey = 'terrain/fill';
		this.#wireKey = 'terrain/wire';
		const describe = (lines: boolean): GPURenderPipelineDescriptor => ({
			layout: layouts.terrainPipeline,
			vertex: { module, entryPoint: 'vs_main', constants },
			fragment: {
				module,
				entryPoint: lines ? 'fs_wire' : 'fs_main',
				targets: format.targets,
			},
			primitive: lines
				? { topology: 'line-list' }
				: { topology: 'triangle-list', frontFace: 'cw', cullMode: 'back' },
			depthStencil: {
				format: format.depth,
				depthWriteEnabled: !lines,
				depthCompare: lines ? 'greater-equal' : DEPTH_COMPARE,
			},
		});
		void pipelines.prepare(this.#fillKey, () => describe(false));
		void pipelines.prepare(this.#wireKey, () => describe(true));
		void pipelines.prepare(SHADOW_KEY, () => ({
			layout: layouts.terrainPipeline,
			vertex: { module, entryPoint: 'vs_main', constants },
			fragment: { module, entryPoint: 'fs_shadow', targets: [] },
			primitive: { topology: 'triangle-list' },
			depthStencil: SHADOW_DEPTH_STATE,
		}));
	}

	#createBindGroup(): GPUBindGroup {
		const device = this.#device;
		const layers = this.#layers ?? this.#placeholderLayers();
		this.#heightsVersion = this.#heights.version;
		return device.createBindGroup({
			label: 'terrain',
			layout: this.#layout,
			entries: [
				{ binding: 0, resource: { buffer: this.#heights.buffer } },
				{ binding: 1, resource: { buffer: this.#patches } },
				{ binding: 2, resource: array(this.#albedo) },
				{ binding: 3, resource: array(this.#normal) },
				{ binding: 4, resource: this.#surfaceSampler },
				{ binding: 5, resource: array(this.#detailControl) },
				{ binding: 6, resource: array(this.#detailTint) },
				{ binding: 7, resource: array(layers.diffuse) },
				{ binding: 8, resource: array(layers.normal) },
				{ binding: 9, resource: { buffer: this.#detailIndex } },
				{ binding: 10, resource: { buffer: layers.params } },
				{ binding: 11, resource: this.#layerSampler },
			],
		});
	}

	#placeholders: { diffuse: GPUTexture; normal: GPUTexture; params: GPUBuffer } | null = null;

	/** 1-layer stand-ins that keep the bind group valid while a package has no layers */
	#placeholderLayers(): { diffuse: GPUTexture; normal: GPUTexture; params: GPUBuffer } {
		if (this.#placeholders === null) {
			const texture = (label: string): GPUTexture =>
				this.#device.createTexture({
					label,
					size: [4, 4, 1],
					format: 'rgba8unorm',
					usage: GPUTextureUsage.TEXTURE_BINDING,
				});
			this.#placeholders = {
				diffuse: texture('no terrain layer diffuse'),
				normal: texture('no terrain layer normal'),
				params: this.#device.createBuffer({
					label: 'no terrain layers',
					size: LAYER_FLOATS * 4,
					usage: GPUBufferUsage.STORAGE,
				}),
			};
		}
		return this.#placeholders;
	}

	/**
	 * sets the package's terrain layers: allocates their texture arrays and uploads their parameters. the
	 * textures arrive through {@link uploadLayer}; detail draws once all have.
	 *
	 * @param info the manifest's detail section, or `null` to drop the current package's layers
	 */
	setSplat(info: TerrainSplatInfo | null): void {
		if (this.#layers !== null) {
			this.#layers.diffuse.destroy();
			this.#layers.normal.destroy();
			this.#layers.params.destroy();
			this.#layers = null;
		}
		if (info !== null && this.surfaces && info.diffuse.length > 0) {
			const count = info.diffuse.length;
			const texture = (label: string, format: GPUTextureFormat): GPUTexture =>
				this.#device.createTexture({
					label,
					size: [info.textureSize, info.textureSize, count],
					mipLevelCount: info.textureLevels,
					format,
					usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
				});
			const diffuse = texture('terrain layer diffuse', 'bc7-rgba-unorm-srgb');
			const normal = texture('terrain layer normal', 'bc7-rgba-unorm');
			const data = new Float32Array(Math.max(1, info.layers.length) * LAYER_FLOATS);
			for (const [i, layer] of info.layers.entries()) {
				data.set(
					[
						layer.tiling,
						layer.offset[0],
						layer.offset[1],
						layer.normalScale,
						...layer.diffuseScale,
						layer.blendBorder,
						...layer.meanColor,
						layer.texture,
						layer.height[0],
						layer.height[1],
						layer.occlusion[0],
						layer.occlusion[1],
						layer.roughness[0],
						layer.roughness[1],
						0,
						0,
					],
					i * LAYER_FLOATS,
				);
			}
			const params = this.#device.createBuffer({
				label: 'terrain layers',
				size: data.byteLength,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			});
			this.#device.queue.writeBuffer(params, 0, data);
			const targets = new Map<number, { texture: GPUTexture; layer: number }[]>();
			const target = (blob: number, into: GPUTexture, layer: number): void => {
				const list = targets.get(blob) ?? [];
				list.push({ texture: into, layer });
				targets.set(blob, list);
			};
			for (let i = 0; i < count; i++) {
				target(info.diffuse[i], diffuse, i);
				target(info.normal[i], normal, i);
			}
			this.#layers = { info, diffuse, normal, params, targets, uploaded: new Set() };
		}
		this.#bindGroup = this.#createBindGroup();
	}

	/**
	 * uploads one layer texture into its array layer
	 *
	 * @param blob the layer blob, one of those {@link setSplat} named
	 * @param decoded its levels
	 * @returns the residency
	 * @throws {Error} if the blob isn't one of the package's layer textures or has the wrong size
	 */
	uploadLayer(blob: number, decoded: DecodedLayer): ResidentLayer {
		const layers = this.#layers;
		const targets = layers?.targets.get(blob);
		if (layers === null || targets === undefined) {
			throw new Error(`blob ${blob} isn't a terrain layer texture of this package`);
		}
		const { textureSize, textureLevels } = layers.info;
		let bytes = 0;
		for (const target of targets) {
			let offset = 0;
			for (let level = 0; level < textureLevels; level++) {
				const size = Math.max(1, textureSize >> level);
				const blocks = Math.ceil(size / 4);
				const levelBytes = bc7LevelBytes(size);
				if (offset + levelBytes > decoded.data.byteLength) {
					throw new Error(`terrain layer blob ${blob} is shorter than its ${textureLevels} levels`);
				}
				this.#device.queue.writeTexture(
					{ texture: target.texture, mipLevel: level, origin: [0, 0, target.layer] },
					decoded.data,
					{ offset, bytesPerRow: blocks * 16, rowsPerImage: blocks },
					[blocks * 4, blocks * 4, 1],
				);
				offset += levelBytes;
			}
			bytes += offset;
		}
		layers.uploaded.add(blob);
		return { kind: 'layer', bytes };
	}

	/** whether every layer texture has arrived, so detail can draw */
	get #layersReady(): boolean {
		return this.#layers !== null && this.#layers.uploaded.size === this.#layers.targets.size;
	}

	/**
	 * uploads a splat page into a free slot
	 *
	 * @param decoded the page
	 * @returns the residency, or `null` if no slot was free (always, without BC textures)
	 * @throws {Error} if the page doesn't have the sizes the shader is written for
	 */
	uploadDetail(decoded: DecodedDetail): ResidentDetail | null {
		if (decoded.side !== SURFACE_SIDE || decoded.cells !== DETAIL_CELLS) {
			throw new Error(`splat page of ${decoded.side}² with ${decoded.cells}² cells isn't supported`);
		}
		const slot = this.#freeDetailSlots.pop();
		if (slot === undefined) {
			return null;
		}
		const queue = this.#device.queue;
		const size = [SURFACE_SIDE, SURFACE_SIDE, 1];
		queue.writeTexture(
			{ texture: this.#detailControl, origin: [0, 0, slot] },
			decoded.control,
			{ bytesPerRow: SURFACE_SIDE * 4, rowsPerImage: SURFACE_SIDE },
			size,
		);
		queue.writeTexture(
			{ texture: this.#detailTint, origin: [0, 0, slot] },
			decoded.tint,
			{ bytesPerRow: (SURFACE_SIDE / 4) * 16, rowsPerImage: SURFACE_SIDE / 4 },
			size,
		);
		queue.writeBuffer(this.#detailIndex, slot * DETAIL_CELLS * DETAIL_CELLS * 4, decoded.index);
		return {
			kind: 'splat',
			bytes: SURFACE_SIDE * SURFACE_SIDE * 4 + SURFACE_IMAGE_BYTES + decoded.index.byteLength,
			slot,
		};
	}

	/** @param resident a page from {@link uploadDetail}; its slot returns to the pool */
	releaseSplat(resident: ResidentDetail): void {
		this.#freeDetailSlots.push(resident.slot);
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
		return this.#heights.bytes + this.#patchData.byteLength + this.#surfaceBytes + this.#detailBytes;
	}

	/**
	 * uploads a height page into a free slot, growing the pool if needed.
	 *
	 * @param decoded the page
	 * @param options `keepSamples` keeps the samples on the CPU, for ground-height queries
	 * @returns the residency, or `null` if the pool is full at its largest
	 * @throws {Error} if the page isn't {@link PAGE_SIDE} samples across
	 */
	upload(decoded: DecodedHeights, options: { keepSamples: boolean }): ResidentHeights | null {
		if (decoded.side !== PAGE_SIDE) {
			throw new Error(`height page side ${decoded.side} isn't ${PAGE_SIDE}`);
		}
		const slot = this.#heights.allocate(1)?.start;
		if (slot === undefined) {
			return null;
		}
		this.#device.queue.writeBuffer(this.#heights.buffer, slot * PAGE_BYTES, decoded.samples);
		return {
			kind: 'heights',
			bytes: PAGE_BYTES,
			slot,
			samples: options.keepSamples ? decoded.samples : null,
		};
	}

	/** @param resident a page from {@link upload}; its slot returns to the pool */
	release(resident: ResidentHeights): void {
		this.#heights.free({ start: resident.slot, count: 1 });
	}

	/**
	 * uploads a surface page into a free layer.
	 *
	 * @param decoded the page
	 * @returns the residency, or `null` if no layer was free (always, without BC textures)
	 * @throws {Error} if the page isn't {@link SURFACE_SIDE} texels across
	 */
	uploadSurface(decoded: DecodedSurface): ResidentSurface | null {
		if (decoded.side !== SURFACE_SIDE) {
			throw new Error(`surface page side ${decoded.side} isn't ${SURFACE_SIDE}`);
		}
		const slot = this.#freeSurfaceSlots.pop();
		if (slot === undefined) {
			return null;
		}
		const layout = { bytesPerRow: (SURFACE_SIDE / 4) * 16, rowsPerImage: SURFACE_SIDE / 4 };
		const size = [SURFACE_SIDE, SURFACE_SIDE, 1];
		this.#device.queue.writeTexture(
			{ texture: this.#albedo, origin: [0, 0, slot] },
			decoded.albedo,
			layout,
			size,
		);
		this.#device.queue.writeTexture(
			{ texture: this.#normal, origin: [0, 0, slot] },
			decoded.normal,
			layout,
			size,
		);
		return { kind: 'surface', bytes: SURFACE_IMAGE_BYTES * 2, slot };
	}

	/** @param resident a page from {@link uploadSurface}; its layer returns to the pool */
	releaseSurface(resident: ResidentSurface): void {
		this.#freeSurfaceSlots.push(resident.slot);
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
		const layersReady = this.#layersReady;
		for (let i = 0; i < count; i++) {
			const { item, node, quadrant, morphStart, morphEnd, surface, detail } = patches[i];
			const at = i * PATCH_FLOATS;
			data[at] = node.minX - eye[0];
			data[at + 1] = node.minZ - eye[2];
			data[at + 2] = node.size / QUADS;
			data[at + 3] = node.level;
			words[at + 4] = item.resident?.kind === 'heights' ? item.resident.slot : 0;
			words[at + 5] = quadrant < 0 ? 0 : (quadrant & 1) * (GRID - 1);
			words[at + 6] = quadrant < 0 ? 0 : (quadrant >> 1) * (GRID - 1);
			const page = surface?.item.resident;
			words[at + 7] = page?.kind === 'surface' ? page.slot + 1 : 0;
			data[at + 8] = Number.isFinite(morphStart) ? morphStart : 0;
			data[at + 9] = Number.isFinite(morphEnd) ? morphEnd : 0;
			data[at + 10] = 0;
			data[at + 11] = 0;
			// the page's uv is affine in world x, z: `(rel.xz − corner) · scale + border`
			const covered = surface?.node ?? node;
			data[at + 12] = covered.minX - eye[0];
			data[at + 13] = covered.minZ - eye[2];
			data[at + 14] = (SURFACE_SIDE - 2 * SURFACE_BORDER) / SURFACE_SIDE / covered.size;
			data[at + 15] = SURFACE_BORDER / SURFACE_SIDE;
			// layer uvs need world position: the node's corner (whole metres, exact in f32) and the eye's height
			const splatPage = layersReady ? detail?.resident : undefined;
			data[at + 16] = node.minX;
			data[at + 17] = node.minZ;
			data[at + 18] = eye[1];
			words[at + 19] = splatPage?.kind === 'splat' ? splatPage.slot + 1 : 0;
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
	 * draws the terrain into a shadow cascade.
	 *
	 * @param pass a shadow pass, with group 0 bound
	 * @returns draw calls issued
	 */
	encodeShadow(pass: GPURenderPassEncoder): number {
		return this.#encode(pass, SHADOW_KEY, this.#fillIndices, this.#fillCount);
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
		if (this.#heightsVersion !== this.#heights.version) {
			this.#bindGroup = this.#createBindGroup();
		}
		pass.setPipeline(pipeline);
		pass.setBindGroup(1, this.#bindGroup);
		pass.setIndexBuffer(indices, 'uint16');
		pass.drawIndexed(indexCount, this.patchCount);
		return 1;
	}
}
