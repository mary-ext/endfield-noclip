import type { MaterialCull } from '@endfield-noclip/package-format/materials';
import type {
	EmissiveFresnel,
	GrassInputs,
	LayerCoverage,
	LeafInputs,
	FlowGlow,
	LitEmission,
	LitFresnel,
	LitLayer,
	LitSurface,
	LitSway,
	LitVertexOffset,
	ParallaxGlow,
	TrunkInputs,
} from '@endfield-noclip/package-format/surfaces';
import type { Rgb } from '@endfield-noclip/package-format/values';

import {
	alphaTextureOf,
	emptyLook,
	LookFlags,
	LookRow,
	type MaterialLook,
	setTexture,
	Slot,
} from './look.ts';

/**
 * the Lit model ({@link LitSurface}). tri-channel masks ({@link Slot.TriMask}) and overlay masks
 * ({@link Slot.OverlayMask}) have dedicated slots so they never collide with `_MROMap` or `_EmissiveMap`;
 * emission pulse/breathing and cloth/pendulum sway have dedicated rows in the look tail. a vertex offset's
 * textures still share the parallax slots, so it isn't drawn alongside a parallax glow or layer, nor on
 * surfaces that aren't alpha-tested or that offset along the normal (docs/viewer/materials.md#vertex-offset)
 *
 * @param surface the surface
 * @param cull the faces the material culls
 * @returns a new look
 */
