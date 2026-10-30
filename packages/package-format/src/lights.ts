import type { Vec3 } from './values.ts';

/**
 * `tables/lights.json`: the scene's local point and spot lights, loaded with the core. a viewer lights with
 * the ones whose group shows, like instances. the game's directional lights, lights that only cast shadows
 * and lights that only light characters are left out
 */
export interface LightsTable {
	lights: LightEntry[];
}

/** {@link LightEntry.kind} values */
export const LightKind = {
	Spot: 0,
	/** a point, or a tube along {@link LightEntry.direction} when {@link LightEntry.tubeLength} is positive */
	Point: 1,
} as const;

export type LightKind = (typeof LightKind)[keyof typeof LightKind];

/** one local light, with the fields the game's shading reads */
export interface LightEntry {
	kind: LightKind;
	/** the game's entity id */
	id: number;
	/** index into `StatesInfo.groups`: the owning level and the scene states that load the light */
	group: number;
	position: Vec3;
	/** unit direction the light points along (a spot's axis, a tube's segment) */
	direction: Vec3;
	/**
	 * linear colour times intensity and colour-temperature tint, in the units the shading adds to the scene as
	 * they are (the game doesn't pre-expose local lights)
	 */
	color: Vec3;
	/** metres; the light reaches nothing farther */
	range: number;
	/** full cone angles, degrees; 0 for points */
	spotAngle: number;
	innerSpotAngle: number;
	/** metres; 0 unless a tube */
	tubeLength: number;
	/** metres; widens highlights */
	softSourceRadius: number;
	/** distance falloff `(1 − d²/range²)^exponent`; negative for inverse square with a smooth window */
	falloffExponent: number;
	specularIntensity: number;
	/** scales the light in the volumetric fog; 0 leaves the fog unlit */
	volumetricScatteringIntensity: number;
	/** orders lights at equal camera distance when there are more than a viewer draws */
	priority: number;
	/**
	 * camera distances (m) over which the light fades out: full up to `falloff`, linearly in squared distance
	 * to nothing at `culling`. `null` when it never fades
	 */
	distanceFade: { falloff: number; culling: number } | null;
	/**
	 * a box confining the light: world point `p` maps to box units by `q = M · (p − position)` with `M` this
	 * rows3x4 matrix (the inverse of the box's transform, scaled to half extents), and the light fades over
	 * `max |q|` from `(1 + falloffThreshold) / 2` to 1. `null` when unconfined
	 */
	cullingBox: { matrix: number[]; falloffThreshold: number } | null;
}
