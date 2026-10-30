import { FormatError } from '../binary/binary-reader.ts';

import { groupColumn, type InitChunk } from './init-chunk-data.ts';
import { levelTagOf } from './level-partition.ts';
import { readChunkRows, readPropertyTable } from './mono-objects.ts';

// local lights among the InitChunkData component-group entities (tag-2 rows, `init-chunk-data.ts`). their
// group columns 42 and 63 are zero-filled in the file; the values sit in the entity's own root row, whose slot 3
// is a keyed property table (`mono-objects.ts` layout) holding two blobs:
//
//   key 0xff000000, 236 bytes: the light as the renderer consumes it
//     0 f32×4 colour (sRGB, as authored)   16 f32 intensity   20 f32 colour temperature (K)   24 u32 use temperature
//     28 f32×4 position, 1                  44 f32×4 direction (the transform's +z), 0
//     60 f32×4 linear colour · intensity · temperature tint (rgb), intensity
//     76 f32 range   80 f32 25 / range²   84 f32 spot angle (degrees; −1 for point lights)   88 u32 type
//     92 f32×4 copy of 60   108 f32×16 object-to-world (column-major)   172 f32×16 world-to-object
//   key 0xff010000, 448 bytes: the authored settings of HG's Light, then its additional data
//     12 u32 type   20 f32 specular intensity   24 f32 range   36 f32 spot angle   40 f32 inner spot angle
//     48 f32 cot(spot / 2)   52 f32 1 / cos(spot / 2)   80 u32 Unity LightmapBakeType (4 realtime, 1 mixed)
//     91 u8 shadow only   92 u8 culling box on   94 u8 culling distance on
//     100 f32×3 culling box offset   112 f32×3 box half extents   124 f32×3 box rotation (Euler degrees)
//     136 f32 box falloff threshold   140 i32 priority   144 f32 tube length (−1 or 0: not a tube)
//     148 f32 soft source radius   152 f32 culling distance   156 f32 falloff distance   160 u32 shadows
//     172 f32 shadow strength   436 u8 character only   440 f32 volumetric scattering intensity
//     444 f32 falloff exponent (negative: inverse square)
//
// layouts found by census over map01 and map02 (a value per offset against the authored properties of Unity's
// Light: the defaults 30° and 21.80208° for the angles, 6570 K for the temperature, and so on), and the order of
// the fork's Light properties.

// #region types

/** Unity `LightType` values (both blocks store the same) */
export const LightType = {
	Spot: 0,
	Directional: 1,
	Point: 2,
} as const;

/** a local light of a chunk */
export interface ChunkLight {
	/** full 32-bit entity id */
	id: number;
	/** `id >>> 27`: the owning level's namespace */
	levelTag: number;
	name: string;
	/** a {@link LightType} value, or another the game has */
	type: number;
	/** world position */
	position: [x: number, y: number, z: number];
	/** world direction the light points along (the transform's +z), unit length */
	direction: [x: number, y: number, z: number];
	/** linear radiant colour: the authored colour times intensity and the colour temperature's tint */
	color: [r: number, g: number, b: number];
	/** the authored intensity, already in {@link color} */
	intensity: number;
	/** metres */
	range: number;
	/** full cone angle, degrees (spot lights) */
	spotAngle: number;
	/** full inner cone angle, degrees (spot lights) */
	innerSpotAngle: number;
	/** Unity `LightmapBakeType`: 4 realtime, 1 mixed, 2 baked */
	bakeType: number;
	/** scales the specular lobe */
	specularIntensity: number;
	/** the light emits nothing and only shadows other local lights */
	shadowOnly: boolean;
	/** lights only characters */
	characterOnly: boolean;
	/** a point light's segment length (a tube along {@link direction}), 0 for a point */
	tubeLength: number;
	/** radius of the emitting sphere, m; widens highlights */
	softSourceRadius: number;
	/** the distance falloff's exponent; negative for inverse square with a smooth window */
	falloffExponent: number;
	/** the froxel fog's multiplier on this light */
	volumetricScatteringIntensity: number;
	/** sorts lights of equal camera distance */
	priority: number;
	/** fades the light out with camera distance: full up to `falloff`, gone at `culling` (m) */
	distanceFade: { falloff: number; culling: number } | null;
	/** a box the light is confined to, faded towards its faces; offset and rotation in world axes */
	cullingBox: {
		offset: [x: number, y: number, z: number];
		halfExtents: [x: number, y: number, z: number];
		/** Euler degrees */
		rotation: [x: number, y: number, z: number];
		/** the fraction of the box, from its centre, that keeps full light */
		falloffThreshold: number;
	} | null;
	/** the authored shadow mode: 0 none, 2 soft */
	shadows: number;
	shadowStrength: number;
}

