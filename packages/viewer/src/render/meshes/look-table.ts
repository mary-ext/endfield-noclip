import { GrowableBuffer } from '../../gfx/growable-buffer.ts';
import { LOOK_FLOATS, type MaterialLook } from '../../looks/look.ts';
import { MIP_FEEDBACK_LOOKS } from '../textures/mip-feedback.ts';

/** bytes of a look table slot (`Look` in surfaces/common.ts) */
const LOOK_BYTES = LOOK_FLOATS * 4;
/** look table slots to start with: a view draws a few thousand materials */
const INITIAL_LOOKS = 4096;
/** look table slots at most, more than a package has materials, and as many as the mip feedback can name */
const MAX_LOOKS = MIP_FEEDBACK_LOOKS;

const createBuffer = (device: GPUDevice): GrowableBuffer =>
	new GrowableBuffer(device, {
		label: 'mesh looks',
		unitBytes: LOOK_BYTES,
		initialUnits: INITIAL_LOOKS,
		maxUnits: MAX_LOOKS,
		usage: GPUBufferUsage.STORAGE,
	});

/**
 * owns the GPU look table (`looks` in surfaces/common.ts): allocates one slot per material on first draw,
 * batches uploads for newly seen looks, and advances animated looks in place
 */
export class LookTable {
	#device: GPUDevice;
	#buffer: GrowableBuffer;
	/** per material id, its slot in {@link #buffer} plus 1, 0 until written */
	#slots = new Uint32Array(0);
	/** slots handed out so far */
	#count = 0;
	/** parameters of materials first drawn this frame, queued for {@link flush} */
	#pending: Float32Array[] = [];
	#pendingSlots: number[] = [];
	#staging = new Float32Array(0);
	/** looks drawn this frame whose looping clip updates their parameters */
	#moving = new Map<number, MaterialLook>();

	/** @param device the device */
	constructor(device: GPUDevice) {
		this.#device = device;
		this.#buffer = createBuffer(device);
	}

	/** @returns the underlying storage buffer */
	get buffer(): GPUBuffer {
		return this.#buffer.buffer;
	}

	/** @returns the buffer's version, bumped when it grows or resets */
	get version(): number {
		return this.#buffer.version;
	}

	/** @returns number of allocated look slots */
	get count(): number {
		return this.#count;
	}

	/** @returns bytes allocated for the look table */
	get bytes(): number {
		return this.#buffer.bytes;
	}

	/**
	 * @param material material id
	 * @returns its allocated look slot, or -1 if never drawn
	 */
	slotOf(material: number): number {
		return (this.#slots[material] ?? 0) - 1;
	}

	/** clears the per-frame set of animated looks */
	clearFrame(): void {
		this.#moving.clear();
	}

	/**
	 * returns a material's look slot, allocating and queuing its upload on first use, and registers animated
	 * looks for {@link advance}
	 *
	 * @param material material id
	 * @param look the material's look
	 * @returns its slot index, or -1 when the table is full
	 */
	ensure(material: number, look: MaterialLook): number {
		let slot: number;
		const known = this.#slots[material] ?? 0;
		if (known > 0) {
			slot = known - 1;
		} else {
			if (material >= this.#slots.length) {
				const grown = new Uint32Array(Math.max(material + 1, this.#slots.length * 2, 1024));
				grown.set(this.#slots);
				this.#slots = grown;
			}
			const allocation = this.#buffer.allocate(1);
			if (allocation === null) {
				return -1;
			}
			slot = allocation.start;
			this.#slots[material] = slot + 1;
			this.#count = Math.max(this.#count, slot + 1);
			this.#pending.push(look.params);
			this.#pendingSlots.push(slot);
		}
		if (look.motion !== null) {
			this.#moving.set(material, look);
		}
		return slot;
	}

	/** uploads looks first drawn this frame, one write per contiguous run of slots */
	flush(): void {
		const looks = this.#pending;
		const slots = this.#pendingSlots;
		if (looks.length === 0) {
			return;
		}
		if (this.#staging.length < looks.length * LOOK_FLOATS) {
			this.#staging = new Float32Array(looks.length * LOOK_FLOATS * 2);
		}
		const staging = this.#staging;
		const queue = this.#device.queue;
		let runStart = 0;
		for (let i = 0; i < looks.length; i++) {
			staging.set(looks[i], i * LOOK_FLOATS);
			if (i + 1 === looks.length || slots[i + 1] !== slots[i] + 1) {
				queue.writeBuffer(
					this.#buffer.buffer,
					slots[runStart] * LOOK_BYTES,
					staging,
					runStart * LOOK_FLOATS,
					(i + 1 - runStart) * LOOK_FLOATS,
				);
				runStart = i + 1;
			}
		}
		looks.length = 0;
		slots.length = 0;
	}

	/**
	 * advances animated looks drawn this frame to `time` and uploads changed slots
	 *
	 * @param time animation clock, s
	 */
	advance(time: number): void {
		for (const [material, look] of this.#moving) {
			const slot = this.#slots[material] ?? 0;
			if (look.motion?.advance(time) === true && slot !== 0 && !this.#pending.includes(look.params)) {
				this.#device.queue.writeBuffer(this.#buffer.buffer, (slot - 1) * LOOK_BYTES, look.params);
			}
		}
	}

	/** resets the table for a newly loaded package */
	reset(): void {
		this.#buffer.destroy();
		this.#buffer = createBuffer(this.#device);
		this.#slots = new Uint32Array(0);
		this.#count = 0;
		this.#pending.length = 0;
		this.#pendingSlots.length = 0;
		this.#moving.clear();
	}

	/** frees the GPU buffer */
	destroy(): void {
		this.#buffer.destroy();
	}
}
