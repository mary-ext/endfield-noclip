import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lengthScale, lengthTextureTransform, readAdjustLength } from './adjust-length.ts';

// the rope of int_rope_port_topright_postmodel: 0.5 m along y as authored, its colour and normal maps tiled
// along v
const rope = {
	m_Enabled: 1,
	axisDir: 1,
	presetLength: 0.5,
	useMultiRenderersEnable: 0,
	useParticleSystemLifeTimes: 0,
	useMoveTransformPositions: 0,
	useScaleTransform: 1,
	targetScaleTransforms: [{ m_FileID: 0, m_PathID: 1n }],
	useTillingOffset: 1,
	tillingOffsetConfigs: [
		{
			target: { m_FileID: 0, m_PathID: 2n },
			textureName: '_BaseColorMap',
			tillingDir: 1,
			offset: 0,
			revertScale: 0,
		},
	],
};

test('a rope set to 8.4 m stretches 16.8 times along y and tiles its texture as often', () => {
	const adjust = readAdjustLength(rope);
	assert.deepEqual(adjust.unread, []);
	assert.equal(adjust.scaleTargets.length, 1);
	assert.deepEqual(lengthScale(adjust, 8.4), [1, 8.4 / 0.5, 1]);
	const [tiling] = adjust.tilings;
	assert.equal(tiling.texture, '_BaseColorMap');
	const { scale, offset } = lengthTextureTransform({ scale: [1, 1], offset: [0, 0] }, tiling, 16.8);
	assert.deepEqual(scale, [1, 16.8]);
	assert.ok(offset[0] === 0 && offset[1] === 0);
});

test('a tiling offset moves by the stretch; reverted tiling divides', () => {
	assert.deepEqual(
		lengthTextureTransform({ scale: [2, 1], offset: [0.5, 0.25] }, { dir: 0, offset: 0.5, revert: false }, 3),
		{ scale: [6, 1], offset: [2 * 0.5 * (1 - 3), 0.25] },
	);
	assert.deepEqual(
		lengthTextureTransform({ scale: [1, 2], offset: [0, 0] }, { dir: 1, offset: 0, revert: true }, 4),
		{ scale: [1, 0.5], offset: [0, 0] },
	);
});

test('parts the reader doesn’t apply are named', () => {
	assert.deepEqual(readAdjustLength({ ...rope, useMoveTransformPositions: 1 }).unread, ['moved Transforms']);
});
