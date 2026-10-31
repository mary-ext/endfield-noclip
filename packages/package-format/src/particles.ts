import type { AnimationCurve } from './environment.ts';
import type { Vec3 } from './values.ts';

/**
 * `tables/particles.json`: the particle systems that chain draws emit ({@link ChainDraw.particles}), loaded
 * with the core. each is a Unity `ParticleSystem` drawing one mesh per particle, reduced to the modules a
 * viewer can evaluate in closed form: a particle's state follows from its emission time and its own random
 * values, so a viewer can place every live particle at any time without stepping a simulation
 */
export interface ParticlesTable {
	systems: ParticleSystemInfo[];
}

/** {@link MinMaxCurveInfo.mode} values, Unity's `ParticleSystemCurveMode` */
export const CurveMode = {
	Constant: 0,
	Curve: 1,
	TwoCurves: 2,
	TwoConstants: 3,
} as const;

export type CurveMode = (typeof CurveMode)[keyof typeof CurveMode];

/**
 * a Unity `MinMaxCurve`: a constant, a curve, or a random value between two of either. curves are read at a
 * normalized time (a particle's age over its lifetime, or the emission time over the system's duration) and
 * scaled by {@link scalar}
 */
export interface MinMaxCurveInfo {
	mode: CurveMode;
	/** the constant (or the upper one), or the curves' multiplier */
	scalar: number;
	/** the lower constant ({@link CurveMode.TwoConstants}) */
	min: number;
	/** the curve, or the upper one; `null` for constants */
	curve: AnimationCurve | null;
	/** the lower curve ({@link CurveMode.TwoCurves}); `null` otherwise */
	minCurve: AnimationCurve | null;
}

/** {@link ParticleShapeInfo.kind} values, Unity's `ParticleSystemShapeType` (those a viewer emits from) */
export const ParticleShapeKind = {
	Sphere: 0,
	Hemisphere: 2,
	/** from the base disc, along the cone */
	Cone: 4,
	Box: 5,
	/** from anywhere inside the cone, up to its length */
	ConeVolume: 8,
	Circle: 10,
} as const;

export type ParticleShapeKind = (typeof ParticleShapeKind)[keyof typeof ParticleShapeKind];

/** where particles start and which way they leave (Unity's `ShapeModule`), in the emitter's frame */
export interface ParticleShapeInfo {
	kind: ParticleShapeKind;
	/** m */
	radius: number;
	/** the outer fraction of the radius particles start in: 0 on the edge only, 1 anywhere inside */
	radiusThickness: number;
	/** the cone's half angle, degrees */
	angle: number;
	/** the cone volume's length, m */
	length: number;
	/** the slice of the circle used, degrees from +x towards +y */
	arc: number;
	/** the shape's own placement in the emitter: translation, Euler angles in degrees (Unity's order), scale */
	position: Vec3;
	rotation: Vec3;
	scale: Vec3;
	/** how far each start direction is pulled towards a random direction, 0–1 */
	randomDirection: number;
	/** how far each start direction is pulled away from the shape's centre, 0–1 */
	sphericalDirection: number;
	/** each start position moves by up to this much along each axis, m */
	randomPosition: number;
}

/** a burst of particles (Unity's `ParticleSystem.Burst`), repeated within each loop */
export interface ParticleBurstInfo {
	/** seconds into the loop */
	time: number;
	/** particles per burst, rounded */
	count: MinMaxCurveInfo;
	/** how many times the burst fires */
	cycles: number;
	/** seconds between them */
	interval: number;
	/** the chance each burst fires, 0–1 */
	probability: number;
}

/** {@link ParticleSystemInfo.alignment} values, Unity's `ParticleSystemRenderSpace` (those a viewer orients by) */
export const ParticleAlignment = {
	/** the mesh turns with the camera: its rotation applies in view space */
	View: 0,
	/** its rotation applies in world space */
	World: 1,
	/** its rotation applies in the emitter's space */
	Local: 2,
} as const;

export type ParticleAlignment = (typeof ParticleAlignment)[keyof typeof ParticleAlignment];

/**
 * one particle system. positions are in the emitter's frame, the instance row's transform: the particle's
 * world position is that transform applied to its local one. Unity's gravity always points down the world's
 * y, so it is given in the world frame
 */
