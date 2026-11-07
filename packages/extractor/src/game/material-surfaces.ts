/**
 * surface describers for the shaders the viewer shades as surfaces: what each draws, from its properties and
 * keywords (`docs/game-data/materials.md`).
 */

import type { TextureSlot } from '@endfield-noclip/package-format/materials';
import type {
	DitheredSurface,
	ErosionSurface,
	GrassInputs,
	LayerCoverage,
	LeafInputs,
	LitDetail,
	LitEmission,
	LitLayer,
	LitSurface,
	LitSway,
	MaskChannel,
	MattePaintingSurface,
	ParallaxGlow,
	UnsupportedSurface,
} from '@endfield-noclip/package-format/surfaces';
import type { Rgb } from '@endfield-noclip/package-format/values';

import {
	linearRgb,
	type MaterialReader,
	scaleRgb,
	type ShaderFamily,
	unsupported,
} from './material-values.ts';

// #region keywords

/** keywords every surface reads: the alpha test and both emission sources */
const SURFACE_KEYWORDS = ['_ALPHATEST_ON', '_EMISSIVE_MAP', '_EMISSIVE_MASK'];

/** Lit's own layers, which `HGRP/LitEffect` shares */
const LIT_KEYWORDS = [
	...SURFACE_KEYWORDS,
	'_TWO_BASEMAP',
	'_EMISSIVE_ANIM',
	'_TRI_CHANNEL_MASK',
	// only the R channel blends (docs/status.md)
	'_TRI_CHANNEL_MASK_SWITCH_TEXTURE',
	'_TRI_CHANNEL_MASK_SWITCH_TEXTURE_GWITHNORMAL',
	'_DETAIL_MAP',
	'_PARALLAX_MAP',
	'_LAYERBLEND_TOP',
	'_LAYERBLEND_MASK',
	'_LAYERBLEND_MOSS',
];

/** the keywords the describers below read, by surface shader */
const DRAWN_KEYWORDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
	Object.entries({
		// only `HGRP/Lit`'s sway is decoded
		'HGRP/Lit': [...LIT_KEYWORDS, '_SIMPLE_VERTEXANIM', '_SIMPLE_VERTEXANIM_CLOTH'],
		'HGRP/LitEffect': LIT_KEYWORDS,
		'HGRP/LitTransparent': [...SURFACE_KEYWORDS, '_TWO_BASEMAP'],
		// its own cubemap reflection (`_CUSTOM_IBL`) isn't drawn: the viewer lights Lit surfaces deferred
		'HGRP/LitForward': [...SURFACE_KEYWORDS, '_TWO_BASEMAP'],
		'HGRP/Foliage/Trunk': [...SURFACE_KEYWORDS, '_TWO_BASEMAP'],
		'HGRP/Foliage/Leaf': [...SURFACE_KEYWORDS, '_NORMAL_MAP', '_CANOPY_COLOR_RAMP'],
		'HGRP/Foliage/Grass': [...SURFACE_KEYWORDS, '_NORMAL_MAP', '_USE_CAMERA_BASED_TILLING'],
		'HGRP/Foliage/Grass Cardmesh Lod': [...SURFACE_KEYWORDS, '_NORMAL_MAP', '_USE_CAMERA_BASED_TILLING'],
		// the tree card LOD's own inputs aren't decoded
		'HGRP/Foliage/TreeFoliageCardMeshLod': [...SURFACE_KEYWORDS, '_NORMAL_MAP'],
		'HGRP/LitHLOD': SURFACE_KEYWORDS,
		'HGRP/MattePainting': SURFACE_KEYWORDS,
		'HGRP/Erosion': SURFACE_KEYWORDS,
	}).map(([shader, keywords]) => [shader, new Set(keywords)]),
);

/**
 * a surface shader's keywords these describers don't read, which the surface is drawn without; for the pack's
 * debug index. effect describers mark materials with keywords they don't draw unsupported instead
 *
 * @param shader a material's shader name
 * @param keywords its enabled keywords
 * @returns the keywords not drawn; empty for effect shaders
 */
export const keywordsNotDrawn = (shader: string, keywords: readonly string[]): string[] => {
	const drawn = DRAWN_KEYWORDS.get(shader);
	return drawn === undefined ? [] : keywords.filter((keyword) => !drawn.has(keyword));
};

// #endregion

// #region lit

