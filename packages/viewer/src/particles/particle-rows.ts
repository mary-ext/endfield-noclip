import {
	ParticleAlignment,
	ParticleRenderMode,
	type ParticleSystemInfo,
	type ParticlesTable,
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
import type { RangeAllocation } from '../gfx/range-allocator.ts';
import { times3Columns, times3ColumnsInto } from '../math/mat3.ts';
import { type Quat, rotateInto, turnFromZInto } from '../math/quat.ts';
import { normalizeOrZ, normalizeOrZInto } from '../math/vec3.ts';

import { emitterFrameInto, multiplyRowsInto } from './emitter-motion.ts';
import { hash2, hashText } from './random.ts';
import { MAX_PARTICLES, PARTICLE_FLOATS, ParticleFloat, ParticleSimulation } from './simulation.ts';
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

/**
 * @returns the axes `row_basis` (frame.wgsl) turns a row's own by for its billboard kind, as columns, or
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
 * turns a vector in a row's frame as `row_basis` (frame.wgsl) turns the row's axes for its billboard kind
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
	/** turns and sizes the row by the render mode and alignment */
	shape: (row: RowGeometry, particle: Readonly<ParticleInput>, context: RowContext) => void;
}

const vec3 = (): Vec3 => [0, 0, 0];
const UNIT: Readonly<Vec3> = [1, 1, 1];
const WORLD_DOWN: Readonly<Vec3> = [0, -1, 0];
const STILL_STRETCH = { lengthScale: 1, velocityScale: 0 };
/** a horizontal quad's frame: lying flat, facing up */
const FLAT: readonly Vec3[] = [
	[1, 0, 0],
	[0, 0, 1],
	[0, -1, 0],
];
const NO_ROWS: readonly number[] = [];

/**
 * frames an emitter may go undrawn before it's forgotten, as the mesh selector drops unused buckets: long
 * enough to outlast a glance away, after which a non-looping system plays from its start again
 */
const EMITTER_LIFETIME = 600;

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
	/** the particle's world position (on-screen limits) and pivot offset (`ParticleField#write`) */
	at: vec3(),
	shift: vec3(),
	/** the particle's rotation (`ParticleField#write`) */
	rotation: [0, 0, 0, 1] satisfies Quat,
};

/** writes `v` turned (not moved) by the emitter's transform into `out` @returns `out` */
const toWorldInto = (out: Vec3, m: Float64Array, x: number, y: number, z: number): Vec3 => {
	out[0] = m[0] * x + m[1] * y + m[2] * z;
	out[1] = m[4] * x + m[5] * y + m[6] * z;
	out[2] = m[8] * x + m[9] * y + m[10] * z;
	return out;
};

