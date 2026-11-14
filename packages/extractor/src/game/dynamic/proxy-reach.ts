/**
 * where a dynamic effect row's LOD proxy is at each level (docs/game-data/world.md#dynamic-load-grids): level
 * 0 while its near grid is loaded, 1 while only its far grid is, 2 while neither is, all within the row's own
 * grid's reach
 *
 * @module
 */

import type { Rect } from '@endfield-noclip/package-format/values';

import { gridIdReach } from './dynamic-grids.ts';

/**
 * @param row the grid storing the row
 * @param lodGrids the near and far grids its LOD proxy follows
 * @param levels a mask of proxy levels (bit `i` for level `i`)
 * @returns disjoint rectangles covering where the streaming centre loads the row with its proxy at one of
 *   `levels`; empty when it never is
 */
export const proxyLevelReaches = (
	row: number,
	[near, far]: readonly [number, number],
	levels: number,
): Rect[] => {
	const own = gridIdReach(row);
	const nearReach = gridIdReach(near);
	const farReach = gridIdReach(far);
	const byLevel = [
		intersect([own], nearReach),
		subtract(intersect([own], farReach), nearReach),
		subtract(subtract([own], nearReach), farReach),
	];
	return merge(byLevel.filter((_, level) => ((levels >> level) & 1) !== 0).flat());
};

const isEmpty = (rect: Rect): boolean => rect.minX >= rect.maxX || rect.minZ >= rect.maxZ;

const intersect = (rects: readonly Rect[], by: Rect): Rect[] =>
	rects
		.map((rect) => ({
			minX: Math.max(rect.minX, by.minX),
			minZ: Math.max(rect.minZ, by.minZ),
			maxX: Math.min(rect.maxX, by.maxX),
			maxZ: Math.min(rect.maxZ, by.maxZ),
		}))
		.filter((rect) => !isEmpty(rect));

/** cuts `by` out of each rectangle: full-width strips below and above it, then the sides between them */
const subtract = (rects: readonly Rect[], by: Rect): Rect[] =>
	rects.flatMap((rect) => {
		const [overlap] = intersect([rect], by);
		if (overlap === undefined) {
			return [rect];
		}
		return [
			{ ...rect, maxZ: overlap.minZ },
			{ ...rect, minZ: overlap.maxZ },
			{ minX: rect.minX, minZ: overlap.minZ, maxX: overlap.minX, maxZ: overlap.maxZ },
			{ minX: overlap.maxX, minZ: overlap.minZ, maxX: rect.maxX, maxZ: overlap.maxZ },
		].filter((part) => !isEmpty(part));
	});

/** joins rectangles sharing a whole edge until none do, so a ring and its hole become one rectangle again */
const merge = (rects: readonly Rect[]): Rect[] => {
	const out = [...rects];
	for (let joined = true; joined;) {
		joined = false;
		for (let i = 0; i < out.length && !joined; i++) {
			for (let j = i + 1; j < out.length && !joined; j++) {
				const a = out[i];
				const b = out[j];
				const alongX = a.minZ === b.minZ && a.maxZ === b.maxZ && (a.maxX === b.minX || b.maxX === a.minX);
				const alongZ = a.minX === b.minX && a.maxX === b.maxX && (a.maxZ === b.minZ || b.maxZ === a.minZ);
				if (alongX || alongZ) {
					out[i] = {
						minX: Math.min(a.minX, b.minX),
						minZ: Math.min(a.minZ, b.minZ),
						maxX: Math.max(a.maxX, b.maxX),
						maxZ: Math.max(a.maxZ, b.maxZ),
					};
					out.splice(j, 1);
					joined = true;
				}
			}
		}
	}
	return out;
};
