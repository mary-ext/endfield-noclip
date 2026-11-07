/**
 * the looks besides Lit that draw through the mesh shader's surface path: erosion rock, VFXDitherAlpha's
 * dithered surfaces and matte paintings
 *
 * @module
 */

import type { MaterialCull, TextureSlot } from '@endfield-noclip/package-format/materials';
import type {
	DitheredSurface,
	ErosionSurface,
	MattePaintingSurface,
} from '@endfield-noclip/package-format/surfaces';

import { emptyLook, LookFlags, LookRow, type MaterialLook, setTexture, Slot } from './look.ts';

// #region erosion

/**
 * float offsets of an {@link erosionLook}'s parameters, which reuse the rows of {@link LookRow} that the Lit
 * layers use
 */
export const ErosionRow = {
	/** linear `_BaseColor`, no alpha test */
	base: LookRow.tint,
	/** `_Roughness`, `_DetailRoughnessCover`, `_Metallic`, `_NormalScale` */
	surface: LookRow.surface,
	/** `_OcclusionStrength`, f0, `_MetallicOffset`, `_DetailNormalScale` */
	surface2: LookRow.surface2,
	/** `_NoiseEmissiveStrength`, `_FlowColorStrength`, `_FlowColorEmissiveStrength`, `_DistanceBlend` */
	strengths: LookRow.emissive,
	/** `_MetallicColor`, `_NoiseStrength` (the noise layer's depth) */
	metal: LookRow.maskAlbedo,
	/** `_NoisePatternTintColor`, `_NoiseMin` */
	noise: LookRow.maskAlbedo + 4,
	/** `_NoisePatternAlphaTintColor`, `_FlowColorOffset` */
	noiseAlpha: LookRow.maskAlbedo + 8,
	/** `_FlowTopColor`, `_FlowRoughness` */
	flowTop: LookRow.maskRoughness,
	/** `_FlowBottomColor` */
	flowBottom: LookRow.maskMetallic,
	/** `_FlowNormalTilling`, `_FlowNoiseStrength`, ramp scroll per second, `_FlowSpeedOffset` */
	flow: LookRow.maskScale,
} as const;

/**
 * erosion rock ({@link ErosionSurface}). its textures take `SLOTS`' places: the base normal map the normal
 * slot, the metal map the mask slot, the flow ramp the emissive slot, the detail normal map the detail slot,
 * and the noise pattern both parallax slots (tiled, then untiled for the march)
 *
 * @param surface the surface
 * @param cull the faces the material culls
 * @returns a new look
 */
export const erosionLook = (surface: ErosionSurface, cull: MaterialCull): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = cull;
	look.flags |= LookFlags.Erosion;
	const params = look.params;
	const { textures, noise, flow } = surface;
	const slots: [number, TextureSlot | null][] = [
		[Slot.Normal, textures.baseNormal],
		[Slot.Mask, textures.metalMix],
		[Slot.Emissive, textures.flowRamp],
		[Slot.Detail, textures.detailNormal],
		[Slot.Parallax, textures.noisePattern],
		[Slot.ParallaxNoise, textures.noisePattern === null ? null : { ...textures.noisePattern, scale: [1, 1] }],
	];
	for (const [i, slot] of slots) {
		if (slot !== null) {
			setTexture(look, i, slot);
		}
	}
	// the ramp is sampled at its finest level whatever its size on screen
	if (textures.flowRamp !== null) {
		look.uvScales[Slot.Emissive] = 0;
	}
	params.set([...surface.baseColor, -1], ErosionRow.base);
	params.set(
		[surface.roughness, surface.detailRoughnessCover, surface.metallic, surface.normalScale],
		ErosionRow.surface,
	);
	params.set(
		[surface.occlusionStrength, surface.f0, surface.metallicOffset, surface.detailNormalScale],
		ErosionRow.surface2,
	);
	params.set(
		[noise.emissiveStrength, flow.colorStrength, flow.emissiveStrength, noise.fadeDistance],
		ErosionRow.strengths,
	);
	params.set([...surface.metallicColor, noise.depth], ErosionRow.metal);
	params.set([...noise.tint, noise.min], ErosionRow.noise);
	params.set([...noise.alphaTint, flow.colorOffset], ErosionRow.noiseAlpha);
	params.set([...flow.top, flow.roughness], ErosionRow.flowTop);
	params.set(flow.bottom, ErosionRow.flowBottom);
	params.set([flow.tiling, flow.noiseStrength, flow.scroll, flow.speedOffset], ErosionRow.flow);
	return look;
};

