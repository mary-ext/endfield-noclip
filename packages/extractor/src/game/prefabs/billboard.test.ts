import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { multiplyMatrices, trsMatrix, unityEulerQuaternion } from '@endfield-noclip/formats/unity/transform';
import type { Aabb } from '@endfield-noclip/formats/unity/values';
import { ChainFlags } from '@endfield-noclip/package-format/instances';

import { billboardPlacement, readBillboard } from './billboard.ts';

const near = (actual: ArrayLike<number>, expected: ArrayLike<number>) => {
	assert.equal(actual.length, expected.length);
	for (let i = 0; i < expected.length; i++) {
		assert.ok(Math.abs(actual[i] - expected[i]) < 1e-5, `[${i}] ${actual[i]} ≠ ${expected[i]}`);
	}
};

const component = (mode: number, rotation = { x: 0, y: 0, z: 0 }, enabled = 1) => ({
	m_Enabled: enabled,
	rotateInLateTick: 0,
	billboardMode: mode,
	rotation,
});

describe('readBillboard', () => {
	const frame = trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);

	it('faces the camera in mode 0 and turns upright in modes 1 to 3', () => {
		assert.equal(readBillboard(component(0), frame)?.flag, ChainFlags.BillboardFacing);
		for (const mode of [1, 2, 3]) {
			assert.equal(readBillboard(component(mode), frame)?.flag, ChainFlags.BillboardUpright);
		}
	});

	it('keeps the offset rotation except where the mode has none', () => {
		const rotation = { x: 25, y: 0, z: 0 };
		near(readBillboard(component(0, rotation), frame)!.offset, unityEulerQuaternion([25, 0, 0]));
		near(readBillboard(component(2, rotation), frame)!.offset, [0, 0, 0, 1]);
	});

	it('ignores disabled components and unknown modes', () => {
		assert.equal(readBillboard(component(0, undefined, 0), frame), null);
		assert.equal(readBillboard(component(7), frame), null);
	});
});

describe('billboardPlacement', () => {
	const local: Aabb = { center: [0, 0.5, 0], extents: [0.5, 0.5, 0] };

	it('stores the offset times the scale at the authored position, dropping the authored rotation', () => {
		const authored = trsMatrix([10, 2, -4], unityEulerQuaternion([0, 90, 0]), [2, 3, 1]);
		const offset = unityEulerQuaternion([90, 0, 0]);
		const { matrix } = billboardPlacement(authored, authored, offset, local);
		near(matrix, trsMatrix([10, 2, -4], offset, [2, 3, 1]));
	});

	it('keeps a child renderer relative to the billboard it hangs under', () => {
		const frame = trsMatrix([0, 0, 0], unityEulerQuaternion([0, 45, 0]), [1, 1, 1]);
		const child = multiplyMatrices(frame, trsMatrix([0, 0, 0], unityEulerQuaternion([0, 0, 30]), [1, 1, 1]));
		const { matrix } = billboardPlacement(child, frame, [0, 0, 0, 1], local);
		near(matrix, trsMatrix([0, 0, 0], unityEulerQuaternion([0, 0, 30]), [1, 1, 1]));
	});

	it('bounds every orientation with a cube about the origin', () => {
		const authored = trsMatrix([1, 2, 3], [0, 0, 0, 1], [2, 2, 2]);
		const { bounds } = billboardPlacement(authored, authored, [0, 0, 0, 1], local);
		near(bounds.center, [1, 2, 3]);
		// the mesh reaches from 1 m above the origin, ±1 m across and 1 m high
		const reach = 1 + Math.hypot(1, 1, 0);
		near(bounds.extents, [reach, reach, reach]);
	});
});
