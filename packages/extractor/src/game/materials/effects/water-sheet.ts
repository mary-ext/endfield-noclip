import type { TextureSlot } from '@endfield-noclip/package-format/materials';
import type {
	EffectTexture,
	UnsupportedSurface,
	WaterSheetSoftBody,
	WaterSheetSurface,
} from '@endfield-noclip/package-format/surfaces';

import { undrawnBlend, undrawnKeywords } from '../describe-steps.ts';
import { isUnsupported, linearRgb, type MaterialReader, scaleRgb, unsupported } from '../material-values.ts';

import {
	dissolveOf,
	disturbIntensityOf,
	effectTexture,
	matrixRotationOf,
	nearFadeOf,
	ownSpeedOf,
	softBlendOf,
	speedOf,
} from './effect-steps.ts';
import { softBodyHdr, softBodyOf } from './soft-body.ts';

/**
 * VFXWater keywords that are drawn. `VFX_WATER_SIMPLE_LIGHT`, the game's cheaper lighting from a per-draw
 * ambient probe and the far shadow, is lit the full way
 */
const WATER_KEYWORDS = new Set([
	'_SUBSURFACE',
	'_USE_DISTURB',
	'_USE_MASK',
	'_USE_DISSOLVE',
	'_USE_SOFTBLEND',
	'_NORMAL_MAP',
	'_USE_SEQUENCE_FRAME',
	'_USE_SEQUENCE_FRAME_MV',
	'_USE_SEQUENCE_FRAME_NORMAL',
	'VFX_WATER_SIMPLE_LIGHT',
	'_VAT_SOFTBODY',
]);

/** a water sheet texture, once those on other UV sets (`'uv'`) have been rejected */
const sheetTexture = (value: EffectTexture | null | 'uv'): EffectTexture | null =>
	value === 'uv' ? null : value;

/**
 * `HGRP/Effect/VFXWater`, the sheets of falling water (`docs/game-data/effects.md#waterfalls`)
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported` for features the viewer doesn't draw (refraction, a vertex offset)
 */
