import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type DecodedMesh, MeshTopology } from '@endfield-noclip/formats/unity/mesh';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	CurveMode,
	GradientMode,
	ParticleAlignment,
	ParticleMeshPlacement,
	ParticleMeshSpawn,
	ParticleRenderMode,
	ParticleShapeKind,
	SheetRow,
} from '@endfield-noclip/package-format/particles';

import {
	InfluenceFilter,
	particleReach,
	particleShapeMesh,
	readForceField,
	readParticleSystem,
} from './particle-system.ts';

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
const white = { r: 1, g: 1, b: 1, a: 1 };
/** a serialized Unity gradient from colour keys (rgb) and alpha keys, as `[time, value]` */
const gradient = (colors: [number, [number, number, number]][], alphas: [number, number][], mode = 0) => {
	const value: Record<string, unknown> = {
		m_Mode: mode,
		m_NumColorKeys: colors.length,
		m_NumAlphaKeys: alphas.length,
	};
	for (let i = 0; i < 8; i++) {
		const [r, g, b] = colors[i]?.[1] ?? [0, 0, 0];
		value[`key${i}`] = { r, g, b, a: alphas[i]?.[1] ?? 0 };
		value[`ctime${i}`] = Math.round((colors[i]?.[0] ?? 0) * 65_535);
		value[`atime${i}`] = Math.round((alphas[i]?.[0] ?? 0) * 65_535);
	}
	return value;
};
const pointer = (pathId: bigint) => ({ m_FileID: 0, m_PathID: pathId });

