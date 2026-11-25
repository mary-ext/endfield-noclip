/**
 * the looks besides Lit that draw through the mesh shader's surface path: erosion rock, VFXDitherAlpha's
 * dithered surfaces and matte paintings
 *
 * @module
 */

import type { MaterialCull, TextureSlot } from '@endfield-noclip/package-format/materials';
import type {
	DitheredSurface,
	ErosionDynamicSurface,
	ErosionSurface,
	MattePaintingSurface,
	SludgeSurface,
} from '@endfield-noclip/package-format/surfaces';
import type { Rgb } from '@endfield-noclip/package-format/values';

import { emptyLook, LookFlags, LookRow, type MaterialLook, placeTexture, setTexture, Slot } from './look.ts';

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

/**
 * float offsets of an {@link erosionDynamicLook}'s parameters (`HGRP/ErosionDynamic`). distinguished from
 * {@link erosionLook} by `mode[3] === 1` (`look.emissive2.w`)
 */
export const ErosionDynamicRow = {
	/** HDR `_BaseColor`, no alpha test */
	base: LookRow.tint,
	/** `_Roughness`, `_DetailRoughnessCover`, `_Metallic`, `_NormalScale` */
	surface: LookRow.surface,
	/** `_OcclusionStrength`, f0 (0.04), `_MetallicOffset`, `_DetailNormalScale` */
	surface2: LookRow.surface2,
	/** `_NoiseEmissiveStrength`, `_FlowColorStrength`, detail normal scroll per second, `_DistanceBlend` */
	strengths: LookRow.emissive,
	/** `_NoiseColorMode`, `_FlowRoughnessOffset`, `_MatcapNormalAreaOffset`, 1 (dynamic discriminant) */
	mode: LookRow.emissive2,
	/** `_NoisePatternTintColor`, `_NoiseMin` */
	noise: LookRow.maskAlbedo,
	/** `_NoiseStrength`, `_MatcapNormalTilling * 0.01`, `_MatcapNormalStrength`, `_FlowColorOffset` */
	noise2: LookRow.maskAlbedo + 4,
	/** `_FlowTopColor`, `_FlowRoughness` */
	flowTop: LookRow.maskRoughness,
	/** `_FlowBottomColor` */
	flowBottom: LookRow.maskMetallic,
	/** `_FlowNormalTilling`, `_FlowNoiseStrength`, ramp scroll per second, `_FlowSpeedOffset` */
	flow: LookRow.maskScale,
	/** `_RippleConfig0` (object-space xyz, radius w) */
	ripple0: LookRow.detail,
	/** `_RippleConfig1` */
	ripple1: LookRow.detail2,
	/** `_RippleConfig2` */
	ripple2: LookRow.detailOverlay,
	/** `_RippleTopColor`, `_RippleWidth` */
	rippleTop: LookRow.parallax,
	/** `_RippleBottomColor`, `_RingRatio` */
	rippleBottom: LookRow.parallax2,
	/** ripple speed per second, `_RippleNoiseStrength`, `_RippleColorOffset`, 0 */
	rippleParams: LookRow.parallaxColor,
} as const;

/**
 * clearable blight patches ({@link ErosionDynamicSurface}). its seven fragment maps fill `SLOTS`: the colour
 * LUT in base, base normal in normal, metal mix in mask, flow ramp in emissive, detail normal in detail,
 * noise pattern in parallax, and matcap normal in parallax noise
 *
 * @param surface the surface
 * @param cull the faces the material culls
 * @returns a new look
 */
