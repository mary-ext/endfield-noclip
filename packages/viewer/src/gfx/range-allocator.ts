/** an allocated range */
export interface RangeAllocation {
	start: number;
	count: number;
}

/** first-fit range allocator with coalescing frees */
export class RangeAllocator {
	#capacity: number;
	/** free ranges sorted by start */
	#free: RangeAllocation[];
	#used = 0;

	/** @param capacity units available */
	constructor(capacity: number) {
		this.#capacity = capacity;
		this.#free = capacity > 0 ? [{ start: 0, count: capacity }] : [];
	}

	/** @returns units available in all */
	get capacity(): number {
		return this.#capacity;
	}

	/** @returns units currently allocated */
	get used(): number {
		return this.#used;
	}

	/** @returns end of the highest live allocation (0 when empty) */
	get highWater(): number {
		const last = this.#free.at(-1);
		return last !== undefined && last.start + last.count === this.#capacity ? last.start : this.#capacity;
	}

	/**
	 * extends the range at its end; live allocations keep their places.
	 *
	 * @param capacity the new capacity, at least the current one
	 */
	grow(capacity: number): void {
		const added = capacity - this.#capacity;
		if (added <= 0) {
			return;
		}
		const last = this.#free.at(-1);
		if (last !== undefined && last.start + last.count === this.#capacity) {
			this.#free[this.#free.length - 1] = { start: last.start, count: last.count + added };
		} else {
			this.#free.push({ start: this.#capacity, count: added });
		}
		this.#capacity = capacity;
	}

	/**
	 * trims unused capacity from the end; live allocations keep their places.
	 *
	 * @param capacity the new capacity, at least {@link highWater} and less than {@link capacity}
	 */
	shrink(capacity: number): void {
		if (capacity >= this.#capacity || capacity < this.highWater) {
			return;
		}
		const removed = this.#capacity - capacity;
		const last = this.#free.at(-1);
		if (last !== undefined && last.start + last.count === this.#capacity) {
			const remaining = last.count - removed;
			if (remaining <= 0) {
				this.#free.pop();
			} else {
				this.#free[this.#free.length - 1] = { start: last.start, count: remaining };
			}
		}
		this.#capacity = capacity;
	}

	/**
	 * @param count units needed (> 0)
	 * @returns the allocation, or `null` if no free range is large enough
	 */
	allocate(count: number): RangeAllocation | null {
		for (let i = 0; i < this.#free.length; i++) {
			const range = this.#free[i];
			if (range.count >= count) {
				const allocation = { start: range.start, count };
				if (range.count === count) {
					this.#free.splice(i, 1);
				} else {
					this.#free[i] = { start: range.start + count, count: range.count - count };
				}
				this.#used += count;
				return allocation;
			}
		}
		return null;
	}

	/** @param allocation a live allocation from this allocator */
	free(allocation: RangeAllocation): void {
		this.#used -= allocation.count;
		const free = this.#free;
		let lo = 0;
		let hi = free.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (free[mid].start < allocation.start) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		let start = allocation.start;
		let count = allocation.count;
		let removeFrom = lo;
		let removeCount = 0;
		if (lo > 0 && free[lo - 1].start + free[lo - 1].count === start) {
			start = free[lo - 1].start;
			count += free[lo - 1].count;
			removeFrom = lo - 1;
			removeCount++;
		}
		if (lo < free.length && allocation.start + allocation.count === free[lo].start) {
			count += free[lo].count;
			removeCount++;
		}
		free.splice(removeFrom, removeCount, { start, count });
	}
}

/**
 * @param count slots in the pool
 * @returns a stack of every slot of a pool, free, that pops the lowest first
 */
export const freeSlots = (count: number): number[] => Array.from({ length: count }, (_, i) => count - 1 - i);
