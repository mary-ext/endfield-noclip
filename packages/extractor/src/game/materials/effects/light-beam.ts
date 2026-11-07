import type { LightBeamSurface, UnsupportedSurface } from '@endfield-noclip/package-format/surfaces';

import { undrawnKeywords } from '../describe-steps.ts';
import { BlendFactor } from '../material-classify.ts';
import { linearRgb, type MaterialReader, unsupported } from '../material-values.ts';

import { fadeRange } from './effect-steps.ts';

/**
 * beam keywords that are drawn. `VLB_NOISE_3D`'s noise is left out; under `VLB_USE_FOG`, alpha-blended beams
 * take the composite's fog and additive ones stay unfogged
 */
const BEAM_KEYWORDS = new Set(['VLB_DEPTH_BLEND', 'VLB_NOISE_3D', 'VLB_USE_FOG']);

/**
 * `Hidden/VLB_*` (`docs/game-data/lighting.md#light-beams`)
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported` for keywords or blending the viewer doesn't draw
 */
export const describeLightBeam = (reader: MaterialReader): LightBeamSurface | UnsupportedSurface => {
	const { float, colorOrVector, has } = reader;
	const keywords = undrawnKeywords(reader, BEAM_KEYWORDS);
	if (keywords !== null) {
		return keywords;
	}
	const blendMode = float('_BlendMode', 0);
	const src = float('_BlendSrcFactor', BlendFactor.One);
	const dst = float('_BlendDstFactor', BlendFactor.One);
	const additive = blendMode === 1 && src === BlendFactor.One && dst === BlendFactor.One;
	const blended = blendMode === 0 && src === BlendFactor.SrcAlpha && dst === BlendFactor.OneMinusSrcAlpha;
	if (!additive && !blended) {
		return unsupported(`blend mode ${blendMode} with factors ${src}, ${dst}`);
	}
	const flat = colorOrVector('_ColorFlat') ?? [1, 1, 1, 1];
	return {
		kind: 'lightBeam',
		color: [...linearRgb(flat), flat[3]],
		cone: colorOrVector('_ConeParams0') ?? [1, 1, 1, 0],
		direction: colorOrVector('_ConeParams1') ?? [0, 0, 1, 0],
		falloff: colorOrVector('_DistanceFallOff') ?? [0, 1, 1, 0],
		alphaInside: float('_AlphaInside', 1),
		alphaOutside: float('_AlphaOutside', 1),
		attenuationLerp: float('_AttenuationLerpLinearQuad', 0.5),
		fresnelPower: float('_FresnelPow', 1),
		glareFrontal: float('_GlareFrontal', 0.5),
		glareBehind: float('_GlareBehind', 0.5),
		apexOffset: float('_ConeGeomProps', 0),
		additive,
		distanceFade: fadeRange(float('_DistanceFadeStart', 0), float('_DistanceFadeEnd', 1)),
		distanceFadeSecond: fadeRange(float('_DistanceFadeStartSecond', 0), float('_DistanceFadeEndSecond', 0)),
		cameraClipping: float('_DistanceCamClipping', 0.5),
		depthBlend: has('VLB_DEPTH_BLEND') ? float('_DepthBlendDistance', 2) : 0,
		depthBlendCapOff: float('_DepthBlendCapOff', 0),
		useClippingPlane: float('_UseClippingPlane', 0),
		clippingPlane: colorOrVector('_AdditionalClippingPlaneWS') ?? [0, 1, 0, 0],
		tilt: [float('_TiltVectorX', 0), float('_TiltVectorY', 0)],
		clippingPlaneTransition: Math.max(float('_ClippingPlaneTransition', 1), 1e-4),
		unfogged: !has('VLB_USE_FOG'),
	};
};
