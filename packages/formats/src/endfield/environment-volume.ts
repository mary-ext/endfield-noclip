import { FormatError } from '../binary/binary-reader.ts';

import {
	monoComponent,
	MonoComponentType,
	monoField,
	type MonoObject,
	type MonoValue,
} from './mono-objects.ts';

// environment and post-processing volumes among the tag-1 chunk objects (`mono-objects.ts`).
//
// `HGEnvironmentVolume` (component 0x4000) fields, named after the IL2CPP properties of
// `HGEnvironmentVolumeBase` / `HGEnvironmentVolume`:
//   0 int volumeType (EnvironmentVolumeType)   1 int blendMode (EnvironmentBlendMode)
//   2 int priority   3 float blendDistance   4 float fadeInDuration   5 float fadeOutDuration
//   6 asset _envPhase (an `HGEnvironmentPhase`, from StreamingChunkData)   7 blob polyLineShape
//
// the polyline blob: u32 byteLength, f32×3 position, f32×3 rotation (Euler degrees), u32 n, n × f32×2 points
// (x, z relative to position), then an edge BVH the client builds from them, and last f32 height,
// f32 baseHeightOffset. the prism spans y ∈ [position.y + baseHeightOffset, + height].
//
// Unity `Volume` (component 0x8000): 0 bool isGlobal, 1 float priority, 2 float blendDistance, 3 float weight,
// 4 asset sharedProfile (a `VolumeProfile`, from StreamingChunkData). local ones carry a `BoxCollider`
// (component 0x10): 2 vector3 center, 3 vector3 size.

// #region types

/** `HGEnvironmentVolumeBase.volumeType` values seen in map02 */
export const EnvironmentVolumeType = {
	/** everywhere */
	Global: 0,
	/** a unit cube under the object's transform; no shape blob (by the placements' scales and names) */
	Box: 1,
	/** a vertical prism over {@link EnvironmentVolume.shape} */
	PolyLine: 3,
	// 4 occurs once (a waterfall), without a shape blob; probably a sphere
} as const;

/** `HGEnvironmentVolumeBase.blendMode` values */
export const EnvironmentBlendMode = {
	None: 0,
	Distance: 1,
	Time: 2,
	Manual: 3,
} as const;

/** a GameObject transform, as authored (local to the scene root, which is the world) */
export interface ObjectTransform {
	position: [x: number, y: number, z: number];
	/** Euler angles, degrees */
	rotation: [x: number, y: number, z: number];
	scale: [x: number, y: number, z: number];
}

/** a vertical prism over a closed polygon */
export interface PolyLineShape {
	/** the shape's origin; {@link points} are relative to it before rotation */
	position: [x: number, y: number, z: number];
	/** Euler angles, degrees */
	rotation: [x: number, y: number, z: number];
	/** closed ring in world x, z (rotation about y applied) */
	points: [x: number, z: number][];
	height: number;
	baseHeightOffset: number;
}

/** an `HGEnvironmentVolume`: applies its environment phase where it contains the camera */
export interface EnvironmentVolume {
	id: number;
	name: string;
	transform: ObjectTransform | null;
	/** an {@link EnvironmentVolumeType} value, or another the game has */
	volumeType: number;
	/** an {@link EnvironmentBlendMode} value */
	blendMode: number;
	priority: number;
	blendDistance: number;
	fadeInDuration: number;
	fadeOutDuration: number;
	/** StringPathHash key of the `HGEnvironmentPhase` asset, or `null` if unset or the Streaming row was absent */
	envPhase: bigint | null;
	/** `null` for global volumes and empty shapes */
	shape: PolyLineShape | null;
}

/** a Unity post-processing `Volume` */
export interface PostVolume {
	id: number;
	name: string;
	transform: ObjectTransform | null;
	isGlobal: boolean;
	priority: number;
	blendDistance: number;
	weight: number;
	/** StringPathHash key of the `VolumeProfile`, or `null` */
	profile: bigint | null;
	/** the local volume's box collider, in the object's frame */
	box: { center: [x: number, y: number, z: number]; size: [x: number, y: number, z: number] } | null;
}

// #endregion

/**
 * @param object a tag-1 chunk object
 * @returns its environment volume, or `undefined` if it has none
 * @throws {FormatError} if a field has an unexpected value type or the shape doesn't frame
 */
export const readEnvironmentVolume = (object: MonoObject): EnvironmentVolume | undefined => {
	const component = monoComponent(object, MonoComponentType.HGEnvironmentVolume);
	if (component === undefined) {
		return undefined;
	}
	const get = (field: number) => monoField(component, field);
	const shape = get(7);
	return {
		id: object.id,
		name: object.name,
		transform: readTransform(object),
		volumeType: numberOf(get(0), 0),
		blendMode: numberOf(get(1), 0),
		priority: numberOf(get(2), 0),
		blendDistance: numberOf(get(3), 0),
		fadeInDuration: numberOf(get(4), 0),
		fadeOutDuration: numberOf(get(5), 0),
		envPhase: assetOf(get(6)),
		shape: shape?.type === 'blob' && shape.value.length > 0 ? parsePolyLineShape(shape.value) : null,
	};
};

