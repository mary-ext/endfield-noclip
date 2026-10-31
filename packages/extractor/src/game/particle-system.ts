/**
 * mesh particle systems a viewer can play: a `ParticleSystem` whose renderer draws one mesh per particle and
 * whose modules all have closed forms (constant or two-constant velocities, gravity, orbits, size and
 * rotation over lifetime), read into the package's {@link ParticleSystemInfo}. the floating rocks rising over
 * Origin Lodespring's crater are such systems.
 *
 * @module
 */

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	arrayField,
	booleanField,
	isObject,
	numberField,
	objectField,
	optionalNumberField,
	type Aabb,
	type PPtr,
	pptrField,
	vector3Field,
} from '@endfield-noclip/formats/unity/values';
import type { AnimationCurve, CurveKey } from '@endfield-noclip/package-format/environment';
import {
	CurveMode,
	type MinMaxCurveInfo,
	ParticleAlignment,
	type ParticleBurstInfo,
	type ParticleShapeInfo,
	ParticleShapeKind,
	type ParticleSystemInfo,
	type ParticleVelocityInfo,
} from '@endfield-noclip/package-format/particles';

/** `ParticleSystemRenderer.m_RenderMode` that draws a mesh per particle */
const RENDER_MODE_MESH = 4;

/** the renderer's meshes and their weights */
const MESH_FIELDS = ['m_Mesh', 'm_Mesh1', 'm_Mesh2', 'm_Mesh3'] as const;
const MESH_WEIGHT_FIELDS = [
	'm_MeshWeighting',
	'm_MeshWeighting1',
	'm_MeshWeighting2',
	'm_MeshWeighting3',
] as const;

/** `ParticleSystemRenderer.m_MeshDistribution` that picks meshes by their weights rather than evenly */
const MESH_DISTRIBUTION_WEIGHTED = 1;

/** `ParticleSystemRenderer.m_RenderAlignment` of Unity's `Facing`, which the viewer orients like `View` */
const ALIGNMENT_FACING = 3;

/** Unity's gravity, m/s² */
const GRAVITY = 9.81;

/**
 * modules whose effect the viewer doesn't evaluate; a system with any of them enabled isn't played. colour
 * modules are among them because a mesh particle's colour reaches the shader only through per-particle data
 */
const UNSUPPORTED_MODULES = [
	'ForceModule',
	'ExternalForcesModule',
	'ClampVelocityModule',
	'NoiseModule',
	'CollisionModule',
	'TriggerModule',
	'SubModule',
	'LightsModule',
	'TrailModule',
	'UVModule',
	'ColorModule',
	'ColorBySpeedModule',
	'SizeBySpeedModule',
	'RotationBySpeedModule',
	'CustomDataModule',
	'LifetimeByEmitterSpeedModule',
] as const;

/** shapes the viewer emits from, by `ShapeModule.type` */
const SHAPES = new Set<number>(Object.values(ParticleShapeKind));
const isShapeKind = (kind: number): kind is ParticleShapeKind => SHAPES.has(kind);

/** what {@link readParticleSystem} found */
export type ParticleSystemRead =
	| {
			/** the system, drawing the first of its meshes */
			info: ParticleSystemInfo;
			/** the meshes particles pick from, in the order of {@link ParticleSystemInfo.meshWeights} */
			meshes: PPtr[];
	  }
	| { reason: string };

/**
 * @param value a serialized `AnimationCurve`
 * @returns its keys and wrap modes
 */
export const readAnimationCurve = (value: TypeTreeObject): AnimationCurve => ({
	keys: arrayField(value, 'm_Curve').map((key): CurveKey => {
		if (!isObject(key)) {
			throw new FormatError('curve key is not an object');
		}
		return {
			time: numberField(key, 'time'),
			value: numberField(key, 'value'),
			inSlope: numberField(key, 'inSlope'),
			outSlope: numberField(key, 'outSlope'),
			weightedMode: optionalNumberField(key, 'weightedMode') ?? 0,
			inWeight: optionalNumberField(key, 'inWeight') ?? 0,
			outWeight: optionalNumberField(key, 'outWeight') ?? 0,
		};
	}),
	preWrapMode: optionalNumberField(value, 'm_PreInfinity') ?? 2,
	postWrapMode: optionalNumberField(value, 'm_PostInfinity') ?? 2,
});

/**
 * @param value a serialized `MinMaxCurve`
 * @returns it, with only the curves its mode reads
 * @throws {FormatError} on an unknown mode
 */
