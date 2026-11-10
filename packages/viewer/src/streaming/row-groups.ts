/**
 * bounds over groups of consecutive instance rows, so the mesh selection can reject a whole group before
 * testing its rows one by one. a block's rows are mostly in placement order, which keeps neighbours near one
 * another (a group of 32 typically spans a few tens of metres), and dense views walk over 100k rows a frame,
 * most of them too small, too far for any LOD or out of view.
 *
 * @module
 */

import { CULL_FLOATS, ROW_WORDS } from '../content/instance-rows.ts';

/** rows per group; groups don't follow chain runs, so a group can hold rows of several chains */
export const GROUP_ROWS = 32;

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
	/** rows whose transform changes after the groups are built (spinning rows), ascending; never culled by group */
	moving: ArrayLike<number> | null;
}

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
export const mirroredRows = (rowsF32: Float32Array, count: number): Uint8Array => {
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
): { segments: Float32Array; groupSegments: Uint32Array } => {
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
			const min = [Infinity, Infinity, Infinity];
			const max = [-Infinity, -Infinity, -Infinity];
			for (let i = s0; i < s1; i++) {
				const size = cull[i * CULL_FLOATS + 1];
				minSize = Math.min(minSize, size);
				maxSize = Math.max(maxSize, size);
				handedness |= mirrored[i] === 1 ? 2 : 1;
				for (let k = 0; k < 3; k++) {
					min[k] = Math.min(min[k], rowsF32[i * ROW_WORDS + 12 + k]);
					max[k] = Math.max(max[k], rowsF32[i * ROW_WORDS + 12 + k]);
				}
			}
			const centre = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
			let centers = 0;
			let radius = 0;
			for (let i = s0; i < s1; i++) {
				const at = i * ROW_WORDS + 12;
				const d = Math.hypot(
					rowsF32[at] - centre[0],
					rowsF32[at + 1] - centre[1],
					rowsF32[at + 2] - centre[2],
				);
				centers = Math.max(centers, d);
				radius = Math.max(radius, d + cull[i * CULL_FLOATS]);
			}
			// a centimetre more covers the centre's rounding to f32
			out.push(s0, s1, q / 3, minSize, maxSize, handedness, ...centre, centers + 0.01, radius + 0.01);
		}
	}
	groupSegments[groupCount] = out.length / SEGMENT_FLOATS;
	return { segments: new Float32Array(out), groupSegments };
};

/**
 * @param rows the block's rows
 * @param reachOf a chain's reach per metre of size, from {@link chainReach}
 * @returns {@link GROUP_FLOATS} floats per group of {@link GROUP_ROWS} rows, the last group possibly shorter
 */
export const buildRowGroups = (rows: GroupedRows, reachOf: (chain: number) => number): Float32Array => {
	const { rowsF32: f32, cull, runs, moving } = rows;
	const count = cull.length / CULL_FLOATS;
	const groups = new Float32Array(Math.ceil(count / GROUP_ROWS) * GROUP_FLOATS);
	const reach = new Float64Array(count);
	for (let r = 0; r < runs.length; r += 3) {
		const perSize = reachOf(runs[r]);
		for (let i = runs[r + 1]; i < runs[r + 1] + runs[r + 2]; i++) {
			reach[i] = perSize * cull[i * CULL_FLOATS + 1];
		}
	}
	let next = 0;
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
			const at = i * ROW_WORDS;
			minX = Math.min(minX, f32[at + 12]);
			minY = Math.min(minY, f32[at + 13]);
			minZ = Math.min(minZ, f32[at + 14]);
			maxX = Math.max(maxX, f32[at + 12]);
			maxY = Math.max(maxY, f32[at + 13]);
			maxZ = Math.max(maxZ, f32[at + 14]);
		}
		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;
		const cz = (minZ + maxZ) / 2;
		let centers = 0;
		let radius = 0;
		let rowRadius = 0;
		let groupReach = 0;
		for (let i = first; i < end; i++) {
			const at = i * ROW_WORDS;
			const d = Math.hypot(f32[at + 12] - cx, f32[at + 13] - cy, f32[at + 14] - cz);
			const r = cull[i * CULL_FLOATS];
			centers = Math.max(centers, d);
			radius = Math.max(radius, d + r);
			rowRadius = Math.max(rowRadius, r);
			groupReach = Math.max(groupReach, reach[i]);
		}
		// a moving row can be anywhere its turning takes it
		if (moving !== null) {
			while (next < moving.length && moving[next] < first) {
				next++;
			}
			if (next < moving.length && moving[next] < end) {
				centers = Infinity;
				radius = Infinity;
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
		groups[out + GroupFloat.reach] = groupReach;
	}
	return groups;
};