// #endregion

// #region dithered

/**
 * the row of a dithered VFXDitherAlpha look (one whose alpha-test threshold, `tint.w`, is negative), which
 * reuses the leaves' canopy row
 */
export const DitherRow = {
	/**
	 * the alpha scale (`_TintColor.a · _TintColorAlpha`), `_DitherAlphaExp`, `_DitherTilling`, 1 when the alpha
	 * is the red of the texture (`_UseMainTexAsAlpha`) rather than its alpha
	 */
	dither: LookRow.canopy,
} as const;

/**
 * a dithered effect ({@link DitheredSurface}), drawn like an opaque surface; the shader has no shadow caster
 * pass
 *
 * @param surface the surface
 * @param cull the faces the material culls
 * @returns a new look
 */
export const ditheredLook = (surface: DitheredSurface, cull: MaterialCull): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = cull;
	look.castsShadows = false;
	const params = look.params;
	if (surface.baseMap !== null) {
		setTexture(look, Slot.Base, surface.baseMap);
	}
	if (surface.normalMap !== null) {
		setTexture(look, Slot.Normal, surface.normalMap);
	}
	const { dither } = surface;
	if (dither !== null) {
		// the main texture's red is the alpha alone, so it can't colour the surface: an unlit look tests it through
		// the normal slot, and a lit one, which may need that slot for its normal map, through the base slot, its
		// albedo taken from the tint alone (below)
		if (dither.redAlpha && surface.lighting === null) {
			setTexture(look, Slot.Normal, dither.texture);
			look.flags |= LookFlags.AlphaNormal;
		} else if (dither.redAlpha) {
			setTexture(look, Slot.Base, dither.texture);
		}
		params.set(
			[dither.alphaScale, dither.exponent, dither.tiling, dither.redAlpha ? 1 : 0],
			DitherRow.dither,
		);
		look.queue = 'cutout';
	}
	const { color, lighting } = surface;
	if (lighting === null) {
		// unlit: the radiance, as the matte painting's path draws it, with no highlight (zero intensity)
		look.flags |= LookFlags.Unlit;
		params.set([...color, -1], LookRow.tint);
		params[LookRow.emissive2 + 2] = surface.ignorePostExposure;
		return look;
	}
	look.flags |= LookFlags.NormalRag;
	// untextured, the tint is the albedo, which the G-buffer saturates
	const untextured = surface.baseMap === null;
	params.set([...(untextured ? color.map((c) => Math.min(c, 1)) : color), -1], LookRow.tint);
	params.set(
		[lighting.roughness, lighting.roughness, lighting.metallic, lighting.normalScale],
		LookRow.surface,
	);
	params.set([1, 0.04, 0, 1], LookRow.surface2);
	params[LookRow.emissive + 3] = untextured ? 1 : 0;
	return look;
};

// #endregion

// #region matte paintings

/**
 * a matte painting ({@link MattePaintingSurface}): unlit, and the shader has no shadow caster pass
 *
 * @param surface the surface
 * @param cull the faces the material culls
 * @returns a new look
 */
export const mattePaintingLook = (surface: MattePaintingSurface, cull: MaterialCull): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = cull;
	look.castsShadows = false;
	look.flags |= LookFlags.Unlit;
	const params = look.params;
	if (surface.texture !== null) {
		setTexture(look, Slot.Base, surface.texture);
	}
	const threshold = surface.alphaClip ?? -1;
	params.set([...surface.color, threshold], LookRow.tint);
	if (threshold >= 0 && look.textures[Slot.Base] !== null) {
		look.queue = 'cutout';
	}
	params[LookRow.surface] = surface.highlight.threshold;
	params[LookRow.surface + 1] = surface.highlight.intensity;
	params[LookRow.emissive2 + 2] = surface.ignorePostExposure;
	return look;
};

// #endregion
