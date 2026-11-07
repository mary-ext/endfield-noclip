import type { GeometryTable } from '@endfield-noclip/package-format/geometry-table';
import { type Chain, ChainDrawFlags, DrawRole } from '@endfield-noclip/package-format/instances';

import type { MaterialLook } from '../looks/look.ts';
import { unsupportedLook } from '../looks/material-looks.ts';
import { SORTED_RANGES } from '../render/meshes/draw-ranges.ts';
import { sortBand } from '../render/meshes/sorted-runs.ts';
import { SHADOW_LAYERS } from '../render/shadows/shadow-map.ts';

import type { ContentItem } from './content-item.ts';
import type { GpuRows } from './gpu-cull-work.ts';
import type { StreamManager } from './stream-manager.ts';

/**
 * instances sharing one geometry submesh, material and handedness. selection output: only the selector writes
 * it, and renderers keep where its rows landed and its draw order to themselves
 */
export interface MeshBucket {
	geometry: ContentItem;
	submesh: number;
	material: number;
	look: MaterialLook;
	/** whether the instances' transforms mirror them (negative determinant) */
	mirrored: boolean;
	/** whether the instances are outside the view and only draw into the shadow map */
	castOnly: boolean;
	/**
	 * global row indices, grouped by the first shadow layer each instance can cast into (the last group for
	 * none), so each layer draws a prefix of the bucket; reset every frame
	 */
	rows: number[][];
	/**
	 * for a bucket the transparent pass draws ({@link ChainSlot.sorted}), the distance from the camera to each
	 * row's instance, m, parallel to its rows (all in the last group), far to near within a band once
	 * {@link sortFarToNear} ran; empty for other buckets
	 */
	distances: number[];
	/**
	 * for a sorted bucket, each row's slot's {@link ChainSlot.band}, parallel to {@link distances}: slots sharing
	 * a bucket can differ in it
	 */
	bands: number[];
	/**
	 * the highest priority of an instance this frame: its projected height, px, scaled by the caster priority
	 * in cast-only buckets. textures stream by it
	 */
	pixels: number;
	/** distance from the camera to the nearest instance's bounding sphere this frame, m */
	nearest: number;
	/** last frame the bucket had rows */
	frame: number;
	/** for a bucket whose rows the GPU culls, what it gathered this frame; `null` for one of listed {@link rows} */
	gpu: GpuRows | null;
}

/** which hidden draws a view selects */
interface SlotFilter {
	/** select draws of materials in the unsupported look */
	unsupportedMaterials: boolean;
	/** select `DrawRole.Unsupported` stand-ins */
	missingContent: boolean;
}

/** a draw of a chain with a visible material, or a shadow-only draw of one that casts shadows */
export interface ChainSlot {
	lod: number;
	minSquared: number;
	maxSquared: number;
	geometry: number;
	submesh: number;
	material: number;
	/** whether it casts into any shadow layer: its material casts, and its draw flags let it cast into one */
	castsShadows: boolean;
	/** whether it casts into the sharp cascades (`ChainDrawFlags.CastsCascades`) */
	castsRealtime: boolean;
	/** whether it casts into the far layer (`ChainDrawFlags.CastsStatic`) */
	castsStatic: boolean;
	/**
	 * what hides the draw: `material` for a material in the unsupported look ({@link
	 * SlotFilter.unsupportedMaterials}), `stand-in` for a `DrawRole.Unsupported` draw ({@link
	 * SlotFilter.missingContent}), `null` for neither
	 */
	hiddenBy: 'material' | 'stand-in' | null;
	/** whether the draw is a shadow proxy, which only the shadow passes draw, even for instances in view */
	shadowOnly: boolean;
	/** whether the GPU can cull its rows: a mesh in the opaque or alpha-tested queue */
	gpuCullable: boolean;
	/**
	 * whether the transparent pass draws it, far to near by instance (`SORTED_RANGES`): its rows keep their
	 * distances and skip the shadow layers' grouping, which only shadow casters need
	 */
	sorted: boolean;
	/** for a sorted slot, its draw's {@link sortBand}: lower bands draw first, whatever their distance */
	band: number;
	/** the particle system the draw plays, whose particles stand in for the instance; `null` for a mesh */
	particles: number | null;
	/** the slot's buckets, once they had rows, by {@link bucketIndex} */
	buckets: (MeshBucket | null)[];
}

