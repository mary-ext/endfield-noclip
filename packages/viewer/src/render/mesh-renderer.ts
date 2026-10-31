/**
 * geometry residency and the mesh family: each geometry gets one vertex buffer (quantized positions,
 * octahedral normals, UV sets 0 and 1, tangents, colours) and one index buffer; each mesh bucket is one
 * instanced `drawIndexed` over its slice of the visible list. per-draw parameters (dequantization, the
 * material look) sit in a storage array indexed through a per-list-entry draw id, and the material's textures
 * are in group 3 (a white texture for slots whose texture hasn't streamed in, with the slot's flag cleared).
 * opaque draws come before alpha-tested ones, which each pass draws with its own pipelines (see mesh.wgsl for
 * why), and alpha-blended ones come last, drawn in a pass of their own whose blending needs no sorting;
 * within each, draws are sorted by geometry, then material, so runs of draws share their bindings.
 *
 * @module
 */

import type { BindLayouts } from '../gfx/bind-layouts.ts';
import type { PipelineCache } from '../gfx/pipeline-cache.ts';
import {
	DEPTH_COMPARE,
	DEPTH_FORMAT,
	type MainPassFormat,
	TRANSPARENT_TARGETS,
} from '../gfx/render-targets.ts';
import type { DecodedGeometry } from '../package/decode-protocol.ts';
import type { MeshBucket } from '../streaming/mesh-selection.ts';
import type { ResidentGeometry } from '../streaming/stream-manager.ts';

import { FRAME_WGSL } from './frame-uniforms.ts';
import { LIST_CAPACITY } from './instance-renderer.ts';
import { alphaTextureOf, LOOK_FLOATS, LookFlags, SLOTS, SLOT_FLAGS } from './materials.ts';
import effectWgsl from './shaders/effect.wgsl?raw';
import meshWgsl from './shaders/mesh.wgsl?raw';
import { SHADOW_DEPTH_STATE } from './shadow-map.ts';
import type { TextureBinding, TextureStore } from './texture-store.ts';

/** floats of `Draw` in mesh.wgsl: the position and UV dequantizations, then the material look */
const DRAW_FLOATS = 16 + LOOK_FLOATS;
/** draws per frame at most; buckets past it aren't drawn */
const MAX_DRAWS = 16_384;
/** bytes per vertex of the zero buffer bound in place of missing streams (the widest are float UVs) */
const ZERO_STRIDE = 8;
/**
 * draw flags of the geometry, next to the material's `LookFlags` (`HAS_*` in mesh.wgsl). the shader can't
 * tell a missing stream from its values: the zero buffer bound in its place reads as an octahedral (0, 0),
 * which is +z
 */
const GeometryFlags = {
	HasNormals: 1 << 9,
	HasTangents: 1 << 10,
	HasColors: 1 << 26,
} as const;

/** the face culling a draw's pipeline uses; each phase has a pipeline per value */
const FACE_CULLS = ['none', 'back', 'front'] as const satisfies readonly GPUCullMode[];
type FaceCull = (typeof FACE_CULLS)[number];

/**
 * the winding of front faces of unmirrored instances, as the game's meshes reach the rasterizer through
 * `view_proj` (Unity's left-handed, clockwise-front convention, like the terrain's)
 */
const FRONT_FACE: GPUFrontFace = 'cw';

/** the vertex formats of UV sets 0 and 1: as the package stores 16-bit UVs, else dequantized floats */
const UV_FORMATS = ['unorm16x2', 'float32x2'] as const;
type UvFormat = (typeof UV_FORMATS)[number];

/** @returns the cache key of a phase's pipeline for a face culling and UV format */
const pipelineKey = (phase: string, cull: FaceCull, uvFormat: UvFormat): string =>
	`${phase}/${cull}/${uvFormat}`;

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

/** the draws a phase runs over: prepared in this order */
type DrawRange = 'opaque' | 'cutout' | 'transparent' | 'effect' | 'effectDecal' | 'mist' | 'mistVolume';

/**
 * the vertex streams a phase's pipelines read, in buffer slot order: every stream, positions alone (opaque
 * shadow casters), or positions and the UV sets (alpha-tested ones)
 */
type VertexStreams = 'all' | 'position' | 'uv';

