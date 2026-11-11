import { crc32 } from 'node:zlib';

import type { ClipMaterialValue } from '@endfield-noclip/formats/unity/animation-clip';
import { parseMaterial } from '@endfield-noclip/formats/unity/material';

import type { AssetResolver, ObjectRef } from '../assets/assets.ts';
import { PER_DRAW_EMISSIVE_ALBEDO } from '../materials/material-values.ts';

import { lengthTextureTransform, type LengthTiling } from './adjust-length.ts';
import { type EmissiveColors, overriddenEmission } from './emissive-override.ts';
import type { MaterialValues } from './prefab.ts';

/** a texture whose tiling follows a length a pose sets, with that length over its preset */
export interface ScaledTiling {
	tiling: LengthTiling;
	ratio: number;
}

/** @returns property names by the hash clip bindings name them with: the low 28 bits of their CRC32 */
const byHash = (names: Iterable<string>): Map<number, string> =>
	new Map([...names].map((name) => [crc32(name) & 0x0fff_ffff, name]));

/**
 * resolves the material values a pose sets on a renderer against one of its materials. clips name properties
 * by a hash of the name, so a value whose property the material doesn't save is left out; so is the tiling of
 * a texture it doesn't save
 *
 * @param resolver bundle reader
 * @param material one of the renderer's materials
 * @param sources.values the values the pose's clips set
 * @param sources.tilings textures whose tiling follows a length the pose sets
 * @param sources.emissive the colours the renderer's `AnimationProperties_Emissive` writes, or `null`: its
 *   emission colour is folded into `_EmissiveColor` after the clips' values, and an albedo tint that tints
 *   anything is set as {@link PER_DRAW_EMISSIVE_ALBEDO}
 * @returns the replaced values by name, or `null` when none of this material's are replaced
 */
export const posedMaterialValues = async (
	resolver: AssetResolver,
	material: ObjectRef,
	sources: {
		values: readonly ClipMaterialValue[];
		tilings: readonly ScaledTiling[];
		emissive: EmissiveColors | null;
	},
): Promise<MaterialValues | null> => {
	const { values, tilings, emissive } = sources;
	if (values.length === 0 && tilings.length === 0 && emissive === null) {
		return null;
	}
	const record = parseMaterial(await resolver.read(material));
	const textures: MaterialValues['textures'] = {};
	for (const { tiling, ratio } of tilings) {
		const slot = record.textures[tiling.texture];
		if (slot !== undefined) {
			textures[tiling.texture] = lengthTextureTransform(slot, tiling, ratio);
		}
	}
	const floatNames = byHash([...Object.keys(record.floats), ...Object.keys(record.ints)]);
	const colorNames = byHash(Object.keys(record.colors));
	const floats: Record<string, number> = {};
	const colors: Record<string, [number, number, number, number]> = {};
	for (const { nameHash, component, value } of values) {
		if (component === null) {
			const name = floatNames.get(nameHash);
			if (name !== undefined) {
				floats[name] = value;
			}
			continue;
		}
		const name = colorNames.get(nameHash);
		if (name !== undefined) {
			colors[name] ??= [...record.colors[name]];
			colors[name][component] = value;
		}
	}
	if (emissive !== null) {
		const name = '_EmissiveColor';
		const saved = colors[name] ?? record.colors[name];
		if (saved !== undefined) {
			colors[name] = overriddenEmission(saved, emissive.color);
		}
		if (emissive.albedo[3] !== 0) {
			colors[PER_DRAW_EMISSIVE_ALBEDO] = emissive.albedo;
		}
	}
	return Object.keys(floats).length + Object.keys(colors).length + Object.keys(textures).length === 0
		? null
		: { floats, colors, textures };
};
