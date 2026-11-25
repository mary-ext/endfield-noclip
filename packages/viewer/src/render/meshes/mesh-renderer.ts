import type { TgpuRoot } from 'typegpu';

import type { PipelineCache } from '../../gfx/pipeline-cache.ts';
import { SwayKind, SwayRow } from '../../looks/lit-look.ts';
import type { LookStencil } from '../../looks/look.ts';
import type { DecodedGeometry } from '../../package/decode-protocol.ts';
import type { Camera } from '../../scene/camera.ts';
import { type GpuCullWork, INDIRECT_WORDS } from '../../streaming/gpu-cull-work.ts';
import type { MeshBucket } from '../../streaming/mesh-buckets.ts';
import type { ResidentGeometry } from '../../streaming/resident.ts';
import type { BindLayouts } from '../frame/bind-layouts.ts';
import type { MainPassFormat } from '../frame/render-targets.ts';
import { LIST_CAPACITY, type ListedSpan } from '../instances/instance-renderer.ts';
import { CAMERA_HISTORY_FLOATS, CameraHistory } from '../post/camera-history.ts';
import { SHADOW_LAYERS } from '../shadows/shadow-map.ts';
import { MipFeedback, type MipSteps } from '../textures/mip-feedback.ts';
import type { TextureStore } from '../textures/texture-store.ts';

import { DepthPyramid } from './depth-pyramid.ts';
import { COMPARATORS, type DrawEntry, drawRangeOf, pipelineKeyOf, sortKeyOf } from './draw-order.ts';
import {
	DRAW_RANGES,
	type DrawPhase,
	type DrawRange,
	type DrawRangeInfo,
	type EffectPass,
	type MeshPass,
	PASS_PHASES,
	SORTED_RANGES,
	type SurfacePass,
} from './draw-ranges.ts';
import { type GeometryIndices, GeometryPools, type GeometryVertices } from './geometry-pools.ts';
import { releaseGeometry, uploadGeometry } from './geometry-residency.ts';
import { type CullTargets, type CulledBucket, InstanceCuller, type Occlusion } from './instance-culler.ts';
import { LookTable } from './look-table.ts';
import {
	type EffectInputs,
	type EffectMaterial,
	MaterialBindings,
	type MaterialState,
} from './material-bindings.ts';
import { type MeshPipelines, prepareMeshPipelines } from './mesh-pipelines.ts';
import { type ResidentSkin, SkinAnimator } from './skin-animation.ts';
import { type SortedSource, mergeFarToNear } from './sorted-runs.ts';
import { VertexBindings } from './vertex-bindings.ts';

/**
 * floats of `Draw` in surfaces/common.ts: the position and UV dequantizations, the flags and the material's
 * slot in the look table
 */
const DRAW_FLOATS = 16;
/** draws per frame at most; buckets past it aren't drawn */
const MAX_DRAWS = 16_384;
/**
 * how far the eye may move between frames for last frame's depth to still stand for what hides rows, m; past
 * it (a jump), every row in view draws
 */
const OCCLUSION_MAX_MOVE = 8;

interface PreparedDraw {
	geometry: ResidentGeometry;
	indexCount: number;
	firstIndex: number;
	baseVertex: number;
	first: number;
	count: number;
	/** per shadow layer, how many of the rows from `first` it draws */
	layerCounts: readonly number[];
	/** for a GPU-culled bucket, the byte offset of its indirect arguments; -1 for one of listed rows */
	indirect: number;
	/** for a GPU-culled bucket, per shadow layer, the room it has for casters (owned by the draw) */
	layerRooms: number[];
	/** the material group; `null` for an effect until its pass builds it */
	material: GPUBindGroup | null;
	/** the pipeline variant for its face culling and its geometry's UV format ({@link variantOf}) */
	variant: number;
	/** for scene effects: the material id and slot bindings their group is built from at encode */
	effect: EffectMaterial | null;
	/** the stencil state its pipeline variant uses, or `null` for the phase's own pipeline */
	stencil: LookStencil | null;
	/** for a draw of the transparent pass, its instances' distances, far to near (`MeshBucket.distances`) */
	distances: readonly number[];
	/** for a draw of the transparent pass, its instances' sort bands (`MeshBucket.bands`) */
	bands: readonly number[];
	/** whether any instance in this draw is cross-fading (`MeshBucket.fading`) */
	fading: boolean;
	/** whether the vertex stage samples a material texture (`SwayKind.Mushroom`) in depth/shadow passes */
	vertexTextured: boolean;
}

/** what {@link MeshRenderer} last bound while encoding a pass, so it binds only what changes */
interface EncodeState {
	phase: DrawPhase | null;
	variant: number;
	fading: boolean;
	stencil: LookStencil | null;
	reference: number;
	vertices: GeometryVertices | null;
	indices: GeometryIndices | null;
	material: GPUBindGroup | null;
}