/** one run over a pass's opaque, alpha-tested or alpha-blended draws, with a pipeline per face culling */
interface DrawPhase {
	key: string;
	range: DrawRange;
	/** whether the pipeline reads the material's textures; if not, any material group will do */
	textured: boolean;
	/** over only the draws whose materials cast shadows */
	shadow: boolean;
	streams: VertexStreams;
}

/**
 * the opaque meshes' depth, laid down before the terrain and the shading so each pixel is shaded once: the
 * opaque phase then shades only where its depth equals this
 */
const PREPASS_PHASES: readonly DrawPhase[] = [
	{ key: 'mesh/prepass', range: 'opaque', textured: false, shadow: false, streams: 'position' },
];

const MAIN_PHASES: readonly DrawPhase[] = [
	{ key: 'mesh/opaque', range: 'opaque', textured: true, shadow: false, streams: 'all' },
	{ key: 'mesh/cutout-depth', range: 'cutout', textured: true, shadow: false, streams: 'uv' },
	{ key: 'mesh/cutout-shade', range: 'cutout', textured: true, shadow: false, streams: 'all' },
];

const TRANSPARENT_PHASES: readonly DrawPhase[] = [
	{ key: 'mesh/transparent', range: 'transparent', textured: true, shadow: false, streams: 'all' },
	{ key: 'mesh/effect', range: 'effect', textured: true, shadow: false, streams: 'all' },
	{ key: 'mesh/effect-decal', range: 'effectDecal', textured: true, shadow: false, streams: 'all' },
	{ key: 'mesh/mist', range: 'mist', textured: true, shadow: false, streams: 'all' },
	{ key: 'mesh/mist-volume', range: 'mistVolume', textured: true, shadow: false, streams: 'all' },
];

/** the main pass's outputs that scene effects read, as `SceneTextures` holds them */
export interface EffectInputs {
	depth: GPUTextureView;
	reflectionSurface: GPUTextureView;
	version: number;
}

const SHADOW_PHASES: readonly DrawPhase[] = [
	{ key: 'mesh/shadow/opaque', range: 'opaque', textured: false, shadow: true, streams: 'position' },
	{ key: 'mesh/shadow/cutout', range: 'cutout', textured: true, shadow: true, streams: 'uv' },
];

/** the vertex buffers bound in a pass, so binding the same buffer at the same offset again is skipped */
class VertexBindings {
	#buffers: (GPUBuffer | null)[] = [];
	#offsets: number[] = [];

	/** forgets what's bound (at the start of each encode, since other families bind in between) */
	reset(): void {
		this.#buffers.fill(null);
	}

	set(pass: GPURenderPassEncoder, slot: number, buffer: GPUBuffer, offset: number, size?: number): void {
		if (this.#buffers[slot] === buffer && this.#offsets[slot] === offset && size === undefined) {
			return;
		}
		pass.setVertexBuffer(slot, buffer, offset, size);
		// a sized binding isn't remembered: the next geometry's positions always rebind
		this.#buffers[slot] = size === undefined ? buffer : null;
		this.#offsets[slot] = offset;
	}

	/** binds a stream of `vertices` at `offset`, or `zeros` where the geometry lacks it (`null`) */
	stream(
		pass: GPURenderPassEncoder,
		slot: number,
		vertices: GPUBuffer,
		offset: number | null,
		zeros: GPUBuffer,
	): void {
		if (offset === null) {
			this.set(pass, slot, zeros, 0);
		} else {
			this.set(pass, slot, vertices, offset);
		}
	}
}

interface PreparedDraw {
	geometry: ResidentGeometry;
	indexCount: number;
	firstIndex: number;
	baseVertex: number;
	first: number;
	count: number;
	/** per shadow layer, how many of the rows from `first` it draws */
	layerCounts: readonly number[];
	/** the material group; `null` for an effect until the transparent pass builds it */
	material: GPUBindGroup | null;
	cull: FaceCull;
	uvFormat: UvFormat;
	/** for scene effects: the material id and slot bindings their group is built from at encode */
	effect: { material: number; slots: (TextureBinding | null)[] } | null;
}

interface MaterialBinding {
	/** the slot bindings' versions the group was built from (-1 for the fallback) */
	versions: number[];
	group: GPUBindGroup;
}

