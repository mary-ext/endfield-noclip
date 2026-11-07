import type { MistCardSurface, MistVolumeSurface } from '@endfield-noclip/package-format/surfaces';

import { type EffectLook, emptyEffect, ROLE_NONE, setSlot, still } from './effect-look.ts';

/**
 * float offsets of a mist look's parameters ({@link mistCardLook}, {@link mistVolumeLook}), in place of
 * `EffectRow` for the mist entry points of `effect.wgsl`. the UV rows are shared
 */
export const MistRow = {
	/** colour rgb (linear, HDR), alpha */
	color: 0,
	/** one UV transform per texture slot, as `EffectRow.uv` */
	uv: 4,
	/** cards: `_BaseAlphaIntensity`, `_FogNoiseIntensity`, `_UseWind`, `_WindNoiseIntensity` */
	card: 32,
	/** cards: `_WindNoiseContrast`, the wind noise's UV scale in u and v, `_WindSpeed` */
	wind: 36,
	/** cards: `_WindDirX`, `_WindDirY`, 1 when lit, `_LightFactor` */
	light: 40,
	/** cards: `_IndirectColor` (linear), 1 when the blending is additive */
	indirect: 44,
	/** distance fade start and end, near camera fade start and end (view depth, m) */
	fade: 48,
	/** cards: top fade contrast and offset, soft blend distance (0 without `_USE_SOFTBLEND`), 0 */
	top: 52,
	/** volumes: `_FogExponent`, `_FogDensity`, `_CubEdgeFade`, `_NearFadeDistance` (0 when walk-in) */
	volume: 56,
	/** volumes: `_HeightOffset`, `_HeightFalloff`, vertical falloff min, max (equal: none) */
	volumeHeight: 60,
	/** volumes: `_FogIntensityFadeDistance`, 1 to measure it from the centre, `_FogDepthStart`, `_FogDepthEnd` */
	volumeFade: 64,
	/** `_IgnorePostExposure`, 0, 0, 0 */
	misc: 68,
	/** volumes: the 3D noise's tiling xyz, 1 to sample it at the world position (else the box's) */
	volumeNoise: 72,
	/** volumes: the 3D noise's scroll per second xyz (`_NoiseUVWDir1 · _NoiseUVWSpeed1`), 0 */
	volumeNoiseFlow: 76,
	/**
	 * volumes: `_NoiseIntensity` (near), `_NoiseFarIntensity`, 0.1 / `_NoiseFar` (per metre towards far), 1
	 * with the noise (`_USE_NOISE3D` and its texture)
	 */
	volumeNoiseMix: 80,
} as const;

/** the slot index of a card's noise texture; its main texture is slot 0 */
const MIST_NOISE_SLOT = 1;

/**
 * a mist card ({@link MistCardSurface}): its main texture in slot 0, its noise in {@link MIST_NOISE_SLOT}
 *
 * @param card the card
 * @returns its look
 */
export const mistCardLook = (card: MistCardSurface): EffectLook => {
	const look = emptyEffect();
	const params = look.params;
	setSlot(
		look,
		0,
		{ ...still(card.main.texture), scale: card.main.scale, offset: card.main.offset },
		ROLE_NONE,
	);
	setSlot(
		look,
		MIST_NOISE_SLOT,
		{ ...still(card.noise.texture), scale: card.noise.scale, offset: card.noise.offset },
		ROLE_NONE,
	);
	const { wind } = card;
	params.set(card.color, MistRow.color);
	params.set([card.baseAlphaIntensity, card.noiseIntensity, card.useWind, wind.noiseIntensity], MistRow.card);
	params.set([wind.noiseContrast, ...wind.scale, wind.speed], MistRow.wind);
	params.set([...wind.direction, card.lit ? 1 : 0, card.lightFactor], MistRow.light);
	params.set([...card.indirectColor, card.additive ? 1 : 0], MistRow.indirect);
	params.set([...card.distanceFade, ...card.nearFade], MistRow.fade);
	params.set([card.topFade.contrast, card.topFade.offset, card.softDistance], MistRow.top);
	return look;
};

/**
 * a mist box ({@link MistVolumeSurface}), its noise the look's volume texture
 *
 * @param volume the box's material
 * @returns its look
 */
export const mistVolumeLook = (volume: MistVolumeSurface): EffectLook => {
	const look = emptyEffect();
	const params = look.params;
	params.set(volume.color, MistRow.color);
	params.set([volume.exponent, volume.density, volume.edgeFade, volume.nearFade], MistRow.volume);
	params.set(
		[volume.height.offset, volume.height.falloff, ...volume.height.verticalFalloff],
		MistRow.volumeHeight,
	);
	params.set(
		[volume.intensityFadeDistance, volume.intensityFadeFromCentre, ...volume.depth],
		MistRow.volumeFade,
	);
	params[MistRow.misc] = volume.ignorePostExposure;
	const { noise } = volume;
	if (noise !== null) {
		look.volumeTexture = noise.texture;
		params.set([...noise.tiling, noise.world ? 1 : 0], MistRow.volumeNoise);
		params.set(noise.flow, MistRow.volumeNoiseFlow);
		params.set([noise.nearIntensity, noise.farIntensity, noise.farPerMetre, 1], MistRow.volumeNoiseMix);
	}
	return look;
};
