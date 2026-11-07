import type { GeometryEntry } from '@endfield-noclip/package-format/geometry';
import type { Chain } from '@endfield-noclip/package-format/instances';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { CULL_FLOATS, ROW_WORDS } from '../content/instance-rows.ts';
import { type MaterialLook, alphaTextureOf } from '../looks/look.ts';
import type { ParticleField, ParticleView } from '../particles/particle-rows.ts';
import { SHADOW_LAYERS, type ShadowLayerVolumes } from '../render/shadows/shadow-map.ts';
import type { TextureStore } from '../render/textures/texture-store.ts';
import type { Plane } from '../scene/camera.ts';

import {
	type GpuCullWork,
	ItemFlags,
	NO_BUCKET,
	SlotFlags,
	addItem,
	addSlot,
	gpuCullWork,
	writeCullView,
} from './gpu-cull-work.ts';
import { firstRunAt, firstShadowLayer, sphereInPlanes, sphereInsidePlanes } from './instance-culling.ts';
import {
	BUCKET_LIFETIME,
	type ChainSlot,
	type MeshBucket,
	MeshBuckets,
	bucketIndex,
	gpuBucketIndex,
	slotHidden,
	sortFarToNear,
} from './mesh-buckets.ts';
import type { ResidentInstances } from './resident.ts';
import {
	GROUP_FLOATS,
	GROUP_ROWS,
	GroupFloat,
	SEGMENT_FLOATS,
	SegmentFloat,
	buildRowGroups,
	chainReach,
	groupSegmentsOf,
	mirroredRows,
} from './row-groups.ts';
import type { CasterVolume, InstanceRange } from './selection.ts';
import type { StreamManager } from './stream-manager.ts';
import { TextureRequests } from './texture-requests.ts';

/** this frame's mesh selection, reused across frames */
export interface MeshSelection {
	buckets: MeshBucket[];
	/** rows drawn as boxes (geometry pending or not converted) */
	boxes: number[];
	/** whether it draws emitters' particles, which move with the clock while the view holds still */
	particles: boolean;
	/** the rows left for the GPU to cull, whose buckets are among {@link buckets} too */
	gpu: GpuCullWork;
}

/** camera inputs */
export interface MeshView {
	eye: Vec3;
	planes: readonly Plane[];
	pixelFactor: number;
	viewportHeight: number;
	/** cull instances smaller than this, px */
	minPixels: number;
	/** mip levels coarser than needed to stream material textures at (0 for full detail; each halves their size) */
	textureBias: number;
	/** select draws of materials in the unsupported look; off skips them as if their chains lacked them */
	unsupportedMaterials: boolean;
	/** select `DrawRole.Unsupported` stand-ins; off skips them likewise */
	missingContent: boolean;
	/** instances outside the view but in this volume are selected as shadow casters; `null` for none */
	casters: CasterVolume | null;
	/** the shadow layers instances are grouped by; `null` without shadows */
	shadowLayers: ShadowLayerVolumes | null;
	/** the clock and camera axes particles are placed by */
	particles: ParticleView;
	/** leave the rows of groups whose LODs are all resident for the GPU to cull ({@link GpuCullWork}) */
	gpuCulling: boolean;
}

/** what the selector reads */
export interface MeshSelectorInit {
	/** LOD-chain templates */
	chains: readonly Chain[];
	/** the geometry table */
	geometries: readonly GeometryEntry[];
	/** by material id, from `materialLooks` */
	looks: readonly MaterialLook[];
	stream: StreamManager;
	textures: TextureStore;
	/** writes the rows of emitters' particles */
	particles: ParticleField;
}

/** priority multiplier for shadow casters outside the view */
const CASTER_PRIORITY = 0.1;
/** shadow casters outside the view smaller than this are culled, px (as if on screen) */
const CASTER_MIN_PIXELS = 16;
/**
 * how far a group's LOD bands are widened when picking the LODs its rows can reach, as a factor of the
 * squared metric: the GPU measures rows in f32, so a row at a band's edge may land on either side
 */
const BAND_SLACK = 1.02;
/**
 * a segment whose row centres spread wider than this fraction of their distance is measured row by row: its
 * bound puts its largest row at its nearest centre, which near the camera rates rows far beyond their size on
 * screen, and so streams their textures at full detail
 */
const LOOSE_SEGMENT = 0.25;

/**
 * @param slot the slot whose LOD band rows are drawn in
 * @param viewportHeight px
 * @returns the most pixels a row in the slot's band can cover: the band's upper edge
 */
const bandPixels = (slot: ChainSlot, viewportHeight: number): number =>
	Math.sqrt(slot.maxSquared) * viewportHeight;

