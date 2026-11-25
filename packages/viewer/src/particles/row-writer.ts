import {
	ParticleAlignment,
	ParticleRenderMode,
	SheetUvChannels,
	type ParticleSystemInfo,
} from '@endfield-noclip/package-format/particles';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import {
	ROW_WORDS,
	RowBillboard,
	RowKind,
	RowWord,
	packRowColor,
	packRowCustom,
	rowSheet,
} from '../content/instance-rows.ts';
import { times3Columns, times3ColumnsInto } from '../math/mat3.ts';
import { type Quat, rotateInto, turnFromZInto } from '../math/quat.ts';
import { normalizeOrZ, normalizeOrZInto } from '../math/vec3.ts';

import { emitterFrameInto, multiplyRowsInto } from './emitter-motion.ts';
import {
	MAX_PARTICLES,
	PARTICLE_FLOATS,
	ParticleFloat,
	type ParticleSimulation,
	TRAIL_POINT_FLOATS,
	TRAIL_POINTS,
	TrailFloat,
} from './simulation.ts';
import { velocityBasisInto } from './vector-math.ts';

/** the camera inputs particle rows depend on */
export interface ParticleView {
	/** seconds of the viewer's clock */
	time: number;
	/** the camera's position (Unity world, f64), which stretched particles turn their width by */
	eye: Vec3;
	/** the viewport's width per metre of view depth, which quads' on-screen size limits are fractions of */
	widthPerDepth: number;
	/** the camera's right, up and forward axes (Unity frame), which view-aligned particles turn with */
	right: Vec3;
	up: Vec3;
	forward: Vec3;
}

/** rows per particle's trail */
export const TRAIL_SEGMENTS = TRAIL_POINTS - 1;

/** an emitter's simulation and placement metadata, read by {@link ParticleRowWriter} */
export interface EmitterState {
	simulation: ParticleSimulation;
	/** the viewer time its system time counts from */
	start: number;
	/** its system time at {@link start} */
	offset: number;
	/** maximum rows allocated for this emitter */
	capacity: number;
	/** the block's world origin, f64 */
	origin: readonly [x: number, y: number, z: number];
	/** the block's slot, which its particles' rows name */
	blockSlot: number;
}

/**
 * @returns the axes `row_basis` (frame-core.ts) turns a row's own by for its billboard kind, as columns, or
 *   `null` for a row it leaves be
 */
const billboardBasis = (billboard: RowBillboard, view: ParticleView): readonly Vec3[] | null => {
	switch (billboard) {
		case RowBillboard.Facing: {
			return [view.right, view.up, view.forward];
		}
		case RowBillboard.Upright: {
			// level and defined even looking straight down; Unity's forward is right × up
			const right = normalizeOrZ([view.right[0], 0, view.right[2]]);
			return [right, [0, 1, 0], [-right[2], 0, right[0]]];
		}
		default: {
			return null;
		}
	}
};

/**
 * turns a vector in a row's frame as `row_basis` (frame-core.ts) turns the row's axes for its billboard kind
 *
 * @param billboard the row's billboard kind
 * @param view the camera's axes
 * @param v the vector in the row's frame
 * @returns it in the world's
 */
export const turnedByBillboard = (
	billboard: RowBillboard,
	view: ParticleView,
	v: readonly number[],
): Vec3 => {
	const basis = billboardBasis(billboard, view);
	return basis === null ? [v[0], v[1], v[2]] : times3Columns(basis, v);
};

/** @returns what {@link screenLimited} scales a quad's x and y sizes by */
const screenRatio = (
	sizes: ArrayLike<number>,
	limits: { min: number; max: number },
	view: ParticleView,
	at: Readonly<Vec3>,
): number => {
	const f = view.forward;
	const depth = (at[0] - view.eye[0]) * f[0] + (at[1] - view.eye[1]) * f[1] + (at[2] - view.eye[2]) * f[2];
	const half = 0.5 * Math.max(sizes[0], sizes[1], 1e-6);
	// the game's tests, signs included: behind the camera the minimum's bound turns negative, which hides the
	// quad only when the minimum is above 0, and the maximum's negative bound is ignored, so with no minimum the
	// quad keeps its whole size there
	const width = view.widthPerDepth * depth;
	const low = limits.min * width;
	const high = limits.max * width;
	let held = low >= 0 ? Math.max(half, 0.5 * low) : 0;
	if (high >= 0) {
		held = Math.min(held, 0.5 * high);
	}
	return held / half;
};

/**
 * holds a quad's larger side between its on-screen limits, as the engine does before building quads
 *
 * @param sizes the quad's sizes along its x, y and z, m
 * @param limits the smallest and largest it may be, as fractions of the viewport's width at its depth
 * @param view the camera
 * @param at the particle's world position
 * @returns the sizes scaled together to fit. behind the camera (or on its plane) they're zero when the
 *   minimum is above 0 and unchanged when it's 0
 */
export const screenLimited = (
	sizes: readonly number[],
	limits: { min: number; max: number },
	view: ParticleView,
	at: Vec3,
): number[] => {
	const ratio = screenRatio(sizes, limits, view, at);
	return [sizes[0] * ratio, sizes[1] * ratio, sizes[2]];
};

// #region row geometry