export const erosionDynamicLook = (surface: ErosionDynamicSurface, cull: MaterialCull): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = cull;
	look.flags |= LookFlags.Erosion;
	const params = look.params;
	const { textures, noise, flow, matcap, ripple } = surface;
	const slots: [number, TextureSlot | null][] = [
		[Slot.Base, textures.colorLut],
		[Slot.Normal, textures.baseNormal],
		[Slot.Mask, textures.metalMix],
		[Slot.Emissive, textures.flowRamp],
		[Slot.Detail, textures.detailNormal],
		[Slot.Parallax, textures.noisePattern],
		[Slot.ParallaxNoise, textures.matcapNormal],
	];
	for (const [i, slot] of slots) {
		if (slot !== null) {
			setTexture(look, i, slot);
		}
	}
	// 1D LUTs stream at mip 0 regardless of screen size
	if (textures.colorLut !== null) {
		look.uvScales[Slot.Base] = 0;
	}
	if (textures.flowRamp !== null) {
		look.uvScales[Slot.Emissive] = 0;
	}
	params.set([...surface.baseColor, -1], ErosionDynamicRow.base);
	params.set(
		[surface.roughness, surface.detailRoughnessCover, surface.metallic, surface.normalScale],
		ErosionDynamicRow.surface,
	);
	params.set(
		[surface.occlusionStrength, 0.04, surface.metallicOffset, surface.detailNormalScale],
		ErosionDynamicRow.surface2,
	);
	params.set(
		[noise.emissiveStrength, flow.colorStrength, surface.detailNormalScroll, noise.fadeDistance],
		ErosionDynamicRow.strengths,
	);
	params.set([noise.colorMode, flow.roughnessOffset, matcap.areaOffset, 1], ErosionDynamicRow.mode);
	params.set([...noise.tint, noise.min], ErosionDynamicRow.noise);
	params.set(
		[noise.depth, matcap.tiling * 0.01, matcap.strength, flow.colorOffset],
		ErosionDynamicRow.noise2,
	);
	params.set([...flow.top, flow.roughness], ErosionDynamicRow.flowTop);
	params.set(flow.bottom, ErosionDynamicRow.flowBottom);
	params.set([flow.tiling, flow.noiseStrength, flow.scroll, flow.speedOffset], ErosionDynamicRow.flow);
	params.set(ripple.configs[0], ErosionDynamicRow.ripple0);
	params.set(ripple.configs[1], ErosionDynamicRow.ripple1);
	params.set(ripple.configs[2], ErosionDynamicRow.ripple2);
	params.set([...ripple.top, ripple.width], ErosionDynamicRow.rippleTop);
	params.set([...ripple.bottom, ripple.ringRatio], ErosionDynamicRow.rippleBottom);
	params.set([ripple.speed, ripple.noiseStrength, ripple.colorOffset, 0], ErosionDynamicRow.rippleParams);
	return look;
};

/**
 * float offsets of a {@link sludgeLook}'s parameters (`HGRP/SludgeV2`). distinguished from {@link erosionLook}
 * (0) and {@link erosionDynamicLook} (1) by `mode[3] === 2` (`look.emissive2.w`)
 */
export const SludgeRow = {
	/** linear `_BaseColor`, no alpha test */
	base: LookRow.tint,
	/** `_RoughnessMin`, `_RoughnessMax`, `_Metallic`, `_OcclusionStrength` */
	surface: LookRow.surface,
	/** `_ColorAlbedoPercent`, `_ColorEmissivePercent`, `_VertNormalOffset`, `_MainTex3UseDisturb` */
	surface2: LookRow.surface2,
	/** linear `_EmissiveColor` */
	emissive: LookRow.emissive,
	/** `sludgeSize`, `sizeY`, 0, 2 (sludge discriminant) */
	mode: LookRow.emissive2,
	/** linear `_BaseColor2` */
	base2: LookRow.maskAlbedo,
	/** linear `_LineColor` (rgba) */
	lineColor: LookRow.maskAlbedo + 4,
	/** linear `_EdgeColor` (rgba) */
	edgeColor: LookRow.maskAlbedo + 8,
	/** `_LineRange`, `_LineRangeOut`, `_LineRangeIn`, `_EdgeRange` */
	ranges: LookRow.maskRoughness,
	/** `_EdgeAlpha` */
	edgeParams: LookRow.maskMetallic,
	/** unpacked clip plane 0 (`nx, ny, nz, d`; `0, 0, 0, 1` when disabled) */
	clip0: LookRow.maskScale,
	/** unpacked clip plane 1 (`nx, ny, nz, d`; `0, 0, 0, 1` when disabled) */
	clip1: LookRow.maskOffset,
	/** `_MainTexUVSpeed.xy`, `_MainTex2UVSpeed.xy` */
	speed01: LookRow.detail,
	/** `_MainTex3UVSpeed.xy`, `_LineTexUVSpeed.xy` */
	speed23: LookRow.detail2,
	/** `_EdgeTexUVSpeed.xy` */
	speed4: LookRow.detailOverlay,
	/** `_WaveIntensity` */
	waveIntensity: LookRow.parallax,
	/** `_WaveLength` */
	waveLength: LookRow.parallax2,
	/** `_WaveSpeed` */
	waveSpeed: LookRow.parallaxColor,
} as const;