export interface ParticleSystemInfo {
	/** seconds per loop; emission stops after one when not {@link looping} */
	duration: number;
	looping: boolean;
	/** seconds before the first emission */
	startDelay: number;
	/** the most particles alive at once */
	maxParticles: number;
	/** the system's time scale */
	simulationSpeed: number;
	/** seconds; read at the emission time over the duration */
	startLifetime: MinMaxCurveInfo;
	/** every particle's colour, rgba as authored (sRGB rgb); it multiplies the mesh's vertex colours */
	startColor: [number, number, number, number];
	/** m/s along the shape's start direction */
	startSpeed: MinMaxCurveInfo;
	/** x, y and z scale of the mesh, m */
	startSize: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo];
	/** Euler angles about x, y and z, radians */
	startRotation: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo];
	/** times Unity's gravity, 9.81 m/s² down the world's y */
	gravityModifier: MinMaxCurveInfo;
	/** particles per second; a constant or two */
	rate: MinMaxCurveInfo;
	bursts: ParticleBurstInfo[];
	/** `null` emits every particle at the emitter's origin, along +z */
	shape: ParticleShapeInfo | null;
	/** extra velocity over each particle's lifetime (Unity's `VelocityModule`); `null` without */
	velocity: ParticleVelocityInfo | null;
	/** a multiplier of the start size over each particle's lifetime, per axis; `null` without */
	sizeOverLifetime: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo] | null;
	/** angular velocity about x, y and z, radians per second; `null` without */
	rotationOverLifetime: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo] | null;
	alignment: ParticleAlignment;
	/** the mesh's offset from the particle's position, in units of its size */
	pivot: Vec3;
	/**
	 * the relative chance of each of the system's meshes (up to four); each particle draws one. a renderer with
	 * several meshes is one entry per mesh, differing only in {@link mesh}, each drawing its own particles
	 */
	meshWeights: number[];
	/** which of {@link meshWeights} the draw naming this entry shows */
	mesh: number;
	/**
	 * particles outlive their lifetime until newer ones replace them (Unity's ring buffer); `null` when they
	 * die at the end of it
	 */
	ringBuffer: ParticleRingBufferInfo | null;
	/** a flipbook the particles step through (Unity's `TextureSheetAnimationModule`); `null` without */
	textureSheet: ParticleTextureSheetInfo | null;
}

/** how a ring-buffered particle carries on past its lifetime */
export interface ParticleRingBufferInfo {
	/** `false` holds it at its end state; `true` replays the part of its lifetime in {@link loopRange} */
	loop: boolean;
	/** the replayed span, as fractions of the lifetime */
	loopRange: [number, number];
}

/** {@link ParticleTextureSheetInfo.row} values besides a fixed row */
export const SheetRow = {
	/** a random row per particle */
	Random: -1,
	/** the row of the particle's mesh, {@link ParticleSystemInfo.mesh} */
	MeshIndex: -2,
} as const;

/**
 * a grid of tiles the particle mesh's UVs are remapped into, one tile at a time. tiles count left to right,
 * then top to bottom, from the texture's top-left. tile `i` maps a UV `uv` to `(uv + (i mod x, y − 1 −
 * floor(i / x))) / (x, y)`, UV (0, 0) being the texture's bottom-left as in Unity
 */
export interface ParticleTextureSheetInfo {
	/** tiles across and down, 1–64 each */
	tiles: [number, number];
	/**
	 * `null` steps through the whole sheet; a row number steps along that row alone, or a {@link SheetRow} value
	 * picks the row per particle
	 */
	row: number | null;
	/**
	 * the frame, as a fraction of the frames: read at the particle's age over its lifetime, repeated
	 * {@link cycles} times. `null` when frames advance by {@link fps} instead
	 */
	frameOverTime: MinMaxCurveInfo | null;
	/** frames per second, when {@link frameOverTime} is `null` */
	fps: number;
	/** added to the frame, as a fraction of the frames; read at the emission's place in its loop */
	startFrame: MinMaxCurveInfo;
	cycles: number;
	/** which UV sets take the tile: bit 0 for UV0, bit 1 for UV1 */
	uvChannels: number;
}

/** Unity's `VelocityModule`, with constant (or two-constant) terms */
export interface ParticleVelocityInfo {
	/** m/s along x, y and z */
	linear: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo];
	/** whether {@link linear} is in world axes rather than the emitter's */
	linearInWorld: boolean;
	/** radians per second about the emitter's x, y and z axes, through {@link orbitalOffset} */
	orbital: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo];
	orbitalOffset: Vec3;
	/** m/s away from {@link orbitalOffset} */
	radial: MinMaxCurveInfo;
	/** scales every velocity */
	speedModifier: MinMaxCurveInfo;
}
