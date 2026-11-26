/**
 * bounds over groups of consecutive instance rows, so the mesh selection can reject a whole group before
 * testing its rows one by one. a block's rows are mostly in placement order, which keeps neighbours near one
 * another (a group of 32 typically spans a few tens of metres), and dense views walk over 100k rows a frame,
 * most of them too small, too far for any LOD or out of view.
 *
 * @module
 */

import { SPIN_FLOATS } from '@endfield-noclip/package-format/instances';

import { CULL_FLOATS, ROW_WORDS, type RowRides, type RowSpins } from './instance-rows.ts';

/** rows per group; groups don't follow chain runs, so a group can hold rows of several chains */
export const GROUP_ROWS = 64;

/** f32 per group, laid out as {@link GroupFloat} names them */
export const GROUP_FLOATS = 8;

/** offsets into a group's floats */
export const GroupFloat = {
	/** the centre of the rows' bounds centres, relative to the block origin (3 floats) */
	center: 0,
	/** the farthest row centre from {@link center} */
	centersRadius: 3,
	/** the sphere around every row's bounding sphere */
	radius: 4,
	/** the largest row bounding-sphere radius */
	rowRadius: 5,
	/**
	 * the largest LOD reach of a row: beyond `reach · pixelFactor / viewportHeight` metres no LOD of it draws
	 * (`Infinity` when one always does)
	 */
	reach: 6,
} as const;

/** what {@link buildRowGroups} reads of a block */
export interface GroupedRows {
	/** the rows, {@link ROW_WORDS} each, as {@link InstanceRows.rows} lays them out */
	rowsF32: Float32Array;
	/** {@link CULL_FLOATS} per row */
	cull: Float32Array;
	/** (chain, first, count) runs */
	runs: Uint32Array;
	/** the block's spinning rows, whose bounds sweep about their pivots; `null` when none */
	spins: RowSpins | null;
	/** the block's riding rows, whose bounds sweep along their paths; `null` when none */
	rides: RowRides | null;
}

/** a moving row's swept centre sphere: `[cx, cy, cz, sweepRadius]` relative to the block origin */
type SweptCenter = readonly [number, number, number, number];

/** f32 per spinning row in `RowSpins.base` */
const SPIN_BASE_FLOATS = 15;
/** f32 per riding row in `RowRides.base` */
const RIDE_BASE_FLOATS = 6;

/**
 * computes an exact swept sphere for every spinning and riding row's bounds centre, so moving rows stay
 * finitely bounded and GPU-cullable at all times
 */
const sweptCentersOf = (spins: RowSpins | null, rides: RowRides | null): Map<number, SweptCenter> | null => {
	if (spins === null && rides === null) {
		return null;
	}
	const swept = new Map<number, SweptCenter>();
	if (spins !== null) {
		const { rows, values, base } = spins;
		for (let s = 0; s < rows.length; s++) {
			const v = s * SPIN_FLOATS;
			const px = values[v];
			const py = values[v + 1];
			const pz = values[v + 2];
			const b = s * SPIN_BASE_FLOATS;
			const dx = base[b + 12] - px;
			const dy = base[b + 13] - py;
			const dz = base[b + 14] - pz;
			swept.set(rows[s], [px, py, pz, Math.sqrt(dx * dx + dy * dy + dz * dz)]);
		}
	}
	if (rides !== null) {
		const { rows, pathOf, base, paths } = rides;
		const pathBounds: SweptCenter[] = paths.map(({ offsets }) => {
			if (offsets.length < 3) {
				return [0, 0, 0, 0];
			}
			let minX = Infinity;
			let minY = Infinity;
			let minZ = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			let maxZ = -Infinity;
			for (let k = 0; k < offsets.length; k += 3) {
				const x = offsets[k];
				const y = offsets[k + 1];
				const z = offsets[k + 2];
				if (x < minX) {
					minX = x;
				}
				if (y < minY) {
					minY = y;
				}
				if (z < minZ) {
					minZ = z;
				}
				if (x > maxX) {
					maxX = x;
				}
				if (y > maxY) {
					maxY = y;
				}
				if (z > maxZ) {
					maxZ = z;
				}
			}
			const mx = (minX + maxX) * 0.5;
			const my = (minY + maxY) * 0.5;
			const mz = (minZ + maxZ) * 0.5;
			let maxSq = 0;
			for (let k = 0; k < offsets.length; k += 3) {
				const dx = offsets[k] - mx;
				const dy = offsets[k + 1] - my;
				const dz = offsets[k + 2] - mz;
				const sq = dx * dx + dy * dy + dz * dz;
				if (sq > maxSq) {
					maxSq = sq;
				}
			}
			return [mx, my, mz, Math.sqrt(maxSq)];
		});
		for (let s = 0; s < rows.length; s++) {
			const b = s * RIDE_BASE_FLOATS;
			const pb = pathBounds[pathOf[s]];
			swept.set(rows[s], [base[b + 3] + pb[0], base[b + 4] + pb[1], base[b + 5] + pb[2], pb[3]]);
		}
	}
	return swept;
};

