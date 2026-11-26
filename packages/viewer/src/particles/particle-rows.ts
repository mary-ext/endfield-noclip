import type { ParticleSystemInfo, ParticlesTable } from '@endfield-noclip/package-format/particles';

import { ROW_WORDS, RowWord } from '../content/instance-rows.ts';
import type { RangeAllocation } from '../gfx/range-allocator.ts';

import type { ParticleWorkerMessage, ParticleWorkerResponse } from './particle-protocol.ts';
import { hash2, hashText } from './random.ts';
import type { ParticleView } from './row-geometry.ts';
import { type EmitterState, ParticleRowWriter, TRAIL_SEGMENTS } from './row-writer.ts';
import { MAX_PARTICLES, ParticleSimulation } from './simulation.ts';

const NO_ROWS: readonly number[] = [];

/**
 * frames an emitter may go undrawn before it's forgotten, as the mesh selector drops unused buckets: long
 * enough to outlast a glance away, after which a non-looping system plays from its start again
 */
const EMITTER_LIFETIME = 600;

/** one emitter's particles: its rows in the instance buffer and its clock */
interface Emitter {
	id: number;
	/** main-thread simulation; dropped once the worker takes over */
	simulation: ParticleSimulation | null;
	rows: RangeAllocation;
	/** the viewer time its system time counts from: when the emitter was first drawn, or 0 for a moving one */
	start: number;
	/**
	 * its system time at {@link start}: 0 for a system that plays once, else long enough for it to look as if it
	 * had always played; for a moving emitter, a whole number of loops, so its loops keep in step with the
	 * clip
	 */
	offset: number;
	/** the block's slot, for padding degenerate rows in {@link ParticleField.refreshActive} */
	blockSlot: number;
	/** the frame its rows were last written */
	frame: number;
	/** global indices of the rows holding live particles */
	live: number[];
	/** how many rows the last full traversal listed for this emitter */
	listedCount: number;
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
 * particle system: its transform is the system's frame, and its particles' rows use its block's origin. when
 * Web Workers are available, subsequent frames evaluate off-thread and upload via transferred buffers
 */
export class ParticleField {
	readonly #systems: readonly ParticleSystemInfo[];
	/**
	 * each system's seed salt, the same for a renderer's entries, which differ only in their mesh (and its
	 * pivot) or in drawing the trails, so they draw the same particles
	 */
	readonly #salts: number[];
	readonly #store: ParticleRowStore;
	readonly #writer = new ParticleRowWriter();
	readonly #emitters = new Map<EmitterBlock, Map<number, Emitter>>();
	readonly #emitterById = new Map<number, Emitter>();
	#nextEmitterId = 1;
	/** reusable state object passed to {@link #writer} on the synchronous path */
	#syncState: EmitterState | null = null;
	/** the frame {@link #prune} last ran */
	#prunedAt = 0;
	/** emitters written during the last full traversal, for {@link refreshActive} and worker steps */
	readonly #active: { block: EmitterBlock; row: number; emitter: Emitter }[] = [];
	readonly #activePool: { block: EmitterBlock; row: number; emitter: Emitter }[] = [];
	#activeFrame = -1;
	/** dedicated off-thread particle worker, `null` when unavailable (e.g. Node unit tests) */
	#worker: Worker | null = null;
	#sentSystems: Uint8Array;
	#workerBusy = false;
	#pendingResult: ParticleWorkerResponse | null = null;
	#recycledBuffer: ArrayBuffer | null = null;
	#recycledIds: Uint32Array<ArrayBuffer> | null = null;
	#recycledTransforms: Float32Array<ArrayBuffer> | null = null;
	#recycledCounts: Uint32Array<ArrayBuffer> | null = null;
	#seq = 0;

