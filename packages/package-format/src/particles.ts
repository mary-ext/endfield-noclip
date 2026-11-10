/**
 * the particles table. a discriminant mirroring a Unity enum keeps that enum's integers, gaps included
 * ({@link CurveMode}, {@link ParticleShapeKind}, …), so the packer copies the game's value through; a
 * discriminant the package introduces itself is a string ({@link ParticleMotionInfo},
 * {@link ParticleClampInfo}, {@link ParticleSheetRows})
 *
 * @module
 */

import type { AnimationCurve, Gradient } from './curves.ts';
import type { Vec3 } from './values.ts';

/**
 * `tables/particles.json.zst`: the particle systems that chain draws emit ({@link ChainDraw.particles}),
 * loaded with the core. each is a Unity `ParticleSystem` drawing one mesh or one quad per particle, reduced
 * to the modules a viewer can evaluate from a particle's emission time and its own random values: in closed
 * form, or, under a speed limit or force fields, by stepping the particle from its birth at
 * {@link PARTICLE_STEP_RATE}
 */
export interface ParticlesTable {
	systems: ParticleSystemInfo[];
}

/** Unity's gravity, m/s² down the world's y, which {@link ParticleFreeMotionInfo.gravityModifier} multiplies */
export const GRAVITY = 9.81;

/** {@link MinMaxCurveInfo.mode} values, Unity's `ParticleSystemCurveMode` */
export const CurveMode = {
	Constant: 0,
	Curve: 1,
	TwoCurves: 2,
	TwoConstants: 3,
} as const;

export type CurveMode = (typeof CurveMode)[keyof typeof CurveMode];

/**
 * a Unity `MinMaxCurve`: a constant, a curve, or a random value between two of either. every mode has a
 * `scalar`: the constant (or the upper one), or the curves' multiplier. curves are read at a normalized time
 * (a particle's age over its lifetime, or the emission time over the system's duration) and scaled by it
 */
export type MinMaxCurveInfo =
	| {
			mode: typeof CurveMode.Constant;
			scalar: number;
	  }
	| {
			mode: typeof CurveMode.TwoConstants;
			/** the upper constant */
			scalar: number;
			/** the lower constant */
			min: number;
	  }
	| {
			mode: typeof CurveMode.Curve;
			/** the curve's multiplier */
			scalar: number;
			curve: AnimationCurve;
	  }
	| {
			mode: typeof CurveMode.TwoCurves;
			/** both curves' multiplier */
			scalar: number;
			/** the upper curve */
			curve: AnimationCurve;
			/** the lower curve */
			minCurve: AnimationCurve;
	  };

/** a {@link MinMaxCurveInfo} of one constant or a random one between two */
export type ConstantMinMaxCurveInfo = Extract<
	MinMaxCurveInfo,
	{ mode: typeof CurveMode.Constant | typeof CurveMode.TwoConstants }
>;

/** an rgba colour as authored (sRGB rgb) */
export type ParticleColor = [r: number, g: number, b: number, a: number];

/** {@link MinMaxGradientInfo.mode} values, Unity's `ParticleSystemGradientMode` */
export const GradientMode = {
	Color: 0,
	Gradient: 1,
	TwoColors: 2,
	TwoGradients: 3,
	/** a random point of the gradient */
	RandomColor: 4,
} as const;

export type GradientMode = (typeof GradientMode)[keyof typeof GradientMode];

/**
 * a Unity `MinMaxGradient`: a colour, a gradient, a random value between two of either, or a random point of
 * a gradient. gradients are read at a normalized time, as {@link MinMaxCurveInfo}'s curves are
 */
export type MinMaxGradientInfo =
	| {
			mode: typeof GradientMode.Color;
			color: ParticleColor;
	  }
	| {
			mode: typeof GradientMode.Gradient;
			gradient: Gradient;
	  }
	| {
			mode: typeof GradientMode.TwoColors;
			min: ParticleColor;
			max: ParticleColor;
	  }
	| {
			mode: typeof GradientMode.TwoGradients;
			min: Gradient;
			max: Gradient;
	  }
	| {
			mode: typeof GradientMode.RandomColor;
			/** the gradient a random point is read from */
			gradient: Gradient;
	  };

