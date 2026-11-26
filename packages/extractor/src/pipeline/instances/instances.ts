import type { Rotator } from '@endfield-noclip/formats/endfield/init-chunk-data';
import type { Aabb } from '@endfield-noclip/formats/unity/values';
import {
	DECAL_PLACEMENT_FLOATS,
	type InstanceBlock,
	RowFlags,
	type RowPath,
	SPIN_FLOATS,
} from '@endfield-noclip/package-format/instances';

import { riddenBounds, sweptBounds } from './bounds.ts';

/** one placed instance, in world space */
export interface InstanceInput {
	chain: number;
	/** 4×4 column-major object-to-world matrix */
	matrix: Float32Array;
	/** world AABB */
	bounds: Aabb;
	entityId: number;
	/** a rect decal's placement, {@link DECAL_PLACEMENT_FLOATS} floats; absent on other rows */
	decalPlacement?: readonly number[];
	/** the spin the instance turns with, world space; absent on rows that hold still */
	spin?: Rotator;
	/** the game id of the water volume the instance floats on; absent on rows that don't float */
	floatsOn?: string;
	/**
	 * the path the instance rides, as offsets from {@link matrix}'s translation; absent on rows that stay put.
	 * rows of one block that share a path object share its stored path
	 */
	ride?: RowPath;
	/** `u32` cloth hash (InitChunkData component 60) for GPU-simulated cloth entities; absent on other rows */
	clothHash?: number;
	/** prefab `LODGroup` reference sphere `[refCenter.x, refCenter.y, refCenter.z, refSize]` in world space */
	lodGroup?: readonly [number, number, number, number];
}

/**
 * @param row an instance
 * @returns the box it reaches while drawn: its bounds, swept about its spin's axis when it has one and along
 *   its ride when it has one
 */
export const rowReach = (row: InstanceInput): Aabb => {
	const turned = row.spin === undefined ? row.bounds : sweptBounds(row.bounds, row.spin);
	return row.ride === undefined ? turned : riddenBounds(turned, row.ride);
};

/** growable struct-of-arrays rows, encoded into an {@link InstanceBlock} at the end */
export class InstanceBlockBuilder {
	readonly #chains: number[] = [];
	readonly #groups: number[] = [];
	readonly #matrices: number[] = [];
	readonly #bounds: number[] = [];
	readonly #entityIds: number[] = [];
	/** by insertion index, the decal rows' placements */
	readonly #placements = new Map<number, readonly number[]>();
	/** by insertion index, the spinning rows' spins */
	readonly #spins = new Map<number, Rotator>();
	/** by insertion index, the floating rows' water volume ids */
	readonly #floatsOn = new Map<number, string>();
	/** by insertion index, the riding rows' paths */
	readonly #rides = new Map<number, RowPath>();
	/** by insertion index, the simulated cloth rows' cloth hashes */
	readonly #cloths = new Map<number, number>();
	/** by insertion index, prefab LODGroup reference spheres */
	readonly #lodGroups = new Map<number, readonly [number, number, number, number]>();

	/** number of rows */
	get length(): number {
		return this.#chains.length;
	}

	/** @returns riding paths referenced by rows in this block */
	ridePaths(): Iterable<RowPath> {
		return this.#rides.values();
	}

	/** @returns moving (riding or spinning) entity descriptors in this block */
	movingEntities(): { entityId: number; ride: RowPath | null }[] {
		const seen = new Set<number>();
		const out: { entityId: number; ride: RowPath | null }[] = [];
		for (const [index, ride] of this.#rides) {
			const entityId = this.#entityIds[index];
			if (!seen.has(entityId)) {
				seen.add(entityId);
				out.push({ entityId, ride });
			}
		}
		for (const index of this.#spins.keys()) {
			const entityId = this.#entityIds[index];
			if (!seen.has(entityId)) {
				seen.add(entityId);
				out.push({ entityId, ride: null });
			}
		}
		return out;
	}

