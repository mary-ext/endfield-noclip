import { type AssetResolver, recordBundleReads } from '../game/assets/assets.ts';
import { bundleSources, sourcesCurrent } from '../ir/bundle-memo.ts';
import type { BundleSource, MemoCache } from '../ir/cache.ts';

import { PhaseTimer } from './phase-timer.ts';

/** options for {@link memoizeValue} */
export interface MemoValueOptions<T> {
	/** module whose workspace import graph fingerprints the cached result */
	entry: URL;
	/** input keys (catalog MD5s, scene id, options) that determine the result */
	parts: object;
	/** computes the value on a cache miss */
	compute: () => Promise<T>;
}

/**
 * recalls a cached value from `cache` when available, or computes and stores it
 *
 * @param cache optional memo cache
 * @param options entry module, key parts, and compute function
 * @returns the recalled or freshly computed value
 */
export const memoizeValue = async <T>(
	cache: MemoCache | null,
	{ entry, parts, compute }: MemoValueOptions<T>,
): Promise<T> => {
	if (cache === null) {
		return compute();
	}
	const key = await cache.stepKey(entry, parts);
	const recalled = await cache.recallValue<T>(key);
	if (recalled !== undefined) {
		return recalled;
	}
	const value = await compute();
	await cache.rememberValue(key, value);
	return value;
};

/** options for {@link memoizeBundleValue} */
export interface MemoBundleValueOptions<T> extends MemoValueOptions<T> {
	/** resolves the `AssetResolver` lazily (only needed when validating or recording bundle reads) */
	resolver: () => Promise<AssetResolver>;
	/** optional predicate gating whether a freshly computed result should be persisted */
	shouldStore?: (value: T) => boolean;
}

/**
 * recalls a bundle-reading value from `cache` if every bundle it touched still has the same catalog MD5, or
 * computes it under `recordBundleReads` and stores the result alongside its touched bundle sources
 *
 * @param cache optional memo cache
 * @param options entry module, key parts, resolver getter, and compute function
 * @returns the recalled or freshly computed value
 */
export const memoizeBundleValue = async <T>(
	cache: MemoCache | null,
	{ entry, parts, resolver, shouldStore, compute }: MemoBundleValueOptions<T>,
): Promise<T> => {
	if (cache === null) {
		return compute();
	}
	const key = await cache.stepKey(entry, parts);
	const recalled = await cache.recallValue<{ result: T; sources: BundleSource[] }>(key);
	if (
		recalled !== undefined &&
		(recalled.sources.length === 0 || (await sourcesCurrent(await resolver(), recalled.sources)))
	) {
		return recalled.result;
	}
	const { result, bundles } = await recordBundleReads(compute);
	if (shouldStore === undefined || shouldStore(result)) {
		const sources = bundles.length === 0 ? [] : await bundleSources(await resolver(), bundles);
		await cache.rememberValue(key, { result, sources });
	}
	return result;
};

/** runs named pipeline stages in order, timing each one through {@link PhaseTimer} */
export class PipelineRunner {
	readonly #timer: PhaseTimer;

	/** @param log progress output */
	constructor(log: (line: string) => void) {
		this.#timer = new PhaseTimer(log);
	}

	/**
	 * executes one timed stage and returns its result
	 *
	 * @param name stage label for the pack report
	 * @param fn stage body
	 * @returns stage output
	 */
	async stage<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
		const result = await fn();
		this.#timer.end(name);
		return result;
	}

	/** adopts sub-phase timings (e.g. `materials`, `geometry`, `textures`) reported by a composite stage */
	adopt(timings: Readonly<Record<string, number>>): void {
		this.#timer.adopt(timings);
	}

	/** elapsed milliseconds by stage name */
	get timings(): Record<string, number> {
		return this.#timer.timings;
	}
}