/** @returns the UV format of a bucket's geometry */
const uvFormatOf = (bucket: MeshBucket): UvFormat => {
	const resident = bucket.geometry.resident;
	return resident?.kind === 'geometry' ? resident.uvFormat : 'float32x2';
};

/**
 * @returns the bucket's place in the draw order within the opaque, alpha-tested and alpha-blended draws:
 *   cast-only draws, then the other shadow casters, so shadow passes draw a prefix and the main pass skips
 *   one; then face culling and UV format (one pipeline each), geometry, material and submesh. all of it is
 *   fixed for a bucket, so it's computed once and packed into one number (50 bits) to keep the sort cheap
 */
const sortKeyOf = (bucket: MeshBucket): number => {
	if (bucket.sortKey < 0) {
		let key = bucket.castOnly ? 0 : 1;
		key = key * 2 + (bucket.look.castsShadows ? 0 : 1);
		key = key * 4 + FACE_CULLS.indexOf(faceCullOf(bucket));
		key = key * 2 + UV_FORMATS.indexOf(uvFormatOf(bucket));
		key = key * 2 ** 21 + Math.min(bucket.geometry.blob, 2 ** 21 - 1);
		key = key * 2 ** 16 + Math.min(bucket.material, 2 ** 16 - 1);
		bucket.sortKey = key * 2 ** 8 + Math.min(bucket.submesh, 2 ** 8 - 1);
	}
	return bucket.sortKey;
};

const byBindings = (a: MeshBucket, b: MeshBucket): number => sortKeyOf(a) - sortKeyOf(b);

/** the part of {@link sortKeyOf} above the geometry: the shadow role and the pipeline */
const PIPELINE_KEY = 2 ** 45;

/**
 * draw order for depth-writing draws: as {@link byBindings} up to the pipeline, then nearest first, so early
 * depth testing skips more of the shading behind
 */