/** {@link ParticleSystemInfo.renderMode} values, Unity's `ParticleSystemRenderMode` */
export const ParticleRenderMode = {
	/**
	 * a quad turned by {@link ParticleSystemInfo.alignment}: facing the camera, or along the world's or
	 * emitter's axes
	 */
	Billboard: 0,
	/** a quad facing the camera, stretched along the particle's velocity ({@link ParticleSystemInfo.stretch}) */
	Stretched: 1,
	/** a quad lying flat, facing up the world's y */
	Horizontal: 2,
	/** a quad facing the camera's heading, kept upright */
	Vertical: 3,
	/** the system's meshes ({@link ParticleSystemInfo.meshWeights}) */
	Mesh: 4,
} as const;

export type ParticleRenderMode = (typeof ParticleRenderMode)[keyof typeof ParticleRenderMode];

/** how a {@link ParticleRenderMode.Stretched} particle's quad lengthens */
export interface ParticleStretchInfo {
	/** its length in units of its width */
	lengthScale: number;
	/** metres added to its length per m/s of speed */
	velocityScale: number;
}

/** {@link ParticleShapeInfo.kind} values, Unity's `ParticleSystemShapeType` (those a viewer emits from) */
export const ParticleShapeKind = {
	Sphere: 0,
	Hemisphere: 2,
	/** from the base disc, along the cone */
	Cone: 4,
	Box: 5,
	/** from a mesh's vertices, edges or triangles ({@link ParticleShapeMeshInfo}) */
	Mesh: 6,
	/** from anywhere inside the cone, up to its length */
	ConeVolume: 8,
	Circle: 10,
	/** from inside a torus around the circle, outwards from its tube's centre line */
	Donut: 17,
} as const;

export type ParticleShapeKind = (typeof ParticleShapeKind)[keyof typeof ParticleShapeKind];

/**
 * where particles start and which way they leave (Unity's `ShapeModule`), in the emitter's frame: the fields
 * of its kind, then its {@link ParticleShapePlacement}. a box spans the unit cube around the shape's centre,
 * leaving along +z
 */
export type ParticleShapeInfo = (
	| ({ kind: typeof ParticleShapeKind.Sphere | typeof ParticleShapeKind.Hemisphere } & ParticleShapeRadius)
	| ({ kind: typeof ParticleShapeKind.Cone } & ParticleShapeRadius & ParticleShapeArc & ParticleShapeCone)
	| ({ kind: typeof ParticleShapeKind.ConeVolume } & ParticleShapeRadius &
			ParticleShapeArc &
			ParticleShapeCone & {
				/** the cone's length, m */
				length: number;
			})
	| ({ kind: typeof ParticleShapeKind.Circle } & ParticleShapeRadius & ParticleShapeArc)
	| ({ kind: typeof ParticleShapeKind.Donut } & ParticleShapeRadius &
			ParticleShapeArc & {
				/** the tube's radius, m */
				donutRadius: number;
			})
	| { kind: typeof ParticleShapeKind.Box }
	| {
			kind: typeof ParticleShapeKind.Mesh;
			mesh: ParticleShapeMeshInfo;
	  }
) &
	ParticleShapePlacement;

