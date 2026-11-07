/** coalesce blobs whose ranges are at most this far apart, bytes */
const COALESCE_GAP = 64 * 1024;
/** largest coalesced read, bytes */
const COALESCE_SPAN = 2 * 1024 * 1024;
/** most blobs in one coalesced read */
const COALESCE_COUNT = 96;

/** a blob's byte range */
export interface BlobRange {
	/** index of the archive holding it */
	archive: number;
	/** absolute byte range in the archive, `[start, end)` */
	start: number;
	end: number;
}

/** one range read covering several queued blobs */
export interface CoalescedRead {
	/** blob indices, in byte order */
	members: number[];
	/** the read's byte range, `[start, end)` */
	start: number;
	end: number;
}

/**
 * groups queued blobs into range reads. every blob's place in byte order is sorted once, so a call costs the
 * reads it returns (plus heapifying the queue) rather than sorting the queue
 */
export class BlobCoalescer {
	#archive: Int32Array;
	#start: Float64Array;
	#end: Float64Array;
	/** readable blobs in (archive, start) order */
	#order: Int32Array;
	/** by blob: its index in {@link #order}, or -1 for blobs that aren't read by range */
	#position: Int32Array;
	/** by blob: the call that took it into a read */
	#taken: Uint32Array;
	#call = 0;
	#heap = new Int32Array(0);

	/**
	 * @param count the package's blob count
	 * @param range a blob's byte range, or `null` for blobs that aren't read by range
	 */
	constructor(count: number, range: (blob: number) => BlobRange | null) {
		this.#archive = new Int32Array(count);
		this.#start = new Float64Array(count);
		this.#end = new Float64Array(count);
		this.#position = new Int32Array(count).fill(-1);
		this.#taken = new Uint32Array(count);
		const readable: number[] = [];
		for (let blob = 0; blob < count; blob++) {
			const r = range(blob);
			if (r !== null) {
				this.#archive[blob] = r.archive;
				this.#start[blob] = r.start;
				this.#end[blob] = r.end;
				readable.push(blob);
			}
		}
		const archive = this.#archive;
		const start = this.#start;
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh array
		this.#order = Int32Array.from(readable).sort((a, b) => archive[a] - archive[b] || start[a] - start[b]);
		for (let i = 0; i < this.#order.length; i++) {
			this.#position[this.#order[i]] = i;
		}
	}

	/**
	 * seeds are taken by descending priority (ties in queue order); each takes in its untaken neighbours in the
	 * same archive that `queued` accepts, while the gaps stay at most 64 KiB, the read at most 2 MiB and 96
	 * blobs, growing right before left. blobs between them that aren't queued are read over.
	 *
	 * @param blobs the queued blobs, all readable by range
	 * @param priorities larger reads sooner, by index into `blobs`
	 * @param queued whether a blob may join a read; true for every one of `blobs`
	 * @param maxReads the most reads to return
	 * @returns the reads, in seed order
	 */
	reads(
		blobs: ArrayLike<number>,
		priorities: ArrayLike<number>,
		queued: (blob: number) => boolean,
		maxReads: number,
	): CoalescedRead[] {
		const reads: CoalescedRead[] = [];
		const n = blobs.length;
		if (n === 0 || maxReads <= 0) {
			return reads;
		}
		const call = ++this.#call;
		const taken = this.#taken;
		const order = this.#order;
		const archives = this.#archive;
		const starts = this.#start;
		const ends = this.#end;
		const usable = (p: number, archive: number): boolean => {
			if (p < 0 || p >= order.length) {
				return false;
			}
			const blob = order[p];
			return archives[blob] === archive && taken[blob] !== call && queued(blob);
		};
		const heap = this.#seedHeap(priorities, n);
		let size = n;
		while (size > 0 && reads.length < maxReads) {
			const seed = blobs[heap[0]];
			size--;
			heap[0] = heap[size];
			siftDown(heap, size, 0, priorities);
			if (taken[seed] === call) {
				continue;
			}
			const archive = archives[seed];
			const at = this.#position[seed];
			let start = starts[seed];
			let end = ends[seed];
			const members = [seed];
			taken[seed] = call;
			// right first, skipping over blobs that aren't queued while the gap allows
			let right = at + 1;
			let left = at - 1;
			while (members.length < COALESCE_COUNT) {
				while (right < order.length && archives[order[right]] === archive && !usable(right, archive)) {
					if (starts[order[right]] - end > COALESCE_GAP) {
						break;
					}
					right++;
				}
				while (left >= 0 && archives[order[left]] === archive && !usable(left, archive)) {
					if (start - ends[order[left]] > COALESCE_GAP) {
						break;
					}
					left--;
				}
				if (usable(right, archive)) {
					const blob = order[right];
					if (starts[blob] - end <= COALESCE_GAP && Math.max(end, ends[blob]) - start <= COALESCE_SPAN) {
						end = Math.max(end, ends[blob]);
						taken[blob] = call;
						members.push(blob);
						right++;
						continue;
					}
				}
				if (usable(left, archive)) {
					const blob = order[left];
					if (start - ends[blob] <= COALESCE_GAP && end - starts[blob] <= COALESCE_SPAN) {
						start = starts[blob];
						taken[blob] = call;
						members.push(blob);
						left--;
						continue;
					}
				}
				break;
			}
			const position = this.#position;
			members.sort((a, b) => position[a] - position[b]);
			reads.push({ members, start, end });
		}
		return reads;
	}

	/** @returns indices into the queue, heapified by descending priority */
	#seedHeap(priorities: ArrayLike<number>, n: number): Int32Array {
		if (this.#heap.length < n) {
			this.#heap = new Int32Array(Math.max(n, this.#heap.length * 2));
		}
		const heap = this.#heap;
		for (let i = 0; i < n; i++) {
			heap[i] = i;
		}
		for (let i = (n >> 1) - 1; i >= 0; i--) {
			siftDown(heap, n, i, priorities);
		}
		return heap;
	}
}

/** whether queue entry `a` seeds before `b`: higher priority, then earlier in the queue */
const before = (a: number, b: number, priorities: ArrayLike<number>): boolean =>
	priorities[a] > priorities[b] || (priorities[a] === priorities[b] && a < b);

const siftDown = (heap: Int32Array, size: number, from: number, priorities: ArrayLike<number>): void => {
	let i = from;
	for (;;) {
		const l = 2 * i + 1;
		if (l >= size) {
			return;
		}
		const r = l + 1;
		const child = r < size && before(heap[r], heap[l], priorities) ? r : l;
		if (!before(heap[child], heap[i], priorities)) {
			return;
		}
		const t = heap[i];
		heap[i] = heap[child];
		heap[child] = t;
		i = child;
	}
};