	/**
	 * appends a row
	 *
	 * @param row the instance
	 * @param group extra sort key applied before the chain (e.g. the node of an HLOD row); 0 when unused
	 * @returns the row's insertion index
	 * @throws {RangeError} if a decal placement isn't {@link DECAL_PLACEMENT_FLOATS} floats
	 */
	add(row: InstanceInput, group: number): number {
		const m = row.matrix;
		// top three rows of the column-major matrix, row-major; translation made relative later
		this.#matrices.push(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]);
		const { center, extents } = row.bounds;
		this.#bounds.push(center[0], center[1], center[2], extents[0], extents[1], extents[2]);
		this.#chains.push(row.chain);
		this.#groups.push(group);
		this.#entityIds.push(row.entityId);
		if (row.decalPlacement !== undefined) {
			if (row.decalPlacement.length !== DECAL_PLACEMENT_FLOATS) {
				throw new RangeError(`a decal placement is ${DECAL_PLACEMENT_FLOATS} floats`);
			}
			this.#placements.set(this.#chains.length - 1, row.decalPlacement);
		}
		if (row.spin !== undefined) {
			this.#spins.set(this.#chains.length - 1, row.spin);
		}
		if (row.floatsOn !== undefined) {
			this.#floatsOn.set(this.#chains.length - 1, row.floatsOn);
		}
		if (row.ride !== undefined) {
			this.#rides.set(this.#chains.length - 1, row.ride);
		}
		if (row.clothHash !== undefined) {
			this.#cloths.set(this.#chains.length - 1, row.clothHash);
		}
		if (row.lodGroup !== undefined) {
			this.#lodGroups.set(this.#chains.length - 1, row.lodGroup);
		}
		return this.#chains.length - 1;
	}

