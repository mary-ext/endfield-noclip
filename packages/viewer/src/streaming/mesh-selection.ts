import type { GeometryTable } from '@endfield-noclip/package-format/geometry-table';
import type { Chain } from '@endfield-noclip/package-format/instances';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { CULL_FLOATS, ROW_WORDS } from '../content/instance-rows.ts';
import {
	GROUP_FLOATS,
	GROUP_ROWS,
	GroupFloat,
	SEGMENT_FLOATS,
	SegmentFloat,
	chainReach,
	setGroupReaches,
} from '../content/row-groups.ts';
import { alphaTextureOf, LookFlags, type MaterialLook, UV1_SHIFT } from '../looks/look.ts';
import type { LazyMaterialLooks } from '../looks/material-looks.ts';
import type { ParticleField } from '../particles/particle-rows.ts';
import type { ParticleView } from '../particles/row-geometry.ts';
import type { ResidentInstances } from '../render/core/resident.ts';
import {
	type GpuCullWork,
	ITEM_FADE_SHIFT,
	ITEM_WORDS,
	ItemFlags,
	MAX_LIGHT_CASTERS,
	NO_BUCKET,
	addItem,
	addItemWithSlots,
	addSlot,
	gpuCullWork,
	writeCullView,
} from '../render/meshes/gpu-cull-work.ts';
import {
	firstRunAt,
	firstShadowLayer,
	sphereInPlanes,
	sphereInsidePlanes,
	sphereTouchesSpheres,
} from '../render/meshes/instance-culling.ts';
import {
	BUCKET_LIFETIME,
	type ChainSlot,
	type MeshBucket,
	MeshBuckets,
	bucketIndex,
	gpuBucketIndex,
	slotHidden,
	sortFarToNear,
} from '../render/meshes/mesh-buckets.ts';
import type { MipSteps } from '../render/textures/mip-feedback.ts';
import type { TextureStore } from '../render/textures/texture-store.ts';
import type { Plane } from '../scene/camera.ts';
import {
	SHADOW_LAYER_MIN_SQUARED,
	SHADOW_LAYERS,
	type ShadowLayerVolumes,
	type CasterVolume,
} from '../scene/shadow-volumes.ts';

import type { InstanceRange } from './selection.ts';
import type { StreamManager } from './stream-manager.ts';
import { TextureRequests } from './texture-requests.ts';

/** this frame's mesh selection, reused across frames */
export interface MeshSelection {
	buckets: MeshBucket[];
	/** rows drawn as boxes while their geometry streams */
	boxes: number[];
	/** whether it draws emitters' particles, which move with the clock while the view holds still */
	particles: boolean;
	/** whether any drawn particle system casts shadows */
	shadowParticles: boolean;
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
	/** progressive grass foliage density multiplier in [0, 1]; defaults to 1 */
	foliageDensity?: number;
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
	/**
	 * how finely the last frames sampled each material's textures, by material id, which the textures of
	 * materials drawn in the main pass stream by; `null` streams every texture by its instances' size on
	 * screen
	 */
	mips: MipSteps | null;
}

/** what the selector reads */
export interface MeshSelectorInit {
	/** LOD-chain templates */
	chains: readonly Chain[];
	/** the geometry table */
	geometries: GeometryTable;
	/** by material id */
	looks: LazyMaterialLooks;
	stream: StreamManager;
	textures: TextureStore;
	/** writes the rows of emitters' particles */
	particles: ParticleField;
}

/** priority multiplier for shadow casters outside the view */
const CASTER_PRIORITY = 0.1;
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
const bandPixels = (slot: ChainSlot, viewportHeight: number): number => slot.maxRelative * viewportHeight;

/**
 * the texture slots the main pass samples by the mesh's UV sets alone, which its mip feedback covers: base
 * colour, normal, mask, emissive and detail. the parallax slots also hold layers mapped by world position
 */
const FEEDBACK_SLOTS = 5;

/**
 * @param look a material's look
 * @returns whether the main pass's mesh shader shades its draws in view, and so reports their mips
 */
const sampledInMainPass = (look: MaterialLook): boolean =>
	(look.queue === 'opaque' || look.queue === 'cutout' || look.queue === 'cutoutOverlay') &&
	(look.flags & LookFlags.Effect) === 0;

/** @returns a number standing for the view options {@link slotHidden} reads */
const slotFilterKey = (view: MeshView): number =>
	(view.unsupportedMaterials ? 1 : 0) | (view.missingContent ? 2 : 0);

