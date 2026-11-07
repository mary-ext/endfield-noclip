/* oxlint-disable no-await-in-loop -- reads a GameObject's MonoBehaviours in order */
import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { ChunkLight } from '@endfield-noclip/formats/endfield/chunk-lights';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import {
	multiplyMatrices,
	multiplyQuaternions,
	quaternionUnityEuler,
	trsMatrix,
	unityEulerQuaternion,
} from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { booleanField, numberField, objectField, vector3Field } from '@endfield-noclip/formats/unity/values';

import type { AssetResolver, ObjectRef } from '../assets/assets.ts';

import type { Placement } from './prefab-environment.ts';
import { PRUNE, walkPrefab } from './prefab-walk.ts';

// local lights inside prefabs the game places through model rows, such as the lighting prefab of a Dijiang
// cabin (docs/game-data/lighting.md#local-lights). they are Unity `Light` components with HG's additional
// light data beside them, serialized by Unity rather than flattened into the chunk blobs, so the colour the
// chunk files store precomputed is derived here the same way.

/** a prefab's light in prefab space: everything a {@link ChunkLight} has but its id and placement */
export interface PrefabLight {
	name: string;
	/** the light's GameObject relative to the prefab root, column-major */
	matrix: Float32Array;
	/** settings as in a chunk light; the culling box is in the prefab root's axes */
	light: Omit<ChunkLight, 'id' | 'levelTag' | 'position' | 'direction'>;
}

/**
 * walks a prefab's active hierarchy for enabled spot, point and directional lights
 *
 * @param resolver bundle reader
 * @param root prefab GameObject
 * @returns the lights in hierarchy order, relative to the prefab root
 * @throws {FormatError} on a malformed hierarchy, or a light without HG's additional light data
 */
export const readPrefabLights = async (resolver: AssetResolver, root: ObjectRef): Promise<PrefabLight[]> => {
	const result: PrefabLight[] = [];
	await walkPrefab(
		resolver,
		root,
		{
			enter: (node) => (node.active ? undefined : PRUNE),
			visit: async (node) => {
				const light = await node.ofClass(UnityClass.Light).at(-1)?.read();
				if (light === undefined || !booleanField(light, 'm_Enabled')) {
					return;
				}
				let additional: TypeTreeObject | null = null;
				for (const behaviour of node.ofClass(UnityClass.MonoBehaviour)) {
					const value = await behaviour.read();
					if ('m_falloffExponent' in value && 'm_volumetricScatteringIntensity' in value) {
						additional = value;
						break;
					}
				}
				if (additional === null) {
					throw new FormatError(`prefab light ${node.name} has no HG light data`);
				}
				result.push({ name: node.name, matrix: node.matrix, light: readLight(node.name, light, additional) });
			},
		},
		undefined,
	);
	return result;
};

/** @returns a Unity `Light` and HG's additional data as a chunk light's settings */
const readLight = (name: string, light: TypeTreeObject, additional: TypeTreeObject): PrefabLight['light'] => {
	const color = objectField(light, 'm_Color');
	const intensity = numberField(light, 'm_Intensity');
	const shadows = objectField(light, 'm_Shadows');
	return {
		name,
		type: numberField(light, 'm_Type'),
		color: lightColor(
			[numberField(color, 'r'), numberField(color, 'g'), numberField(color, 'b')],
			intensity,
			booleanField(light, 'm_UseColorTemperature') ? numberField(light, 'm_ColorTemperature') : null,
		),
		intensity,
		range: numberField(light, 'm_Range'),
		spotAngle: numberField(light, 'm_SpotAngle'),
		innerSpotAngle: numberField(light, 'm_InnerSpotAngle'),
		bakeType: numberField(
			objectField(objectField(light, 'm_BakingOutput'), 'lightmapBakeMode'),
			'lightmapBakeType',
		),
		specularIntensity: numberField(light, 'm_SpecularIntensity'),
		shadowOnly: booleanField(light, 'm_ShadowOnly'),
		characterOnly: booleanField(additional, 'm_LightCharacterOnly'),
		tubeLength: Math.max(numberField(light, 'm_LinearLightLength'), 0),
		softSourceRadius: numberField(light, 'm_SoftSourceRadius'),
		falloffExponent: numberField(additional, 'm_falloffExponent'),
		volumetricScatteringIntensity: numberField(additional, 'm_volumetricScatteringIntensity'),
		priority: numberField(light, 'm_LightPriority'),
		distanceFade: booleanField(light, 'm_UseCullingDistance')
			? { falloff: numberField(light, 'm_FalloffDistance'), culling: numberField(light, 'm_CullingDistance') }
			: null,
		cullingBox: booleanField(light, 'm_EnableOBBCullingBox')
			? {
					offset: vector3Field(light, 'm_CullingBoxRelativePosition'),
					halfExtents: vector3Field(light, 'm_CullingBoxHalfExtents'),
					rotation: vector3Field(light, 'm_CullingBoxOrientation'),
					falloffThreshold: numberField(light, 'm_CullingBoxFalloffThreshold'),
				}
			: null,
		shadows: numberField(objectField(shadows, 'm_PlatformSpecificType'), 'defaultParam'),
		shadowStrength: numberField(shadows, 'm_Strength'),
	};
};

