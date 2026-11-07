/**
 * the tree tiles of HLOD clusters. cluster names (`HLOD<tier>_<i>_<j>_Cluster_…`) give the cell on the tier's
 * grid, but clamp negative coordinates to 0, and a cluster's bounds centre is a poor stand-in since one large
 * member can overhang its cell by hundreds of metres (see `docs/game-data/world.md#lod-and-hlod`). the grid's
 * cell size and origin differ per scene and aren't stored anywhere found, so they're fitted to the names.
 *
 * @module
 */

import type { Aabb } from '@endfield-noclip/formats/unity/values';
import { type TileKey, tileAt } from '@endfield-noclip/package-format/tiles';
import type { TreeInfo } from '@endfield-noclip/package-format/tree';

/** slack when testing whether a cluster's bounds contain a detail instance's, m */
const CONTAIN_SLACK = 0.5;

/**
 * the least share of clusters with an unclamped name whose bounds centre must lie in their named cell under
 * the fitted grid; below it the names don't follow any grid the fit tries
 */
const MIN_AGREEMENT = 0.8;

/** an axis needs this many unclamped names before its agreement is judged */
const MIN_SAMPLES = 8;

/** coarser tier-0 cells tried, as doublings of the leaf */
const MAX_CELL_DOUBLINGS = 3;

/**
 * how far a fitted origin may move to land on the tree's tiles, m. the fit's window is bounded by cluster
 * centres, so it rarely contains the exact corner
 */
const SNAP_TOLERANCE = 8;

/** an HLOD cluster as the grid sees it */
/** HLOD cluster entity names: `HLOD<tier>_<i>_<j>_Cluster_<hash>_<n>…`, `i`/`j` being the tier's grid cell */
export const HLOD_NAME = /^HLOD(\d)_(-?\d+)_(-?\d+)_Cluster_/;

export interface HlodSample {
	tier: number;
	/** the cell in its name */
	x: number;
	z: number;
	/** world x, z of its bounds centre */
	center: [x: number, z: number];
}

/** the grid HLOD cluster names count cells on, placed on the tile tree */
export interface HlodLayout {
	/** tier-0 cell edge, m; each tier doubles it */
	cellSize: number;
	/** world x, z of named cell (0, 0)'s minimum corner */
	origin: [x: number, z: number];
	/** tree level whose tiles are each tier's cell size */
	levels: number[];
	/** tiers whose cells are tree tiles, by tier; a misaligned tier's cells straddle tiles */
	aligned: boolean[];
	/** per axis, the share of unclamped names the grid explains, or `null` without enough names */
	agreement: [x: number | null, z: number | null];
}

/** an HLOD cluster's candidate tree tiles: `[x0, x1] × [z0, z1]` at `level`, inclusive */
export interface HlodCandidates {
	level: number;
	x: [lo: number, hi: number];
	z: [lo: number, hi: number];
}

/**
 * the window of grid origins along one axis that the most unclamped names agree with
 *
 * @returns the window and how many names agree, or `null` without any unclamped name
 */
const fitAxis = (
	samples: readonly HlodSample[],
	axis: 0 | 1,
	cellSize: number,
): { lo: number; hi: number; hits: number; names: number } | null => {
	// a name n > 0 on a cell of size s puts the origin in (c − (n + 1)s, c − n·s]
	const events: [at: number, delta: number][] = [];
	for (const sample of samples) {
		const name = axis === 0 ? sample.x : sample.z;
		if (name <= 0) {
			continue;
		}
		const size = cellSize * 2 ** sample.tier;
		const c = sample.center[axis];
		events.push([c - (name + 1) * size, 1], [c - name * size, -1]);
	}
	if (events.length === 0) {
		return null;
	}
	// at equal positions, close windows before opening new ones: the intervals are half-open
	events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	let depth = 0;
	let best = { lo: 0, hi: 0, hits: -1 };
	for (let i = 0; i < events.length; i++) {
		depth += events[i][1];
		if (events[i][1] > 0 && depth > best.hits) {
			best = { lo: events[i][0], hi: events[i + 1][0], hits: depth };
		}
	}
	return { ...best, names: events.length / 2 };
};

/** @returns the lattice point `base + k·step` nearest `[lo, hi]`, if it lies within the snap tolerance */
const snap = (lo: number, hi: number, base: number, step: number): number | null => {
	const middle = (lo + hi) / 2;
	const k = Math.round((middle - base) / step);
	const point = base + k * step;
	return Math.max(lo - point, point - hi, 0) <= SNAP_TOLERANCE ? point : null;
};

/**
 * fits the grid HLOD cluster names count cells on, and places it on the tile tree. the tier-0 cell is the
 * tree leaf or a power-of-two multiple of it, each tier doubling the cell; the origin is the one most names
 * agree with, snapped to the coarsest tree tiles within {@link SNAP_TOLERANCE}.
 *
 * @param samples every HLOD cluster of the scene
 * @param tree the tile tree's grid
 * @returns the layout; without clusters, or along an axis no name constrains, the tree's own grid
 * @throws {Error} if no grid explains the names along an axis
 */
