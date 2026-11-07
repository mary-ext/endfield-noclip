/**
 * steps the effect describers share (`docs/game-data/effects.md`): fades, soft blending, scrolled and turned
 * textures, dissolves and distortion
 */

import type { TextureSlot } from '@endfield-noclip/package-format/materials';
import type {
	EffectDissolve,
	EffectNearFade,
	EffectStackSurface,
	EffectTexture,
	FadeRange,
	SoftBlend,
} from '@endfield-noclip/package-format/surfaces';
import type { TextureRef } from '@endfield-noclip/package-format/textures';

import { type MaterialReader, scaleRgb } from '../material-values.ts';

/** a fade between two view depths that also works with equal ends (then a step at the start) */
export const fadeRange = (start: number, end: number): FadeRange =>
	Math.abs(end - start) < 1e-4 ? [start, start + 1e-4] : [start, end];

/** the near camera fade every effect shader shares, `null` without it */
export const nearFadeOf = ({ float }: MaterialReader): EffectNearFade | null =>
	float('_UseNearCameraFade', 0) !== 0
		? [
				float('_NearCameraFadeDistanceStart', 0),
				float('_NearCameraFadeDistanceEnd', 1),
				float('_NearCameraFadeDistanceStart2', 1e5),
				float('_NearCameraFadeDistanceEnd2', 2e5),
			]
		: null;

/** `_USE_SOFTBLEND`'s fade in front of what lies behind, `null` without it */
export const softBlendOf = ({ float, has }: MaterialReader): SoftBlend | null =>
	has('_USE_SOFTBLEND')
		? { distance: Math.max(float('_SoftDistance', 1), 1e-3), bias: float('_SoftBias', 0) }
		: null;

/** a slot an effect samples: a bound one, or an unset one whose shader samples white ({@link UNSET_WHITE}) */
export type EffectSlot = Omit<TextureSlot, 'texture'> & { texture: TextureRef };

/** an unset slot, where the shader's white default stands in */
export const UNSET_WHITE: EffectSlot = { texture: null, uv: 0, scale: [1, 1], offset: [0, 0] };

/**
 * a slot as an effect texture, with its scroll and rotation. a `*UVSpeed` vector's zw is its shift per unit
 * of a particle's custom data
 */
export const effectTexture = (
	slot: Pick<EffectSlot, 'texture' | 'scale' | 'offset'>,
	scroll: readonly number[] = [0, 0],
	rotation: [cos: number, sin: number] = [1, 0],
): EffectTexture => ({
	texture: slot.texture,
	scale: [slot.scale[0], slot.scale[1]],
	offset: [slot.offset[0], slot.offset[1]],
	scroll: [scroll[0], scroll[1]],
	rotation,
	customScroll: [scroll[2] ?? 0, scroll[3] ?? 0],
});

/** a `*UVSpeed` property: its xy scroll per second, and its zw per unit of a particle's custom data */
export const speedOf = (reader: MaterialReader, name: string): readonly number[] =>
	reader.colorOrVector(name) ?? [0, 0, 0, 0];

/** a `*UVSpeed` property's xy scroll alone, for UVs that take no custom data */
export const ownSpeedOf = (reader: MaterialReader, name: string): readonly number[] =>
	(reader.colorOrVector(name) ?? [0, 0]).slice(0, 2);

/**
 * a `*UVRotateMat` property: the shaders' UV rotations are pure rotations, so (a, b) of the matrix's first
 * column is (cos, sin)
 */
export const matrixRotationOf = (reader: MaterialReader, name: string): [cos: number, sin: number] => {
	const rotation = reader.colorOrVector(name) ?? [1, 0, 0, 1];
	return [rotation[0], rotation[1]];
};

/**
 * a rotation property's value in degrees, as the matrix with columns (cos, −sin) and (sin, cos): the shaders
 * turn UVs by `-degrees` about their centre
 */
export const degreesRotation = (degrees: number): [cos: number, sin: number] => {
	const angle = (degrees * Math.PI) / 180;
	return [Math.cos(angle), -Math.sin(angle)];
};

/**
 * a dissolve's threshold, which sweeps from below 0 to past 1 as the schedule goes from 0 to 1, and its
 * edge's sharpness
 */
export const dissolveSweepOf = ({
	float,
}: MaterialReader): Pick<EffectDissolve, 'threshold' | 'sharpness'> => ({
	threshold: float('_DissolveScheduleOffset', 0) * 2.02 - 1.01,
	sharpness: float('_DissolveEdgeSharp', 1),
});

/** a dissolve with its glowing edge, whose colour scales by `intensity` */
export const dissolveOf = (reader: MaterialReader, intensity: number): EffectDissolve => {
	const edge = reader.colorOrVector('_DissolveEmissiveColor') ?? [0, 0, 0, 0];
	return {
		...dissolveSweepOf(reader),
		edgeWidth: reader.float('_DissolveEmissiveEdge', 0),
		edgeColor: scaleRgb(edge, intensity),
	};
};

/** the u and v shifts the `n`th disturb texture distorts by */
export const disturbIntensityOf = ({ float }: MaterialReader, n: 1 | 2): [u: number, v: number] => [
	float(`_DisturbUIntensity${n}`, 0),
	float(`_DisturbVIntensity${n}`, 0),
];

/** the brightening of what's past `_ExpThreshold` */
export const brightenOf = ({ float }: MaterialReader): EffectStackSurface['brighten'] => ({
	threshold: float('_ExpThreshold', 1),
	intensity: float('_ExpIntensity', 0),
});