/** a particle's row as the steps below build it: its axes, its size along each, and its centre */
interface RowGeometry {
	/** unit axes, or scaled ones for meshes turned by the emitter's transform */
	axes: [Vec3, Vec3, Vec3];
	sizes: Vec3;
	/** relative to the block's origin */
	center: Vec3;
}

/** what the render mode's step reads of a particle, besides its row so far */
interface ParticleInput {
	/** its size along each axis, as the simulation gives it */
	size: Vec3;
	/** its velocity in the emitter's frame */
	velocity: Vec3;
	/** its y size, scaled, before the on-screen limits: a stretched quad's length comes from it */
	length: number;
}

/** one emitter's frame and what every row of its system shares, this frame */
interface RowContext {
	info: ParticleSystemInfo;
	view: ParticleView;
	origin: readonly [x: number, y: number, z: number];
	/** the emitter's rows3x4 transform, translation relative to the block's origin */
	m: Float64Array;
	/** the lengths of the transform's columns: the emitter's scale */
	scales: Readonly<Vec3>;
	/** the scale where it sizes the particles, else ones: the transform's scale always moves them */
	sizing: Readonly<Vec3>;
	/** the camera-facing kind `row_basis` turns the rows by on the GPU */
	billboard: RowBillboard;
	/** the frame quads turn in, as columns: the emitter's or lying flat facing up; `null` to leave them */
	quadFrame: readonly Vec3[] | null;
	/** whether the pivot offsets the row in its own frame (stretched quads place it themselves) */
	pivoted: boolean;
	/** whether {@link shape} leaves {@link RowGeometry.axes} unit-length, so extent needs no axis norms */
	unitAxes: boolean;
	/** turns and sizes the row by the render mode and alignment */
	shape: (row: RowGeometry, particle: Readonly<ParticleInput>, context: RowContext) => void;
}

const vec3 = (): Vec3 => [0, 0, 0];
const UNIT: Readonly<Vec3> = [1, 1, 1];
const WORLD_DOWN: Readonly<Vec3> = [0, -1, 0];
const STILL_STRETCH = {
	lengthScale: 1,
	velocityScale: 0,
	freeform: false,
	rotateWithStretchDirection: false,
};
/** a horizontal quad's frame: lying flat, facing up */
const FLAT: readonly Vec3[] = [
	[1, 0, 0],
	[0, 0, 1],
	[0, -1, 0],
];
/** a trail segment's ends, then its centre and line of sight, and its axes (`ParticleRowWriter#writeTrails`) */
const trailScratch: [Vec3, Vec3, Vec3, Vec3, Vec3] = [vec3(), vec3(), vec3(), vec3(), vec3()];

// every particle row is rebuilt each frame, so the steps work in these rather than allocating. each is written
// by the one step named beside it; frames don't nest
const scratch = {
	/** {@link toLocal}'s result */
	local: vec3(),
	/** a particle's velocity in the world's frame (`stretchedShape`, `meshVelocityShape`) */
	world: vec3(),
	/** the turn from +z onto the velocity (`quadShape`) */
	onto: [0, 0, 0, 1] satisfies Quat,
	/** the line of sight to the particle (`stretchedShape`) */
	sight: vec3(),
	/** the look rotation along the velocity (`meshVelocityShape`) */
	basis: [vec3(), vec3(), vec3()] satisfies [Vec3, Vec3, Vec3],
	/** the particle's world position (on-screen limits) and pivot offset (`ParticleRowWriter#write`) */
	at: vec3(),
	shift: vec3(),
};

/** writes `v` turned (not moved) by the emitter's transform into `out` @returns `out` */
const toWorldInto = (out: Vec3, m: Float64Array, x: number, y: number, z: number): Vec3 => {
	out[0] = m[0] * x + m[1] * y + m[2] * z;
	out[1] = m[4] * x + m[5] * y + m[6] * z;
	out[2] = m[8] * x + m[9] * y + m[10] * z;
	return out;
};

/**
 * quads keep their rotation (clockwise about z as Unity's billboard job turns), turned onto the velocity for
 * velocity alignment, then into their frame
 */
const quadShape = (row: RowGeometry, particle: Readonly<ParticleInput>, context: RowContext): void => {
	// in Unity's billboard quad job (0x1800cc5b0), positive 2D Z rotation turns clockwise when viewing the quad's
	// front (-z): x' = cos·right - sin·up, y' = sin·right + cos·up
	const [ax0, ax1, ax2] = row.axes;
	if (ax2[0] === 0 && ax2[1] === 0 && ax2[2] === 1) {
		ax0[1] = -ax0[1];
		ax1[0] = -ax1[0];
	}
	if (context.info.alignment === ParticleAlignment.Velocity) {
		const onto = turnFromZInto(scratch.onto, particle.velocity);
		for (const axis of row.axes) {
			rotateInto(axis, onto, axis[0], axis[1], axis[2]);
		}
	}
	const frame = context.quadFrame;
	if (frame !== null) {
		for (const axis of row.axes) {
			times3ColumnsInto(axis, frame, axis[0], axis[1], axis[2]);
		}
	}
};

/**
 * a streak from the particle back along its velocity, lengthened by the length scale and the speed. in Unity
 * (`0x1803aa9e0`) U runs from 0 at the head to 1 at the tail (`−vel`) and V runs across the velocity as seen
 * from the camera's position, flattened onto the view plane, so turning the camera in place leaves it be
 */
