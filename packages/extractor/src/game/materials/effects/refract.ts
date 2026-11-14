import type {
	EffectTexture,
	RefractSurface,
	RefractTexture,
	UnsupportedSurface,
} from '@endfield-noclip/package-format/surfaces';

import { undrawnBlend, undrawnKeywords } from '../describe-steps.ts';
import { isUnsupported, linearRgb, type MaterialReader, unsupported } from '../material-values.ts';

import {
	degreesRotation,
	dissolveSweepOf,
	effectTexture,
	nearFadeOf,
	ownSpeedOf,
	softBlendOf,
	speedOf,
	UNSET_WHITE,
} from './effect-steps.ts';

/** keywords of `HGRP/Effect/VFXRefract` that are drawn */
const REFRACT_KEYWORDS = new Set([
	'_USE_BLEND',
	'_USE_DISSOLVE',
	'_USE_MASK',
	'_USE_POLARUV',
	'_USE_RBOFFSET',
	'_USE_RGBOFFSET',
	'_USE_SOFTBLEND',
	'_USE_SPREAD',
]);

/**
 * `HGRP/Effect/VFXRefract`: the scene behind, seen at an offset that a texture sets, masked
 * (`docs/game-data/effects.md#refraction`)
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported`
 */
export const describeRefract = (reader: MaterialReader): RefractSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has } = reader;
	const undrawn = undrawnBlend(reader, ['alphaBlend', 'opaque']) ?? undrawnKeywords(reader, REFRACT_KEYWORDS);
	if (undrawn !== null) {
		return undrawn;
	}
	// an opaque blend state writes the refracted colour outright, and the game draws these in the distortion
	// pass's opaque list, ahead of the blended ones (docs/game-data/effects.md#refraction)
	const opaque = reader.material.blend === 'opaque';
	if (opaque && !reader.material.zWrite) {
		return unsupported('opaque blending without depth writes');
	}
	/** a slot on UV0, turned by its rotation property in degrees */
	const uv0Texture = (
		name: string,
		rotate: string,
		scroll: readonly number[],
	): EffectTexture | UnsupportedSurface => {
		const bound = reader.slot(name) ?? UNSET_WHITE;
		if (bound.uv !== 0) {
			return unsupported(`${name} on UV set ${bound.uv}`);
		}
		return effectTexture(bound, scroll, degreesRotation(float(rotate, 0)));
	};
	const polar = has('_USE_POLARUV');
	/** the shader reads UV0, or polar UVs about its centre with either switch value */
	const textureOf = (
		name: string,
		rotate: string,
		speed: string,
		switchName: string,
	): RefractTexture | UnsupportedSurface => {
		const switched = float(switchName, 0) !== 0;
		if (switched && !polar) {
			return unsupported(`${switchName} without polar UVs`);
		}
		const sampled = uv0Texture(name, rotate, speedOf(reader, speed));
		return isUnsupported(sampled) ? sampled : { ...sampled, source: switched ? 'polar' : 'uv0' };
	};
	const refraction = textureOf('_RefractTex', '_RefractTexUVRotate', '_RefractUVSpeed', '_RefractSwitchUV');
	if (isUnsupported(refraction)) {
		return refraction;
	}
	let mask: RefractSurface['mask'] = null;
	if (has('_USE_MASK')) {
		const masked = textureOf('_MaskTex', '_MaskTexUVRotate', '_MaskTexUVSpeed', '_MaskSwitchUV');
		if (isUnsupported(masked)) {
			return masked;
		}
		mask = { texture: masked, redAlpha: float('_UseMaskTexAsAlpha', 1) !== 0 };
	}
	let dissolve: RefractSurface['dissolve'] = null;
	if (has('_USE_DISSOLVE')) {
		// the dissolve texture always reads UV0, without a polar switch, and its UVs take no custom data
		const dissolved = uv0Texture('_DissolveTex', '_DissolveUVRotate', ownSpeedOf(reader, '_DissolveUVSpeed'));
		if (isUnsupported(dissolved)) {
			return dissolved;
		}
		dissolve = {
			texture: dissolved,
			...dissolveSweepOf(reader),
			affectsAlpha: float('_DissolveAffectBlend', 0),
		};
	}
	let blend: RefractSurface['blend'] = null;
	if (has('_USE_BLEND')) {
		const blended = textureOf('_BlendTex', '_BlendTexUVRotate', '_BlendTexUVSpeed', '_BlendSwitchUV');
		if (isUnsupported(blended)) {
			return blended;
		}
		const tint = color('_BlendColor') ?? [1, 1, 1, 1];
		blend = {
			texture: blended,
			redAlpha: float('_UseBlendTexAsAlpha', 0) !== 0,
			// [HDR]: used as stored
			color: [tint[0], tint[1], tint[2], tint[3]],
			usesRefraction: float('_BlendTexUseRefract', 0),
		};
	}
	let spread: RefractSurface['spread'] = null;
	if (has('_USE_SPREAD')) {
		// no variant pairs the spread with polar UVs, and its UVs take no custom data
		const spreading = uv0Texture('_SpreadTex', '_SpreadUVRotate', ownSpeedOf(reader, '_SpreadUVSpeed'));
		if (isUnsupported(spreading)) {
			return spreading;
		}
		spread = {
			texture: spreading,
			schedule: float('_SpreadScheduleOffset', 0),
			range: Math.max(float('_SpreadRange', 1), 1e-6),
			flip: float('_SpreadFlip', 0),
			alphaScale: float('_SpreadAlphaCurve', 1),
		};
	}
	const dir = color('_RefractDir') ?? [1, 1, 0, 0];
	let colorOffsets: RefractSurface['colorOffsets'] = null;
	// `_USE_RGBOFFSET` only adds a second further sample to `_USE_RBOFFSET`'s, with a mask per sample
	if (has('_USE_RBOFFSET')) {
		const offset = color('_RBOffset') ?? [0, 0, 0, 0];
		const scale = 0.01 * float('_Intensity', 1);
		const second = has('_USE_RGBOFFSET');
		colorOffsets = {
			offset: [offset[0] * scale, offset[1] * scale],
			secondShare: float('_GOffset', -1),
			intensity: float('_RBIntensity', 1),
			main: linearRgb(color('_RBMainColorMask') ?? [1, 0, 0, 1]),
			first: linearRgb(color(second ? '_RBOffset1ColorMask' : '_RBOffsetColorMask') ?? [0, 1, 1, 1]),
			mainAsMask: float('_UseMainTexAsMask', 0),
			second: second ? linearRgb(color('_RBOffset2ColorMask') ?? [0, 0, 1, 1]) : null,
		};
	}
	return {
		kind: 'refract',
		opaque,
		refraction,
		mask,
		direction: [dir[0], dir[1]],
		strength: float('_Intensity', 1) * float('_TintColorAlpha', 1),
		bias: float('_Bi_Refract', 0),
		isNormal: float('_RefractIsNormal', 1) !== 0,
		maskUsesRefraction: float('_MaskTexUseRefract', 0),
		colorOffsets,
		dissolve,
		blend,
		spread,
		// soft blend: the cover fades out over `_SoftDistance` in front of what lies behind
		softDistance: softBlendOf(reader)?.distance ?? 0,
		near: nearFadeOf(reader),
	};
};