/**
 * a caster reaches every layer from the first its bounds reach on (each takes in the volumes of those
 * before); of those, the sharp cascades take realtime casters and the far layer static ones, as the game's
 * maps do. layers whose screen-size minimum exceeds `maxSquared` are masked out, matching the game's
 * `CSMScreenSizeMin` / `ASMScreenSizeMin` cull
 *
 * @param slot the slot that draws the rows
 * @param first the first shadow layer the rows' bounds reach, {@link SHADOW_LAYERS} for none
 * @param maxSquared upper bound on the rows' camera-view squared relative screen size
 * @returns a bit per shadow layer the slot's rows can cast into
 */
const casterLayerBits = (slot: ChainSlot, first: number, maxSquared: number): number => {
	if (first >= SHADOW_LAYERS) {
		return 0;
	}
	let bits = slot.casterBits & (~0 << first);
	if (bits === 0) {
		return 0;
	}
	for (let layer = first; layer < SHADOW_LAYERS; layer++) {
		if (maxSquared <= SHADOW_LAYER_MIN_SQUARED[layer]) {
			bits &= ~(1 << layer);
		}
	}
	return bits;
};

/** what a resident block's selection reuses from frame to frame */
interface SelectedBlock {
	/** its row groups' bounds, from `buildRowGroups`, their reaches set */
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
	/** per chain run: 1 when at least one shown slot casts shadows */
	runCasts: Uint8Array;
	/** per chain run: OR of segment handedness bits (1 = unmirrored, 2 = mirrored) */
	runHandedness: Uint8Array;
	/** per chain run: max and min row size across segments */
	runMaxSize: Float32Array;
	runMinSize: Float32Array;
	/** whole-block bounding sphere `[cx, cy, cz, radius, maxRowRadius]` relative to block origin */
	blockSphere: [number, number, number, number, number];
	/** each group's rows split by chain run, from `groupSegmentsOf` */
	segments: Float32Array;
	/** per group, where its segments start; one more entry ends the last */
	groupSegments: Uint32Array;
}

/** a stand-in LOD's slots for one chain, wanted LOD and filter, as found in `frame` */
interface StandIn {
	frame: number;
	slots: ChainSlot[];
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

/** minimum squared relative screen size a shadow-only caster must exceed for `layer` */
const minShadowLayerSquared = (layer: number): number =>
	layer === 0 ? SHADOW_LAYER_MIN_SQUARED[0] : SHADOW_LAYER_MIN_SQUARED[3];

/** whether a camera-relative sphere overlaps the sun-caster frustum or any local-light caster sphere */
const inCasterVolume = (
	casterPlanes: Float64Array,
	casterFloats: number,
	lightCasters: Float64Array,
	x: number,
	y: number,
	z: number,
	radius: number,
): boolean =>
	(casterFloats > 0 && sphereInPlanes(casterPlanes, casterFloats, x, y, z, radius)) ||
	sphereTouchesSpheres(lightCasters, x, y, z, radius);

/** selects LODs and buckets instances */
export class MeshSelector {
	readonly selection: MeshSelection = {
		buckets: [],
		boxes: [],
		particles: false,
		shadowParticles: false,
		gpu: gpuCullWork(),
	};
	#chains: readonly Chain[];
	#geometries: GeometryTable;
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
	/** this frame's light caster spheres (`CasterVolume.lights`), camera-relative */
	#lightCasters = new Float64Array(0);
	#pending: ChainSlot[] = [];
	/**
	 * per chain, by `wanted LOD * 2 + castOnly`: the stand-in {@link #residentLod} found, and the frame it was
	 * found in. residency and the shown slots hold for the frame, and a chain that's still streaming is asked
	 * once per row or segment
	 */
	readonly #standIns: (StandIn[] | undefined)[];
	/** the block being selected's origin relative to the eye, for {@link #selectRows} */
	#ox = 0;
	#oy = 0;
	#oz = 0;
	/** the current range's 8-bit transition fade code (0 = opaque) */
	#fade = 0;
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
	readonly #segment = { rows: 0, handedness: 0, priority: 0, nearest: 0, layer: 0, high: 0 };
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
		const count = init.geometries.count;
		this.#checkedFrame = new Int32Array(count).fill(-1);
		this.#ready = new Uint8Array(count);
		this.#wanted = new Float64Array(count);
		this.#reaches = new Float64Array(init.chains.length).fill(Number.NaN);
		this.#standIns = Array.from({ length: init.chains.length });
	}

	/**
	 * refreshes active particle emitters in place for a still view (settle/adapt frames) without re-running
	 * mesh selection. returns `false` if any emitter grew past its listed row span or casts shadows
	 *
	 * @param view the clock and camera axes
	 * @returns whether the existing selection and visible list remain valid
	 */
	refreshParticles(view: ParticleView): boolean {
		if (!this.selection.particles || this.selection.shadowParticles) {
			return false;
		}
		return this.#particles.refreshActive(++this.#frame, view);
	}