/**
 * the linear colour a chunk light stores precomputed: the authored sRGB colour made linear, times intensity
 * and, when the light uses one, its colour temperature's tint
 *
 * @param srgb the authored colour
 * @param intensity the authored intensity
 * @param temperature the colour temperature in kelvin, or `null` when the light doesn't use it
 * @returns linear rgb
 */
export const lightColor = (
	srgb: readonly number[],
	intensity: number,
	temperature: number | null,
): [number, number, number] => {
	const tint = temperature === null ? [1, 1, 1] : temperatureTint(temperature);
	return [
		srgbToLinear(srgb[0]) * intensity * tint[0],
		srgbToLinear(srgb[1]) * intensity * tint[1],
		srgbToLinear(srgb[2]) * intensity * tint[2],
	];
};

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const saturate = (value: number): number => Math.min(Math.max(value, 0), 1);

/**
 * the rational curve fit of the Planckian locus that HDRP's `LightUtils` publishes, pivoting at 6570 K; it
 * reproduces the tints in the chunk files' stored colours
 */
const temperatureTint = (temperature: number): [number, number, number] => {
	const k = Math.min(Math.max(temperature, 1000), 40000) / 1000;
	const k2 = k * k;
	if (k < 6.57) {
		return [
			1,
			saturate((-399.809 + 414.271 * k + 111.543 * k2) / (2779.24 + 164.143 * k + 84.7356 * k2)),
			saturate((348.963 - 523.53 * k + 183.62 * k2) / (2848.82 - 214.52 * k + 78.8614 * k2)),
		];
	}
	return [
		saturate((1.35651 + 0.216422 * k + 0.000633715 * k2) / (-3.24223 + 0.918711 * k)),
		saturate((1370.38 + 734.616 * k + 0.689955 * k2) / (-4625.69 + 1699.87 * k)),
		k > 6.57 ? 1 : saturate((348.963 - 523.53 * k + 183.62 * k2) / (2848.82 - 214.52 * k + 78.8614 * k2)),
	];
};

/**
 * places a prefab's light in the world. the culling box turns with the placement, so it keeps covering the
 * geometry it was authored around
 *
 * @param prefab the light in prefab space
 * @param placement the prefab's placement; rotation as an xyzw quaternion
 * @param id the light's entity id
 * @returns the light as a chunk light
 */
export const placePrefabLight = (prefab: PrefabLight, placement: Placement, id: number): ChunkLight => {
	const matrix = multiplyMatrices(
		trsMatrix(placement.position, placement.rotation, placement.scale),
		prefab.matrix,
	);
	const z = [matrix[8], matrix[9], matrix[10]];
	const length = Math.hypot(...z) || 1;
	const box = prefab.light.cullingBox;
	let cullingBox = box;
	if (box !== null) {
		const turn = trsMatrix([0, 0, 0], placement.rotation, [1, 1, 1]);
		const [ox, oy, oz] = box.offset;
		cullingBox = {
			...box,
			offset: [
				turn[0] * ox + turn[4] * oy + turn[8] * oz,
				turn[1] * ox + turn[5] * oy + turn[9] * oz,
				turn[2] * ox + turn[6] * oy + turn[10] * oz,
			],
			rotation: quaternionUnityEuler(
				multiplyQuaternions(placement.rotation, unityEulerQuaternion(box.rotation)),
			),
		};
	}
	return {
		...prefab.light,
		id,
		levelTag: id >>> 27,
		position: [matrix[12], matrix[13], matrix[14]],
		direction: [z[0] / length, z[1] / length, z[2] / length],
		cullingBox,
	};
};
