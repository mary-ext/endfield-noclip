import { SHADOW_LAYERS, type ShadowLayerVolumes } from '../render/shadows/shadow-map.ts';

/**
 * @param runs (chain, first, count) triples in row order
 * @param row a row
 * @returns the word offset of the run containing `row`, or of the first run after it
 */
export const firstRunAt = (runs: Uint32Array, row: number): number => {
	let lo = 0;
	let hi = runs.length / 3;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (runs[mid * 3 + 1] + runs[mid * 3 + 2] <= row) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo * 3;
};

/**
 * @param planes camera-relative planes, (normal, distance) each
 * @param floats how many of `planes`' floats to test, 4 per plane
 * @param x the sphere's camera-relative centre
 * @param y
 * @param z
 * @param radius the sphere's radius
 * @returns whether the sphere is at least partly inside the planes
 */
export const sphereInPlanes = (
	planes: Float64Array,
	floats: number,
	x: number,
	y: number,
	z: number,
	radius: number,
): boolean => {
	for (let p = 0; p < floats; p += 4) {
		if (planes[p] * x + planes[p + 1] * y + planes[p + 2] * z + planes[p + 3] < -radius) {
			return false;
		}
	}
	return true;
};

/**
 * @param planes camera-relative planes, (normal, distance) each
 * @param floats how many of `planes`' floats to test, 4 per plane
 * @param x the sphere's camera-relative centre
 * @param y
 * @param z
 * @param radius the sphere's radius
 * @returns whether the sphere is wholly inside the planes
 */
export const sphereInsidePlanes = (
	planes: Float64Array,
	floats: number,
	x: number,
	y: number,
	z: number,
	radius: number,
): boolean => {
	for (let p = 0; p < floats; p += 4) {
		if (planes[p] * x + planes[p + 1] * y + planes[p + 2] * z + planes[p + 3] < radius) {
			return false;
		}
	}
	return true;
};

/**
 * @param spheres (x, y, z, radius) each
 * @param x the sphere's centre, in the spheres' space
 * @param y
 * @param z
 * @param radius the sphere's radius
 * @returns whether the sphere touches any of `spheres`
 */
export const sphereTouchesSpheres = (
	spheres: Float64Array,
	x: number,
	y: number,
	z: number,
	radius: number,
): boolean => {
	for (let s = 0; s < spheres.length; s += 4) {
		const dx = x - spheres[s];
		const dy = y - spheres[s + 1];
		const dz = z - spheres[s + 2];
		const reach = radius + spheres[s + 3];
		if (dx * dx + dy * dy + dz * dz <= reach * reach) {
			return true;
		}
	}
	return false;
};

/**
 * @param spheres (x, y, z, radius) each
 * @param min the box's corners, in the spheres' space
 * @param max
 * @returns whether the box touches any of `spheres`
 */
export const boxTouchesSpheres = (
	spheres: Float64Array,
	min: readonly number[],
	max: readonly number[],
): boolean => {
	for (let s = 0; s < spheres.length; s += 4) {
		let squared = 0;
		for (let axis = 0; axis < 3; axis++) {
			const c = spheres[s + axis];
			const d = Math.max(min[axis] - c, 0, c - max[axis]);
			squared += d * d;
		}
		if (squared <= spheres[s + 3] ** 2) {
			return true;
		}
	}
	return false;
};

/**
 * each layer draws the instances whose first layer is it or an earlier one: that holds every caster it needs,
 * plus a few near the camera that only the nearer layers need.
 *
 * @param volumes the shadow layers' volumes
 * @param x the sphere's camera-relative centre
 * @param y
 * @param z
 * @param radius the sphere's radius
 * @returns the first shadow layer the sphere can cast into, or {@link SHADOW_LAYERS} for none
 */
export const firstShadowLayer = (
	volumes: ShadowLayerVolumes,
	x: number,
	y: number,
	z: number,
	radius: number,
): number => {
	const axes = volumes.axes;
	const layers = volumes.layers;
	const u = x * axes[0] + y * axes[1] + z * axes[2];
	const v = x * axes[3] + y * axes[4] + z * axes[5];
	const w = x * axes[6] + y * axes[7] + z * axes[8];
	for (let layer = 0; layer < SHADOW_LAYERS; layer++) {
		const at = layer * 4;
		const reach = layers[at + 3] + radius;
		const dw = w - layers[at + 2];
		if (
			Math.abs(u - layers[at]) <= reach &&
			Math.abs(v - layers[at + 1]) <= reach &&
			dw <= reach &&
			dw >= -reach - volumes.reach
		) {
			return layer;
		}
	}
	return SHADOW_LAYERS;
};