/** @returns a number standing for the view options {@link slotHidden} reads */
const slotFilterKey = (view: MeshView): number =>
	(view.unsupportedMaterials ? 1 : 0) | (view.missingContent ? 2 : 0);

/**
 * a caster reaches every layer from the first its bounds reach on (each takes in the volumes of those
 * before); of those, the sharp cascades take realtime casters and the far layer static ones, as the game's
 * maps do
 *
 * @param slot the slot that draws the rows
 * @param first the first shadow layer the rows' bounds reach, {@link SHADOW_LAYERS} for none
 * @returns a bit per shadow layer the slot's rows can cast into
 */
const casterLayerBits = (slot: ChainSlot, first: number): number => {
	if (!slot.castsShadows) {
		return 0;
	}
	let bits = 0;
	for (let layer = first; layer < SHADOW_LAYERS; layer++) {
		if (layer === SHADOW_LAYERS - 1 ? slot.castsStatic : slot.castsRealtime) {
			bits |= 1 << layer;
		}
	}
	return bits;
};

/** what a resident block's selection reuses from frame to frame */
interface SelectedBlock {
	/** its row groups' bounds, from `buildRowGroups` */
	groups: Float32Array;
	/** 1 per mirrored row */
	mirrored: Uint8Array;
	/** per chain run: its chain's drawn slots */
	allSlots: ChainSlot[][];
	/** per chain run: the slots the view's options show ({@link slotHidden}), for {@link filter} */
	slots: ChainSlot[][];
	/** the view options {@link slots} were filtered for, from {@link slotFilterKey}; -1 before the first */
	filter: number;
	/** per chain run: 1 when its instances draw their box while no LOD is resident */
	boxes: Uint8Array;
	/** per chain run: its chain's distance origin, for `CameraDistance` chains */
	origins: (Vec3 | null)[];
	/** per chain run: 1 when the GPU can cull its rows (every shown slot {@link ChainSlot.gpuCullable}) */
	gpuRuns: Uint8Array;
	/** each group's rows split by chain run, from `groupSegmentsOf` */
	segments: Float32Array;
	/** per group, where its segments start; one more entry ends the last */
	groupSegments: Uint32Array;
}

/** the group {@link MeshSelector.run} hands to the GPU path, as it tested it */
interface CulledGroup {
	/** the rows of the selected range in it */
	first: number;
	end: number;
	inside: boolean;
	/** whether the group's bounds touch the view; if not, its rows can only cast shadows */
	inView: boolean;
	/** the first shadow layer its bounds reach */
	layer: number;
}

