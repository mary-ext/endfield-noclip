import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ChainDrawFlags } from '@endfield-noclip/package-format/instances';

import { chainDrawFlagsOf } from './chains.ts';

it('casts into the cascades only as a realtime caster, and into the far layer only as a static one', () => {
	const { CastsCascades, CastsStatic } = ChainDrawFlags;
	// RayTracing, Realtime, Static, the four cascades and CastShadow
	assert.equal(chainDrawFlagsOf(0x0bf8_0000), CastsCascades | CastsStatic);
	// CastShadow and RayTracing alone: no sun shadow map
	assert.equal(chainDrawFlagsOf(0x0808_0000), 0);
	// static, without the realtime flag or cascade bits
	assert.equal(chainDrawFlagsOf(0x0108_0000), CastsStatic);
	// realtime flags without CastShadow
	assert.equal(chainDrawFlagsOf(0x02f0_0000), 0);
});
