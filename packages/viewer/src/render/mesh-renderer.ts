/**
 * geometry residency and the mesh family: each geometry gets one vertex buffer (quantized positions,
 * octahedral normals, UV set 0, tangents) and one index buffer; each mesh bucket is one instanced
 * `drawIndexed` over its slice of the visible list. per-draw parameters (dequantization, the material look)
 * sit in a storage array indexed through a per-list-entry draw id, and the material's textures are in group 3
 * (a white texture for slots whose texture hasn't streamed in, with the slot's flag cleared). opaque draws
 * come before alpha-tested ones, which each pass draws with its own pipelines (see mesh.wgsl for why); within
 * each, draws are sorted by geometry, then material, so runs of draws share their bindings.
 *
 * @module
 */

import type { BindLayouts } from '../gfx/bind-layouts.ts';
import type { PipelineCache } from '../gfx/pipeline-cache.ts';
import { DEPTH_COMPARE, DEPTH_FORMAT, type MainPassFormat } from '../gfx/render-targets.ts';
import type { DecodedGeometry } from '../package/decode-protocol.ts';
import type { MeshBucket } from '../streaming/mesh-selection.ts';
import type { ResidentGeometry } from '../streaming/stream-manager.ts';

import { FRAME_WGSL } from './frame-uniforms.ts';
import { LIST_CAPACITY } from './instance-renderer.ts';
import { LOOK_FLOATS, SLOTS, SLOT_FLAGS } from './materials.ts';
import meshWgsl from './shaders/mesh.wgsl?raw';
import { SHADOW_DEPTH_STATE } from './shadow-map.ts';
import type { TextureBinding, TextureStore } from './texture-store.ts';

/** floats of `Draw` in mesh.wgsl: dequantization offset and scale, then the material look */
const DRAW_FLOATS = 8 + LOOK_FLOATS;
/** draws per frame at most; buckets past it aren't drawn */
const MAX_DRAWS = 16_384;
/** bytes per vertex of the zero buffer bound in place of missing streams (the widest is UV set 0) */
const ZERO_STRIDE = 8;
/**
 * draw flags of the geometry, next to the material's `LookFlags` (`HAS_*` in mesh.wgsl). the shader can't
 * tell a missing stream from its values: the zero buffer bound in its place reads as an octahedral (0, 0),
 * which is +z
 */
const GeometryFlags = {
	HasNormals: 1 << 9,
	HasTangents: 1 << 10,
} as const;

/** the face culling a draw's pipeline uses; each phase has a pipeline per value */
const FACE_CULLS = ['none', 'back', 'front'] as const satisfies readonly GPUCullMode[];
type FaceCull = (typeof FACE_CULLS)[number];

/**
 * the winding of front faces of unmirrored instances, as the game's meshes reach the rasterizer through
 * `view_proj` (Unity's left-handed, clockwise-front convention, like the terrain's)
 */
const FRONT_FACE: GPUFrontFace = 'cw';

/** @returns the faces a bucket's draws cull: the material's, swapped for mirrored instances */
const faceCullOf = (bucket: MeshBucket): FaceCull => {
	switch (bucket.look.cull) {
		case 'none': {
			return 'none';
		}
		case 'back': {
			return bucket.mirrored ? 'front' : 'back';
		}
		case 'front': {
			return bucket.mirrored ? 'back' : 'front';
		}
	}
};

/** one run over a pass's opaque or alpha-tested draws, with a pipeline per face culling */
interface DrawPhase {
	key: string;
	/** over the alpha-tested draws, else the opaque ones */
	cutout: boolean;
	/** whether the pipeline reads the material's textures; if not, any material group will do */
	textured: boolean;
}

const SHADOW_PHASES: readonly DrawPhase[] = [
	{ key: 'mesh/shadow/opaque', cutout: false, textured: false },
	{ key: 'mesh/shadow/cutout', cutout: true, textured: true },
];

interface PreparedDraw {
	geometry: ResidentGeometry;
	indexCount: number;
	firstIndex: number;
	baseVertex: number;
	first: number;
	count: number;
	material: GPUBindGroup;
	cull: FaceCull;
}

interface MaterialBinding {
	/** the slot bindings' versions the group was built from (-1 for the fallback) */
	versions: number[];
	group: GPUBindGroup;
}

/**
 * draw order within the opaque and the alpha-tested draws: face culling (one pipeline each), then geometry,
 * material and submesh
 */
