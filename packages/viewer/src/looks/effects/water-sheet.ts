import type { WaterSheetSurface } from '@endfield-noclip/package-format/surfaces';

import {
	EffectKind,
	type EffectLook,
	EffectRole,
	EffectRow,
	emptyEffect,
	setNear,
	setSlot,
} from './effect-look.ts';

/**
 * float offsets of a VFXWater look's parameters, in place of {@link EffectRow}'s rows 17–22 and 26–30. the
 * tint, UV, scroll, soft blend, near fade and last rows are shared, and the vertex offset stays off (row 30's
 * x)
 */
export const WaterSheetRow = {
	/** {@link WaterSheetFlags}, 1 when additive (`_BlendMode`), `_UseLighting`, `_WaterRandomUV` */
	flags: 68,
	/** `_Bi_Disturb`, `_DisturbUIntensity1`, `_DisturbVIntensity1`, 0 */
	disturb: 72,
	/** how far the distortion moves the main, mask, normal map and dissolve UVs (`_…UseDisturb`) */
	disturbUse: 76,
	/** dissolve threshold, edge sharpness, glowing edge width, 0 */
	dissolve: 80,
	/** the dissolve edge's colour (linear, times the tint intensity), 0 */
	dissolveColor: 84,
	/** flipbook columns, rows, frames per second, `_RandomStartByPos` */
	sequence: 88,
	/** flipbook: motion vector strength, opacity scale, opacity threshold, colour threshold */
	sequenceShape: 104,
	/** flipbook colour tint (linear), normal scale (the flipbook's or the normal map's) */
	sequenceTint: 108,
	/** `_Roughness`, `_Specular`, `_DirSpecularStrength`, `_FresnelStrength` */
	surface: 112,
	/** subsurface hue, saturation, value (0 without `_SUBSURFACE`), indirect strength */
	subsurface: 116,
	/** 0 (the vertex offset's switch), `_IndirectSaturation`, 0, 0 */
	misc: 120,
} as const;

/** {@link WaterSheetRow.flags} bits, matching `effect.wgsl` */
export const WaterSheetFlags = {
	Disturb: 1 << 0,
	/** the disturb texture holds a normal: its (a·r, g) distort instead of its red */
	DisturbNormal: 1 << 1,
	Mask: 1 << 2,
	Dissolve: 1 << 3,
	Sequence: 1 << 4,
	SequenceMotion: 1 << 5,
	/** slot 6 holds the flipbook's normals */
	SequenceNormal: 1 << 6,
	/** slot 6 holds `_NormalMap` */
	NormalMap: 1 << 7,
	MainAsAlpha: 1 << 8,
	MaskAsAlpha: 1 << 9,
	VertexOpacity: 1 << 10,
	FresnelOpacity: 1 << 11,
	VertexColor: 1 << 12,
} as const;

/**
 * a VFXWater sheet ({@link WaterSheetSurface}): main, disturb, mask, dissolve, flipbook and its motion
 * vectors in slots 0–5, and slot 6 whichever normals it uses
 *
 * @param sheet the sheet
 * @returns its look
 */
export const waterSheetLook = (sheet: WaterSheetSurface): EffectLook => {
	const look = emptyEffect();
	const params = look.params;
	const { textures, dissolve } = sheet;
	const slots = [
		textures.main,
		textures.disturb,
		textures.mask,
		dissolve?.texture ?? null,
		textures.sequence,
		textures.sequenceMotion,
	];
	slots.forEach((texture, i) => {
		if (texture !== null) {
			setSlot(look, i, texture, EffectRole.Main);
		}
	});
	let flags = 0;
	if (textures.disturb !== null) {
		flags |= WaterSheetFlags.Disturb | (sheet.disturbNormal ? WaterSheetFlags.DisturbNormal : 0);
	}
	if (textures.mask !== null) {
		flags |= WaterSheetFlags.Mask;
	}
	if (dissolve !== null) {
		flags |= WaterSheetFlags.Dissolve;
		params.set([dissolve.threshold, dissolve.sharpness, dissolve.edgeWidth, 0], WaterSheetRow.dissolve);
		params.set([...dissolve.edgeColor, 0], WaterSheetRow.dissolveColor);
	}
	if (textures.sequence !== null) {
		flags |=
			WaterSheetFlags.Sequence | (textures.sequenceMotion === null ? 0 : WaterSheetFlags.SequenceMotion);
	}
	if (textures.normals !== null) {
		setSlot(look, 6, textures.normals.texture, EffectRole.Main);
		flags |= textures.normals.flipbook ? WaterSheetFlags.SequenceNormal : WaterSheetFlags.NormalMap;
	}
	flags |=
		(sheet.mainAsAlpha ? WaterSheetFlags.MainAsAlpha : 0) |
		(sheet.maskAsAlpha ? WaterSheetFlags.MaskAsAlpha : 0) |
		(sheet.vertexOpacity ? WaterSheetFlags.VertexOpacity : 0) |
		(sheet.fresnelOpacity ? WaterSheetFlags.FresnelOpacity : 0) |
		(sheet.vertexColor ? WaterSheetFlags.VertexColor : 0);
	params.set(sheet.tint, EffectRow.tint);
	params.set([flags, sheet.additive ? 1 : 0, sheet.useLighting, sheet.randomUv], WaterSheetRow.flags);
	params.set([sheet.disturbBias, ...sheet.disturb, 0], WaterSheetRow.disturb);
	params.set(sheet.disturbUse, WaterSheetRow.disturbUse);
	const { sequence } = sheet;
	params.set(
		[sequence.columns, sequence.rows, sequence.framesPerSecond, sequence.randomStartByPosition],
		WaterSheetRow.sequence,
	);
	params.set(
		[sequence.motionStrength, sequence.opacityScale, sequence.opacityThreshold, sequence.colorThreshold],
		WaterSheetRow.sequenceShape,
	);
	params.set([...sequence.tint, textures.normals?.scale ?? 1], WaterSheetRow.sequenceTint);
	params.set([sheet.roughness, sheet.specular, sheet.directSpecular, sheet.fresnel], WaterSheetRow.surface);
	params.set(sheet.subsurface, WaterSheetRow.subsurface);
	params.set([0, sheet.indirectSaturation, 0, 0], WaterSheetRow.misc);
	params.set(
		[sheet.soft?.distance ?? 0, sheet.soft?.bias ?? 0, sheet.ignorePostExposure, sheet.vertexColor ? 1 : 0],
		EffectRow.soft,
	);
	setNear(look, sheet.near);
	params.set([0, EffectKind.WaterSheet, 0, 0], EffectRow.unfogged);
	return look;
};