/** selects LODs and buckets instances */
export class MeshSelector {
	readonly selection: MeshSelection = { buckets: [], boxes: [], particles: false, gpu: gpuCullWork() };
	#chains: readonly Chain[];
	#geometries: readonly GeometryEntry[];
	#stream: StreamManager;
	#textures: TextureRequests;
	#particles: ParticleField;
	#buckets: MeshBuckets;
	#frame = 0;
	/** per geometry: the frame {@link #geometryReady} last looked it up */
	#checkedFrame: Int32Array;
	/** per geometry: whether it was resident that frame */
	#ready: Uint8Array;
	/** per geometry: the highest priority it was wanted with that frame */
	#wanted: Float64Array;
	/** this frame's camera inputs, for {@link #selectRows} */
	#view: MeshView | null = null;
	#planes = new Float64Array(4 * 5);
	/** floats of {@link #planes} in use this frame */
	#planeFloats = 0;
	#casterPlanes = new Float64Array(4 * 5);
	/** floats of {@link #casterPlanes} in use this frame, 0 without casters */
	#casterFloats = 0;
	#casterDistance = 0;
	#pending: ChainSlot[] = [];
	/** the block being selected's origin relative to the eye, for {@link #selectRows} */
	#ox = 0;
	#oy = 0;
	#oz = 0;
	/** what each resident block's selection reuses, built on its first selection */
	readonly #blocks = new WeakMap<ResidentInstances, SelectedBlock>();
	/** per chain, its reach per metre of size ({@link chainReach}), `NaN` until first asked */
	readonly #reaches: Float64Array;
	/** the group being handed to {@link #cullGroup} */
	readonly #group: CulledGroup = {
		first: 0,
		end: 0,
		inside: false,
		inView: false,
		layer: 0,
	};
	/** what {@link #gpuBucket} adds, reused */
	readonly #room = { inView: 0, layers: 0, rows: 0, priority: 0 };
	/** the slots a segment's rows can reach, from {@link #cullGroup} */
	readonly #candidates: ChainSlot[] = [];
	/**
	 * the segment {@link #addSlot} adds to: its rows, handedness bits, priority, nearest row centre and the
	 * first shadow layer its bounds reach
	 */
	readonly #segment = { rows: 0, handedness: 0, priority: 0, nearest: 0, layer: 0 };
	/** a slot entry's buckets, reused */
	readonly #pair: [unmirrored: number, mirrored: number] = [0, 0];
	/** the geometries asked about this frame, wanted at their highest priority once the selection is done */
	readonly #asked: number[] = [];

	/** @param init tables and residency */
	constructor(init: MeshSelectorInit) {
		this.#chains = init.chains;
		this.#geometries = init.geometries;
		this.#stream = init.stream;
		this.#textures = new TextureRequests(init.stream, init.textures);
		this.#particles = init.particles;
		this.#buckets = new MeshBuckets(init);
		const count = init.geometries.length;
		this.#checkedFrame = new Int32Array(count).fill(-1);
		this.#ready = new Uint8Array(count);
		this.#wanted = new Float64Array(count);
		this.#reaches = new Float64Array(init.chains.length).fill(Number.NaN);
	}

	/**
	 * @param ranges the instance ranges the tree traversal selected
	 * @param view camera inputs
	 * @returns buckets and box fallbacks (the same object every frame)
	 */
	run(ranges: readonly InstanceRange[], view: MeshView): MeshSelection {
		const frame = ++this.#frame;
		const selection = this.selection;
		selection.buckets.length = 0;
		selection.boxes.length = 0;
		selection.particles = false;
		const work = selection.gpu;
		work.itemCount = 0;
		work.slotCount = 0;
		work.buckets.length = 0;
		this.#view = view;
		const { eye, pixelFactor, viewportHeight, minPixels, casters } = view;
		const planes = this.#planes;
		const planeFloats = Math.min(view.planes.length * 4, planes.length);
		for (let p = 0; p < planeFloats; p++) {
			planes[p] = view.planes[p >> 2][p & 3];
		}
		this.#planeFloats = planeFloats;
		const casterPlanes = this.#casterPlanes;
		let casterFloats = 0;
		if (casters !== null) {
			casterFloats = Math.min(casters.planes.length * 4, casterPlanes.length);
			for (let p = 0; p < casterFloats; p++) {
				casterPlanes[p] = casters.planes[p >> 2][p & 3];
			}
			this.#casterDistance = casters.distance;
		}
		this.#casterFloats = casterFloats;
		writeCullView(work, {
			planes,
			planeFloats,
			casterPlanes,
			casterFloats,
			casterDistance: this.#casterDistance,
			casterMinPixels: CASTER_MIN_PIXELS,
			pixelFactor,
			viewportHeight,
			minPixels,
			shadowLayers: view.shadowLayers,
		});
		const reachScale = pixelFactor / viewportHeight;
		const filter = slotFilterKey(view);

		for (const { item, first, count } of ranges) {
			const instances = item.resident;
			if (instances?.kind !== 'instances') {
				continue;
			}
			const ox = (this.#ox = instances.origin[0] - eye[0]);
			const oy = (this.#oy = instances.origin[1] - eye[1]);
			const oz = (this.#oz = instances.origin[2] - eye[2]);
			const block = this.#blockOf(instances);
			if (block.filter !== filter) {
				block.slots = block.allSlots.map((slots) => slots.filter((slot) => !slotHidden(slot, view)));
				// effect distance bands, particles and the queues drawn in order stay on the CPU
				block.gpuRuns = Uint8Array.from(block.slots, (slots, r) =>
					slots.length > 0 && block.origins[r] === null && slots.every((slot) => slot.gpuCullable) ? 1 : 0,
				);
				block.filter = filter;
			}
			const groups = block.groups;
			const end = first + count;
			for (let g = Math.floor(first / GROUP_ROWS); g * GROUP_ROWS < end; g++) {
				// each of #selectRows' rejections, tested on the group's bounds: a group that fails one holds no row
				// that passes it
				const at = g * GROUP_FLOATS;
				const gx = ox + groups[at + GroupFloat.center];
				const gy = oy + groups[at + GroupFloat.center + 1];
				const gz = oz + groups[at + GroupFloat.center + 2];
				const centre = Math.sqrt(gx * gx + gy * gy + gz * gz);
				const nearest = Math.max(centre - groups[at + GroupFloat.centersRadius], 0.1);
				const rowPixels = (groups[at + GroupFloat.rowRadius] * pixelFactor) / nearest;
				if (rowPixels < minPixels || nearest > groups[at + GroupFloat.reach] * reachScale) {
					continue;
				}
				const radius = groups[at + GroupFloat.radius];
				const inView = sphereInPlanes(planes, planeFloats, gx, gy, gz, radius);
				if (
					!inView &&
					(casterFloats === 0 ||
						rowPixels < CASTER_MIN_PIXELS ||
						!sphereInPlanes(casterPlanes, casterFloats, gx, gy, gz, radius))
				) {
					continue;
				}
				// every row of a group wholly in view is in view too
				const inside = inView && sphereInsidePlanes(planes, planeFloats, gx, gy, gz, radius);
				const rowFirst = Math.max(first, g * GROUP_ROWS);
				const rowEnd = Math.min(end, (g + 1) * GROUP_ROWS);
				// a group holding moving rows has no bounds to pick its LODs by
				if (view.gpuCulling && radius !== Infinity) {
					const group = this.#group;
					group.first = rowFirst;
					group.end = rowEnd;
					group.inside = inside;
					group.inView = inView;
					group.layer =
						view.shadowLayers === null
							? SHADOW_LAYERS
							: firstShadowLayer(view.shadowLayers, gx, gy, gz, radius);
					this.#cullGroup(instances, block, g);
				} else {
					this.#selectRows(instances, rowFirst, rowEnd, { inside, block });
				}
			}
		}

		this.#wantAsked();
		const texturePixels = 2 ** -view.textureBias;
		for (const bucket of selection.buckets) {
			const look = bucket.look;
			if (bucket.distances.length > 0) {
				sortFarToNear(bucket);
			}
			if (bucket.castOnly) {
				// a shadow needs only the texture holding the alpha it's cut out by
				const alpha = look.queue === 'cutout' ? alphaTextureOf(look) : -1;
				if (alpha >= 0) {
					this.#textures.forPixels(
						alpha,
						bucket.pixels * texturePixels,
						look.uvScales[look.textures.indexOf(alpha)],
					);
				}
				continue;
			}
			for (let i = 0; i < look.textures.length; i++) {
				if (look.textures[i] >= 0) {
					this.#textures.forPixels(look.textures[i], bucket.pixels * texturePixels, look.uvScales[i]);
				}
			}
			if (look.volumeTexture >= 0) {
				this.#textures.whole(look.volumeTexture, '3d', bucket.pixels);
			}
		}
		if (frame % BUCKET_LIFETIME === 0) {
			this.#buckets.prune(frame);
		}
		return selection;
	}

	/** @returns what the block's selection reuses, built on first use */
	#blockOf(instances: ResidentInstances): SelectedBlock {
		return this.#blocks.getOrInsertComputed(instances, () => {
			const runs = instances.runs;
			const runCount = runs.length / 3;
			const allSlots: ChainSlot[][] = [];
			const boxes = new Uint8Array(runCount);
			const origins: (Vec3 | null)[] = [];
			for (let r = 0; r < runCount; r++) {
				const chain = runs[r * 3];
				allSlots.push(this.#buckets.slots(chain));
				boxes[r] = this.#buckets.drawsBox(chain) ? 1 : 0;
				origins.push(this.#chains[chain].distanceOrigin);
			}
			const rowCount = instances.cull.length / CULL_FLOATS;
			const mirrored = mirroredRows(instances.rowsF32, rowCount);
			const { segments, groupSegments } = groupSegmentsOf(instances.rowsF32, runs, instances.cull, mirrored);
			return {
				groups: buildRowGroups(
					{
						rowsF32: instances.rowsF32,
						cull: instances.cull,
						runs: instances.runs,
						moving: instances.spins?.rows ?? null,
					},
					(chain) => this.#reach(chain),
				),
				mirrored,
				allSlots,
				slots: allSlots,
				filter: -1,
				boxes,
				origins,
				gpuRuns: new Uint8Array(runCount),
				segments,
				groupSegments,
			};
		});
	}

	/** @returns the chain's reach per metre of size, over every slot it may draw */
	#reach(chain: number): number {
		let reach = this.#reaches[chain];
		if (Number.isNaN(reach)) {
			let minSquared: number | null = null;
			for (const slot of this.#buckets.slots(chain)) {
				minSquared = minSquared === null ? slot.minSquared : Math.min(minSquared, slot.minSquared);
			}
			reach = chainReach(minSquared, this.#chains[chain].distanceOrigin !== null);
			this.#reaches[chain] = reach;
		}
		return reach;
	}

	/**
	 * hands the rows of {@link #group} (group `g` of the block) to the GPU, a segment at a time: it picks the
	 * slots whose LOD bands the segment's rows can reach from the group's distances and the rows' sizes, and
	 * requests their geometry. a LOD with a slot not resident is drawn by the nearest resident LOD's slots in
	 * its band, as {@link #selectRows} picks stand-ins. a segment of a run the GPU can't cull, or of rows that
	 * would draw their box, goes through {@link #selectRows}
	 */
	#cullGroup(instances: ResidentInstances, block: SelectedBlock, g: number): void {
		const view = this.#view;
		if (view === null) {
			return;
		}
		const group = this.#group;
		const { pixelFactor, viewportHeight } = view;
		const work = this.selection.gpu;
		const frame = this.#frame;
		const segments = block.segments;
		const candidates = this.#candidates;
		const castOnly = !group.inView;
		for (let s = block.groupSegments[g]; s < block.groupSegments[g + 1]; s++) {
			const at = s * SEGMENT_FLOATS;
			const first = Math.max(group.first, segments[at + SegmentFloat.first]);
			const end = Math.min(group.end, segments[at + SegmentFloat.end]);
			if (first >= end) {
				continue;
			}
			const run = segments[at + SegmentFloat.run];
			if (block.gpuRuns[run] === 0) {
				this.#selectRows(instances, first, end, { inside: group.inside, block });
				continue;
			}
			// the metric's widest range over the segment's rows: the largest nearest, the smallest farthest
			const sx = this.#ox + segments[at + SegmentFloat.center];
			const sy = this.#oy + segments[at + SegmentFloat.center + 1];
			const sz = this.#oz + segments[at + SegmentFloat.center + 2];
			const centre = Math.sqrt(sx * sx + sy * sy + sz * sz);
			const centersRadius = segments[at + SegmentFloat.centersRadius];
			const nearest = Math.max(centre - centersRadius, 0.1);
			const far = Math.max(centre + centersRadius, 0.1);
			const largest =
				centersRadius > centre * LOOSE_SEGMENT
					? this.#largestRelative(instances, first, end)
					: (2 * segments[at + SegmentFloat.maxSize] * pixelFactor) / (nearest * viewportHeight);
			const smallest = (2 * segments[at + SegmentFloat.minSize] * pixelFactor) / (far * viewportHeight);
			const high = largest * largest * BAND_SLACK;
			const low = (smallest * smallest) / BAND_SLACK;
			const scale = castOnly ? CASTER_PRIORITY : 1;
			const priority = largest * viewportHeight * scale;
			const slots = block.slots[run];
			let count = 0;
			let ready = true;
			for (const slot of slots) {
				if (slot.maxSquared < low || slot.minSquared >= high || (castOnly && !slot.castsShadows)) {
					continue;
				}
				candidates[count++] = slot;
				const slotPriority = Math.min(priority, bandPixels(slot, viewportHeight) * scale);
				if (!this.#geometryReady(slot.geometry, slotPriority, frame)) {
					ready = false;
				}
			}
			if (count === 0) {
				continue;
			}
			// rows with no LOD resident draw their box, which only listed rows can
			if (!ready && block.boxes[run] === 1 && !castOnly && this.#needsBox(slots, count)) {
				this.#selectRows(instances, first, end, { inside: group.inside, block });
				continue;
			}
			const rows = end - first;
			addItem(work, instances.alloc.start + first, rows, group.inside ? ItemFlags.Inside : 0);
			const segment = this.#segment;
			segment.rows = rows;
			segment.handedness = segments[at + SegmentFloat.handedness];
			segment.priority = priority;
			segment.nearest = nearest;
			// the segment's own sphere reaches fewer layers than its group's
			segment.layer =
				group.layer === SHADOW_LAYERS || view.shadowLayers === null
					? SHADOW_LAYERS
					: firstShadowLayer(view.shadowLayers, sx, sy, sz, segments[at + SegmentFloat.radius]);
			if (ready) {
				for (let c = 0; c < count; c++) {
					this.#addSlot(candidates[c], candidates[c]);
				}
				continue;
			}
			for (let c = 0; c < count; c++) {
				const lod = candidates[c].lod;
				if (this.#seenLod(count, c)) {
					continue;
				}
				let lodReady = true;
				for (let d = c; d < count; d++) {
					if (candidates[d].lod === lod && this.#ready[candidates[d].geometry] === 0) {
						lodReady = false;
					}
				}
				if (lodReady) {
					for (let d = c; d < count; d++) {
						if (candidates[d].lod === lod) {
							this.#addSlot(candidates[d], candidates[d]);
						}
					}
					continue;
				}
				// the stand-in's slots draw in the band of the LOD they stand in for
				const standIns = this.#residentLod(slots, lod, { castOnly });
				const band = candidates[c];
				for (let p = 0; p < standIns; p++) {
					this.#addSlot(band, this.#pending[p]);
				}
			}
		}
	}

	/**
	 * @returns the largest LOD metric (size relative to the screen height) of the block's rows `[first, end)`,
	 *   as {@link #selectRows} measures each row
	 */
	#largestRelative(instances: ResidentInstances, first: number, end: number): number {
		const view = this.#view;
		if (view === null) {
			return 0;
		}
		const f32 = instances.rowsF32;
		const cull = instances.cull;
		let largest = 0;
		for (let i = first; i < end; i++) {
			const at = i * ROW_WORDS;
			const x = this.#ox + f32[at + 12];
			const y = this.#oy + f32[at + 13];
			const z = this.#oz + f32[at + 14];
			const distance = Math.max(Math.sqrt(x * x + y * y + z * z), 0.1);
			largest = Math.max(largest, cull[i * CULL_FLOATS + 1] / distance);
		}
		return (2 * largest * view.pixelFactor) / view.viewportHeight;
	}

	/** @returns whether candidate `c` shares its LOD with an earlier one of the first `count` candidates */
	#seenLod(count: number, c: number): boolean {
		const lod = this.#candidates[c].lod;
		for (let d = 0; d < c && d < count; d++) {
			if (this.#candidates[d].lod === lod) {
				return true;
			}
		}
		return false;
	}

	/**
	 * @param slots the run's shown slots
	 * @param count candidates in {@link #candidates}
	 * @returns whether a candidate LOD has a slot not resident and no resident LOD to stand in for it
	 */
	#needsBox(slots: readonly ChainSlot[], count: number): boolean {
		for (let c = 0; c < count; c++) {
			if (
				this.#ready[this.#candidates[c].geometry] === 0 &&
				this.#residentLod(slots, this.#candidates[c].lod, { castOnly: false }) === 0
			) {
				return true;
			}
		}
		return false;
	}

	/**
	 * adds a slot entry for {@link #segment}'s item: `target`'s buckets, drawn by the rows in `band`'s LOD band
	 *
	 * @param band the slot whose band the rows are tested against
	 * @param target the slot that draws them: `band` itself, or its stand-in
	 */
	#addSlot(band: ChainSlot, target: ChainSlot): void {
		const { rows, handedness, priority } = this.#segment;
		const group = this.#group;
		const room = this.#room;
		room.inView = group.inView && !target.shadowOnly ? rows : 0;
		room.layers = casterLayerBits(target, this.#segment.layer);
		room.rows = rows;
		// rows drawn in a coarse LOD's band are small on screen, whatever the segment's largest row is
		const view = this.#view;
		const cap =
			view === null ? Infinity : bandPixels(band, view.viewportHeight) * (group.inView ? 1 : CASTER_PRIORITY);
		room.priority = Math.min(priority, cap);
		if (room.inView === 0 && room.layers === 0) {
			return;
		}
		const buckets = this.#pair;
		buckets[0] = (handedness & 1) === 0 ? NO_BUCKET : this.#gpuBucket(target, 0, room);
		buckets[1] = (handedness & 2) === 0 ? NO_BUCKET : this.#gpuBucket(target, 1, room);
		addSlot(
			this.selection.gpu,
			band,
			(target.castsShadows ? SlotFlags.Casts : 0) |
				(target.shadowOnly ? SlotFlags.ShadowOnly : 0) |
				(target.castsRealtime ? SlotFlags.Realtime : 0) |
				(target.castsStatic ? SlotFlags.Static : 0),
			buckets,
		);
	}

	/**
	 * makes room in a slot's GPU-culled bucket for a segment of {@link #group}
	 *
	 * @param room rows the segment may add in view, the layers it may cast into (bits) and its rows, and its
	 *   priority
	 * @returns the bucket's GPU index
	 */
	#gpuBucket(
		slot: ChainSlot,
		mirrored: 0 | 1,
		room: { inView: number; layers: number; rows: number; priority: number },
	): number {
		const index = gpuBucketIndex(mirrored, slot.shadowOnly);
		const bucket = slot.buckets[index] ?? this.#buckets.bucketOf(slot, index);
		const gpu = bucket.gpu;
		if (gpu === null) {
			throw new Error('a GPU bucket index named a bucket of listed rows');
		}
		const work = this.selection.gpu;
		if (bucket.frame !== this.#frame) {
			bucket.frame = this.#frame;
			bucket.pixels = 0;
			bucket.nearest = Infinity;
			gpu.index = work.buckets.length;
			gpu.rows = 0;
			gpu.layerRows.fill(0);
			work.buckets.push(bucket);
			this.selection.buckets.push(bucket);
		}
		gpu.rows += room.inView;
		for (let layer = 0; layer < SHADOW_LAYERS; layer++) {
			if ((room.layers & (1 << layer)) !== 0) {
				gpu.layerRows[layer] += room.rows;
			}
		}
		if (room.priority > bucket.pixels) {
			bucket.pixels = room.priority;
		}
		const nearest = this.#segment.nearest;
		if (nearest < bucket.nearest) {
			bucket.nearest = nearest;
		}
		return gpu.index;
	}

	/**
	 * culls, LOD-selects and buckets a block's rows `[first, end)` for this frame's view, the block's origin
	 * relative to the eye being {@link #ox}, {@link #oy}, {@link #oz}
	 *
	 * @param group `inside` when the rows' group is wholly in view, so no row needs the frustum test, and what
	 *   the block's selection reuses
	 */
	#selectRows(
		instances: ResidentInstances,
		first: number,
		end: number,
		{ inside, block }: { inside: boolean; block: SelectedBlock },
	): void {
		const view = this.#view;
		if (view === null) {
			return;
		}
		const ox = this.#ox;
		const oy = this.#oy;
		const oz = this.#oz;
		const frame = this.#frame;
		const { buckets, boxes } = this.selection;
		const { pixelFactor, viewportHeight, minPixels, shadowLayers } = view;
		const planes = this.#planes;
		const planeFloats = this.#planeFloats;
		const casterPlanes = this.#casterPlanes;
		const casterFloats = this.#casterFloats;
		const casterDistance = this.#casterDistance;
		const pending = this.#pending;
		const f32 = instances.rowsF32;
		const cull = instances.cull;
		const runs = instances.runs;
		const mirroredRow = block.mirrored;
		for (let r = firstRunAt(runs, first); r < runs.length; r += 3) {
			const runFirst = runs[r + 1];
			const runEnd = runFirst + runs[r + 2];
			if (runFirst >= end) {
				break;
			}
			if (runEnd <= first) {
				continue;
			}
			const slots = block.slots[r / 3];
			const box = block.boxes[r / 3] === 1;
			// effect distance bands measure from the effect's origin, in the instance's frame
			const origin = block.origins[r / 3];
			const last = Math.min(end, runEnd);
			for (let i = Math.max(first, runFirst); i < last; i++) {
				const at = i * ROW_WORDS;
				const x = ox + f32[at + 12];
				const y = oy + f32[at + 13];
				const z = oz + f32[at + 14];
				const radius = cull[i * CULL_FLOATS];
				const distance = Math.max(Math.sqrt(x * x + y * y + z * z), 0.1);
				if ((radius * pixelFactor) / distance < minPixels) {
					continue;
				}
				let castOnly = false;
				if (!inside && !sphereInPlanes(planes, planeFloats, x, y, z, radius)) {
					if (
						casterFloats === 0 ||
						(radius * pixelFactor) / distance < CASTER_MIN_PIXELS ||
						distance - radius > casterDistance ||
						!sphereInPlanes(casterPlanes, casterFloats, x, y, z, radius)
					) {
						continue;
					}
					castOnly = true;
				}
				// Unity's LODGroup metric: the object's size relative to the screen height
				const relative = (2 * cull[i * CULL_FLOATS + 1] * pixelFactor) / (distance * viewportHeight);
				let squared = relative * relative;
				if (origin !== null) {
					// rows hold the transform's top three rows, row-major, translation relative to the block
					const [px, py, pz] = origin;
					const dx = ox + f32[at] * px + f32[at + 1] * py + f32[at + 2] * pz + f32[at + 3];
					const dy = oy + f32[at + 4] * px + f32[at + 5] * py + f32[at + 6] * pz + f32[at + 7];
					const dz = oz + f32[at + 8] * px + f32[at + 9] * py + f32[at + 10] * pz + f32[at + 11];
					squared = dx * dx + dy * dy + dz * dz;
				}
				const priority = relative * viewportHeight * (castOnly ? CASTER_PRIORITY : 1);

				let pendingCount = 0;
				let ready = true;
				let lod = -1;
				for (let s = 0; s < slots.length; s++) {
					const slot = slots[s];
					if (!(squared > slot.minSquared && squared <= slot.maxSquared)) {
						continue;
					}
					lod = slot.lod;
					if (castOnly && !slot.castsShadows) {
						continue;
					}
					if (this.#geometryReady(slot.geometry, priority, frame)) {
						pending[pendingCount++] = slot;
					} else {
						ready = false;
					}
				}
				if (lod < 0) {
					continue;
				}
				const row = instances.alloc.start + i;
				if (!ready) {
					pendingCount = this.#residentLod(slots, lod, { castOnly });
					if (pendingCount === 0) {
						if (box && !castOnly) {
							boxes.push(row);
						}
						continue;
					}
				}
				const group = shadowLayers === null ? SHADOW_LAYERS : firstShadowLayer(shadowLayers, x, y, z, radius);
				const mirrored = mirroredRow[i] === 1 ? 1 : 0;
				for (let p = 0; p < pendingCount; p++) {
					const slot = pending[p];
					const cast = castOnly || slot.shadowOnly;
					const index = bucketIndex(mirrored, cast);
					const bucket = slot.buckets[index] ?? this.#buckets.bucketOf(slot, index);
					if (bucket.frame !== frame) {
						bucket.frame = frame;
						for (const rows of bucket.rows) {
							rows.length = 0;
						}
						bucket.distances.length = 0;
						bucket.pixels = 0;
						bucket.nearest = Infinity;
						buckets.push(bucket);
					}
					// listed rows draw into a prefix of the layers: a static caster only from the far layer on, and a
					// realtime one into the far layer too. the transparent pass's rows draw no shadows
					let slotGroup = group;
					if (!slot.castsShadows || slot.sorted) {
						slotGroup = SHADOW_LAYERS;
					} else if (!slot.castsRealtime && group < SHADOW_LAYERS) {
						slotGroup = SHADOW_LAYERS - 1;
					}
					const groupRows = bucket.rows[slotGroup];
					const listed = groupRows.length;
					if (slot.particles === null) {
						groupRows.push(row);
					} else {
						const particles = this.#particles.rows(instances, i, slot.particles, frame, view.particles);
						this.selection.particles = true;
						for (const particle of particles) {
							groupRows.push(particle);
						}
					}
					if (slot.sorted) {
						// the game sorts by renderer: a system's particles all take its distance
						for (let k = listed; k < groupRows.length; k++) {
							bucket.distances.push(distance);
						}
					}
					if (priority > bucket.pixels) {
						bucket.pixels = priority;
					}
					if (distance - radius < bucket.nearest) {
						bucket.nearest = distance - radius;
					}
				}
			}
		}
	}

	/**
	 * wants a geometry at `priority` and reports whether it's resident. residency can't change before the
	 * stream update, so each geometry is looked up once per frame, and wanted once at its highest priority by
	 * {@link #wantAsked}
	 */
	#geometryReady(geometry: number, priority: number, frame: number): boolean {
		if (this.#checkedFrame[geometry] !== frame) {
			this.#checkedFrame[geometry] = frame;
			this.#wanted[geometry] = priority;
			const entry = this.#geometries[geometry];
			const known = entry?.status === 'ready';
			this.#ready[geometry] = known && this.#stream.isReady(entry.blob) ? 1 : 0;
			if (known) {
				this.#asked.push(geometry);
			}
		} else if (priority > this.#wanted[geometry]) {
			this.#wanted[geometry] = priority;
		}
		return this.#ready[geometry] === 1;
	}

	/** wants every geometry asked about this frame at the highest priority it was asked with */
	#wantAsked(): void {
		for (const geometry of this.#asked) {
			const entry = this.#geometries[geometry];
			if (entry?.status === 'ready') {
				this.#stream.want(entry.blob, this.#wanted[geometry]);
			}
		}
		this.#asked.length = 0;
	}

	/**
	 * finds a stand-in for an instance whose wanted LOD is still streaming: the nearest LOD whose geometry is
	 * all resident, coarser first on ties because far LODs are smaller and more often loaded. usually that's
	 * the LOD drawn before the switch, so the instance keeps its shape instead of dropping to its box.
	 * stand-ins are kept in use but not requested, so they don't add to the streaming queue.
	 *
	 * @param slots the slots the view's options show
	 * @param filter `castOnly` when only the shadow-casting slots are wanted
	 * @returns how many of the stand-in's slots were written to `#pending` (0 when no LOD is resident)
	 */
	#residentLod(slots: readonly ChainSlot[], wanted: number, { castOnly }: { castOnly: boolean }): number {
		let maxLod = 0;
		for (const slot of slots) {
			maxLod = Math.max(maxLod, slot.lod);
		}
		const pending = this.#pending;
		for (let step = 1; step <= Math.max(wanted, maxLod - wanted); step++) {
			for (let side = 0; side < 2; side++) {
				const lod = side === 0 ? wanted + step : wanted - step;
				if (lod < 0 || lod > maxLod) {
					continue;
				}
				let count = 0;
				let resident = true;
				for (const slot of slots) {
					if (slot.lod !== lod || (castOnly && !slot.castsShadows)) {
						continue;
					}
					if (!this.#geometryResident(slot.geometry)) {
						resident = false;
						break;
					}
					pending[count++] = slot;
				}
				if (resident && count > 0) {
					for (let p = 0; p < count; p++) {
						this.#keepGeometry(pending[p].geometry);
					}
					return count;
				}
			}
		}
		return 0;
	}

	/** whether a geometry is resident, without requesting it or marking it used */
	#geometryResident(geometry: number): boolean {
		const entry = this.#geometries[geometry];
		return entry?.status === 'ready' && this.#stream.isReady(entry.blob);
	}

	/** marks a resident geometry used this frame, so it isn't evicted */
	#keepGeometry(geometry: number): void {
		const entry = this.#geometries[geometry];
		if (entry?.status === 'ready') {
			this.#stream.markUsed(entry.blob);
		}
	}
}
