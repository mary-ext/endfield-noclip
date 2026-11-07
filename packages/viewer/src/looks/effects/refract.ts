import type { RefractSurface, RefractTexture } from '@endfield-noclip/package-format/surfaces';

import {
	EffectKind,
	type EffectLook,
	EffectRow,
	emptyEffect,
	setNear,
	setSlot,
	SlotSource,
} from './effect-look.ts';

/**
 * float offsets of a VFXRefract look's parameters. the UV, scroll, slot bit, near fade and last rows are
 * {@link EffectRow}'s; slot 0 is `_RefractTex`, slot 1 `_MaskTex`, slot 2 `_DissolveTex`, slot 3 `_BlendTex`,
 * slot 4 `_SpreadTex`. the spread and blend rows take rows the vertex stage reads only for VFXBaseV2's offset
 * and the stack's edge colour
 */
export const RefractRow = {
	/** `_RefractDir` xy, the strength (`_Intensity · _TintColorAlpha`), `_Bi_Refract` */
	refract: 68,
	/**
	 * 1 when the refraction texture is a normal map (`_RefractIsNormal`), `_MaskTexUseRefract`, 1 with a mask,
	 * 0
	 */
	refract2: 72,
	/**
	 * the colour offsets (`_USE_RBOFFSET`): the further samples' offset in screen UVs (`_RBOffset · 0.01 ·
	 * _Intensity`), the second sample's share of it (`_GOffset`), `_RBIntensity`
	 */
	rb: 76,
	/** `_RBMainColorMask` rgb, 1 with colour offsets */
	rbMain: 80,
	/** the first further sample's colour mask rgb, `_UseMainTexAsMask` */
	rbFirst: 84,
	/** the second further sample's colour mask rgb, 1 when it's taken (`_USE_RGBOFFSET`) */
	rbSecond: 88,
	/** the dissolve (slot 2): threshold, sharpness, how much it scales the alpha, 1 when dissolving */
	dissolve: 104,
	/** the spread (slot 4): schedule, range (0 without `_USE_SPREAD`), flip, alpha scale */
	spread: 112,
	/** the blend layer's colour (`_BlendColor`, HDR) rgb, how strongly it tints */
	blendColor: 128,
	/** 1 with a blend layer (slot 3), the share of the refraction offset its UVs take, 0, 0 */
	blend: 132,
} as const;

/** a refraction slot's source bits: polar UVs about the centre, or UV set 0 */
const sourceBits = (source: RefractTexture['source']): number =>
	(source === 'polar' ? SlotSource.Polar : SlotSource.Uv0) * 32;

/**
 * a VFXRefract layer ({@link RefractSurface}). it samples the finished scene, so it draws over the composited
 * scene rather than in the transparent pass
 *
 * @param refract the layer
 * @returns its look
 */
export const refractLook = (refract: RefractSurface): EffectLook => {
	const look = emptyEffect();
	const params = look.params;
	setSlot(look, 0, refract.refraction, sourceBits(refract.refraction.source));
	const { mask } = refract;
	if (mask !== null) {
		setSlot(look, 1, mask.texture, sourceBits(mask.texture.source) + (mask.redAlpha ? 16 : 0));
	}
	params.set([...refract.direction, refract.strength, refract.bias], RefractRow.refract);
	params.set(
		[refract.isNormal ? 1 : 0, refract.maskUsesRefraction, mask === null ? 0 : 1, 0],
		RefractRow.refract2,
	);
	const offsets = refract.colorOffsets;
	if (offsets !== null) {
		params.set([...offsets.offset, offsets.secondShare, offsets.intensity], RefractRow.rb);
		params.set([...offsets.main, 1], RefractRow.rbMain);
		params.set([...offsets.first, offsets.mainAsMask], RefractRow.rbFirst);
		params.set([...(offsets.second ?? [0, 0, 1]), offsets.second === null ? 0 : 1], RefractRow.rbSecond);
	}
	const { dissolve } = refract;
	if (dissolve !== null) {
		setSlot(look, 2, dissolve.texture, sourceBits('uv0'));
		params.set([dissolve.threshold, dissolve.sharpness, dissolve.affectsAlpha, 1], RefractRow.dissolve);
	}
	const { blend, spread } = refract;
	if (blend !== null) {
		setSlot(look, 3, blend.texture, sourceBits(blend.texture.source) + (blend.redAlpha ? 16 : 0));
		params.set(blend.color, RefractRow.blendColor);
		params.set([1, blend.usesRefraction, 0, 0], RefractRow.blend);
	}
	if (spread !== null) {
		setSlot(look, 4, spread.texture, sourceBits('uv0'));
		params.set([spread.schedule, spread.range, spread.flip, spread.alphaScale], RefractRow.spread);
	}
	params[EffectRow.soft] = refract.softDistance;
	setNear(look, refract.near);
	params.set([1, EffectKind.Refract, 0, 0], EffectRow.unfogged);
	return look;
};
