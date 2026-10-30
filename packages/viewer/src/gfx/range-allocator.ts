/**
 * first-fit allocator over a linear range of units (rows of a mega buffer, slots of a pool). freed ranges
 * coalesce with their neighbours, so streaming in and out doesn't fragment the space indefinitely.
 *
 * @module
 */

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
		// binary search for the insertion point
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
