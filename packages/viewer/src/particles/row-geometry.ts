/**
 * billboard, stretched, freeform-stretched, and mesh particle row-shaping math shared by
 * {@link ParticleRowWriter}.
 *
 * @module
 */

import {
	ParticleAlignment,
	ParticleRenderMode,
	type ParticleSystemInfo,
} from '@endfield-noclip/package-format/particles';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import { RowBillboard } from '../content/instance-rows.ts';
import { times3Columns, times3ColumnsInto } from '../math/mat3.ts';
import { type Quat, rotateInto, turnFromZInto } from '../math/quat.ts';
import { normalizeOrZ, normalizeOrZInto } from '../math/vec3.ts';

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

export const billboardBasis = (billboard: RowBillboard, view: ParticleView): readonly Vec3[] | null => {
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
export const screenRatio = (
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
export interface RowGeometry {
	/** unit axes, or scaled ones for meshes turned by the emitter's transform */
	axes: [Vec3, Vec3, Vec3];
	sizes: Vec3;
	/** relative to the block's origin */
	center: Vec3;
}

/** what the render mode's step reads of a particle, besides its row so far */
export interface ParticleInput {
	/** its size along each axis, as the simulation gives it */
	size: Vec3;
	/** its velocity in the emitter's frame */
	velocity: Vec3;
	/** its y size, scaled, before the on-screen limits: a stretched quad's length comes from it */
	length: number;
}

/** one emitter's frame and what every row of its system shares, this frame */
export interface RowContext {
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

export const vec3 = (): Vec3 => [0, 0, 0];
export const UNIT: Readonly<Vec3> = [1, 1, 1];
export const WORLD_DOWN: Readonly<Vec3> = [0, -1, 0];
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
export const trailScratch: [Vec3, Vec3, Vec3, Vec3, Vec3] = [vec3(), vec3(), vec3(), vec3(), vec3()];

// every particle row is rebuilt each frame, so the steps work in these rather than allocating. each is written
// by the one step named beside it; frames don't nest
export const scratch = {
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
export const toWorldInto = (out: Vec3, m: Float64Array, x: number, y: number, z: number): Vec3 => {
	out[0] = m[0] * x + m[1] * y + m[2] * z;
	out[1] = m[4] * x + m[5] * y + m[6] * z;
	out[2] = m[8] * x + m[9] * y + m[10] * z;
	return out;
};

/**
 * quads keep their rotation (clockwise about z as Unity's billboard job turns), turned onto the velocity for
 * velocity alignment, then into their frame
 */
export const quadShape = (row: RowGeometry, particle: Readonly<ParticleInput>, context: RowContext): void => {
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
export const fillRowContext = (
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