	/**
	 * @param table the package's particle systems
	 * @param store the instance buffer the rows go to
	 */
	constructor(table: ParticlesTable, store: ParticleRowStore) {
		this.#systems = table.systems;
		this.#salts = table.systems.map(
			(system) =>
				system.seedSalt ?? hashText(JSON.stringify({ ...system, mesh: 0, pivot: null, trail: null })),
		);
		this.#store = store;
		this.#sentSystems = new Uint8Array(table.systems.length);
		if (typeof Worker !== 'undefined') {
			const worker = new Worker(new URL('./particle-worker.ts', import.meta.url), {
				type: 'module',
				name: 'particles',
			});
			worker.addEventListener('message', (event: MessageEvent<ParticleWorkerResponse>) => {
				this.#workerBusy = false;
				if (this.#pendingResult !== null) {
					this.#recycleResult(this.#pendingResult);
				}
				this.#pendingResult = event.data;
			});
			worker.addEventListener('error', (event) => console.error('particle worker:', event.message));
			this.#worker = worker;
		}
	}

	/** applies any completed worker batch to the instance buffer before mesh selection reads emitter row lists */
	beginFrame(): void {
		const result = this.#pendingResult;
		if (result === null) {
			return;
		}
		this.#pendingResult = null;
		this.#applyWorkerResult(result, false);
	}

	/**
	 * dispatches the active emitters to the particle worker for the next frame
	 *
	 * @param view the clock and camera
	 */
	endFrame(view: ParticleView): void {
		this.#dispatchStep(view);
	}