/** the families drawn by the Lit model */
export const LIT_FAMILIES: ReadonlySet<ShaderFamily> = new Set([
	'lit',
	'litEffect',
	'litTransparent',
	'litForward',
	'trunk',
	'leaf',
	'grass',
	'cardMesh',
	'hlod',
	'terrain',
]);

/** shaders whose G-buffer pass writes the material's `_StencilRef` into the stencil */
const STENCIL_REF_SHADERS = new Set([
	'HGRP/Lit',
	'HGRP/Foliage/Leaf',
	'HGRP/Foliage/Grass',
	'HGRP/Foliage/Trunk',
	'HGRP/Foliage/TreeFoliageCardMeshLod',
	'HGRP/Foliage/Grass Cardmesh Lod',
]);

/** the stencil bit `HGRP/DecalLit` draws only where clear */
const LIT_DECAL_STENCIL_BIT = 32;

const GRASS_CARD_SHADER = 'HGRP/Foliage/Grass Cardmesh Lod';

/** the tri-channel mask's properties per channel, R, G, B */
const MASK_CHANNELS = [
	{
		albedo: '_MaskAlbedoR',
		roughness: '_MaskRoghnessR',
		metallic: '_MaskMetallicR',
		scale: '_MaskRScale',
		offset: '_MaskROffset',
	},
	{
		albedo: '_MaskAlbedoG',
		roughness: '_MaskRoghnessG',
		metallic: '_MaskMetallicG',
		scale: '_MaskGScale',
		offset: '_MaskGOffset',
	},
	{
		albedo: '_MaskAlbedoB',
		roughness: '_MaskRoghnessB',
		metallic: '_MaskMetallicB',
		scale: '_MaskBScale',
		offset: '_MaskBOffset',
	},
] as const;

/** the leaf's reflectance, quantized to 3 bits as the GBuffer stores it, as F0 */
const reflectanceF0 = (reflectance: number): number =>
	0.08 * (0.5 + 0.75 * (Math.round(Math.min(Math.max(reflectance, 0), 1) * 7) / 7));

/**
 * the Lit model's shaders (`docs/game-data/materials.md`): the Lit families with their optional layers,
 * glass, HLODs and foliage
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported` for textures on UV sets the meshes don't carry
 */
