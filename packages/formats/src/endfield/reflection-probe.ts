import { FormatError } from '../binary/binary-reader.ts';

import {
	monoComponent,
	MonoComponentType,
	monoField,
	type MonoObject,
	type MonoValue,
} from './mono-objects.ts';

// local reflection probes among the tag-1 chunk objects (`mono-objects.ts`; `StreamingComponentType.ReflectionProbe`).
// field keys match Unity's `ReflectionProbe` serialization in Hypergryph's fork.

/** `ReflectionProbe.m_ShapeType` values */
export const ReflectionProbeShapeType = {
	Box: 0,
	Sphere: 1,
} as const;

/** a local reflection probe read from an `InitChunkData` tag-1 object */
export interface ChunkReflectionProbe {
	id: number;
	name: string;
	/** full box size in probe-local metres (`m_BoxSize`) */
	size: [x: number, y: number, z: number];
	/** inner full-weight fraction per axis (`m_BoxInfluenceScale`), 0–1 */
	influenceScale: [x: number, y: number, z: number];
	/** world-space centre of the probe's box (translation of `m_TRS`) */
	center: [x: number, y: number, z: number];
	/** world-space AABB half extents (`m_rotatedExtents`) */
	boundsExtents: [x: number, y: number, z: number];
	/** world → probe-local unscaled transform (`m_TRInverse`, 12 floats `rows3x4`) */
	worldToLocal: number[];
	/** `m_IntensityMultiplier` */
	intensity: number;
	/** `m_BoxProjection` */
	boxProjection: boolean;
	/** `m_Mode` (0 = Baked, 2 = Custom) */
	mode: number;
	/** `m_Importance`: higher priority wins when probes overlap */
	importance: number;
	/** a {@link ReflectionProbeShapeType} value (`m_ShapeType`) */
	shape: number;
	/** baked probe SH (27 floats channel-major, `SphericalHarmonicsL2`), or `null` if absent */
	sh: number[] | null;
	/** asset path of the cubemap `.exr` (`m_TexturePath`), or `null` */
	texturePath: string | null;
	/** `StringPathHash` of the cubemap `.exr` (`m_TexturePathHash`), or `null` */
	textureHash: bigint | null;
}

/**
 * reads a local reflection probe from a tag-1 chunk object
 *
 * @param object a tag-1 chunk object
 * @returns its reflection probe, or `undefined` if it has no `ReflectionProbe` component
 * @throws {FormatError} if a required blob has an unexpected byte length
 */
export const readReflectionProbe = (object: MonoObject): ChunkReflectionProbe | undefined => {
	const component = monoComponent(object, MonoComponentType.ReflectionProbe);
	if (component === undefined) {
		return undefined;
	}
	const get = (field: number): MonoValue | undefined => monoField(component, field);
	const size = vector3Of(get(0), [0, 0, 0]);
	const influenceScale = vector3Of(get(3), [0.9, 0.9, 0.9]);
	const trs = mat4Of(get(4));
	const trInverse = mat4Of(get(5));
	const mode = numberOf(get(8), 2);
	const bakedSh = shOf(get(10));
	const customSh = shOf(get(11));
	const sh = mode === 0 ? (bakedSh ?? customSh) : (customSh ?? bakedSh);
	const texturePath = stringOf(get(12));
	const textureHash = uint64Of(get(17));
	const boundsExtents = vector3Of(get(15), [size[0] * 0.5, size[1] * 0.5, size[2] * 0.5]);

	let center: [number, number, number];
	if (trs !== null) {
		center = [trs[12], trs[13], trs[14]];
	} else {
		const offset = vector3Of(get(1), [0, 0, 0]);
		const transform = monoComponent(object, MonoComponentType.Transform);
		const pos =
			transform === undefined
				? ([0, 0, 0] as [number, number, number])
				: vector3Of(monoField(transform, 0), [0, 0, 0]);
		center = [pos[0] + offset[0], pos[1] + offset[1], pos[2] + offset[2]];
	}

	let worldToLocal: number[];
	if (trInverse !== null) {
		worldToLocal = [
			trInverse[0],
			trInverse[4],
			trInverse[8],
			trInverse[12],
			trInverse[1],
			trInverse[5],
			trInverse[9],
			trInverse[13],
			trInverse[2],
			trInverse[6],
			trInverse[10],
			trInverse[14],
		];
	} else {
		worldToLocal = [1, 0, 0, -center[0], 0, 1, 0, -center[1], 0, 0, 1, -center[2]];
	}

	return {
		id: object.id,
		name: object.name,
		size,
		influenceScale,
		center,
		boundsExtents,
		worldToLocal,
		intensity: numberOf(get(6), 1),
		boxProjection: boolOf(get(7), false),
		mode,
		importance: numberOf(get(9), 0),
		shape: numberOf(get(13), ReflectionProbeShapeType.Box),
		sh,
		texturePath,
		textureHash,
	};
};

