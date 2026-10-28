/**
 * geometry residency and the mesh family: each geometry gets one vertex buffer (quantized positions,
 * octahedral normals, UV set 0) and one index buffer; each mesh bucket is one instanced `drawIndexed` over
 * its slice of the visible list. per-draw parameters (dequantization, colour, alpha test, UV transform) sit
 * in a storage array indexed through a per-list-entry draw id, and the material's base colour texture is in
 * group 3 (a white texture until the texture streams in). draws are sorted by geometry, then material, so
 * runs of draws share their bindings.
 *
 * @module
 */

import type { BindLayouts } from '../gfx/bind-layouts.ts';
import type { PipelineCache } from '../gfx/pipeline-cache.ts';
import { DEPTH_COMPARE, DEPTH_FORMAT } from '../gfx/render-targets.ts';
import type { DecodedGeometry } from '../package/decode-protocol.ts';
import type { MeshBucket } from '../streaming/mesh-selection.ts';
import type { ResidentGeometry } from '../streaming/stream-manager.ts';

import { FRAME_WGSL } from './frame-uniforms.ts';
import { LIST_CAPACITY } from './instance-renderer.ts';
import { LOOK_FLOATS } from './materials.ts';
import meshWgsl from './shaders/mesh.wgsl?raw';
import type { TextureBinding, TextureStore } from './texture-store.ts';

/** floats of `Draw` in mesh.wgsl: dequantization offset and scale, then the material look */
const DRAW_FLOATS = 8 + LOOK_FLOATS;
/** draws per frame at most; buckets past it aren't drawn */
const MAX_DRAWS = 16_384;

interface PreparedDraw {
	geometry: ResidentGeometry;
	indexCount: number;
	firstIndex: number;
	baseVertex: number;
	first: number;
	count: number;
	material: GPUBindGroup;
}

interface MaterialBinding {
	version: number;
	group: GPUBindGroup;
}

/** draw order: geometry, then material, then submesh */
const byBindings = (a: MeshBucket, b: MeshBucket): number =>
	a.geometry.blob - b.geometry.blob || a.material - b.material || a.submesh - b.submesh;

/** owns geometry buffers, material bind groups and the mesh pipeline */
export class MeshRenderer {
	/** mesh instances last frame */
	instanceCount = 0;
	/** mesh triangles last frame */
	triangles = 0;
	/** draws whose base colour texture was bound */
	texturedDraws = 0;

	#device: GPUDevice;
	#layouts: BindLayouts;
	#pipelines: PipelineCache;
	#key: string;
	#instances: GPUBindGroup;
	#params: GPUBuffer;
	#paramData = new Float32Array(MAX_DRAWS * DRAW_FLOATS);
	#drawIds: GPUBuffer;
	#drawIdData = new Uint32Array(LIST_CAPACITY);
	#drawGroup: GPUBindGroup;
	/** zeros bound as the normal/UV streams of meshes without them */
	#zeros: GPUBuffer;
	#zerosSize = 0;
	#white: GPUBindGroup;
	/** material bind groups by texture id */
	#bindings = new Map<number, MaterialBinding>();
	#order: MeshBucket[] = [];
	/** prepared draws; entries past {@link #drawCount} are reused next frame */
	#draws: PreparedDraw[] = [];
	#drawCount = 0;

