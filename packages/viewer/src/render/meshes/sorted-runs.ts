/**
 * the transparent pass's draw order: every draw's instances in one list, far to near, as the game merges its
 * sorted transparent lists (`docs/game-data/materials.md#transparent-draw-order`)
 *
 * @module
 */

/**
 * @param layer a renderer's sorting layer (its place in the layer order), i16
 * @param order its sorting order within the layer, i16
 * @returns its sort band: lower bands draw first, whatever their distance
 */
export const sortBand = (layer: number, order: number): number => layer * 65_536 + order;

/** a draw's instances in draw order, as the merge reads them */
export interface SortedSource {
	/** each instance's {@link sortBand}, ascending */
	bands: readonly number[];
	/** each instance's distance from the camera, m, far to near within a band */
	distances: readonly number[];
	/** how many of them draw, from the first */
	count: number;
}

/**
 * merges draws' instances into one order, lower bands first and far to near within a band, in runs:
 * consecutive instances of one draw draw together, as the game draws neighbouring instances of one mesh and
 * material in one call. on a tie, the earlier source goes first
 *
 * @param sources the draws, each in that order
 * @param runs filled with `[source, first, count]` triples, `first` counting from the source's first
 *   instance; cleared first
 */
export const mergeFarToNear = (sources: readonly SortedSource[], runs: number[]): void => {
	runs.length = 0;
	// a binary heap of sources by their next instance, the one to draw first on top
	const heap: number[] = [];
	const next = sources.map(() => 0);
	const band = (source: number): number => sources[source].bands[next[source]];
	const key = (source: number): number => sources[source].distances[next[source]];
	/** whether `a` goes before `b` */
	const before = (a: number, b: number): boolean => {
		const ba = band(a);
		const bb = band(b);
		if (ba !== bb) {
			return ba < bb;
		}
		return key(a) > key(b) || (key(a) === key(b) && a < b);
	};
	const up = (at: number): void => {
		let i = at;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (!before(heap[i], heap[parent])) {
				break;
			}
			[heap[i], heap[parent]] = [heap[parent], heap[i]];
			i = parent;
		}
	};
	const down = (at: number): void => {
		let i = at;
		for (;;) {
			const left = 2 * i + 1;
			const right = left + 1;
			let top = i;
			if (left < heap.length && before(heap[left], heap[top])) {
				top = left;
			}
			if (right < heap.length && before(heap[right], heap[top])) {
				top = right;
			}
			if (top === i) {
				break;
			}
			[heap[i], heap[top]] = [heap[top], heap[i]];
			i = top;
		}
	};
	for (let s = 0; s < sources.length; s++) {
		if (sources[s].count > 0) {
			heap.push(s);
			up(heap.length - 1);
		}
	}
	while (heap.length > 0) {
		const source = heap[0];
		const first = next[source];
		const { count } = sources[source];
		// take instances while this source stays ahead of every other
		next[source]++;
		while (next[source] < count) {
			const other = heap.length > 1 ? (heap.length > 2 && before(heap[2], heap[1]) ? heap[2] : heap[1]) : -1;
			if (other >= 0 && before(other, source)) {
				break;
			}
			next[source]++;
		}
		runs.push(source, first, next[source] - first);
		if (next[source] >= count) {
			// the last source takes the finished one's place
			heap[0] = heap.at(-1) ?? source;
			heap.length--;
		}
		if (heap.length > 0) {
			down(0);
		}
	}
};