export const litLook = (surface: LitSurface, cull: MaterialCull): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = cull;
	const params = look.params;
	const { textures, emission, overlay } = surface;
	if (textures.base !== null) {
		setTexture(look, Slot.Base, textures.base);
	}
	if (textures.normal !== null) {
		setTexture(look, Slot.Normal, textures.normal);
	}
	if (textures.mro !== null) {
		setTexture(look, Slot.Mask, textures.mro);
	}
	if (textures.emissive !== null) {
		setTexture(look, Slot.Emissive, textures.emissive);
	}
	if (surface.triChannel !== null) {
		setTexture(look, Slot.TriMask, surface.triChannel.mask);
	}
	if (surface.detail !== null) {
		setTexture(look, Slot.Detail, surface.detail.texture);
	}

	switch (surface.layout) {
		case 'mro': {
			look.flags |= LookFlags.NormalRag;
			break;
		}
		case 'twoBasemap': {
			// the two-basemap layout's occlusion and metallic sources (docs/game-data/materials.md#texture-layouts)
			look.flags |= LookFlags.NormalRoughness | LookFlags.NormalOcclusion;
			if (surface.metallicFromBaseAlpha) {
				look.flags |= LookFlags.MetallicBaseAlpha;
			}
			break;
		}
		case 'roughnessInB': {
			look.flags |= LookFlags.NormalRoughness;
			break;
		}
		case 'plain': {
			break;
		}
	}
	if (surface.foliage !== null) {
		look.flags |= LookFlags.Foliage;
	}
	if (surface.alphaFromNormal) {
		look.flags |= LookFlags.AlphaNormal;
	}

	// base colour: tinted and brightened, then covered by the tint
	params.set([...surface.tint, surface.alphaClip ?? -1], LookRow.tint);
	// glass: the opacity is the alpha the alpha test would read, times its own. glass casting a solid shadow
	// would darken what lies behind it, so it casts none
	if (surface.blend !== 'opaque') {
		look.queue = surface.writesDepth ? 'transparentDepthWrite' : 'transparent';
		look.castsShadows = false;
		params[LookRow.emissive2 + 3] = surface.opacity;
		params[LookRow.meta + 2] = surface.blend === 'premultiplied' ? 1 : 0;
		if (surface.vertexRedOpacity) {
			params[LookRow.parallaxBright + 1] = 1;
		}
		if (surface.fresnel != null) {
			fresnelParams(params, surface.fresnel);
		}
	} else if (surface.alphaClip !== null && surface.alphaClip >= 0 && alphaTextureOf(look) !== null) {
		if (surface.writesDepth) {
			look.queue = 'cutout';
		} else {
			look.queue = 'cutoutOverlay';
			look.castsShadows = false;
		}
	}
	params[LookRow.emissive + 3] = surface.tintCover;
	// `_SUBSURFACE` on `HGRP/LitTransparent` forces dielectric shading (`metallic = 0`) and scatters through the
	// same `LookRow.foliage` / `LookRow.foliageAo` slots as `VFXWaterDitherAlpha`
	const subsurface = surface.subsurface ?? null;
	const metallic = subsurface === null ? surface.metallic : 0;
	params.set([surface.roughness[0], surface.roughness[1], metallic, surface.normalScale], LookRow.surface);
	if (subsurface !== null) {
		const [hue, saturation, value, indirect] = subsurface;
		const amount = value * surface.opacity;
		const scattered = hueRgb(hue).map((c) => (1 + (c - 1) * saturation) * amount);
		params.set([...scattered, amount], LookRow.foliage);
		params[LookRow.foliageAo] = indirect;
	}
	params.set(
		[surface.occlusionStrength, surface.f0, surface.transmission, surface.brighterScale],
		LookRow.surface2,
	);
	switch (surface.foliage?.kind) {
		case 'leaf': {
			leafParams(look, surface.foliage);
			break;
		}
		case 'grass': {
			grassParams(look, surface.foliage);
			break;
		}
		default: {
			break;
		}
	}

	if (emission !== null) {
		if (emission.source === 'mask') {
			look.flags |= LookFlags.EmissiveMask;
		}
		params.set(emission.color, LookRow.emissive);
		params.set([emission.albedoAffect, emission.maskChannel, emission.ignorePostExposure], LookRow.emissive2);
		emission.channels?.forEach((rgb, i) => {
			params.set(rgb, LookRow.emissiveChannels + i * 4);
		});
		if (emission.albedoTint !== null) {
			params.set([...emission.albedoTint.color, emission.albedoTint.weight], LookRow.emissiveAlbedo);
		}
		if (emission.fresnel != null && surface.foliage !== null) {
			emissiveFresnelParams(params, emission.fresnel);
		}
	}

	if (surface.triChannel !== null) {
		look.flags |= LookFlags.TriChannelMask;
		surface.triChannel.channels.forEach((channel, i) => {
			params.set([...channel.albedo, channel.strength], LookRow.maskAlbedo + i * 4);
			params[LookRow.maskRoughness + i] = channel.roughness;
			params[LookRow.maskMetallic + i] = channel.metallic;
			params[LookRow.maskScale + i] = channel.scale;
			params[LookRow.maskOffset + i] = channel.offset;
		});
	}

	const { detail } = surface;
	if (detail !== null) {
		params.set([detail.mode, detail.maskMode, detail.normalIntensity, detail.pbrIntensity], LookRow.detail);
		params.set([detail.fade[0], detail.fade[1], detail.brighterScale], LookRow.detail2);
		params.set([...detail.overlay, detail.overlayCover], LookRow.detailOverlay);
	}

	// the glow, the layer, and transparent Fresnel take the parallax slots/rows, which vertex offset shares
	let parallaxSlotsFree = surface.fresnel == null;
	switch (overlay?.kind) {
		case 'parallax': {
			parallaxParams(look, overlay);
			parallaxSlotsFree = false;
			break;
		}
		case 'flowGlow': {
			flowGlowParams(look, overlay);
			break;
		}
		case 'layer': {
			layerBlendParams(look, overlay, LAYER_SOURCES[overlay.coverage.kind]);
			parallaxSlotsFree = false;
			break;
		}
		default: {
			break;
		}
	}
	if (emission !== null && (emission.pulse !== null || emission.breath !== null)) {
		emissivePulseParams(look, emission.pulse, emission.breath);
	}
	if (surface.keepsLitDecalsOff) {
		params[LookRow.detail2 + 3] = 1;
	}
	if (surface.sway !== null && (surface.foliage === null || surface.sway.kind === 'mushroom')) {
		swayParams(look, surface.sway);
	}
	if (surface.trunk !== null && surface.foliage === null) {
		trunkParams(look, surface.trunk);
	}
	// the offset's textures take the parallax slots, and only the alpha-tested depth and shadow passes read
	// the UV sets and textures it needs; their vertex stages don't read the normal
	const { vertexOffset } = surface;
	if (vertexOffset !== null) {
		if (
			vertexOffset.space !== 'normal' &&
			surface.foliage === null &&
			parallaxSlotsFree &&
			look.queue === 'cutout'
		) {
			vertexOffsetParams(look, vertexOffset);
		} else {
			look.gaps.push('vertex offset: not alpha-tested, along the normal, or its slots are held');
		}
	}
	return look;
};