export const readMinMaxCurve = (value: TypeTreeObject): MinMaxCurveInfo => {
	const mode = numberField(value, 'minMaxState');
	switch (mode) {
		case CurveMode.Constant:
		case CurveMode.Curve:
		case CurveMode.TwoCurves:
		case CurveMode.TwoConstants: {
			break;
		}
		default: {
			throw new FormatError(`unknown MinMaxCurve mode ${mode}`);
		}
	}
	const curves = mode === CurveMode.Curve || mode === CurveMode.TwoCurves;
	return {
		mode,
		scalar: numberField(value, 'scalar'),
		min: numberField(value, 'minScalar'),
		curve: curves ? readAnimationCurve(objectField(value, 'maxCurve')) : null,
		minCurve: mode === CurveMode.TwoCurves ? readAnimationCurve(objectField(value, 'minCurve')) : null,
	};
};

/** @returns whether a MinMaxCurve is one constant or a random one between two */
const isConstant = (curve: MinMaxCurveInfo): boolean =>
	curve.mode === CurveMode.Constant || curve.mode === CurveMode.TwoConstants;

/**
 * @param curve a MinMaxCurve
 * @returns the largest magnitude it can take (the keys' values bound a curve, overshoot aside)
 */
export const curveReach = (curve: MinMaxCurveInfo): number => {
	switch (curve.mode) {
		case CurveMode.Constant: {
			return Math.abs(curve.scalar);
		}
		case CurveMode.TwoConstants: {
			return Math.max(Math.abs(curve.scalar), Math.abs(curve.min));
		}
		default: {
			let most = 0;
			for (const key of [...(curve.curve?.keys ?? []), ...(curve.minCurve?.keys ?? [])]) {
				most = Math.max(most, Math.abs(key.value));
			}
			return most * Math.abs(curve.scalar);
		}
	}
};

/** @returns whether the module is present and enabled */
const enabled = (system: TypeTreeObject, module: string): boolean =>
	isObject(system[module]) && booleanField(system[module], 'enabled');

/** @returns the start colour if it isn't plain white, which the viewer can't apply per particle */
const tinted = (initial: TypeTreeObject): boolean => {
	const color = objectField(initial, 'startColor');
	if (numberField(color, 'minMaxState') !== 0) {
		return true;
	}
	const max = objectField(color, 'maxColor');
	return ['r', 'g', 'b', 'a'].some((channel) => numberField(max, channel) !== 1);
};

const readShape = (shape: TypeTreeObject): ParticleShapeInfo | string => {
	const kind = numberField(shape, 'type');
	if (!isShapeKind(kind)) {
		return `shape ${kind}`;
	}
	const radius = objectField(shape, 'radius');
	const arc = objectField(shape, 'arc');
	return {
		kind,
		radius: numberField(radius, 'value'),
		radiusThickness: numberField(shape, 'radiusThickness'),
		angle: numberField(shape, 'angle'),
		length: numberField(shape, 'length'),
		arc: numberField(arc, 'value'),
		position: vector3Field(shape, 'm_Position'),
		rotation: vector3Field(shape, 'm_Rotation'),
		scale: vector3Field(shape, 'm_Scale'),
		randomDirection: numberField(shape, 'randomDirectionAmount'),
		sphericalDirection: numberField(shape, 'sphericalDirectionAmount'),
		randomPosition: numberField(shape, 'randomPositionAmount'),
	};
};

const readVelocity = (velocity: TypeTreeObject): ParticleVelocityInfo | string => {
	const curves = (names: readonly string[]) =>
		names.map((name) => readMinMaxCurve(objectField(velocity, name)));
	const linear = curves(['x', 'y', 'z']);
	const orbital = curves(['orbitalX', 'orbitalY', 'orbitalZ']);
	const [radial, speedModifier] = curves(['radial', 'speedModifier']);
	if (![...linear, ...orbital, radial, speedModifier].every(isConstant)) {
		return 'velocity curves';
	}
	return {
		linear: [linear[0], linear[1], linear[2]],
		linearInWorld: booleanField(velocity, 'inWorldSpace'),
		orbital: [orbital[0], orbital[1], orbital[2]],
		orbitalOffset: [
			numberField(objectField(velocity, 'orbitalOffsetX'), 'scalar'),
			numberField(objectField(velocity, 'orbitalOffsetY'), 'scalar'),
			numberField(objectField(velocity, 'orbitalOffsetZ'), 'scalar'),
		],
		radial,
		speedModifier,
	};
};