/**
 * the farthest a chain's instances draw, as a factor of their LODGroup size: Unity's metric is `2 · size ·
 * pixelFactor / (distance · viewportHeight)`, and nothing draws once its square falls to the chain's lowest
 * `minSquared`.
 *
 * @param minSquared the lowest `minSquared` of the chain's drawn slots, or `null` when it has none
 * @param measuredByDistance the chain's bands are squared distances rather than screen sizes
 * @returns the reach per metre of size; `Infinity` when its instances never fall out by size
 */
export const chainReach = (minSquared: number | null, measuredByDistance: boolean): number => {
	if (minSquared === null) {
		return 0;
	}
	if (measuredByDistance || minSquared <= 0) {
		return Infinity;
	}
	return 2 / Math.sqrt(minSquared);
};

/**
 * @param rowsF32 a block's rows, {@link ROW_WORDS} each, starting with their transform's top three rows
 * @param count how many rows
 * @returns 1 per row whose transform mirrors it (a negative determinant), else 0; turning never changes it
 */
export const mirroredRows = (rowsF32: Float32Array, count: number): Uint8Array<ArrayBuffer> => {
	const mirrored = new Uint8Array(count);
	for (let i = 0; i < count; i++) {
		const at = i * ROW_WORDS;
		const f = rowsF32;
		const det =
			f[at] * (f[at + 5] * f[at + 10] - f[at + 6] * f[at + 9]) -
			f[at + 1] * (f[at + 4] * f[at + 10] - f[at + 6] * f[at + 8]) +
			f[at + 2] * (f[at + 4] * f[at + 9] - f[at + 5] * f[at + 8]);
		mirrored[i] = det < 0 ? 1 : 0;
	}
	return mirrored;
};

/** f32 per segment, laid out as {@link SegmentFloat} names them */
export const SEGMENT_FLOATS = 11;

/** offsets into a segment's floats: the rows of a group in one chain run */
export const SegmentFloat = {
	first: 0,
	end: 1,
	/** the chain run, counted in runs */
	run: 2,
	/** the smallest and largest LOD size of its rows (largest half extent) */
	minSize: 3,
	maxSize: 4,
	/** bit 0 when it holds unmirrored rows, bit 1 when it holds mirrored ones */
	handedness: 5,
	/** the centre of its rows' bounds centres, relative to the block origin (3 floats) */
	center: 6,
	/** the farthest row centre from {@link center} */
	centersRadius: 9,
	/** the sphere around every row's bounding sphere */
	radius: 10,
} as const;

/**
 * splits each group's rows by chain run, so the GPU path can pick a segment's LODs by its rows' sizes and
 * distances, which a segment bounds tighter than its group
 *
 * @param rowsF32 the block's rows, {@link ROW_WORDS} each
 * @param runs (chain, first, count) runs
 * @param cull {@link CULL_FLOATS} per row
 * @param mirrored 1 per mirrored row, from {@link mirroredRows}
 * @returns {@link SEGMENT_FLOATS} per segment, and per group where its segments start (one more entry ends
 *   the last)
 */