/** a hue (0–1) as a fully saturated colour */
const hueRgb = (hue: number): Rgb => {
	const channel = (shift: number): number => {
		const turn = (((hue + shift) % 1) + 1) % 1;
		return Math.min(Math.max(Math.abs(turn * 6 - 3) - 1, 0), 1);
	};
	return [channel(0), channel(2 / 3), channel(1 / 3)];
};

/**
 * packs `HGRP/LitTransparent`'s `_USE_FRESNEL` into the parallax rows (unused on transparent looks):
 * `parallax` = `(bias, power, flip, affectOpacity)`, `parallax2` = `(mapChannel, maskOffset, vertexGreen,
 * useMeshNormal)`, `parallaxColor` = linear HDR `_FresnelColor`, `parallaxBright.x` = 1
 */
const fresnelParams = (params: Float32Array, fresnel: LitFresnel): void => {
	params.set([fresnel.bias, fresnel.power, fresnel.flip, fresnel.affectOpacity], LookRow.parallax);
	params.set(
		[fresnel.mapChannel, fresnel.maskOffset, fresnel.vertexGreen ? 1 : 0, fresnel.useMeshNormal ? 1 : 0],
		LookRow.parallax2,
	);
	params.set(fresnel.color, LookRow.parallaxColor);
	params[LookRow.parallaxBright] = 1;
};

/**
 * packs `HGRP/Foliage/MushroomAnimation`'s `_UseEmissiveNoMapFresnel` into the parallax rows (unused on
 * foliage looks): `parallax` = `(bias, power, useVertexNormal, vertexGreen)`, `parallaxColor` = `(r, g, b,
 * 1)`
 */
const emissiveFresnelParams = (params: Float32Array, fresnel: EmissiveFresnel): void => {
	params.set([fresnel.bias, fresnel.power, fresnel.useVertexNormal, fresnel.vertexGreen], LookRow.parallax);
	params.set([...fresnel.color, 1], LookRow.parallaxColor);
};

// #region vertex animation and pulse

/** values of {@link SwayRow.kind} (`meta.y` in `surfaces/common.ts`) */
export const SwayKind = {
	Cloth: 0,
	Pendulum: 1,
	Mushroom: 2,
} as const;

/**
 * where vertex sway keeps its inputs: dedicated tail rows that never collide with foliage or trunk
 * parameters. `surfaces/common.ts` sways cloth/pendulum vertices when the look isn't foliage, erosion, unlit
 * or an effect, and mushroom vertices when `meta.y` is {@link SwayKind.Mushroom}
 */
export const SwayRow = {
	/**
	 * cloth/pendulum: `_SimpleVertexAnimationWindIntensity`, `_SimpleVertexAnimationWindFreq`, then the cloth's
	 * soft factor and `_Kite`, or the pendulum's `_Stability` and turn about +Y per unit of the wind clock.
	 * mushroom: `1 / period`, `_SwayAnimationBendScale`, `_SwayAnimationSquashScale`,
	 * `_SwayAnimationTwistScale`
	 */
	sway: LookRow.sway,
	/**
	 * cloth/pendulum: `_DirectionTendency` or pendulum spin range (radians), 1 for the material's own
	 * direction, that direction's X and Z. mushroom: `_SwayAnimationPhaseRandom`, `_SwayAnimationSpeedRandom`,
	 * `_SwayAnimationMaskPow`, 0
	 */
	direction: LookRow.sway + 4,
	/** {@link SwayKind}, stored in `meta.y` */
	kind: LookRow.meta + 1,
} as const;

