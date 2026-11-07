import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { MaterialTextureSlot } from '@endfield-noclip/formats/unity/material';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	asPPtr,
	booleanField,
	isObject,
	numberField,
	pptrField,
	stringField,
	type PPtr,
} from '@endfield-noclip/formats/unity/values';

import type { ObjectRef } from '../assets/assets.ts';

// the effect-length component (`VFXAdjustLength`) a view state's length behaviour sets, and the position
// follower that can hang something off its end. rules: docs/game-data/interactives.md#lengths-view-states-set

/** `VFXAdjustLength.TillingDir`: which UV axis a texture's tiling stretches along */
const TilingDir = {
	U: 0,
	V: 1,
} as const;

/** a texture whose tiling follows the length */
export interface LengthTiling {
	/** the renderer whose property block takes the tiling */
	renderer: PPtr;
	/** the texture property, such as `_BaseColorMap` */
	texture: string;
	/** `VFXAdjustLength.TillingDir` */
	dir: number;
	offset: number;
	/** tiles by the inverse ratio */
	revert: boolean;
}

/** a `VFXAdjustLength`, with the parts that change when its length is set */
export interface AdjustLength {
	/** `VFXAdjustLength.AxisDir`: 0 x, 1 y, 2 z */
	axis: number;
	/** the length as authored: a set length scales by its ratio to this */
	preset: number;
	/** Transforms whose local scale becomes the ratio along {@link axis} */
	scaleTargets: PPtr[];
	tilings: LengthTiling[];
	/** parts set that this reader doesn't apply */
	unread: string[];
}

/**
 * @param ref a MonoBehaviour
 * @returns whether its serialized fields are a `VFXAdjustLength`'s, without reading the object
 */
export const isAdjustLengthType = (ref: ObjectRef): boolean => {
	const names = new Set(ref.info.type?.nodes.filter((node) => node.level === 1).map((node) => node.name));
	return names.has('presetLength') && names.has('axisDir') && names.has('targetScaleTransforms');
};

/**
 * @param ref a MonoBehaviour
 * @returns whether its serialized fields are a `PositionFollower`'s, which moves its GameObject to another's
 *   world position every frame
 */
export const isPositionFollowerType = (ref: ObjectRef): boolean => {
	const names = new Set(ref.info.type?.nodes.filter((node) => node.level === 1).map((node) => node.name));
	return names.has('source') && names.has('positionThreshold');
};

/**
 * @param data a `VFXAdjustLength`'s fields (see {@link isAdjustLengthType})
 * @returns what setting its length changes
 * @throws {FormatError} on an unknown axis or a preset length that isn't positive
 */
export const readAdjustLength = (data: TypeTreeObject): AdjustLength => {
	const axis = numberField(data, 'axisDir');
	const preset = numberField(data, 'presetLength');
	if (axis !== 0 && axis !== 1 && axis !== 2) {
		throw new FormatError(`unknown VFXAdjustLength axis ${axis}`);
	}
	if (!(preset > 0)) {
		throw new FormatError(`VFXAdjustLength preset length ${preset}`);
	}
	const unread: string[] = [];
	for (const [flag, name] of [
		['useMultiRenderersEnable', 'renderer bounds'],
		['useParticleSystemLifeTimes', 'particle lifetimes'],
		['useMoveTransformPositions', 'moved Transforms'],
	] as const) {
		if (booleanField(data, flag)) {
			unread.push(name);
		}
	}
	const scaleTargets = booleanField(data, 'useScaleTransform')
		? arrayField(data, 'targetScaleTransforms').map((pointer) => asPPtr(pointer))
		: [];
	const tilings = booleanField(data, 'useTillingOffset')
		? arrayField(data, 'tillingOffsetConfigs').map((config): LengthTiling => {
				if (!isObject(config)) {
					throw new FormatError('invalid VFXAdjustLength tiling');
				}
				return {
					renderer: pptrField(config, 'target'),
					texture: stringField(config, 'textureName'),
					dir: numberField(config, 'tillingDir'),
					offset: numberField(config, 'offset'),
					revert: booleanField(config, 'revertScale'),
				};
			})
		: [];
	return { axis, preset, scaleTargets, tilings, unread };
};

/**
 * @param adjust the component
 * @param length the length set
 * @returns the local scale its scale targets take: the ratio to the preset along its axis, 1 on the others
 */
export const lengthScale = (adjust: AdjustLength, length: number): [number, number, number] => {
	const scale: [number, number, number] = [1, 1, 1];
	scale[adjust.axis] = length / adjust.preset;
	return scale;
};

/**
 * @param slot the material's own scale and offset for the texture
 * @param tiling how the texture follows the length
 * @param ratio the length over the preset
 * @returns the scale and offset the property block sets: along the tiling's axis the scale is multiplied by
 *   the ratio and the offset becomes `scale · offset · (1 − ratio)`; the other axis keeps the material's
 * @throws {FormatError} on an unknown tiling axis
 */
export const lengthTextureTransform = (
	slot: Pick<MaterialTextureSlot, 'scale' | 'offset'>,
	tiling: Pick<LengthTiling, 'dir' | 'offset' | 'revert'>,
	ratio: number,
): Pick<MaterialTextureSlot, 'scale' | 'offset'> => {
	const k = tiling.revert ? 1 / ratio : ratio;
	const scale: [number, number] = [...slot.scale];
	const offset: [number, number] = [...slot.offset];
	switch (tiling.dir) {
		case TilingDir.U:
		case TilingDir.V: {
			const axis = tiling.dir;
			offset[axis] = slot.scale[axis] * tiling.offset * (1 - k);
			scale[axis] = slot.scale[axis] * k;
			return { scale, offset };
		}
		default: {
			throw new FormatError(`unknown VFXAdjustLength tiling axis ${tiling.dir}`);
		}
	}
};
