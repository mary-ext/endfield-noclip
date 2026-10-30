import type { Aabb } from '@endfield-noclip/formats/unity/values';
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

/** @returns whether an x/z square overlaps a rect; touching edges don't count */
export const squareOverlapsRect = (
	{ minX, minZ, size }: { minX: number; minZ: number; size: number },
	rect: Rect,
): boolean => minX < rect.maxX && minX + size > rect.minX && minZ < rect.maxZ && minZ + size > rect.minZ;