/** vertex sway (`docs/game-data/materials.md#swaying-cloth`, `#swinging-pendulums`, `#mushroom-animation`) */
const swayParams = (look: MaterialLook, sway: LitSway): void => {
	switch (sway.kind) {
		case 'cloth': {
			const direction = [sway.direction === null ? 0 : 1, ...(sway.direction ?? [0, 0])];
			look.params.set([sway.intensity, sway.frequency, sway.softness, sway.kite], SwayRow.sway);
			look.params.set([sway.tendency, ...direction], SwayRow.direction);
			break;
		}
		case 'pendulum': {
			const direction = [sway.direction === null ? 0 : 1, ...(sway.direction ?? [0, 0])];
			look.params.set([sway.intensity, sway.frequency, sway.stability, sway.spinFrequency], SwayRow.sway);
			look.params.set([sway.spinRange, ...direction], SwayRow.direction);
			look.params[SwayRow.kind] = SwayKind.Pendulum;
			break;
		}
		case 'mushroom': {
			setTexture(look, Slot.Parallax, sway.lut);
			look.params.set(
				[1 / Math.max(sway.period, 0.001), sway.bendScale, sway.squashScale, sway.twistScale],
				SwayRow.sway,
			);
			look.params.set([sway.phaseRandom, sway.speedRandom, sway.maskPow, 0], SwayRow.direction);
			look.params[SwayRow.kind] = SwayKind.Mushroom;
			break;
		}
	}
};

/**
 * where `_USE_VERTOFFSET`'s offset keeps its inputs: the parallax rows the pulse leaves alone, on a look with
 * {@link LookFlags.VertexOffset}, whose parallax slots hold the offset texture and its mask
 */
export const VertexOffsetRow = {
	/** `_OffsetDir.xyz`, 1 when it lies along the world's axes (0: turned by the object's transform) */
	direction: LookRow.parallaxColor,
	/**
	 * `_OffsetIntensity`, `_Bi_Offset`, 1 when the vertex colour's alpha weighs the offset, the mask's strength
	 * (`_OffsetMaskPower / 5`; 0 unmasked)
	 */
	shape: LookRow.parallaxDark,
	/** UV scroll per second of the offset texture (xy) and of its mask (zw) */
	scroll: LookRow.parallaxBright,
} as const;

/**
 * `_USE_VERTOFFSET`'s offset by a scrolling texture (docs/game-data/materials.md#vertex-offset). both
 * textures sample the offset's UV set, each through its own `_ST`
 */
const vertexOffsetParams = (look: MaterialLook, offset: LitVertexOffset): void => {
	const { mask } = offset;
	look.flags |= LookFlags.VertexOffset;
	setTexture(look, Slot.Parallax, offset.texture);
	if (mask !== null) {
		setTexture(look, Slot.ParallaxNoise, mask.texture);
	}
	look.params.set([...offset.direction, offset.space === 'world' ? 1 : 0], VertexOffsetRow.direction);
	look.params.set(
		[offset.intensity, offset.bias, offset.vertexAlphaWeight ? 1 : 0, mask?.strength ?? 0],
		VertexOffsetRow.shape,
	);
	look.params.set([...offset.scroll, ...(mask?.scroll ?? [0, 0])], VertexOffsetRow.scroll);
};

/**
 * where `_EMISSIVE_ANIM`'s pulse and per-draw breathing keep their inputs: dedicated tail rows that never
 * collide with parallax, layer blend or Fresnel parameters. surfaces/surface.ts pulses emission when the
 * interval is positive and breathes it when the breathing frequency is positive
 */