const stretchedShape = (row: RowGeometry, particle: Readonly<ParticleInput>, context: RowContext): void => {
	const { view, origin, info } = context;
	const { axes, sizes, center } = row;
	const [back, across, face] = axes;
	const v = particle.velocity;
	const velocity = toWorldInto(scratch.world, context.m, v[0], v[1], v[2]);
	const speed = Math.sqrt(velocity[0] * velocity[0] + velocity[1] * velocity[1] + velocity[2] * velocity[2]);
	// a still particle has no streak, and the game draws nothing for it
	let sx: number;
	let sy: number;
	let sz: number;
	if (speed > 1e-15) {
		const inv = 1 / speed;
		sx = velocity[0] * inv;
		sy = velocity[1] * inv;
		sz = velocity[2] * inv;
	} else {
		sx = view.up[0];
		sy = view.up[1];
		sz = view.up[2];
	}
	back[0] = -sx;
	back[1] = -sy;
	back[2] = -sz;
	const f = view.forward;
	const sight = scratch.sight;
	sight[0] = origin[0] + center[0] - view.eye[0];
	sight[1] = origin[1] + center[1] - view.eye[1];
	sight[2] = origin[2] + center[2] - view.eye[2];
	const acrossX = sy * sight[2] - sz * sight[1];
	const acrossY = sz * sight[0] - sx * sight[2];
	const acrossZ = sx * sight[1] - sy * sight[0];
	const ahead = acrossX * f[0] + acrossY * f[1] + acrossZ * f[2];
	const flatX = acrossX - f[0] * ahead;
	const flatY = acrossY - f[1] * ahead;
	const flatZ = acrossZ - f[2] * ahead;
	// one moving along the line of sight has no width, so the game draws nothing for it either
	const flatLength = Math.sqrt(flatX * flatX + flatY * flatY + flatZ * flatZ);
	if (flatLength > 1e-15) {
		normalizeOrZInto(across, flatX, flatY, flatZ);
	} else {
		for (let r = 0; r < 3; r++) {
			across[r] = view.right[r];
		}
	}
	// the face's own normal, which the effect shaders' Fresnel fades by, turned so the quad's -z normal faces
	// the camera
	normalizeOrZInto(
		face,
		back[1] * across[2] - back[2] * across[1],
		back[2] * across[0] - back[0] * across[2],
		back[0] * across[1] - back[1] * across[0],
	);
	if (face[0] * sight[0] + face[1] * sight[1] + face[2] * sight[2] < 0) {
		for (let r = 0; r < 3; r++) {
			face[r] = -face[r];
		}
	}
	const stretch = info.stretch ?? STILL_STRETCH;
	const drawn = speed > 1e-15 && flatLength > 1e-15;
	const width = drawn ? sizes[0] : 0;
	const length = drawn ? particle.length * stretch.lengthScale + speed * stretch.velocityScale : 0;
	if (drawn) {
		if (length < 0) {
			// in Unity (0x1803aa9e0), tail = head - vel * length sits ahead of head, so T × H also flips sign:
			// both axes negate (180° in-plane turn), keeping positive determinant and front-face winding
			back[0] = sx;
			back[1] = sy;
			back[2] = sz;
			across[0] = -across[0];
			across[1] = -across[1];
			across[2] = -across[2];
			sizes[0] = -length;
		} else {
			sizes[0] = length;
		}
		sizes[1] = width;
	} else {
		sizes.fill(0);
	}
	// the unit quad is centred, and the particle sits at the streak's head. the game's pivot moves the head
	// along the velocity by its y times the size before the limits, and the whole streak across by its x times
	// half the width
	const pivot = info.pivot;
	const along = pivot[1] * particle.length - length * 0.5;
	const side = pivot[0] * width * 0.5;
	center[0] += sx * along + across[0] * side;
	center[1] += sy * along + across[1] * side;
	center[2] += sz * along + across[2] * side;
};

/**
 * a centred camera-facing billboard linearly stretched along the particle's velocity
 * (`m_FreeformStretching`). unlike legacy stretched quads, the quad stays centred on the particle (even when
 * still), keeps its Z rotation (plus the projected velocity angle when `rotateWithStretchDirection` is set),
 * and stretches its axes and pivot offset by `S(u) = u + (factor - 1) * dot(u, v̂) * v̂`
 */
