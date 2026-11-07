import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { overriddenEmission, readEmissiveOverride } from './emissive-override.ts';

// the water drone targets' component (int_waterdrone_floating_target_postmodel) and material
// (M_anm_map02_machine+1_003_02, `_EMISSIVE_ANIM_SWEEP`)
const TARGET = {
	m_Enabled: 1,
	affectRenderers: [
		{ m_FileID: 0, m_PathID: 6008603127270556715n },
		{ m_FileID: 0, m_PathID: -582741042123488213n },
	],
	affectEntityRenderHelper: { m_FileID: 0, m_PathID: 0n },
	emissiveColor: { r: 0, g: 1, b: 0.16790390014648438, a: 1 },
	emissiveAlbedoColor: { r: 1, g: 0.04339611530303955, b: 0.04339611530303955, a: 0 },
	breathFrequency: 0,
	breathIntensity: 0,
};

describe('readEmissiveOverride', () => {
	it('reads the listed renderers and the resting colour', () => {
		const read = readEmissiveOverride(TARGET);
		assert.equal(read.renderers.length, 2);
		assert.deepEqual(read.color, [0, 1, 0.16790390014648438, 1]);
	});
});

describe('overriddenEmission', () => {
	it('replaces a black emission colour by the override at alpha 1, keeping the sweep depth', () => {
		assert.deepEqual(overriddenEmission([0, 0, 0, 0], [0, 1, 0.25, 1]), [0, 1, 0.25, 0]);
		assert.deepEqual(overriddenEmission([2, 2, 2, 1], [0, 1, 0.25, 1]), [0, 1, 0.25, 1]);
	});

	it('mixes by the override alpha', () => {
		assert.deepEqual(overriddenEmission([2, 0, 0, 0.5], [0, 2, 0, 0.5]), [1, 1, 0, 0.5]);
	});
});