/** a range's queued buckets and where its draws landed this frame */
interface PreparedRange {
	info: DrawRangeInfo;
	/** this frame's buckets in the range, in draw order */
	entries: DrawEntry[];
	/** the range's draws, [start, end) of the prepared draws */
	start: number;
	end: number;
	/** the end of the cast-only draws, sorted first, where the passes over draws in view start */
	castOnlyEnd: number;
	/** the end of the shadow-casting draws, sorted before the rest, where the shadow passes stop */
	castersEnd: number;
}

/**
 * draws the mesh buckets: owns the geometry pools, material bind groups and the mesh pipelines, prepares each
 * frame's draws into the ranges of draw-ranges.ts and encodes the passes over them
 */
export class MeshRenderer {
	/** mesh instances last frame */
	instanceCount = 0;
	/** mesh triangles last frame */
	triangles = 0;
	/** draws whose base colour texture was bound */
	texturedDraws = 0;
	/** whether any prepared draw in the transparent pass reads `fx_background` (`MaterialLook.readsBackground`) */
	transparentReadsBackground = false;
	/** whether any prepared draw in the transparent pass writes depth (`transparentDepthWrite`) */
	transparentWritesDepth = false;

	#device: GPUDevice;
	#instances: { readonly bindGroup: GPUBindGroup };
	#params: GPUBuffer;
	#paramData = new Float32Array(MAX_DRAWS * DRAW_FLOATS);
	#paramWords = new Uint32Array(this.#paramData.buffer);
	#drawIds: GPUBuffer;
	#drawIdData = new Uint32Array(LIST_CAPACITY);
	/** the look table: each drawn material's parameters, uploaded once on first use */
	#looks: LookTable;
	/** which mip levels the main pass sampled of each look slot's textures */
	#mips: MipFeedback;
	/**
	 * how finely the frames just drawn sampled a material's textures, by material id; -1 for a material the
	 * main pass drew no pixel of
	 */
	readonly mips: MipSteps = {
		steps: (material, set) => {
			const slot = this.#looks.slotOf(material);
			return slot < 0 ? -1 : this.#mips.steps(slot, set);
		},
	};
	/** the {@link LookTable.version} that {@link #drawGroup} binds */
	#looksVersion = -1;
	#layouts: BindLayouts;
	#fog: { uniforms: GPUBuffer; froxels: GPUTextureView; sampler: GPUSampler };
	#drawGroup: GPUBindGroup;
	#vertexBindings: VertexBindings;
	/** the still geometries' vertex streams and indices */
	#pools: GeometryPools;
	#materials: MaterialBindings;
	/** every range, in {@link DRAW_RANGES} order */
	#ranges: PreparedRange[] = DRAW_RANGES.map((info) => ({
		info,
		entries: [],
		start: 0,
		end: 0,
		castOnlyEnd: 0,
		castersEnd: 0,
	}));
	#rangeOf = new Map(this.#ranges.map((range) => [range.info.range, range]));
	/** the entries queued in the ranges, reused across frames */
	#entries: DrawEntry[] = [];
	/** prepared draws in {@link DRAW_RANGES} order; entries past {@link #drawCount} are reused next frame */
	#draws: PreparedDraw[] = [];
	#drawCount = 0;
	/**
	 * the transparent pass's draw order, as `[draw, first, count, phase]` quads: the draws that write the
	 * stencil whole, so the effects testing it see the whole mask, then every other draw's instances far to
	 * near; `first` counts from the draw's first instance and `phase` indexes the pass's phases
	 */
	#sortedRuns: number[] = [];
	/** {@link mergeFarToNear}'s inputs and output, reused */
	#sortedSources: SortedSource[] = [];
	#sortedDraws: number[] = [];
	#sortedPhases: number[] = [];
	#merged: number[] = [];
	/** whether the depth buffer has a stencil; without one, draws that use it are skipped */
	#stencil: boolean;
	/** lazy pipeline store for all mesh and effect phases */
	#meshPipelines: MeshPipelines;
	#skins: SkinAnimator;
	/** the animations of this frame's draws, which are skinned before they draw */
	#drawnSkins = new Set<ResidentSkin>();
	/** culls the GPU-culled buckets' rows; `null` without `indirect-first-instance` */
	#culler: InstanceCuller | null;
	/** last frame's depth, which rows in view are tested against */
	#pyramid: DepthPyramid;
	/** the camera last frame's depth was drawn with */
	#history = new CameraHistory();
	#previous = new Float32Array(CAMERA_HISTORY_FLOATS);
	/** what {@link #prepareDraw} hands the culler, reused */
	#culled: CulledBucket = {
		first: 0,
		room: 0,
		layerFirst: Array.from({ length: SHADOW_LAYERS }, () => 0),
		layerRoom: Array.from({ length: SHADOW_LAYERS }, () => 0),
		draw: 0,
		indexCount: 0,
		firstIndex: 0,
		baseVertex: 0,
	};

	/**
	 * @param device the device
	 * @param layouts shared layouts
	 * @param pipelines pipeline cache
	 * @param context `instances`, the owner of group 1 (instance rows, block origins and the visible list),
	 *   asked for it on every encode since it changes when the rows grow, and of the buffers GPU culling reads
	 *   and writes; the main pass's targets; what transparent draws fog themselves with; and
	 *   `indirectFirstInstance` when indirect draws may start past the first instance, which GPU culling needs
	 */
	/**
	 * @param root the TypeGPU root
	 * @param layouts shared bind-group layouts
	 * @param pipelines pipeline cache
	 * @param options instances, main pass format, shadow map, fog inputs, and device features
	 */
	constructor(
		root: TgpuRoot,
		layouts: BindLayouts,
		pipelines: PipelineCache,
		{
			instances,
			format,
			shadow,
			fog,
			features,
		}: {
			instances: { readonly bindGroup: GPUBindGroup; readonly buffers: Omit<CullTargets, 'drawIds'> };
			format: MainPassFormat;
			shadow: { format: GPUTextureFormat; unclippedDepth: boolean };
			fog: { uniforms: GPUBuffer; froxels: GPUTextureView; sampler: GPUSampler };
			features: { indirectFirstInstance: boolean };
		},
	) {
		const device = root.device;
		this.#device = device;
		this.#instances = instances;
		this.#stencil = format.stencil;
		this.#skins = new SkinAnimator(root, pipelines);
		this.#vertexBindings = new VertexBindings(device);
		this.#pools = new GeometryPools(device);
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
		this.#layouts = layouts;
		this.#fog = fog;
		this.#looks = new LookTable(device);
		this.#drawGroup = this.#createDrawGroup();
		this.#culler = features.indirectFirstInstance
			? new InstanceCuller(root, pipelines, () => ({ ...instances.buffers, drawIds: this.#drawIds }))
			: null;
		this.#pyramid = new DepthPyramid(root, pipelines);
		this.#mips = new MipFeedback(root, pipelines);
		this.#meshPipelines = prepareMeshPipelines(device, layouts, pipelines, format, shadow);
		this.#materials = new MaterialBindings(
			device,
			this.#meshPipelines.materialLayout,
			this.#meshPipelines.effectLayout,
		);
	}

	// #region residency

	/**
	 * uploads a decoded geometry.
	 *
	 * @param blob the geometry's blob, for labels
	 * @param decoded vertex streams and indices
	 * @returns the residency (still geometry is pooled; the memory budget bounds the pools)
	 */
	upload(blob: number, decoded: DecodedGeometry): ResidentGeometry {
		return uploadGeometry(
			this.#device,
			{ pools: this.#pools, skins: this.#skins, bindings: this.#vertexBindings },
			blob,
			decoded,
		);
	}

	/** @param resident a geometry from {@link upload}; its pool ranges are freed and its own buffers destroyed */
	release(resident: ResidentGeometry): void {
		if (resident.skin !== null) {
			this.#drawnSkins.delete(resident.skin);
		}
		releaseGeometry(resident, this.#pools);
	}

	/** forgets material bind groups and the look table (when a package is unloaded) */
	releaseMaterials(): void {
		this.#materials.release();
		this.#looks.reset();
		this.#mips.reset();
		this.#drawGroup = this.#createDrawGroup();
	}

	/** @returns the draw group (group 2) over the current look table */
	#createDrawGroup(): GPUBindGroup {
		this.#looksVersion = this.#looks.version;
		return this.#device.createBindGroup({
			label: 'mesh draws',
			layout: this.#layouts.draw,
			entries: [
				{ binding: 0, resource: { buffer: this.#params } },
				{ binding: 1, resource: { buffer: this.#drawIds } },
				{ binding: 2, resource: { buffer: this.#fog.uniforms } },
				{ binding: 3, resource: this.#fog.froxels },
				{ binding: 4, resource: this.#fog.sampler },
				{ binding: 5, resource: { buffer: this.#looks.buffer } },
			],
		});
	}

	/**
	 * @returns bytes of the GPU allocations: the draw parameters, the look table, the draw ids, the zero
	 *   streams, the geometry pools (whose ranges the geometries' residency counts too) and the culling
	 *   buffers
	 */
	get bytes(): number {
		return (
			this.#params.size +
			this.#pools.bytes +
			this.#looks.bytes +
			this.#drawIds.size +
			this.#vertexBindings.bytes +
			(this.#culler?.bytes ?? 0) +
			this.#pyramid.bytes +
			this.#mips.bytes
		);
	}

	/** @returns whether the GPU can cull rows (the mesh selection's `gpuCulling`): its passes compiled */
	get gpuCulling(): boolean {
		return this.#culler?.ready ?? false;
	}

	/**
	 * destroys the renderer's own GPU allocations, the geometry pools included; geometries' own buffers stay
	 * with their residency, released through {@link release}. the renderer can't be used after
	 */
	destroy(): void {
		this.#params.destroy();
		this.#pools.destroy();
		this.#looks.destroy();
		this.#drawIds.destroy();
		this.#vertexBindings.destroy();
		this.#materials.release();
		this.#culler?.destroy();
		this.#pyramid.destroy();
		this.#mips.destroy();
	}

	/** forgets the camera last frame's depth was drawn with, so the next cull tests nothing against it (a cut) */
	reset(): void {
		this.#history.reset();
	}

	// #endregion

	// #region animation

	/**
	 * skins the animated geometries this frame draws at the time's frame, and moves the looks a looping clip
	 * plays to it; encode before anything draws meshes
	 *
	 * @param encoder the frame's encoder
	 * @param time seconds of the viewer's clock
	 * @returns whether a drawn geometry moved, so the shadows it casts must be drawn again
	 */
	animate(encoder: GPUCommandEncoder, time: number): boolean {
		this.#looks.advance(time);
		return this.#skins.encode(encoder, this.#drawnSkins, time);
	}

	/**
	 * culls the rows of the GPU-culled buckets prepared since the last call, testing rows in view against the
	 * depth the main pass left last frame. call every frame, before anything draws meshes, so it knows which
	 * camera the depth was drawn with
	 *
	 * @param encoder the frame's encoder
	 * @param frame this frame's unjittered camera and the render size's aspect, the depth buffer (still holding
	 *   last frame's depth) and its size, and whether to test rows against it
	 */
	cull(
		encoder: GPUCommandEncoder,
		frame: {
			camera: Camera;
			aspect: number;
			depth: { view: GPUTextureView; width: number; height: number };
			occlusion: boolean;
		},
	): void {
		const previous = this.#previous;
		this.#history.write(previous, frame.camera, frame.aspect);
		const culler = this.#culler;
		if (culler !== null) {
			let occlusion: Occlusion | null = null;
			const eyeDelta = [previous[16], previous[17], previous[18]] as const;
			// a 1 in the history's 20th float: no last frame to test against
			if (
				culler.pending &&
				frame.occlusion &&
				previous[19] === 0 &&
				Math.hypot(...eyeDelta) < OCCLUSION_MAX_MOVE &&
				this.#pyramid.encode(encoder, frame.depth)
			) {
				const pyramid = this.#pyramid.extent;
				if (pyramid !== null) {
					occlusion = { pyramid, previous: previous.subarray(0, 16), eyeDelta, near: frame.camera.near };
				}
			}
			culler.encode(encoder, occlusion);
		}
		this.#history.advance();
	}

	/**
	 * reduces the mip feedback the main pass's meshes wrote, which {@link mips} reports a few frames later;
	 * encode after the main pass, and call {@link afterSubmit} once the frame is submitted
	 *
	 * @param encoder the frame's encoder
	 * @param feedback the main pass's mip feedback target and its size
	 * @param frame the frame counter
	 */
	encodeMipFeedback(
		encoder: GPUCommandEncoder,
		feedback: { view: GPUTextureView; width: number; height: number },
		frame: number,
	): void {
		this.#mips.encode(encoder, feedback, this.#looks.count, frame);
	}

	/** starts the readbacks of the frame just submitted */
	afterSubmit(): void {
		this.#mips.afterSubmit();
	}

	// #endregion

	// #region prepare

	/** draws nothing this frame */
	clear(): void {
		this.#drawCount = 0;
		this.#sortedRuns.length = 0;
		this.instanceCount = 0;
		this.triangles = 0;
		this.texturedDraws = 0;
		this.transparentReadsBackground = false;
		this.transparentWritesDepth = false;
		this.#drawnSkins.clear();
		this.#looks.clearFrame();
	}

	/**
	 * writes this frame's draw parameters.
	 *
	 * @param buckets this frame's mesh buckets
	 * @param spans where `InstanceRenderer.prepareList` placed each bucket's rows in the visible list, by index
	 *   into `buckets`
	 * @param textures the package's textures
	 * @param work the rows left for the GPU to cull, whose buckets are among `buckets`
	 */
	prepare(
		buckets: readonly MeshBucket[],
		spans: readonly ListedSpan[],
		textures: TextureStore,
		work: GpuCullWork,
	): void {
		this.clear();
		const culler = work.buckets.length > 0 ? this.#culler : null;
		culler?.begin(work.buckets.length);
		for (const range of this.#ranges) {
			range.entries.length = 0;
		}
		let entries = 0;
		for (let b = 0; b < buckets.length; b++) {
			const bucket = buckets[b];
			const span = spans[b];
			if (span.count === 0 || bucket.geometry.resident?.kind !== 'geometry') {
				continue;
			}
			const look = bucket.look;
			const state = this.#materials.state(bucket.material, look, textures);
			const range = drawRangeOf(look, { castOnly: bucket.castOnly, stencil: this.#stencil, state });
			if (range === null) {
				continue;
			}
			const preparedRange = this.#range(range);
			const pipelineKey = pipelineKeyOf(bucket);
			// pipelineThenNearest never reads entry.key
			const key = preparedRange.info.order === 'pipelineThenNearest' ? 0 : sortKeyOf(bucket, pipelineKey);
			const entry = this.#entries[entries];
			if (entry === undefined) {
				this.#entries[entries] = { bucket, span, state, pipelineKey, key, nearest: bucket.nearest };
			} else {
				entry.bucket = bucket;
				entry.span = span;
				entry.state = state;
				entry.pipelineKey = pipelineKey;
				entry.key = key;
				entry.nearest = bucket.nearest;
			}
			preparedRange.entries.push(this.#entries[entries]);
			entries++;
		}

		let listStart = LIST_CAPACITY;
		let listEnd = 0;
		let d = 0;
		for (const range of this.#ranges) {
			range.entries.sort(COMPARATORS[range.info.order]);
			range.start = d;
			range.castOnlyEnd = d;
			range.castersEnd = d;
			for (const { bucket, span, state } of range.entries) {
				if (d >= MAX_DRAWS || !this.#prepareDraw(d, bucket, span, range.info, state)) {
					continue;
				}
				// the GPU writes its buckets' draw ids
				if (bucket.gpu === null) {
					listStart = Math.min(listStart, span.first);
					listEnd = Math.max(listEnd, span.first + span.count);
				}
				d++;
				if (bucket.look.castsShadows) {
					range.castersEnd = d;
				}
				if (bucket.castOnly) {
					range.castOnlyEnd = d;
				}
			}
			range.end = d;
		}
		this.#drawCount = d;
		this.#prepareSorted();
		this.#looks.flush();
		if (this.#looks.version !== this.#looksVersion) {
			this.#drawGroup = this.#createDrawGroup();
		}
		if (d > 0) {
			const queue = this.#device.queue;
			queue.writeBuffer(this.#params, 0, this.#paramData, 0, d * DRAW_FLOATS);
			if (listEnd > listStart) {
				queue.writeBuffer(this.#drawIds, listStart * 4, this.#drawIdData, listStart, listEnd - listStart);
			}
		}
		if (culler !== null) {
			culler.commit(work);
			// as last read back, a few frames late
			this.instanceCount += culler.instances;
			this.triangles += culler.triangles;
		}
	}

	/** orders the transparent pass's draws into {@link #sortedRuns} */
	#prepareSorted(): void {
		const runs = this.#sortedRuns;
		const sources = this.#sortedSources;
		const drawsOf = this.#sortedDraws;
		const phasesOf = this.#sortedPhases;
		runs.length = 0;
		let s = 0;
		for (const [p, phase] of PASS_PHASES.transparent.entries()) {
			const range = this.#range(phase.range);
			for (let i = range.castOnlyEnd; i < range.end; i++) {
				const draw = this.#draws[i];
				if (draw.stencil?.replace === true || draw.distances.length === 0) {
					runs.push(i, 0, draw.count, p);
					continue;
				}
				const source = sources[s];
				const count = Math.min(draw.count, draw.distances.length);
				if (source === undefined) {
					sources.push({ bands: draw.bands, distances: draw.distances, count });
				} else {
					source.bands = draw.bands;
					source.distances = draw.distances;
					source.count = count;
				}
				drawsOf[s] = i;
				phasesOf[s] = p;
				s++;
			}
		}
		sources.length = s;
		const merged = this.#merged;
		mergeFarToNear(sources, merged);
		for (let m = 0; m < merged.length; m += 3) {
			const source = merged[m];
			runs.push(drawsOf[source], merged[m + 1], merged[m + 2], phasesOf[source]);
		}
	}

	/** @returns the prepared range of a draw range */
	#range(range: DrawRange): PreparedRange {
		const prepared = this.#rangeOf.get(range);
		if (prepared === undefined) {
			throw new Error(`draw range ${range} isn't in DRAW_RANGES`);
		}
		return prepared;
	}

	/**
	 * writes the parameters of a bucket's draw and counts its instances in the stats
	 *
	 * @returns whether it draws (its submesh is resident)
	 */
	#prepareDraw(
		d: number,
		bucket: MeshBucket,
		span: ListedSpan,
		info: DrawRangeInfo,
		state: MaterialState,
	): boolean {
		const resident = bucket.geometry.resident;
		const range = resident?.kind === 'geometry' ? resident.submeshes[bucket.submesh] : undefined;
		if (resident?.kind !== 'geometry' || range === undefined) {
			return false;
		}
		const look = bucket.look;
		const lookSlot = this.#looks.ensure(bucket.material, look);
		if (lookSlot < 0) {
			return false;
		}
		if (look.readsBackground && SORTED_RANGES.has(info.range)) {
			this.transparentReadsBackground = true;
		}
		if (info.range === 'transparentDepthWrite' || info.range === 'transparentDepthOnly') {
			this.transparentWritesDepth = true;
		}
		if (resident.skin !== null) {
			this.#drawnSkins.add(resident.skin);
		}
		const params = this.#paramData;
		const words = this.#paramWords;
		const at = d * DRAW_FLOATS;
		const po = resident.positionOffset;
		const ps = resident.positionScale;
		params[at] = po[0];
		params[at + 1] = po[1];
		params[at + 2] = po[2];
		words[at + 3] = state.flags | resident.streamFlags;
		params[at + 4] = ps[0];
		params[at + 5] = ps[1];
		params[at + 6] = ps[2];
		words[at + 7] = lookSlot | (state.extraFlags << 16);
		const uv0 = resident.uvTransforms[0];
		params[at + 8] = uv0[0];
		params[at + 9] = uv0[1];
		params[at + 10] = uv0[2];
		params[at + 11] = uv0[3];
		const uv1 = resident.uvTransforms[1];
		params[at + 12] = uv1[0];
		params[at + 13] = uv1[1];
		params[at + 14] = uv1[2];
		params[at + 15] = uv1[3];
		const gpu = bucket.gpu;
		const culled = this.#culled;
		if (gpu === null) {
			this.#drawIdData.fill(d, span.first, span.first + span.count);
		} else if (this.#culler !== null) {
			// the span holds the rows in view, then each layer's casters, as far as it reaches
			const end = span.first + span.count;
			culled.first = span.first;
			culled.room = Math.min(gpu.rows, span.count);
			let next = span.first + culled.room;
			for (let layer = 0; layer < SHADOW_LAYERS; layer++) {
				culled.layerFirst[layer] = next;
				culled.layerRoom[layer] = Math.min(gpu.layerRows[layer], end - next);
				next += culled.layerRoom[layer];
			}
			culled.draw = d;
			culled.indexCount = range.indexCount;
			culled.firstIndex = range.firstIndex;
			culled.baseVertex = range.baseVertex;
			this.#culler.setBucket(gpu.index, culled);
		}
		const indirect = gpu === null ? -1 : gpu.index * INDIRECT_WORDS * 4;
		const count = gpu === null ? span.count : culled.room;

		// an effect's group also binds the main pass's outputs, so it's built when its pass encodes
		const material = info.effect ? null : state.group;
		const effect = info.effect ? state : null;
		const variant = bucket.cullIndex * 4 + resident.formatVariant;
		const draw = this.#draws[d];
		if (draw === undefined) {
			this.#draws[d] = {
				geometry: resident,
				indexCount: range.indexCount,
				firstIndex: range.firstIndex,
				baseVertex: range.baseVertex,
				first: span.first,
				count,
				layerCounts: span.layerCounts,
				indirect,
				layerRooms: gpu === null ? [] : [...culled.layerRoom],
				material,
				variant,
				effect,
				stencil: look.stencil,
				distances: bucket.distances,
				bands: bucket.bands,
				fading: bucket.fading,
				vertexTextured: look.params[SwayRow.kind] === SwayKind.Mushroom,
			};
		} else {
			draw.geometry = resident;
			draw.indexCount = range.indexCount;
			draw.firstIndex = range.firstIndex;
			draw.baseVertex = range.baseVertex;
			draw.first = span.first;
			draw.count = count;
			draw.layerCounts = span.layerCounts;
			draw.indirect = indirect;
			if (gpu !== null) {
				for (let layer = 0; layer < SHADOW_LAYERS; layer++) {
					draw.layerRooms[layer] = culled.layerRoom[layer];
				}
			}
			draw.material = material;
			draw.variant = variant;
			draw.effect = effect;
			draw.stencil = look.stencil;
			draw.distances = bucket.distances;
			draw.bands = bucket.bands;
			draw.fading = bucket.fading;
			draw.vertexTextured = look.params[SwayRow.kind] === SwayKind.Mushroom;
		}
		if (!bucket.castOnly && gpu === null) {
			this.instanceCount += span.count;
			this.triangles += (span.count * range.indexCount) / 3;
			if (state.slots[0] !== null) {
				this.texturedDraws++;
			}
		}
		return true;
	}

	// #endregion

	// #region encode

	/**
	 * @param which the pass
	 * @returns whether this frame has draws in the pass, so it needs to be run
	 */
	has(which: MeshPass): boolean {
		return PASS_PHASES[which].some((phase) => {
			const range = this.#range(phase.range);
			return range.end > range.start;
		});
	}

	/**
	 * encodes a pass over the main pass's targets, with group 0 bound: `prepass` lays down the opaque meshes'
	 * depth, so call it before anything else draws into the main pass, then `main`
	 *
	 * @param which the pass
	 * @param pass the main pass
	 * @returns draw calls issued
	 */
	encodePass(which: SurfacePass, pass: GPURenderPassEncoder): number {
		// opaque effect layers draw into the outputs they'd read, which stand-ins take the place of
		this.#bindEffectGroups(which, this.#materials.mainPassStandIns);
		return this.#encode(which, pass, -1);
	}

	/**
	 * encodes a pass of scene effects, with group 0 bound. in frame order:
	 *
	 * - `relight` adds the light that relit decals change to the main pass's radiance and sky reflection, both
	 *   kept (`load`), and writes the surface they leave into the cleared decal surface, the attachments in
	 *   that order (`SceneTextures.decalSurface`)
	 * - `decals` lays lit decals over the composited scene, into a pass as `multiply`'s, before the water draws
	 * - `transparent` into the transparent pass, with the main pass's depth attached read-only
	 * - `waterFoam` draws the WaterDecal boxes into a pass whose only colour attachment is the foam target
	 *   (`WATER_FOAM_FORMAT`), cleared to (0, 0, 0, 1), with the main pass's depth attached read-only; `inputs`
	 *   hold the water surface's depth in place of the scene's
	 * - `multiply` multiplies the composited scene, into a pass whose only colour attachment is the composited
	 *   scene, kept (`load`), with the main pass's depth attached read-only
	 * - `refractOpaque` replaces the composited scene with refracting effects' colour, into a pass as
	 *   `multiply`'s but with the main pass's depth writable; `inputs` must have the composited scene's copy as
	 *   their `background`, and their depth is ignored, since the pass writes it
	 * - `refract` blends refracting effects over the composited scene, into a pass as `multiply`'s; `inputs` must
	 *   have the composited scene's copy as their `background`
	 *
	 * @param which the pass
	 * @param pass the pass
	 * @param inputs the main pass's outputs, which the effects read
	 * @returns draw calls issued
	 */
	encodeEffectPass(which: EffectPass, pass: GPURenderPassEncoder, inputs: EffectInputs): number {
		// a pass can't sample the depth it writes; an opaque refraction's alpha, which is all the depth feeds, is
		// thrown away
		const read =
			which === 'refractOpaque' ? { ...inputs, depth: this.#materials.mainPassStandIns.depth } : inputs;
		this.#bindEffectGroups(which, read);
		return this.#encode(which, pass, -1);
	}

	/** builds the groups of a pass's effect draws, which also bind the main pass's outputs */
	#bindEffectGroups(which: MeshPass, inputs: EffectInputs): void {
		for (const phase of PASS_PHASES[which]) {
			const range = this.#range(phase.range);
			if (!range.info.effect) {
				continue;
			}
			for (let i = range.start; i < range.end; i++) {
				const draw = this.#draws[i];
				if (draw.effect !== null) {
					draw.material = this.#materials.effectGroup(draw.effect, inputs);
				}
			}
		}
	}

	/**
	 * draws this frame's meshes into a shadow cascade.
	 *
	 * @param pass a shadow pass, with group 0 bound
	 * @param layer the shadow layer, which draws only the instances that can cast into it
	 * @returns draw calls issued
	 */
	encodeShadow(pass: GPURenderPassEncoder, layer: number): number {
		return this.#encode('shadow', pass, layer);
	}

	/**
	 * draws this frame's meshes into a local-light shadow tile.
	 *
	 * @param pass a local-light shadow pass, with group 0 bound
	 * @param layer the shadow layer whose casters are drawn (the far static layer)
	 * @returns draw calls issued
	 */
	encodeLightShadow(pass: GPURenderPassEncoder, layer: number): number {
		return this.#encode('lightShadow', pass, layer);
	}

	/**
	 * encodes a pass's phases in order; draws whose pipeline is still compiling are skipped until ready.
	 * `layer` limits each draw to the rows that shadow layer draws, or is -1 for all of them
	 */
	#encode(which: MeshPass, pass: GPURenderPassEncoder, layer: number): number {
		if (this.#drawCount === 0) {
			return 0;
		}
		pass.setBindGroup(1, this.#instances.bindGroup);
		pass.setBindGroup(2, this.#drawGroup);
		this.#vertexBindings.reset();
		const state: EncodeState = {
			phase: null,
			variant: -1,
			fading: false,
			stencil: null,
			reference: -1,
			vertices: null,
			indices: null,
			material: null,
		};
		let draws = 0;
		if (which === 'transparent') {
			const phases = PASS_PHASES.transparent;
			const runs = this.#sortedRuns;
			for (let r = 0; r < runs.length; r += 4) {
				const draw = this.#draws[runs[r]];
				if (
					this.#encodeDraw(pass, state, phases[runs[r + 3]], draw, {
						first: draw.first + runs[r + 1],
						count: runs[r + 2],
						layer,
					})
				) {
					draws++;
				}
			}
			return draws;
		}
		for (const phase of PASS_PHASES[which]) {
			const range = this.#range(phase.range);
			// shadow passes draw the casters, cast-only ones first; the rest skip those
			const from = phase.shadow ? range.start : range.castOnlyEnd;
			const to = phase.shadow ? range.castersEnd : range.end;
			for (let i = from; i < to; i++) {
				const draw = this.#draws[i];
				let count = 0;
				if (draw.indirect < 0) {
					count = layer < 0 ? draw.count : draw.layerCounts[layer];
				} else if (layer < 0) {
					count = draw.count;
				} else {
					count = draw.layerRooms[layer] ?? 0;
				}
				if (this.#encodeDraw(pass, state, phase, draw, { first: draw.first, count, layer })) {
					draws++;
				}
			}
		}
		return draws;
	}

	/**
	 * encodes one draw of a phase, binding what changed since the last
	 *
	 * @param first the first row's list offset
	 * @param count how many rows from it, for listed rows
	 * @param layer the shadow layer, -1 for the rows in view
	 * @returns whether it drew
	 */
	#encodeDraw(
		pass: GPURenderPassEncoder,
		state: EncodeState,
		phase: DrawPhase,
		draw: PreparedDraw,
		{ first, count, layer }: { first: number; count: number; layer: number },
	): boolean {
		// only an effect drawn outside its pass would lack its group
		if (draw.material === null || count === 0) {
			return false;
		}
		// each phase has its own pipelines and reads its own vertex streams
		if (phase !== state.phase) {
			state.phase = phase;
			state.variant = -1;
			state.fading = false;
			state.stencil = null;
			state.vertices = null;
			state.material = null;
		}
		const useFade = phase.key === 'mesh/prepass' && draw.fading;
		if (draw.variant !== state.variant || useFade !== state.fading || draw.stencil !== state.stencil) {
			const pipeline = this.#meshPipelines.get(phase, draw.variant, {
				fade: useFade,
				stencil: draw.stencil,
			});
			if (pipeline === undefined) {
				state.variant = -1;
				return false;
			}
			pass.setPipeline(pipeline);
			if (draw.stencil !== null && draw.stencil.reference !== state.reference) {
				state.reference = draw.stencil.reference;
				pass.setStencilReference(state.reference);
			}
			state.variant = draw.variant;
			state.fading = useFade;
			state.stencil = draw.stencil;
		}
		if (
			(phase.textured || draw.vertexTextured || state.material === null) &&
			draw.material !== state.material
		) {
			state.material = draw.material;
			pass.setBindGroup(3, draw.material);
		}
		// pooled geometries share buffers, so this binds again only past a pool or an animated geometry
		const { vertices, indices } = draw.geometry;
		if (vertices !== state.vertices) {
			state.vertices = vertices;
			this.#vertexBindings.bind(pass, vertices, phase.streams);
		}
		if (indices !== state.indices) {
			state.indices = indices;
			pass.setIndexBuffer(indices.buffer, indices.format);
		}
		if (draw.indirect < 0) {
			pass.drawIndexed(draw.indexCount, count, draw.firstIndex, draw.baseVertex, first);
		} else if (this.#culler !== null) {
			// the draw of the rows in view, then one per shadow layer, 5 words each
			pass.drawIndexedIndirect(this.#culler.indirect, draw.indirect + (layer < 0 ? 0 : (1 + layer) * 20));
		}
		return true;
	}

	// #endregion
}
