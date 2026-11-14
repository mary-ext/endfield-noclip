/**
 * interprets a converted material into the surface description the viewer draws
 * (`package-format/surfaces.ts`): which model, with the shader's properties, keywords and formulas applied. a
 * material whose keywords or texture combinations the viewer doesn't draw becomes `unsupported` with the
 * reason, which the pack lists in `debug/assets.json`. stays out of the conversion worker's imports.
 *
 * each shader the viewer draws has a describer module, in `surfaces/` for the shaders shaded as surfaces (the
 * Lit model, matte paintings, erosion, dithered effects, lit decals) and `effects/` for the effect looks,
 * built from the shared steps beside them (`describe-steps.ts`, `effects/effect-steps.ts`,
 * `effects/texture-stack.ts`) and picked by {@link DESCRIBERS}
 */

import type { LitSway, LitVertexOffset, MaterialSurface } from '@endfield-noclip/package-format/surfaces';

import { describeDitherEffect, isDitherEffect } from './effects/dither-effect.ts';
import { describeLightBeam } from './effects/light-beam.ts';
import { describeMistCard } from './effects/mist-card.ts';
import { describeMistVolume } from './effects/mist-volume.ts';
import { describeRefract } from './effects/refract.ts';
import { describeSixWaySmoke } from './effects/six-way-smoke.ts';
import { describeCharacterVfx, describeVfxAdvance } from './effects/vfx-advance.ts';
import { describeVfxBase } from './effects/vfx-base.ts';
import { describeVfxDecal } from './effects/vfx-decal.ts';
import { describeWaterFoam } from './effects/water-foam.ts';
import { describeWaterSheet } from './effects/water-sheet.ts';
import {
	type MaterialReader,
	type MaterialValues,
	readerOf,
	type ShaderEntry,
	type ShaderFamily,
	unsupported,
} from './material-values.ts';
import { describeDithered } from './surfaces/dithered.ts';
import { describeErosion } from './surfaces/erosion.ts';
import { describeFoliageGlow } from './surfaces/foliage-glow.ts';
import { describeLitDecal } from './surfaces/lit-decal.ts';
import { swayOf, vertexOffsetOf } from './surfaces/lit-sway.ts';
import { describeLit } from './surfaces/lit.ts';
import { describeMattePainting } from './surfaces/matte-painting.ts';

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

/** describes a material of the shader it was picked for */
type Describer = (reader: MaterialReader) => MaterialSurface;

const byShader = (describers: Record<string, Describer>): ReadonlyMap<string, Describer> =>
	new Map(Object.entries(describers));

/**
 * the describer of each family the viewer draws: one for all of the family's shaders, or one per shader name,
 * where the family's other shaders have no look. the families left out have none
 */
const DESCRIBERS: { readonly [F in ShaderFamily]?: Describer | ReadonlyMap<string, Describer> } = {
	lit: describeLit,
	litEffect: describeLit,
	litTransparent: describeLit,
	litForward: describeLit,
	trunk: describeLit,
	leaf: describeLit,
	grass: describeLit,
	cardMesh: describeLit,
	foliageGlow: describeFoliageGlow,
	hlod: describeLit,
	terrain: describeLit,
	mattePainting: describeMattePainting,
	erosion: describeErosion,
	vfxDitherAlpha: (reader) =>
		isDitherEffect(reader) ? describeDitherEffect(reader) : describeDithered(reader),
	decal: byShader({ 'HGRP/Effect/VFXDecal': describeVfxDecal, 'HGRP/DecalLit': describeLitDecal }),
	fogSimple: describeMistCard,
	vfxFakeVolumeFog: byShader({ 'HGRP/Effect/VFXFakeVolumeFog': describeMistVolume }),
	volumetricBeam: describeLightBeam,
	vfxBase: byShader({ 'HGRP/Effect/VFXBaseV2': describeVfxBase }),
	vfxAdvance: byShader({
		'HGRP/Effect/VFXAdvance': describeVfxAdvance,
		'HGRP/CharacterNPR_VFX': describeCharacterVfx,
	}),
	vfxRefract: byShader({ 'HGRP/Effect/VFXRefract': describeRefract }),
	vfxSmokeSixWay: describeSixWaySmoke,
	water: byShader({ 'HGRP/Effect/VFXWater': describeWaterSheet }),
	waterDecal: describeWaterFoam,
};

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
 * the vertex offset a material's surface will carry, for converting the meshes it draws before the surfaces
 * are described
 *
 * @param material a converted material
 * @param shader its shader's entry
 * @returns its vertex offset, or `null` without one
 */
export const materialVertexOffset = (
	material: MaterialValues,
	shader: ShaderEntry,
): LitVertexOffset | null =>
	shader.name === 'HGRP/Lit' && material.blend !== 'additive'
		? vertexOffsetOf(readerOf(material, shader))
		: null;

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
	const describers = DESCRIBERS[shader.family];
	const describer = describers instanceof Map ? describers.get(shader.name) : describers;
	return describer === undefined ? noLook : describer(readerOf(material, shader));
};