/** quads keep their rotation, turned onto the velocity for velocity alignment, then into their frame */
const quadShape = (row: RowGeometry, particle: Readonly<ParticleInput>, context: RowContext): void => {
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
 * a streak from the particle back along its velocity, lengthened by the length scale and the speed. its width
 * runs across the velocity as seen from the camera's position, flattened onto the view plane, so turning the
 * camera in place leaves it be
 */
const stretchedShape = (row: RowGeometry, particle: Readonly<ParticleInput>, context: RowContext): void => {
	const { view, origin, info } = context;
	const { axes, sizes, center } = row;
	const [right, streak, face] = axes;
	const v = particle.velocity;
	const velocity = toWorldInto(scratch.world, context.m, v[0], v[1], v[2]);
	const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
	// a still particle has no streak, and the game draws nothing for it
	for (let r = 0; r < 3; r++) {
		streak[r] = speed > 1e-15 ? velocity[r] / speed : view.up[r];
	}
	const f = view.forward;
	const sight = scratch.sight;
	for (let r = 0; r < 3; r++) {
		sight[r] = origin[r] + center[r] - view.eye[r];
	}
	const acrossX = streak[1] * sight[2] - streak[2] * sight[1];
	const acrossY = streak[2] * sight[0] - streak[0] * sight[2];
	const acrossZ = streak[0] * sight[1] - streak[1] * sight[0];
	const ahead = acrossX * f[0] + acrossY * f[1] + acrossZ * f[2];
	const flatX = acrossX - f[0] * ahead;
	const flatY = acrossY - f[1] * ahead;
	const flatZ = acrossZ - f[2] * ahead;
	// one moving along the line of sight has no width, so the game draws nothing for it either
	const flatLength = Math.hypot(flatX, flatY, flatZ);
	if (flatLength > 1e-15) {
		normalizeOrZInto(right, flatX, flatY, flatZ);
	} else {
		for (let r = 0; r < 3; r++) {
			right[r] = view.right[r];
		}
	}
	// the face's own normal, which the effect shaders' Fresnel fades by, turned so the quad's -z normal faces
	// the camera
	normalizeOrZInto(
		face,
		right[1] * streak[2] - right[2] * streak[1],
		right[2] * streak[0] - right[0] * streak[2],
		right[0] * streak[1] - right[1] * streak[0],
	);
	if (face[0] * sight[0] + face[1] * sight[1] + face[2] * sight[2] < 0) {
		for (let r = 0; r < 3; r++) {
			face[r] = -face[r];
		}
	}
	const stretch = info.stretch ?? STILL_STRETCH;
	const drawn = speed > 1e-15 && flatLength > 1e-15;
	const length = drawn ? particle.length * stretch.lengthScale + speed * stretch.velocityScale : 0;
	if (drawn) {
		sizes[1] = length;
	} else {
		sizes.fill(0);
	}
	// the unit quad is centred, and the particle sits at the streak's head. the game's pivot moves the head
	// along the velocity by its y times the size before the limits, and the whole streak across by its x times
	// half the width
	const pivot = info.pivot;
	for (let r = 0; r < 3; r++) {
		center[r] +=
			streak[r] * (pivot[1] * particle.length - length * 0.5) + right[r] * pivot[0] * sizes[0] * 0.5;
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

/** @returns what every row of an emitter's system shares this frame, by its render mode */
const rowContext = (
	info: ParticleSystemInfo,
	view: ParticleView,
	block: EmitterBlock,
	m: Float64Array,
	columns: readonly Vec3[],
	scales: Readonly<Vec3>,
): RowContext => {
	const pivot = info.pivot;
	const context: RowContext = {
		info,
		view,
		origin: block.origin,
		m,
		scales,
		sizing: info.sizedByScale ? scales : UNIT,
		billboard: RowBillboard.None,
		quadFrame: null,
		pivoted: pivot[0] !== 0 || pivot[1] !== 0 || pivot[2] !== 0,
		shape: quadShape,
	};
	// quads turn in the camera's frame or its heading's (which `row_basis` turns them in on the GPU, as
	// billboard chains are), or lie flat facing up. billboards take their render alignment: the camera's
	// (View), the world's axes or the emitter's
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
					context.quadFrame = columns.map(normalizeOrZ);
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
			context.shape = stretchedShape;
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
					break;
				}
				case ParticleAlignment.Velocity: {
					context.shape = meshVelocityShape;
					break;
				}
			}
			break;
		}
	}
	return context;
};

// #endregion

/** one emitter's particles: its rows in the instance buffer and its clock */
interface Emitter {
	simulation: ParticleSimulation;
	rows: RangeAllocation;
	/** the viewer time its system time counts from: when the emitter was first drawn, or 0 for a moving one */
	start: number;
	/**
	 * its system time at {@link start}: 0 for a system that plays once, else long enough for it to look as if it
	 * had always played; for a moving emitter, a whole number of loops, so its loops keep in step with the
	 * clip
	 */
	offset: number;
	/** the frame its rows were last written */
	frame: number;
	/** global indices of the rows holding live particles */
	live: number[];
}

/**
 * what {@link ParticleField} reads of a resident instance block. the same object must stand for the block
 * while it's resident, since it keys the block's emitters
 */
export interface EmitterBlock {
	/** the block's rows, each starting with its rows3x4 transform relative to {@link origin} */
	readonly rowsF32: Float32Array;
	/** the world origin of the rows, f64 */
	readonly origin: readonly [x: number, y: number, z: number];
	/** the block's slot, which its particles' rows name */
	readonly blockSlot: number;
}

