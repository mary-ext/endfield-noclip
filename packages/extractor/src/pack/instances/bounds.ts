import type { Rotator } from '@endfield-noclip/formats/endfield/init-chunk-data';
import type { Aabb } from '@endfield-noclip/formats/unity/values';
import type { RowPath } from '@endfield-noclip/package-format/instances';
import type { Bounds, Rect } from '@endfield-noclip/package-format/values';

/** @returns the min/max form of a centre/extents box */
export const aabbBounds = ({ center, extents }: Aabb): Bounds => ({
	min: [center[0] - extents[0], center[1] - extents[1], center[2] - extents[2]],
	max: [center[0] + extents[0], center[1] + extents[1], center[2] + extents[2]],
});

/** grows owned bounds, in place, to enclose an AABB */
export const growBounds = (bounds: Bounds, { center, extents }: Aabb): void => {
	for (let axis = 0; axis < 3; axis++) {
		bounds.min[axis] = Math.min(bounds.min[axis], center[axis] - extents[axis]);
		bounds.max[axis] = Math.max(bounds.max[axis], center[axis] + extents[axis]);
	}
};

/**
 * @param bounds a box at one orientation
 * @param spin the axis it turns about
 * @returns a box holding it at every angle: that of the cylinder its corners sweep
 */
export const sweptBounds = (bounds: Aabb, spin: Pick<Rotator, 'axis' | 'pivot'>): Aabb => {
	const { axis, pivot } = spin;
	let radius = 0;
	let low = Infinity;
	let high = -Infinity;
	for (let corner = 0; corner < 8; corner++) {
		const d = [0, 1, 2].map(
			(i) => bounds.center[i] + ((corner >> i) & 1 ? 1 : -1) * bounds.extents[i] - pivot[i],
		);
		const along = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
		low = Math.min(low, along);
		high = Math.max(high, along);
		radius = Math.max(
			radius,
			Math.hypot(d[0] - along * axis[0], d[1] - along * axis[1], d[2] - along * axis[2]),
		);
	}
	const mid = (low + high) / 2;
	const half = (high - low) / 2;
	// the union of the cylinder's end discs; a disc of radius r normal to a reaches r·√(1 − aᵢ²) along axis i
	const extent = (i: number): number =>
		half * Math.abs(axis[i]) + radius * Math.sqrt(Math.max(0, 1 - axis[i] ** 2));
	return {
		center: [pivot[0] + mid * axis[0], pivot[1] + mid * axis[1], pivot[2] + mid * axis[2]],
		extents: [extent(0), extent(1), extent(2)],
	};
};

/**
 * @param bounds a box where it's placed
 * @param ride the path it rides
 * @returns a box holding it at every frame of the path
 */
export const riddenBounds = (bounds: Aabb, { offsets }: RowPath): Aabb => {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < offsets.length; i++) {
		min[i % 3] = Math.min(min[i % 3], offsets[i]);
		max[i % 3] = Math.max(max[i % 3], offsets[i]);
	}
	const axis = (i: number): number => bounds.center[i] + (min[i] + max[i]) / 2;
	const reach = (i: number): number => bounds.extents[i] + (max[i] - min[i]) / 2;
	return { center: [axis(0), axis(1), axis(2)], extents: [reach(0), reach(1), reach(2)] };
};

/** @returns whether an x/z square overlaps a rect; touching edges don't count */
export const squareOverlapsRect = (
	{ minX, minZ, size }: { minX: number; minZ: number; size: number },
	rect: Rect,
): boolean => minX < rect.maxX && minX + size > rect.minX && minZ < rect.maxZ && minZ + size > rect.minZ;