const byPipelineThenNearest = (a: MeshBucket, b: MeshBucket): number =>
	Math.floor(sortKeyOf(a) / PIPELINE_KEY) - Math.floor(sortKeyOf(b) / PIPELINE_KEY) || a.nearest - b.nearest;

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
	#instances: { readonly bindGroup: GPUBindGroup };
	#params: GPUBuffer;
	#paramData = new Float32Array(MAX_DRAWS * DRAW_FLOATS);
	#paramWords = new Uint32Array(this.#paramData.buffer);
	#drawIds: GPUBuffer;
	#drawIdData = new Uint32Array(LIST_CAPACITY);
	#drawGroup: GPUBindGroup;
	#vertexBindings = new VertexBindings();
	/** zeros bound as the streams meshes lack */
	#zeros: GPUBuffer;
	#zerosSize = 0;
	#white: GPUTextureView;
	#defaultSampler: GPUSampler;
	/** material bind groups by material id */
	#bindings = new Map<number, MaterialBinding>();
	#slotBindings: (TextureBinding | null)[] = SLOTS.map(() => null);
	#versions: number[] = SLOTS.map(() => -1);
	#opaqueOrder: MeshBucket[] = [];
	#cutoutOrder: MeshBucket[] = [];
	#transparentOrder: MeshBucket[] = [];
	#effectOrder: MeshBucket[] = [];
	#decalOrder: MeshBucket[] = [];
	#mistOrder: MeshBucket[] = [];
	#mistVolumeOrder: MeshBucket[] = [];
	/** group 3 of the effect pipelines: seven textures, their samplers, the main pass's depth and surfaces */
	#effectLayout: GPUBindGroupLayout;
	/** effect bind groups by material id */
	#effectBindings = new Map<number, MaterialBinding & { inputs: number }>();
	#effectStart = 0;
	#decalStart = 0;
	#mistStart = 0;
	#mistVolumeStart = 0;
	/**
	 * prepared draws, opaque, then alpha-tested, then alpha-blended; entries past {@link #drawCount} are reused
	 * next frame
	 */
	#draws: PreparedDraw[] = [];
	#drawCount = 0;
	/** indices of the first alpha-tested and the first alpha-blended draw */
	#cutoutStart = 0;
	#transparentStart = 0;
	/** ends of the shadow-casting opaque and alpha-tested draws */
	#opaqueCastersEnd = 0;
	#cutoutCastersEnd = 0;
	/** ends of the cast-only opaque and alpha-tested draws, where the main pass starts */
	#opaqueCastOnlyEnd = 0;
	#cutoutCastOnlyEnd = 0;

	/**
	 * @param device the device
	 * @param layouts shared layouts
	 * @param pipelines pipeline cache
	 * @param instances the owner of group 1 (instance rows, block origins and the visible list), asked for it
	 *   on every encode since it changes when the rows grow
	 * @param format the main pass's targets
	 */
	constructor(
		device: GPUDevice,
		layouts: BindLayouts,
		pipelines: PipelineCache,
		instances: { readonly bindGroup: GPUBindGroup },
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
		const vertex = (uvFormat: UvFormat, streams: VertexStreams = 'all'): GPUVertexState => {
			const uvStride = uvFormat === 'unorm16x2' ? 4 : 8;
			const position: GPUVertexBufferLayout = {
				arrayStride: 8,
				attributes: [{ shaderLocation: 0, offset: 0, format: 'unorm16x4' }],
			};
			const uvs: GPUVertexBufferLayout[] = [
				{ arrayStride: uvStride, attributes: [{ shaderLocation: 2, offset: 0, format: uvFormat }] },
				{ arrayStride: uvStride, attributes: [{ shaderLocation: 4, offset: 0, format: uvFormat }] },
			];
			switch (streams) {
				case 'position': {
					return { module, entryPoint: 'vs_depth', buffers: [position] };
				}
				case 'uv': {
					return { module, entryPoint: 'vs_cutout_depth', buffers: [position, ...uvs] };
				}
				case 'all': {
					return {
						module,
						entryPoint: 'vs_main',
						buffers: [
							position,
							{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: 'snorm16x2' }] },
							...uvs,
							{ arrayStride: 4, attributes: [{ shaderLocation: 3, offset: 0, format: 'snorm8x4' }] },
							{ arrayStride: 4, attributes: [{ shaderLocation: 5, offset: 0, format: 'unorm8x4' }] },
						],
					};
				}
			}
		};
		const prepare = (
			{ key, streams }: DrawPhase,
			stages: Pick<GPURenderPipelineDescriptor, 'fragment' | 'depthStencil'>,
		): void => {
			for (const cullMode of FACE_CULLS) {
				for (const uvFormat of UV_FORMATS) {
					void pipelines.prepare(pipelineKey(key, cullMode, uvFormat), () => ({
						layout: layouts.meshPipeline,
						vertex: vertex(uvFormat, streams),
						primitive: { topology: 'triangle-list', frontFace: FRONT_FACE, cullMode },
						...stages,
					}));
				}
			}
		};
		const depthWrite: GPUDepthStencilState = {
			format: DEPTH_FORMAT,
			depthWriteEnabled: true,
			depthCompare: DEPTH_COMPARE,
		};
		const shade: GPUFragmentState = { module, entryPoint: 'fs_opaque', targets: format.targets };
		const [opaque, cutoutDepth, cutoutShade] = MAIN_PHASES;
		const depthEqual: GPUDepthStencilState = {
			format: DEPTH_FORMAT,
			depthWriteEnabled: false,
			depthCompare: 'equal',
		};
		prepare(PREPASS_PHASES[0], {
			fragment: {
				module,
				entryPoint: 'fs_depth',
				targets: format.targets.map((target) => ({ ...target, writeMask: 0 })),
			},
			depthStencil: depthWrite,
		});
		prepare(opaque, { fragment: shade, depthStencil: depthEqual });
		prepare(cutoutDepth, {
			fragment: {
				module,
				entryPoint: 'fs_cutout_depth',
				targets: format.targets.map((target) => ({ ...target, writeMask: 0 })),
			},
			depthStencil: depthWrite,
		});
		prepare(cutoutShade, {
			fragment: shade,
			depthStencil: depthEqual,
		});
		prepare(TRANSPARENT_PHASES[0], {
			fragment: { module, entryPoint: 'fs_transparent', targets: TRANSPARENT_TARGETS },
			depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: DEPTH_COMPARE },
		});
		const [shadowOpaque, shadowCutout] = SHADOW_PHASES;
		prepare(shadowOpaque, { depthStencil: SHADOW_DEPTH_STATE });
		prepare(shadowCutout, {
			fragment: { module, entryPoint: 'fs_cutout_depth', targets: [] },
			depthStencil: SHADOW_DEPTH_STATE,
		});

		// #region scene effects
		{
			this.#effectLayout = device.createBindGroupLayout({
				label: 'effect materials',
				entries: [
					...SLOTS.map((_, binding) => ({
						binding,
						visibility: GPUShaderStage.FRAGMENT,
						texture: { sampleType: 'float' as const },
					})),
					...SLOTS.map((_, i) => ({
						binding: SLOTS.length + i,
						visibility: GPUShaderStage.FRAGMENT,
						sampler: { type: 'filtering' as const },
					})),
					{ binding: 14, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
					{ binding: 15, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
				],
			});
			const layout = device.createPipelineLayout({
				label: 'effect',
				bindGroupLayouts: [layouts.frame, layouts.instances, layouts.draw, this.#effectLayout],
			});
			const effectModule = pipelines.module('mesh-effect', FRAME_WGSL + effectWgsl);
			const [, effect, decal, mist, mistVolume] = TRANSPARENT_PHASES;
			for (const [phase, entryPoint, depthCompare] of [
				[effect, 'fs_effect', DEPTH_COMPARE],
				// decals find their surface through the depth buffer, so their back faces draw wherever they are
				[decal, 'fs_effect_decal', 'always'],
				[mist, 'fs_mist_card', DEPTH_COMPARE],
				// fog boxes measure their thickness up to the depth buffer the same way
				[mistVolume, 'fs_mist_volume', 'always'],
			] as const) {
				for (const cullMode of FACE_CULLS) {
					for (const uvFormat of UV_FORMATS) {
						void pipelines.prepare(pipelineKey(phase.key, cullMode, uvFormat), () => ({
							layout,
							vertex: { ...vertex(uvFormat), module: effectModule, entryPoint: 'vs_effect' },
							primitive: { topology: 'triangle-list', frontFace: FRONT_FACE, cullMode },
							fragment: { module: effectModule, entryPoint, targets: TRANSPARENT_TARGETS },
							depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare },
						}));
					}
				}
			}
		}
		// #endregion
	}

	/** an effect material's bind group over its slots' current bindings and this frame's main pass outputs */
	#effectGroup(
		material: number,
		slots: readonly (TextureBinding | null)[],
		inputs: EffectInputs,
	): GPUBindGroup {
		const versions = slots.map((slot) => slot?.version ?? -1);
		const cached = this.#effectBindings.get(material);
		if (
			cached !== undefined &&
			cached.inputs === inputs.version &&
			cached.versions.every((version, i) => version === versions[i])
		) {
			return cached.group;
		}
		const group = this.#device.createBindGroup({
			label: `effect material ${material}`,
			layout: this.#effectLayout,
			entries: [
				...slots.map((slot, i) => ({ binding: i, resource: slot?.view ?? this.#white })),
				...slots.map((slot, i) => ({
					binding: SLOTS.length + i,
					resource: slot?.sampler ?? this.#defaultSampler,
				})),
				{ binding: 14, resource: inputs.depth },
				{ binding: 15, resource: inputs.reflectionSurface },
			],
		});
		this.#effectBindings.set(material, { versions, inputs: inputs.version, group });
		return group;
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
		const streams = [decoded.positions, decoded.normals, ...decoded.uvs, decoded.tangents, decoded.colors];
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
			uv0Offset: offsets[2],
			// the game reads a UV set a mesh lacks as set 0
			uv1Offset: offsets[3] ?? offsets[2],
			uvFormat: decoded.uvFormat,
			uvTransforms: decoded.uvTransforms,
			tangentOffset: offsets[4],
			colorOffset: offsets[5],
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
		this.#effectBindings.clear();
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
				{ binding: SLOTS.length, resource: slots[0]?.sampler ?? this.#defaultSampler },
				{ binding: SLOTS.length + 1, resource: detail?.sampler ?? this.#defaultSampler },
				{ binding: SLOTS.length + 2, resource: slots[5]?.sampler ?? this.#defaultSampler },
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
		const transparent = this.#transparentOrder;
		const effects = this.#effectOrder;
		const decals = this.#decalOrder;
		const mists = this.#mistOrder;
		const mistVolumes = this.#mistVolumeOrder;
		opaque.length = 0;
		cutout.length = 0;
		transparent.length = 0;
		effects.length = 0;
		decals.length = 0;
		mists.length = 0;
		mistVolumes.length = 0;
		for (const bucket of buckets) {
			if (bucket.count === 0 || bucket.geometry.resident?.kind !== 'geometry') {
				continue;
			}
			// without the texture holding its alpha there's nothing to test yet. unlit looks are their texture, so
			// they wait for it rather than draw as solid cards
			const look = bucket.look;
			if (bucket.castOnly && (!look.castsShadows || look.transparent)) {
				continue;
			}
			if ((look.flags & LookFlags.Unlit) !== 0 && textures.binding(look.textures[0]) === null) {
				continue;
			}
			// effects are made of their textures, so they wait for all of them
			if ((look.flags & LookFlags.Effect) !== 0) {
				if (look.textures.every((texture) => texture < 0 || textures.binding(texture) !== null)) {
					const decal = (look.flags & LookFlags.EffectDecal) !== 0;
					if ((look.flags & LookFlags.EffectMist) !== 0) {
						(decal ? mistVolumes : mists).push(bucket);
					} else {
						(decal ? decals : effects).push(bucket);
					}
				}
				continue;
			}
			if (look.transparent) {
				transparent.push(bucket);
			} else if (look.cutout && textures.binding(alphaTextureOf(look)) !== null) {
				cutout.push(bucket);
			} else {
				opaque.push(bucket);
			}
		}
		opaque.sort(byPipelineThenNearest);
		cutout.sort(byPipelineThenNearest);
		transparent.sort(byBindings);
		effects.sort(byBindings);
		decals.sort(byBindings);
		mists.sort(byBindings);
		mistVolumes.sort(byBindings);
		const cutoutFrom = opaque.length;
		const transparentFrom = cutoutFrom + cutout.length;
		const effectFrom = transparentFrom + transparent.length;
		const decalFrom = effectFrom + effects.length;
		const mistFrom = decalFrom + decals.length;
		const mistVolumeFrom = mistFrom + mists.length;
		const bucketCount = mistVolumeFrom + mistVolumes.length;
		const bucketAt = (b: number): MeshBucket => {
			if (b < cutoutFrom) {
				return opaque[b];
			}
			if (b < transparentFrom) {
				return cutout[b - cutoutFrom];
			}
			if (b < effectFrom) {
				return transparent[b - transparentFrom];
			}
			if (b < decalFrom) {
				return effects[b - effectFrom];
			}
			if (b < mistFrom) {
				return decals[b - decalFrom];
			}
			if (b < mistVolumeFrom) {
				return mists[b - mistFrom];
			}
			return mistVolumes[b - mistVolumeFrom];
		};

		const params = this.#paramData;
		const words = this.#paramWords;
		const ids = this.#drawIdData;
		const slots = this.#slotBindings;
		let listStart = LIST_CAPACITY;
		let listEnd = 0;
		let d = 0;
		this.#opaqueCastersEnd = 0;
		this.#cutoutCastersEnd = 0;
		this.#opaqueCastOnlyEnd = 0;
		this.#cutoutCastOnlyEnd = 0;
		this.#cutoutStart = 0;
		this.#transparentStart = 0;
		this.#effectStart = 0;
		this.#decalStart = 0;
		this.#mistStart = 0;
		this.#mistVolumeStart = 0;
		for (let b = 0; b < bucketCount; b++) {
			if (b === cutoutFrom) {
				this.#cutoutStart = d;
			}
			if (b === transparentFrom) {
				this.#transparentStart = d;
			}
			if (b === effectFrom) {
				this.#effectStart = d;
			}
			if (b === decalFrom) {
				this.#decalStart = d;
			}
			if (b === mistFrom) {
				this.#mistStart = d;
			}
			if (b === mistVolumeFrom) {
				this.#mistVolumeStart = d;
			}
			const bucket = bucketAt(b);
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
				(resident.tangentOffset === null ? 0 : GeometryFlags.HasTangents) |
				(resident.colorOffset === null ? 0 : GeometryFlags.HasColors);
			params.set(resident.positionScale, at + 4);
			params[at + 7] = 0;
			params.set(resident.uvTransforms[0], at + 8);
			params.set(resident.uvTransforms[1], at + 12);
			params.set(look.params, at + 16);
			ids.fill(d, bucket.first, bucket.first + bucket.count);
			listStart = Math.min(listStart, bucket.first);
			listEnd = Math.max(listEnd, bucket.first + bucket.count);

			// an effect's group also binds the main pass's outputs, so it's built when the transparent pass encodes
			const isEffect = b >= effectFrom;
			const material = isEffect ? null : this.#materialGroup(bucket.material, slots);
			const effect = isEffect ? { material: bucket.material, slots: [...slots] } : null;
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
					layerCounts: bucket.layerCounts,
					material,
					cull,
					uvFormat: resident.uvFormat,
					effect,
				};
			} else {
				draw.geometry = resident;
				draw.indexCount = range.indexCount;
				draw.firstIndex = range.firstIndex;
				draw.baseVertex = range.baseVertex;
				draw.first = bucket.first;
				draw.count = bucket.count;
				draw.layerCounts = bucket.layerCounts;
				draw.material = material;
				draw.cull = cull;
				draw.uvFormat = resident.uvFormat;
				draw.effect = effect;
			}
			d++;
			if (look.castsShadows) {
				if (b < cutoutFrom) {
					this.#opaqueCastersEnd = d;
				} else if (b < transparentFrom) {
					this.#cutoutCastersEnd = d;
				}
			}
			if (bucket.castOnly) {
				if (b < cutoutFrom) {
					this.#opaqueCastOnlyEnd = d;
				} else {
					this.#cutoutCastOnlyEnd = d;
				}
				continue;
			}

			this.instanceCount += bucket.count;
			this.triangles += (bucket.count * range.indexCount) / 3;
			if (slots[0] !== null) {
				this.texturedDraws++;
			}
		}
		this.#drawCount = d;
		// ranges that start at or past the last bucket (empty ones, or draws past the cap) start at the end
		if (cutoutFrom === bucketCount) {
			this.#cutoutStart = d;
		}
		if (transparentFrom === bucketCount) {
			this.#transparentStart = d;
		}
		if (effectFrom === bucketCount) {
			this.#effectStart = d;
		}
		if (decalFrom === bucketCount) {
			this.#decalStart = d;
		}
		if (mistFrom === bucketCount) {
			this.#mistStart = d;
		}
		if (mistVolumeFrom === bucketCount) {
			this.#mistVolumeStart = d;
		}
		this.#cutoutCastersEnd = Math.max(this.#cutoutCastersEnd, this.#cutoutStart);
		this.#cutoutCastOnlyEnd = Math.max(this.#cutoutCastOnlyEnd, this.#cutoutStart);
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
		if (!this.#ready(PREPASS_PHASES)) {
			return 0;
		}
		return this.#encode(pass, MAIN_PHASES);
	}

	/**
	 * lays down the opaque meshes' depth; call before anything else draws into the main pass, then
	 * {@link encode}.
	 *
	 * @param pass the main pass, with group 0 bound
	 * @returns draw calls issued
	 */
	encodePrepass(pass: GPURenderPassEncoder): number {
		// the shading only shows where the prepass drew, so neither draws until both can
		if (!this.#ready(MAIN_PHASES)) {
			return 0;
		}
		return this.#encode(pass, PREPASS_PHASES);
	}

	/** @returns whether every pipeline of the phases is compiled */
	#ready(phases: readonly DrawPhase[]): boolean {
		for (const phase of phases) {
			for (const cull of FACE_CULLS) {
				for (const uvFormat of UV_FORMATS) {
					if (this.#pipelines.get(pipelineKey(phase.key, cull, uvFormat)) === undefined) {
						return false;
					}
				}
			}
		}
		return true;
	}

	/**
	 * @param pass the transparent pass, with group 0 bound and the main pass's depth attached read-only
	 * @param inputs the main pass's outputs, which scene effects read
	 * @returns draw calls issued
	 */
	encodeTransparent(pass: GPURenderPassEncoder, inputs: EffectInputs): number {
		for (let i = this.#effectStart; i < this.#drawCount; i++) {
			const draw = this.#draws[i];
			if (draw.effect !== null) {
				draw.material = this.#effectGroup(draw.effect.material, draw.effect.slots, inputs);
			}
		}
		return this.#encode(pass, TRANSPARENT_PHASES);
	}

	/**
	 * draws this frame's meshes into a shadow cascade.
	 *
	 * @param pass a shadow pass, with group 0 bound
	 * @param layer the shadow layer, which draws only the instances that can cast into it
	 * @returns draw calls issued
	 */
	encodeShadow(pass: GPURenderPassEncoder, layer: number): number {
		return this.#encode(pass, SHADOW_PHASES, layer);
	}

	/**
	 * encodes the phases in order; nothing if any phase's pipeline isn't ready. `layer` limits each draw to the
	 * rows that shadow layer draws, or is -1 for all of them
	 */
	#encode(pass: GPURenderPassEncoder, phases: readonly DrawPhase[], layer = -1): number {
		if (this.#drawCount === 0) {
			return 0;
		}
		// cutout depth and depth-equal shading must rasterize identically, so nothing draws until every variant
		// is ready
		if (!this.#ready(phases)) {
			return 0;
		}
		pass.setBindGroup(1, this.#instances.bindGroup);
		pass.setBindGroup(2, this.#drawGroup);
		const bindings = this.#vertexBindings;
		bindings.reset();
		let draws = 0;
		for (const phase of phases) {
			let from: number;
			let to: number;
			switch (phase.range) {
				case 'opaque': {
					from = phase.shadow ? 0 : this.#opaqueCastOnlyEnd;
					to = phase.shadow ? this.#opaqueCastersEnd : this.#cutoutStart;
					break;
				}
				case 'cutout': {
					from = phase.shadow ? this.#cutoutStart : this.#cutoutCastOnlyEnd;
					to = phase.shadow ? this.#cutoutCastersEnd : this.#transparentStart;
					break;
				}
				case 'transparent': {
					from = this.#transparentStart;
					to = this.#effectStart;
					break;
				}
				case 'effect': {
					from = this.#effectStart;
					to = this.#decalStart;
					break;
				}
				case 'effectDecal': {
					from = this.#decalStart;
					to = this.#mistStart;
					break;
				}
				case 'mist': {
					from = this.#mistStart;
					to = this.#mistVolumeStart;
					break;
				}
				case 'mistVolume': {
					from = this.#mistVolumeStart;
					to = this.#drawCount;
					break;
				}
			}
			if (from === to) {
				continue;
			}
			let cull: FaceCull | null = null;
			let uvFormat: UvFormat | null = null;
			let geometry: ResidentGeometry | null = null;
			let material: GPUBindGroup | null = null;
			for (let i = from; i < to; i++) {
				const draw = this.#draws[i];
				const count = layer < 0 ? draw.count : draw.layerCounts[layer];
				// only an effect drawn outside the transparent pass would lack its group
				if (draw.material === null || count === 0) {
					continue;
				}
				if (draw.cull !== cull || draw.uvFormat !== uvFormat) {
					cull = draw.cull;
					uvFormat = draw.uvFormat;
					const pipeline = this.#pipelines.get(pipelineKey(phase.key, cull, uvFormat));
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
					geometry = draw.geometry;
					this.#bindStreams(pass, bindings, geometry, phase.streams);
					pass.setIndexBuffer(geometry.indices, geometry.indexFormat);
				}
				pass.drawIndexed(draw.indexCount, count, draw.firstIndex, draw.baseVertex, draw.first);
				draws++;
			}
		}
		return draws;
	}

	/** binds a geometry's vertex streams in the slots a phase's pipelines read, zeros where it lacks one */
	#bindStreams(
		pass: GPURenderPassEncoder,
		bindings: VertexBindings,
		geometry: ResidentGeometry,
		streams: VertexStreams,
	): void {
		bindings.set(pass, 0, geometry.vertices, 0, geometry.positionBytes);
		const vertices = geometry.vertices;
		const zeros = this.#zeros;
		switch (streams) {
			case 'position': {
				break;
			}
			case 'uv': {
				bindings.stream(pass, 1, vertices, geometry.uv0Offset, zeros);
				bindings.stream(pass, 2, vertices, geometry.uv1Offset, zeros);
				break;
			}
			case 'all': {
				bindings.stream(pass, 1, vertices, geometry.normalOffset, zeros);
				bindings.stream(pass, 2, vertices, geometry.uv0Offset, zeros);
				bindings.stream(pass, 3, vertices, geometry.uv1Offset, zeros);
				bindings.stream(pass, 4, vertices, geometry.tangentOffset, zeros);
				bindings.stream(pass, 5, vertices, geometry.colorOffset, zeros);
				break;
			}
		}
	}
}