/** what {@link ParticleField} needs of the instance buffer */
export interface ParticleRowStore {
	allocateRows(count: number): RangeAllocation | null;
	freeRows(alloc: RangeAllocation): void;
	writeRows(start: number, rows: Uint32Array<ArrayBuffer>, count: number): void;
}

/**
 * the particles of every drawn emitter, as instance rows. an emitter is an instance row whose draw names a
 * particle system: its transform is the system's frame, and its particles' rows use its block's origin
 */
export class ParticleField {
	readonly #systems: readonly ParticleSystemInfo[];
	/** each system's seed salt, the same for entries differing only in their mesh */
	readonly #salts: number[];
	readonly #store: ParticleRowStore;
	readonly #emitters = new Map<EmitterBlock, Map<number, Emitter>>();
	readonly #particles = new Float32Array(MAX_PARTICLES * PARTICLE_FLOATS);
	readonly #rows = new Uint32Array(MAX_PARTICLES * ROW_WORDS);
	readonly #rowsF32 = new Float32Array(this.#rows.buffer);
	/** the emitter being written's transform, its columns and their lengths (`#write`, `#toLocal`) */
	readonly #m = new Float64Array(12);
	/** a moving emitter's frame relative to its row's (`#write`) and its row's own transform */
	readonly #emittedAt = new Float64Array(12);
	readonly #placed = new Float64Array(12);
	readonly #columns: [Vec3, Vec3, Vec3] = [vec3(), vec3(), vec3()];
	readonly #scales = vec3();
	/** world down in the emitter's frame (`#write`) */
	readonly #down = vec3();
	/** the row being built (`#write`) and what its render mode's step reads of its particle */
	readonly #row: RowGeometry = { axes: [vec3(), vec3(), vec3()], sizes: vec3(), center: vec3() };
	readonly #particle: ParticleInput = { size: vec3(), velocity: vec3(), length: 0 };
	readonly #color = new Float32Array(4);
	readonly #custom = new Float32Array(4);
	/** the frame {@link #prune} last ran */
	#prunedAt = 0;

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
	 * @param table the package's particle systems
	 * @param store the instance buffer the rows go to
	 */
	constructor(table: ParticlesTable, store: ParticleRowStore) {
		this.#systems = table.systems;
		this.#salts = table.systems.map((system) => hashText(JSON.stringify({ ...system, mesh: 0 })));
		this.#store = store;
	}