export const EmissivePulseRow = {
	/** pulse cycles per second, phase offset (`_EmissiveAnimRandom`), interval, minimum brightness */
	pulse: LookRow.emissivePulse,
	/** how much the pulse dims the emission (`_EmissiveColor.a`), followed by breathing frequency and intensity */
	strength: LookRow.emissivePulse + 4,
} as const;

/** `_EMISSIVE_ANIM`'s pulse and per-draw breathing (docs/game-data/materials.md#emission) */
const emissivePulseParams = (
	look: MaterialLook,
	pulse: LitEmission['pulse'],
	breath: LitEmission['breath'],
): void => {
	if (pulse !== null) {
		look.params.set([pulse.rate, pulse.phase, pulse.interval, pulse.minimum], EmissivePulseRow.pulse);
		look.params[EmissivePulseRow.strength] = pulse.depth;
	}
	if (breath !== null) {
		look.params[EmissivePulseRow.strength + 1] = breath.frequency;
		look.params[EmissivePulseRow.strength + 2] = breath.intensity;
	}
};

// #endregion

// #region foliage

/**
 * where a trunk's `_FOLIAGE_TRUNK` inputs go: rows only leaves use otherwise (a trunk doesn't sway, so the
 * sway's direction row is free). surfaces/common.ts reads them on looks with {@link LookFlags.Trunk}
 */
export const TrunkRow = {
	/** the ramp's range and transition range, `_TrunkVertexAoStrength`, the ramp's intensity (0 without one) */
	shape: LookRow.canopy,
	/** `_TrunkRampColor`, linear */
	color: LookRow.canopyColor,
} as const;

/** a trunk's vertex AO and ramp (docs/game-data/materials.md#foliage) */
const trunkParams = (look: MaterialLook, trunk: TrunkInputs): void => {
	const ramp = trunk.ramp;
	look.flags |= LookFlags.Trunk;
	look.params.set(
		[ramp?.range ?? 0, ramp?.transition ?? 0, trunk.vertexAo, ramp?.intensity ?? 0],
		TrunkRow.shape,
	);
	look.params.set(ramp?.color ?? [0, 0, 0], TrunkRow.color);
};

/** `HGRP/Foliage/Leaf`'s inputs to the two-sided foliage lighting (`docs/game-data/materials.md#foliage`) */
const leafParams = (look: MaterialLook, leaf: LeafInputs): void => {
	const params = look.params;
	look.flags |= LookFlags.FoliageLeaf;
	params.set(
		[leaf.occlusionShadow, leaf.fakeShadow.strength, leaf.fakeShadow.power, leaf.diffuseUsesVertexNormal],
		LookRow.foliage,
	);
	params.set([...leaf.aoTransmission, ...leaf.aoSubsurface], LookRow.foliageAo);
	const canopy = leaf.canopy;
	params.set(
		[
			leaf.subsurface,
			leaf.transmissionDistanceFade,
			canopy?.intensity ?? 0,
			canopy?.startsAtTop === true ? 1 : 0,
		],
		LookRow.foliage2,
	);
	params.set(
		[canopy?.range ?? 0, canopy?.transition ?? 0, canopy?.brighterScale ?? 1, canopy?.cover ?? 0],
		LookRow.canopy,
	);
	params.set([...(canopy?.color ?? [1, 1, 1]), leaf.twoSidedNormal ? 1 : 0], LookRow.canopyColor);
	const blend = leaf.blend;
	if (blend !== null) {
		params.set([...blend.color, blend.strength], LeafBlendRow.color);
		params.set([blend.normalAdd, blend.normalPower, blend.withVertexNormal, 1], LeafBlendRow.shape);
	}
};

/**
 * where `_BLEND_COLOR` keeps its inputs: the tri-channel mask's rows, which leaves don't use.
 * surfaces/common.ts blends when the last value of {@link LeafBlendRow.shape} is set
 */
