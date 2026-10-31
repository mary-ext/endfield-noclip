import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';

import { frozenParticleMatrix } from './particle-mesh.ts';

const constant = (value: number) => ({ minMaxState: 0, scalar: value, minScalar: 0 });
const between = (min: number, max: number) => ({ minMaxState: 3, scalar: max, minScalar: min });

const system = ({
	initial = {},
	...overrides
}: { initial?: Record<string, unknown> } & Record<string, unknown> = {}): TypeTreeObject => ({
	ringBufferMode: 1,
	playOnAwake: true,
	scalingMode: 1,
	InitialModule: {
		maxNumParticles: 1,
		size3D: true,
		rotation3D: true,
		startSize: constant(12),
		startSizeY: constant(12),
		startSizeZ: constant(7),
		startRotationX: constant(0),
		startRotationY: constant(0),
		startRotation: between(0, Math.PI),
		...initial,
	},
	ShapeModule: { enabled: true, type: 5, m_Position: { x: 0, y: 0, z: 0 } },
	...overrides,
});

const renderer = (alignment: number): TypeTreeObject => ({ m_RenderMode: 4, m_RenderAlignment: alignment });

const emitter = { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [2, 1, 1] };

const round = (v: number) => Math.round(v * 1000) / 1000 + 0;

test('a frozen mesh particle sits at the emitter with its start size, scaled by the emitter, and its mid start rotation', () => {
	const m = frozenParticleMatrix(system(), renderer(4), emitter);
	assert.ok(m !== null);
	// a quarter turn about z at the midpoint of 0…π maps x to y; the emitter's scale stretches its own x
	assert.deepEqual(Array.from(m.subarray(0, 3), round), [0, 12, 0]);
	assert.deepEqual(Array.from(m.subarray(4, 7), round), [-24, 0, 0]);
	assert.deepEqual(Array.from(m.subarray(8, 11), round), [0, 0, 7]);
	assert.deepEqual(Array.from(m.subarray(12, 15)), [1, 2, 3]);
});

test('mesh particles that die, multiply, face the camera, follow curves or flip through a sheet are not frozen', () => {
	assert.equal(frozenParticleMatrix(system({ ringBufferMode: 0 }), renderer(4), emitter), null);
	assert.equal(frozenParticleMatrix(system({ UVModule: { enabled: true } }), renderer(1), emitter), null);
	assert.notEqual(frozenParticleMatrix(system({ UVModule: { enabled: false } }), renderer(1), emitter), null);
	assert.equal(frozenParticleMatrix(system(), renderer(0), emitter), null);
	assert.equal(frozenParticleMatrix(system(), { m_RenderMode: 0, m_RenderAlignment: 1 }, emitter), null);
	assert.equal(frozenParticleMatrix(system({ initial: { maxNumParticles: 5 } }), renderer(1), emitter), null);
	const curve = { minMaxState: 1, scalar: 1, minScalar: 0 };
	assert.equal(frozenParticleMatrix(system({ initial: { startSize: curve } }), renderer(1), emitter), null);
});
