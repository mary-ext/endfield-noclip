import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LightBeamSurface } from '@endfield-noclip/package-format/surfaces';

import { LookFlags } from '../look.ts';
import { materialLooks } from '../material-looks.ts';
import { described } from '../test-materials.ts';

import { EffectKind, EffectRow } from './effect-look.ts';
import { BeamRow } from './light-beam.ts';

test('a light beam is a shadowless effect with its cone, falloff and colour in the beam rows', () => {
	// dung02_dg005's `VLB_5006340546849160366`, one of the Wuling rift's two great beams
	const beam: LightBeamSurface = {
		kind: 'lightBeam',
		color: [0.1708, 0.3, 1, 1],
		cone: [1, 1.00087571, 0.99999994, 0.0002919],
		direction: [0, 0, 1, 0],
		falloff: [1, 3, 3, 0],
		alphaInside: 0.15,
		alphaOutside: 0.15,
		attenuationLerp: 1,
		fresnelPower: 2,
		glareFrontal: 0.5,
		glareBehind: 0.5,
		apexOffset: 0,
		additive: true,
		distanceFade: [256, 200],
		distanceFadeSecond: [0, 0.0001],
		cameraClipping: 0.5,
		depthBlend: 22,
		depthBlendCapOff: 0,
		useClippingPlane: 0,
		clippingPlane: [0, 1, 0, 0],
		tilt: [0, 0],
		clippingPlaneTransition: 1,
		unfogged: true,
	};
	const [look, fogged] = materialLooks({
		entries: [described(beam), described({ ...beam, additive: false, unfogged: false })],
	});
	assert.deepEqual(
		[look.unsupported, look.queue, look.castsShadows, look.cull],
		[false, 'effect', false, 'back'],
	);
	assert.notEqual(look.flags & LookFlags.Effect, 0);
	assert.equal(look.params[EffectRow.unfogged + 1], EffectKind.Beam);
	assert.deepEqual([look.params[EffectRow.unfogged + 2], look.params[BeamRow.glare + 3]], [1, 1]);
	assert.deepEqual([...look.params.subarray(BeamRow.falloff, BeamRow.falloff + 4)], [1, 3, 3, 0]);
	assert.ok(Math.abs(look.params[BeamRow.cone + 1] - 1.00087571) < 1e-6);
	assert.equal(look.params[BeamRow.clip + 1], 22);
	assert.deepEqual([fogged.params[EffectRow.unfogged], fogged.params[EffectRow.unfogged + 2]], [0, 0]);
});