export const LeafBlendRow = {
	/** `_BlendColor`: linear colour, alpha */
	color: LookRow.maskAlbedo,
	/** `_BlendNormalAdd`, `_BlendNormalPower`, `_BlendWithVertexNormal`, 1 with `_BLEND_COLOR` */
	shape: LookRow.maskAlbedo + 4,
} as const;

/**
 * `HGRP/Foliage/Grass` and its card LOD: their inputs to the two-sided foliage lighting, the bent normal and
 * the lean away from the camera (`docs/game-data/materials.md#foliage`), in the leaf rows. zeros leave a row
 * neutral
 */
const grassParams = (look: MaterialLook, grass: GrassInputs): void => {
	const params = look.params;
	params.set(
		[grass.bendNormalUpward, grass.cameraLean, grass.maskOnDiffuse, grass.maskOnTransmission],
		LookRow.foliage,
	);
	params.set([...grass.ao, grass.twoSidedNormal ? 1 : 0], LookRow.foliageAo);
	params.set([grass.subsurface, ...grass.sunMask], LookRow.foliage2);
};

// #endregion

// #region parallax glow and layers

/**
 * where `_PARALLAX_MAP_WORLDSPACE`'s world-space mask keeps its inputs: five rows in the tail mesh looks
 * leave free (`effect_only[1..5]` in surfaces/common.ts), after `GAPS_FLOAT`. surfaces/common.ts enters the
 * world-space branch when the last float of {@link additionalColor} is set, reading `_ParallaxMaskMap` from
 * {@link Slot.Mask}
 */
export const ParallaxWorldRow = {
	/** centre X and Z (`_MaskWorldPosParams.xz`), `1 / scale`, `_ParallaxLerpSchedule` */
	worldParams: 148,
	/** rotation cosine and sine, `_ParallaxIntensity`, `_ParallaxSignLerpFactor1.w` */
	rotation: 152,
	/** `_ParallaxPatternColor` × strength, `_ParallaxSignLerpFactor1.y` */
	patternColor: 156,
	/** `_ParallaxPatternColorDark` × strength, `_WorldParallaxAdditionalLightMaskChannel` */
	patternDark: 160,
	/** `_WorldParallaxAdditionalColor`, 1 when world-space parallax is active */
	additionalColor: 164,
} as const;

/** `_PARALLAX_MAP`'s glow (`docs/game-data/materials.md#lit-layers`), in the parallax slots and rows */
const parallaxParams = (look: MaterialLook, glow: ParallaxGlow): void => {
	const params = look.params;
	// without a noise map the noise flag stays clear, and the march reads height 0
	setTexture(look, Slot.Parallax, glow.pattern);
	if (glow.noise !== null) {
		setTexture(look, Slot.ParallaxNoise, glow.noise);
	}
	// the pulse runs between the minimum brightness and 1
	const minimum = glow.pulseMinimum;
	params.set([glow.depth, glow.steps, glow.fresnelPower, (1 - minimum) / 2], LookRow.parallax);
	params.set(
		[glow.pulseRate, glow.pulsePhasePerMetre, glow.ignorePostExposure, (1 + minimum) / 2],
		LookRow.parallax2,
	);
	params.set([...glow.bright, glow.maskChannel], LookRow.parallaxColor);
	params.set(glow.dark, LookRow.parallaxDark);
	// the brightening near the player, whom the viewer places at the camera
	params.set([glow.near.outer, glow.near.inner, glow.near.strength], LookRow.parallaxBright);

	const { worldMask } = glow;
	if (worldMask !== null) {
		if (worldMask.mask !== null) {
			setTexture(look, Slot.OverlayMask, worldMask.mask);
		}
		params.set(
			[worldMask.center[0], worldMask.center[1], 1 / worldMask.scale, worldMask.lerpSchedule],
			ParallaxWorldRow.worldParams,
		);
		params.set(
			[worldMask.rotation[0], worldMask.rotation[1], worldMask.intensity, worldMask.worldYCut],
			ParallaxWorldRow.rotation,
		);
		params.set([...worldMask.patternColor, worldMask.objectYCut], ParallaxWorldRow.patternColor);
		params.set(
			[...worldMask.patternColorDark, worldMask.additionalMaskChannel],
			ParallaxWorldRow.patternDark,
		);
		params.set([...worldMask.additionalColor, 1], ParallaxWorldRow.additionalColor);
	}
};

