/**
 * the Lit model's overlays: the parallax glow and the blended layer
 * (`docs/game-data/materials.md#lit-layers`)
 */

import type { TextureSlot } from '@endfield-noclip/package-format/materials';
import type { LayerCoverage, LitLayer, ParallaxGlow } from '@endfield-noclip/package-format/surfaces';

import { tiledSlot } from '../describe-steps.ts';
import { linearRgb, type MaterialReader, scaleRgb } from '../material-values.ts';

/** `_PARALLAX_MAP`'s glow (`docs/game-data/materials.md#lit-layers`) */
export const parallaxGlowOf = (
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
export const layerOf = (reader: MaterialReader): LitLayer | null => {
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
