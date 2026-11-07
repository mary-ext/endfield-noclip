import assert from 'node:assert/strict';
import { test } from 'node:test';

import { multiplyMatrices, trsMatrix } from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';

import {
	axisLengths,
	frozenParticleMatrix,
	meshParticlePivot,
	particleEmitterMatrix,
	particleMeshSize,
	particleStandInMatrix,
	withAxisLengths,
} from './particle-mesh.ts';

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

const ZERO = { x: 0, y: 0, z: 0 };
const UNIT_MESH = [1, 1, 1];

const renderer = (alignment: number): TypeTreeObject => ({
	m_RenderMode: 4,
	m_RenderAlignment: alignment,
	m_Pivot: ZERO,
});

const emitter = { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [2, 1, 1] };

const round = (v: number) => Math.round(v * 1000) / 1000 + 0;

const identity = trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);

test('a frozen mesh particle sits at the emitter with its start size, scaled by the emitter, and its mid start rotation', () => {
	const m = frozenParticleMatrix(system(), renderer(4), identity, emitter, UNIT_MESH);
	assert.ok(m !== null);
	// a quarter turn about z at the midpoint of 0…π maps x to y; the emitter's scale stretches its own x
	assert.deepEqual(Array.from(m.subarray(0, 3), round), [0, 12, 0]);
	assert.deepEqual(Array.from(m.subarray(4, 7), round), [-24, 0, 0]);
	assert.deepEqual(Array.from(m.subarray(8, 11), round), [0, 0, 7]);
	assert.deepEqual(Array.from(m.subarray(12, 15)), [1, 2, 3]);
});

test('mesh particles that die, multiply, face the camera, follow curves or flip through a sheet are not frozen', () => {
	assert.equal(
		frozenParticleMatrix(system({ ringBufferMode: 0 }), renderer(4), identity, emitter, UNIT_MESH),
		null,
	);
	assert.equal(
		frozenParticleMatrix(system({ UVModule: { enabled: true } }), renderer(1), identity, emitter, UNIT_MESH),
		null,
	);
	assert.notEqual(
		frozenParticleMatrix(system({ UVModule: { enabled: false } }), renderer(1), identity, emitter, UNIT_MESH),
		null,
	);
	assert.equal(frozenParticleMatrix(system(), renderer(0), identity, emitter, UNIT_MESH), null);
	assert.equal(
		frozenParticleMatrix(
			system(),
			{ m_RenderMode: 0, m_RenderAlignment: 1, m_Pivot: ZERO },
			identity,
			emitter,
			UNIT_MESH,
		),
		null,
	);
	assert.equal(
		frozenParticleMatrix(
			system({ initial: { maxNumParticles: 5 } }),
			renderer(1),
			identity,
			emitter,
			UNIT_MESH,
		),
		null,
	);
	const curve = {
		minMaxState: 1,
		scalar: 1,
		minScalar: 0,
		maxCurve: { m_Curve: [], m_PreInfinity: 2, m_PostInfinity: 2 },
	};
	assert.equal(
		frozenParticleMatrix(
			system({ initial: { startSize: curve } }),
			renderer(1),
			identity,
			emitter,
			UNIT_MESH,
		),
		null,
	);
});

test('a stand-in takes the scale the game sizes particles by, not a parent that stretches the spawn box', () => {
	// the Jingyu bird flock's parent scales its box shape 363 × 150 × 148 m
	const parent = trsMatrix([-19.6, 0, 93.2], [0, 0, 0, 1], [363, 150, 148]);
	const local = { position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [2, 2, 2] };
	const axes = (m: Float32Array) => [m[0], m[5], m[10]].map(round);
	const shape = particleStandInMatrix(parent, local, 2);
	assert.deepEqual(axes(shape), [1, 1, 1]);
	assert.deepEqual(Array.from(shape.subarray(12, 15), round), [-19.6, 150, 93.2]);
	assert.deepEqual(axes(particleStandInMatrix(parent, local, 1)), [2, 2, 2]);
	assert.deepEqual(axes(particleStandInMatrix(parent, local, 0)), [726, 300, 296]);
});

