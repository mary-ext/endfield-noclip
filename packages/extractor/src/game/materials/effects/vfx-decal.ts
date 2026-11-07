import type { TextureSlot } from '@endfield-noclip/package-format/materials';
import type {
	DecalParallax,
	EffectStackSurface,
	EffectUvSource,
	StackLayer,
	UnsupportedSurface,
} from '@endfield-noclip/package-format/surfaces';

import { pastUvSets, undrawnBlend, undrawnKeywords } from '../describe-steps.ts';
import { isUnsupported, type MaterialReader, unsupported } from '../material-values.ts';

import { degreesRotation, type EffectSlot, effectTexture, speedOf, UNSET_WHITE } from './effect-steps.ts';
import { stackSharedOf } from './texture-stack.ts';

/**
 * slots of a VFXDecal: each texture's role, the keyword that enables it, and the properties of its UV scroll,
 * rotation (degrees), distortion switch, UV source switch (0 the box, 1 the screen, 2 polar) and the constant
 * its speed's zw shifts by (`*CustomData`, in place of a particle's custom data). the shader runs through the
 * slots in order, so the disturb textures come before the weight and the textures they distort
 */
const DECAL_SLOTS = [
	{
		name: '_MainTex',
		role: 'main',
		keyword: null,
		speed: '_MainTexUVSpeed',
		rotate: '_MainTexUVRotate',
		disturbed: '_MainTexUseDisturb',
		source: '_MainSwitchUV',
		custom: '_MainCustomData',
	},
	{
		name: '_DisturbTex1',
		role: 'disturb1',
		keyword: '_USE_DISTURB',
		speed: '_DisturbUVSpeed1',
		rotate: null,
		disturbed: null,
		source: '_DisturbSwitchUV',
		custom: '_DisturbCustomData',
	},
	{
		name: '_DisturbTex2',
		role: 'disturb2',
		keyword: '_USE_DISTURB_TEX2',
		speed: '_DisturbUVSpeed2',
		rotate: null,
		disturbed: null,
		source: '_DisturbSwitchUV',
		custom: '_DisturbCustomData',
	},
	{
		name: '_WeightTex',
		role: 'weight',
		keyword: '_USE_WEIGHT',
		speed: null,
		rotate: null,
		disturbed: null,
		source: '_WeightSwitchUV',
		custom: null,
	},
	{
		name: '_MaskTex',
		role: 'mask',
		keyword: '_USE_MASK',
		speed: '_MaskTexUVSpeed',
		rotate: '_MaskTexUVRotate',
		disturbed: '_MaskTexUseDisturb',
		source: '_MaskSwitchUV',
		custom: '_MaskCustomData',
	},
	{
		name: '_BlendTex',
		role: 'blend',
		keyword: '_USE_BLEND',
		speed: '_BlendTexUVSpeed',
		rotate: '_BlendTexUVRotate',
		disturbed: '_BlendTexUseDisturb',
		source: '_BlendSwitchUV',
		custom: '_BlendCustomData',
	},
	{
		name: '_DissolveTex',
		role: 'dissolve',
		keyword: '_USE_DISSOLVE',
		speed: '_DissolveUVSpeed',
		rotate: '_DissolveUVRotate',
		disturbed: '_DissolveTexUseDisturb',
		source: '_DissolveSwitchUV',
		custom: '_DissolveCustomData',
	},
] as const;

/** keywords VFXDecal can have and still be drawn */
const DECAL_KEYWORDS = new Set([
	'_USE_MASK',
	'_USE_BLEND',
	'_USE_DISSOLVE',
	'_USE_DISTURB',
	'_USE_DISTURB_TEX2',
	'_USE_WEIGHT',
	'_USE_NORMALBLEND',
	'_USE_FOG',
	'_USE_POLARUV',
	'_USE_SCREENUV',
	'_USE_PARALLAX',
]);

/**
 * `_USE_PARALLAX`'s depth texture, crack mask and crack noise, in the stack slots no layer takes
 *
 * @param reader the material's properties
 * @param layers the stack's slots
 * @param sources the UV sources a switch can pick, by its value
 * @returns the parallax, `null` without the keyword, or `unsupported`
 */
