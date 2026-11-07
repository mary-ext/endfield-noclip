import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emptyLook, LookFlags, type MaterialLook } from '../../looks/look.ts';
import type { TextureBinding } from '../textures/texture-store.ts';

import { drawRangeOf } from './draw-order.ts';

const look = (fields: Partial<MaterialLook>): MaterialLook => ({ ...emptyLook({ drawn: true }), ...fields });

const bound = { version: 0 } as TextureBinding;

const ready = { slots: [bound], alphaReady: true, complete: true };

test('a look draws in its queue, alpha-tested ones as opaque until their alpha is bound', () => {
	const context = { castOnly: false, stencil: true, state: ready };
	assert.equal(drawRangeOf(look({ queue: 'transparent' }), context), 'transparent');
	assert.equal(drawRangeOf(look({ queue: 'cutout' }), context), 'cutout');
	assert.equal(
		drawRangeOf(look({ queue: 'cutout' }), { ...context, state: { ...ready, alphaReady: false } }),
		'opaque',
	);
});

test('effects wait for all their textures, unlit looks for their base colour', () => {
	const effect = look({ queue: 'refract', flags: LookFlags.Effect, castsShadows: false });
	const waiting = {
		castOnly: false,
		stencil: true,
		state: { slots: [null], alphaReady: false, complete: false },
	};
	assert.equal(drawRangeOf(effect, { ...waiting, state: ready }), 'refract');
	assert.equal(drawRangeOf(effect, waiting), null);
	const unlit = look({ flags: LookFlags.Unlit, textures: [3, null, null, null, null, null, null] });
	assert.equal(drawRangeOf(unlit, waiting), null);
	assert.equal(drawRangeOf(unlit, { ...waiting, state: ready }), 'opaque');
});

test('cast-only buckets draw only shadow-casting surfaces, and stencil looks need a stencil', () => {
	const castOnly = { castOnly: true, stencil: false, state: ready };
	assert.equal(drawRangeOf(look({}), castOnly), 'opaque');
	assert.equal(drawRangeOf(look({ castsShadows: false }), castOnly), null);
	assert.equal(drawRangeOf(look({ queue: 'transparent' }), castOnly), null);
	const mask = look({
		queue: 'stencilMask',
		castsShadows: false,
		stencil: {
			compare: 'always',
			replace: true,
			reference: 1,
			readMask: 255,
			writeMask: 255,
			depthCompare: 'greater',
		},
	});
	assert.equal(drawRangeOf(mask, { ...castOnly, castOnly: false }), null);
	assert.equal(drawRangeOf(mask, { castOnly: false, stencil: true, state: ready }), 'stencilMask');
});