/**
 * @param object a tag-1 chunk object
 * @returns its post-processing volume, or `undefined` if it has none
 * @throws {FormatError} if a field has an unexpected value type
 */
export const readPostVolume = (object: MonoObject): PostVolume | undefined => {
	const component = monoComponent(object, MonoComponentType.Volume);
	if (component === undefined) {
		return undefined;
	}
	const get = (field: number) => monoField(component, field);
	const isGlobal = get(0);
	let box: PostVolume['box'] = null;
	{
		const collider = monoComponent(object, MonoComponentType.BoxCollider);
		const center = collider && monoField(collider, 2);
		const size = collider && monoField(collider, 3);
		if (center?.type === 'vector3' && size?.type === 'vector3') {
			box = { center: center.value, size: size.value };
		}
	}
	return {
		id: object.id,
		name: object.name,
		transform: readTransform(object),
		isGlobal: isGlobal?.type === 'bool' && isGlobal.value,
		priority: numberOf(get(1), 0),
		blendDistance: numberOf(get(2), 0),
		weight: numberOf(get(3), 1),
		profile: assetOf(get(4)),
		box,
	};
};

/**
 * @param polygon closed ring in world x, z
 * @param x world x
 * @param z world z
 * @returns whether the point is inside (even-odd rule)
 */
export const polygonContains = (
	polygon: readonly (readonly [number, number])[],
	x: number,
	z: number,
): boolean => {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const [xi, zi] = polygon[i];
		const [xj, zj] = polygon[j];
		if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
			inside = !inside;
		}
	}
	return inside;
};

/**
 * @param polygon closed ring in world x, z
 * @returns its unsigned area, m²
 */
export const polygonArea = (polygon: readonly (readonly [number, number])[]): number => {
	let twice = 0;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		twice += polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
	}
	return Math.abs(twice) / 2;
};

/**
 * @param blob a polyline-shape blob
 * @returns the shape
 * @throws {FormatError} if the blob's own length or point count doesn't fit it
 */
export const parsePolyLineShape = (blob: Uint8Array): PolyLineShape => {
	const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	if (blob.length < 40 || view.getUint32(0, true) !== blob.length) {
		throw new FormatError(
			`polyline shape of ${blob.length} bytes declares ${blob.length >= 4 ? view.getUint32(0, true) : '?'}`,
		);
	}
	const f = (at: number) => view.getFloat32(at, true);
	const position: [number, number, number] = [f(4), f(8), f(12)];
	const rotation: [number, number, number] = [f(16), f(20), f(24)];
	const count = view.getUint32(28, true);
	if (32 + count * 8 + 8 > blob.length) {
		throw new FormatError(`polyline shape of ${blob.length} bytes can't hold ${count} points`);
	}
	const rotate = yawRotation(rotation[1]);
	const points = Array.from({ length: count }, (_, i): [number, number] => {
		const [x, z] = rotate(f(32 + i * 8), f(36 + i * 8));
		return [position[0] + x, position[2] + z];
	});
	return {
		position,
		rotation,
		points,
		height: f(blob.length - 8),
		baseHeightOffset: f(blob.length - 4),
	};
};

/**
 * @param degrees Unity Euler angle about +y
 * @returns the rotation on the x, z plane, left-handed as Unity's: (x, z) → (x cos θ + z sin θ, −x sin θ + z
 *   cos θ)
 */
export const yawRotation = (degrees: number): ((x: number, z: number) => [x: number, z: number]) => {
	const theta = (degrees * Math.PI) / 180;
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);
	return (x, z) => [x * cos + z * sin, -x * sin + z * cos];
};

const readTransform = (object: MonoObject): ObjectTransform | null => {
	const component = monoComponent(object, MonoComponentType.Transform);
	const position = component && monoField(component, 0);
	const rotation = component && monoField(component, 1);
	const scale = component && monoField(component, 2);
	if (position?.type !== 'vector3' || rotation?.type !== 'vector3' || scale?.type !== 'vector3') {
		return null;
	}
	return { position: position.value, rotation: rotation.value, scale: scale.value };
};

const numberOf = (value: MonoValue | undefined, fallback: number): number => {
	if (value === undefined) {
		return fallback;
	}
	switch (value.type) {
		case 'int':
		case 'float': {
			return value.value;
		}
		default: {
			throw new FormatError(`expected a number, got a ${value.type} value`);
		}
	}
};

const assetOf = (value: MonoValue | undefined): bigint | null => {
	if (value === undefined) {
		return null;
	}
	if (value.type !== 'asset') {
		throw new FormatError(`expected an asset reference, got a ${value.type} value`);
	}
	return value.hash === 0n ? null : value.hash;
};