/** what every {@link ParticleShapeInfo} has: its placement in the emitter and how it scatters its particles */
export interface ParticleShapePlacement {
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

/** a round {@link ParticleShapeInfo}'s size */
export interface ParticleShapeRadius {
	/** m; a donut's circle through its tube's centre */
	radius: number;
	/**
	 * the outer fraction of the radius particles start in: 0 on the edge only, 1 anywhere inside. a donut
	 * applies it to its tube's radius
	 */
	radiusThickness: number;
}

/** the part of a circle a cone, circle or donut {@link ParticleShapeInfo} uses */
export interface ParticleShapeArc {
	/** degrees from +x towards +y */
	arc: number;
}

/** a cone {@link ParticleShapeInfo}'s opening */
export interface ParticleShapeCone {
	/** the half angle, degrees */
	angle: number;
}

/** {@link ParticleShapeMeshInfo.placement} values, Unity's `ParticleSystemMeshShapeType` */
export const ParticleMeshPlacement = {
	Vertex: 0,
	Edge: 1,
	Triangle: 2,
} as const;

export type ParticleMeshPlacement = (typeof ParticleMeshPlacement)[keyof typeof ParticleMeshPlacement];

/** {@link ParticleShapeMeshInfo.spawn} values: how {@link ParticleMeshPlacement.Vertex} picks its vertex */
export const ParticleMeshSpawn = {
	/** a random primitive, then a random corner of it */
	Random: 0,
	/** the particle's emission number, wrapping around the vertex buffer */
	Loop: 1,
	/** the particle's emission number, back and forth along the vertex buffer */
	PingPong: 2,
} as const;

export type ParticleMeshSpawn = (typeof ParticleMeshSpawn)[keyof typeof ParticleMeshSpawn];

/**
 * the mesh a {@link ParticleShapeKind.Mesh} shape emits from, in the shape's own frame before its placement. a
 * particle starts at a point of a primitive: one of its corners ({@link ParticleMeshPlacement.Vertex}), a
 * point on its outline, each side taking a third of the picks whatever its length (Edge), or a point anywhere
 * on it (Triangle). Edge and Triangle pick the primitive by its area (a line's length); Vertex picks it
 * evenly. it leaves along the point's normal, offset along it by {@link normalOffset}
 */
export interface ParticleShapeMeshInfo {
	placement: ParticleMeshPlacement;
	spawn: ParticleMeshSpawn;
	/** Edge picks its place along the outline in steps of this fraction; 0 anywhere */
	spread: number;
	/** m along the interpolated normal, before it's normalized */
	normalOffset: number;
	/** xyz per vertex, m */
	positions: number[];
	/** xyz per vertex; `null` when the mesh has none, leaving along +z */
	normals: number[] | null;
	/** rgba per vertex, 0–255, multiplying the authored start colour; `null` when it doesn't */
	colors: number[] | null;
	/** vertex indices per primitive: 3 for triangles, 2 for lines */
	corners: 2 | 3;
	/** {@link corners} vertex indices per primitive */
	primitives: number[];
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

/**
 * {@link ParticleSystemInfo.alignment} values, Unity's `ParticleSystemRenderSpace` (those a viewer orients
 * by): the frame a mesh or {@link ParticleRenderMode.Billboard} quad's rotation applies in. other quads ignore
 * it
 */
export const ParticleAlignment = {
	/** the camera's, so the particle turns with it */
	View: 0,
	/** the world's */
	World: 1,
	/** the emitter's */
	Local: 2,
	/** the emitter's, turned the shortest way from its +z onto the particle's velocity */
	Velocity: 4,
} as const;

export type ParticleAlignment = (typeof ParticleAlignment)[keyof typeof ParticleAlignment];

/**
 * one particle system. positions are in the emitter's frame, the instance row's transform: the particle's
 * world position is that transform applied to its local one. Unity's gravity always points down the world's
 * y, so it is given in the world frame
 */
export interface ParticleSystemInfo {
	/**
	 * what each particle draws. every mode but {@link ParticleRenderMode.Mesh} draws a unit quad in its xy plane
	 * (the chain draw's geometry), turned as the mode says
	 */
	renderMode: ParticleRenderMode;
	/** how {@link ParticleRenderMode.Stretched} quads lengthen; `null` for other modes */
	stretch: ParticleStretchInfo | null;
	/**
	 * the smallest and largest a quad may be on screen, as fractions of the viewport's width at its depth: its
	 * larger side is held between them, scaling both (a stretched quad's length keeps its own). `null` for
	 * {@link ParticleRenderMode.Mesh}
	 */
	screenSize: { min: number; max: number } | null;
	/**
	 * whether the emitter matrix's scale sizes the particles as well as moving them; otherwise they keep their
	 * own size (Unity's `Shape` scaling mode). the packer resolves the other modes into the matrix itself
	 */
	sizedByScale: boolean;
	/** seconds per loop; emission stops after one when not {@link looping} */
	duration: number;
	looping: boolean;
	/** seconds before the first emission, a constant or two (one drawn per play) */
	startDelay: MinMaxCurveInfo;
	/** the most particles alive at once */
	maxParticles: number;
	/**
	 * the most particles one longest lifetime of emission holds, ignoring {@link maxParticles}. above the cap,
	 * which particles live depends on the emissions the cap turned away before
	 */
	emissionBound: number;
	/** the system's time scale */
	simulationSpeed: number;
	/** seconds; read at the emission time over the duration */
	startLifetime: MinMaxCurveInfo;
	/** each particle's colour, read at the emission's place in its loop; it multiplies the mesh's vertex colours */
	startColor: MinMaxGradientInfo;
	/** a multiplier of the start colour, read at each particle's age over its lifetime; `null` without */
	colorOverLifetime: MinMaxGradientInfo | null;
	/** x, y and z scale of the mesh, m */
	startSize: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo];
	/** Euler angles about x, y and z, radians */
	startRotation: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo];
	/** particles per second; a constant or two */
	rate: MinMaxCurveInfo;
	bursts: ParticleBurstInfo[];
	/** `null` emits every particle at the emitter's origin, along +z */
	shape: ParticleShapeInfo | null;
	/** how the particles move from where the shape starts them */
	motion: ParticleMotionInfo;
	/** a multiplier of the start size over each particle's lifetime, per axis; `null` without */
	sizeOverLifetime: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo] | null;
	/**
	 * angular velocity about x, y and z, radians per second, read at each particle's age over its lifetime; the
	 * angle is its integral over the age. `null` without
	 */
	rotationOverLifetime: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo] | null;
	alignment: ParticleAlignment;
	/**
	 * the mesh's offset from the particle's position, in units of its size; for mesh particles the packer has
	 * already multiplied the renderer's pivot by the mesh's size
	 */
	pivot: Vec3;
	/**
	 * the relative chance of each of the system's meshes (up to four); each particle draws one. a renderer with
	 * several meshes is one entry per mesh, differing only in {@link mesh}, each drawing its own particles.
	 * quads are one mesh, `[1]`
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
	/**
	 * what each particle's second texture coordinate set holds, x to w, which effect materials read as its
	 * custom data (Unity's `CustomDataModule`): each component a curve read every frame at the particle's age
	 * over its lifetime, its random value fixed for the particle's life, or `null` for 0. `null` when the
	 * renderer passes none
	 */
	customData: [ParticleCustom, ParticleCustom, ParticleCustom, ParticleCustom] | null;
}