export const describeLit = (reader: MaterialReader): LitSurface | UnsupportedSurface => {
	const { float, color, has, material, shader } = reader;
	const family = shader.family;
	// Lit's optional layers. LitEffect declares a subset of Lit's properties plus its dissolve and disturb
	// effects, which aren't drawn; trunks and glass share only the texture layout
	const lit = family === 'lit' || family === 'litEffect';
	const foliage = family === 'leaf' || family === 'grass' || family === 'cardMesh';
	const count = material.baseTextureMapCount;

	// the maps the material's layout and keywords sample; the geometry carries UV sets 0 and 1
	const used = new Map<string, TextureSlot>();
	const bound = (name: string, on = true): TextureSlot | null => {
		const slot = on ? reader.slot(name) : undefined;
		if (slot === undefined) {
			return null;
		}
		used.set(name, slot);
		return slot;
	};
	// HLOD normal maps aren't tangent-space maps the shader can read
	const base = bound('_BaseColorMap');
	const normal = bound('_NormalMap', family !== 'hlod');
	const mro = bound('_MROMap', count === 0);
	const emissiveMap = bound('_EmissiveMap', has('_EMISSIVE_MAP'));
	const triMask = bound('_MaskMap', lit && has('_TRI_CHANNEL_MASK'));
	const detailMap = bound('_DetailMap', lit && has('_DETAIL_MAP'));
	// a separate parallax mask texture (`_UseParallaxMask`) has no slot; such materials stay dark
	const parallax = lit && has('_PARALLAX_MAP') && float('_UseParallaxMask', 0) === 0;
	const pattern = bound('_ParallaxMap', parallax);
	const noise = bound('_ParallaxNoiseMap', parallax);
	for (const [name, slot] of used) {
		if (slot.uv > 1) {
			return unsupported(`${name} on UV set ${slot.uv}`);
		}
	}

	let layout: LitSurface['layout'] = 'plain';
	if (count === 0) {
		layout = 'mro';
	} else if (count !== null) {
		layout = 'twoBasemap';
	} else if (foliage) {
		layout = 'roughnessInB';
	}

	const tint = color('_BaseColor');
	const blend =
		material.blend === 'alphaBlend' || material.blend === 'premultiplied' ? material.blend : 'opaque';

	let emission: LitEmission | null = null;
	{
		const emissive = color('_EmissiveColor');
		const channel = float('_EmissiveMaskChannel', 0);
		let source: LitEmission['source'] | null = null;
		if (has('_EMISSIVE_MAP')) {
			source = emissiveMap === null ? null : 'map';
		} else if (has('_EMISSIVE_MASK') && channel > 0) {
			source = 'mask';
		}
		if (source !== null && emissive !== undefined) {
			// `_EMISSIVE_ANIM_SWEEP` lights each colour inside a band that sweeps up the object, by its alpha:
			// alpha 1 glows only in the band. the band isn't drawn, so this keeps each colour at its resting
			// value outside it (docs/game-data/materials.md#emission)
			const sweep = lit && has('_EMISSIVE_ANIM_SWEEP');
			const resting = (rgba: readonly [number, number, number, number], scale: number): Rgb =>
				scaleRgb(rgba, sweep ? scale * (1 - Math.min(Math.max(rgba[3], 0), 1)) : scale);
			// the map's G, B and A add colours of their own, scaled by `_EmissiveType` (0 leaves them out)
			let channels: LitEmission['channels'] = null;
			const type = float('_EmissiveType', 0);
			if (source === 'map' && type !== 0) {
				// HDR like `_EmissiveColor`: as stored
				const scaled = (name: string): Rgb => resting(color(name) ?? [0, 0, 0, 1], type);
				const added: [Rgb, Rgb, Rgb] = [
					scaled('_EmissiveColorG'),
					scaled('_EmissiveColorB'),
					scaled('_EmissiveColorA'),
				];
				if (added.some((rgb) => rgb.some((value) => value !== 0))) {
					channels = added;
				}
			}
			emission = {
				// HDR, authored linear: as stored
				color: resting(emissive, 1),
				source,
				maskChannel: channel,
				channels,
				albedoAffect: float('_AlbedoAffectEmissive', 1),
				ignorePostExposure: float('_IgnorePostExposure', 1),
				// `_EnableEmissiveAnimFlicker`'s noise isn't drawn: those emitters keep still
				pulse:
					lit && has('_EMISSIVE_ANIM') && float('_EnableEmissiveAnimFlicker', 0) <= 0.5
						? {
								// the phase is `_Time.x` (seconds / 20; docs/game-data/materials.md#clock) / 2π times the speed
								rate: float('_EmissiveAnimSpeed', 0) / (40 * Math.PI),
								phase: float('_EmissiveAnimRandom', 0),
								interval: float('_EmissiveAnimInterval', 1),
								minimum: float('_EmissiveMinBrightness', 0),
								depth: emissive[3],
							}
						: null,
			};
		}
	}

	let triChannel: LitSurface['triChannel'] = null;
	if (triMask !== null) {
		// the switch-texture variants take G and B from textures of their own, which have no slot: only R blends
		const switched = material.keywords.some((keyword) =>
			keyword.startsWith('_TRI_CHANNEL_MASK_SWITCH_TEXTURE'),
		);
		const channel = (i: number): MaskChannel => {
			const names = MASK_CHANNELS[i];
			const albedo = color(names.albedo) ?? [1, 1, 1, 0];
			return {
				albedo: linearRgb(albedo),
				strength: switched && i > 0 ? 0 : albedo[3],
				roughness: float(names.roughness, 1),
				metallic: float(names.metallic, 0),
				scale: float(names.scale, 0),
				offset: float(names.offset, 0),
			};
		};
		triChannel = { mask: triMask, channels: [channel(0), channel(1), channel(2)] };
	}

	let detail: LitDetail | null = null;
	if (detailMap !== null) {
		const overlay = color('_DetailOverlayColor') ?? [0, 0, 0, 0];
		detail = {
			texture: detailMap,
			mode: float('_DetailMode', 1),
			maskMode: float('_DetailMaskMode', 0),
			normalIntensity: float('_DetailNormalIntensity', 1),
			pbrIntensity: float('_DetailPBRIntensity', 0),
			fade: [float('_DetailFalloffStart', 0), float('_DetailFalloffEnd', 0)],
			brighterScale: float('_DetailBaseColorBrighterScale', 1),
			overlay: linearRgb(overlay),
			overlayCover: overlay[3],
		};
	}

	let overlay: LitSurface['overlay'] = null;
	// an empty noise slot reads as Unity's black default, which still glows (the originium crystals of
	// `M_interactive_campfire+1_003_02` and Dijiang's far crystal leave it empty). an empty pattern would glow in
	// the dark colour alone; none is seen
	if (pattern !== null) {
		overlay = parallaxGlowOf(reader, pattern, noise);
	} else if (lit && !parallax) {
		overlay = layerOf(reader);
	}

	let f0 = 0.08 * float('_Specular', 0.5);
	let transmission = foliage ? float('_Transmission', 0.2) : 0;
	let foliageInputs: LitSurface['foliage'] = null;
	if (family === 'leaf') {
		f0 = reflectanceF0(float('_Reflectance', 0));
		foliageInputs = leafInputsOf(reader);
	} else if (family === 'grass' || shader.name === GRASS_CARD_SHADER) {
		// both shaders write a reflectance of 4/7 and half the transmission
		f0 = reflectanceF0(4 / 7);
		transmission = 0.5 * float('_Transmission', 0.2);
		foliageInputs = grassInputsOf(reader, family === 'cardMesh');
	} else if (family === 'cardMesh') {
		foliageInputs = { kind: 'card' };
	}

	return {
		kind: 'lit',
		layout,
		metallicFromBaseAlpha: layout === 'twoBasemap' && count !== null && count < 1.5,
		textures: { base, normal, mro, emissive: emissiveMap },
		alphaClip: material.alphaClipThreshold,
		// `_AlphaMaskChannel` picks the alpha the Lit family tests: 0 the base colour's, 1 the normal map's
		alphaFromNormal: count !== null && float('_AlphaMaskChannel', 0) === 1,
		blend,
		opacity: tint?.[3] ?? 1,
		// the HLOD shader ignores the tint
		tint: tint === undefined || family === 'hlod' ? [1, 1, 1] : linearRgb(tint),
		// untextured: the tint alone
		tintCover: base === null ? 1 : float('_BaseColorTintCover', 0),
		brighterScale: float('_BaseColorBrighterScale', 1),
		roughness: [float('_RoughnessMin', 0), float('_RoughnessMax', 1)],
		metallic: float('_Metallic', 0),
		normalScale: float('_NormalScale', 1),
		occlusionStrength: float('_OcclusionStrength', 1),
		f0,
		transmission,
		emission,
		triChannel,
		detail,
		overlay,
		foliage: foliageInputs,
		sway: shader.name === 'HGRP/Lit' ? swayOf(reader) : null,
		keepsLitDecalsOff:
			STENCIL_REF_SHADERS.has(shader.name) && (float('_StencilRef', 0) & LIT_DECAL_STENCIL_BIT) !== 0,
	};
};

