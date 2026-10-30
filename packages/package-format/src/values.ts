/** a world x, z rectangle */
export interface Rect {
	minX: number;
	minZ: number;
	maxX: number;
	maxZ: number;
}

/** an axis-aligned box */
export interface Bounds {
	min: [x: number, y: number, z: number];
	max: [x: number, y: number, z: number];
}

/** an RGBA colour, as authored (not converted to linear; HDR colours exceed 1) */
export type Color = [r: number, g: number, b: number, a: number];

/** a `Vector2f` */
export type Vec2 = [x: number, y: number];

/** a `Vector3f`; directions and positions are in the Unity world frame */
export type Vec3 = [x: number, y: number, z: number];

/** a `Vector4f` */
export type Vec4 = [x: number, y: number, z: number, w: number];

/** a unit quaternion */
export type Quat = [x: number, y: number, z: number, w: number];

/**
 * @param a a box
 * @param b another box
 * @returns a new box enclosing both
 */
export const unionBounds = (a: Bounds, b: Bounds): Bounds => {
	return {
		min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
		max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
	};
};