const readBurst = (burst: TypeTreeObject): ParticleBurstInfo => ({
	time: numberField(burst, 'time'),
	count: readMinMaxCurve(objectField(burst, 'countCurve')),
	cycles: Math.max(1, numberField(burst, 'cycleCount')),
	interval: Math.max(numberField(burst, 'repeatInterval'), 1e-4),
	probability: numberField(burst, 'probability'),
});

/**
 * reads a mesh particle system that plays on its own once loaded.
 *
 * @param system the emitter's `ParticleSystem`
 * @param renderer its `ParticleSystemRenderer`
 * @returns the system and the meshes its particles draw, or why the viewer can't play it: another render
 *   mode, a frozen single particle (see `frozenParticleMatrix`), a module or shape it doesn't evaluate,
 *   velocity curves, a rate curve, a tinted start colour, no mesh, or velocity alignment
 */
export const readParticleSystem = (system: TypeTreeObject, renderer: TypeTreeObject): ParticleSystemRead => {
	if (numberField(renderer, 'm_RenderMode') !== RENDER_MODE_MESH) {
		return { reason: 'not mesh particles' };
	}
	if (!booleanField(system, 'playOnAwake')) {
		return { reason: 'not played on awake' };
	}
	if (numberField(system, 'ringBufferMode') !== 0) {
		return { reason: 'ring buffer' };
	}
	const unsupported = UNSUPPORTED_MODULES.find((module) => enabled(system, module));
	if (unsupported !== undefined) {
		return { reason: unsupported };
	}
	// each particle picks one of up to four meshes, evenly or by the weights
	const weighted = (optionalNumberField(renderer, 'm_MeshDistribution') ?? 0) === MESH_DISTRIBUTION_WEIGHTED;
	const meshes: PPtr[] = [];
	const meshWeights: number[] = [];
	for (const [i, field] of MESH_FIELDS.entries()) {
		if (!isObject(renderer[field]) || pptrField(renderer, field).pathId === 0n) {
			continue;
		}
		const weight = weighted ? (optionalNumberField(renderer, MESH_WEIGHT_FIELDS[i]) ?? 1) : 1;
		if (weight > 0) {
			meshes.push(pptrField(renderer, field));
			meshWeights.push(weight);
		}
	}
	if (meshes.length === 0) {
		return { reason: 'no mesh' };
	}
	const renderAlignment = numberField(renderer, 'm_RenderAlignment');
	let alignment: ParticleAlignment;
	switch (renderAlignment) {
		case ParticleAlignment.View:
		case ALIGNMENT_FACING: {
			alignment = ParticleAlignment.View;
			break;
		}
		case ParticleAlignment.World:
		case ParticleAlignment.Local: {
			alignment = renderAlignment;
			break;
		}
		default: {
			return { reason: `alignment ${renderAlignment}` };
		}
	}
	const initial = objectField(system, 'InitialModule');
	if (tinted(initial)) {
		return { reason: 'start colour' };
	}
	const emission = objectField(system, 'EmissionModule');
	const emits = booleanField(emission, 'enabled');
	const rate = emits
		? readMinMaxCurve(objectField(emission, 'rateOverTime'))
		: { mode: CurveMode.Constant, scalar: 0, min: 0, curve: null, minCurve: null };
	if (!isConstant(rate)) {
		return { reason: 'rate curve' };
	}
	const bursts = emits
		? arrayField(emission, 'm_Bursts').map((burst) => {
				if (!isObject(burst)) {
					throw new FormatError('burst is not an object');
				}
				return readBurst(burst);
			})
		: [];

	let shape: ParticleShapeInfo | null = null;
	if (enabled(system, 'ShapeModule')) {
		const read = readShape(objectField(system, 'ShapeModule'));
		if (typeof read === 'string') {
			return { reason: read };
		}
		shape = read;
	}
	let velocity: ParticleVelocityInfo | null = null;
	if (enabled(system, 'VelocityModule')) {
		const read = readVelocity(objectField(system, 'VelocityModule'));
		if (typeof read === 'string') {
			return { reason: read };
		}
		velocity = read;
	}

	const curve = (parent: TypeTreeObject, name: string) => readMinMaxCurve(objectField(parent, name));
	const size = curve(initial, 'startSize');
	const startSize: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo] = booleanField(initial, 'size3D')
		? [size, curve(initial, 'startSizeY'), curve(initial, 'startSizeZ')]
		: [size, size, size];
	const zero: MinMaxCurveInfo = { mode: CurveMode.Constant, scalar: 0, min: 0, curve: null, minCurve: null };
	const startRotation: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo] = booleanField(
		initial,
		'rotation3D',
	)
		? [curve(initial, 'startRotationX'), curve(initial, 'startRotationY'), curve(initial, 'startRotation')]
		: [zero, zero, curve(initial, 'startRotation')];

	let sizeOverLifetime: ParticleSystemInfo['sizeOverLifetime'] = null;
	if (enabled(system, 'SizeModule')) {
		const sizeModule = objectField(system, 'SizeModule');
		const x = curve(sizeModule, 'curve');
		sizeOverLifetime = booleanField(sizeModule, 'separateAxes')
			? [x, curve(sizeModule, 'y'), curve(sizeModule, 'z')]
			: [x, x, x];
	}
	let rotationOverLifetime: ParticleSystemInfo['rotationOverLifetime'] = null;
	if (enabled(system, 'RotationModule')) {
		const rotation = objectField(system, 'RotationModule');
		const z = curve(rotation, 'curve');
		const axes: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo] = booleanField(rotation, 'separateAxes')
			? [curve(rotation, 'x'), curve(rotation, 'y'), z]
			: [zero, zero, z];
		if (!axes.every(isConstant)) {
			return { reason: 'rotation curves' };
		}
		rotationOverLifetime = axes;
	}

	const delay = curve(system, 'startDelay');
	return {
		info: {
			duration: Math.max(numberField(system, 'lengthInSec'), 1e-3),
			looping: booleanField(system, 'looping'),
			// a random delay takes its midpoint, a curve none
			startDelay: isConstant(delay)
				? (delay.scalar + (delay.mode === CurveMode.Constant ? delay.scalar : delay.min)) / 2
				: 0,
			maxParticles: numberField(initial, 'maxNumParticles'),
			simulationSpeed: numberField(system, 'simulationSpeed'),
			startLifetime: curve(initial, 'startLifetime'),
			startSpeed: curve(initial, 'startSpeed'),
			startSize,
			startRotation,
			gravityModifier: curve(initial, 'gravityModifier'),
			rate,
			bursts,
			shape,
			velocity,
			sizeOverLifetime,
			rotationOverLifetime,
			alignment,
			pivot: vector3Field(renderer, 'm_Pivot'),
			meshWeights,
			mesh: 0,
		},
		meshes,
	};
};

