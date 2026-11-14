import type { LitDecalSurface } from '@endfield-noclip/package-format/surfaces';

import {
	EffectKind,
	type EffectLook,
	EffectRow,
	emptyEffect,
	ROLE_NONE,
	setSlot,
	still,
} from './effect-look.ts';

/**
 * float offsets of an `HGRP/DecalLit` look's parameters, in place of {@link EffectRow}'s rows 17–26 and 32.
 * the tint (the placement's colour; alpha times `_DecalOpacity`), the UV rows of slot 0 (`_BaseColorMap`), 1
 * (`_SampleTex1`) and 2 (`_SludgeDecalTex`) and the last row are shared
 */
export const DecalLitRow = {
	/**
	 * `_RoughnessMin`, `_RoughnessMax`, `_NormalScale`, the angle fade's power (0 without
	 * `_NORMAL_ANGLE_BLEND`)
	 */
	surface: 68,
	/**
	 * 1 when the decal writes its normal over the surface's, 1 when it writes its roughness, then
	 * `_BlendSceneNormal` (how much the decal's normal map takes the surface's frame instead of the box's), 0
	 */
	writes: 72,
	/** 1 when it writes metallic, 1 when it writes occlusion, `_Metallic`, `_OcclusionStrength` */
	pbr: 76,
	/**
	 * 1 when the base map is the PBR map and the colour is the placement's alone (`_BaseTexChannel`),
	 * `_MetallicChannel`, `_OcclusionChannel`, `_AffectNormal`
	 */
	channels: 80,
	/**
	 * `_BLEND_WATER_FLOW`: 1 when on, `_WaterNormalScale`, `_WaterRoughness`, `_NormalFactor` (how far steep
	 * walls push the flow's UVs)
	 */
	water: 84,
	/** `_BLEND_WATER_FLOW`: `_UVMovement` (the two layers' scroll speeds, then their UV scales) */
	flow: 88,
	/** `_BLEND_WATER_FLOW`: `_AngleBlendFallOff2`, the power of the fade towards level surfaces, then 0, 0, 0 */
	flowFade: 92,
	/** `_BLEND_EMISSIVE`: `_EmissiveColor` rgb, then 1 when on */
	emissive: 96,
	/**
	 * `_BLEND_EMISSIVE`: `_EmissiveChannel` (0–3 pick `_SampleTex1`'s R–A, 4 the base map's alpha),
	 * `_AlbedoAffectEmissive` (1: emission ignores the albedo), `_IgnorePostExposure`, 0
	 */
	emissiveMask: 100,
	/**
	 * 1 when the PBR map takes the placement's UV transform rather than its own (`FX_UV` + 1), then 0, 0, 0.
	 * the base map always takes the placement's
	 */
	pbrPlaced: 104,
	/**
	 * `_BLEND_SLUDGE_EROSION`: 1 when on, `_SludgeDecalAlphaScale`, `_SludgeDecalHeightFalloff`, 0. in the
	 * texture stack's edge colour row, which decals don't read
	 */
	sludge: 128,
} as const;

/**
 * the slot of a lit decal's PBR map (`_SampleTex1`: normal RG, roughness B), or with `_BLEND_WATER_FLOW` its
 * water normal map (`_WaterNormalTex`: normal RG, roughness B, at world positions); its base colour is slot
 * 0
 */
const DECAL_PBR_SLOT = 1;

/** the slot of `_BLEND_SLUDGE_EROSION`'s wall texture, whose UV row holds its scale of the box's position */
const DECAL_SLUDGE_SLOT = 2;

/**
 * a lit decal ({@link LitDecalSurface}): its base colour map tinted by the placement's colour, with the PBR
 * map's roughness and normal (or a scrolling water normal map's), on the game's VFXDecal cube. each
 * placement's colour and UV transform come from its row
 *
 * @param decal the decal
 * @returns its look
 */
export const litDecalLook = (decal: LitDecalSurface): EffectLook => {
	const look = emptyEffect();
	const params = look.params;
	setSlot(look, 0, still(decal.base), ROLE_NONE);
	if (decal.pbr !== null) {
		const own = decal.pbr.ownTransform;
		if (own === null) {
			setSlot(look, DECAL_PBR_SLOT, still(decal.pbr.texture), ROLE_NONE);
			params[DecalLitRow.pbrPlaced] = 1;
		} else {
			setSlot(look, DECAL_PBR_SLOT, { ...still(decal.pbr.texture), ...own }, ROLE_NONE);
		}
	}
	params.set([1, 1, 1, decal.opacity], EffectRow.tint);
	params.set([...decal.roughness, decal.normalScale, decal.angleFade], DecalLitRow.surface);
	params.set(
		[decal.writesNormal ? 1 : 0, decal.writesRoughness ? 1 : 0, decal.blendSceneNormal],
		DecalLitRow.writes,
	);
	params.set(
		[decal.writesMetallic ? 1 : 0, decal.writesOcclusion ? 1 : 0, decal.metallic, decal.occlusionStrength],
		DecalLitRow.pbr,
	);
	params.set(
		[decal.pbrBase ? 1 : 0, decal.metallicChannel, decal.occlusionChannel, decal.affectNormal],
		DecalLitRow.channels,
	);
	const { waterFlow, sludge, emission } = decal;
	if (sludge !== null) {
		setSlot(look, DECAL_SLUDGE_SLOT, { ...still(sludge.texture), scale: sludge.scale }, ROLE_NONE);
		params.set([1, sludge.alphaScale, sludge.heightFalloff], DecalLitRow.sludge);
	}
	if (waterFlow !== null) {
		params.set([1, waterFlow.normalScale, waterFlow.roughness, waterFlow.normalFactor], DecalLitRow.water);
		params.set(waterFlow.movement, DecalLitRow.flow);
		params[DecalLitRow.flowFade] = waterFlow.levelFade;
	}
	if (emission !== null) {
		params.set([...emission.color, 1], DecalLitRow.emissive);
		params.set(
			[emission.channel, emission.albedoAffect, emission.ignorePostExposure],
			DecalLitRow.emissiveMask,
		);
	}
	params.set([0, EffectKind.LitDecal], EffectRow.unfogged);
	return look;
};
