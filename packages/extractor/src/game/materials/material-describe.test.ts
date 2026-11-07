import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeMaterial } from './material-describe.ts';
import type { MaterialValues, ShaderEntry, ShaderFamily } from './material-values.ts';

/** a shader without declared properties */
const shaderEntry = (
	name: string,
	family: ShaderFamily,
	overrides: Partial<ShaderEntry> = {},
): ShaderEntry => ({
	name,
	family,
	floats: {},
	colors: {},
	vectors: {},
	textures: {},
	normalMaps: [],
	...overrides,
});

/** an opaque material with no overrides */
const materialValues = (overrides: Partial<MaterialValues> = {}): MaterialValues => ({
	shader: 0,
	keywords: [],
	renderQueue: 2000,
	blend: 'opaque',
	blendFactors: null,
	alphaClipThreshold: null,
	cull: 'back',
	zWrite: true,
	baseTextureMapCount: null,
	slots: {},
	floats: {},
	colors: {},
	vectors: {},
	...overrides,
});

describe('describeMaterial', () => {
	it('leaves water proxies and reflection-only effects undrawn', () => {
		assert.equal(
			describeMaterial(materialValues(), shaderEntry('HGRP/WaterProxy', 'waterProxy')).kind,
			'undrawn',
		);
		assert.equal(
			describeMaterial(materialValues(), shaderEntry('HGRP/Effect/VFXReflectionPass', 'unknown')).kind,
			'undrawn',
		);
	});

	it('marks shaders without a family and additive surfaces unsupported, with a reason', () => {
		const unknown = describeMaterial(materialValues(), shaderEntry('HGRP/CharacterNPR', 'unknown'));
		assert.equal(unknown.kind, 'unsupported');
		const additive = describeMaterial(materialValues({ blend: 'additive' }), shaderEntry('HGRP/Lit', 'lit'));
		assert.deepEqual(additive, {
			kind: 'unsupported',
			reason: 'additive blending outside the effect shaders',
		});
	});
});