export const groupSegmentsOf = (
	rowsF32: Float32Array,
	runs: Uint32Array,
	cull: Float32Array,
	mirrored: Uint8Array,
	swept: Map<number, SweptCenter> | null = null,
): { segments: Float32Array<ArrayBuffer>; groupSegments: Uint32Array<ArrayBuffer> } => {
	const count = cull.length / CULL_FLOATS;
	const groupCount = Math.ceil(count / GROUP_ROWS);
	const groupSegments = new Uint32Array(groupCount + 1);
	const out: number[] = [];
	let r = 0;
	for (let g = 0; g < groupCount; g++) {
		groupSegments[g] = out.length / SEGMENT_FLOATS;
		const first = g * GROUP_ROWS;
		const end = Math.min(count, first + GROUP_ROWS);
		while (r < runs.length && runs[r + 1] + runs[r + 2] <= first) {
			r += 3;
		}
		for (let q = r; q < runs.length && runs[q + 1] < end; q += 3) {
			const s0 = Math.max(first, runs[q + 1]);
			const s1 = Math.min(end, runs[q + 1] + runs[q + 2]);
			let minSize = Infinity;
			let maxSize = 0;
			let handedness = 0;
			let minX = Infinity;
			let minY = Infinity;
			let minZ = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			let maxZ = -Infinity;
			for (let i = s0; i < s1; i++) {
				const size = cull[i * CULL_FLOATS + 1];
				if (size < minSize) {
					minSize = size;
				}
				if (size > maxSize) {
					maxSize = size;
				}
				handedness |= mirrored[i] === 1 ? 2 : 1;
				const sw = swept?.get(i);
				const x = sw !== undefined ? sw[0] : rowsF32[i * ROW_WORDS + 12];
				const y = sw !== undefined ? sw[1] : rowsF32[i * ROW_WORDS + 13];
				const z = sw !== undefined ? sw[2] : rowsF32[i * ROW_WORDS + 14];
				const sr = sw !== undefined ? sw[3] : 0;
				if (x - sr < minX) {
					minX = x - sr;
				}
				if (y - sr < minY) {
					minY = y - sr;
				}
				if (z - sr < minZ) {
					minZ = z - sr;
				}
				if (x + sr > maxX) {
					maxX = x + sr;
				}
				if (y + sr > maxY) {
					maxY = y + sr;
				}
				if (z + sr > maxZ) {
					maxZ = z + sr;
				}
			}
			const cx = (minX + maxX) * 0.5;
			const cy = (minY + maxY) * 0.5;
			const cz = (minZ + maxZ) * 0.5;
			let centers = 0;
			let radius = 0;
			for (let i = s0; i < s1; i++) {
				const sw = swept?.get(i);
				const dx = (sw !== undefined ? sw[0] : rowsF32[i * ROW_WORDS + 12]) - cx;
				const dy = (sw !== undefined ? sw[1] : rowsF32[i * ROW_WORDS + 13]) - cy;
				const dz = (sw !== undefined ? sw[2] : rowsF32[i * ROW_WORDS + 14]) - cz;
				const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + (sw !== undefined ? sw[3] : 0);
				if (d > centers) {
					centers = d;
				}
				const total = d + cull[i * CULL_FLOATS];
				if (total > radius) {
					radius = total;
				}
			}
			// a centimetre more covers the centre's rounding to f32
			out.push(s0, s1, q / 3, minSize, maxSize, handedness, cx, cy, cz, centers + 0.01, radius + 0.01);
		}
	}
	groupSegments[groupCount] = out.length / SEGMENT_FLOATS;
	return { segments: new Float32Array(out), groupSegments };
};

/**
 * what the mesh selection culls a block's rows by, derived from the rows alone, so the decode worker builds
 * it beside them
 */
export interface RowBounds {
	/** {@link GROUP_FLOATS} per group of {@link GROUP_ROWS} rows, from {@link buildRowGroups} */
	groups: Float32Array<ArrayBuffer>;
	/** 1 per mirrored row, from {@link mirroredRows} */
	mirrored: Uint8Array<ArrayBuffer>;
	/** each group's rows split by chain run, from {@link groupSegmentsOf} */
	segments: Float32Array<ArrayBuffer>;
	/** per group, where its segments start; one more entry ends the last */
	groupSegments: Uint32Array<ArrayBuffer>;
}

/**
 * @param rows the block's rows
 * @param rowFlags optional pre-baked `RowFlags` per row from `.inst` `FLAG` section (bit 0 = mirrored)
 * @returns the block's {@link RowBounds}, its groups reaching any distance until {@link setGroupReaches}
 */
export const buildRowBounds = (rows: GroupedRows, rowFlags?: Uint8Array): RowBounds => {
	const count = rows.cull.length / CULL_FLOATS;
	let mirrored: Uint8Array<ArrayBuffer>;
	if (rowFlags !== undefined && rowFlags.length === count) {
		mirrored = new Uint8Array(count);
		for (let i = 0; i < count; i++) {
			mirrored[i] = rowFlags[i] & 1;
		}
	} else {
		mirrored = mirroredRows(rows.rowsF32, count);
	}
	const swept = sweptCentersOf(rows.spins, rows.rides);
	return {
		groups: buildRowGroupsFromSwept(rows.rowsF32, rows.cull, swept),
		mirrored,
		...groupSegmentsOf(rows.rowsF32, rows.runs, rows.cull, mirrored, swept),
	};
};

