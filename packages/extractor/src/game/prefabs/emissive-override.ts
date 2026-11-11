import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	asPPtr,
	numberField,
	objectField,
	type PPtr,
	pptrField,
} from '@endfield-noclip/formats/unity/values';

import type { AssetResolver, ObjectRef } from '../assets/assets.ts';

export type Rgba = [number, number, number, number];

/**
 * what an `AnimationProperties_Emissive` writes into the per-draw data of its renderers
 * ([emission](../../../../docs/game-data/materials.md#emission))
 */
export interface EmissiveColors {
	/** `emissiveColor`: HDR, linear; its alpha is how far it replaces the material's `_EmissiveColor` */
	color: Rgba;
	/**
	 * `emissiveAlbedoColor`: HDR, linear; its alpha is how strongly it tints the albedo where the emission's
	 * strength is at least 0.1
	 */
	albedo: Rgba;
}

/**
 * an `AnimationProperties_Emissive` component: a VFX playable that starts playing when enabled and writes its
 * colours into the per-draw data of the renderers it lists
 */
export interface EmissiveOverride {
	/** the renderers it writes to */
	renderers: PPtr[];
	colors: EmissiveColors;
}

/**
 * @param ref a MonoBehaviour
 * @returns whether its serialized fields are an `AnimationProperties_Emissive`'s, without reading the object
 */
export const isEmissiveOverrideType = (ref: ObjectRef): boolean => {
	const names = new Set(ref.info.type?.nodes.filter((node) => node.level === 1).map((node) => node.name));
	return (
		names.has('affectRenderers') &&
		names.has('emissiveColor') &&
		names.has('emissiveAlbedoColor') &&
		names.has('breathFrequency')
	);
};

const rgba = (value: TypeTreeObject): Rgba => [
	numberField(value, 'r'),
	numberField(value, 'g'),
	numberField(value, 'b'),
	numberField(value, 'a'),
];

/**
 * reads the resting colours of an `AnimationProperties_Emissive`. its breathing isn't read
 *
 * @param data the component's fields (see {@link isEmissiveOverrideType})
 * @returns the renderers it lists and the colours it gives them
 */
export const readEmissiveOverride = (data: TypeTreeObject): EmissiveOverride => ({
	renderers: arrayField(data, 'affectRenderers').map((pointer) => asPPtr(pointer)),
	colors: {
		color: rgba(objectField(data, 'emissiveColor')),
		albedo: rgba(objectField(data, 'emissiveAlbedoColor')),
	},
});

/**
 * the GameObject name a pose's emissive configs give the prefab root, which a root animator's empty name
 * means
 */
export const ROOT_EMISSIVE = '';

/** what an `InteractiveEmissiveConfig` leaves `emissiveAlbedoColor` at without a base colour */
const NO_ALBEDO: Rgba = [1, 1, 1, 0];

/**
 * reads an `InteractiveEmissiveConfig`, which an interactive's view states apply to an
 * `AnimationProperties_Emissive` in place of its saved colours, and the colour assets it points to. its
 * cycle, which breathes the emission unless it's constant, isn't read
 *
 * @param resolver bundle reader
 * @param ref the config's MonoBehaviour
 * @returns the colours it sets on the component: its base colour asset's as the albedo tint, or white at
 *   alpha 0 without one
 * @throws {FormatError} if it has no colour asset, which the game requires
 */
export const readEmissiveConfig = async (
	resolver: AssetResolver,
	ref: ObjectRef,
): Promise<EmissiveColors> => {
	const config = await resolver.read(ref);
	const colorRef = await resolver.resolve(ref, pptrField(config, 'colorConfig'));
	if (colorRef === null) {
		throw new FormatError(`emissive config ${ref.info.pathId} has no colour config`);
	}
	const color = rgba(objectField(await resolver.read(colorRef), 'emissiveColor'));
	const baseRef = await resolver.resolve(ref, pptrField(config, 'baseColorConfig'));
	const albedo = baseRef === null ? NO_ALBEDO : rgba(objectField(await resolver.read(baseRef), 'baseColor'));
	return { color, albedo };
};

/**
 * the emission colour a Lit draw ends up with under a per-draw override, as the shader mixes it: the
 * override's colour replaces the material's by the override's alpha, and the material's alpha (its pulse or
 * sweep depth) stays
 *
 * @param material the material's `_EmissiveColor`, as saved or as a pose sets it
 * @param override the override's colour
 * @returns a new colour
 */
export const overriddenEmission = (material: readonly number[], override: Rgba): Rgba => {
	const weight = override[3];
	const mix = (i: number): number => material[i] + (override[i] - material[i]) * weight;
	return [mix(0), mix(1), mix(2), material[3]];
};
