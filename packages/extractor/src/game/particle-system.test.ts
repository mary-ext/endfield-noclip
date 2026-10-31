import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { CurveMode, ParticleAlignment, ParticleShapeKind } from '@endfield-noclip/package-format/particles';

import { particleReach, readParticleSystem } from './particle-system.ts';

const constant = (value: number) => ({ minMaxState: 0, scalar: value, minScalar: 0 });
const between = (min: number, max: number) => ({ minMaxState: 3, scalar: max, minScalar: min });
const curve = (keys: [number, number][]) => ({
	minMaxState: 1,
	scalar: 1,
	minScalar: 0,
	maxCurve: {
		m_Curve: keys.map(([time, value]) => ({ time, value, inSlope: 0, outSlope: 0 })),
		m_PreInfinity: 2,
		m_PostInfinity: 2,
	},
});
const vector = (x: number, y: number, z: number) => ({ x, y, z });
const pointer = (pathId: bigint) => ({ m_FileID: 0, m_PathID: pathId });

const system = (
	overrides: Record<string, unknown> = {},
	initial: Record<string, unknown> = {},
): TypeTreeObject => ({
	lengthInSec: 5,
	looping: true,
	playOnAwake: true,
	ringBufferMode: 0,
	simulationSpeed: 1,
	scalingMode: 1,
	startDelay: constant(0),
	InitialModule: {
		enabled: true,
		startLifetime: constant(80),
		startSpeed: constant(0),
		startColor: { minMaxState: 0, maxColor: { r: 1, g: 1, b: 1, a: 1 } },
		size3D: true,
		startSize: between(5, 3),
		startSizeY: between(5, 3),
		startSizeZ: between(5, 3),
		rotation3D: false,
		startRotation: between(0, 6.28),
		maxNumParticles: 150,
		gravityModifier: between(-0.003, -0.012),
		...initial,
	},
	EmissionModule: { enabled: true, rateOverTime: constant(1.1), m_Bursts: [] },
	ShapeModule: {
		enabled: true,
		type: 4,
		radius: { value: 65 },
		radiusThickness: 0.5,
		angle: 2,
		length: 5,
		arc: { value: 360 },
		m_Position: vector(0, 0, 0),
		m_Rotation: vector(0, 0, 0),
		m_Scale: vector(1, 1, 1),
		randomDirectionAmount: 0,
		sphericalDirectionAmount: 0,
		randomPositionAmount: 0,
	},
	VelocityModule: {
		enabled: true,
		x: constant(0),
		y: constant(0),
		z: constant(0),
		orbitalX: constant(0),
		orbitalY: constant(0),
		orbitalZ: between(-0.05, -0.005),
		orbitalOffsetX: constant(0),
		orbitalOffsetY: constant(0),
		orbitalOffsetZ: constant(0),
		radial: constant(0),
		speedModifier: constant(1),
		inWorldSpace: false,
	},
	SizeModule: {
		enabled: true,
		separateAxes: false,
		curve: curve([
			[0, 1],
			[1, 0.1],
		]),
	},
	RotationModule: { enabled: false },
	ColorModule: { enabled: false },
	NoiseModule: { enabled: false },
	...overrides,
});

const renderer = (overrides: Record<string, unknown> = {}): TypeTreeObject => ({
	m_RenderMode: 4,
	m_RenderAlignment: 0,
	m_Mesh: pointer(7n),
	m_Mesh1: pointer(0n),
	m_Pivot: vector(0, 0, 0),
	...overrides,
});

test('a looping mesh particle system keeps its emission, shape, gravity, orbit and size over lifetime', () => {
	const read = readParticleSystem(system(), renderer());
	assert.ok('info' in read);
	const { info } = read;
	assert.deepEqual(
		read.meshes.map((mesh) => mesh.pathId),
		[7n],
	);
	assert.deepEqual(info.meshWeights, [1]);
	assert.equal(info.alignment, ParticleAlignment.View);
	assert.equal(info.rate.scalar, 1.1);
	assert.equal(info.shape?.kind, ParticleShapeKind.Cone);
	assert.equal(info.shape?.radius, 65);
	assert.deepEqual(info.gravityModifier, {
		mode: CurveMode.TwoConstants,
		scalar: -0.012,
		min: -0.003,
		curve: null,
		minCurve: null,
	});
	assert.equal(info.velocity?.orbital[2].min, -0.05);
	// without 3D rotation only the rotation about z is read
	assert.equal(info.startRotation[0].scalar, 0);
	assert.equal(info.startRotation[2].scalar, 6.28);
	assert.deepEqual(
		info.sizeOverLifetime?.[1].curve?.keys.map((key) => key.value),
		[1, 0.1],
	);
	assert.equal(info.rotationOverLifetime, null);
});

test('particles pick among the renderer meshes evenly, or by weight when the distribution says so', () => {
	const meshes = { m_Mesh1: pointer(8n), m_Mesh2: pointer(0n), m_Mesh3: pointer(9n) };
	const even = readParticleSystem(system(), renderer(meshes));
	assert.ok('info' in even);
	assert.deepEqual(
		even.meshes.map((mesh) => mesh.pathId),
		[7n, 8n, 9n],
	);
	assert.deepEqual(even.info.meshWeights, [1, 1, 1]);
	const weighted = readParticleSystem(
		system(),
		renderer({
			...meshes,
			m_MeshDistribution: 1,
			m_MeshWeighting: 2,
			m_MeshWeighting1: 0,
			m_MeshWeighting3: 0.5,
		}),
	);
	assert.ok('info' in weighted);
	// a mesh weighted 0 is never picked
	assert.deepEqual(
		weighted.meshes.map((mesh) => mesh.pathId),
		[7n, 9n],
	);
	assert.deepEqual(weighted.info.meshWeights, [2, 0.5]);
});

test('systems the viewer cannot play say why', () => {
	const reason = (s: TypeTreeObject, r: TypeTreeObject = renderer()) => {
		const read = readParticleSystem(s, r);
		return 'reason' in read ? read.reason : null;
	};
	assert.equal(reason(system(), renderer({ m_RenderMode: 0 })), 'not mesh particles');
	assert.equal(reason(system({ NoiseModule: { enabled: true } })), 'NoiseModule');
	assert.equal(reason(system({ ringBufferMode: 1 })), 'ring buffer');
	assert.equal(reason(system(), renderer({ m_RenderAlignment: 4 })), 'alignment 4');
	assert.equal(reason(system(), renderer({ m_Mesh: pointer(0n) })), 'no mesh');
	assert.equal(
		reason(system({}, { startColor: { minMaxState: 0, maxColor: { r: 1, g: 0.5, b: 1, a: 1 } } })),
		'start colour',
	);
	assert.equal(
		reason(system({ EmissionModule: { enabled: true, rateOverTime: curve([[0, 1]]), m_Bursts: [] } })),
		'rate curve',
	);
});

test('the reach covers the cone, the rise under gravity and the largest mesh', () => {
	const read = readParticleSystem(system(), renderer());
	assert.ok('info' in read);
	const reach = particleReach(read.info, 1);
	// radius 65 plus a slight spread, ½ · 9.81 · 0.012 · 80² of rise, a mesh of size 5
	const rise = 0.5 * 9.81 * 0.012 * 80 * 80;
	assert.ok(reach.extents[1] >= 65 + rise + 5);
	assert.ok(reach.extents[1] < 65 + rise + 5 + 1);
	assert.deepEqual(reach.center, [0, 0, 0]);
});
