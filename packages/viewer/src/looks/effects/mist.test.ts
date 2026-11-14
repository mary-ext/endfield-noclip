import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MistCardSurface, MistVolumeSurface } from '@endfield-noclip/package-format/surfaces';

import { LookFlags } from '../look.ts';
import { materialLooks } from '../material-looks.ts';
import { described } from '../test-materials.ts';

import { MistRow } from './mist.ts';

test('mist: cards and boxes draw in the mist rows; boxes by their back faces, with their noise as the volume texture', () => {
	const card: MistCardSurface = {
		kind: 'mistCard',
		main: { texture: 1, uv: 0, scale: [1, 1], offset: [0, 0] },
		noise: { texture: 2, uv: 0, scale: [1, 1], offset: [0, 0] },
		color: [16.07, 19.84, 29.89, 1],
		baseAlphaIntensity: 2,
		noiseIntensity: 0,
		useWind: 0,
		wind: { noiseIntensity: 0, noiseContrast: 0, scale: [1, 1], speed: 0, direction: [1, 0] },
		lit: false,
		lightFactor: 0,
		indirectColor: [0.5, 0.25, 2],
		additive: true,
		distanceFade: [0.001, 0.0011],
		nearFade: [3000, 2500],
		topFade: { contrast: 1, offset: 0 },
		softDistance: 12,
		fresnel: { intensity: 0.25, contrast: 2, flip: 1 },
	};
	const box: MistVolumeSurface = {
		kind: 'mistVolume',
		color: [1, 1, 1, 1],
		exponent: 1,
		density: 4,
		edgeFade: 1,
		nearFade: 0,
		height: { offset: 0, falloff: 0, verticalFalloff: [0, 0] },
		intensityFadeDistance: 1e5,
		intensityFadeFromCentre: 0,
		depth: [0, 0],
		ignorePostExposure: 1,
		noise: {
			texture: 3,
			tiling: [0.02, 0.02, 0.02],
			world: true,
			flow: [0.5, 0, -0.5],
			nearIntensity: 0,
			farIntensity: -0.3,
			farPerMetre: 0.05,
		},
	};
	const [cardLook, boxLook, plainLook] = materialLooks({
		entries: [described(card), described(box), described({ ...box, noise: null })],
	});
	assert.deepEqual([cardLook.flags, cardLook.queue], [LookFlags.Effect, 'mist']);
	assert.deepEqual(cardLook.textures.slice(0, 2), [1, 2]);
	assert.equal(cardLook.params[MistRow.card], 2);
	assert.deepEqual(
		Array.from(cardLook.params.subarray(MistRow.color, MistRow.color + 4), (v) => Number(v.toFixed(2))),
		[16.07, 19.84, 29.89, 1],
	);
	assert.deepEqual([...cardLook.params.subarray(MistRow.indirect, MistRow.indirect + 4)], [0.5, 0.25, 2, 1]);
	assert.deepEqual(
		Array.from(cardLook.params.subarray(MistRow.fade, MistRow.fade + 4), (v) => Number(v.toFixed(4))),
		[0.001, 0.0011, 3000, 2500],
	);
	assert.equal(cardLook.params[MistRow.top + 2], 12);
	assert.deepEqual([...cardLook.params.subarray(MistRow.fresnel, MistRow.fresnel + 4)], [1, 0.25, 2, 1]);
	assert.deepEqual([boxLook.flags, boxLook.queue], [LookFlags.Effect, 'mistVolume']);
	assert.equal(boxLook.cull, 'front');
	assert.deepEqual([boxLook.params[MistRow.volume + 1], boxLook.params[MistRow.volume + 3]], [4, 0]);
	assert.equal(boxLook.volumeTexture, 3);
	assert.deepEqual(
		[...boxLook.params.subarray(MistRow.volumeNoiseFlow, MistRow.volumeNoiseFlow + 3)],
		[0.5, 0, -0.5],
	);
	assert.deepEqual(
		Array.from(boxLook.params.subarray(MistRow.volumeNoiseMix, MistRow.volumeNoiseMix + 4), (v) =>
			Number(v.toFixed(4)),
		),
		[0, -0.3, 0.05, 1],
	);
	assert.deepEqual([plainLook.volumeTexture, plainLook.params[MistRow.volumeNoiseMix + 3]], [null, 0]);
});
