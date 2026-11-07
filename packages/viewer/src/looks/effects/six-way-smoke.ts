import type { SixWaySmokeSurface, SixWayUvSource } from '@endfield-noclip/package-format/surfaces';

import {
	EffectKind,
	type EffectLook,
	EffectRow,
	emptyEffect,
	ROLE_NONE,
	setNear,
	setSlot,
	SlotSource,
} from './effect-look.ts';

/**
 * float offsets of a six-way smoke look's parameters, in place of {@link EffectRow}'s rows 17–22. the tint,
 * UV, scroll, slot bits (where each slot's UVs start), soft blend, near fade, misc (near fade switch,
 * brightening) and last rows are shared. slots: 0 the positive lightmap, 1–2 the distortion, 3 mask, 4 blend,
 * 5 dissolve, 6 the negative lightmap (sampled at slot 0's UVs)
 */
export const SixWayRow = {
	/** {@link SixWayFlags}, `_Bi_Disturb`, the absorption range, `_EnvLightSaturation` */
	flags: 68,
	/** distortion per unit of the first and second disturb texture: u1, v1, u2, v2 */
	disturb: 72,
	/** the share of the distortion the lightmap, mask, blend and dissolve UVs take */
	disturbUse: 76,
	/** dissolve threshold, edge sharpness, glowing edge width, 0 */
	dissolve: 80,
	/** the dissolve edge's colour (HDR, times the tint intensity), 0 */
	dissolveColor: 84,
	/** the blend layer's tint rgb (HDR), w = how strongly it covers */
	blendTint: 88,
} as const;

/** {@link SixWayRow.flags} bits, matching `effect.wgsl` */
export const SixWayFlags = {
	Disturb1: 1 << 0,
	Disturb2: 1 << 1,
	/** the disturb texture holds a normal: its (a·r, g) distort instead of its red */
	Disturb1Normal: 1 << 2,
	Disturb2Normal: 1 << 3,
	Mask: 1 << 4,
	MaskRedAlpha: 1 << 5,
	Blend: 1 << 6,
	Dissolve: 1 << 7,
	VertexColor: 1 << 8,
} as const;

/** {@link EffectRow.slotBits} bit of a six-way slot whose screen UVs scale by the object's view depth */
export const SIX_WAY_SCREEN_DEPTH = 8;

const SOURCES = { uv0: SlotSource.Uv0, polar: SlotSource.Polar, screen: SlotSource.Screen } as const;

/** a six-way slot's bits: no stack role, where its UVs start, and whether screen UVs scale by depth */
const slotBits = ({ source, screenDepth }: SixWayUvSource): number =>
	ROLE_NONE + SOURCES[source] * 32 + (source === 'screen' && screenDepth ? SIX_WAY_SCREEN_DEPTH : 0);

/**
 * six-way lit smoke ({@link SixWaySmokeSurface})
 *
 * @param smoke the smoke
 * @returns its look
 */
export const sixWaySmokeLook = (smoke: SixWaySmokeSurface): EffectLook => {
	const look = emptyEffect();
	const params = look.params;
	setSlot(look, 0, smoke.positive, slotBits(smoke.positive));
	// the negative lightmap samples at the positive one's UVs, which the shader takes from slot 0's rows
	setSlot(look, 6, { ...smoke.positive, texture: smoke.negative }, slotBits(smoke.positive));
	let flags = smoke.vertexColor ? SixWayFlags.VertexColor : 0;
	const disturb = [0, 0, 0, 0];
	const disturbFlags = [
		[SixWayFlags.Disturb1, SixWayFlags.Disturb1Normal],
		[SixWayFlags.Disturb2, SixWayFlags.Disturb2Normal],
	];
	smoke.disturb.forEach((layer, i) => {
		if (layer !== null) {
			setSlot(look, 1 + i, layer.texture, slotBits(smoke.disturbSource));
			disturb[i * 2] = layer.intensity[0];
			disturb[i * 2 + 1] = layer.intensity[1];
			flags |= disturbFlags[i][0] | (layer.normal ? disturbFlags[i][1] : 0);
		}
	});
	if (smoke.mask !== null) {
		setSlot(look, 3, smoke.mask.texture, slotBits(smoke.mask.texture));
		flags |= SixWayFlags.Mask | (smoke.mask.redAlpha ? SixWayFlags.MaskRedAlpha : 0);
	}
	if (smoke.blend !== null) {
		setSlot(look, 4, smoke.blend, slotBits(smoke.blend));
		flags |= SixWayFlags.Blend;
	}
	if (smoke.dissolve !== null) {
		const { dissolve } = smoke.dissolve;
		setSlot(look, 5, smoke.dissolve.texture, slotBits(smoke.dissolve.texture));
		params.set([dissolve.threshold, dissolve.sharpness, dissolve.edgeWidth, 0], SixWayRow.dissolve);
		params.set([...dissolve.edgeColor, 0], SixWayRow.dissolveColor);
		flags |= SixWayFlags.Dissolve;
	}
	params.set(smoke.tint, EffectRow.tint);
	params.set([flags, smoke.disturbBias, smoke.absorptionRange, smoke.envSaturation], SixWayRow.flags);
	params.set(disturb, SixWayRow.disturb);
	params.set(
		[
			smoke.positive.disturbShare,
			smoke.mask?.texture.disturbShare ?? 0,
			smoke.blend?.disturbShare ?? 0,
			smoke.dissolve?.texture.disturbShare ?? 0,
		],
		SixWayRow.disturbUse,
	);
	params.set(smoke.blendTint, SixWayRow.blendTint);
	params.set(
		[smoke.soft?.distance ?? 0, smoke.soft?.bias ?? 0, 0, smoke.vertexColor ? 1 : 0],
		EffectRow.soft,
	);
	setNear(look, smoke.near);
	params.set([smoke.brighten.threshold, smoke.brighten.intensity], EffectRow.misc + 1);
	// the screen UV options' depth bit stays clear: each slot scales by depth by its own bit
	params.set(
		[smoke.unfogged ? 1 : 0, EffectKind.SixWaySmoke, 0, smoke.screenVFromHeight ? 2 : 0],
		EffectRow.unfogged,
	);
	return look;
};
