import type {
	DecalParallax,
	EffectSoftBody,
	EffectStackSurface,
	EffectUvSource,
	EffectVertexOffset,
	StackLayer,
} from '@endfield-noclip/package-format/surfaces';

import {
	EffectKind,
	type EffectLook,
	EffectRole,
	EffectRow,
	emptyEffect,
	ROLE_NONE,
	setNear,
	setSlot,
	SLOT_NO_BASE,
	SlotSource,
} from './effect-look.ts';

/** each {@link StackLayer} role's {@link EffectRole} */
const ROLES: Record<StackLayer['role'], number> = {
	disturb1: EffectRole.Disturb1,
	disturb2: EffectRole.Disturb2,
	weight: EffectRole.Weight,
	mask: EffectRole.Mask,
	blend: EffectRole.Blend,
	dissolve: EffectRole.Dissolve,
	main: EffectRole.Main,
};

/** each {@link EffectUvSource}'s {@link SlotSource} */
const SOURCES: Record<EffectUvSource, SlotSource> = {
	uv0: SlotSource.Uv0,
	uv1: SlotSource.Uv1,
	polar: SlotSource.Polar,
	screen: SlotSource.Screen,
};

/**
 * how the vertex stage moves an effect's vertices ({@link EffectRow.offsetMode} x). with the soft body, the
 * {@link OFFSET_SLOT} holds the position texture, its UV row UV1's u scale and the frame rows' scale, its
 * scroll row the cycles per second and the phase; {@link EffectRow.offsetDir} holds the offset's minimum and
 * the frame count, and {@link EffectRow.offset} its range and the camera pull
 */
export const VertexMotion = {
	None: 0,
	Offset: 1,
	SoftBody: 2,
} as const;

/**
 * the texture stack's slot of the vertex offset's texture, which the vertex stage samples; its UV and scroll
 * rows hold the texture's `_ST` and scroll. VFXBaseV2's sixth sample texture shares it, so a material can't
 * have both
 */
export const OFFSET_SLOT = 6;

/** the water-blend height of a texture stack without one: below every world */
export const NO_WATER_BLEND = -1e30;

/**
 * the {@link EffectRow.slotBits} term for the share of the distortion a slot's UVs take (`*UseDisturb`), in
 * 1/1024ths above the low byte, which f32 holds exactly
 */
const slotDisturb = (share: number): number => Math.round(Math.max(share, 0) * 1024) * 256;

/** a stack layer's {@link EffectRow.slotBits} */
const layerBits = (layer: StackLayer): number =>
	ROLES[layer.role] +
	(layer.redAlpha ? 16 : 0) +
	(layer.source === null ? SLOT_NO_BASE : SOURCES[layer.source] * 32) +
	slotDisturb(layer.disturbShare);

/** {@link EffectRow.offsetDir}'s last float by {@link EffectVertexOffset.space} */
const OFFSET_SPACES: Record<EffectVertexOffset['space'], number> = { object: 0, world: 1, normal: 2 };

/** {@link EffectRow.unfogged}'s third float by {@link EffectStackSurface.blendMode} */
const BLEND_MODES: Record<EffectStackSurface['blendMode'], number> = { over: 0, add: 1, multiply: 2 };

/** the vertex offset's slot and rows */
const setVertexOffset = (look: EffectLook, offset: EffectVertexOffset): void => {
	const params = look.params;
	setSlot(look, OFFSET_SLOT, offset.texture, ROLE_NONE);
	params.set([...offset.direction, OFFSET_SPACES[offset.space]], EffectRow.offsetDir);
	params.set([offset.intensity, offset.bias, offset.vertexAlphaWeight], EffectRow.offset);
	params.set([VertexMotion.Offset, offset.uv1 ? 1 : 0], EffectRow.offsetMode);
	if (offset.mask !== null) {
		// the fragment stage skips the slot, which has no role
		setSlot(look, offset.mask.slot, offset.mask.texture, ROLE_NONE);
		params.set([offset.mask.slot, offset.mask.strength], EffectRow.offsetMask);
	}
};

/** the soft-body animation's slot and rows ({@link VertexMotion}) */
const setSoftBody = (look: EffectLook, body: EffectSoftBody): void => {
	const params = look.params;
	// a fixed frame is a still phase in the middle of its frame
	const rate = body.fixedFrame === null ? body.cycleRate : 0;
	const phase =
		body.fixedFrame === null ? -body.cycleStart * body.cycleRate : (body.fixedFrame + 0.5) / body.frameCount;
	setSlot(
		look,
		OFFSET_SLOT,
		{
			texture: body.texture,
			scale: [body.uScale, body.vScale],
			offset: [0, 0],
			scroll: [rate, phase],
			rotation: [1, 0],
			customScroll: [0, 0],
		},
		ROLE_NONE,
	);
	params.set([...body.min, body.frameCount], EffectRow.offsetDir);
	params.set(body.range, EffectRow.offset);
	params[EffectRow.offsetMode] = VertexMotion.SoftBody;
};

/**
 * a decal's parallax slots and rows ({@link EffectRow.parallax}): the depth texture and crack mask sample at
 * the main texture's UVs, the noise at its own source's
 */