/**
 * `_SIMPLE_VERTEXANIM_CLOTH`'s sway (`docs/game-data/materials.md#swaying-cloth`). `_GPU_CLOTH` materials are
 * left still: their cloth simulation isn't decoded
 *
 * @param reader an `HGRP/Lit` material's properties
 * @returns its sway, or `null` when it keeps still
 */
export const swayOf = (reader: MaterialReader): LitSway | null => {
	const { float, has } = reader;
	const intensity = float('_SimpleVertexAnimationWindIntensity', 0);
	// the shader skips the sway when this sum is zero; the noise offset itself moves nothing in this variant
	const enabled = intensity + float('_NoiseOffsetIntensity', 0) !== 0;
	if (!has('_SIMPLE_VERTEXANIM') || !has('_SIMPLE_VERTEXANIM_CLOTH') || has('_GPU_CLOTH') || !enabled) {
		return null;
	}
	let direction: LitSway['direction'] = null;
	if (float('_Use_Custom_WindDir', 0) !== 0) {
		// the shader approximates cos and sin by their Taylor series; at authored angles they agree to 1e-3
		const angle = (float('_MainDirectionAngle', 0) * Math.PI) / 180;
		direction = [Math.cos(angle), Math.sin(angle)];
	}
	return {
		intensity,
		frequency: float('_SimpleVertexAnimationWindFreq', 1),
		softness: float('_SimpleVertexAnimationWindSoftFactor', 0),
		kite: float('_Kite', 0),
		tendency: float('_DirectionTendency', 0),
		direction,
	};
};

/**
 * @param slot a bound slot
 * @param tiling the scale of both UV axes, in place of the slot's `_ST`
 * @param uv the UV set it samples
 * @returns the slot tiled by its own scale
 */