	/**
	 * @param ranges the instance ranges the tree traversal selected
	 * @param view camera inputs
	 * @returns buckets and box fallbacks (the same object every frame)
	 */
	run(ranges: readonly InstanceRange[], view: MeshView): MeshSelection {
		const frame = ++this.#frame;
		this.#particles.beginFrame();
		this.#textures.beginFrame(frame);
		const selection = this.selection;
		selection.buckets.length = 0;
		selection.boxes.length = 0;
		selection.particles = false;
		selection.shadowParticles = false;
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
		}
		this.#casterFloats = casterFloats;
		// the lights' caster spheres, relative to the eye like the rows
		const lightCount = Math.min((casters?.lights.length ?? 0) / 4, MAX_LIGHT_CASTERS);
		if (this.#lightCasters.length !== lightCount * 4) {
			this.#lightCasters = new Float64Array(lightCount * 4);
		}
		const lightCasters = this.#lightCasters;
		for (let s = 0; s < lightCount * 4; s += 4) {
			lightCasters[s] = (casters?.lights[s] ?? 0) - eye[0];
			lightCasters[s + 1] = (casters?.lights[s + 1] ?? 0) - eye[1];
			lightCasters[s + 2] = (casters?.lights[s + 2] ?? 0) - eye[2];
			lightCasters[s + 3] = casters?.lights[s + 3] ?? 0;
		}
		writeCullView(work, {
			planes,
			planeFloats,
			casterPlanes,
			casterFloats,
			lightCasters,
			pixelFactor,
			viewportHeight,
			minPixels,
			shadowLayers: view.shadowLayers,
		});
		const reachScale = pixelFactor / viewportHeight;
		const filter = slotFilterKey(view);
		const foliageDensity = view.foliageDensity ?? 1;
		const sparsityU32 = new Uint32Array(1);
		const sparsityF32 = new Float32Array(sparsityU32.buffer);

		const selectSpan = (
			instances: ResidentInstances,
			block: SelectedBlock,
			ox: number,
			oy: number,
			oz: number,
			spanFirst: number,
			spanEnd: number,
		): void => {
			const groups = block.groups;
			for (let g = Math.floor(spanFirst / GROUP_ROWS); g * GROUP_ROWS < spanEnd; g++) {
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
				if (!inView && !inCasterVolume(casterPlanes, casterFloats, lightCasters, gx, gy, gz, radius)) {
					continue;
				}
				const layer =
					view.shadowLayers === null
						? SHADOW_LAYERS
						: firstShadowLayer(view.shadowLayers, gx, gy, gz, radius);
				if (!inView) {
					if (layer === SHADOW_LAYERS) {
						continue;
					}
					// upper bound on any row's squared relative size: 2 · rowRadius · pixelFactor / (nearest · height)
					const maxRelative = (2 * rowPixels) / viewportHeight;
					if (radius !== Infinity && maxRelative * maxRelative <= minShadowLayerSquared(layer)) {
						continue;
					}
				}
				// every row of a group wholly in view is in view too
				const inside = inView && sphereInsidePlanes(planes, planeFloats, gx, gy, gz, radius);
				const rowFirst = Math.max(spanFirst, g * GROUP_ROWS);
				const rowEnd = Math.min(spanEnd, (g + 1) * GROUP_ROWS);
				// a group holding moving rows has no bounds to pick its LODs by
				if (view.gpuCulling && radius !== Infinity) {
					const group = this.#group;
					group.first = rowFirst;
					group.end = rowEnd;
					group.inside = inside;
					group.inView = inView;
					group.layer = layer;
					this.#cullGroup(instances, block, g);
				} else {
					this.#selectRows(instances, rowFirst, rowEnd, { inside, block });
				}
			}
		};

