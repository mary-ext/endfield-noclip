/**
 * a storage buffer sub-allocated in ranges that starts small and grows on demand, so a pool sized for the
 * worst case only costs what's in it. growing copies the contents into a buffer twice the size (or more, for
 * a large request) on the GPU; live allocations keep their offsets. the streaming budget already bounds what
 * the pools hold, so they never shrink.
 *
 * @module
 */

import { type RangeAllocation, RangeAllocator } from './range-allocator.ts';

/** a growable range-allocated buffer */
export class GrowableBuffer {
	/** the current buffer; replaced when it grows, so binders check {@link version} */
	buffer: GPUBuffer;
	/** bumped whenever {@link buffer} is replaced */
	version = 0;
	readonly #device: GPUDevice;
	readonly #label: string;
	readonly #unitBytes: number;
	readonly #maxUnits: number;
	readonly #usage: GPUBufferUsageFlags;
	readonly #allocator: RangeAllocator;

	/**
	 * @param device the device
	 * @param options the label, bytes per allocation unit, the units to start with and at most (clamped to the
	 *   device's storage binding size), and the usage (copies in and out are added)
	 */
	constructor(
		device: GPUDevice,
		options: {
			label: string;
			unitBytes: number;
			initialUnits: number;
			maxUnits: number;
			usage: GPUBufferUsageFlags;
		},
	) {
		this.#device = device;
		this.#label = options.label;
		this.#unitBytes = options.unitBytes;
		this.#maxUnits = Math.min(
			options.maxUnits,
			Math.floor(device.limits.maxStorageBufferBindingSize / options.unitBytes),
		);
		this.#usage = options.usage | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
		const units = Math.min(options.initialUnits, this.#maxUnits);
		this.#allocator = new RangeAllocator(units);
		this.buffer = this.#create(units);
	}

	/** @returns units the buffer holds now */
	get capacity(): number {
		return this.#allocator.capacity;
	}

	/** @returns units the buffer can grow to */
	get maxCapacity(): number {
		return this.#maxUnits;
	}

	/** @returns bytes of the current buffer */
	get bytes(): number {
		return this.buffer.size;
	}

	/**
	 * allocates `count` units, growing the buffer if no free range is large enough.
	 *
	 * @param count units needed (> 0)
	 * @returns the allocation, or `null` when even the largest buffer has no room
	 */
	allocate(count: number): RangeAllocation | null {
		const alloc = this.#allocator.allocate(count);
		if (alloc !== null) {
			return alloc;
		}
		const capacity = this.#allocator.capacity;
		if (capacity >= this.#maxUnits) {
			return null;
		}
		// room for the request even if all free space is fragmented
		this.#grow(Math.min(this.#maxUnits, Math.max(capacity * 2, capacity + count)));
		return this.#allocator.allocate(count);
	}

	/** @param allocation a live allocation from {@link allocate} */
	free(allocation: RangeAllocation): void {
		this.#allocator.free(allocation);
	}

	/** frees the buffer */
	destroy(): void {
		this.buffer.destroy();
	}

	#create(units: number): GPUBuffer {
		return this.#device.createBuffer({
			label: this.#label,
			size: Math.max(4, units * this.#unitBytes),
			usage: this.#usage,
		});
	}

	#grow(units: number): void {
		const previous = this.buffer;
		const next = this.#create(units);
		// queue order keeps writes made to the old buffer ahead of the copy
		const encoder = this.#device.createCommandEncoder({ label: `${this.#label} growth` });
		encoder.copyBufferToBuffer(previous, 0, next, 0, previous.size);
		this.#device.queue.submit([encoder.finish()]);
		previous.destroy();
		this.buffer = next;
		this.#allocator.grow(units);
		this.version++;
	}
}
