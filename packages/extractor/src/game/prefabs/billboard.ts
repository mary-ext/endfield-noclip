import {
	transformBounds,
	unityEulerQuaternion,
	trsMatrix,
	multiplyMatrices,
} from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { booleanField, numberField, objectField, type Aabb } from '@endfield-noclip/formats/unity/values';
import { ChainFlags } from '@endfield-noclip/package-format/instances';

import type { ObjectRef } from '../assets/assets.ts';

/**
 * a `VFXBillBoard` component (HG's effect billboard), which turns its GameObject, and so everything under it,
 * towards the camera every frame
 */
export interface PrefabBillboard {
	/** `ChainFlags.BillboardFacing` or `ChainFlags.BillboardUpright` */
	flag: number;
	/** the rotation kept relative to the camera's (xyzw); identity for modes that have none */
	offset: [number, number, number, number];
	/** the billboard GameObject's matrix in prefab space (column-major) */
	frame: Float32Array;
}

/** the game's `VFXBillBoard.BillboardMode` */
const BillboardMode = {
	/** the camera's rotation times the offset */
	Billboard: 0,
	/** the camera's heading (Euler y) added to the offset's */
	VerticalBillboard: 1,
	/** forward along the camera's forward with the component along the authored up axis removed; no offset */
	LockUpAxis: 2,
	/** as `LockUpAxis` about the parent's up axis, times the offset */
	ParentUpAxis: 3,
} as const;

/**
 * @param ref a MonoBehaviour
 * @returns whether its serialized fields are a `VFXBillBoard`'s, without reading the object
 */
export const isBillboardType = (ref: ObjectRef): boolean => {
	const names = new Set(ref.info.type?.nodes.filter((node) => node.level === 1).map((node) => node.name));
	return names.has('billboardMode') && names.has('rotateInLateTick') && names.has('rotation');
};

/**
 * reads an enabled `VFXBillBoard`. modes 2 and 3 turn about an up axis the viewer takes as the world's
 * vertical, which it is on upright placements
 *
 * @param data the component's fields (see {@link isBillboardType})
 * @param frame its GameObject's matrix in prefab space
 * @returns the billboard, or `null` when the component is disabled or its mode is unknown
 */
export const readBillboard = (data: TypeTreeObject, frame: Float32Array): PrefabBillboard | null => {
	if (!booleanField(data, 'm_Enabled')) {
		return null;
	}
	const rotation = objectField(data, 'rotation');
	const offset = unityEulerQuaternion([
		numberField(rotation, 'x'),
		numberField(rotation, 'y'),
		numberField(rotation, 'z'),
	]);
	switch (numberField(data, 'billboardMode')) {
		case BillboardMode.Billboard: {
			return { flag: ChainFlags.BillboardFacing, offset, frame };
		}
		case BillboardMode.VerticalBillboard:
		case BillboardMode.ParentUpAxis: {
			return { flag: ChainFlags.BillboardUpright, offset, frame };
		}
		case BillboardMode.LockUpAxis: {
			return { flag: ChainFlags.BillboardUpright, offset: [0, 0, 0, 1], frame };
		}
		default: {
			return null;
		}
	}
};

/**
 * the stored transform and bounds of a renderer under a billboard. the game sets the billboard's world
 * rotation to the camera's times the offset, carrying the renderers below it along. the stored rotation is
 * that offset times the renderer's rotation relative to the billboard, about the renderer's own origin, so a
 * renderer away from the billboard's origin turns in place rather than swinging around it
 *
 * @param matrix the renderer's world matrix as authored
 * @param frame the billboard GameObject's world matrix as authored
 * @param offset the billboard's offset rotation
 * @param local the mesh's local bounds
 * @returns the matrix to store, and bounds centred on its origin that hold every orientation
 */
export const billboardPlacement = (
	matrix: Float32Array,
	frame: Float32Array,
	offset: readonly number[],
	local: Aabb,
): { matrix: Float32Array; bounds: Aabb } => {
	// the billboard's authored rotation, its axes with the scale taken out, inverted by transposing
	const inverse = new Float32Array(16);
	for (let c = 0; c < 3; c++) {
		const length = Math.hypot(frame[c * 4], frame[c * 4 + 1], frame[c * 4 + 2]) || 1;
		for (let r = 0; r < 3; r++) {
			inverse[r * 4 + c] = frame[c * 4 + r] / length;
		}
	}
	inverse[15] = 1;
	const linear = new Float32Array(matrix);
	linear[12] = 0;
	linear[13] = 0;
	linear[14] = 0;
	const stored = multiplyMatrices(trsMatrix([0, 0, 0], offset, [1, 1, 1]), multiplyMatrices(inverse, linear));
	stored[12] = matrix[12];
	stored[13] = matrix[13];
	stored[14] = matrix[14];
	const turned = transformBounds(local, stored);
	const reach =
		Math.hypot(turned.center[0] - stored[12], turned.center[1] - stored[13], turned.center[2] - stored[14]) +
		Math.hypot(...turned.extents);
	return {
		matrix: stored,
		bounds: { center: [stored[12], stored[13], stored[14]], extents: [reach, reach, reach] },
	};
};