const setParallax = (look: EffectLook, parallax: DecalParallax): void => {
	const params = look.params;
	setSlot(look, parallax.depthSlot, parallax.depth, ROLE_NONE);
	setSlot(look, parallax.crackSlot, parallax.crack, ROLE_NONE);
	// the fragment stage skips it in the stack's loop, but reads its source bits
	setSlot(look, parallax.noiseSlot, parallax.noise, ROLE_NONE + SOURCES[parallax.noiseSource] * 32);
	params.set(
		[-parallax.scale / 30, parallax.depthSlot, parallax.crackSlot, parallax.noiseSlot],
		EffectRow.parallax,
	);
	params.set([...parallax.crackColor, parallax.noiseDisturb], EffectRow.crack);
	params.set(parallax.noiseColor, EffectRow.crackNoise);
};

/**
 * the texture stack of VFXBaseV2, VFXDecal, VFXDitherAlpha's effect variants and VFXAdvance ({@link
 * EffectStackSurface})
 *
 * @param stack the stack
 * @returns its look
 */
export const stackLook = (stack: EffectStackSurface): EffectLook => {
	const look = emptyEffect();
	const params = look.params;
	stack.layers.forEach((layer, i) => {
		if (layer !== null) {
			setSlot(look, i, layer, layerBits(layer));
		}
	});
	params.set(stack.tint, EffectRow.tint);
	params.set(stack.blendTint, EffectRow.blendTint);
	params.set(stack.disturb, EffectRow.disturb);
	params.set(
		[stack.disturbBias, stack.weight.disturb, stack.weight.dissolve, stack.weight.used ? 1 : 0],
		EffectRow.weight,
	);
	const { dissolve } = stack;
	if (dissolve !== null) {
		params.set([dissolve.threshold, dissolve.sharpness, dissolve.edgeWidth, 1], EffectRow.dissolve);
		params.set(dissolve.edgeColor, EffectRow.dissolveColor);
	}
	params[EffectRow.dissolveColor + 3] = stack.masked ? 1 : 0;
	if (stack.fresnel !== null) {
		const { fresnel } = stack;
		params.set([fresnel.power, fresnel.bias, fresnel.flip, fresnel.opacity], EffectRow.fresnel);
	}
	params.set(
		[stack.soft?.distance ?? 0, stack.soft?.bias ?? 0, stack.ignorePostExposure, stack.vertexColor ? 1 : 0],
		EffectRow.soft,
	);
	setNear(look, stack.near);
	params.set(
		[stack.brighten.threshold, stack.brighten.intensity, stack.distorted ? 1 : 0],
		EffectRow.misc + 1,
	);
	if (stack.decalFade !== null) {
		const fade = stack.decalFade;
		params.set([...fade.edge, fade.width, fade.height], EffectRow.decalFade);
		params.set([fade.heightOffset, fade.angle], EffectRow.decal);
	} else if (stack.breathing !== null) {
		const { breathing } = stack;
		params.set([breathing.minAlpha, breathing.speed, breathing.power, 1], EffectRow.decalFade);
	}
	if (stack.edge !== null) {
		const { edge } = stack;
		params.set(edge.color, EffectRow.edgeColor);
		params.set([edge.distance, edge.offset, edge.mode, 1], EffectRow.edge);
		params[EffectRow.edgeAlpha] = edge.alpha;
	}
	params[EffectRow.particleDisturb] = stack.particleDisturb ? 1 : 0;
	params[EffectRow.decal + 2] = stack.waterBlendBelow ?? NO_WATER_BLEND;
	params[EffectRow.decal + 3] = stack.alphaPower;
	if (stack.offset !== null) {
		setVertexOffset(look, stack.offset);
	}
	if (stack.softBody !== null) {
		setSoftBody(look, stack.softBody);
	}
	if (stack.cameraPull !== null) {
		params.set([stack.cameraPull, 1], EffectRow.cameraPull);
	}
	if (stack.lighting !== null) {
		params.set([1, stack.lighting.worldUp ? 1 : 0], EffectRow.offsetMode + 2);
	}
	if (stack.parallax !== null) {
		setParallax(look, stack.parallax);
	}
	if (stack.appear !== null) {
		const { appear } = stack;
		params.set([appear.inner, appear.outer, appear.alphaFar, appear.edge], EffectRow.appear);
		params.set([appear.noiseScale, appear.noiseSpeed, appear.characterHeight, 1], EffectRow.appearNoise);
		params.set(appear.brightColor, EffectRow.appearBright);
		params[EffectRow.appearVertexAlpha] = appear.brightVertexAlpha ? 1 : 0;
		params[EffectRow.appearGlobal] = appear.global ? 1 : 0;
	}
	params[EffectRow.disturbNormal] = stack.disturbNormal ? 1 : 0;
	params[EffectRow.blendVertexColor] = stack.blendVertexColor ? 1 : 0;
	params.set(
		[
			stack.unfogged ? 1 : 0,
			EffectKind.Stack,
			BLEND_MODES[stack.blendMode],
			(stack.screenUv.byDepth ? 1 : 0) +
				(stack.screenUv.heightAsV ? 2 : 0) +
				(stack.screenUv.localPivot ? 4 : 0),
		],
		EffectRow.unfogged,
	);
	return look;
};

/**
 * @param stack a texture stack
 * @returns whether it multiplies what lies behind, which the transparent pass's targets can't hold, so it
 *   draws over the composited scene instead
 */
export const multipliesScene = (stack: EffectStackSurface): boolean => stack.blendMode === 'multiply';