	/**
	 * @param device the device
	 * @param layouts shared layouts
	 * @param pipelines pipeline cache
	 * @param instances group 1: instance rows, block origins and the visible list
	 * @param targets color format and sample count of the main pass
	 */
	constructor(
		device: GPUDevice,
		layouts: BindLayouts,
		pipelines: PipelineCache,
		instances: GPUBindGroup,
		targets: { colorFormat: GPUTextureFormat; sampleCount: number },
	) {
		this.#device = device;
		this.#layouts = layouts;
		this.#pipelines = pipelines;
		this.#instances = instances;
		this.#zeros = this.#zeroBuffer(8 * 65_536);
		this.#params = device.createBuffer({
			label: 'mesh draws',
			size: this.#paramData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#drawIds = device.createBuffer({
			label: 'mesh draw ids',
			size: this.#drawIdData.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		this.#drawGroup = device.createBindGroup({
			label: 'mesh draws',
			layout: layouts.draw,
			entries: [
				{ binding: 0, resource: { buffer: this.#params } },
				{ binding: 1, resource: { buffer: this.#drawIds } },
			],
		});
		const white = device.createTexture({
			label: 'white',
			size: [1, 1],
			format: 'rgba8unorm',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
		});
		device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), {}, [1, 1]);
		this.#white = device.createBindGroup({
			label: 'white material',
			layout: layouts.materials,
			entries: [
				{ binding: 0, resource: white.createView() },
				{ binding: 1, resource: device.createSampler() },
			],
		});
		const module = pipelines.module('mesh', FRAME_WGSL + meshWgsl);
		this.#key = `mesh/fill/${targets.colorFormat}/x${targets.sampleCount}`;
		void pipelines.prepare(this.#key, () => ({
			layout: layouts.meshPipeline,
			vertex: {
				module,
				entryPoint: 'vs_main',
				buffers: [
					{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'unorm16x4' }] },
					{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: 'snorm16x2' }] },
					{ arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
				],
			},
			fragment: { module, entryPoint: 'fs_main', targets: [{ format: targets.colorFormat }] },
			// instances may be mirrored (negative determinant), which flips winding per instance
			primitive: { topology: 'triangle-list', cullMode: 'none' },
			depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: DEPTH_COMPARE },
			multisample: { count: targets.sampleCount },
		}));
	}

	#zeroBuffer(size: number): GPUBuffer {
		this.#zerosSize = size;
		return this.#device.createBuffer({ label: 'zero streams', size, usage: GPUBufferUsage.VERTEX });
	}

	/**
	 * uploads a decoded geometry.
	 *
	 * @param blob the geometry's blob, for labels
	 * @param decoded vertex streams and indices
	 * @returns the residency (geometry buffers aren't pooled; the memory budget bounds them)
	 */
	upload(blob: number, decoded: DecodedGeometry): ResidentGeometry {
		const positionBytes = decoded.positions.byteLength;
		const normalBytes = decoded.normals?.byteLength ?? 0;
		const uvBytes = decoded.uvs?.byteLength ?? 0;
		const vertices = this.#device.createBuffer({
			label: `geometry ${blob}`,
			size: Math.max(4, positionBytes + normalBytes + uvBytes),
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
		});
		this.#device.queue.writeBuffer(vertices, 0, decoded.positions);
		if (decoded.normals !== null) {
			this.#device.queue.writeBuffer(vertices, positionBytes, decoded.normals);
		}
		if (decoded.uvs !== null) {
			this.#device.queue.writeBuffer(vertices, positionBytes + normalBytes, decoded.uvs);
		}
		if ((decoded.normals === null || decoded.uvs === null) && decoded.vertexCount * 8 > this.#zerosSize) {
			this.#zeros.destroy();
			this.#zeros = this.#zeroBuffer(decoded.vertexCount * 8);
		}
		const indices = this.#device.createBuffer({
			label: `geometry ${blob} indices`,
			size: Math.max(4, decoded.indices.byteLength),
			usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
		});
		this.#device.queue.writeBuffer(indices, 0, decoded.indices);
		return {
			kind: 'geometry',
			bytes: vertices.size + indices.size,
			vertices,
			positionBytes,
			normalOffset: decoded.normals === null ? null : positionBytes,
			uvOffset: decoded.uvs === null ? null : positionBytes + normalBytes,
			indices,
			indexFormat: decoded.indexSize === 4 ? 'uint32' : 'uint16',
			positionOffset: decoded.positionOffset,
			positionScale: decoded.positionScale,
			submeshes: decoded.submeshes,
		};
	}

	/** @param resident a geometry from {@link upload}; its buffers are destroyed */
	release(resident: ResidentGeometry): void {
		resident.vertices.destroy();
		resident.indices.destroy();
	}

	/** forgets material bind groups (when a package is unloaded) */
	releaseMaterials(): void {
		this.#bindings.clear();
	}

	#materialGroup(texture: number, binding: TextureBinding): GPUBindGroup {
		const cached = this.#bindings.get(texture);
		if (cached?.version === binding.version) {
			return cached.group;
		}
		const group = this.#device.createBindGroup({
			label: `texture ${texture}`,
			layout: this.#layouts.materials,
			entries: [
				{ binding: 0, resource: binding.view },
				{ binding: 1, resource: binding.sampler },
			],
		});
		this.#bindings.set(texture, { version: binding.version, group });
		return group;
	}

	/** draws nothing this frame */
	clear(): void {
		this.#drawCount = 0;
		this.instanceCount = 0;
		this.triangles = 0;
		this.texturedDraws = 0;
	}

	/**
	 * writes this frame's draw parameters.
	 *
	 * @param buckets this frame's mesh buckets, placed in the visible list by `InstanceRenderer.prepareList`
	 * @param textures the package's textures
	 */
	prepare(buckets: readonly MeshBucket[], textures: TextureStore): void {
		this.clear();
		const order = this.#order;
		order.length = 0;
		for (const bucket of buckets) {
			if (bucket.count > 0 && bucket.geometry.resident?.kind === 'geometry') {
				order.push(bucket);
			}
		}
		order.sort(byBindings);

		const params = this.#paramData;
		const ids = this.#drawIdData;
		let listStart = LIST_CAPACITY;
		let listEnd = 0;
		let d = 0;
		for (const bucket of order) {
			const resident = bucket.geometry.resident;
			const range = resident?.kind === 'geometry' ? resident.submeshes[bucket.submesh] : undefined;
			if (resident?.kind !== 'geometry' || range === undefined || d >= MAX_DRAWS) {
				continue;
			}
			const look = bucket.look;
			const binding = look.texture < 0 ? null : textures.binding(look.texture);
			const at = d * DRAW_FLOATS;
			params.set(resident.positionOffset, at);
			params[at + 3] = binding === null ? 0 : 1;
			params.set(resident.positionScale, at + 4);
			params[at + 7] = 0;
			params.set(binding === null ? look.untextured : look.textured, at + 8);
			ids.fill(d, bucket.first, bucket.first + bucket.count);
			listStart = Math.min(listStart, bucket.first);
			listEnd = Math.max(listEnd, bucket.first + bucket.count);

			let draw = this.#draws[d];
			if (draw === undefined) {
				draw = {
					geometry: resident,
					indexCount: 0,
					firstIndex: 0,
					baseVertex: 0,
					first: 0,
					count: 0,
					material: this.#white,
				};
				this.#draws[d] = draw;
			}
			draw.geometry = resident;
			draw.indexCount = range.indexCount;
			draw.firstIndex = range.firstIndex;
			draw.baseVertex = range.baseVertex;
			draw.first = bucket.first;
			draw.count = bucket.count;
			draw.material = binding === null ? this.#white : this.#materialGroup(look.texture, binding);
			d++;

			this.instanceCount += bucket.count;
			this.triangles += (bucket.count * range.indexCount) / 3;
			if (binding !== null) {
				this.texturedDraws++;
			}
		}
		this.#drawCount = d;
		if (d > 0) {
			const queue = this.#device.queue;
			queue.writeBuffer(this.#params, 0, params, 0, d * DRAW_FLOATS);
			queue.writeBuffer(this.#drawIds, listStart * 4, ids, listStart, listEnd - listStart);
		}
	}

	/**
	 * @param pass the main pass, with group 0 bound
	 * @returns draw calls issued
	 */
	encode(pass: GPURenderPassEncoder): number {
		const pipeline = this.#pipelines.get(this.#key);
		if (pipeline === undefined || this.#drawCount === 0) {
			return 0;
		}
		pass.setPipeline(pipeline);
		pass.setBindGroup(1, this.#instances);
		pass.setBindGroup(2, this.#drawGroup);
		let geometry: ResidentGeometry | null = null;
		let material: GPUBindGroup | null = null;
		for (let i = 0; i < this.#drawCount; i++) {
			const draw = this.#draws[i];
			if (draw.material !== material) {
				material = draw.material;
				pass.setBindGroup(3, material);
			}
			if (draw.geometry !== geometry) {
				geometry = draw.geometry;
				pass.setVertexBuffer(0, geometry.vertices, 0, geometry.positionBytes);
				if (geometry.normalOffset === null) {
					pass.setVertexBuffer(1, this.#zeros);
				} else {
					pass.setVertexBuffer(1, geometry.vertices, geometry.normalOffset);
				}
				if (geometry.uvOffset === null) {
					pass.setVertexBuffer(2, this.#zeros);
				} else {
					pass.setVertexBuffer(2, geometry.vertices, geometry.uvOffset);
				}
				pass.setIndexBuffer(geometry.indices, geometry.indexFormat);
			}
			pass.drawIndexed(draw.indexCount, draw.count, draw.firstIndex, draw.baseVertex, draw.first);
		}
		return this.#drawCount;
	}
}