const tiledSlot = (slot: TextureSlot, tiling: number, uv: number): TextureSlot => ({
	texture: slot.texture,
	uv,
	scale: [tiling, tiling],
	offset: [0, 0],
});

/** `_PARALLAX_MAP`'s glow (`docs/game-data/materials.md#lit-layers`) */
const parallaxGlowOf = (
	reader: MaterialReader,
	pattern: TextureSlot,
	noise: TextureSlot | null,
): ParallaxGlow => {
	const { float, color } = reader;
	// the step count is an integer uniform: the float property truncates
	const steps = Math.min(Math.max(Math.trunc(float('_ParallaxMarchNum', 3)), 1), 20);
	const intensity = float('_ParallaxIntensity', 1);
	return {
		kind: 'parallax',
		pattern: tiledSlot(pattern, float('_ParallaxTilling', 1), pattern.uv),
		// the noise follows the pattern's UV set
		noise: noise === null ? null : tiledSlot(noise, float('_ParallaxNoiseMapTilling', 1), pattern.uv),
		depth: float('_ParallaxStrength', 0),
		steps,
		fresnelPower: Math.floor(float('_ParallaxFresnelStrength', 1)),
		// 0.05 · speed per second (docs/game-data/materials.md#clock)
		pulseRate: 0.05 * float('_ParallaxAnimSpeed', 0),
		pulsePhasePerMetre: float('_ParallaxAnimRandom', 0),
		pulseMinimum: float('_ParallaxMinBrightness', 0),
		// HDR colours, as stored
		bright: scaleRgb(color('_ParallaxColor') ?? [0, 0, 0, 1], intensity),
		dark: scaleRgb(color('_ParallaxColorDark') ?? [0, 0, 0, 1], intensity),
		maskChannel: float('_ParallaxMaskChannel', 0),
		ignorePostExposure: float('_ParallaxIgnorePostExposure', 1),
		near: {
			outer: float('_ParallaxBrightOuterRadius', 20),
			inner: float('_ParallaxBrightInnerRadius', 10),
			strength: float('_ParallaxCharPos', 0) !== 0 ? float('_ParallaxBrightStrength', 1) : 0,
		},
	};
};

const LAYER_MASK_MAP = '_LayerBlendMaskMap';

/** `_LayerBlendUVType`'s coordinate, the property rounded: 1 the world's x and z, 2 and up UV set 2 */
const layerUvType = (type: number): LitLayer['uvType'] => {
	if (type > 0.5 && type < 1.5) {
		return 'worldXZ';
	}
	return type >= 1.5 ? 'uv2' : 'uv0';
};

/**
 * `_LAYERBLEND_TOP` and `_LAYERBLEND_MASK`, with `_LAYERBLEND_MOSS`
 * (`docs/game-data/materials.md#lit-layers`)
 *
 * @returns the layer, or `null` without one the viewer draws: the mask's noise and parallax variants aren't
 *   ported, and both layer maps must be bound
 */