export const describeWaterSheet = (reader: MaterialReader): WaterSheetSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has } = reader;
	const undrawn = undrawnBlend(reader, ['premultiplied']) ?? undrawnKeywords(reader, WATER_KEYWORDS);
	if (undrawn !== null) {
		return undrawn;
	}
	const sequence = has('_USE_SEQUENCE_FRAME');
	if (sequence && reader.slot('_SequenceBaseColorMap') === undefined) {
		return unsupported('a flipbook without its texture');
	}
	const softBody = sheetSoftBodyOf(reader);
	if (softBody !== null && isUnsupported(softBody)) {
		return softBody;
	}
	/** a used slot; the sheets are drawn from UV set 0 alone */
	const used = (name: string, on: boolean): TextureSlot | null | 'uv' => {
		const slot = on ? reader.slot(name) : undefined;
		if (slot === undefined) {
			return null;
		}
		return slot.uv > 0 ? 'uv' : slot;
	};
	const animated = (name: string, on: boolean, prefix: string, suffix = ''): EffectTexture | null | 'uv' => {
		const slot = used(name, on);
		if (slot === null || slot === 'uv') {
			return slot;
		}
		return effectTexture(
			slot,
			speedOf(reader, `${prefix}UVSpeed${suffix}`),
			matrixRotationOf(reader, `${prefix}UVRotateMat${suffix}`),
		);
	};
	/** the flipbook samples its frames' UVs as they are */
	const frames = (name: string, on: boolean): EffectTexture | null | 'uv' => {
		const slot = used(name, on);
		return slot === null || slot === 'uv'
			? slot
			: effectTexture({ texture: slot.texture, scale: [1, 1], offset: [0, 0] });
	};
	const main = animated('_MainTex', true, '_MainTex');
	const disturb = animated('_DisturbTex1', has('_USE_DISTURB'), '_Disturb', '1');
	const mask = animated('_MaskTex', has('_USE_MASK'), '_MaskTex');
	const dissolveMap = animated('_DissolveTex', has('_USE_DISSOLVE'), '_Dissolve');
	const sequenceMap = frames('_SequenceBaseColorMap', sequence);
	const sequenceMotion = frames('_SequenceMotionVectorMap', sequence && has('_USE_SEQUENCE_FRAME_MV'));
	const textures = [main, disturb, mask, dissolveMap, sequenceMap, sequenceMotion];
	if (textures.includes('uv')) {
		return unsupported('a texture on a UV set other than 0');
	}
	if (main === null && reader.shader.textures['_MainTex'] !== 'white') {
		return unsupported('no main texture and a non-white default');
	}
	// the flipbook's normals, or a normal map
	let normals: WaterSheetSurface['textures']['normals'] = null;
	{
		const flipbook = sequence && has('_USE_SEQUENCE_FRAME_NORMAL');
		const name = flipbook ? '_SequenceNormalMap' : has('_NORMAL_MAP') ? '_NormalMap' : null;
		const slot = name === null ? undefined : reader.slot(name);
		if (slot !== undefined && slot.uv === 0) {
			normals = {
				texture: flipbook
					? effectTexture({ texture: slot.texture, scale: [1, 1], offset: [0, 0] })
					: // the normal map takes no custom data
						effectTexture(
							slot,
							ownSpeedOf(reader, '_NormalMapUVSpeed'),
							matrixRotationOf(reader, '_NormalMapUVRotateMat'),
						),
				flipbook,
				scale: flipbook ? float('_FrameNormalScale', 1) : float('_NormalScale', 1),
			};
		}
	}
	const intensity = float('_TintColorIntensity', 1);
	// VFXWater's `_TintColor` and `_DissolveEmissiveColor` are [HDR]: authored linear, used as stored
	const tint = color('_TintColor') ?? [1, 1, 1, 1];
	const frameSize = color('_SequenceFrameSize') ?? [1, 1, 0, 0];
	const dissolveTexture = sheetTexture(dissolveMap);
	return {
		kind: 'waterSheet',
		tint: [...scaleRgb(tint, intensity), tint[3] * float('_TintColorAlpha', 1)],
		textures: {
			main: sheetTexture(main),
			disturb: sheetTexture(disturb),
			mask: sheetTexture(mask),
			sequence: sheetTexture(sequenceMap),
			sequenceMotion: sheetTexture(sequenceMotion),
			normals,
		},
		disturbNormal: float('_DisturbTex1Normal', 0) !== 0,
		mainAsAlpha: float('_UseMainTexAsAlpha', 1) !== 0,
		maskAsAlpha: float('_UseMaskTexAsAlpha', 1) !== 0,
		vertexOpacity: float('_UseVertexColorAsOpacity', 0) !== 0,
		fresnelOpacity: float('_UseFresnelAsOpacity', 0) !== 0,
		vertexColor: float('_DisableVertColor', 0) === 0,
		additive: float('_BlendMode', 0) >= 0.5,
		useLighting: float('_UseLighting', 1),
		randomUv: float('_WaterRandomUV', 0),
		disturbBias: float('_Bi_Disturb', 0),
		disturb: disturbIntensityOf(reader, 1),
		disturbUse: [
			float('_MainTexUseDisturb', 0),
			float('_MaskTexUseDisturb', 0),
			float('_NormalMapUseDisturb', 0),
			float('_DissolveTexUseDisturb', 0),
		],
		dissolve:
			dissolveTexture === null ? null : { ...dissolveOf(reader, intensity), texture: dissolveTexture },
		sequence: {
			columns: Math.max(frameSize[0], 1),
			rows: Math.max(frameSize[1], 1),
			framesPerSecond: float('_PlaybackSpeed', 0),
			randomStartByPosition: float('_RandomStartByPos', 0),
			motionStrength: float('_MotionVectorDistortionStrength', 0),
			opacityScale: float('_SequenceOpacityScale', 1),
			opacityThreshold: float('_SequenceOpacitySdf', 0),
			colorThreshold: float('_SequenceBaseColorSdf', 0),
			tint: linearRgb(color('_SequenceBaseColorMapTint') ?? [1, 1, 1, 1]),
		},
		roughness: float('_Roughness', 1),
		specular: float('_Specular', 1),
		directSpecular: float('_DirSpecularStrength', 1),
		fresnel: float('_FresnelStrength', 0),
		subsurface: [
			float('_SubsurfaceHue', 1),
			float('_SubsurfaceSaturation', 1),
			has('_SUBSURFACE') ? float('_SubsurfaceValue', 1) : 0,
			float('_SubsurfaceIndirect', 1),
		],
		indirectSaturation: float('_IndirectSaturation', 1),
		soft: softBlendOf(reader),
		ignorePostExposure: float('_IgnorePostExposure', 1),
		near: nearFadeOf(reader),
		softBody,
	};
};

/**
 * `_VAT_SOFTBODY` on a sheet: its position texture and the rotation texture its normals come from
 *
 * @returns the animation, `null` without the keyword, or `unsupported`
 */
const sheetSoftBodyOf = (reader: MaterialReader): WaterSheetSoftBody | UnsupportedSurface | null => {
	const { has } = reader;
	if (!has('_VAT_SOFTBODY')) {
		return null;
	}
	// the viewer binds the two textures where a flipbook's motion vectors and the normals go
	if (has('_USE_SEQUENCE_FRAME') || has('_NORMAL_MAP')) {
		return unsupported('a soft-body animation with a flipbook or a normal map');
	}
	const body = softBodyOf(reader);
	if (isUnsupported(body)) {
		return body;
	}
	const rotation = reader.slot('_RotationTexture');
	if (rotation === undefined) {
		return unsupported('a soft-body animation without its rotation texture');
	}
	return { ...body, rotation: rotation.texture, rotationPacked: !softBodyHdr(reader) };
};