/** one component of {@link ParticleSystemInfo.customData} */
export type ParticleCustom = MinMaxCurveInfo | null;

/** how a {@link ParticleSystemInfo}'s particles move: freely, or along a path */
export type ParticleMotionInfo = ParticleFreeMotionInfo | ParticleSplineInfo;

/** an ordinary system's motion: launched along the shape's direction, then moved by its modules */
export interface ParticleFreeMotionInfo {
	kind: 'free';
	/** m/s along the shape's start direction */
	startSpeed: MinMaxCurveInfo;
	/** times {@link GRAVITY} */
	gravityModifier: MinMaxCurveInfo;
	/** extra velocity over each particle's lifetime (Unity's `VelocityModule`); `null` without */
	velocity: ParticleVelocityInfo | null;
	/** what Unity's `ClampVelocityModule` does to the particles' speed; `null` without */
	clamp: ParticleClampInfo | null;
	/** the force fields pushing the particles (Unity's `ExternalForcesModule`); `null` without */
	forces: ParticleForcesInfo | null;
}

/** the force fields a system's particles feel, stepped at {@link PARTICLE_STEP_RATE} */
export interface ParticleForcesInfo {
	/** scales every field's push, read at the particle's age over its lifetime */
	multiplier: MinMaxCurveInfo;
	fields: ParticleForceFieldInfo[];
}

/** the rate a viewer steps particles whose motion has no closed form (force fields, speed limits), per second */
export const PARTICLE_STEP_RATE = 30;

/**
 * one Unity `ParticleSystemForceField` with a sphere shape. a particle feels it only while its distance from
 * the field's centre, measured in the field's own frame (scale included), lies between {@link startRange} and
 * {@link endRange}. every curve but the multiplier is read at that distance's place between the two, 0–1; two
 * constants pick one value per particle, the same for every field. each step the field changes the particle's
 * own velocity (after gravity, before the velocity module) by its direction, gravity, swirl and drag, in that
 * order, each scaled by the multiplier; the terms are in docs/game-data/particles.md's external forces
 */
export interface ParticleForceFieldInfo {
	/**
	 * the emitter's frame as seen from the field's, a 4×4 column-major matrix: it takes a particle's position
	 * to the field's frame, and its inverse's 3×3 part takes the field's vectors back
	 */
	fromEmitter: number[];
	/** in the field's units */
	startRange: number;
	endRange: number;
	/** the part of the range, 0–1, within which gravity pushes outwards rather than pulling in */
	gravityFocus: number;
	/** each particle's swirl axis tilts by up to ± half a turn times these, about x and about z */
	rotationRandomness: [x: number, z: number];
	/** m/s² along the field's x, y and z */
	direction: [MinMaxCurveInfo, MinMaxCurveInfo, MinMaxCurveInfo];
	/** the pull towards the field's centre when positive, m/s per 1/30 s */
	gravity: MinMaxCurveInfo;
	/** m/s about the field's +y: the swirl the whole velocity is pulled towards */
	rotationSpeed: MinMaxCurveInfo;
	/** 0–1: the share of the way to the swirl the velocity is pulled per 1/30 s */
	rotationAttraction: MinMaxCurveInfo;
	/**
	 * m/s² off the speed, to no less than 0: times the cross-section `π (size / 2)²` with {@link dragBySize} and
	 * the speed squared with {@link dragByVelocity}
	 */
	drag: MinMaxCurveInfo;
	dragBySize: boolean;
	dragByVelocity: boolean;
}

