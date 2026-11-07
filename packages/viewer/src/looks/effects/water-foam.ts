import type { WaterFoamSurface } from '@endfield-noclip/package-format/surfaces';

import { EffectKind, type EffectLook, EffectRole, EffectRow, emptyEffect, setSlot } from './effect-look.ts';

/**
 * float offsets of a WaterDecal look's parameters, in place of {@link EffectRow}'s rows 17–27. slots 0–3 are
 * the base colour map, disturb, mask and dissolve textures; their UV rows hold each `_ST` and their scroll
 * rows each scroll per second, which the shader applies in the game's order for each
 */
export const WaterFoamRow = {
	/** `_BaseColor` rgb, `_OverallOpacity` */
	base: 0,
	/** `_BaseColorTint` rgb, {@link WaterFoamFlags} */
	tint: 68,
	/** `_Bi_Disturb`, `_DisturbUIntensity1`, `_DisturbVIntensity1`, `_BlendMode` */
	disturb: 72,
	/** how far the distortion moves the base, mask and dissolve UVs, then `_UseAChannelAsAlpha` */
	use: 76,
	/** each slot's UV source (`WaterFoamSource` in package-format) */
	sources: 80,
	/** the mask's UV matrix, by columns */
	maskMatrix: 84,
	/** dissolve threshold, edge sharpness, glowing edge width, `_UseMaskTexAsAlpha` */
	dissolve: 88,
	/** the dissolve edge's colour (HDR), 0 */
	dissolveColor: 92,
	/** the box's UV scale and offset */
	boxUv: 96,
	/** `_EdgeFadeRange` xy, then the soft blend's bias and distance (0 without `_USE_SOFTBLEND`) */
	fade: 100,
	/** mip levels added to the base colour map's and the mask's, then the dissolve texture's level */
	mip: 104,
	/** the erosion's noise strength, flowmap u shift, distance and offset (`WaterErosion`) */
	erosion: 108,
	/** the erosion's edge colour rgb (HDR), 0 */
	erosionEdge: 112,
	/** each erosion layer's colour rgb (HDR) and threshold, three rows past the vertex stage's rows 30–31 */
	erosionLayers: 128,
} as const;

/**
 * the slots of a look with `_USE_WATER_EROSION`, after the base colour map's 0: the flowmap, its noise, the
 * gradient and the three layers' noises, in the slots the distortion, mask and dissolve leave free
 */
export const EROSION_SLOTS = { flow: 1, flowNoise: 2, gradient: 3, layers: 4 } as const;

/** {@link WaterFoamRow.tint}'s w bits, matching `effect.wgsl` */
export const WaterFoamFlags = {
	Disturb: 1 << 0,
	Mask: 1 << 1,
	Dissolve: 1 << 2,
	EdgeFade: 1 << 3,
	ClipToBox: 1 << 4,
	Soft: 1 << 5,
	Erosion: 1 << 6,
} as const;

/**
 * a WaterDecal box ({@link WaterFoamSurface})
 *
 * @param foam the box's material
 * @returns its look
 */
export const waterFoamLook = (foam: WaterFoamSurface): EffectLook => {
	const look = emptyEffect();
	const params = look.params;
	const { textures, dissolve, erosion } = foam;
	[textures.base, textures.disturb, textures.mask, dissolve?.texture ?? null].forEach((texture, i) => {
		if (texture !== null) {
			setSlot(look, i, texture, EffectRole.Main);
		}
	});
	if (erosion !== null) {
		// the package leaves these slots empty with an erosion (`WaterFoamSurface.erosion`)
		setSlot(look, EROSION_SLOTS.flow, erosion.flow, EffectRole.Main);
		setSlot(look, EROSION_SLOTS.flowNoise, erosion.flowNoise, EffectRole.Main);
		setSlot(look, EROSION_SLOTS.gradient, erosion.gradient, EffectRole.Main);
		erosion.layers.forEach((layer, i) => {
			setSlot(look, EROSION_SLOTS.layers + i, layer.noise, EffectRole.Main);
			params.set([...layer.color, layer.threshold], WaterFoamRow.erosionLayers + i * 4);
		});
		params.set(
			[erosion.noiseStrength, erosion.flowShift, erosion.distance, erosion.offset],
			WaterFoamRow.erosion,
		);
		params.set([...erosion.edgeColor, 0], WaterFoamRow.erosionEdge);
	}
	const flags =
		(textures.disturb === null ? 0 : WaterFoamFlags.Disturb) |
		(textures.mask === null ? 0 : WaterFoamFlags.Mask) |
		(dissolve === null ? 0 : WaterFoamFlags.Dissolve) |
		(foam.edgeFade === null ? 0 : WaterFoamFlags.EdgeFade) |
		(foam.clipToBox ? WaterFoamFlags.ClipToBox : 0) |
		(foam.soft === null ? 0 : WaterFoamFlags.Soft) |
		(erosion === null ? 0 : WaterFoamFlags.Erosion);
	params.set([...foam.baseColor, foam.opacity], WaterFoamRow.base);
	params.set([...foam.tint, flags], WaterFoamRow.tint);
	params.set([foam.disturbBias, ...foam.disturb, foam.blendMode], WaterFoamRow.disturb);
	params.set([...foam.disturbUse, foam.baseAlpha], WaterFoamRow.use);
	const { sources } = foam;
	params.set([sources.base, sources.disturb, sources.mask, sources.dissolve], WaterFoamRow.sources);
	params.set(foam.maskMatrix, WaterFoamRow.maskMatrix);
	params.set(
		[dissolve?.threshold ?? 0, dissolve?.sharpness ?? 1, dissolve?.edgeWidth ?? 0, foam.maskAsAlpha],
		WaterFoamRow.dissolve,
	);
	params.set([...(dissolve?.edgeColor ?? [0, 0, 0]), 0], WaterFoamRow.dissolveColor);
	params.set(foam.boxUv, WaterFoamRow.boxUv);
	params.set(
		[...(foam.edgeFade ?? [0, 0]), foam.soft?.bias ?? 0, foam.soft?.distance ?? 0],
		WaterFoamRow.fade,
	);
	params.set([foam.mipBias.base, foam.mipBias.mask, foam.mipBias.dissolve, 0], WaterFoamRow.mip);
	params.set([0, EffectKind.WaterFoam, 0, 0], EffectRow.unfogged);
	return look;
};