const layerOf = (reader: MaterialReader): LitLayer | null => {
	const { float, color, vector, has } = reader;
	let coverage: LayerCoverage | null = null;
	if (has('_LAYERBLEND_TOP')) {
		coverage = { kind: 'top' };
	} else if (
		has('_LAYERBLEND_MASK') &&
		!has('_LAYERBLEND_NOISEBLEND') &&
		!has('_LAYERBLEND_MASK_PARALLAX_PBR')
	) {
		// the game rounds the type to the nearest of 1 to 4; anything under 0.5 samples the mask map
		const type = float('_LayerBlendMaskType', 0);
		if (type < 0.5) {
			const mask = reader.slot(LAYER_MASK_MAP);
			if (mask === undefined) {
				// without a texture the shader's default stands in
				coverage = reader.shader.textures[LAYER_MASK_MAP] === 'white' ? { kind: 'full' } : null;
			} else {
				// the mask map samples UV set 1 when `_LayerBlendMaskUVType` is 0, whatever the slot's own set
				coverage = {
					kind: 'maskMap',
					map: tiledSlot(mask, 1, float('_LayerBlendMaskUVType', 0) === 0 ? 1 : 0),
				};
			}
		} else {
			const kinds = ['layerBumpAlpha', 'baseAlpha', 'normalAlpha', 'full'] as const;
			coverage = { kind: kinds[Math.min(Math.max(Math.round(type), 1), 4) - 1] };
		}
	}
	const layerBase = reader.slot('_Layer1BaseMap');
	const layerBump = reader.slot('_Layer1BumpMap');
	if (coverage === null || layerBase === undefined || layerBump === undefined) {
		return null;
	}
	const offset = vector('_Layer1Offset') ?? [0, 0, 0, 0];
	const tiling = float('_Layer1Tilling', 1);
	const layered = (slot: TextureSlot): TextureSlot => ({
		...tiledSlot(slot, tiling, 0),
		offset: [offset[0], offset[1]],
	});
	const moss = has('_LAYERBLEND_MOSS');
	return {
		kind: 'layer',
		base: layered(layerBase),
		bump: layered(layerBump),
		uvType: layerUvType(float('_LayerBlendUVType', 0)),
		coverage,
		top: {
			bumped: float('_TopBlendWithBumpMap', 0),
			threshold: float('_TopBlendThreshold', 0.5),
			smoothness: Math.max(float('_TopBlendSmoothness', 0.5), 1.175_494e-38),
		},
		heightTransition: float('_LayerBlendHeight', 0) !== 0 ? float('_LayerBlendHeightTransition', 1) : null,
		tint: scaleRgb(
			linearRgb(color('_Layer1TintColor') ?? [1, 1, 1, 1]),
			float('_Layer1ColorBrighterScale', 1),
		),
		saturation: Math.min(Math.max(float('_Layer1Saturation', 0) + 1, 0), 1),
		colorBlendMode: float('_Layer1BaseColorBlendMode', 0),
		additiveIntensity: float('_Layer1BaseColorAdditiveIntensity', 1),
		metallicFromAlpha: float('_LayerMetallicType', 0) !== 0,
		metallic: float('_Layer1Metallic', 0),
		bumpScale: float('_Layer1BumpScale', 1),
		baseNormalIntensity: float('_Layer1BaseNormalIntensity', 0),
		occlusionFromBump: float('_LayerAOType', 0) === 0,
		aoStrength: float('_Layer1AOStrength', 1),
		moss: moss
			? {
					coreDarkness: float('_Layer1FuzzyCoreDarkness', 0),
					edgeBrightness: float('_Layer1FuzzyEdgeBrightness', 0),
					edgeShadowRange: float('_Layer1FuzzyEdgeShadowRange', 1),
					edgeShadowOffset: float('_Layer1FuzzyEdgeShadowOffset', 0),
					edgeShadowIntensity: float('_Layer1FuzzyEdgeShadowIntensity', 0),
					// the game floors both powers at 0.1
					darkPower: Math.max(float('_Layer1FuzzyDarkPower', 1), 0.1),
					brightPower: Math.max(float('_Layer1FuzzyBrightPower', 1), 0.1),
					normalStrength: float('_Layer1FuzzyNormalStrength', 0),
				}
			: null,
	};
};

/** `HGRP/Foliage/Leaf`'s inputs (`docs/game-data/materials.md#foliage`) */
const leafInputsOf = (reader: MaterialReader): LeafInputs => {
	const { float, color, has } = reader;
	return {
		kind: 'leaf',
		occlusionShadow: float('_OcclusionShadow', 0),
		fakeShadow: {
			strength: float('_FakeDirectionalShadowStrength', 0),
			power: float('_FakeDirectionalShadowPow', 1),
		},
		diffuseUsesVertexNormal: float('_DiffuseUseVertexNormal', 0),
		aoTransmission: [float('_AoAffectTransmissionStart', 0), float('_AoAffectTransmissionRange', 0.01)],
		aoSubsurface: [float('_AoAffectSubsurfaceStart', 0), float('_AoAffectSubsurfaceRange', 0.01)],
		subsurface: float('_SubsurfaceIntensity', 0),
		transmissionDistanceFade: float('_TransmissionDistanceFade', 0),
		canopy: has('_CANOPY_COLOR_RAMP')
			? {
					intensity: float('_CanopyRampIntensity', 0),
					startsAtTop: float('_CanopyRampStartAtTop', 0) > 0,
					range: float('_CanopyRampRange', 0),
					transition: float('_CanopyRampTransitionRange', 0),
					brighterScale: float('_CanopyRampColorBrighterScale', 1),
					cover: float('_CanopyRampColorCover', 0),
					color: linearRgb(color('_CanopyRampColor') ?? [1, 1, 1, 1]),
				}
			: null,
	};
};

