/**
 * the cells of HLOD clusters whose names lost them. cluster names (`HLOD<tier>_<i>_<j>_Cluster_…`) give the
 * cell on the tier's grid, but clamp negative coordinates to 0, and a cluster's bounds centre is a poor
 * stand-in since one large member can overhang its cell by hundreds of metres.
 *
 * @module
 */

import type { Aabb } from '@endfield-noclip/formats/unity/values';
import { type TileKey, type TreeInfo, tileAt } from '@endfield-noclip/package-format/format';

/** slack when testing whether a cluster's bounds contain a detail instance's, m */
const CONTAIN_SLACK = 0.5;

/**
 * @param named the cell in the cluster's name
 * @returns whether an axis of the name may have been clamped
 */
export const mayBeClamped = (named: TileKey): boolean => named.x === 0 || named.z === 0;

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
 * @returns the candidate coordinates along an axis: the named one, or for a name of 0 the spanned cells at or
 *   below 0
 */
const range = (name: number, lo: number, hi: number): [lo: number, hi: number] => {
	if (name !== 0) {
		return [name, name];
	}
	const top = Math.min(hi, 0);
	return [Math.min(lo, top), top];
};

/**
 * picks the cell of a cluster whose name may have clamped a coordinate: along each axis named 0, the
 * candidates are the cells at or below 0 that its bounds span, and the one whose detail instances the
 * cluster's bounds contain most often wins. ties and clusters containing no detail go to the candidate
 * nearest the bounds centre.
 *
 * @param request the tree grid, the leaf level, the named cell, the cluster's bounds, and the bounds of the
 *   detail instances filed under a leaf tile
 * @returns the cluster's cell, at the named cell's level
 */
export const resolveClampedHlodCell = (request: {
	tree: Pick<TreeInfo, 'origin' | 'rootSize'>;
	leafLevel: number;
	named: TileKey;
	bounds: Aabb;
	detailAt: (leaf: TileKey) => readonly Aabb[];
}): TileKey => {
	const { tree, leafLevel, named, bounds, detailAt } = request;
	const { level } = named;
	const [cx, , cz] = bounds.center;
	const low = tileAt(tree, level, cx - bounds.extents[0], cz - bounds.extents[2]);
	const high = tileAt(tree, level, cx + bounds.extents[0], cz + bounds.extents[2]);
	const center = tileAt(tree, level, cx, cz);
	const [x0, x1] = range(named.x, low.x, high.x);
	const [z0, z1] = range(named.z, low.z, high.z);
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