	/**
	 * encodes the rows sorted by (group, chainHash), insertion order breaking ties, with a per-block local
	 * chain hash palette (`PLTT`) so the encoded bytes depend only on this block's own chains
	 *
	 * @param origin world position translations and bounds centres are made relative to
	 * @param chainHashes per interned chain id, its 64-bit canonical hash (`ChainTable.canonicalOrder`)
	 * @param volumes by water volume id, its index in the water table; a row floating on a volume missing here
	 *   is stored as not floating
	 * @returns the block, and per output row its insertion index
	 */
	toBlock(
		origin: [x: number, y: number, z: number],
		chainHashes: BigUint64Array,
		volumes: ReadonlyMap<string, number>,
		cloths: ReadonlyMap<number, number> = new Map(),
		motions: ReadonlyMap<RowPath, number> = new Map(),
		assemblyNodes: ReadonlyMap<number, number> = new Map(),
	): { block: InstanceBlock; order: Uint32Array } {
		const count = this.#chains.length;
		const hashOf = (i: number): bigint => chainHashes[this.#chains[i]];
		const order = Uint32Array.from({ length: count }, (_, i) => i);
		order.sort((a, b) => {
			if (this.#groups[a] !== this.#groups[b]) {
				return this.#groups[a] - this.#groups[b];
			}
			const ha = hashOf(a);
			const hb = hashOf(b);
			return ha < hb ? -1 : ha > hb ? 1 : a - b;
		});
		const paletteIndex = new Map<bigint, number>();
		const paletteList: bigint[] = [];
		const chains = new Uint32Array(count);
		const transforms = new Float32Array(count * 12);
		const bounds = new Float32Array(count * 6);
		const rowFlags = new Uint8Array(count);
		const decalRows = new Uint32Array(this.#placements.size);
		const placements = new Float32Array(this.#placements.size * DECAL_PLACEMENT_FLOATS);
		const spinRows = new Uint32Array(this.#spins.size);
		const spins = new Float32Array(this.#spins.size * SPIN_FLOATS);
		const floaterRows: number[] = [];
		const floaterVolumes: number[] = [];
		const rideRows: number[] = [];
		const ridePaths: number[] = [];
		const clothRows: number[] = [];
		const clothIndices: number[] = [];
		const motionRows: number[] = [];
		const motionValues: number[] = [];
		const assemblyRows: number[] = [];
		const assemblyIndices: number[] = [];
		const lodGroupRows: number[] = [];
		const lodGroupValues: number[] = [];
		/** the block's paths, in the order its rows first ride them */
		const paths = new Map<RowPath, number>();
		let decals = 0;
		let spinning = 0;
		for (let out = 0; out < count; out++) {
			const i = order[out];
			const hash = hashOf(i);
			chains[out] = paletteIndex.getOrInsertComputed(hash, () => paletteList.push(hash) - 1);
			const mBase = out * 12;
			for (let k = 0; k < 12; k++) {
				transforms[mBase + k] = this.#matrices[i * 12 + k];
			}
			transforms[mBase + 3] -= origin[0];
			transforms[mBase + 7] -= origin[1];
			transforms[mBase + 11] -= origin[2];
			const det =
				transforms[mBase] *
					(transforms[mBase + 5] * transforms[mBase + 10] - transforms[mBase + 6] * transforms[mBase + 9]) -
				transforms[mBase + 1] *
					(transforms[mBase + 4] * transforms[mBase + 10] - transforms[mBase + 6] * transforms[mBase + 8]) +
				transforms[mBase + 2] *
					(transforms[mBase + 4] * transforms[mBase + 9] - transforms[mBase + 5] * transforms[mBase + 8]);
			if (det < 0) {
				rowFlags[out] = RowFlags.Mirrored;
			}
			for (let k = 0; k < 6; k++) {
				bounds[out * 6 + k] = this.#bounds[i * 6 + k];
			}
			bounds[out * 6] -= origin[0];
			bounds[out * 6 + 1] -= origin[1];
			bounds[out * 6 + 2] -= origin[2];
			const placement = this.#placements.get(i);
			if (placement !== undefined) {
				decalRows[decals] = out;
				placements.set(placement, decals * DECAL_PLACEMENT_FLOATS);
				decals++;
			}
			const spin = this.#spins.get(i);
			if (spin !== undefined) {
				spinRows[spinning] = out;
				const { pivot, axis, speed } = spin;
				spins.set(
					[pivot[0] - origin[0], pivot[1] - origin[1], pivot[2] - origin[2], ...axis, speed],
					spinning * SPIN_FLOATS,
				);
				spinning++;
			}
			const floatsOn = this.#floatsOn.get(i);
			const volume = floatsOn === undefined ? undefined : volumes.get(floatsOn);
			if (volume !== undefined) {
				floaterRows.push(out);
				floaterVolumes.push(volume);
			}
			const ride = this.#rides.get(i);
			if (ride !== undefined) {
				rideRows.push(out);
				ridePaths.push(paths.getOrInsertComputed(ride, () => paths.size));
				const animBlob = motions.get(ride);
				if (animBlob !== undefined) {
					motionRows.push(out);
					motionValues.push(animBlob, 0);
					rowFlags[out] |= RowFlags.HasMotion;
				}
			}
			const assemblyNode = assemblyNodes.get(this.#entityIds[i]);
			if (assemblyNode !== undefined) {
				assemblyRows.push(out);
				assemblyIndices.push(assemblyNode);
			}
			const clothHash = this.#cloths.get(i);
			const clothIndex = clothHash === undefined ? undefined : cloths.get(clothHash);
			if (clothIndex !== undefined) {
				clothRows.push(out);
				clothIndices.push(clothIndex);
			}
			const lodGroup = this.#lodGroups.get(i);
			if (lodGroup !== undefined) {
				lodGroupRows.push(out);
				lodGroupValues.push(
					lodGroup[0] - origin[0],
					lodGroup[1] - origin[1],
					lodGroup[2] - origin[2],
					lodGroup[3],
				);
			}
		}
		return {
			block: {
				origin,
				palette: BigUint64Array.from(paletteList),
				chains,
				transforms,
				bounds,
				rowFlags,
				decals: { rows: decalRows, values: placements },
				spins: { rows: spinRows, values: spins },
				floaters: { rows: Uint32Array.from(floaterRows), values: Uint32Array.from(floaterVolumes) },
				rides: { rows: Uint32Array.from(rideRows), values: Uint32Array.from(ridePaths) },
				paths: [...paths.keys()],
				...(motionRows.length > 0
					? { motions: { rows: Uint32Array.from(motionRows), values: Uint32Array.from(motionValues) } }
					: {}),
				...(lodGroupRows.length > 0
					? {
							lodGroups: {
								rows: Uint32Array.from(lodGroupRows),
								values: Float32Array.from(lodGroupValues),
							},
						}
					: {}),
				...(assemblyRows.length > 0
					? {
							assemblyNodes: {
								rows: Uint32Array.from(assemblyRows),
								values: Uint32Array.from(assemblyIndices),
							},
						}
					: {}),
				...(clothRows.length > 0
					? { cloths: { rows: Uint32Array.from(clothRows), values: Uint32Array.from(clothIndices) } }
					: {}),
			},
			order,
		};
	}

	/**
	 * @param order output order from {@link InstanceBlockBuilder.toBlock}
	 * @returns the group key of each output row
	 */
	groupsInOrder(order: Uint32Array): number[] {
		return Array.from(order, (i) => this.#groups[i]);
	}

	/**
	 * @param order output order from {@link InstanceBlockBuilder.toBlock}
	 * @returns the entity id of each output row
	 */
	entityIdsInOrder(order: Uint32Array): number[] {
		return Array.from(order, (i) => this.#entityIds[i]);
	}
}
