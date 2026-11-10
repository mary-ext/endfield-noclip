import type { MaterialCull } from '@endfield-noclip/package-format/materials';
import type {
	GrassInputs,
	LayerCoverage,
	LeafInputs,
	LitEmission,
	LitLayer,
	LitSurface,
	LitSway,
	LitVertexOffset,
	ParallaxGlow,
} from '@endfield-noclip/package-format/surfaces';

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
 * the Lit model ({@link LitSurface}). slots are shared where materials rarely use both (`SLOTS`): the MRO
 * layout's map takes the tri-channel mask's slot, which therefore isn't drawn there, and a mask layer's mask
 * map the emissive map's, so mask layers on emissive-mapped materials aren't drawn. `_EMISSIVE_ANIM`'s pulse
 * keeps its inputs in the parallax rows, so it stays still on surfaces with a parallax glow or a layer. a
 * vertex offset's textures take the parallax slots, so it isn't drawn on those surfaces either, nor on ones
 * that aren't alpha-tested or that offset along the normal (docs/viewer/materials.md#vertex-offset)
 *
 * @param surface the surface
 * @param cull the faces the material culls
 * @returns a new look
 */
export const litLook = (surface: LitSurface, cull: MaterialCull): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = cull;
	const params = look.params;
	const { textures, emission } = surface;
	const triChannel = surface.layout === 'mro' ? null : surface.triChannel;
	if (textures.base !== null) {
		setTexture(look, Slot.Base, textures.base);
	}
	if (textures.normal !== null) {
		setTexture(look, Slot.Normal, textures.normal);
	}
	const mask = textures.mro ?? triChannel?.mask ?? null;
	if (mask !== null) {
		setTexture(look, Slot.Mask, mask);
	}
	if (textures.emissive !== null) {
		setTexture(look, Slot.Emissive, textures.emissive);
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
		look.queue = 'transparent';
		look.castsShadows = false;
		params[LookRow.emissive2 + 3] = surface.opacity;
		params[LookRow.detail2 + 2] = surface.blend === 'premultiplied' ? 1 : 0;
	} else if (surface.alphaClip !== null && surface.alphaClip >= 0 && alphaTextureOf(look) !== null) {
		look.queue = 'cutout';
	}
	params[LookRow.emissive + 3] = surface.tintCover;
	params.set(
		[surface.roughness[0], surface.roughness[1], surface.metallic, surface.normalScale],
		LookRow.surface,
	);
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
	}

	if (triChannel !== null) {
		look.flags |= LookFlags.TriChannelMask;
		triChannel.channels.forEach((channel, i) => {
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

	// the glow and the layer take the parallax rows, which the pulse has otherwise
	let parallaxRowsFree = true;
	const { overlay } = surface;
	switch (overlay?.kind) {
		case 'parallax': {
			parallaxParams(look, overlay);
			parallaxRowsFree = false;
			break;
		}
		case 'layer': {
			// a mask layer's mask map would take the emissive map's slot
			if (overlay.coverage.kind !== 'maskMap' || textures.emissive === null) {
				layerBlendParams(look, overlay, LAYER_SOURCES[overlay.coverage.kind]);
				parallaxRowsFree = false;
			}
			break;
		}
		default: {
			break;
		}
	}
	if (parallaxRowsFree && emission?.pulse != null) {
		emissivePulseParams(look, emission.pulse);
	}
	if (surface.keepsLitDecalsOff) {
		params[LookRow.detail2 + 3] = 1;
	}
	if (surface.sway !== null && surface.foliage === null) {
		swayParams(look, surface.sway);
	}
	// the offset's textures take the parallax slots, and only the alpha-tested depth and shadow passes read
	// the UV sets and textures it needs; their vertex stages don't read the normal
	const { vertexOffset } = surface;
	if (
		vertexOffset !== null &&
		vertexOffset.space !== 'normal' &&
		surface.foliage === null &&
		parallaxRowsFree &&
		look.queue === 'cutout'
	) {
		vertexOffsetParams(look, vertexOffset);
	}
	return look;
};

// #region vertex animation and pulse

/**
 * where `_SIMPLE_VERTEXANIM_CLOTH`'s sway keeps its inputs: rows only leaves and grass use otherwise.
 * mesh.wgsl sways a vertex of a look that isn't foliage, erosion, unlit or an effect when the frequency or
 * intensity is non-zero and the geometry's position W (the sway weight) is
 */
export const SwayRow = {
	/** `_SimpleVertexAnimationWindIntensity`, `_SimpleVertexAnimationWindFreq`, the soft factor, `_Kite` */
	sway: LookRow.foliage2,
	/** `_DirectionTendency`, 1 for the material's own direction (0: the wind's), that direction's X and Z */
	direction: LookRow.canopyColor,
} as const;

/** `_SIMPLE_VERTEXANIM_CLOTH`'s sway in the wind (docs/game-data/materials.md#swaying-cloth) */
const swayParams = (look: MaterialLook, sway: LitSway): void => {
	look.params.set([sway.intensity, sway.frequency, sway.softness, sway.kite], SwayRow.sway);
	look.params.set(
		[sway.tendency, sway.direction === null ? 0 : 1, ...(sway.direction ?? [0, 0])],
		SwayRow.direction,
	);
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
 * where `_EMISSIVE_ANIM`'s pulse keeps its inputs. a look without parallax or layer maps leaves their rows
 * free; mesh.wgsl pulses emission when the interval is positive
 */
export const EmissivePulseRow = {
	/** pulse cycles per second, phase offset (`_EmissiveAnimRandom`), interval, minimum brightness */
	pulse: LookRow.parallax,
	/** how much the pulse dims the emission (`_EmissiveColor.a`) */
	strength: LookRow.parallax2,
} as const;

/** `_EMISSIVE_ANIM`'s pulse (docs/game-data/materials.md#emission) */
const emissivePulseParams = (look: MaterialLook, pulse: NonNullable<LitEmission['pulse']>): void => {
	look.params.set([pulse.rate, pulse.phase, pulse.interval, pulse.minimum], EmissivePulseRow.pulse);
	look.params[EmissivePulseRow.strength] = pulse.depth;
};

// #endregion

// #region foliage

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
	params.set(canopy?.color ?? [1, 1, 1], LookRow.canopyColor);
	const blend = leaf.blend;
	if (blend !== null) {
		params.set([...blend.color, blend.strength], LeafBlendRow.color);
		params.set([blend.normalAdd, blend.normalPower, blend.withVertexNormal, 1], LeafBlendRow.shape);
	}
};

/**
 * where `_BLEND_COLOR` keeps its inputs: the tri-channel mask's rows, which leaves don't use. mesh.wgsl
 * blends when the last value of {@link LeafBlendRow.shape} is set
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
		setTexture(look, Slot.Emissive, layer.coverage.map);
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