const freeformStretchedShape = (
	row: RowGeometry,
	particle: Readonly<ParticleInput>,
	context: RowContext,
): void => {
	const { view, origin, info } = context;
	const { axes, sizes, center } = row;
	const [ax0, ax1, face] = axes;
	const stretch = info.stretch ?? STILL_STRETCH;
	const v = particle.velocity;
	const velocity = toWorldInto(scratch.world, context.m, v[0], v[1], v[2]);
	const speed = Math.sqrt(velocity[0] * velocity[0] + velocity[1] * velocity[1] + velocity[2] * velocity[2]);
	const moving = speed > 1e-15;
	const vx = moving ? velocity[0] / speed : 0;
	const vy = moving ? velocity[1] / speed : 0;
	const vz = moving ? velocity[2] / speed : 0;
	const stretchFactor = Math.abs(
		(moving && sizes[1] > 1e-15 ? (stretch.velocityScale * speed) / sizes[1] : 0) + stretch.lengthScale,
	);

	// camera-facing billboard basis (bx, by, bz) at the particle's world position
	const sight = scratch.sight;
	sight[0] = origin[0] + center[0] - view.eye[0];
	sight[1] = origin[1] + center[1] - view.eye[1];
	sight[2] = origin[2] + center[2] - view.eye[2];
	const sightLen = Math.sqrt(sight[0] * sight[0] + sight[1] * sight[1] + sight[2] * sight[2]);
	let bzX: number;
	let bzY: number;
	let bzZ: number;
	if (sightLen > 1e-15) {
		const inv = 1 / sightLen;
		bzX = sight[0] * inv;
		bzY = sight[1] * inv;
		bzZ = sight[2] * inv;
	} else {
		bzX = view.forward[0];
		bzY = view.forward[1];
		bzZ = view.forward[2];
	}
	const up = view.up;
	let bxX = up[1] * bzZ - up[2] * bzY;
	let bxY = up[2] * bzX - up[0] * bzZ;
	let bxZ = up[0] * bzY - up[1] * bzX;
	const bxLen = Math.sqrt(bxX * bxX + bxY * bxY + bxZ * bxZ);
	if (bxLen > 1e-15) {
		const inv = 1 / bxLen;
		bxX *= inv;
		bxY *= inv;
		bxZ *= inv;
	} else {
		bxX = view.right[0];
		bxY = view.right[1];
		bxZ = view.right[2];
	}
	const byX = bzY * bxZ - bzZ * bxY;
	const byY = bzZ * bxX - bzX * bxZ;
	const byZ = bzX * bxY - bzY * bxX;

	// particle's Z rotation, plus the projected velocity angle when rotateWithStretchDirection is set
	let angle = Math.atan2(ax0[1], ax0[0]);
	if (stretch.rotateWithStretchDirection && moving) {
		const vDotZ = vx * bzX + vy * bzY + vz * bzZ;
		const px = vx - vDotZ * bzX;
		const py = vy - vDotZ * bzY;
		const pz = vz - vDotZ * bzZ;
		const pLen = Math.sqrt(px * px + py * py + pz * pz);
		if (pLen > 1e-15) {
			const inv = 1 / pLen;
			const dx = (bxX * px + bxY * py + bxZ * pz) * inv;
			const dy = Math.max(-1, Math.min(1, (byX * px + byY * py + byZ * pz) * inv));
			const sign = dx > 0 ? 1 : dx < 0 ? -1 : 0;
			angle += Math.acos(dy) * sign + Math.PI * 0.5;
		} else {
			angle += Math.PI * 0.5;
		}
	}
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const rxX = cos * bxX - sin * byX;
	const rxY = cos * bxY - sin * byY;
	const rxZ = cos * bxZ - sin * byZ;
	const ryX = sin * bxX + cos * byX;
	const ryY = sin * bxY + cos * byY;
	const ryZ = sin * bxZ + cos * byZ;

	// apply linear stretch S(u) = u + (stretchFactor - 1) * dot(u, v̂) * v̂ to both axes and pivot offset
	const k = moving ? stretchFactor - 1 : 0;
	const rxDot = k * (rxX * vx + rxY * vy + rxZ * vz);
	ax0[0] = rxX + rxDot * vx;
	ax0[1] = rxY + rxDot * vy;
	ax0[2] = rxZ + rxDot * vz;
	const ryDot = k * (ryX * vx + ryY * vy + ryZ * vz);
	ax1[0] = ryX + ryDot * vx;
	ax1[1] = ryY + ryDot * vy;
	ax1[2] = ryZ + ryDot * vz;

	// face normal, oriented so the quad's -z normal faces the camera
	normalizeOrZInto(
		face,
		ax0[1] * ax1[2] - ax0[2] * ax1[1],
		ax0[2] * ax1[0] - ax0[0] * ax1[2],
		ax0[0] * ax1[1] - ax0[1] * ax1[0],
	);
	if (face[0] * sight[0] + face[1] * sight[1] + face[2] * sight[2] < 0) {
		face[0] = -face[0];
		face[1] = -face[1];
		face[2] = -face[2];
	}

	const pivot = info.pivot;
	if (pivot[0] !== 0 || pivot[1] !== 0 || pivot[2] !== 0) {
		const p0 = sizes[0] * pivot[0];
		const p1 = sizes[1] * pivot[1];
		const p2 = sizes[2] * pivot[2];
		const px = rxX * p0 + ryX * p1 + bzX * p2;
		const py = rxY * p0 + ryY * p1 + bzY * p2;
		const pz = rxZ * p0 + ryZ * p1 + bzZ * p2;
		const pDot = k * (px * vx + py * vy + pz * vz);
		center[0] += px + pDot * vx;
		center[1] += py + pDot * vy;
		center[2] += pz + pDot * vz;
	}
};

/** a locally aligned mesh turns with the emitter's transform, which sizes it only when the system says so */
const meshLocalShape = (row: RowGeometry, particle: Readonly<ParticleInput>, context: RowContext): void => {
	const { axes, sizes } = row;
	const { m, scales } = context;
	for (const axis of axes) {
		toWorldInto(axis, m, axis[0], axis[1], axis[2]);
	}
	const s = particle.size;
	for (let k = 0; k < 3; k++) {
		sizes[k] = context.info.sizedByScale ? s[k] : s[k] / scales[k];
	}
};