/**
 * where `HGRP/Foliage/Glow`'s flowing glow keeps its inputs: the parallax rows the pulse leaves alone.
 * surfaces/common.ts draws it on a look with {@link LookFlags.ParallaxNoiseMap} and none of the other users of
 * the parallax slots ({@link LookFlags.ParallaxMap}, {@link LookFlags.LayerBlend},
 * {@link LookFlags.VertexOffset})
 */
export const FlowGlowRow = {
	/** `_DistortionColor` (HDR rgb), the luminance base */
	color: LookRow.parallaxColor,
	/** the two noise scales, then the two speeds */
	flow: LookRow.parallaxDark,
	/** the warp, multiplier, bias and how much the vertex colour's red weighs the glow */
	shape: LookRow.parallaxBright,
} as const;

/** `_DISTORTION_FLOW`'s flowing glow (docs/game-data/materials.md#glowing-foliage) */
const flowGlowParams = (look: MaterialLook, glow: FlowGlow): void => {
	setTexture(look, Slot.ParallaxNoise, glow.noise);
	look.params.set([...glow.color, glow.luminanceBase], FlowGlowRow.color);
	look.params.set([...glow.scales, ...glow.speeds], FlowGlowRow.flow);
	look.params.set([glow.warp, glow.multiplier, glow.bias, glow.vertexRed], FlowGlowRow.shape);
};

/** what decides how much a layer covers ({@link LayerBlendRow.height}'s last float) */
export const LayerSource = {
	/** `_LAYERBLEND_TOP`: how far the surface faces up */
	Top: 0,
	/** `_LAYERBLEND_MASK` with `_LayerBlendMaskType` 0: `_LayerBlendMaskMap`'s R, in the emissive slot */
	MaskMap: 1,
	/** `_LayerBlendMaskType` 1: the layer bump map's alpha */
	LayerBumpAlpha: 2,
	/** `_LayerBlendMaskType` 2: the base colour's alpha */
	BaseAlpha: 3,
	/** `_LayerBlendMaskType` 3: the normal map's alpha */
	NormalAlpha: 4,
	/** `_LayerBlendMaskType` 4: everywhere */
	Full: 5,
} as const;

type LayerSource = (typeof LayerSource)[keyof typeof LayerSource];

/** each {@link LayerCoverage}'s {@link LayerSource} */
const LAYER_SOURCES: Record<LayerCoverage['kind'], LayerSource> = {
	top: LayerSource.Top,
	maskMap: LayerSource.MaskMap,
	layerBumpAlpha: LayerSource.LayerBumpAlpha,
	baseAlpha: LayerSource.BaseAlpha,
	normalAlpha: LayerSource.NormalAlpha,
	full: LayerSource.Full,
};

/** {@link LayerBlendRow.coverage}'s last float by {@link LitLayer.uvType} */
const LAYER_UV_TYPES: Record<LitLayer['uvType'], number> = { uv0: 0, worldXZ: 1, uv2: 2 };

