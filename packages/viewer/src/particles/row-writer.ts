import { ParticleRenderMode, SheetUvChannels } from '@endfield-noclip/package-format/particles';
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
import { times3ColumnsInto } from '../math/mat3.ts';
import { normalizeOrZInto } from '../math/vec3.ts';

import { emitterFrameInto, multiplyRowsInto } from './emitter-motion.ts';
import {
	type ParticleInput,
	type ParticleView,
	type RowContext,
	type RowGeometry,
	UNIT,
	WORLD_DOWN,
	billboardBasis,
	fillRowContext,
	quadShape,
	scratch,
	screenRatio,
	toWorldInto,
	trailScratch,
	vec3,
} from './row-geometry.ts';
import {
	MAX_PARTICLES,
	PARTICLE_FLOATS,
	ParticleFloat,
	type ParticleSimulation,
	TRAIL_POINT_FLOATS,
	TRAIL_POINTS,
	TrailFloat,
} from './simulation.ts';

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
		if (this.#context === null) {
			this.#context = {
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
			};
		}
		const context = this.#context;
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
			if (sheet !== null) {
				words[o + RowWord.sheet] = rowSheet(
					sheet.tiles,
					particles[base + ParticleFloat.tile],
					sheet.uvChannels,
					quadFlip,
				);
			} else if (quadFlip === 0) {
				words[o + RowWord.sheet] = 0;
			} else {
				words[o + RowWord.sheet] = rowSheet([1, 1], 0, 0, quadFlip);
			}
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
