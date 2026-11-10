/**
 * what every scene effect's look shares: the rows `effect.wgsl` reads for all of them, the slot bits, and the
 * slot writers the families' modules beside this one build on
 *
 * @module
 */

import type { EffectNearFade, EffectTexture } from '@endfield-noclip/package-format/surfaces';
import type { TextureRef } from '@endfield-noclip/package-format/textures';

import { emptySlots, type LookSlots, placeTexture } from '../look.ts';

/** a look's {@link EffectRow.slotBits} role value for a texture that isn't sampled */
export const ROLE_NONE = 7;

/** the roles a texture plays, as `effect.wgsl` numbers them */
export const EffectRole = {
	Disturb1: 0,
	Disturb2: 1,
	Weight: 2,
	Mask: 3,
	Blend: 4,
	Dissolve: 5,
	/** the base colour and alpha */
	Main: 6,
} as const;

/** what `effect.wgsl` draws a look as, in {@link EffectRow.unfogged}'s second float */
export const EffectKind = {
	/** VFXBaseV2 and VFXDecal's texture stack */
	Stack: 0,
	/** a VFXWater sheet (`WaterSheetRow`) */
	WaterSheet: 1,
	/** an `HGRP/DecalLit` box (`DecalLitRow`), drawn by the decal entry point */
	LitDecal: 2,
	/** a volumetric light beam's cone (`BeamRow`) */
	Beam: 3,
	/** a VFXRefract layer (`RefractRow`), drawn by the refraction entry point over the composited scene */
	Refract: 4,
	/** a WaterDecal box (`WaterFoamRow`), drawn into the water's foam by its own entry point */
	WaterFoam: 5,
	/** six-way lit smoke (`SixWayRow`) */
	SixWaySmoke: 6,
} as const;

/**
 * float offsets of an effect look's parameters (`MaterialLook.params`), `LOOK_FLOATS` of them; the shader
 * reads them as vec4 rows. row 39 is free past {@link EffectRow.customScroll}, as is float 143
 */
export const EffectRow = {
	/** tint rgb (times its intensity), alpha */
	tint: 0,
	/** one UV transform per texture slot: scale, offset */
	uv: 4,
	/** per slot: UV scroll per second (xy), the UV rotation's cosine and sine */
	anim: 32,
	/**
	 * per slot: role, plus 16 when its red channel is its alpha, plus 32 times its {@link SlotSource}, or
	 * {@link SLOT_NO_BASE}, plus the share of the distortion its UVs take (`slotDisturb` in stack.ts)
	 */
	slotBits: 60,
	/** the blend layer's tint rgb (HDR), w = how strongly it covers */
	blendTint: 68,
	/** distortion per unit of the first and second disturb texture: u1, v1, u2, v2 */
	disturb: 72,
	/**
	 * `_Bi_Disturb`, the weight texture's strength on the distortion, on the dissolve, 1 when the weight is
	 * used
	 */
	weight: 76,
	/** dissolve threshold, edge sharpness, glowing edge width, 1 when dissolving */
	dissolve: 80,
	/** the dissolve edge's colour (HDR), 1 when a mask is used */
	dissolveColor: 84,
	/** Fresnel power, bias, flip, how much it affects opacity (0 without `_USE_FRESNEL`) */
	fresnel: 88,
	/**
	 * soft blend distance (0 without `_USE_SOFTBLEND`), soft blend bias, `_IgnorePostExposure`, 1 to use vertex
	 * colours
	 */
	soft: 92,
	/** near camera fade: start, end, second start, second end (view depth, m) */
	near: 96,
	/** 1 with the near camera fade, brightening threshold, brightening intensity, 1 with distortion */
	misc: 100,
	/**
	 * decals: edge fade across x, across z, the fades' width, height fade. the texture stack, which decals
	 * don't draw through: the breathing's minimum alpha, speed and power, 1 when it breathes
	 */
	decalFade: 104,
	/**
	 * decals: height fade offset, angle falloff (0: no angle fade); the texture stack: 0, then the height
	 * (world y) below which fragments show the unsupported checker (`waterBlendBelow`, `NO_WATER_BLEND`
	 * without), and the power its alpha is raised to (1 but for VFXDitherAlpha's `_DitherAlphaExp`)
	 */
	decal: 108,
	/**
	 * vertex offset (VFXBaseV2, VFXDitherAlpha): `_OffsetDir` xyz, then how it's read: 0 in object space, 1 in
	 * world space, 2 along the vertex normal (`_OffsetSwitchDir`)
	 */
	offsetDir: 112,
	/**
	 * vertex offset (VFXBaseV2, VFXDitherAlpha): `_OffsetIntensity`, `_Bi_Offset`, how much the vertex alpha
	 * weighs the offset
	 */
	offset: 116,
	/**
	 * VFXBaseV2: `VertexMotion`, 1 when the offset texture reads UV set 1, 1 when `_USE_LIGHTING` lights the
	 * colour, 1 when it lights it at the world's up rather than the surface normal (`_RotateNormalToWorldUp`)
	 */
	offsetMode: 120,
	/**
	 * 1 when the layer goes unfogged (its material lacks `_USE_FOG`, and the game draws effects after the fog),
	 * the {@link EffectKind}, 1 when a VFXBaseV2 layer adds its light rather than blending over (`_BlendMode`
	 * 1), then VFXBaseV2's screen UV options: 1 to scale by the object's view depth (`_ScreenUVUseDepth`), plus
	 * 2 to take v from the world height (`_UsePosYAsScreenV`), plus 4 for the offset from the object's origin
	 * (`_LocalPivortSpace`)
	 */
	unfogged: 124,
	/** the texture stack's edge colour (`_USE_EDGECOLOR`): rgb (HDR), strength */
	edgeColor: 128,
	/** the edge's distance, offset, mode (0: multiply, 1: add), 1 with `_USE_EDGECOLOR` */
	edge: 132,
	/** the alpha the edge adds in mode 1 (`_TintColorAlpha`) */
	edgeAlpha: 136,
	/** 1 when the particle's custom data's w scales the distortion (`EffectStackSurface.particleDisturb`) */
	particleDisturb: 137,
	/**
	 * the vertex offset's mask (`EffectVertexOffsetMask`): its slot, then its strength (0 without a mask, which
	 * leaves the offset whole)
	 */
	offsetMask: 138,
	/**
	 * the texture stack's pull towards the camera (`EffectStackSurface.cameraPull`): its most in metres, then 1
	 * when it pulls
	 */
	cameraPull: 140,
	/**
	 * the texture stack, per slot: its UVs' shift (u, v) per unit of the particle's custom data
	 * (`StackLayer.customScroll`), 14 floats over rows 36–39
	 */
	customScroll: 144,
	/**
	 * the texture stack's reveal around the player (`EffectAppear`): inner radius, outer radius, the alpha's
	 * factor past them, how far the noise shifts the edge
	 */
	appear: 160,
	/** the reveal's noise scale, its speed, the height above the player its centre sits at, 1 with a reveal */
	appearNoise: 164,
	/** the reveal's brightening colour (linear rgb, alpha) */
	appearBright: 168,
	/** 1 when the vertex alpha scales the brightening's alpha */
	appearVertexAlpha: 172,
	/** 1 when the global radii add to the reveal's (`EffectAppear.global`) */
	appearGlobal: 173,
	/** 1 when the first disturb texture holds a normal (`EffectStackSurface.disturbNormal`) */
	disturbNormal: 174,
	/** 1 when the vertex colour scales the blend tint (`EffectStackSurface.blendVertexColor`) */
	blendVertexColor: 175,
	/**
	 * a decal's parallax (`DecalParallax`), in the reveal's rows, which decals don't have: the UV shift per
	 * layer per unit of slope (`−scale / 30`), then the depth, crack mask and crack noise slots (0 without)
	 */
	parallax: 160,
	/** 1 when the stack's mask scales only the alpha (`EffectStackSurface.maskAlphaOnly`) */
	maskAlphaOnly: 142,
	/** the decal's crack colour (HDR rgb), then the share of the distortion the crack noise takes */
	crack: 164,
	/** the decal's crack noise colour (HDR rgb, times its intensity) */
	crackNoise: 168,
} as const;