const parallaxOf = (
	reader: MaterialReader,
	layers: readonly (StackLayer | null)[],
	sources: ReadonlyMap<number, EffectUvSource>,
): DecalParallax | UnsupportedSurface | null => {
	const { float, colorOrVector: color, has } = reader;
	if (!has('_USE_PARALLAX')) {
		return null;
	}
	// where the shader adds the cracks against the blend layer isn't known
	if (has('_USE_BLEND')) {
		return unsupported('parallax with a blend layer');
	}
	const free = [1, 2, 3, 4, 5, 6].filter((i) => layers[i] === null);
	if (free.length < 3) {
		return unsupported('parallax with too few free slots');
	}
	// each defaults to white, which an unset slot binds
	const bound = (name: string): EffectSlot => reader.slot(name) ?? UNSET_WHITE;
	const noiseSlot = bound('_CrackNoiseTex');
	for (const [name, slot] of [
		['_DepthTex', bound('_DepthTex')],
		['_CrackMask', bound('_CrackMask')],
		['_CrackNoiseTex', noiseSlot],
	] as const) {
		const uvSet = pastUvSets(name, slot);
		if (uvSet !== null) {
			return uvSet;
		}
	}
	// the noise scrolls after its `_ST`, so its scroll is divided by the scale the viewer applies after it
	const speed = speedOf(reader, '_CrackNoiseSpeed');
	const scroll = [0, 1].map((k) => (noiseSlot.scale[k] === 0 ? 0 : speed[k] / noiseSlot.scale[k]));
	const crackColor = color('_CrackColor') ?? [0, 0, 0, 0];
	const noiseColor = color('_CrackNoiseColor') ?? [0, 0, 0, 0];
	const intensity = float('_CrackNoiseIntensity', 1);
	return {
		scale: float('_ParallaxScale', 0),
		// the depth texture and crack mask take the main texture's UVs, so their own transforms are unused
		depthSlot: free[0],
		depth: effectTexture({ ...UNSET_WHITE, texture: bound('_DepthTex').texture }),
		crackSlot: free[1],
		crack: effectTexture({ ...UNSET_WHITE, texture: bound('_CrackMask').texture }),
		noiseSlot: free[2],
		noise: effectTexture(noiseSlot, scroll),
		noiseSource: sources.get(float('_ParallaxSwitchUV', 0)) ?? 'uv0',
		noiseDisturb: float('_ParallaxUseDisturb', 0),
		crackColor: [crackColor[0], crackColor[1], crackColor[2]],
		noiseColor: [noiseColor[0] * intensity, noiseColor[1] * intensity, noiseColor[2] * intensity],
	};
};

/**
 * `HGRP/Effect/VFXDecal`, a box projecting the texture stack onto the surfaces inside it
 *
 * @param reader the material's properties
 * @returns its surface, or `unsupported`
 */