/**
 * a conservative box around everywhere a system's particles can reach, meshes included, in the emitter's
 * frame: the shape's extent plus the farthest any velocity, gravity or radial push carries a particle in its
 * longest lifetime, around the orbits' centre
 *
 * @param info the system
 * @param meshRadius the particle mesh's bounding radius at size 1
 * @returns the box
 */
export const particleReach = (info: ParticleSystemInfo, meshRadius: number): Aabb => {
	const life = curveReach(info.startLifetime);
	const speedScale = info.velocity === null ? 1 : curveReach(info.velocity.speedModifier);
	let speed = curveReach(info.startSpeed);
	let offset = 0;
	if (info.velocity !== null) {
		const [x, y, z] = info.velocity.linear.map(curveReach);
		speed += Math.hypot(x, y, z) + curveReach(info.velocity.radial);
		offset = Math.hypot(...info.velocity.orbitalOffset);
	}
	let shape = 0;
	if (info.shape !== null) {
		const s = info.shape;
		const along = s.kind === ParticleShapeKind.ConeVolume ? s.length : 0;
		const spread = s.radius + along * Math.tan((Math.min(Math.abs(s.angle), 89) * Math.PI) / 180);
		shape =
			Math.hypot(...s.position) +
			Math.max(...s.scale.map(Math.abs)) * Math.hypot(spread, along) +
			s.randomPosition * Math.sqrt(3);
	}
	const gravity = 0.5 * GRAVITY * curveReach(info.gravityModifier) * life * life;
	const size =
		meshRadius *
		Math.max(...info.startSize.map(curveReach)) *
		Math.max(1, ...(info.sizeOverLifetime ?? []).map(curveReach)) *
		Math.max(1, Math.hypot(...info.pivot));
	// orbits keep a particle's distance from their centre, which lies `offset` from the emitter
	const half = 2 * offset + shape + speed * speedScale * life + gravity + size;
	return { center: [0, 0, 0], extents: [half, half, half] };
};