/**
 * the UVs a texture slot starts from: the mesh's UV sets, polar coordinates about the UV centre (VFXBaseV2:
 * UV0's; VFXDecal: the box's), or the screen position
 */
export const SlotSource = {
	Uv0: 0,
	Uv1: 1,
	Polar: 2,
	Screen: 3,
} as const;

export type SlotSource = (typeof SlotSource)[keyof typeof SlotSource];

/**
 * {@link EffectRow.slotBits} bit of a slot whose UVs start from zero, as the game's do when the source its
 * weights pick isn't computed (polar or screen UVs without their keyword and switch)
 */
export const SLOT_NO_BASE = 128;

/** what an effect's builder fills of its `MaterialLook`; `material-looks.ts` adds the flags and draw state */
export type EffectLook = LookSlots;

/**
 * fills a slot's texture, UV transform, scroll and rotation, and role bits
 *
 * @param look the look to change
 * @param i the slot
 * @param texture the texture and its transform and animation
 * @param bits the slot's {@link EffectRow.slotBits}
 */
export const setSlot = (look: EffectLook, i: number, texture: EffectTexture, bits: number): void => {
	// the mesh looks' UV rows, which EffectRow.uv shares
	placeTexture(look, i, texture);
	look.params.set([...texture.scroll, ...texture.rotation], EffectRow.anim + i * 4);
	look.params.set(texture.customScroll, EffectRow.customScroll + i * 2);
	look.params[EffectRow.slotBits + i] = bits;
};

/**
 * @param texture a texture
 * @returns the texture, still and without its own transform
 */
export const still = (texture: TextureRef): EffectTexture => ({
	texture,
	scale: [1, 1],
	offset: [0, 0],
	scroll: [0, 0],
	rotation: [1, 0],
	customScroll: [0, 0],
});

/**
 * @returns a new effect look with no textures, identity UV transforms and no animation, for a family's
 *   builder to fill
 */
export const emptyEffect = (): EffectLook => {
	const look = emptySlots();
	const { params } = look;
	for (let i = 0; i < look.textures.length; i++) {
		params[EffectRow.slotBits + i] = ROLE_NONE;
		params.set([0, 0, 1, 0], EffectRow.anim + i * 4);
	}
	params[EffectRow.decal + 3] = 1;
	return look;
};

/**
 * writes the near camera fade's rows; without one they stay zero, which the shader reads as off
 *
 * @param look the look to change
 * @param near the fade, or `null` without one
 */
export const setNear = (look: EffectLook, near: EffectNearFade | null): void => {
	if (near !== null) {
		look.params.set(near, EffectRow.near);
		look.params[EffectRow.misc] = 1;
	}
};