		for (const { item, first, count, fade } of ranges) {
			const instances = item.resident;
			if (instances?.kind !== 'instances') {
				continue;
			}
			const foliageClusters = instances.foliageClusters ?? null;
			if (foliageClusters !== null && foliageDensity <= 0) {
				continue;
			}
			this.#fade = fade;
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
				block.runCasts = Uint8Array.from(block.slots, (slots) =>
					slots.some((slot) => slot.castsShadows) ? 1 : 0,
				);
				block.filter = filter;
			}
			const end = first + count;
			if (foliageClusters !== null && view.gpuCulling) {
				if (this.#cullFoliageBlock(instances, block, first, end, foliageClusters, foliageDensity)) {
					continue;
				}
			}
			if (foliageClusters !== null && foliageDensity < 1) {
				for (let c = 0; c < foliageClusters.length; c += 3) {
					const cFirst = foliageClusters[c];
					const cCount = foliageClusters[c + 1];
					if (cFirst >= end || cFirst + cCount <= first) {
						continue;
					}
					sparsityU32[0] = foliageClusters[c + 2];
					const keepRatio = Math.min(1, Math.max(0.01, sparsityF32[0] * foliageDensity));
					const keep = Math.min(cCount, Math.ceil(cCount * keepRatio));
					const spanFirst = Math.max(first, cFirst);
					const spanEnd = Math.min(end, cFirst + keep);
					if (spanFirst < spanEnd) {
						selectSpan(instances, block, ox, oy, oz, spanFirst, spanEnd);
					}
				}
			} else {
				selectSpan(instances, block, ox, oy, oz, first, end);
			}
		}

		this.#particles.endFrame(view.particles);
		this.#wantAsked();
		const texturePixels = 2 ** -view.textureBias;
		for (const bucket of selection.buckets) {
			const look = bucket.look;
			if (bucket.distances.length > 0) {
				sortFarToNear(bucket);
			}
			if (bucket.castOnly) {
				// a shadow needs only the texture holding the alpha it's cut out by
				const alpha = look.queue === 'cutout' ? alphaTextureOf(look) : null;
				if (alpha !== null) {
					this.#textures.forPixels(
						alpha,
						bucket.pixels * texturePixels,
						look.uvScales[look.textures.indexOf(alpha)],
						bucket.pixels,
					);
				}
				continue;
			}
			// the main pass reports how finely it samples the materials it shades
			const mips = sampledInMainPass(look) ? view.mips : null;
			for (let i = 0; i < look.textures.length; i++) {
				const texture = look.textures[i];
				if (texture === null) {
					continue;
				}
				if (mips === null || i >= FEEDBACK_SLOTS) {
					this.#textures.forPixels(texture, bucket.pixels * texturePixels, look.uvScales[i], bucket.pixels);
					continue;
				}
				const steps = mips.steps(bucket.material, (look.flags >> (UV1_SHIFT + i)) & 1);
				if (steps < 0) {
					// no pixel of it was read: hidden, or about to show
					this.#textures.forUnseen(texture, bucket.pixels * texturePixels, look.uvScales[i], bucket.pixels);
				} else {
					this.#textures.forFootprint(texture, steps, look.uvScales[i], view.textureBias, bucket.pixels);
				}
			}
			if (look.volumeTexture !== null) {
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
		let block = this.#blocks.get(instances);
		if (block !== undefined) {
			return block;
		}
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
		// the worker bounded the rows; how far each group draws takes the chains' slots, which only this has
		const { groups, mirrored, segments, groupSegments } = instances.bounds;
		setGroupReaches(instances.bounds, runs, (chain) => this.#reach(chain));
		const runHandedness = new Uint8Array(runCount);
		const runMaxSize = new Float32Array(runCount);
		const runMinSize = new Float32Array(runCount).fill(Infinity);
		for (let at = 0; at < segments.length; at += SEGMENT_FLOATS) {
			const r = segments[at + SegmentFloat.run];
			runHandedness[r] |= segments[at + SegmentFloat.handedness];
			const hi = segments[at + SegmentFloat.maxSize];
			const lo = segments[at + SegmentFloat.minSize];
			if (hi > runMaxSize[r]) {
				runMaxSize[r] = hi;
			}
			if (lo < runMinSize[r]) {
				runMinSize[r] = lo;
			}
		}
		// whole-block bounding sphere enclosing every group sphere (used by the GPU foliage fast path)
		let minX = Infinity;
		let minY = Infinity;
		let minZ = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let maxZ = -Infinity;
		let maxRowRadius = 0;
		for (let at = 0; at < groups.length; at += GROUP_FLOATS) {
			const r = groups[at + GroupFloat.radius];
			if (!Number.isFinite(r)) {
				maxRowRadius = Infinity;
				break;
			}
			const cx = groups[at + GroupFloat.center];
			const cy = groups[at + GroupFloat.center + 1];
			const cz = groups[at + GroupFloat.center + 2];
			if (cx - r < minX) {
				minX = cx - r;
			}
			if (cy - r < minY) {
				minY = cy - r;
			}
			if (cz - r < minZ) {
				minZ = cz - r;
			}
			if (cx + r > maxX) {
				maxX = cx + r;
			}
			if (cy + r > maxY) {
				maxY = cy + r;
			}
			if (cz + r > maxZ) {
				maxZ = cz + r;
			}
			const rr = groups[at + GroupFloat.rowRadius];
			if (rr > maxRowRadius) {
				maxRowRadius = rr;
			}
		}
		const blockSphere: [number, number, number, number, number] =
			Number.isFinite(maxRowRadius) && minX <= maxX
				? [
						(minX + maxX) * 0.5,
						(minY + maxY) * 0.5,
						(minZ + maxZ) * 0.5,
						Math.hypot((maxX - minX) * 0.5, (maxY - minY) * 0.5, (maxZ - minZ) * 0.5),
						maxRowRadius,
					]
				: [0, 0, 0, Infinity, Infinity];
		block = {
			groups,
			mirrored,
			allSlots,
			slots: allSlots,
			filter: -1,
			boxes,
			origins,
			gpuRuns: new Uint8Array(runCount),
			runCasts: new Uint8Array(runCount),
			runHandedness,
			runMaxSize,
			runMinSize,
			blockSphere,
			segments,
			groupSegments,
		};
		this.#blocks.set(instances, block);
		return block;
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
	 * whole-block GPU fast path for `.fol` grass blocks: tests the tile sphere once, checks each chain run's
	 * geometry readiness and reserves its bucket once, then emits 64-row GPU cull items sharing one slot slice.
	 * returns `false` if any run cannot use the GPU path (e.g. still streaming geometry with boxes enabled).
	 */
	#cullFoliageBlock(
		instances: ResidentInstances,
		block: SelectedBlock,
		first: number,
		end: number,
		foliageClusters: Uint32Array,
		foliageDensity: number,
	): boolean {
		const view = this.#view;
		if (view === null) {
			return false;
		}
		const [bcx, bcy, bcz, bRadius, maxRowRadius] = block.blockSphere;
		if (!Number.isFinite(bRadius)) {
			return false;
		}
		const bx = this.#ox + bcx;
		const by = this.#oy + bcy;
		const bz = this.#oz + bcz;
		const centre = Math.hypot(bx, by, bz);
		const nearest = Math.max(centre - bRadius, 0.1);
		const { pixelFactor, viewportHeight, minPixels } = view;
		if ((maxRowRadius * pixelFactor) / nearest < minPixels) {
			return true;
		}
		const inView = sphereInPlanes(this.#planes, this.#planeFloats, bx, by, bz, bRadius);
		if (
			!inView &&
			!inCasterVolume(this.#casterPlanes, this.#casterFloats, this.#lightCasters, bx, by, bz, bRadius)
		) {
			return true;
		}
		const blockLayer =
			view.shadowLayers === null ? SHADOW_LAYERS : firstShadowLayer(view.shadowLayers, bx, by, bz, bRadius);
		if (!inView && blockLayer === SHADOW_LAYERS) {
			return true;
		}
		const runs = instances.runs;
		const runCount = runs.length / 3;
		for (let r = 0; r < runCount; r++) {
			if (block.gpuRuns[r] === 0) {
				return false;
			}
		}

		const inside = inView && sphereInsidePlanes(this.#planes, this.#planeFloats, bx, by, bz, bRadius);
		const castOnly = !inView;
		const far = Math.max(centre + bRadius, 0.1);
		const work = this.selection.gpu;
		const frame = this.#frame;
		const checkedFrame = this.#checkedFrame;
		const readyArr = this.#ready;
		const wantedArr = this.#wanted;
		const candidates = this.#candidates;
		const itemFlags = (inside ? ItemFlags.Inside : 0) | (this.#fade << ITEM_FADE_SHIFT);
		const sparsityU32 = new Uint32Array(1);
		const sparsityF32 = new Float32Array(sparsityU32.buffer);

		for (let r = 0; r < runCount; r++) {
			const runFirst = Math.max(first, runs[r * 3 + 1]);
			const runEnd = Math.min(end, runs[r * 3 + 1] + runs[r * 3 + 2]);
			if (runFirst >= runEnd) {
				continue;
			}
			if (castOnly && block.runCasts[r] === 0) {
				continue;
			}
			const largest = (2 * block.runMaxSize[r] * pixelFactor) / (nearest * viewportHeight);
			const smallest = (2 * block.runMinSize[r] * pixelFactor) / (far * viewportHeight);
			const high = largest * largest * BAND_SLACK;
			if (castOnly && high <= minShadowLayerSquared(blockLayer)) {
				continue;
			}
			const low = (smallest * smallest) / BAND_SLACK;
			const scale = castOnly ? CASTER_PRIORITY : 1;
			const priority = largest * viewportHeight * scale;
			const slots = block.slots[r];
			let count = 0;
			let ready = true;
			for (let i = 0; i < slots.length; i++) {
				const slot = slots[i];
				if (slot.maxSquared < low || slot.minSquared >= high || (castOnly && !slot.castsShadows)) {
					continue;
				}
				candidates[count++] = slot;
				const slotPriority = Math.min(priority, bandPixels(slot, viewportHeight) * scale);
				const geom = slot.geometry;
				if (checkedFrame[geom] === frame) {
					if (slotPriority > wantedArr[geom]) {
						wantedArr[geom] = slotPriority;
					}
					if (readyArr[geom] === 0) {
						ready = false;
					}
				} else if (!this.#geometryReady(geom, slotPriority, frame)) {
					ready = false;
				}
			}
			if (count === 0) {
				continue;
			}
			if (!ready) {
				if (block.boxes[r] === 1 && !castOnly) {
					this.#selectRows(instances, runFirst, runEnd, { inside, block });
				}
				continue;
			}

			// gather row spans for this run (single span at full density, thinned cluster spans when < 1)
			const spans: number[] = [];
			let totalRows = 0;
			if (foliageDensity < 1) {
				for (let c = 0; c < foliageClusters.length; c += 3) {
					const cFirst = foliageClusters[c];
					const cCount = foliageClusters[c + 1];
					if (cFirst >= runEnd || cFirst + cCount <= runFirst) {
						continue;
					}
					sparsityU32[0] = foliageClusters[c + 2];
					const keepRatio = Math.min(1, Math.max(0.01, sparsityF32[0] * foliageDensity));
					const keep = Math.min(cCount, Math.ceil(cCount * keepRatio));
					const sFirst = Math.max(runFirst, cFirst);
					const sEnd = Math.min(runEnd, cFirst + keep);
					if (sFirst < sEnd) {
						spans.push(sFirst, sEnd);
						totalRows += sEnd - sFirst;
					}
				}
			} else {
				spans.push(runFirst, runEnd);
				totalRows = runEnd - runFirst;
			}
			if (totalRows === 0) {
				continue;
			}

			const segment = this.#segment;
			segment.rows = totalRows;
			segment.handedness = block.runHandedness[r];
			segment.priority = priority;
			segment.nearest = nearest;
			segment.layer = blockLayer;
			segment.high = high;

			// emit the first chunk via addItem + #addSlot (reserving bucket room for all `totalRows`), then
			// share its slot slice across all remaining 64-row chunks
			const firstSpanStart = spans[0];
			const firstSpanEnd = spans[1];
			const firstChunk = Math.min(GROUP_ROWS, firstSpanEnd - firstSpanStart);
			const itemIndex = work.itemCount;
			addItem(work, instances.alloc.start + firstSpanStart, firstChunk, itemFlags);
			for (let i = 0; i < count; i++) {
				this.#addSlot(candidates[i], candidates[i]);
			}
			const slotFirst = work.items[itemIndex * ITEM_WORDS + 2];
			const slotCount = work.items[itemIndex * ITEM_WORDS + 3];
			if (slotCount === 0) {
				work.itemCount--;
				continue;
			}
			for (let pos = firstSpanStart + firstChunk; pos < firstSpanEnd; pos += GROUP_ROWS) {
				addItemWithSlots(
					work,
					instances.alloc.start + pos,
					Math.min(GROUP_ROWS, firstSpanEnd - pos),
					itemFlags,
					slotFirst,
					slotCount,
				);
			}
			for (let sp = 2; sp < spans.length; sp += 2) {
				const sFirst = spans[sp];
				const sEnd = spans[sp + 1];
				for (let pos = sFirst; pos < sEnd; pos += GROUP_ROWS) {
					addItemWithSlots(
						work,
						instances.alloc.start + pos,
						Math.min(GROUP_ROWS, sEnd - pos),
						itemFlags,
						slotFirst,
						slotCount,
					);
				}
			}
		}
		return true;
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
			if (castOnly && block.runCasts[run] === 0) {
				continue;
			}
			if (block.gpuRuns[run] === 0) {
				this.#selectRows(instances, first, end, { inside: group.inside, block });
				continue;
			}
			// the metric's widest range over the segment's rows: the largest nearest, the smallest farthest
			const sx = this.#ox + segments[at + SegmentFloat.center];
			const sy = this.#oy + segments[at + SegmentFloat.center + 1];
			const sz = this.#oz + segments[at + SegmentFloat.center + 2];
			// the segment's own sphere reaches fewer layers than its group's
			const segmentLayer =
				group.layer === SHADOW_LAYERS || view.shadowLayers === null
					? SHADOW_LAYERS
					: firstShadowLayer(view.shadowLayers, sx, sy, sz, segments[at + SegmentFloat.radius]);
			if (castOnly && segmentLayer === SHADOW_LAYERS) {
				continue;
			}
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
			if (castOnly && high <= minShadowLayerSquared(segmentLayer)) {
				continue;
			}
			const low = (smallest * smallest) / BAND_SLACK;
			const scale = castOnly ? CASTER_PRIORITY : 1;
			const priority = largest * viewportHeight * scale;
			const slots = block.slots[run];
			const checkedFrame = this.#checkedFrame;
			const readyArr = this.#ready;
			const wantedArr = this.#wanted;
			// fast path for single-slot chains (~60% of chains): avoids candidate/LOD loops and #needsBox
			if (slots.length === 1) {
				const slot = slots[0];
				if (slot.maxSquared < low || slot.minSquared >= high) {
					continue;
				}
				const slotPriority = Math.min(priority, bandPixels(slot, viewportHeight) * scale);
				const geom = slot.geometry;
				let isReady = true;
				if (checkedFrame[geom] === frame) {
					if (slotPriority > wantedArr[geom]) {
						wantedArr[geom] = slotPriority;
					}
					if (readyArr[geom] === 0) {
						isReady = false;
					}
				} else if (!this.#geometryReady(geom, slotPriority, frame)) {
					isReady = false;
				}
				if (!isReady) {
					if (block.boxes[run] === 1 && !castOnly) {
						this.#selectRows(instances, first, end, { inside: group.inside, block });
					}
					continue;
				}
				const rows = end - first;
				const segment = this.#segment;
				segment.rows = rows;
				segment.handedness = segments[at + SegmentFloat.handedness];
				segment.priority = priority;
				segment.nearest = nearest;
				segment.layer = segmentLayer;
				segment.high = high;
				addItem(
					work,
					instances.alloc.start + first,
					rows,
					(group.inside ? ItemFlags.Inside : 0) | (this.#fade << ITEM_FADE_SHIFT),
				);
				this.#addSlot(slot, slot);
				if (work.items[(work.itemCount - 1) * ITEM_WORDS + 3] === 0) {
					work.itemCount--;
				}
				continue;
			}
			let count = 0;
			let ready = true;
			for (let i = 0; i < slots.length; i++) {
				const slot = slots[i];
				if (slot.maxSquared < low || slot.minSquared >= high || (castOnly && !slot.castsShadows)) {
					continue;
				}
				candidates[count++] = slot;
				const slotPriority = Math.min(priority, bandPixels(slot, viewportHeight) * scale);
				const geom = slot.geometry;
				if (checkedFrame[geom] === frame) {
					if (slotPriority > wantedArr[geom]) {
						wantedArr[geom] = slotPriority;
					}
					if (readyArr[geom] === 0) {
						ready = false;
					}
				} else if (!this.#geometryReady(geom, slotPriority, frame)) {
					ready = false;
				}
			}
			if (count === 0) {
				continue;
			}
			// rows with no LOD resident draw their box, which only listed rows can
			const chain = instances.runs[run * 3];
			if (!ready && block.boxes[run] === 1 && !castOnly && this.#needsBox(chain, slots, count)) {
				this.#selectRows(instances, first, end, { inside: group.inside, block });
				continue;
			}
			const rows = end - first;
			addItem(
				work,
				instances.alloc.start + first,
				rows,
				(group.inside ? ItemFlags.Inside : 0) | (this.#fade << ITEM_FADE_SHIFT),
			);
			const segment = this.#segment;
			segment.rows = rows;
			segment.handedness = segments[at + SegmentFloat.handedness];
			segment.priority = priority;
			segment.nearest = nearest;
			segment.layer = segmentLayer;
			segment.high = high;
			if (ready) {
				for (let c = 0; c < count; c++) {
					this.#addSlot(candidates[c], candidates[c]);
				}
			} else {
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
					const standIns = this.#residentLod(chain, slots, lod, { castOnly });
					const band = candidates[c];
					for (let p = 0; p < standIns; p++) {
						this.#addSlot(band, this.#pending[p]);
					}
				}
			}
			// drop the item if every slot was culled (e.g. out-of-view segment below shadow size thresholds)
			if (work.items[(work.itemCount - 1) * ITEM_WORDS + 3] === 0) {
				work.itemCount--;
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
	 * @param chain the run's chain
	 * @param slots the run's shown slots
	 * @param count candidates in {@link #candidates}
	 * @returns whether a candidate LOD has a slot not resident and no resident LOD to stand in for it
	 */
	#needsBox(chain: number, slots: readonly ChainSlot[], count: number): boolean {
		for (let c = 0; c < count; c++) {
			if (
				this.#ready[this.#candidates[c].geometry] === 0 &&
				this.#residentLod(chain, slots, this.#candidates[c].lod, { castOnly: false }) === 0
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
		room.layers = casterLayerBits(target, this.#segment.layer, Math.min(this.#segment.high, band.maxSquared));
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
		addSlot(this.selection.gpu, band, target.gpuFlags, buckets);
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
			bucket.fading = false;
			gpu.index = work.buckets.length;
			gpu.rows = 0;
			gpu.layerRows.fill(0);
			work.buckets.push(bucket);
			this.selection.buckets.push(bucket);
		}
		if (this.#fade !== 0) {
			bucket.fading = true;
		}
		gpu.rows += room.inView;
		const layers = room.layers;
		if (layers !== 0) {
			const rows = room.rows;
			const layerRows = gpu.layerRows;
			for (let layer = 0; layer < SHADOW_LAYERS; layer++) {
				if ((layers & (1 << layer)) !== 0) {
					layerRows[layer] += rows;
				}
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
		const lightCasters = this.#lightCasters;
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
					if (!inCasterVolume(casterPlanes, casterFloats, lightCasters, x, y, z, radius)) {
						continue;
					}
					castOnly = true;
				}
				const group = shadowLayers === null ? SHADOW_LAYERS : firstShadowLayer(shadowLayers, x, y, z, radius);
				if (castOnly && group === SHADOW_LAYERS) {
					continue;
				}
				// Unity's LODGroup metric: the object's size relative to the screen height
				const relative = (2 * cull[i * CULL_FLOATS + 1] * pixelFactor) / (distance * viewportHeight);
				const relativeSquared = relative * relative;
				if (castOnly && relativeSquared <= minShadowLayerSquared(group)) {
					continue;
				}
				let squared = relativeSquared;
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
					pendingCount = this.#residentLod(runs[r], slots, lod, { castOnly });
					if (pendingCount === 0) {
						if (box && !castOnly) {
							boxes.push(row);
						}
						continue;
					}
				}
				const fade = this.#fade;
				const fadeBits = fade << 24;
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
						bucket.bands.length = 0;
						bucket.pixels = 0;
						bucket.nearest = Infinity;
						bucket.fading = false;
						buckets.push(bucket);
					}
					if (fade !== 0) {
						bucket.fading = true;
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
						groupRows.push((row | fadeBits) >>> 0);
					} else {
						const particles = this.#particles.rows(instances, i, slot.particles, frame, view.particles);
						this.selection.particles = true;
						if (slot.castsShadows) {
							this.selection.shadowParticles = true;
						}
						for (const particle of particles) {
							groupRows.push((particle | fadeBits) >>> 0);
						}
					}
					if (slot.sorted) {
						// the game sorts by renderer: a system's particles all take its distance
						for (let k = listed; k < groupRows.length; k++) {
							bucket.distances.push(distance);
							bucket.bands.push(slot.band);
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
			const blob = this.#geometries.blob(geometry);
			this.#ready[geometry] = blob !== null && this.#stream.isReady(blob) ? 1 : 0;
			if (blob !== null) {
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
			const blob = this.#geometries.blob(geometry);
			if (blob !== null) {
				this.#stream.want(blob, this.#wanted[geometry]);
			}
		}
		this.#asked.length = 0;
	}

	/**
	 * finds a stand-in for an instance whose wanted LOD is still streaming: the nearest LOD whose geometry is
	 * all resident, coarser first on ties because far LODs are smaller and more often loaded. usually that's
	 * the LOD drawn before the switch, so the instance keeps its shape instead of dropping to its box.
	 * stand-ins are kept in use but not requested, so they don't add to the streaming queue. found once per
	 * frame for each chain, LOD and filter.
	 *
	 * @param chain the slots' chain
	 * @param slots the slots the view's options show
	 * @param filter `castOnly` when only the shadow-casting slots are wanted
	 * @returns how many of the stand-in's slots were written to `#pending` (0 when no LOD is resident)
	 */
	#residentLod(
		chain: number,
		slots: readonly ChainSlot[],
		wanted: number,
		{ castOnly }: { castOnly: boolean },
	): number {
		const byKey = (this.#standIns[chain] ??= []);
		const key = wanted * 2 + (castOnly ? 1 : 0);
		const standIn = (byKey[key] ??= { frame: -1, slots: [] });
		if (standIn.frame !== this.#frame) {
			standIn.frame = this.#frame;
			const count = this.#findResidentLod(slots, wanted, castOnly);
			standIn.slots.length = 0;
			for (let p = 0; p < count; p++) {
				standIn.slots.push(this.#pending[p]);
				this.#keepGeometry(this.#pending[p].geometry);
			}
			return count;
		}
		const pending = this.#pending;
		for (let p = 0; p < standIn.slots.length; p++) {
			pending[p] = standIn.slots[p];
		}
		return standIn.slots.length;
	}

	/** {@link #residentLod}'s search, uncached and without marking the stand-in's geometry used */
	#findResidentLod(slots: readonly ChainSlot[], wanted: number, castOnly: boolean): number {
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
					return count;
				}
			}
		}
		return 0;
	}

	/** whether a geometry is resident, without requesting it or marking it used */
	#geometryResident(geometry: number): boolean {
		const blob = this.#geometries.blob(geometry);
		return blob !== null && this.#stream.isReady(blob);
	}

	/** marks a resident geometry used this frame, so it isn't evicted */
	#keepGeometry(geometry: number): void {
		const blob = this.#geometries.blob(geometry);
		if (blob !== null) {
			this.#stream.markUsed(blob);
		}
	}
}