/**
 * sets each group's {@link GroupFloat.reach}, the largest reach of a row of it, which only the chains' drawn
 * slots tell
 *
 * @param bounds the block's bounds; the reach of each of its groups is overwritten
 * @param runs the block's (chain, first, count) runs
 * @param reachOf a chain's reach per metre of size, from {@link chainReach}
 */
export const setGroupReaches = (
	bounds: RowBounds,
	runs: Uint32Array,
	reachOf: (chain: number) => number,
): void => {
	const { groups, segments, groupSegments } = bounds;
	for (let g = 0; g + 1 < groupSegments.length; g++) {
		// a segment's largest row reaches farthest of its rows, which share its chain
		let reach = 0;
		for (let s = groupSegments[g]; s < groupSegments[g + 1]; s++) {
			const at = s * SEGMENT_FLOATS;
			reach = Math.max(
				reach,
				reachOf(runs[segments[at + SegmentFloat.run] * 3]) * segments[at + SegmentFloat.maxSize],
			);
		}
		groups[g * GROUP_FLOATS + GroupFloat.reach] = reach;
	}
};

/**
 * @param rows the block's rows
 * @returns {@link GROUP_FLOATS} floats per group of {@link GROUP_ROWS} rows, the last group possibly shorter,
 *   each with an infinite {@link GroupFloat.reach}
 */
export const buildRowGroups = (rows: GroupedRows): Float32Array<ArrayBuffer> =>
	buildRowGroupsFromSwept(rows.rowsF32, rows.cull, sweptCentersOf(rows.spins, rows.rides));

const buildRowGroupsFromSwept = (
	f32: Float32Array,
	cull: Float32Array,
	swept: Map<number, SweptCenter> | null,
): Float32Array<ArrayBuffer> => {
	const count = cull.length / CULL_FLOATS;
	const groups = new Float32Array(Math.ceil(count / GROUP_ROWS) * GROUP_FLOATS);
	for (let g = 0; g * GROUP_ROWS < count; g++) {
		const first = g * GROUP_ROWS;
		const end = Math.min(count, first + GROUP_ROWS);
		let minX = Infinity;
		let minY = Infinity;
		let minZ = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let maxZ = -Infinity;
		for (let i = first; i < end; i++) {
			const sw = swept?.get(i);
			const x = sw !== undefined ? sw[0] : f32[i * ROW_WORDS + 12];
			const y = sw !== undefined ? sw[1] : f32[i * ROW_WORDS + 13];
			const z = sw !== undefined ? sw[2] : f32[i * ROW_WORDS + 14];
			const sr = sw !== undefined ? sw[3] : 0;
			if (x - sr < minX) {
				minX = x - sr;
			}
			if (y - sr < minY) {
				minY = y - sr;
			}
			if (z - sr < minZ) {
				minZ = z - sr;
			}
			if (x + sr > maxX) {
				maxX = x + sr;
			}
			if (y + sr > maxY) {
				maxY = y + sr;
			}
			if (z + sr > maxZ) {
				maxZ = z + sr;
			}
		}
		const cx = (minX + maxX) * 0.5;
		const cy = (minY + maxY) * 0.5;
		const cz = (minZ + maxZ) * 0.5;
		let centers = 0;
		let radius = 0;
		let rowRadius = 0;
		for (let i = first; i < end; i++) {
			const sw = swept?.get(i);
			const dx = (sw !== undefined ? sw[0] : f32[i * ROW_WORDS + 12]) - cx;
			const dy = (sw !== undefined ? sw[1] : f32[i * ROW_WORDS + 13]) - cy;
			const dz = (sw !== undefined ? sw[2] : f32[i * ROW_WORDS + 14]) - cz;
			const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + (sw !== undefined ? sw[3] : 0);
			const r = cull[i * CULL_FLOATS];
			if (d > centers) {
				centers = d;
			}
			if (d + r > radius) {
				radius = d + r;
			}
			if (r > rowRadius) {
				rowRadius = r;
			}
		}
		const out = g * GROUP_FLOATS;
		groups[out + GroupFloat.center] = cx;
		groups[out + GroupFloat.center + 1] = cy;
		groups[out + GroupFloat.center + 2] = cz;
		// a centimetre more covers the centre's rounding to f32
		groups[out + GroupFloat.centersRadius] = centers + 0.01;
		groups[out + GroupFloat.radius] = radius + 0.01;
		groups[out + GroupFloat.rowRadius] = rowRadius;
		groups[out + GroupFloat.reach] = Infinity;
	}
	return groups;
};