/** float offsets of a layer's parameters ({@link layerBlendParams}), which reuse the parallax and leaf rows */
export const LayerBlendRow = {
	/**
	 * how much the bumped normal decides top coverage (`_TopBlendWithBumpMap`), `_TopBlendThreshold`,
	 * `_TopBlendSmoothness`, the layer's coordinates (`_LayerBlendUVType`: 0 UV set 0, 1 world XZ, 2 UV set 2)
	 */
	coverage: LookRow.parallax,
	/**
	 * 1 for the height blend (`_LayerBlendHeight`), `_LayerBlendHeightTransition`, the base's height, the
	 * coverage source ({@link LayerSource})
	 */
	height: LookRow.parallax2,
	/** linear `_Layer1TintColor` times `_Layer1ColorBrighterScale`, how much colour the layer keeps */
	color: LookRow.parallaxColor,
	/**
	 * `_Layer1BaseColorBlendMode` (0 replace, 1 add), its additive intensity, 1 when metallic is the layer's
	 * alpha (`_LayerMetallicType`), `_Layer1Metallic`
	 */
	blend: LookRow.parallaxDark,
	/**
	 * `_Layer1BumpScale`, `_Layer1BaseNormalIntensity`, `_Layer1AOStrength`, 1 when the occlusion doesn't come
	 * from the bump map (`_LayerAOType`)
	 */
	normal: LookRow.parallaxBright,
	/**
	 * `_LAYERBLEND_MOSS`: `_Layer1FuzzyCoreDarkness`, `…EdgeBrightness`, `…EdgeShadowRange`,
	 * `…EdgeShadowOffset`; neutral without the keyword
	 */
	fuzzy: LookRow.foliage,
	/** `_Layer1FuzzyEdgeShadowIntensity`, `…DarkPower`, `…BrightPower`, `…NormalStrength` */
	fuzzy2: LookRow.foliageAo,
} as const;

/**
 * `_LAYERBLEND_TOP` and `_LAYERBLEND_MASK`, with `_LAYERBLEND_MOSS`'s fuzzy shading
 * (`docs/game-data/materials.md#lit-layers`), in the parallax slots and rows. both maps sample one
 * coordinate, tiled and offset by the layer's own values; the mask map samples untiled in the emissive slot.
 * UV set 2 isn't loaded and reads as set 0, and `_BaseHeightMap` has no slot and reads as the shader's grey
 * default (0.5)
 */
const layerBlendParams = (look: MaterialLook, layer: LitLayer, source: LayerSource): void => {
	const params = look.params;
	look.flags |= LookFlags.LayerBlend;
	if (layer.coverage.kind === 'maskMap') {
		setTexture(look, Slot.OverlayMask, layer.coverage.map);
	}
	setTexture(look, Slot.Parallax, layer.base);
	setTexture(look, Slot.ParallaxNoise, layer.bump);
	params.set(
		[layer.top.bumped, layer.top.threshold, layer.top.smoothness, LAYER_UV_TYPES[layer.uvType]],
		LayerBlendRow.coverage,
	);
	params.set(
		[layer.heightTransition === null ? 0 : 1, layer.heightTransition ?? 1, 0.5, source],
		LayerBlendRow.height,
	);
	params.set([...layer.tint, layer.saturation], LayerBlendRow.color);
	params.set(
		[layer.colorBlendMode, layer.additiveIntensity, layer.metallicFromAlpha ? 1 : 0, layer.metallic],
		LayerBlendRow.blend,
	);
	params.set(
		[layer.bumpScale, layer.baseNormalIntensity, layer.aoStrength, layer.occlusionFromBump ? 0 : 1],
		LayerBlendRow.normal,
	);
	// neutral fuzz: no darkening, brightening or edge shadow, a unit range so the edge term stays finite
	let fuzzy = [0, 0, 1, 0];
	let fuzzy2 = [0, 1, 1, 0];
	const { moss } = layer;
	if (moss !== null) {
		fuzzy = [moss.coreDarkness, moss.edgeBrightness, moss.edgeShadowRange, moss.edgeShadowOffset];
		fuzzy2 = [moss.edgeShadowIntensity, moss.darkPower, moss.brightPower, moss.normalStrength];
	}
	params.set(fuzzy, LayerBlendRow.fuzzy);
	params.set(fuzzy2, LayerBlendRow.fuzzy2);
};

// #endregion