test('a placement scale moves a stand-in sized on its own without sizing it', () => {
	// Jingyu's drifting petals (p_fxmap_map02_lv001_flower_801) are placed 52× to spread their box over the
	// valley, and their Shape scaling keeps each petal its own size
	const placement = trsMatrix([-925, 183, -1733], [0, 0, 0, 1], [52, 52, 52]);
	const standIn = particleStandInMatrix(
		trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]),
		{ position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
		2,
	);
	const placed = withAxisLengths(multiplyMatrices(placement, standIn), axisLengths(standIn));
	assert.deepEqual(axisLengths(placed).map(round), [1, 1, 1]);
	assert.deepEqual(Array.from(placed.subarray(12, 15), round), [-925, 235, -1733]);
});

test('a frozen particle under a scaled parent is sized and placed as its scaling mode sizes and moves particles', () => {
	const parent = trsMatrix([10, 0, 0], [0, 0, 0, 1], [4, 4, 4]);
	const shape = { enabled: true, type: 5, m_Position: { x: 1, y: 0, z: 0 } };
	const unrotated = { startRotation: constant(0) };
	const placed = (scalingMode: number) =>
		frozenParticleMatrix(
			system({ scalingMode, ShapeModule: shape, initial: unrotated }),
			renderer(2),
			parent,
			emitter,
			UNIT_MESH,
		);
	const columns = (m: Float32Array | null) => [m![0], m![5], m![10], m![12]].map(round);
	// Hierarchy: the parent's 4 and the emitter's 2 × 1 × 1 size it, and the shape's centre moves 4 × 2 m out
	assert.deepEqual(columns(placed(0)), [96, 48, 28, 22]);
	// Local: only the emitter's own scale sizes it and moves the centre from where the parent puts the emitter
	assert.deepEqual(columns(placed(1)), [24, 12, 7, 16]);
	// Shape: the start size alone, though the hierarchy's scale still moves the shape's centre
	assert.deepEqual(columns(placed(2)), [12, 12, 7, 22]);
});

test('world-aligned frozen particles keep the world axes under a turned parent', () => {
	const turned = trsMatrix([0, 0, 0], [0, 0, Math.SQRT1_2, Math.SQRT1_2], [1, 1, 1]);
	const m = frozenParticleMatrix(
		system({ initial: { startRotation: constant(0) } }),
		renderer(1),
		turned,
		emitter,
		UNIT_MESH,
	);
	assert.deepEqual(Array.from(m!.subarray(0, 3), round), [24, 0, 0]);
});

test('a played Local-mode emitter drops the parent scale, others keep the whole hierarchy scale', () => {
	const parent = trsMatrix([0, 0, 0], [0, 0, 0, 1], [3, 3, 3]);
	const local = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [2, 2, 2] };
	assert.equal(round(particleEmitterMatrix(parent, local, 0)[0]), 6);
	assert.equal(round(particleEmitterMatrix(parent, local, 1)[0]), 2);
	assert.equal(round(particleEmitterMatrix(parent, local, 2)[0]), 6);
});

test('a mesh particle pivot is measured in the mesh size, twice its bounds reach from the origin', () => {
	// Dijiang's robot lamp eyes: a 0.1 m plane (P_fxmap_common_robot_lamp_802, eye_normal_blink_01_01)
	const plane = particleMeshSize({ center: [0, 0, 0], extents: [0.05, 0.05, 0] });
	assert.deepEqual(plane.map(round), [0.1, 0.1, 0]);
	assert.deepEqual(meshParticlePivot([0.95, 0, 0], plane).map(round), [0.095, 0, 0]);
	// an off-centre mesh reaches farther on the side its centre sits
	assert.deepEqual(particleMeshSize({ center: [0, -1, 0], extents: [1, 2, 3] }), [2, 6, 6]);
});

test('a frozen mesh particle is moved by its pivot within its turned, sized frame', () => {
	const m = frozenParticleMatrix(
		system({ initial: { startRotation: constant(0) } }),
		{ m_RenderMode: 4, m_RenderAlignment: 2, m_Pivot: { x: 0.5, y: 0, z: 0 } },
		identity,
		emitter,
		[0.1, 0.1, 0.1],
	);
	// the pivot of 0.5 mesh sizes, 0.05 m at size 1, times the start size 12 and the emitter's x scale 2
	assert.deepEqual(Array.from(m!.subarray(12, 15), round), [2.2, 2, 3]);
});