/**
 * Unity's `ClampVelocityModule`: drag slowing each particle's start velocity and its fall, or (with a
 * `dampen`) a speed limit each particle's speed is pulled down to, which carries the module's drag with it
 */
export type ParticleClampInfo = ParticleDragInfo | ParticleSpeedLimitInfo;

/** one cubic Bézier segment of a {@link ParticleSplineInfo}, in the emitter's frame */
export interface SplineSegmentInfo {
	/** the start point, its two control points and the end point */
	points: [Vec3, Vec3, Vec3, Vec3];
	/** m along the path this segment takes up, the length the game gives it */
	length: number;
}

/**
 * a path of cubic Bézier segments laid end to end (Beyond's `HGSplineMovingObjects`). a particle `d` metres
 * along it lies in the segment its distance falls in, at the Bézier parameter `(d − segment start) / length`,
 * which is linear in distance only for evenly spaced control points. it dies once `d` passes the last
 * segment's end, even within its lifetime
 */
export interface ParticleSplineInfo {
	kind: 'spline';
	segments: SplineSegmentInfo[];
	/** m/s along the path, read at the particle's age over its lifetime; the distance is its integral */
	speed: MinMaxCurveInfo;
}

/** how a ring-buffered particle carries on past its lifetime */
export interface ParticleRingBufferInfo {
	/** `false` holds it at its end state; `true` replays the part of its lifetime in {@link loopRange} */
	loop: boolean;
	/** the replayed span, as fractions of the lifetime */
	loopRange: [number, number];
}

/** which tiles of a {@link ParticleTextureSheetInfo} a particle steps through */
export type ParticleSheetRows =
	/** the whole sheet */
	| { kind: 'all' }
	/** one row, the same for every particle */
	| {
			kind: 'fixed';
			/** 0 for the top row, up to the sheet's rows less one */
			row: number;
	  }
	/** a random row per particle */
	| { kind: 'random' }
	/** the row numbered by the particle's mesh, {@link ParticleSystemInfo.mesh} */
	| { kind: 'mesh' };

/** {@link ParticleTextureSheetInfo.uvChannels} bits */
export const SheetUvChannels = {
	Uv0: 1 << 0,
	Uv1: 1 << 1,
} as const;

/**
 * a grid of tiles the particle mesh's UVs are remapped into, one tile at a time. tiles count left to right,
 * then top to bottom, from the texture's top-left. tile `i` maps a UV `uv` to `(uv + (i mod x, y − 1 −
 * floor(i / x))) / (x, y)`, UV (0, 0) being the texture's bottom-left as in Unity
 */
export interface ParticleTextureSheetInfo {
	/** tiles across and down, 1–64 each */
	tiles: [number, number];
	rows: ParticleSheetRows;
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
	/** which UV sets take the tile, {@link SheetUvChannels} bits */
	uvChannels: number;
}

/** how strongly the air slows a particle: its deceleration is {@link amount} times the factors chosen */
export interface ParticleDragInfo {
	kind: 'drag';
	/** a constant or two */
	amount: MinMaxCurveInfo;
	/** times the particle's cross-section, π (size / 2)² */
	bySize: boolean;
	/** times its speed squared rather than its speed */
	byVelocity: boolean;
}

/**
 * a limit on a particle's whole speed, its velocity over lifetime included. while the speed exceeds the
 * limit, each step pulls it {@link dampen} of the way down to the limit per 1/30 s along the same direction,
 * taking the excess from the particle's own velocity (the formula is in docs/game-data/particles.md's Limit
 * Velocity)
 */
export interface ParticleSpeedLimitInfo {
	kind: 'limit';
	/** m/s, read at the particle's age over its lifetime */
	limit: MinMaxCurveInfo;
	/** the fraction of the excess removed per 1/30 s, above 0 */
	dampen: number;
	/** the module's drag, which each step applies to the limited speed; `null` without */
	drag: ParticleDragInfo | null;
}

/** Unity's `VelocityModule`; every curve is read at the particle's age over its lifetime */
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
