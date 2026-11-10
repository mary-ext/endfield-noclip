import assert from 'node:assert/strict';
import { test } from 'node:test';

import { trsMatrix, unityEulerQuaternion } from '@endfield-noclip/formats/unity/transform';

import { lightColor, placePrefabLight, type PrefabLight } from './prefab-lights.ts';

const close = (actual: readonly number[], expected: readonly number[], epsilon = 1e-4) => {
	assert.equal(actual.length, expected.length);
	for (const [i, value] of actual.entries()) {
		assert.ok(Math.abs(value - expected[i]) < epsilon, `[${i}] ${value} ≠ ${expected[i]}`);
	}
};

test('light colours are the linear colour times intensity and the temperature tint', () => {
	// sRGB 0.5 is linear 0.21404
	close(lightColor([0.5, 1, 0], 2, null), [0.42808, 2, 0]);
	// below the 6570 K pivot red stays whole, above it blue does
	close(lightColor([1, 1, 1], 1, 1900), [1, 0.23255, 0.00628]);
	close(lightColor([1, 1, 1], 1, 8000), [0.76165, 0.81258, 1]);
	// out-of-range temperatures clamp to 1000 K
	close(lightColor([1, 1, 1], 1, 500), lightColor([1, 1, 1], 1, 1000));
});

test('placed prefab lights take the placement, and their culling boxes turn with it', () => {
	const prefab: PrefabLight = {
		name: 'Spot Light',
		// one metre along x, pointing down
		matrix: trsMatrix([1, 0, 0], unityEulerQuaternion([90, 0, 0]), [1, 1, 1]),
		light: {
			name: 'Spot Light',
			type: 0,
			color: [1, 1, 1],
			intensity: 1,
			range: 10,
			spotAngle: 90,
			innerSpotAngle: 30,
			bakeType: 4,
			specularIntensity: 1,
			shadowOnly: false,
			characterOnly: false,
			tubeLength: 0,
			softSourceRadius: 0,
			falloffExponent: -1,
			volumetricScatteringIntensity: 0,
			priority: 0,
			distanceFade: null,
			cullingBox: { offset: [2, 0, 0], halfExtents: [3, 1, 1], rotation: [0, 0, 0], falloffThreshold: 0.8 },
			shadows: 0,
			shadowStrength: 1,
			shadowNormalBias: 0.4,
			shadowNearPlane: 0.2,
			shadowFarPlane: 10,
			shadowCullDistance: 50,
			shadowFadeRatio: 0.8,
			shadowGuardAngle: 0,
			shadowCasterFaces: -1,
			shadowCasterProperties: 6,
		},
	};
	const id = ((3 << 27) | 0x7ffffff) >>> 0;
	const light = placePrefabLight(
		prefab,
		{ position: [10, 5, 20], rotation: unityEulerQuaternion([0, 90, 0]), scale: [1, 1, 1] },
		id,
	);
	assert.equal(light.id, id);
	assert.equal(light.levelTag, 3);
	// a quarter turn of yaw takes +x to −z
	close(light.position, [10, 5, 19]);
	close(light.direction, [0, -1, 0]);
	close(light.cullingBox?.offset ?? [], [0, 0, -2]);
	close(light.cullingBox?.rotation ?? [], [0, 90, 0]);
	assert.deepEqual(light.cullingBox?.halfExtents, [3, 1, 1]);
});