/**
 * the game's look rotation along the world velocity, rolled level by the world's up, with the emitter's scale
 * applied along its axes
 */
const meshVelocityShape = (
	row: RowGeometry,
	particle: Readonly<ParticleInput>,
	context: RowContext,
): void => {
	const { axes, sizes } = row;
	const { m, sizing } = context;
	const v = particle.velocity;
	const basis = velocityBasisInto(scratch.basis, toWorldInto(scratch.world, m, v[0], v[1], v[2]));
	for (const axis of axes) {
		times3ColumnsInto(axis, basis, axis[0] * sizing[0], axis[1] * sizing[1], axis[2] * sizing[2]);
	}
	const s = particle.size;
	for (let k = 0; k < 3; k++) {
		sizes[k] = s[k];
	}
};

/** the row keeps its rotation: in the world's frame, or the camera's, which the GPU turns it with */
const keptShape = (): void => {};

/** writes what every row of an emitter's system shares this frame into `context` */
const fillRowContext = (
	context: RowContext,
	quadFrame: [Vec3, Vec3, Vec3],
	info: ParticleSystemInfo,
	view: ParticleView,
	origin: readonly [x: number, y: number, z: number],
	m: Float64Array,
	columns: readonly Vec3[],
	scales: Readonly<Vec3>,
): RowContext => {
	const pivot = info.pivot;
	context.info = info;
	context.view = view;
	context.origin = origin;
	context.m = m;
	context.scales = scales;
	context.sizing = info.sizedByScale ? scales : UNIT;
	context.billboard = RowBillboard.None;
	context.quadFrame = null;
	context.pivoted = pivot[0] !== 0 || pivot[1] !== 0 || pivot[2] !== 0;
	context.unitAxes = true;
	context.shape = quadShape;
	switch (info.renderMode) {
		case ParticleRenderMode.Billboard: {
			switch (info.alignment) {
				case ParticleAlignment.View: {
					context.billboard = RowBillboard.Facing;
					break;
				}
				case ParticleAlignment.World: {
					break;
				}
				case ParticleAlignment.Local:
				case ParticleAlignment.Velocity: {
					for (let i = 0; i < 3; i++) {
						const c = columns[i];
						normalizeOrZInto(quadFrame[i], c[0], c[1], c[2]);
					}
					context.quadFrame = quadFrame;
					break;
				}
			}
			break;
		}
		case ParticleRenderMode.Vertical: {
			context.billboard = RowBillboard.Upright;
			break;
		}
		case ParticleRenderMode.Horizontal: {
			context.quadFrame = FLAT;
			break;
		}
		case ParticleRenderMode.Stretched: {
			if (info.stretch?.freeform) {
				context.shape = freeformStretchedShape;
				context.unitAxes = false;
			} else {
				context.shape = stretchedShape;
			}
			context.pivoted = false;
			break;
		}
		case ParticleRenderMode.Mesh: {
			switch (info.alignment) {
				case ParticleAlignment.View: {
					context.billboard = RowBillboard.Facing;
					context.shape = keptShape;
					break;
				}
				case ParticleAlignment.World: {
					context.shape = keptShape;
					break;
				}
				case ParticleAlignment.Local: {
					context.shape = meshLocalShape;
					context.unitAxes = false;
					break;
				}
				case ParticleAlignment.Velocity: {
					context.shape = meshVelocityShape;
					context.unitAxes = false;
					break;
				}
			}
			break;
		}
	}
	return context;
};

// #endregion

/**
 * evaluates one emitter's particles and packs them into reusable GPU instance row storage. shared between the
 * main thread (synchronous first-frame / fallback path) and the particle worker
 */
export class ParticleRowWriter {
	/** packed output rows for the last {@link write} call, up to `MAX_PARTICLES` rows */
	readonly rows: Uint32Array<ArrayBuffer> = new Uint32Array(MAX_PARTICLES * ROW_WORDS);
	readonly #rowsF32 = new Float32Array(this.rows.buffer);
	readonly #particles = new Float32Array(MAX_PARTICLES * PARTICLE_FLOATS);
	readonly #m = new Float64Array(12);
	readonly #emittedAt = new Float64Array(12);
	readonly #placed = new Float64Array(12);
	readonly #columns: [Vec3, Vec3, Vec3] = [vec3(), vec3(), vec3()];
	readonly #scales = vec3();
	readonly #down = vec3();
	readonly #row: RowGeometry = { axes: [vec3(), vec3(), vec3()], sizes: vec3(), center: vec3() };
	readonly #particle: ParticleInput = { size: vec3(), velocity: vec3(), length: 0 };
	readonly #quadFrame: [Vec3, Vec3, Vec3] = [vec3(), vec3(), vec3()];
	#context: RowContext | null = null;
	readonly #color = new Float32Array(4);
	readonly #custom = new Float32Array(4);
	readonly #trail = new Float32Array(TRAIL_POINTS * TRAIL_POINT_FLOATS);