// #endregion

/** group columns that only light entities have */
const LIGHT_COLUMNS = [42, 63];

const CORE_KEY = 0xff000000;
const SETTINGS_KEY = 0xff010000;
const CORE_SIZE = 236;
const SETTINGS_SIZE = 448;

/**
 * reads the local lights of a chunk. lights that span cells appear in each cell's chunk under the same id;
 * callers dedupe across files.
 *
 * @param data the InitChunkData FlatBuffer (after `unpackHgPayload`) that `chunk` was parsed from
 * @param chunk the parsed chunk
 * @returns the lights in row order
 * @throws {FormatError} if a light's row has no property table or its blobs don't have the known sizes
 */
export const readChunkLights = (data: Uint8Array, chunk: InitChunk): ChunkLight[] => {
	const lightIds = new Set<number>();
	for (const group of chunk.groups) {
		if (LIGHT_COLUMNS.every((id) => groupColumn(group, id) !== undefined)) {
			for (const id of group.ids) {
				lightIds.add(id);
			}
		}
	}
	if (lightIds.size === 0) {
		return [];
	}
	const names = new Map<number, string>();
	for (const object of chunk.objects) {
		names.set(object.id, object.name);
	}

	const { fb, rows } = readChunkRows(data);
	const lights: ChunkLight[] = [];
	for (const row of rows) {
		if (!lightIds.has(row.id)) {
			continue;
		}
		const at = fb.field(row.table, 3);
		if (at === undefined) {
			throw new FormatError(`light ${row.id} has no property table`);
		}
		let core: DataView | undefined;
		let settings: DataView | undefined;
		for (const [key, value] of readPropertyTable(fb, fb.deref(at))) {
			if (value.type !== 'blob') {
				continue;
			}
			const view = new DataView(value.value.buffer, value.value.byteOffset, value.value.byteLength);
			if (key === CORE_KEY) {
				core = view;
			} else if (key === SETTINGS_KEY) {
				settings = view;
			}
		}
		if (core?.byteLength !== CORE_SIZE || settings?.byteLength !== SETTINGS_SIZE) {
			throw new FormatError(
				`light ${row.id} blobs are ${core?.byteLength ?? 'absent'}/${settings?.byteLength ?? 'absent'} bytes, expected ${CORE_SIZE}/${SETTINGS_SIZE}`,
			);
		}
		lights.push(decodeLight(row.id, names.get(row.id) ?? '', core, settings));
	}
	return lights;
};

const decodeLight = (id: number, name: string, core: DataView, settings: DataView): ChunkLight => {
	const f = (at: number) => core.getFloat32(at, true);
	const vec3 = (at: number): [number, number, number] => [f(at), f(at + 4), f(at + 8)];
	const s = (at: number) => settings.getFloat32(at, true);
	const sVec3 = (at: number): [number, number, number] => [s(at), s(at + 4), s(at + 8)];
	const flag = (at: number) => settings.getUint8(at) !== 0;
	const type = core.getUint32(88, true);
	if (settings.getUint32(12, true) !== type) {
		throw new FormatError(`light ${id}: its two blocks disagree on the type`);
	}
	return {
		id,
		levelTag: levelTagOf(id),
		name,
		type,
		position: vec3(28),
		direction: vec3(44),
		color: vec3(60),
		intensity: f(16),
		range: f(76),
		spotAngle: s(36),
		innerSpotAngle: s(40),
		bakeType: settings.getUint32(80, true),
		specularIntensity: s(20),
		shadowOnly: flag(91),
		characterOnly: flag(436),
		tubeLength: Math.max(s(144), 0),
		softSourceRadius: s(148),
		falloffExponent: s(444),
		volumetricScatteringIntensity: s(440),
		priority: settings.getInt32(140, true),
		distanceFade: flag(94) ? { falloff: s(156), culling: s(152) } : null,
		cullingBox: flag(92)
			? { offset: sVec3(100), halfExtents: sVec3(112), rotation: sVec3(124), falloffThreshold: s(136) }
			: null,
		shadows: settings.getUint32(160, true),
		shadowStrength: s(172),
	};
};