const decodeHalf = (bits: number): number => {
	const sign = (bits & 0x8000) !== 0 ? -1 : 1;
	const exp = (bits >> 10) & 0x1f;
	const mant = bits & 0x3ff;
	if (exp === 0) {
		return sign * 2 ** -14 * (mant / 1024);
	}
	if (exp === 31) {
		return mant === 0 ? sign * Infinity : Number.NaN;
	}
	return sign * 2 ** (exp - 15) * (1 + mant / 1024);
};

/** decodes `FBDynamicSceneSludgeComp.EncodedClipPlane*` into a local-space plane `(nx, ny, nz, d)` */
const unpackSludgeClipPlane = (encoded: number): [number, number, number, number] => {
	if (((encoded >>> 19) & 1) !== 0) {
		return [0, 0, 0, 1];
	}
	const axis = (encoded >>> 16) & 3;
	const sign = ((encoded >>> 18) & 1) !== 0 ? -1 : 1;
	const raw = decodeHalf(encoded & 0xffff);
	const d = Number.isNaN(raw) ? 1000 : raw;
	return [axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0, d * sign];
};

/**
 * spray-clearable sludge ({@link SludgeSurface}). its five shading maps fill slots 0–4 and its per-patch
 * heightmap fills slot 6 (`ParallaxNoise`), drawn in the `cutout` queue so the depth and shadow passes bind
 * the heightmap and UVs for vertex displacement
 *
 * @param surface the surface
 * @param cull the faces the material culls
 * @returns a new look
 */
export const sludgeLook = (surface: SludgeSurface, cull: MaterialCull): MaterialLook => {
	const look = emptyLook({ drawn: true });
	look.cull = cull;
	look.queue = 'cutout';
	look.flags |= LookFlags.Erosion;
	const params = look.params;
	const { textures, speeds, wave } = surface;
	const slots: [number, TextureSlot | null][] = [
		[Slot.Base, textures.main],
		[Slot.Normal, textures.main2],
		[Slot.Mask, textures.main3],
		[Slot.Emissive, textures.line],
		[Slot.Detail, textures.edge],
		[Slot.ParallaxNoise, textures.heightmap],
	];
	for (const [i, slot] of slots) {
		if (slot !== null) {
			setTexture(look, i, slot);
		}
	}
	// the 64×64 heightmap streams at mip 0 regardless of screen size
	if (textures.heightmap !== null) {
		look.uvScales[Slot.ParallaxNoise] = 0;
	}
	params.set([...surface.baseColor, -1], SludgeRow.base);
	params.set(
		[surface.roughnessMin, surface.roughnessMax, surface.metallic, surface.occlusionStrength],
		SludgeRow.surface,
	);
	params.set(
		[
			surface.colorAlbedoPercent,
			surface.colorEmissivePercent,
			surface.vertNormalOffset,
			surface.main3UseDisturb,
		],
		SludgeRow.surface2,
	);
	params.set([...surface.emissiveColor, 0], SludgeRow.emissive);
	params.set([surface.sludgeSize, surface.sizeY, 0, 2], SludgeRow.mode);
	params.set([...surface.baseColor2, 0], SludgeRow.base2);
	params.set(surface.lineColor, SludgeRow.lineColor);
	params.set(surface.edgeColor, SludgeRow.edgeColor);
	params.set(
		[surface.lineRange, surface.lineRangeOut, surface.lineRangeIn, surface.edgeRange],
		SludgeRow.ranges,
	);
	params.set([surface.edgeAlpha, 0, 0, 0], SludgeRow.edgeParams);
	params.set(unpackSludgeClipPlane(surface.clipPlane0), SludgeRow.clip0);
	params.set(unpackSludgeClipPlane(surface.clipPlane1), SludgeRow.clip1);
	params.set([...speeds.main, ...speeds.main2], SludgeRow.speed01);
	params.set([...speeds.main3, ...speeds.line], SludgeRow.speed23);
	params.set([...speeds.edge, 0, 0], SludgeRow.speed4);
	params.set(wave.intensity, SludgeRow.waveIntensity);
	params.set(wave.length, SludgeRow.waveLength);
	params.set(wave.speed, SludgeRow.waveSpeed);
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
	 * the alpha scale (`_TintColor.a · _TintColorAlpha`), `_DitherAlphaExp`, `_DitherTilling`, then
	 * {@link DitherFlags}
	 */
	dither: LookRow.canopy,
	/** the near camera fade's start, end, second start and second end in metres; zeros without it */
	near: LookRow.canopyColor,
	/**
	 * `_SUBSURFACE`: the scattered colour times its amount, then the amount (the colour's value times the
	 * metallic); zero without it
	 */
	subsurface: LookRow.foliage,
	/** the scattered colour's share of the ambient light (`_SubsurfaceIndirect`), 0, 0, 0 */
	subsurfaceIndirect: LookRow.foliageAo,
} as const;