export const describeVfxDecal = (reader: MaterialReader): EffectStackSurface | UnsupportedSurface => {
	const { float, colorOrVector: color, has } = reader;
	const undrawn =
		undrawnBlend(reader, ['premultiplied', 'additive']) ?? undrawnKeywords(reader, DECAL_KEYWORDS);
	if (undrawn !== null) {
		return undrawn;
	}
	// under `Blend One One`, `_BlendMode` 1 leaves the fog's in-scatter out, so the colour only adds
	const additive = reader.material.blend === 'additive';
	if (additive && float('_BlendMode', 0) !== 1) {
		return unsupported(`additive blending with _BlendMode ${float('_BlendMode', 0)}`);
	}
	const base = color('_DecalBaseColor') ?? [1, 1, 1, 1];
	// a texture's UV switch picks polar or screen UVs only where they're computed; the box's otherwise
	const sources = new Map<number, EffectUvSource>();
	if (has('_USE_SCREENUV') && float('_UseScreenUV', 0) !== 0) {
		sources.set(1, 'screen');
	}
	if (has('_USE_POLARUV') && float('_UsePolarUV', 0) !== 0) {
		sources.set(2, 'polar');
	}
	const layers: (StackLayer | null)[] = Array.from({ length: 7 }, () => null);
	for (const [
		i,
		{ name, role, keyword, speed, rotate, disturbed, source, custom },
	] of DECAL_SLOTS.entries()) {
		const slot = reader.slot(name);
		if (slot === undefined || (keyword !== null && !has(keyword))) {
			continue;
		}
		const uvSet = pastUvSets(name, slot);
		if (uvSet !== null) {
			return uvSet;
		}
		// the shader applies the blend texture's `_ST` twice
		const transform: Pick<TextureSlot, 'texture' | 'scale' | 'offset'> =
			role === 'blend'
				? {
						texture: slot.texture,
						scale: [slot.scale[0] * slot.scale[0], slot.scale[1] * slot.scale[1]],
						offset: [slot.offset[0] * (slot.scale[0] + 1), slot.offset[1] * (slot.scale[1] + 1)],
					}
				: slot;
		const texture = effectTexture(
			transform,
			speed === null ? [0, 0, 0, 0] : speedOf(reader, speed),
			degreesRotation(rotate === null ? 0 : float(rotate, 0)),
		);
		// off particles the shader shifts the UVs by the speed's zw times a constant of the material instead of
		// custom data, before the rotation: the same as moving the offset by the turned, scaled shift
		const k = custom === null ? 0 : float(custom, 0);
		const [c, s] = texture.rotation;
		const [u, v] = [texture.customScroll[0] * k, texture.customScroll[1] * k];
		layers[i] = {
			...texture,
			offset: [
				texture.offset[0] + (c * u - s * v) * texture.scale[0],
				texture.offset[1] + (s * u + c * v) * texture.scale[1],
			],
			customScroll: [0, 0],
			role,
			redAlpha:
				(role === 'main' && float('_UseMainTexAsAlpha', 0) !== 0) ||
				(role === 'mask' && float('_UseMaskTexAsAlpha', 0) !== 0),
			source: sources.get(float(source, 0)) ?? 'uv0',
			disturbShare: disturbed === null ? 0 : float(disturbed, 0),
		};
	}
	if (layers[0] === null) {
		return unsupported('no main texture');
	}
	const parallax = parallaxOf(reader, layers, sources);
	if (isUnsupported(parallax)) {
		return parallax;
	}
	// the dissolve edge takes the base colour's red as its intensity, as the shader reads it
	const shared = stackSharedOf(reader, base[0]);
	const weighted = has('_USE_WEIGHT');
	const intensity = float('_WeightTexIntensity', 1);
	return {
		kind: 'effectStack',
		variant: 'decal',
		layers,
		tint: [base[0], base[1], base[2], base[3] * float('_TintColorAlpha', 1)],
		blendTint: shared.blendTint,
		blendVertexColor: false,
		disturb: shared.disturb,
		disturbBias: float('_Bi_Disturb', 0),
		distorted: has('_USE_DISTURB'),
		disturbNormal: false,
		particleDisturb: false,
		// the distortion and dissolve then scale by `1 − intensity + red · intensity`
		weight: weighted
			? {
					disturb: intensity * float('_DisturbUseWeight', 1),
					dissolve: intensity * float('_DissolveUseWeight', 0),
					used: true,
				}
			: { disturb: 0, dissolve: 0, used: false },
		dissolve: has('_USE_DISSOLVE') ? shared.dissolve : null,
		masked: has('_USE_MASK'),
		maskAlphaOnly: false,
		fresnel: null,
		soft: null,
		ignorePostExposure: shared.ignorePostExposure,
		vertexColor: false,
		near: shared.near,
		brighten: { threshold: 0, intensity: 0 },
		breathing: null,
		edge: null,
		decalFade: {
			edge: [float('_EdgeFadeX', 0), float('_EdgeFadeZ', 0)],
			width: float('_EdgeFadeIntensity', 0),
			height: Math.max(float('_HeightFade', 0), 1e-3),
			heightOffset: float('_HeightFadeOffset', 0),
			angle: has('_USE_NORMALBLEND') ? float('_AngleBlendFallOff', 1) : 0,
		},
		alphaPower: 1,
		offset: null,
		softBody: null,
		cameraPull: null,
		waterBlendBelow: null,
		lighting: null,
		unfogged: !has('_USE_FOG'),
		blendMode: additive ? 'add' : 'over',
		opaque: false,
		screenUv: { localPivot: false, byDepth: false, heightAsV: false },
		stencil: null,
		appear: null,
		parallax,
	};
};