	/**
	 * writes an emitter's live particles for this frame, once per frame however many draws ask.
	 *
	 * @param block the emitter's block
	 * @param row the emitter's row in the block
	 * @param system the particles-table entry its draw names
	 * @param frame the frame number
	 * @param view the clock and camera
	 * @returns the global row indices of its live particles (valid until the next frame)
	 */
	rows(
		block: EmitterBlock,
		row: number,
		system: number,
		frame: number,
		view: ParticleView,
	): readonly number[] {
		if (frame < this.#prunedAt || frame - this.#prunedAt >= EMITTER_LIFETIME) {
			this.#prunedAt = frame;
			this.#prune(frame);
		}
		const emitters = this.#emitters.getOrInsertComputed(block, () => new Map());
		// one emitter per row and system: a renderer's meshes are separate rows
		const key = row * this.#systems.length + system;
		let emitter = emitters.get(key);
		if (emitter === undefined) {
			const info = this.#systems[system];
			if (info === undefined) {
				return NO_ROWS;
			}
			const f32 = block.rowsF32;
			const at = row * ROW_WORDS;
			// emitters of one renderer's meshes share their place, so they share their particles' random values
			const seed = hash2(
				hash2(this.#salts[system], hashText(`${f32[at + 3]},${f32[at + 7]},${f32[at + 11]}`)),
				0,
			);
			const simulation = new ParticleSimulation(info, seed);
			const rows = this.#store.allocateRows(Math.max(Math.min(simulation.liveBound, MAX_PARTICLES), 1));
			if (rows === null) {
				return NO_ROWS;
			}
			// a moving emitter's system plays from where its clip starts, the viewer's clock's 0, as in the game, where
			// both start as the prefab loads
			const moving = info.emitterMotion !== null;
			let offset = 0;
			if (info.looping) {
				offset = moving
					? Math.ceil(simulation.settleTime / info.duration) * info.duration
					: simulation.settleTime;
			}
			emitter = {
				simulation,
				rows,
				start: moving && info.looping ? 0 : view.time,
				offset,
				frame: -1,
				live: [],
			};
			emitters.set(key, emitter);
		}
		if (emitter.frame !== frame) {
			emitter.frame = frame;
			this.#write(block, row, emitter, view);
		}
		return emitter.live;
	}

	/** forgets a released block's emitters and frees their rows */
	release(block: EmitterBlock): void {
		const emitters = this.#emitters.get(block);
		if (emitters === undefined) {
			return;
		}
		for (const emitter of emitters.values()) {
			this.#store.freeRows(emitter.rows);
		}
		this.#emitters.delete(block);
	}

	/**
	 * forgets the emitters not drawn for {@link EMITTER_LIFETIME} frames and frees their rows: pinned blocks
	 * (HLOD, global scenery) are never released, so without this every emitter ever drawn would keep its rows
	 */
	#prune(frame: number): void {
		for (const [block, emitters] of this.#emitters) {
			for (const [key, emitter] of emitters) {
				if (emitter.frame < frame - EMITTER_LIFETIME) {
					this.#store.freeRows(emitter.rows);
					emitters.delete(key);
				}
			}
			if (emitters.size === 0) {
				this.#emitters.delete(block);
			}
		}
	}