const system = (
	overrides: Record<string, unknown> = {},
	initial: Record<string, unknown> = {},
): TypeTreeObject => ({
	lengthInSec: 5,
	looping: true,
	playOnAwake: true,
	ringBufferMode: 0,
	ringBufferLoopRange: { x: 0, y: 1 },
	simulationSpeed: 1,
	scalingMode: 1,
	startDelay: constant(0),
	InitialModule: {
		enabled: true,
		startLifetime: constant(80),
		startSpeed: constant(0),
		startColor: { minMaxState: 0, minColor: white, maxColor: white },
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
	m_MinParticleSize: 0,
	m_MaxParticleSize: 0.5,
	m_UseCustomVertexStreams: false,
	m_VertexStreams: new Uint8Array([0, 1, 3, 4]),
	...overrides,
});

test('custom data reaches the particles where the vertex streams put it in the second texture coordinates', () => {
	// the anchors' black smoke (`blackfire01`): random x and y, a z between two curves rising over the life
	const smoke = system({
		CustomDataModule: {
			enabled: true,
			mode0: 1,
			vectorComponentCount0: 4,
			vector0_0: between(0, 1),
			vector0_1: between(0, 1),
			vector0_2: curve([
				[0, 0.3],
				[1, 1],
			]),
			vector0_3: constant(0),
		},
	});
	const custom = (streams: number[], count = 4) =>
		readParticleSystem(
			{
				...smoke,
				CustomDataModule: { ...(smoke['CustomDataModule'] as object), vectorComponentCount0: count },
			},
			renderer({ m_UseCustomVertexStreams: true, m_VertexStreams: new Uint8Array(streams) }),
		);
	const modes = (read: ReturnType<typeof custom>) => {
		assert.ok(read !== null && 'info' in read);
		return read.info.customData?.map((component) => component?.mode ?? null) ?? null;
	};
	// position, normal, colour, UV, UV2, Custom1XYZW: the custom data is the whole second set
	assert.deepEqual(modes(custom([0, 1, 3, 4, 5, 34])), [
		CurveMode.TwoConstants,
		CurveMode.TwoConstants,
		CurveMode.Curve,
		CurveMode.Constant,
	]);
	// without UV2 it starts in the first set's zw, so the second set holds its z and w
	assert.deepEqual(modes(custom([0, 1, 3, 4, 34])), [CurveMode.Curve, CurveMode.Constant, null, null]);
	// components past the module's count are 0
	assert.deepEqual(modes(custom([0, 1, 3, 4, 5, 34], 2)), [
		CurveMode.TwoConstants,
		CurveMode.TwoConstants,
		null,
		null,
	]);
	// nothing without custom streams, or with the module off
	assert.equal(modes(readParticleSystem(smoke, renderer())), null);
	assert.equal(
		modes(
			readParticleSystem(
				system({ CustomDataModule: { enabled: false } }),
				renderer({ m_UseCustomVertexStreams: true, m_VertexStreams: new Uint8Array([0, 1, 3, 4, 5, 34]) }),
			),
		),
		null,
	);
});

test('a looping mesh particle system keeps its emission, shape, gravity, orbit and size over lifetime', () => {
	const read = readParticleSystem(system(), renderer());
	assert.ok(read !== null && 'info' in read);
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
	assert.equal(info.motion.kind, 'free');
	assert.deepEqual(info.motion.gravityModifier, {
		mode: CurveMode.TwoConstants,
		scalar: -0.012,
		min: -0.003,
		curve: null,
		minCurve: null,
	});
	assert.equal(info.motion.velocity?.orbital[2].min, -0.05);
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
	assert.ok(even !== null && 'info' in even);
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
	assert.ok(weighted !== null && 'info' in weighted);
	// a mesh weighted 0 is never picked
	assert.deepEqual(
		weighted.meshes.map((mesh) => mesh.pathId),
		[7n, 9n],
	);
	assert.deepEqual(weighted.info.meshWeights, [2, 0.5]);
});

const sheet = (overrides: Record<string, unknown> = {}) => ({
	enabled: true,
	mode: 0,
	timeMode: 0,
	fps: 30,
	frameOverTime: {
		...curve([
			[0, 0],
			[1, 1],
		]),
		scalar: 0.9999,
	},
	startFrame: constant(0),
	tilesX: 8,
	tilesY: 8,
	animationType: 0,
	rowIndex: 0,
	cycles: 1,
	uvChannelMask: -1,
	rowMode: 1,
	...overrides,
});

test('a ring-buffered flipbook particle keeps its sheet and how it outlives its lifetime', () => {
	const faint = { startColor: { minMaxState: 0, minColor: white, maxColor: { ...white, a: 0.25 } } };
	const read = readParticleSystem(system({ ringBufferMode: 1, UVModule: sheet() }, faint), renderer());
	assert.ok(read !== null && 'info' in read);
	assert.deepEqual(read.info.startColor.max, [1, 1, 1, 0.25]);
	assert.equal(read.info.startColor.maxGradient, null);
	assert.deepEqual(read.info.ringBuffer, { loop: false, loopRange: [0, 1] });
	const textureSheet = read.info.textureSheet;
	assert.deepEqual(textureSheet?.tiles, [8, 8]);
	// the whole sheet ignores the row mode
	assert.equal(textureSheet?.row, null);
	assert.equal(textureSheet?.frameOverTime?.scalar, 0.9999);
	assert.equal(textureSheet?.uvChannels, 3);

	const looped = readParticleSystem(
		system({ ringBufferMode: 2, ringBufferLoopRange: { x: 0.2, y: 0.8 } }),
		renderer(),
	);
	assert.ok(looped !== null && 'info' in looped);
	assert.deepEqual(looped.info.ringBuffer, { loop: true, loopRange: [0.2, 0.8] });
	assert.equal(looped.info.textureSheet, null);

	// a single row: a fixed one, a random one, or the mesh's; frames per second leave no curve
	const row = (overrides: Record<string, unknown>) => {
		const result = readParticleSystem(
			system({ UVModule: sheet({ animationType: 1, ...overrides }) }),
			renderer(),
		);
		assert.ok(result !== null && 'info' in result);
		return result.info.textureSheet;
	};
	assert.equal(row({ rowMode: 0, rowIndex: 3 })?.row, 3);
	assert.equal(row({ rowMode: 1 })?.row, SheetRow.Random);
	assert.equal(row({ rowMode: 2 })?.row, SheetRow.MeshIndex);
	assert.equal(row({ rowMode: 0, timeMode: 2 })?.frameOverTime, null);
});

test('a cap of 0 becomes what one lifetime of emission holds', () => {
	// one particle per 1.6 s loop living 1.6 s, as the tilted torch flame
	const flame = readParticleSystem(
		system(
			{
				lengthInSec: 1.6,
				ringBufferMode: 2,
				EmissionModule: {
					enabled: true,
					rateOverTime: constant(0),
					m_Bursts: [
						{ time: 0, countCurve: constant(1), cycleCount: 1, repeatInterval: 0.01, probability: 1 },
					],
				},
			},
			{ startLifetime: constant(1.6), maxNumParticles: 0 },
		),
		renderer(),
	);
	assert.ok(flame !== null && 'info' in flame);
	assert.equal(flame.info.maxParticles, 1);
	// 1.1 per second for 80 s
	const steady = readParticleSystem(system({}, { maxNumParticles: 0 }), renderer());
	assert.ok(steady !== null && 'info' in steady);
	assert.equal(steady.info.maxParticles, 88);
});

test('systems the viewer cannot play say why', () => {
	const reason = (s: TypeTreeObject, r: TypeTreeObject = renderer()) => {
		const read = readParticleSystem(s, r);
		return read !== null && 'reason' in read ? read.reason : null;
	};
	assert.equal(reason(system(), renderer({ m_RenderMode: 5 })), 'render mode 5');
	// modules the viewer doesn't evaluate are ignored
	assert.equal(reason(system({ NoiseModule: { enabled: true } })), null);
	assert.equal(reason(system({ ringBufferMode: 3 })), 'ring buffer mode 3');
	assert.equal(reason(system({ UVModule: sheet({ mode: 1 }) })), 'sprite sheet');
	assert.equal(reason(system({ UVModule: sheet({ timeMode: 1 }) })), 'sheet time mode 1');
	assert.equal(reason(system({ UVModule: sheet({ tilesX: 65 }) })), 'sheet of 65×8 tiles');
	assert.equal(reason(system(), renderer({ m_RenderAlignment: 5 })), 'alignment 5');
	assert.equal(
		reason(system({ ShapeModule: { ...(system().ShapeModule as object), type: 12 } })),
		'shape 12',
	);
	assert.equal(reason(system(), renderer({ m_Mesh: pointer(0n) })), 'no mesh');
	const turning = { ...curve([[0, 1]]), minMaxState: 1 };
	// orbital and radial curves play (Jingyu's drifting petals spin up through theirs)
	assert.equal(
		reason(system({ VelocityModule: { ...(system().VelocityModule as object), radial: turning } })),
		null,
	);
	assert.equal(
		reason(system({ VelocityModule: { ...(system().VelocityModule as object), orbitalZ: turning } })),
		null,
	);
	// a speed modifier curve plays (the floating stones of Valley's Aberrants ramp theirs up), under a speed
	// limit too (the collectible pieces' rings slow under one), but not under drag
	const ramping = { VelocityModule: { ...(system().VelocityModule as object), speedModifier: turning } };
	assert.equal(reason(system(ramping)), null);
	const limited = {
		enabled: true,
		dampen: 0.015,
		separateAxis: false,
		magnitude: constant(1),
		drag: constant(0),
		multiplyDragByParticleSize: true,
		multiplyDragByParticleVelocity: true,
	};
	assert.equal(reason(system({ ...ramping, ClampVelocityModule: limited })), null);
	const dragged = {
		enabled: true,
		dampen: 0,
		separateAxis: false,
		magnitude: constant(1),
		drag: constant(0.5),
		multiplyDragByParticleSize: false,
		multiplyDragByParticleVelocity: false,
	};
	assert.equal(
		reason(system({ ...ramping, ClampVelocityModule: dragged })),
		'speed modifier curve with drag',
	);
	assert.equal(
		reason(system({ EmissionModule: { enabled: true, rateOverTime: curve([[0, 1]]), m_Bursts: [] } })),
		'rate curve',
	);
	// one a script starts shows nothing until then, so it's neither played nor unsupported
	assert.equal(readParticleSystem(system({ playOnAwake: false }), renderer()), null);
});

test('the accelerate mushroom plays its velocity-aligned arrows, spin curves and donut', () => {
	// the arrows (dajiantou02) rise along their velocity; the wind meshes (wind01) slow their spin by curves
	const twoCurves = (scalar: number) => ({
		...curve([
			[0, -1],
			[1, 0],
		]),
		minMaxState: 2,
		scalar,
		minCurve: {
			m_Curve: [{ time: 0, value: 1, inSlope: 0, outSlope: 0 }],
			m_PreInfinity: 2,
			m_PostInfinity: 2,
		},
	});
	const read = readParticleSystem(
		system({
			RotationModule: {
				enabled: true,
				separateAxes: false,
				x: constant(0),
				y: constant(0),
				curve: twoCurves(1.05),
			},
			ShapeModule: { ...(system().ShapeModule as object), type: 17, radius: { value: 1 }, donutRadius: 0.2 },
		}),
		renderer({ m_RenderAlignment: 4 }),
	);
	assert.ok(read !== null && 'info' in read);
	assert.equal(read.info.alignment, ParticleAlignment.Velocity);
	assert.equal(read.info.rotationOverLifetime?.[2].mode, CurveMode.TwoCurves);
	assert.equal(read.info.rotationOverLifetime?.[2].scalar, 1.05);
	assert.equal(read.info.shape?.kind, ParticleShapeKind.Donut);
	assert.equal(read.info.shape?.donutRadius, 0.2);
});

test('billboards draw one quad, stretched ones keep how they lengthen', () => {
	const billboard = readParticleSystem(system(), renderer({ m_RenderMode: 0, m_Mesh: pointer(0n) }));
	assert.ok(billboard !== null && 'info' in billboard);
	assert.equal(billboard.info.renderMode, ParticleRenderMode.Billboard);
	assert.deepEqual(billboard.meshes, []);
	assert.deepEqual(billboard.info.meshWeights, [1]);
	assert.equal(billboard.info.stretch, null);
	const stretched = readParticleSystem(
		system({ scalingMode: 2 }),
		renderer({ m_RenderMode: 1, m_LengthScale: 1.5, m_VelocityScale: 0.2 }),
	);
	assert.ok(stretched !== null && 'info' in stretched);
	assert.deepEqual(stretched.info.stretch, { lengthScale: 1.5, velocityScale: 0.2 });
	assert.deepEqual(stretched.info.screenSize, { min: 0, max: 0.5 });
	assert.equal(stretched.info.sizedByScale, false);
	assert.equal(billboard.info.sizedByScale, true);
});

test('start colours and colour over lifetime keep their gradients and random ranges', () => {
	const read = readParticleSystem(
		system(
			{
				ColorModule: {
					enabled: true,
					gradient: {
						minMaxState: 3,
						minColor: white,
						maxColor: white,
						maxGradient: gradient(
							[
								[0, [1, 1, 1]],
								[1, [0.5, 0.5, 0.5]],
							],
							[
								[0, 0],
								[0.4, 1],
								[1, 1],
							],
						),
						minGradient: gradient([[0, [1, 1, 1]]], [[0, 1]], 1),
					},
				},
			},
			{
				startColor: { minMaxState: 2, minColor: { ...white, a: 0.2 }, maxColor: { ...white, a: 0.45 } },
			},
		),
		renderer(),
	);
	assert.ok(read !== null && 'info' in read);
	const { startColor, colorOverLifetime } = read.info;
	assert.equal(startColor.mode, GradientMode.TwoColors);
	assert.equal(startColor.min[3], 0.2);
	assert.equal(startColor.max[3], 0.45);
	assert.equal(colorOverLifetime?.mode, GradientMode.TwoGradients);
	assert.deepEqual(colorOverLifetime?.maxGradient?.colorKeys, [
		{ time: 0, color: [1, 1, 1] },
		{ time: 1, color: [0.5, 0.5, 0.5] },
	]);
	assert.deepEqual(
		colorOverLifetime?.maxGradient?.alphaKeys.map((key) => key.alpha),
		[0, 1, 1],
	);
	assert.ok(Math.abs((colorOverLifetime?.maxGradient?.alphaKeys[1].time ?? 0) - 0.4) < 1e-4);
	assert.equal(colorOverLifetime?.maxGradient?.fixed, false);
	assert.equal(colorOverLifetime?.minGradient?.fixed, true);
});

test('linear velocities can be curves', () => {
	const read = readParticleSystem(
		system({
			VelocityModule: {
				...(system().VelocityModule as object),
				y: curve([
					[0, 0],
					[1, 2],
				]),
			},
		}),
		renderer(),
	);
	assert.ok(read !== null && 'info' in read);
	assert.equal(
		read.info.motion.kind === 'free' && read.info.motion.velocity?.linear[1].mode,
		CurveMode.Curve,
	);
});

test('the reach covers the cone, the rise under gravity and the largest mesh', () => {
	const read = readParticleSystem(system(), renderer());
	assert.ok(read !== null && 'info' in read);
	const reach = particleReach(read.info, 1);
	// radius 65 plus a slight spread, ½ · 9.81 · 0.012 · 80² of rise, a mesh of size 5
	const rise = 0.5 * 9.81 * 0.012 * 80 * 80;
	assert.ok(reach.extents[1] >= 65 + rise + 5);
	assert.ok(reach.extents[1] < 65 + rise + 5 + 1);
	assert.deepEqual(reach.center, [0, 0, 0]);
});

test('a box reaches its corners whatever its radius', () => {
	const reachOf = (radius: number) => {
		const read = readParticleSystem(
			system({
				ShapeModule: { ...(system().ShapeModule as object), type: 5, radius: { value: radius } },
			}),
			renderer(),
		);
		assert.ok(read !== null && 'info' in read);
		return particleReach(read.info, 0).extents[0];
	};
	assert.equal(reachOf(0.01), reachOf(65));
});

// Jingyu Valley's fish school (`p_fxmap_map02_lv001_fish_2101`): a sphere field swirling the fish about its
// +y, pulling them in and slowing them
const fishField = (overrides: Record<string, unknown> = {}): TypeTreeObject => ({
	m_Enabled: 1,
	m_Parameters: {
		m_Shape: 0,
		m_StartRange: 3,
		m_EndRange: 15,
		m_Length: 1,
		m_GravityFocus: 0,
		m_RotationRandomness: { x: 0.01, y: 0.25 },
		m_DirectionCurveX: constant(0),
		m_DirectionCurveY: constant(0),
		m_DirectionCurveZ: constant(0),
		m_GravityCurve: between(0.25, 0.1),
		m_RotationSpeedCurve: between(4, -4),
		m_RotationAttractionCurve: between(0.02, 0.05),
		m_DragCurve: between(0.3, 0.3),
		m_VectorField: pointer(0n),
		m_MultiplyDragByParticleSize: false,
		m_MultiplyDragByParticleVelocity: true,
		...overrides,
	},
});

const externalForces = (multiplier: number) => ({
	ExternalForcesModule: {
		enabled: true,
		multiplierCurve: constant(multiplier),
		influenceFilter: 1,
		influenceMask: { m_Bits: 0xffff_ffff },
		influenceList: [pointer(-5n)],
	},
});

test('a sphere force field keeps its ranges, curves and the emitter seen from it', () => {
	const fromEmitter = new Float32Array([1, 0, 0, 0, 0, 0, -5, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
	const field = readForceField(fishField(), fromEmitter);
	assert.ok(typeof field !== 'string');
	assert.equal(field.startRange, 3);
	assert.equal(field.endRange, 15);
	assert.deepEqual(field.rotationRandomness, [0.01, 0.25]);
	assert.equal(field.rotationSpeed.min, 4);
	assert.equal(field.dragByVelocity, true);
	assert.deepEqual(field.fromEmitter, [...fromEmitter]);
	// the viewer steps spheres alone
	assert.equal(readForceField(fishField({ m_Shape: 3 }), fromEmitter), 'force field shape 3');
});

test('a system lists the force fields it feels for the packer to resolve, unless the multiplier is 0', () => {
	const read = readParticleSystem(system(externalForces(1)), renderer({ m_RenderAlignment: 4 }));
	assert.ok(read !== null && 'info' in read);
	assert.equal(read.forces?.filter, InfluenceFilter.List);
	assert.deepEqual(
		read.forces?.list.map((field) => field.pathId),
		[-5n],
	);
	assert.equal(read.info.alignment, ParticleAlignment.Velocity);
	const off = readParticleSystem(system(externalForces(0)), renderer());
	assert.ok(off !== null && 'info' in off);
	assert.equal(off.forces, null);
	// the stepped path takes no drag
	const dragged = readParticleSystem(
		system({
			...externalForces(1),
			ClampVelocityModule: {
				enabled: true,
				dampen: 0,
				separateAxis: false,
				magnitude: constant(1),
				drag: constant(1),
				multiplyDragByParticleSize: false,
				multiplyDragByParticleVelocity: false,
			},
		}),
		renderer(),
	);
	assert.deepEqual(dragged, { reason: 'force fields with drag' });
});

// #region mesh shape

/** a ShapeModule of type 6, as the red mission portal's edge sparks (`dot_Line`) set it */
const meshShape = (overrides: Record<string, unknown> = {}, spawn: Record<string, unknown> = {}) => ({
	enabled: true,
	type: 6,
	radius: { value: 0.75 },
	radiusThickness: 0.5,
	donutRadius: 0.2,
	angle: 0,
	length: 3,
	arc: { value: 360 },
	m_Position: vector(0, 0, 0),
	m_Rotation: vector(0, 0, 0),
	m_Scale: vector(1.5, 1.5, 1.5),
	placementMode: 1,
	m_MeshMaterialIndex: 0,
	m_MeshNormalOffset: 0,
	m_MeshSpawn: { mode: 0, spread: 0, ...spawn },
	m_Mesh: pointer(7n),
	m_Texture: pointer(0n),
	m_UseMeshMaterialIndex: false,
	m_UseMeshColors: false,
	randomDirectionAmount: 0,
	sphericalDirectionAmount: 0,
	randomPositionAmount: 0.5,
	...overrides,
});

/** a unit quad of two triangles as submesh 0 and a line strip without indices as submesh 1 */
const decoded = (submeshes: DecodedMesh['submeshes']): DecodedMesh => ({
	name: 'shape',
	vertexCount: 4,
	channels: [],
	positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0.123456]),
	normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
	packedNormals: null,
	tangents: null,
	colors: {
		dimension: 4,
		format: 0,
		data: new Float32Array([1, 0, 0, 1, 0, 1, 0, 0.5, 0, 0, 1, 1, 1, 1, 1, 0]),
	},
	uvs: [],
	indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
	submeshes,
	bounds: { center: [0.5, 0.5, 0], extents: [0.5, 0.5, 0] },
	skin: null,
});
const submesh = (
	topology: number,
	firstIndex: number,
	indexCount: number,
): DecodedMesh['submeshes'][number] => ({
	firstIndex,
	indexCount,
	topology,
	baseVertex: 0,
	firstVertex: 0,
	vertexCount: 4,
	bounds: { center: [0, 0, 0], extents: [0, 0, 0] },
});
const triangles = submesh(MeshTopology.Triangles, 0, 6);

test('mesh shapes emit from their mesh', () => {
	const read = readParticleSystem(system({ ShapeModule: meshShape() }), renderer());
	assert.ok(read !== null && 'info' in read);
	assert.equal(read.info.shape?.kind, ParticleShapeKind.Mesh);
	assert.deepEqual(read.shapeMesh, { fileId: 0, pathId: 7n });

	const mesh = particleShapeMesh(meshShape(), decoded([triangles]));
	assert.ok(typeof mesh !== 'string');
	assert.equal(mesh.placement, ParticleMeshPlacement.Edge);
	assert.equal(mesh.corners, 3);
	assert.deepEqual(mesh.primitives, [0, 1, 2, 0, 2, 3]);
	// rounded to 0.1 mm
	assert.equal(mesh.positions[11], 0.1235);
	// colours only when the shape asks for them, as Color32 bytes
	assert.equal(mesh.colors, null);
	const colored = particleShapeMesh(meshShape({ m_UseMeshColors: true }), decoded([triangles]));
	assert.ok(typeof colored !== 'string');
	assert.deepEqual(colored.colors?.slice(4, 8), [0, 255, 0, 128]);
});

test('mesh shapes read submeshes and spawn modes as the engine does', () => {
	// as map02's defence array threads (`zhuzi`) store it: no indices, no vertices
	const strip = { ...submesh(MeshTopology.Triangles, 0, 0), vertexCount: 0 };
	// a submesh without indices is a line strip through its vertices
	const lines = particleShapeMesh(meshShape(), decoded([strip]));
	assert.ok(typeof lines !== 'string');
	assert.equal(lines.corners, 2);
	assert.deepEqual(lines.primitives, [0, 1, 1, 2, 2, 3]);
	// the material index keeps one submesh
	const picked = particleShapeMesh(
		meshShape({ m_UseMeshMaterialIndex: true, m_MeshMaterialIndex: 5 }),
		decoded([triangles, submesh(MeshTopology.Lines, 0, 4)]),
	);
	assert.ok(typeof picked !== 'string');
	assert.deepEqual(picked.primitives, [0, 1, 2, 0]);
	assert.equal(
		particleShapeMesh(meshShape(), decoded([triangles, strip])),
		'mesh shape mixing lines and triangles',
	);
	assert.equal(
		particleShapeMesh(meshShape(), decoded([submesh(MeshTopology.Quads, 0, 4)])),
		'mesh shape topology 2',
	);

	const spawn = (placementMode: number, mode: number) => {
		const mesh = particleShapeMesh(meshShape({ placementMode }, { mode }), decoded([triangles]));
		assert.ok(typeof mesh !== 'string');
		return mesh.spawn;
	};
	assert.equal(spawn(ParticleMeshPlacement.Vertex, 1), ParticleMeshSpawn.Loop);
	// burst spread walks back and forth like ping-pong
	assert.equal(spawn(ParticleMeshPlacement.Vertex, 3), ParticleMeshSpawn.PingPong);
	// triangles are always random
	assert.equal(spawn(ParticleMeshPlacement.Triangle, 1), ParticleMeshSpawn.Random);

	const reason = (shape: TypeTreeObject) => {
		const read = readParticleSystem(system({ ShapeModule: shape }), renderer());
		return read !== null && 'reason' in read ? read.reason : null;
	};
	assert.equal(reason(meshShape({}, { mode: 1 })), 'edge mesh shape spawn mode 1');
	assert.equal(reason(meshShape({ m_Texture: pointer(3n) })), 'mesh shape texture');
});

test('a mesh shape reaches its farthest vertex', () => {
	const read = readParticleSystem(
		system({ ShapeModule: meshShape({ randomPositionAmount: 0 }) }),
		renderer(),
	);
	assert.ok(read !== null && 'info' in read && read.info.shape !== null);
	const mesh = particleShapeMesh(meshShape(), decoded([triangles]));
	assert.ok(typeof mesh !== 'string');
	const still = {
		...read.info,
		shape: { ...read.info.shape, mesh, scale: [1, 1, 1] as [number, number, number] },
	};
	const plain = { ...still, shape: { ...still.shape, mesh: { ...mesh, positions: [0, 0, 0] } } };
	const reach = particleReach(still, 0).extents[0] - particleReach(plain, 0).extents[0];
	assert.ok(Math.abs(reach - Math.hypot(1, 1)) < 1e-3);
});

// #endregion