	/** terminates the particle worker, if running */
	destroy(): void {
		if (this.#worker !== null) {
			this.#worker.terminate();
			this.#worker = null;
		}
		this.#pendingResult = null;
		this.#recycledBuffer = null;
		this.#recycledIds = null;
		this.#recycledTransforms = null;
		this.#recycledCounts = null;
		this.#workerBusy = false;
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
		let emitters = this.#emitters.get(block);
		if (emitters === undefined) {
			emitters = new Map();
			this.#emitters.set(block, emitters);
		}
		// one emitter per row and system: a renderer's meshes are separate rows
		const key = row * this.#systems.length + system;
		let emitter = emitters.get(key);
		let created = false;
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
			// a trail is a row per segment
			const perParticle = info.trail === null ? 1 : TRAIL_SEGMENTS;
			const rows = this.#store.allocateRows(
				Math.max(Math.min(simulation.liveBound * perParticle, MAX_PARTICLES), perParticle),
			);
			if (rows === null) {
				return NO_ROWS;
			}
			// a moving emitter's system plays from where its clip starts, the viewer's clock's 0, as in the game, where
			// both start as the prefab loads. a sub-emitter loops whenever its driving parent loops
			const moving = info.emitterMotion !== null;
			const loops = simulation.loops;
			let offset = 0;
			if (loops) {
				offset = moving
					? Math.ceil(simulation.settleTime / info.duration) * info.duration
					: simulation.settleTime;
			}
			const id = this.#nextEmitterId++;
			const start = moving && loops ? 0 : view.time;
			emitter = {
				id,
				simulation,
				rows,
				start,
				offset,
				blockSlot: block.blockSlot,
				frame: -1,
				live: [],
				listedCount: 0,
			};
			emitters.set(key, emitter);
			this.#emitterById.set(id, emitter);
			created = true;
			if (this.#worker !== null) {
				if (this.#sentSystems[system] === 0) {
					this.#sentSystems[system] = 1;
					const sysMsg: ParticleWorkerMessage = { kind: 'system', system, info };
					this.#worker.postMessage(sysMsg, []);
				}
				const addMsg: ParticleWorkerMessage = {
					kind: 'add',
					id,
					system,
					seed,
					start,
					offset,
					capacity: rows.count,
					origin: [block.origin[0], block.origin[1], block.origin[2]],
					blockSlot: block.blockSlot,
				};
				this.#worker.postMessage(addMsg, []);
			}
		}
		if (frame !== this.#activeFrame) {
			this.#active.length = 0;
			this.#activeFrame = frame;
		}
		if (emitter.frame !== frame) {
			emitter.frame = frame;
			if (created || this.#worker === null) {
				this.#writeSync(block, row, emitter, view);
			}
			emitter.listedCount = emitter.live.length;
			const entry = this.#activePool[this.#active.length];
			if (entry === undefined) {
				const createdEntry = { block, row, emitter };
				this.#activePool.push(createdEntry);
				this.#active.push(createdEntry);
			} else {
				entry.block = block;
				entry.row = row;
				entry.emitter = emitter;
				this.#active.push(entry);
			}
		}
		return emitter.live;
	}

	/**
	 * updates the active emitters from the last full traversal in place without changing the visible list.
	 * unused slots up to each emitter's listed count are collapsed to degenerate rows; if any emitter grew past
	 * its listed count, returns `false` so the caller can run a full traversal instead
	 *
	 * @param frame the frame number
	 * @param view the clock and camera
	 * @returns whether every active emitter fit within its listed row span
	 */
	refreshActive(frame: number, view: ParticleView): boolean {
		const active = this.#active;
		if (active.length === 0) {
			return true;
		}
		if (this.#worker === null) {
			for (let i = 0; i < active.length; i++) {
				const { block, row, emitter } = active[i];
				if (!this.#writeSync(block, row, emitter, view, emitter.listedCount)) {
					return false;
				}
				emitter.frame = frame;
			}
			return true;
		}
		const result = this.#pendingResult;
		if (result !== null) {
			const { count: n, ids, counts } = result;
			for (let i = 0; i < n; i++) {
				const emitter = this.#emitterById.get(ids[i]);
				if (emitter !== undefined && counts[i] > emitter.listedCount) {
					return false;
				}
			}
			this.#pendingResult = null;
			this.#applyWorkerResult(result, true);
		}
		for (let i = 0; i < active.length; i++) {
			active[i].emitter.frame = frame;
		}
		this.#dispatchStep(view);
		return true;
	}

	/** forgets a released block's emitters and frees their rows */
	release(block: EmitterBlock): void {
		const emitters = this.#emitters.get(block);
		if (emitters === undefined) {
			return;
		}
		const removed: number[] = [];
		for (const emitter of emitters.values()) {
			this.#store.freeRows(emitter.rows);
			this.#emitterById.delete(emitter.id);
			removed.push(emitter.id);
		}
		this.#emitters.delete(block);
		if (this.#worker !== null && removed.length > 0) {
			const msg: ParticleWorkerMessage = { kind: 'remove', ids: removed };
			this.#worker.postMessage(msg, []);
		}
	}

	/**
	 * forgets the emitters not drawn for {@link EMITTER_LIFETIME} frames and frees their rows: pinned blocks
	 * (HLOD, global scenery) are never released, so without this every emitter ever drawn would keep its rows
	 */
	#prune(frame: number): void {
		const removed: number[] = [];
		for (const [block, emitters] of this.#emitters) {
			for (const [key, emitter] of emitters) {
				if (emitter.frame < frame - EMITTER_LIFETIME) {
					this.#store.freeRows(emitter.rows);
					this.#emitterById.delete(emitter.id);
					emitters.delete(key);
					removed.push(emitter.id);
				}
			}
			if (emitters.size === 0) {
				this.#emitters.delete(block);
			}
		}
		if (this.#worker !== null && removed.length > 0) {
			const msg: ParticleWorkerMessage = { kind: 'remove', ids: removed };
			this.#worker.postMessage(msg, []);
		}
	}

	/** posts the active emitters to the worker if it is idle */
	#dispatchStep(view: ParticleView): void {
		const worker = this.#worker;
		const active = this.#active;
		if (worker === null || this.#workerBusy || active.length === 0) {
			return;
		}
		const n = active.length;
		const recycledIds = this.#recycledIds;
		const ids =
			recycledIds !== null && recycledIds.length >= n ? recycledIds : new Uint32Array(Math.max(n, 256));
		this.#recycledIds = null;
		const recycledTransforms = this.#recycledTransforms;
		const transforms =
			recycledTransforms !== null && recycledTransforms.length >= n * 12
				? recycledTransforms
				: new Float32Array(Math.max(n, 256) * 12);
		this.#recycledTransforms = null;
		for (let i = 0; i < n; i++) {
			const { block, row, emitter } = active[i];
			ids[i] = emitter.id;
			const src = block.rowsF32;
			const at = row * ROW_WORDS;
			const dst = i * 12;
			for (let k = 0; k < 12; k++) {
				transforms[dst + k] = src[at + k];
			}
		}
		const buffer = this.#recycledBuffer;
		this.#recycledBuffer = null;
		const counts = this.#recycledCounts;
		this.#recycledCounts = null;
		const transfer: Transferable[] = [ids.buffer, transforms.buffer];
		if (counts !== null) {
			transfer.push(counts.buffer);
		}
		if (buffer !== null) {
			transfer.push(buffer);
		}
		this.#workerBusy = true;
		const msg: ParticleWorkerMessage = {
			kind: 'step',
			seq: ++this.#seq,
			view,
			count: n,
			ids,
			transforms,
			counts,
			buffer,
		};
		worker.postMessage(msg, transfer);
	}

	/** returns a completed worker response's transferred buffers to the ping-pong slots */
	#recycleResult(result: ParticleWorkerResponse): void {
		this.#recycledBuffer = result.rows.buffer;
		this.#recycledIds = result.ids;
		this.#recycledTransforms = result.transforms;
		this.#recycledCounts = result.counts;
	}

	/** uploads a worker batch's rows to the store, optionally zero-padding shrunken spans up to `listedCount` */
	#applyWorkerResult(result: ParticleWorkerResponse, padListed: boolean): void {
		const { count: n, ids, counts, rows } = result;
		let wordOffset = 0;
		const padWords = this.#writer.rows;
		for (let i = 0; i < n; i++) {
			const count = counts[i];
			const words = count * ROW_WORDS;
			const emitter = this.#emitterById.get(ids[i]);
			if (emitter !== undefined) {
				if (count > 0) {
					this.#store.writeRows(emitter.rows.start, rows.subarray(wordOffset, wordOffset + words), count);
				}
				if (padListed && count < emitter.listedCount) {
					const padCount = emitter.listedCount - count;
					for (let p = 0; p < padCount; p++) {
						const o = p * ROW_WORDS;
						padWords.fill(0, o, o + ROW_WORDS);
						padWords[o + RowWord.block] = emitter.blockSlot;
					}
					this.#store.writeRows(emitter.rows.start + count, padWords, padCount);
				}
				emitter.live.length = count;
				const start = emitter.rows.start;
				for (let k = 0; k < count; k++) {
					emitter.live[k] = start + k;
				}
				emitter.simulation = null;
			}
			wordOffset += words;
		}
		this.#recycleResult(result);
	}

	/** synchronously evaluates and writes one emitter via {@link #writer} */
	#writeSync(
		block: EmitterBlock,
		row: number,
		emitter: Emitter,
		view: ParticleView,
		padTo?: number,
	): boolean {
		const simulation = emitter.simulation;
		if (simulation === null) {
			return true;
		}
		let state = this.#syncState;
		if (state === null) {
			state = this.#syncState = {
				simulation,
				start: emitter.start,
				offset: emitter.offset,
				capacity: emitter.rows.count,
				origin: block.origin,
				blockSlot: block.blockSlot,
			};
		} else {
			state.simulation = simulation;
			state.start = emitter.start;
			state.offset = emitter.offset;
			state.capacity = emitter.rows.count;
			state.origin = block.origin;
			state.blockSlot = block.blockSlot;
		}
		const count = this.#writer.write(state, block.rowsF32, row * ROW_WORDS, view, padTo);
		if (count < 0) {
			return false;
		}
		emitter.live.length = count;
		const start = emitter.rows.start;
		for (let i = 0; i < count; i++) {
			emitter.live[i] = start + i;
		}
		const uploadCount = padTo !== undefined ? padTo : count;
		if (uploadCount > 0) {
			this.#store.writeRows(start, this.#writer.rows, uploadCount);
		}
		return true;
	}
}