	/** reads an emitter's transform from its row into {@link #m}, {@link #columns} and {@link #scales} */
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
			column[0] = m[i];
			column[1] = m[4 + i];
			column[2] = m[8 + i];
			this.#scales[i] = Math.hypot(column[0], column[1], column[2]);
		}
	}

	#write(block: EmitterBlock, row: number, emitter: Emitter, view: ParticleView): void {
		const simulation = emitter.simulation;
		const info = simulation.info;
		this.#readFrame(block.rowsF32, row * ROW_WORDS);
		const m = this.#m;
		const speed = info.simulationSpeed;
		const time = (view.time - emitter.start) * speed + emitter.offset;
		const motion = info.emitterMotion;
		let emittedFrom: ((born: number) => Readonly<Float64Array>) | undefined;
		if (motion !== null) {
			if (motion.inWorld) {
				// each particle leaves from where the emitter was when it was emitted, the clip read at that moment
				const at = this.#emittedAt;
				emittedFrom = (born) =>
					emitterFrameInto(motion, (born - emitter.offset) / Math.max(speed, 1e-6) + emitter.start, at);
			} else {
				// the particles move with the emitter, so the whole system is where the clip has it now
				const placed = this.#placed;
				for (let i = 0; i < 12; i++) {
					placed[i] = m[i];
				}
				multiplyRowsInto(m, placed, emitterFrameInto(motion, view.time, this.#emittedAt));
				this.#columnsOf(m);
			}
		}
		// derived once per frame, since the simulation reuses it for every particle
		const down = this.#down;
		const local = this.#toLocal(WORLD_DOWN);
		for (let r = 0; r < 3; r++) {
			down[r] = local[r];
		}
		const particles = this.#particles;
		const count = simulation.evaluate(
			time,
			down,
			this.#toLocal,
			particles.subarray(0, Math.min(emitter.rows.count, MAX_PARTICLES) * PARTICLE_FLOATS),
			emittedFrom,
		);
		const context = rowContext(info, view, block, m, this.#columns, this.#scales);
		const { sizing, billboard, pivoted, shape } = context;
		const turnedBy = pivoted ? billboardBasis(billboard, view) : null;
		const origin = block.origin;
		const pivot = info.pivot;
		const screenSize = info.screenSize;
		const sheet = info.textureSheet;
		const infoWord = (RowKind.Detail | (billboard << 30)) >>> 0;
		const slot = block.blockSlot;
		const out = this.#rowsF32;
		const words = this.#rows;
		const geometry = this.#row;
		const { axes, sizes, center } = geometry;
		const particle = this.#particle;
		const { at, shift, rotation } = scratch;
		emitter.live.length = 0;
		for (let i = 0; i < count; i++) {
			const base = i * PARTICLE_FLOATS;
			{
				const p = base + ParticleFloat.position;
				toWorldInto(center, m, particles[p], particles[p + 1], particles[p + 2]);
				center[0] = center[0] + m[3];
				center[1] = center[1] + m[7];
				center[2] = center[2] + m[11];
			}
			// the rotation's axes, which the render mode's step turns into the frame they're drawn in
			for (let k = 0; k < 4; k++) {
				rotation[k] = particles[base + ParticleFloat.rotation + k];
			}
			rotateInto(axes[0], rotation, 1, 0, 0);
			rotateInto(axes[1], rotation, 0, 1, 0);
			rotateInto(axes[2], rotation, 0, 0, 1);
			for (let k = 0; k < 3; k++) {
				particle.size[k] = particles[base + ParticleFloat.size + k];
				particle.velocity[k] = particles[base + ParticleFloat.velocity + k];
				sizes[k] = particle.size[k] * sizing[k];
			}
			particle.length = sizes[1];
			if (screenSize !== null) {
				for (let r = 0; r < 3; r++) {
					at[r] = origin[r] + center[r];
				}
				const ratio = screenRatio(sizes, screenSize, view, at);
				sizes[0] = sizes[0] * ratio;
				sizes[1] = sizes[1] * ratio;
			}
			shape(geometry, particle, context);
			if (pivoted) {
				// the pivot moves the mesh in its turned and sized frame, the one it's drawn in: for camera-facing
				// rows that frame is turned on the GPU, so turn the offset with it here
				for (let r = 0; r < 3; r++) {
					let sum = 0;
					for (let k = 0; k < 3; k++) {
						sum += axes[k][r] * sizes[k] * pivot[k];
					}
					shift[r] = sum;
				}
				if (turnedBy !== null) {
					times3ColumnsInto(shift, turnedBy, shift[0], shift[1], shift[2]);
				}
				for (let r = 0; r < 3; r++) {
					center[r] += shift[r];
				}
			}
			const o = i * ROW_WORDS;
			for (let r = 0; r < 3; r++) {
				out[o + r * 4] = axes[0][r] * sizes[0];
				out[o + r * 4 + 1] = axes[1][r] * sizes[1];
				out[o + r * 4 + 2] = axes[2][r] * sizes[2];
				out[o + r * 4 + 3] = center[r];
			}
			const extent = Math.max(
				Math.hypot(axes[0][0], axes[0][1], axes[0][2]) * sizes[0],
				Math.hypot(axes[1][0], axes[1][1], axes[1][2]) * sizes[1],
				Math.hypot(axes[2][0], axes[2][1], axes[2][2]) * sizes[2],
			);
			for (let r = 0; r < 3; r++) {
				out[o + 12 + r] = center[r];
				out[o + RowWord.extent + r] = extent;
			}
			words[o + RowWord.block] = slot;
			words[o + RowWord.info] = infoWord;
			words[o + RowWord.sheet] =
				sheet === null ? 0 : rowSheet(sheet.tiles, particles[base + ParticleFloat.tile], sheet.uvChannels);
			for (let k = 0; k < 4; k++) {
				this.#color[k] = particles[base + ParticleFloat.color + k];
				this.#custom[k] = particles[base + ParticleFloat.custom + k];
			}
			words[o + RowWord.color] = packRowColor(this.#color);
			const [xy, zw] = packRowCustom(this.#custom);
			words[o + RowWord.custom] = xy;
			words[o + RowWord.custom + 1] = zw;
			emitter.live.push(emitter.rows.start + i);
		}
		if (count > 0) {
			this.#store.writeRows(emitter.rows.start, words, count);
		}
	}
}