/** @returns {@link ChainSlot.hiddenBy} for a draw of `role` drawn with `look` */
const hiddenByOf = (role: DrawRole, look: MaterialLook): ChainSlot['hiddenBy'] => {
	if (role === DrawRole.Unsupported) {
		return 'stand-in';
	}
	return look.unsupported ? 'material' : null;
};

/**
 * @param slot a chain slot
 * @param filter which hidden draws the view selects
 * @returns whether the view's options skip the slot
 */
export const slotHidden = (slot: ChainSlot, filter: SlotFilter): boolean => {
	switch (slot.hiddenBy) {
		case 'material': {
			return !filter.unsupportedMaterials;
		}
		case 'stand-in': {
			return !filter.missingContent;
		}
		case null: {
			return false;
		}
	}
};

/**
 * @param mirrored 1 for mirrored instances, 0 for unmirrored
 * @param castOnly whether the instances only cast shadows
 * @returns the index of a slot's bucket of listed rows
 */
export const bucketIndex = (mirrored: 0 | 1, castOnly: boolean): number => mirrored + (castOnly ? 2 : 0);

/** a slot's buckets: those of listed rows by {@link bucketIndex}, then those the GPU culls */
const BUCKET_VARIANTS = 8;

/**
 * @param mirrored 1 for mirrored instances, 0 for unmirrored
 * @param shadowOnly whether the slot is a shadow proxy, whose rows only cast shadows
 * @returns the index of a slot's bucket whose rows the GPU culls; its rows out of view share it, as casters
 */
export const gpuBucketIndex = (mirrored: 0 | 1, shadowOnly: boolean): number =>
	4 + mirrored + (shadowOnly ? 2 : 0);

/**
 * orders a sorted bucket's rows by their {@link MeshBucket.bands}, then far to near by their
 * {@link MeshBucket.distances}, all in place. rows of one instance (a particle system's particles) share its
 * distance and keep their order
 *
 * @param bucket a bucket of a {@link ChainSlot.sorted} slot, its rows all in the last group
 */
export const sortFarToNear = (bucket: MeshBucket): void => {
	const rows = bucket.rows[SHADOW_LAYERS];
	const { bands, distances } = bucket;
	const n = distances.length;
	let sorted = true;
	for (let i = 1; i < n && sorted; i++) {
		sorted = bands[i - 1] < bands[i] || (bands[i - 1] === bands[i] && distances[i - 1] >= distances[i]);
	}
	if (sorted) {
		return;
	}
	const order = Array.from({ length: n }, (_, i) => i);
	// stable, so a system's particles stay together in their order
	order.sort((a, b) => bands[a] - bands[b] || distances[b] - distances[a]);
	const oldRows = rows.slice();
	const oldBands = bands.slice();
	const oldDistances = distances.slice();
	for (let i = 0; i < n; i++) {
		rows[i] = oldRows[order[i]];
		bands[i] = oldBands[order[i]];
		distances[i] = oldDistances[order[i]];
	}
};

/** buckets without rows for this many frames are dropped */
export const BUCKET_LIFETIME = 600;

/** what {@link MeshBuckets} reads */
interface MeshBucketsInit {
	/** LOD-chain templates */
	chains: readonly Chain[];
	/** the geometry table */
	geometries: GeometryTable;
	/** by material id, from `materialLooks` */
	looks: readonly MaterialLook[];
	stream: Pick<StreamManager, 'get'>;
}

/** each chain's drawn slots, and the buckets their instances go to */
export class MeshBuckets {
	#chains: readonly Chain[];
	#geometries: GeometryTable;
	/** by material id, then the look stand-ins draw with at {@link #standIn} */
	#looks: readonly MaterialLook[];
	/** the material id `DrawRole.Unsupported` draws take, one past the package's */
	#standIn: number;
	#stream: Pick<StreamManager, 'get'>;
	#buckets = new Map<number, MeshBucket>();
	/** drawn draws per chain, built on first use */
	#slots: (ChainSlot[] | null)[];
	/** per chain, 1 when its instances draw their box while no LOD is resident, set with {@link #slots} */
	#boxes: Uint8Array;

	/** @param init tables and residency */
	constructor(init: MeshBucketsInit) {
		this.#chains = init.chains;
		this.#geometries = init.geometries;
		this.#standIn = init.looks.length;
		this.#looks = [...init.looks, unsupportedLook()];
		this.#stream = init.stream;
		// filled up front: an array written at scattered indices turns into a slow dictionary
		this.#slots = Array.from({ length: init.chains.length }, () => null);
		this.#boxes = new Uint8Array(init.chains.length);
	}

