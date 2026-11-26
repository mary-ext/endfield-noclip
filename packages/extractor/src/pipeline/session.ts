import type { Context } from '../install/context.ts';

import { type CacheReport, PackCache } from './cache/pack-cache.ts';
import { ConvertPool } from './compile/convert-pool.ts';

/** options for opening a {@link PackSession} */
export interface PackSessionOptions {
	/** cache directory, or `null` to pack without a cache */
	cacheDir: string | null;
	/** worker threads for asset conversion */
	jobs: number;
}

/**
 * long-lived resources shared across one or more `packScene` calls (e.g. `pack --existing`): keeps the SQLite
 * cache, conversion worker pool, `MemoryPack` schema, and `StringPathHash` tables alive across scenes and
 * runs a single cache sweep when {@link close} is called
 */
export class PackSession {
	readonly context: Context;
	readonly cache: PackCache | null;
	readonly #jobs: number;
	#pool: ConvertPool | null = null;
	#recordedRoots = false;

	private constructor(context: Context, cache: PackCache | null, jobs: number) {
		this.context = context;
		this.cache = cache;
		this.#jobs = jobs;
	}

	/**
	 * opens the pack cache (if configured) and prepares a session for packing scenes
	 *
	 * @param context install readers
	 * @param options cache directory and worker concurrency
	 * @returns the open session
	 */
	static async open(context: Context, options: PackSessionOptions): Promise<PackSession> {
		const cache = options.cacheDir === null ? null : await PackCache.open(options.cacheDir);
		return new PackSession(context, cache, options.jobs);
	}

	/**
	 * returns the shared conversion worker pool when backed by a persistent cache (so every scene writes into
	 * the same `blobs/` directory), or `null` when running uncached
	 *
	 * @returns shared conversion pool, or `null` without a cache
	 */
	async sharedPool(): Promise<ConvertPool | null> {
		if (this.cache === null) {
			return null;
		}
		if (this.#pool === null) {
			this.#pool = new ConvertPool(this.#jobs, {
				gameData: this.context.config.gameData,
				keys: this.context.keys,
				blobDir: this.cache.blobs.root,
				cacheDb: this.cache.dbPath,
				manifest: (await this.context.world.manifest()).bytes,
			});
		}
		return this.#pool;
	}

	/** marks that at least one scene recorded a root in this session, so {@link finish} should sweep */
	markRootRecorded(): void {
		this.#recordedRoots = true;
	}

	/**
	 * sweeps unreferenced cache entries once for all scenes packed in this session, then closes the worker pool
	 * and cache
	 *
	 * @returns sweep totals, or `null` without a cache or recorded roots
	 */
	async close(): Promise<CacheReport['swept'] | null> {
		let swept: CacheReport['swept'] | null = null;
		try {
			if (this.#pool !== null) {
				await this.#pool.close();
				this.#pool = null;
			}
			if (this.cache !== null && this.#recordedRoots) {
				swept = await this.cache.sweep();
			}
		} finally {
			await this.cache?.close();
		}
		return swept;
	}
}