/**
 * `HGRP/Foliage/Grass` and its card LOD's inputs (`docs/game-data/materials.md#foliage`). the card LOD
 * decodes its normal map its own way and masks by the normal map's B, so it takes neither the bend nor the
 * masks
 */
const grassInputsOf = (reader: MaterialReader, card: boolean): GrassInputs => {
	const { float, vector, has } = reader;
	// the ramps' floors are stored as strengths, so a missing vector stays neutral
	const ao = vector('_AoParams') ?? [0, 0, 1, 0];
	const dir = vector('_DirParams') ?? [0, 0, 1, 0];
	return {
		kind: 'grass',
		bendNormalUpward: card ? 0 : float('_BendNormalUpward', 0),
		cameraLean: has('_USE_CAMERA_BASED_TILLING') ? float('_CameraBasedTillingIntensity', 0) : 0,
		maskOnDiffuse: card ? 0 : float('_MaskOnDiffuse', 0),
		maskOnTransmission: card ? 0 : float('_MaskOnTransmission', 0),
		twoSidedNormal: !card && float('_TwoSidedNormal', 0) > 0,
		subsurface: float('_SubsurfaceIntensity', 0),
		ao: [ao[0], ao[1], 1 - ao[2]],
		sunMask: [dir[0], dir[1], 1 - dir[2]],
	};
};

// #endregion

// #region matte paintings

/**
 * `HGRP/MattePainting` (`docs/game-data/materials.md#matte-paintings`)
 *
 * @param reader the material's properties
 * @returns its surface
 */
export const describeMattePainting = (reader: MaterialReader): MattePaintingSurface => {
	const { float, color, material } = reader;
	const slot = reader.slot('_MainTex');
	const tint = color('_TintColor') ?? [1, 1, 1, 1];
	const intensity = float('_TintColorIntensity', 1);
	// the alpha test on the texture's alpha alone: saturate(a · scale) < clip ⇔ a < clip / scale while clip ≤ 1;
	// past 1 everything is discarded
	let alphaClip: number | null = null;
	const clip = material.alphaClipThreshold;
	if (clip !== null && clip > 0) {
		const scale = tint[3] * float('_TintColorAlpha', 1);
		alphaClip = clip > 1 || scale <= 0 ? 2 : clip / scale;
	}
	return {
		kind: 'mattePainting',
		texture: slot !== undefined && slot.uv === 0 ? slot : null,
		color: scaleRgb(linearRgb(tint), intensity),
		alphaClip,
		highlight: { threshold: float('_ExpThreshold', 1), intensity: float('_ExpIntensity', 0) },
		ignorePostExposure: float('_IgnorePostExposure', 1),
	};
};

// #endregion

// #region dithered effects

/** keywords a `HGRP/Effect/VFXDitherAlpha` material can have and still be drawn as a dithered surface */
const DITHERED_KEYWORDS = new Set(['_NORMAL_MAP', '_USE_MAIN2']);

/**
 * `HGRP/Effect/VFXDitherAlpha` and its variants as an opaque G-buffer surface
 * (`docs/game-data/effects.md#solid-effects`)
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported` with keywords or texture combinations the viewer doesn't draw
 */