const byBindings = (a: MeshBucket, b: MeshBucket): number =>
	FACE_CULLS.indexOf(faceCullOf(a)) - FACE_CULLS.indexOf(faceCullOf(b)) ||
	a.geometry.blob - b.geometry.blob ||
	a.material - b.material ||
	a.submesh - b.submesh;

/** owns geometry buffers, material bind groups and the mesh pipelines */
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
	#mainPhases: readonly DrawPhase[];
	#instances: GPUBindGroup;
	#params: GPUBuffer;
	#paramData = new Float32Array(MAX_DRAWS * DRAW_FLOATS);
	#paramWords = new Uint32Array(this.#paramData.buffer);
	#drawIds: GPUBuffer;
	#drawIdData = new Uint32Array(LIST_CAPACITY);
	#drawGroup: GPUBindGroup;
	/** zeros bound as the streams meshes lack */
	#zeros: GPUBuffer;
	#zerosSize = 0;
	#white: GPUTextureView;
	#defaultSampler: GPUSampler;
	/** material bind groups by material id */
	#bindings = new Map<number, MaterialBinding>();
	#slotBindings: (TextureBinding | null)[] = [null, null, null, null];
	#versions: number[] = [-1, -1, -1, -1];
	#opaqueOrder: MeshBucket[] = [];
	#cutoutOrder: MeshBucket[] = [];
	/** prepared draws, opaque ones first; entries past {@link #drawCount} are reused next frame */
	#draws: PreparedDraw[] = [];
	#drawCount = 0;
	/** index of the first alpha-tested draw */
	#cutoutStart = 0;

	/**
	 * @param device the device
	 * @param layouts shared layouts
	 * @param pipelines pipeline cache
	 * @param instances group 1: instance rows, block origins and the visible list
	 * @param format the main pass's targets
	 */
	constructor(
		device: GPUDevice,
		layouts: BindLayouts,
		pipelines: PipelineCache,
		instances: GPUBindGroup,
		format: MainPassFormat,
	) {
		this.#device = device;
		this.#layouts = layouts;
		this.#pipelines = pipelines;
		this.#instances = instances;
		this.#zeros = this.#zeroBuffer(ZERO_STRIDE * 65_536);
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
		this.#white = white.createView();
		this.#defaultSampler = device.createSampler({
			label: 'material default',
			addressModeU: 'repeat',
			addressModeV: 'repeat',
			magFilter: 'linear',
			minFilter: 'linear',
			mipmapFilter: 'linear',
		});
		const module = pipelines.module('mesh', FRAME_WGSL + meshWgsl);
		const vertex: GPUVertexState = {
			module,
			entryPoint: 'vs_main',
			buffers: [
				{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'unorm16x4' }] },
				{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: 'snorm16x2' }] },
				{ arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
				{ arrayStride: 4, attributes: [{ shaderLocation: 3, offset: 0, format: 'snorm8x4' }] },
			],
		};
		const prepare = (
			key: string,
			stages: Pick<GPURenderPipelineDescriptor, 'fragment' | 'depthStencil' | 'multisample'>,
		): void => {
			for (const cullMode of FACE_CULLS) {
				void pipelines.prepare(`${key}/${cullMode}`, () => ({
					layout: layouts.meshPipeline,
					vertex,
					primitive: { topology: 'triangle-list', frontFace: FRONT_FACE, cullMode },
					...stages,
				}));
			}
		};
		const samples = format.sampleCount;
		const multisample: GPUMultisampleState = { count: samples };
		const depthWrite: GPUDepthStencilState = {
			format: DEPTH_FORMAT,
			depthWriteEnabled: true,
			depthCompare: DEPTH_COMPARE,
		};
		const shade: GPUFragmentState = { module, entryPoint: 'fs_opaque', targets: format.targets };
		this.#mainPhases = [
			{ key: `mesh/opaque/x${samples}`, cutout: false, textured: true },
			{ key: `mesh/cutout-depth/x${samples}`, cutout: true, textured: true },
			{ key: `mesh/cutout-shade/x${samples}`, cutout: true, textured: true },
		];
		const [opaque, cutoutDepth, cutoutShade] = this.#mainPhases;
		prepare(opaque.key, { fragment: shade, depthStencil: depthWrite, multisample });
		prepare(cutoutDepth.key, {
			fragment: {
				module,
				entryPoint: 'fs_cutout_depth',
				targets: format.targets.map((target) => ({ ...target, writeMask: 0 })),
			},
			depthStencil: depthWrite,
			multisample,
		});
		prepare(cutoutShade.key, {
			fragment: shade,
			depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'equal' },
			multisample,
		});
		const [shadowOpaque, shadowCutout] = SHADOW_PHASES;
		prepare(shadowOpaque.key, { depthStencil: SHADOW_DEPTH_STATE });
		prepare(shadowCutout.key, {
			fragment: { module, entryPoint: 'fs_cutout_depth', targets: [] },
			depthStencil: SHADOW_DEPTH_STATE,
		});
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
		const streams = [decoded.positions, decoded.normals, decoded.uvs, decoded.tangents];
		const offsets: (number | null)[] = [];
		let size = 0;
		for (const stream of streams) {
			offsets.push(stream === null ? null : size);
			size += stream?.byteLength ?? 0;
		}
		const vertices = this.#device.createBuffer({
			label: `geometry ${blob}`,
			size: Math.max(4, size),
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
		});
		streams.forEach((stream, i) => {
			const offset = offsets[i];
			if (stream !== null && offset !== null) {
				this.#device.queue.writeBuffer(vertices, offset, stream);
			}
		});
		if (streams.includes(null) && decoded.vertexCount * ZERO_STRIDE > this.#zerosSize) {
			this.#zeros.destroy();
			this.#zeros = this.#zeroBuffer(decoded.vertexCount * ZERO_STRIDE);
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
			positionBytes: decoded.positions.byteLength,
			normalOffset: offsets[1],
			uvOffset: offsets[2],
			tangentOffset: offsets[3],
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

	/** the material's bind group over its slots' current bindings (`null` slots get the white texture) */
	#materialGroup(material: number, slots: readonly (TextureBinding | null)[]): GPUBindGroup {
		const versions = this.#versions;
		for (let i = 0; i < slots.length; i++) {
			versions[i] = slots[i]?.version ?? -1;
		}
		const cached = this.#bindings.get(material);
		if (cached !== undefined && cached.versions.every((version, i) => version === versions[i])) {
			return cached.group;
		}
		const detail = slots[1] ?? slots[2] ?? slots[0];
		const group = this.#device.createBindGroup({
			label: `material ${material}`,
			layout: this.#layouts.materials,
			entries: [
				...slots.map((slot, i) => ({ binding: i, resource: slot?.view ?? this.#white })),
				{ binding: 4, resource: slots[0]?.sampler ?? this.#defaultSampler },
				{ binding: 5, resource: detail?.sampler ?? this.#defaultSampler },
			],
		});
		this.#bindings.set(material, { versions: [...versions], group });
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
		const opaque = this.#opaqueOrder;
		const cutout = this.#cutoutOrder;
		opaque.length = 0;
		cutout.length = 0;
		for (const bucket of buckets) {
			if (bucket.count === 0 || bucket.geometry.resident?.kind !== 'geometry') {
				continue;
			}
			// without its base colour there's no alpha to test yet
			const look = bucket.look;
			if (look.cutout && textures.binding(look.textures[0]) !== null) {
				cutout.push(bucket);
			} else {
				opaque.push(bucket);
			}
		}
		opaque.sort(byBindings);
		cutout.sort(byBindings);

		const params = this.#paramData;
		const words = this.#paramWords;
		const ids = this.#drawIdData;
		const slots = this.#slotBindings;
		let listStart = LIST_CAPACITY;
		let listEnd = 0;
		let d = 0;
		for (let b = 0; b < opaque.length + cutout.length; b++) {
			if (b === opaque.length) {
				this.#cutoutStart = d;
			}
			const bucket = b < opaque.length ? opaque[b] : cutout[b - opaque.length];
			const resident = bucket.geometry.resident;
			const range = resident?.kind === 'geometry' ? resident.submeshes[bucket.submesh] : undefined;
			if (resident?.kind !== 'geometry' || range === undefined || d >= MAX_DRAWS) {
				continue;
			}
			const look = bucket.look;
			let flags = look.flags;
			for (let i = 0; i < SLOTS.length; i++) {
				const texture = look.textures[i];
				slots[i] = texture < 0 ? null : textures.binding(texture);
				if (slots[i] === null) {
					flags &= ~SLOT_FLAGS[i];
				}
			}
			const at = d * DRAW_FLOATS;
			params.set(resident.positionOffset, at);
			words[at + 3] =
				flags |
				(resident.normalOffset === null ? 0 : GeometryFlags.HasNormals) |
				(resident.tangentOffset === null ? 0 : GeometryFlags.HasTangents);
			params.set(resident.positionScale, at + 4);
			params[at + 7] = 0;
			params.set(look.params, at + 8);
			ids.fill(d, bucket.first, bucket.first + bucket.count);
			listStart = Math.min(listStart, bucket.first);
			listEnd = Math.max(listEnd, bucket.first + bucket.count);

			const material = this.#materialGroup(bucket.material, slots);
			const cull = faceCullOf(bucket);
			const draw = this.#draws[d];
			if (draw === undefined) {
				this.#draws[d] = {
					geometry: resident,
					indexCount: range.indexCount,
					firstIndex: range.firstIndex,
					baseVertex: range.baseVertex,
					first: bucket.first,
					count: bucket.count,
					material,
					cull,
				};
			} else {
				draw.geometry = resident;
				draw.indexCount = range.indexCount;
				draw.firstIndex = range.firstIndex;
				draw.baseVertex = range.baseVertex;
				draw.first = bucket.first;
				draw.count = bucket.count;
				draw.material = material;
				draw.cull = cull;
			}
			d++;

			this.instanceCount += bucket.count;
			this.triangles += (bucket.count * range.indexCount) / 3;
			if (slots[0] !== null) {
				this.texturedDraws++;
			}
		}
		this.#drawCount = d;
		if (cutout.length === 0) {
			this.#cutoutStart = d;
		}
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
		return this.#encode(pass, this.#mainPhases);
	}

	/**
	 * draws this frame's meshes into a shadow cascade.
	 *
	 * @param pass a shadow pass, with group 0 bound
	 * @returns draw calls issued
	 */
	encodeShadow(pass: GPURenderPassEncoder): number {
		return this.#encode(pass, SHADOW_PHASES);
	}

	/** encodes the phases in order; nothing if any phase's pipeline isn't ready */
	#encode(pass: GPURenderPassEncoder, phases: readonly DrawPhase[]): number {
		if (this.#drawCount === 0) {
			return 0;
		}
		// cutout depth and depth-equal shading must rasterize identically, so nothing draws until every variant
		// is ready
		for (const phase of phases) {
			for (const cull of FACE_CULLS) {
				if (this.#pipelines.get(`${phase.key}/${cull}`) === undefined) {
					return 0;
				}
			}
		}
		pass.setBindGroup(1, this.#instances);
		pass.setBindGroup(2, this.#drawGroup);
		let draws = 0;
		for (const phase of phases) {
			const from = phase.cutout ? this.#cutoutStart : 0;
			const to = phase.cutout ? this.#drawCount : this.#cutoutStart;
			if (from === to) {
				continue;
			}
			let cull: FaceCull | null = null;
			let geometry: ResidentGeometry | null = null;
			let material: GPUBindGroup | null = null;
			for (let i = from; i < to; i++) {
				const draw = this.#draws[i];
				if (draw.cull !== cull) {
					cull = draw.cull;
					const pipeline = this.#pipelines.get(`${phase.key}/${cull}`);
					if (pipeline === undefined) {
						return draws;
					}
					pass.setPipeline(pipeline);
				}
				if ((phase.textured || material === null) && draw.material !== material) {
					material = draw.material;
					pass.setBindGroup(3, material);
				}
				if (draw.geometry !== geometry) {
					const next: ResidentGeometry = draw.geometry;
					geometry = next;
					pass.setVertexBuffer(0, next.vertices, 0, next.positionBytes);
					const optional = [next.normalOffset, next.uvOffset, next.tangentOffset];
					optional.forEach((offset, slot) => {
						if (offset === null) {
							pass.setVertexBuffer(slot + 1, this.#zeros);
						} else {
							pass.setVertexBuffer(slot + 1, next.vertices, offset);
						}
					});
					pass.setIndexBuffer(next.indices, next.indexFormat);
				}
				pass.drawIndexed(draw.indexCount, draw.count, draw.firstIndex, draw.baseVertex, draw.first);
			}
			draws += to - from;
		}
		return draws;
	}
}