/** the bits of {@link DitherRow.dither}'s last float, matching `fs_cutout_depth` in surfaces/common.ts */
export const DitherFlags = {
	/** the alpha is the red of the texture (`_UseMainTexAsAlpha`) rather than its alpha */
	RedAlpha: 1,
	/** the vertex colour multiplies the colour, and its alpha the tested alpha */
	VertexColor: 2,
	/** the texture in {@link Slot.ParallaxNoise} scales the alpha (`_USE_MASK`) */
	Mask: 4,
	/** by its red (`_UseMaskTexAsAlpha`) rather than its alpha */
	MaskRed: 8,
	/** set on every dithered look, so the shading can tell its row from an empty one */
	Surface: 16,
	/** the colour is times the alpha before the mask and the power (`colorTimesAlpha`) */
	AlphaColor: 32,
} as const;

/** a hue (0–1) as a fully saturated colour */
const hueRgb = (hue: number): Rgb => {
	const channel = (shift: number): number => {
		const turn = (((hue + shift) % 1) + 1) % 1;
		return Math.min(Math.max(Math.abs(turn * 6 - 3) - 1, 0), 1);
	};
	return [channel(0), channel(2 / 3), channel(1 / 3)];
};

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
	// read by the shading too, so set with or without the test
	let flags = DitherFlags.Surface | (surface.vertexColor ? DitherFlags.VertexColor : 0);
	if (dither !== null) {
		// a tested texture that isn't the base map (the main texture's red as the alpha alone, or a lone mask)
		// can't colour the surface: an unlit look tests it through the normal slot, and a lit one, which may need
		// that slot for its normal map, through the base slot, its albedo taken from the tint alone (below)
		if (surface.baseMap === null && surface.lighting === null) {
			setTexture(look, Slot.Normal, dither.texture);
			look.flags |= LookFlags.AlphaNormal;
		} else if (surface.baseMap === null) {
			setTexture(look, Slot.Base, dither.texture);
		}
		flags |=
			(dither.redAlpha ? DitherFlags.RedAlpha : 0) | (dither.colorTimesAlpha ? DitherFlags.AlphaColor : 0);
		if (dither.mask !== null) {
			// only the depth pass samples the mask, so it takes a slot the surface's shading leaves alone, without
			// the slot's flag: unloaded, the slot binds white and the test runs unmasked
			placeTexture(look, Slot.ParallaxNoise, dither.mask.texture);
			flags |= DitherFlags.Mask | (dither.mask.redAlpha ? DitherFlags.MaskRed : 0);
		}
		params.set([dither.alphaScale, dither.exponent, dither.tiling, flags], DitherRow.dither);
		if (dither.near !== null) {
			params.set(dither.near, DitherRow.near);
		}
		look.queue = 'cutout';
	} else {
		params[DitherRow.dither + 3] = flags;
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
	// untextured, the tint is the albedo. the shader saturates it as the G-buffer does, after the vertex colour
	const untextured = surface.baseMap === null;
	params.set([...color, -1], LookRow.tint);
	const { subsurface } = lighting;
	// the game's subsurface lighting has no metals: the metallic scales the scattering instead
	const metallic = subsurface === null ? lighting.metallic : 0;
	params.set([lighting.roughness, lighting.roughness, metallic, lighting.normalScale], LookRow.surface);
	if (subsurface !== null) {
		const [hue, saturation, value, indirect] = subsurface;
		const amount = value * lighting.metallic;
		const scattered = hueRgb(hue).map((c) => (1 + (c - 1) * saturation) * amount);
		params.set([...scattered, amount], DitherRow.subsurface);
		params[DitherRow.subsurfaceIndirect] = indirect;
	}
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
