/**
 * interprets a converted material into the surface description the viewer draws
 * (`package-format/surfaces.ts`): which model, with the shader's properties, keywords and formulas applied. a
 * material whose keywords or texture combinations the viewer doesn't draw becomes `unsupported` with the
 * reason, which the pack lists in `debug/assets.json`. stays out of the conversion worker's imports.
 */

import type { LitSway, MaterialSurface } from '@endfield-noclip/package-format/surfaces';

import {
	describeDitherEffect,
	describeLightBeam,
	describeLitDecal,
	describeMistCard,
	describeMistVolume,
	describeRefract,
	describeSixWaySmoke,
	describeVfxBase,
	describeVfxDecal,
	describeWaterFoam,
	describeWaterSheet,
	isDitherEffect,
} from './material-effects.ts';
import {
	describeDithered,
	describeErosion,
	describeLit,
	describeMattePainting,
	LIT_FAMILIES,
	swayOf,
} from './material-surfaces.ts';
import {
	type MaterialValues,
	readerOf,
	type ShaderEntry,
	type ShaderFamily,
	unsupported,
} from './material-values.ts';

/**
 * shader families drawn only through effect looks of their own (fog volumes, light beams, effects, projected
 * decals)
 */
const EFFECT_FAMILIES: ReadonlySet<ShaderFamily> = new Set([
	'decal',
	'fogSimple',
	'volumetricBeam',
	'vfxFakeVolumeFog',
	'vfxBase',
	'vfxAdvance',
	'vfxRefract',
	'vfxDitherAlpha',
	'vfxSmokeSixWay',
	'waterDecal',
	'water',
]);

/**
 * shaders the game never shades into the image: VFXReflectionPass only writes screen-space reflections'
 * normal and roughness (`docs/game-data/effects.md#reflection-only-effects`)
 */
const UNDRAWN_SHADERS = new Set(['HGRP/Effect/VFXReflectionPass']);

/**
 * the sway a material's surface will carry, for converting the meshes it draws before the surfaces are
 * described
 *
 * @param material a converted material
 * @param shader its shader's entry
 * @returns its sway, or `null` when it keeps still
 */
export const materialSway = (material: MaterialValues, shader: ShaderEntry): LitSway | null =>
	shader.name === 'HGRP/Lit' && material.blend !== 'additive' ? swayOf(readerOf(material, shader)) : null;

/**
 * @param material a converted material
 * @param shader its shader's entry
 * @returns its surface description
 */
export const describeMaterial = (material: MaterialValues, shader: ShaderEntry): MaterialSurface => {
	// the water pipeline's proxy meshes, which the water pass stands in for
	if (shader.family === 'waterProxy') {
		return { kind: 'undrawn', reason: 'a water proxy, which feeds the water pass' };
	}
	if (UNDRAWN_SHADERS.has(shader.name)) {
		return { kind: 'undrawn', reason: 'writes only the reflections’ inputs' };
	}
	const noLook = unsupported('the viewer has no look for this shader');
	if (shader.family === 'unknown') {
		return noLook;
	}
	// the opaque path has no additive blending
	if (material.blend === 'additive' && !EFFECT_FAMILIES.has(shader.family)) {
		return unsupported('additive blending outside the effect shaders');
	}
	const reader = readerOf(material, shader);
	switch (shader.family) {
		case 'mattePainting': {
			return describeMattePainting(reader);
		}
		case 'erosion': {
			return describeErosion(reader);
		}
		case 'fogSimple': {
			return describeMistCard(reader);
		}
		case 'vfxFakeVolumeFog': {
			return shader.name === 'HGRP/Effect/VFXFakeVolumeFog' ? describeMistVolume(reader) : noLook;
		}
		case 'volumetricBeam': {
			return describeLightBeam(reader);
		}
		case 'vfxDitherAlpha': {
			return isDitherEffect(reader) ? describeDitherEffect(reader) : describeDithered(reader);
		}
		case 'vfxBase': {
			return shader.name === 'HGRP/Effect/VFXBaseV2' ? describeVfxBase(reader) : noLook;
		}
		case 'water': {
			return shader.name === 'HGRP/Effect/VFXWater' ? describeWaterSheet(reader) : noLook;
		}
		case 'vfxRefract': {
			return shader.name === 'HGRP/Effect/VFXRefract' ? describeRefract(reader) : noLook;
		}
		case 'vfxSmokeSixWay': {
			return describeSixWaySmoke(reader);
		}
		case 'waterDecal': {
			return describeWaterFoam(reader);
		}
		case 'decal': {
			switch (shader.name) {
				case 'HGRP/Effect/VFXDecal': {
					return describeVfxDecal(reader);
				}
				case 'HGRP/DecalLit': {
					return describeLitDecal(reader);
				}
				default: {
					return noLook;
				}
			}
		}
		default: {
			// the other effect families (VFXAdvance, …) have no look
			return LIT_FAMILIES.has(shader.family) ? describeLit(reader) : noLook;
		}
	}
};
