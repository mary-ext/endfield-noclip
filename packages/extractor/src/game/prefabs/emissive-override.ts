import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	asPPtr,
	numberField,
	objectField,
	type PPtr,
} from '@endfield-noclip/formats/unity/values';

import type { ObjectRef } from '../assets/assets.ts';

export type Rgba = [number, number, number, number];

/**
 * an `AnimationProperties_Emissive` component: a VFX playable that starts playing when enabled and writes its
 * colour into the per-draw emission override of the renderers it lists
 * ([emission](../../../../docs/game-data/materials.md#emission))
 */
export interface EmissiveOverride {
	/** the renderers it writes to */
	renderers: PPtr[];
	/** HDR, linear; its alpha is how far it replaces the material's `_EmissiveColor` */
	color: Rgba;
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
 * reads the resting emission colour of an `AnimationProperties_Emissive`. its breathing and its albedo tint
 * aren't read
 *
 * @param data the component's fields (see {@link isEmissiveOverrideType})
 * @returns the renderers it lists and the colour it gives them
 */
export const readEmissiveOverride = (data: TypeTreeObject): EmissiveOverride => ({
	renderers: arrayField(data, 'affectRenderers').map((pointer) => asPPtr(pointer)),
	color: rgba(objectField(data, 'emissiveColor')),
});

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