export const describeDithered = (reader: MaterialReader): DitheredSurface | UnsupportedSurface => {
	const { float, color, has, material } = reader;
	const unknown = material.keywords.filter((keyword) => !DITHERED_KEYWORDS.has(keyword));
	if (unknown.length > 0) {
		return unsupported(`keywords ${unknown.join(', ')}`);
	}
	let second: Rgb = [1, 1, 1];
	if (has('_USE_MAIN2')) {
		if (float('_UseMainTex2AsAlpha', 0) === 0 || float('_MainTex2BlendMode', 0) !== 0) {
			return unsupported('a second texture that colours or blends rather than masks');
		}
		second = linearRgb(color('_MainTex2Color') ?? [1, 1, 1, 1]);
	}
	const redAlpha = float('_UseMainTexAsAlpha', 0) !== 0;
	const main = reader.slot('_MainTex');
	const normal = has('_NORMAL_MAP') ? reader.slot('_NormalMap') : undefined;
	// the geometry's UV set 0 is all the shader reads
	if ((main !== undefined && main.uv !== 0) || (normal !== undefined && normal.uv !== 0)) {
		return unsupported('a texture on a UV set other than 0');
	}
	const lit = float('_UseLighting', 1) !== 0;
	// the depth pass's dithered alpha test, which shapes meshes such as the soft dark disc at the centre of
	// Power Plateau's sky vortex. the viewer draws it for the main texture's alpha (or red, as the alpha alone,
	// on unlit surfaces) in the default dither mode
	let dither: DitheredSurface['dither'] = null;
	if (main !== undefined && !has('_USE_MAIN2') && float('_DitherAlphaMode', 0) === 0 && (!redAlpha || !lit)) {
		dither = {
			texture: main,
			redAlpha,
			alphaScale: (color('_TintColor') ?? [1, 1, 1, 1])[3] * float('_TintColorAlpha', 1),
			exponent: float('_DitherAlphaExp', 1),
			tiling: float('_DitherTilling', 1),
		};
	}
	const tint = scaleRgb(linearRgb(color('_TintColor') ?? [1, 1, 1, 1]), float('_TintColorIntensity', 1));
	return {
		kind: 'dithered',
		baseMap: redAlpha ? null : (main ?? null),
		normalMap: normal ?? null,
		color: [tint[0] * second[0], tint[1] * second[1], tint[2] * second[2]],
		dither,
		lighting: lit
			? {
					roughness: float('_Roughness', 1),
					metallic: float('_Metallic', 0),
					normalScale: float('_NormalScale', 1),
				}
			: null,
		ignorePostExposure: float('_IgnorePostExposure', 1),
	};
};

// #endregion

// #region erosion

/**
 * `HGRP/Erosion` (`docs/game-data/materials.md#erosion`). every map samples UV set 0 and tiles by its own
 * property rather than its `_ST`; the metal, noise and flow colours are HDR and used as stored
 *
 * @param reader the material's properties
 * @returns its surface
 */
export const describeErosion = (reader: MaterialReader): ErosionSurface => {
	const { float, color } = reader;
	const tiled = (name: string, tiling: string | null): TextureSlot | null => {
		const slot = reader.slot(name);
		return slot === undefined ? null : tiledSlot(slot, tiling === null ? 1 : float(tiling, 1), 0);
	};
	const hdr = (name: string): Rgb => {
		const value = color(name) ?? [1, 1, 1, 1];
		return [value[0], value[1], value[2]];
	};
	return {
		kind: 'erosion',
		textures: {
			baseNormal: tiled('_BaseNormalMap', '_BaseNormalTilling'),
			metalMix: tiled('_MetalMixMap', null),
			flowRamp: tiled('_FlowRampMap', null),
			detailNormal: tiled('_DetailNormalMap', '_DetailNormalTilling'),
			noisePattern: tiled('_NoisePatternMap', '_NoisePatternMapTilling'),
		},
		baseColor: linearRgb(color('_BaseColor') ?? [1, 1, 1, 1]),
		roughness: float('_Roughness', 0),
		detailRoughnessCover: float('_DetailRoughnessCover', 0),
		metallic: float('_Metallic', 0),
		metallicOffset: float('_MetallicOffset', 0),
		metallicColor: hdr('_MetallicColor'),
		normalScale: float('_NormalScale', 1),
		detailNormalScale: float('_DetailNormalScale', 1),
		occlusionStrength: float('_OcclusionStrength', 1),
		f0: 0.08 * float('_Specular', 0.5),
		noise: {
			depth: float('_NoiseStrength', 0),
			tint: hdr('_NoisePatternTintColor'),
			alphaTint: hdr('_NoisePatternAlphaTintColor'),
			min: float('_NoiseMin', 0),
			emissiveStrength: float('_NoiseEmissiveStrength', 0),
			fadeDistance: float('_DistanceBlend', 1),
		},
		flow: {
			tiling: float('_FlowNormalTilling', 0),
			noiseStrength: float('_FlowNoiseStrength', 0),
			// 0.05 · speed per second (docs/game-data/materials.md#clock)
			scroll: 0.05 * float('_FlowNormalSpeed', 0),
			speedOffset: float('_FlowSpeedOffset', 0),
			colorOffset: float('_FlowColorOffset', 0),
			top: hdr('_FlowTopColor'),
			bottom: hdr('_FlowBottomColor'),
			colorStrength: float('_FlowColorStrength', 0),
			emissiveStrength: float('_FlowColorEmissiveStrength', 0),
			roughness: float('_FlowRoughness', 0),
		},
	};
};

// #endregion