const numberOf = (value: MonoValue | undefined, fallback: number): number => {
	if (value === undefined) {
		return fallback;
	}
	if (value.type === 'int' || value.type === 'uint' || value.type === 'float') {
		return value.value;
	}
	throw new FormatError(`expected number field, got ${value.type}`);
};

const boolOf = (value: MonoValue | undefined, fallback: boolean): boolean => {
	if (value === undefined) {
		return fallback;
	}
	if (value.type === 'bool') {
		return value.value;
	}
	throw new FormatError(`expected bool field, got ${value.type}`);
};

const vector3Of = (
	value: MonoValue | undefined,
	fallback: [number, number, number],
): [number, number, number] => {
	if (value === undefined) {
		return fallback;
	}
	if (value.type === 'vector3') {
		return value.value;
	}
	throw new FormatError(`expected vector3 field, got ${value.type}`);
};

const stringOf = (value: MonoValue | undefined): string | null => {
	if (value === undefined) {
		return null;
	}
	if (value.type === 'string') {
		return value.value.length > 0 ? value.value : null;
	}
	throw new FormatError(`expected string field, got ${value.type}`);
};

const uint64Of = (value: MonoValue | undefined): bigint | null => {
	if (value === undefined) {
		return null;
	}
	if (value.type === 'uint64') {
		return value.value === 0n ? null : value.value;
	}
	throw new FormatError(`expected uint64 field, got ${value.type}`);
};

const mat4Of = (value: MonoValue | undefined): Float32Array | null => {
	if (value === undefined) {
		return null;
	}
	if (value.type !== 'blob') {
		throw new FormatError(`expected blob mat4, got ${value.type}`);
	}
	if (value.value.byteLength === 0) {
		return null;
	}
	if (value.value.byteLength !== 64) {
		throw new FormatError(`reflection probe mat4 blob is ${value.value.byteLength} bytes, expected 64`);
	}
	const out = new Float32Array(16);
	const view = new DataView(value.value.buffer, value.value.byteOffset, 64);
	for (let i = 0; i < 16; i++) {
		out[i] = view.getFloat32(i * 4, true);
	}
	return out;
};

const shOf = (value: MonoValue | undefined): number[] | null => {
	if (value === undefined) {
		return null;
	}
	if (value.type !== 'blob') {
		throw new FormatError(`expected blob SH, got ${value.type}`);
	}
	if (value.value.byteLength === 0) {
		return null;
	}
	if (value.value.byteLength !== 108) {
		throw new FormatError(`reflection probe SH blob is ${value.value.byteLength} bytes, expected 108`);
	}
	const out: number[] = [];
	const view = new DataView(value.value.buffer, value.value.byteOffset, 108);
	for (let i = 0; i < 27; i++) {
		out.push(view.getFloat32(i * 4, true));
	}
	return out;
};