	/**
	 * an emitter's box spans everywhere its particles reach, so it doesn't stand in for them; nor does a shadow
	 * proxy's
	 *
	 * @param chain chain index, whose {@link slots} were built
	 * @returns whether the chain's instances in view draw their box while none of their LODs is resident
	 */
	drawsBox(chain: number): boolean {
		return this.#boxes[chain] === 1;
	}

	/**
	 * materials the game draws nothing visible with are dropped, as are shadow-only draws whose material casts
	 * no shadow
	 *
	 * @param chain chain index
	 * @returns the chain's drawn slots, built on first use
	 */
	slots(chain: number): ChainSlot[] {
		let slots = this.#slots[chain];
		if (slots === null) {
			slots = [];
			for (const draw of this.#chains[chain].draws) {
				const material = draw.role === DrawRole.Unsupported ? this.#standIn : draw.material;
				const look = material !== null && material < this.#looks.length ? this.#looks[material] : undefined;
				const shadowOnly = draw.role === DrawRole.ShadowOnly;
				const queue = look?.queue;
				const layers = {
					realtime: (draw.flags & ChainDrawFlags.CastsCascades) !== 0,
					static: (draw.flags & ChainDrawFlags.CastsStatic) !== 0,
				};
				const castsShadows = (look?.castsShadows ?? false) && (layers.realtime || layers.static);
				// a proxy's material is never seen, only whether it casts
				if (material === null || look === undefined || (shadowOnly ? !castsShadows : !look.drawn)) {
					continue;
				}
				slots.push({
					lod: draw.lod,
					minSquared: draw.minSquared,
					maxSquared: draw.maxSquared,
					geometry: draw.geometry,
					submesh: draw.submesh,
					material,
					castsShadows,
					castsRealtime: castsShadows && layers.realtime,
					castsStatic: castsShadows && layers.static,
					hiddenBy: hiddenByOf(draw.role, look),
					shadowOnly,
					gpuCullable: draw.particles === null && (queue === 'opaque' || queue === 'cutout'),
					sorted: SORTED_RANGES.has(look.queue),
					band: sortBand(draw.sortingLayer, draw.sortingOrder),
					particles: draw.particles,
					buckets: Array.from({ length: BUCKET_VARIANTS }, () => null),
				});
			}
			this.#slots[chain] = slots;
			const box = slots.some((slot) => !slot.shadowOnly) && !slots.some((slot) => slot.particles !== null);
			this.#boxes[chain] = box ? 1 : 0;
		}
		return slots;
	}

	/**
	 * @param slot a chain slot whose geometry has a stream item
	 * @param index the bucket, by {@link bucketIndex} or {@link gpuBucketIndex}
	 * @returns the slot's bucket, created and remembered by the slot on first use
	 * @throws {Error} if the slot's geometry was never requested
	 */
	bucketOf(slot: ChainSlot, index: number): MeshBucket {
		const { geometry, submesh, material } = slot;
		const key = ((geometry * 256 + submesh) * 65_536 + material) * BUCKET_VARIANTS + index;
		const bucket = this.#buckets.getOrInsertComputed(key, (): MeshBucket => {
			const blob = this.#geometries.blob(geometry);
			const item = blob === null ? undefined : this.#stream.get(blob);
			if (item === undefined) {
				throw new Error(`geometry ${geometry} has no stream item`);
			}
			return {
				geometry: item,
				submesh,
				material,
				look: this.#looks[material],
				mirrored: (index & 1) === 1,
				castOnly: (index & 2) === 2,
				rows: Array.from({ length: SHADOW_LAYERS + 1 }, () => []),
				distances: [],
				bands: [],
				pixels: 0,
				nearest: Infinity,
				frame: -1,
				gpu:
					index >= 4
						? { index: -1, rows: 0, layerRows: Array.from({ length: SHADOW_LAYERS }, () => 0) }
						: null,
			};
		});
		slot.buckets[index] = bucket;
		return bucket;
	}

	/**
	 * drops buckets without rows for {@link BUCKET_LIFETIME} frames, and the slots' references to them
	 *
	 * @param frame the current frame
	 */
	prune(frame: number): void {
		let pruned = false;
		for (const [key, bucket] of this.#buckets) {
			if (bucket.frame < frame - BUCKET_LIFETIME) {
				this.#buckets.delete(key);
				pruned = true;
			}
		}
		if (pruned) {
			for (const slots of this.#slots) {
				for (const slot of slots ?? []) {
					slot.buckets.fill(null);
				}
			}
		}
	}
}