	/**
	 * turns a world direction into the emitter's frame: the inverse of a rotation times a scale, so it projects
	 * onto each column, divided by its squared length. its result is reused by the next call
	 */
	readonly #toLocal = (direction: Readonly<Vec3>): Vec3 => {
		const columns = this.#columns;
		const scales = this.#scales;
		const out = scratch.local;
		const [x, y, z] = direction;
		for (let i = 0; i < 3; i++) {
			const column = columns[i];
			out[i] = (column[0] * x + column[1] * y + column[2] * z) / Math.max(scales[i] * scales[i], 1e-12);
		}
		return out;
	};

	/**
	 * evaluates `emitter` at `view` and writes its instance rows into {@link rows}.
	 *
	 * @param emitter the emitter state and simulation
	 * @param transformF32 array containing the emitter's 3×4 transform
	 * @param transformOffset index of the first float of the transform in `transformF32`
	 * @param view the clock and camera
	 * @param padTo when set, pads shrunk counts up to `padTo` with degenerate rows and returns `-1` if the live
	 *   count exceeds `padTo`
	 * @returns live row count written, or `-1` when `padTo` was exceeded
	 */
	write(
		emitter: EmitterState,
		transformF32: Float32Array,
		transformOffset: number,
		view: ParticleView,
		padTo?: number,
	): number {
		if (emitter.simulation.info.trail === null) {
			return this.#writeQuads(emitter, transformF32, transformOffset, view, padTo);
		}
		return this.#writeTrails(emitter, transformF32, transformOffset, view, padTo);
	}

	/** reads an emitter's transform into {@link #m}, {@link #columns} and {@link #scales} */
	#readFrame(f32: Float32Array, at: number): void {
		const m = this.#m;
		for (let i = 0; i < 12; i++) {
			m[i] = f32[at + i];
		}
		this.#columnsOf(m);
	}

	/** sets {@link #columns} and {@link #scales} from a rows3x4 transform */
	#columnsOf(m: Float64Array): void {
		for (let i = 0; i < 3; i++) {
			const column = this.#columns[i];
			const x = m[i];
			const y = m[4 + i];
			const z = m[8 + i];
			column[0] = x;
			column[1] = y;
			column[2] = z;
			this.#scales[i] = Math.sqrt(x * x + y * y + z * z);
		}
	}

	/** evaluates an emitter's particles into {@link #particles} */
	#evaluate(
		emitter: EmitterState,
		transformF32: Float32Array,
		transformOffset: number,
		view: ParticleView,
		capacity: number,
	): number {
		const simulation = emitter.simulation;
		const info = simulation.info;
		this.#readFrame(transformF32, transformOffset);
		const m = this.#m;
		const speed = info.simulationSpeed;
		const time = (view.time - emitter.start) * speed + emitter.offset;
		const motion = info.emitterMotion;
		let emittedFrom: ((born: number) => Readonly<Float64Array>) | undefined;
		if (motion !== null) {
			if (motion.inWorld) {
				const at = this.#emittedAt;
				emittedFrom = (born) =>
					emitterFrameInto(motion, (born - emitter.offset) / Math.max(speed, 1e-6) + emitter.start, at);
			} else {
				const placed = this.#placed;
				for (let i = 0; i < 12; i++) {
					placed[i] = m[i];
				}
				multiplyRowsInto(m, placed, emitterFrameInto(motion, view.time, this.#emittedAt));
				this.#columnsOf(m);
			}
		}
		const down = this.#down;
		const local = this.#toLocal(WORLD_DOWN);
		for (let r = 0; r < 3; r++) {
			down[r] = local[r];
		}
		return simulation.evaluate(
			time,
			down,
			this.#toLocal,
			this.#particles.subarray(0, Math.min(capacity, MAX_PARTICLES) * PARTICLE_FLOATS),
			emittedFrom,
		);
	}

	#writeQuads(
		emitter: EmitterState,
		transformF32: Float32Array,
		transformOffset: number,
		view: ParticleView,
		padTo?: number,
	): number {
		const info = emitter.simulation.info;
		const count = this.#evaluate(emitter, transformF32, transformOffset, view, emitter.capacity);
		if (padTo !== undefined && count > padTo) {
			return -1;
		}
		const m = this.#m;
		const particles = this.#particles;
		const context =
			this.#context === null
				? (this.#context = {
						info,
						view,
						origin: emitter.origin,
						m,
						scales: this.#scales,
						sizing: UNIT,
						billboard: RowBillboard.None,
						quadFrame: null,
						pivoted: false,
						unitAxes: true,
						shape: quadShape,
					})
				: this.#context;
		fillRowContext(context, this.#quadFrame, info, view, emitter.origin, m, this.#columns, this.#scales);
		const { sizing, billboard, pivoted, unitAxes, shape } = context;
		const turnedBy = pivoted ? billboardBasis(billboard, view) : null;
		const origin = emitter.origin;
		const pivot = info.pivot;
		const screenSize = info.screenSize;
		const sheet = info.textureSheet;
		const hasCustom = info.customData !== null;
		const infoWord = (RowKind.Detail | (billboard << 30)) >>> 0;
		const slot = emitter.blockSlot;
		const out = this.#rowsF32;
		const words = this.rows;
		const geometry = this.#row;
		const { axes, sizes, center } = geometry;
		const [ax0, ax1, ax2] = axes;
		const particle = this.#particle;
		const { at, shift } = scratch;
		const color = this.#color;
		const custom = this.#custom;
		for (let i = 0; i < count; i++) {
			const base = i * PARTICLE_FLOATS;
			{
				const p = base + ParticleFloat.position;
				toWorldInto(center, m, particles[p], particles[p + 1], particles[p + 2]);
				center[0] = center[0] + m[3];
				center[1] = center[1] + m[7];
				center[2] = center[2] + m[11];
			}
			const qx = particles[base + ParticleFloat.rotation];
			const qy = particles[base + ParticleFloat.rotation + 1];
			const qz = particles[base + ParticleFloat.rotation + 2];
			const qw = particles[base + ParticleFloat.rotation + 3];
			if (qx === 0 && qy === 0) {
				const c = 1 - 2 * qz * qz;
				const s = 2 * qw * qz;
				ax0[0] = c;
				ax0[1] = s;
				ax0[2] = 0;
				ax1[0] = -s;
				ax1[1] = c;
				ax1[2] = 0;
				ax2[0] = 0;
				ax2[1] = 0;
				ax2[2] = 1;
			} else {
				const xx = 2 * qx * qx;
				const yy = 2 * qy * qy;
				const zz = 2 * qz * qz;
				const xy = 2 * qx * qy;
				const xz = 2 * qx * qz;
				const yz = 2 * qy * qz;
				const wx = 2 * qw * qx;
				const wy = 2 * qw * qy;
				const wz = 2 * qw * qz;
				ax0[0] = 1 - yy - zz;
				ax0[1] = xy + wz;
				ax0[2] = xz - wy;
				ax1[0] = xy - wz;
				ax1[1] = 1 - xx - zz;
				ax1[2] = yz + wx;
				ax2[0] = xz + wy;
				ax2[1] = yz - wx;
				ax2[2] = 1 - xx - yy;
			}
			const flip = particles[base + ParticleFloat.flip];
			particle.size[0] = particles[base + ParticleFloat.size];
			particle.size[1] = particles[base + ParticleFloat.size + 1];
			particle.size[2] = particles[base + ParticleFloat.size + 2];
			if (info.renderMode === ParticleRenderMode.Mesh && flip !== 0) {
				if (flip & 1) {
					particle.size[0] = -particle.size[0];
				}
				if (flip & 2) {
					particle.size[1] = -particle.size[1];
				}
				if (flip & 4) {
					particle.size[2] = -particle.size[2];
				}
			}
			particle.velocity[0] = particles[base + ParticleFloat.velocity];
			particle.velocity[1] = particles[base + ParticleFloat.velocity + 1];
			particle.velocity[2] = particles[base + ParticleFloat.velocity + 2];
			sizes[0] = particle.size[0] * sizing[0];
			sizes[1] = particle.size[1] * sizing[1];
			sizes[2] = particle.size[2] * sizing[2];
			particle.length = sizes[1];
			if (screenSize !== null) {
				at[0] = origin[0] + center[0];
				at[1] = origin[1] + center[1];
				at[2] = origin[2] + center[2];
				const ratio = screenRatio(sizes, screenSize, view, at);
				sizes[0] = sizes[0] * ratio;
				sizes[1] = sizes[1] * ratio;
			}
			shape(geometry, particle, context);
			if (pivoted) {
				const p0 = sizes[0] * pivot[0];
				const p1 = sizes[1] * pivot[1];
				const p2 = sizes[2] * pivot[2];
				shift[0] = ax0[0] * p0 + ax1[0] * p1 + ax2[0] * p2;
				shift[1] = ax0[1] * p0 + ax1[1] * p1 + ax2[1] * p2;
				shift[2] = ax0[2] * p0 + ax1[2] * p1 + ax2[2] * p2;
				if (turnedBy !== null) {
					times3ColumnsInto(shift, turnedBy, shift[0], shift[1], shift[2]);
				}
				center[0] += shift[0];
				center[1] += shift[1];
				center[2] += shift[2];
			}
			const s0 = sizes[0];
			const s1 = sizes[1];
			const s2 = sizes[2];
			const o = i * ROW_WORDS;
			out[o] = ax0[0] * s0;
			out[o + 1] = ax1[0] * s1;
			out[o + 2] = ax2[0] * s2;
			out[o + 3] = center[0];
			out[o + 4] = ax0[1] * s0;
			out[o + 5] = ax1[1] * s1;
			out[o + 6] = ax2[1] * s2;
			out[o + 7] = center[1];
			out[o + 8] = ax0[2] * s0;
			out[o + 9] = ax1[2] * s1;
			out[o + 10] = ax2[2] * s2;
			out[o + 11] = center[2];
			const extent = unitAxes
				? Math.max(Math.abs(s0), Math.abs(s1), Math.abs(s2))
				: Math.max(
						Math.sqrt(ax0[0] * ax0[0] + ax0[1] * ax0[1] + ax0[2] * ax0[2]) * Math.abs(s0),
						Math.sqrt(ax1[0] * ax1[0] + ax1[1] * ax1[1] + ax1[2] * ax1[2]) * Math.abs(s1),
						Math.sqrt(ax2[0] * ax2[0] + ax2[1] * ax2[1] + ax2[2] * ax2[2]) * Math.abs(s2),
					);
			out[o + 12] = center[0];
			out[o + 13] = center[1];
			out[o + 14] = center[2];
			out[o + RowWord.extent] = extent;
			out[o + RowWord.extent + 1] = extent;
			out[o + RowWord.extent + 2] = extent;
			words[o + RowWord.block] = slot;
			words[o + RowWord.info] = infoWord;
			const quadFlip = info.renderMode === ParticleRenderMode.Mesh ? 0 : flip & 3;
			words[o + RowWord.sheet] =
				sheet === null
					? quadFlip === 0
						? 0
						: rowSheet([1, 1], 0, 0, quadFlip)
					: rowSheet(sheet.tiles, particles[base + ParticleFloat.tile], sheet.uvChannels, quadFlip);
			color[0] = particles[base + ParticleFloat.color];
			color[1] = particles[base + ParticleFloat.color + 1];
			color[2] = particles[base + ParticleFloat.color + 2];
			color[3] = particles[base + ParticleFloat.color + 3];
			words[o + RowWord.color] = packRowColor(color);
			if (hasCustom) {
				custom[0] = particles[base + ParticleFloat.custom];
				custom[1] = particles[base + ParticleFloat.custom + 1];
				custom[2] = particles[base + ParticleFloat.custom + 2];
				custom[3] = particles[base + ParticleFloat.custom + 3];
				const [xy, zw] = packRowCustom(custom);
				words[o + RowWord.custom] = xy;
				words[o + RowWord.custom + 1] = zw;
			} else {
				words[o + RowWord.custom] = 0;
				words[o + RowWord.custom + 1] = 0;
			}
		}
		if (padTo !== undefined) {
			for (let i = count; i < padTo; i++) {
				const o = i * ROW_WORDS;
				words.fill(0, o, o + ROW_WORDS);
				words[o + RowWord.block] = slot;
			}
		}
		return count;
	}

	#writeTrails(
		emitter: EmitterState,
		transformF32: Float32Array,
		transformOffset: number,
		view: ParticleView,
		padTo?: number,
	): number {
		const simulation = emitter.simulation;
		const count = this.#evaluate(
			emitter,
			transformF32,
			transformOffset,
			view,
			Math.floor(emitter.capacity / TRAIL_SEGMENTS),
		);
		const m = this.#m;
		const origin = emitter.origin;
		const infoWord = RowKind.Detail;
		const slot = emitter.blockSlot;
		const out = this.#rowsF32;
		const words = this.rows;
		const points = this.#trail;
		const [head, tail, along, across, face] = trailScratch;
		const color = this.#color;
		let written = 0;
		for (let i = 0; i < count; i++) {
			if (simulation.trailPoints(i, this.#particles, points) === 0) {
				continue;
			}
			for (let j = 0; j < TRAIL_SEGMENTS; j++) {
				const a = j * TRAIL_POINT_FLOATS;
				const b = a + TRAIL_POINT_FLOATS;
				toWorldInto(head, m, points[a], points[a + 1], points[a + 2]);
				toWorldInto(tail, m, points[b], points[b + 1], points[b + 2]);
				for (let r = 0; r < 3; r++) {
					along[r] = tail[r] - head[r];
					head[r] = (head[r] + tail[r]) * 0.5 + m[r * 4 + 3];
					tail[r] = origin[r] + head[r] - view.eye[r];
				}
				const length = Math.sqrt(along[0] * along[0] + along[1] * along[1] + along[2] * along[2]);
				if (!(length > 1e-9)) {
					continue;
				}
				normalizeOrZInto(
					across,
					tail[1] * along[2] - tail[2] * along[1],
					tail[2] * along[0] - tail[0] * along[2],
					tail[0] * along[1] - tail[1] * along[0],
				);
				normalizeOrZInto(
					face,
					along[1] * across[2] - along[2] * across[1],
					along[2] * across[0] - along[0] * across[2],
					along[0] * across[1] - along[1] * across[0],
				);
				const width = (points[a + TrailFloat.width] + points[b + TrailFloat.width]) * 0.5;
				const o = written * ROW_WORDS;
				for (let r = 0; r < 3; r++) {
					out[o + r * 4] = along[r];
					out[o + r * 4 + 1] = across[r] * width;
					out[o + r * 4 + 2] = face[r] * width;
					out[o + r * 4 + 3] = head[r];
					out[o + 12 + r] = head[r];
					out[o + RowWord.extent + r] = Math.max(length, Math.abs(width));
				}
				words[o + RowWord.block] = slot;
				words[o + RowWord.info] = infoWord;
				words[o + RowWord.sheet] = rowSheet([TRAIL_SEGMENTS, 1], j, SheetUvChannels.Uv0);
				for (let k = 0; k < 4; k++) {
					color[k] = (points[a + TrailFloat.color + k] + points[b + TrailFloat.color + k]) * 0.5;
				}
				words[o + RowWord.color] = packRowColor(color);
				words[o + RowWord.custom] = 0;
				words[o + RowWord.custom + 1] = 0;
				written++;
			}
		}
		if (padTo !== undefined && written > padTo) {
			return -1;
		}
		if (padTo !== undefined) {
			for (let i = written; i < padTo; i++) {
				const o = i * ROW_WORDS;
				words.fill(0, o, o + ROW_WORDS);
				words[o + RowWord.block] = slot;
			}
		}
		return written;
	}
}