export const layoutHlodGrid = (
	samples: readonly HlodSample[],
	tree: Pick<TreeInfo, 'origin' | 'rootSize' | 'leafLevel'>,
): HlodLayout => {
	const leafSize = tree.rootSize / 2 ** tree.leafLevel;
	const topTier = samples.reduce((top, sample) => Math.max(top, sample.tier), 0);

	let best: { cellSize: number; fits: ReturnType<typeof fitAxis>[]; hits: number } | null = null;
	for (
		let doublings = 0;
		doublings <= MAX_CELL_DOUBLINGS && tree.leafLevel - doublings - topTier >= 0;
		doublings++
	) {
		const cellSize = leafSize * 2 ** doublings;
		const fits = [fitAxis(samples, 0, cellSize), fitAxis(samples, 1, cellSize)];
		const hits = fits.reduce((sum, fit) => sum + (fit?.hits ?? 0), 0);
		// ties go to the finer cell
		if (best === null || hits > best.hits) {
			best = { cellSize, fits, hits };
		}
	}
	const cellSize = best?.cellSize ?? leafSize;
	const doublings = Math.log2(cellSize / leafSize);
	const levels = [0, 1, 2].map((tier) => tree.leafLevel - doublings - tier);

	const agreement: HlodLayout['agreement'] = [null, null];
	const origin: [number, number] = [tree.origin[0], tree.origin[1]];
	for (const axis of [0, 1] as const) {
		const fit = best?.fits[axis] ?? null;
		if (fit === null) {
			continue;
		}
		if (fit.names >= MIN_SAMPLES) {
			const share = fit.hits / fit.names;
			agreement[axis] = share;
			if (share < MIN_AGREEMENT) {
				throw new Error(
					`HLOD cluster names along ${axis === 0 ? 'x' : 'z'} follow no grid: at best ${fit.hits} of ` +
						`${fit.names} lie in their named cell`,
				);
			}
		}
		// the coarsest tree tiles the origin lands on, down to the leaf
		let snapped: number | null = null;
		for (let step = cellSize * 2 ** topTier; step >= leafSize && snapped === null; step /= 2) {
			snapped = snap(fit.lo, fit.hi, tree.origin[axis], step);
		}
		origin[axis] = snapped ?? (fit.lo + fit.hi) / 2;
	}

	const aligned = levels.map((_, tier) => {
		const size = cellSize * 2 ** tier;
		return [0, 1].every((axis) => Number.isInteger((origin[axis] - tree.origin[axis]) / size));
	});
	return { cellSize, origin, levels, aligned, agreement };
};

/**
 * the tree tiles a cluster may belong to: at its tier's level, those its named cell overlaps; along an axis
 * whose name may be clamped (named 0), also those west or south of it that the cluster's bounds span
 *
 * @param request the tree grid, the scene's HLOD layout, the cluster and its bounds
 * @returns its candidates; a single tile needs no {@link pickHlodTile}
 */
export const hlodCandidates = (request: {
	tree: Pick<TreeInfo, 'origin' | 'rootSize'>;
	layout: HlodLayout;
	sample: Pick<HlodSample, 'tier' | 'x' | 'z'>;
	bounds: Aabb;
}): HlodCandidates => {
	const { tree, layout, sample, bounds } = request;
	const level = layout.levels[sample.tier];
	const tileSize = tree.rootSize / 2 ** level;
	const cellSize = layout.cellSize * 2 ** sample.tier;
	const axis = (k: 0 | 1, name: number): [number, number] => {
		const lo = layout.origin[k] + name * cellSize;
		const first = Math.floor((lo - tree.origin[k]) / tileSize);
		const last = Math.ceil((lo + cellSize - tree.origin[k]) / tileSize) - 1;
		if (name !== 0) {
			return [first, last];
		}
		const reach = Math.floor((bounds.center[k * 2] - bounds.extents[k * 2] - tree.origin[k]) / tileSize);
		return [Math.min(reach, first), last];
	};
	return { level, x: axis(0, sample.x), z: axis(1, sample.z) };
};

const contains = (outer: Aabb, inner: Aabb): boolean => {
	for (let k = 0; k < 3; k++) {
		const reach = outer.extents[k] + CONTAIN_SLACK;
		if (
			inner.center[k] - inner.extents[k] < outer.center[k] - reach ||
			inner.center[k] + inner.extents[k] > outer.center[k] + reach
		) {
			return false;
		}
	}
	return true;
};

/**
 * picks a cluster's tile among its candidates: the one whose detail instances the cluster's bounds contain
 * most often wins. ties and clusters containing no detail go to the candidate nearest the bounds centre.
 *
 * @param request the tree grid, the leaf level, the candidates ({@link hlodCandidates}), the cluster's
 *   bounds, and the bounds of the detail instances filed under a leaf tile
 * @returns the cluster's tile
 */
export const pickHlodTile = (request: {
	tree: Pick<TreeInfo, 'origin' | 'rootSize'>;
	leafLevel: number;
	candidates: HlodCandidates;
	bounds: Aabb;
	detailAt: (leaf: TileKey) => readonly Aabb[];
}): TileKey => {
	const { tree, leafLevel, candidates, bounds, detailAt } = request;
	const {
		level,
		x: [x0, x1],
		z: [z0, z1],
	} = candidates;
	const center = tileAt(tree, level, bounds.center[0], bounds.center[2]);
	const nearX = Math.min(Math.max(center.x, x0), x1);
	const nearZ = Math.min(Math.max(center.z, z0), z1);

	const span = 2 ** (leafLevel - level);
	let best: TileKey = { level, x: nearX, z: nearZ };
	let bestScore = 0;
	let bestDistance = 0;
	for (let z = z0; z <= z1; z++) {
		for (let x = x0; x <= x1; x++) {
			let score = 0;
			for (let lz = z * span; lz < (z + 1) * span; lz++) {
				for (let lx = x * span; lx < (x + 1) * span; lx++) {
					for (const detail of detailAt({ level: leafLevel, x: lx, z: lz })) {
						if (contains(bounds, detail)) {
							score++;
						}
					}
				}
			}
			const distance = Math.max(Math.abs(x - nearX), Math.abs(z - nearZ));
			if (score > bestScore || (score === bestScore && score > 0 && distance < bestDistance)) {
				best = { level, x, z };
				bestScore = score;
				bestDistance = distance;
			}
		}
	}
	return best;
};
