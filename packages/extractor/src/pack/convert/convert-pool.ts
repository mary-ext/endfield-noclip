import { Worker } from 'node:worker_threads';

import type { ReadyGeometry } from '@endfield-noclip/package-format/geometry';

import { Queue } from '@mary-ext/ds-queue';

import type { Keys } from '../../config.ts';
import type { AssetRef, ObjectLocator } from '../../game/assets/assets.ts';
import type { BlobMeta } from '../store/blob-file.ts';

import type { OffsetReach, SwayReach } from './geometry.ts';
import type { ConvertedTexture } from './textures.ts';
import type { VatBake } from './vat-skin.ts';

// mesh and texture conversion is CPU-bound (LZ4, meshopt, zstd, SHA-256), so it runs on worker threads
// (`convert-worker.ts`). each worker opens the install itself and writes blobs straight to the blob directory.

// #region protocol

/** what a worker needs to open the install */
export interface ConvertWorkerData {
	gameData: string;
	keys: Keys;
	/** the {@link BlobDir} root blobs are written to */
	blobDir: string;
	/** optional SQLite cache database path for raw-byte compression dedup memos */
	cacheDb: string | null;
	/** the packer's decompressed bundle manifest, shared rather than loaded by each worker (~150 MB) */
	manifest: Uint8Array;
}

/** one asset to convert */
export type ConvertJob =
	| {
			kind: 'geometry';
			asset: AssetRef;
			/** UV set to generate tangents from; see `convertMesh` */
			tangentUv: number | null;
			/** the farthest sway of the materials drawing it, `null` when none sways; see `convertMesh` */
			sway: SwayReach | null;
			/** the farthest vertex offset of the materials drawing it, `null` without one; see `convertMesh` */
			offset: OffsetReach | null;
			/** the vertex animation its materials play, `null` without one; see `vatSkin` and `boneVatSkin` */
			vat: VatBake | null;
			zstdLevel: number;
	  }
	| { kind: 'texture'; locator: ObjectLocator; zstdLevel: number };

/** a converted asset; its blobs are in the blob directory */
export type ConvertOutput =
	| {
			kind: 'geometry';
			/** `CAB-<hex>:<path id>` of the mesh */
			object: string;
			name: string;
			entry: Omit<ReadyGeometry, 'status' | 'blob'>;
			gpuBytes: number;
			blob: BlobMeta;
			/** why the vertex animation the job asked for wasn't baked, which leaves the mesh still */
			unanimated?: string;
	  }
	| {
			kind: 'texture';
			name: string;
			entry: ConvertedTexture['entry'];
			/** equal for textures with the same shape, format, sampler and texels */
			contentKey: string;
			/** settings WebGPU can't express and the stand-in used, e.g. Unity's mirror-once wrap */
			approximations: string[];
			/** coarse to fine */
			pieces: { firstLevel: number; levelCount: number; blob: BlobMeta }[];
	  };

/** a bundle a conversion read, as the VFS catalog had it then */
export interface BundleSource {
	/** manifest bundle name, `main/<hex>.ab` */
	bundle: string;
	md5: string;
}

/** a failed conversion and what it read before failing: holds while those bundles (or the manifest) do */
export interface FailedConvertResult {
	kind: 'failed';
	jobKind: ConvertJob['kind'];
	error: string;
	sources: BundleSource[];
	/** bundle manifest content hash, stored when `sources` is empty (e.g. missing path hash) */
	manifestHash?: string;
}

/** a conversion's output and what it read: it holds for as long as those bundles' md5s do */
export type ConvertResult = (ConvertOutput & { sources: BundleSource[] }) | FailedConvertResult;

/** a job's successful result type */
export type ConvertResultOf<J extends ConvertJob> = Extract<ConvertResult, { kind: J['kind'] }>;

/**
 * @param job a job
 * @param result a result said to be the job's
 * @returns whether the result is of the job's kind
 */
export const resultMatches = <J extends ConvertJob>(
	job: J,
	result: ConvertResult,
): result is ConvertResultOf<J> => result.kind === job.kind;

export type WorkerRequest = { type: 'job'; id: number; job: ConvertJob } | { type: 'close' };

export type WorkerReply = { id: number; result: ConvertResult } | { id: number; error: string };

// #endregion

interface QueuedJob {
	id: number;
	job: ConvertJob;
	/** manifest bundle index the job reads, to prefer a worker that already has it open */
	affinity: number | undefined;
	resolve: (result: ConvertResult) => void;
	reject: (error: Error) => void;
}

interface PoolWorker {
	worker: Worker;
	pending: Map<number, QueuedJob>;
}

/**
 * jobs a worker holds at once. conversion is synchronous CPU work, so a second job only overlaps the first's
 * reads; more would hold more decoded textures without converting faster
 */
const JOBS_PER_WORKER = 2;

/**
 * up to a fixed number of conversion workers, started as jobs need them (a pack that finds everything in its
 * cache starts none); jobs wait here until a worker has room, then go to the least busy one
 */
export class ConvertPool {
	readonly size: number;
	readonly #data: ConvertWorkerData;
	readonly #workers: PoolWorker[] = [];
	readonly #queue = new Queue<QueuedJob>();
	/** last worker assigned a job for each manifest bundle index */
	readonly #affinity = new Map<number, PoolWorker>();
	#nextId = 0;

	/**
	 * @param size number of workers
	 * @param data how workers open the install and where they write blobs
	 */
	constructor(size: number, data: ConvertWorkerData) {
		this.size = size;
		this.#data = data;
	}

	/**
	 * @param job the asset to convert
	 * @param affinity manifest bundle index the job reads, to route same-bundle jobs to one worker
	 * @returns the converted asset
	 * @throws {Error} with the worker's message if conversion fails
	 */
	run(job: ConvertJob, affinity?: number): Promise<ConvertResult> {
		const { promise, resolve, reject } = Promise.withResolvers<ConvertResult>();
		this.#queue.enqueue({ id: this.#nextId++, job, affinity, resolve, reject });
		this.#dispatch();
		return promise;
	}

	/** hands queued jobs to workers with room, starting workers while the pool isn't full */
	#dispatch(): void {
		while (this.#queue.size > 0) {
			const next = this.#queue.peek()!;
			const preferred = next.affinity === undefined ? undefined : this.#affinity.get(next.affinity);
			let target: PoolWorker | undefined;
			if (preferred !== undefined && preferred.pending.size < JOBS_PER_WORKER) {
				target = preferred;
			} else {
				for (const entry of this.#workers) {
					if (target === undefined || entry.pending.size < target.pending.size) {
						target = entry;
					}
				}
				if (target === undefined || (target.pending.size > 0 && this.#workers.length < this.size)) {
					target = this.#start();
					this.#workers.push(target);
				} else if (target.pending.size >= JOBS_PER_WORKER) {
					return;
				}
			}
			const queued = this.#queue.dequeue()!;
			if (queued.affinity !== undefined) {
				this.#affinity.set(queued.affinity, target);
			}
			target.pending.set(queued.id, queued);
			// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a node worker, not a window
			target.worker.postMessage({ type: 'job', id: queued.id, job: queued.job } satisfies WorkerRequest);
		}
	}

	/** lets every worker close its files and exit */
	async close(): Promise<void> {
		await Promise.all(
			this.#workers.map(({ worker }) => {
				const exited = new Promise((resolve) => worker.once('exit', resolve));
				// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a node worker, not a window
				worker.postMessage({ type: 'close' } satisfies WorkerRequest);
				return exited;
			}),
		);
	}

	#start(): PoolWorker {
		const entry: PoolWorker = {
			worker: new Worker(new URL('./convert-worker.ts', import.meta.url), { workerData: this.#data }),
			pending: new Map(),
		};
		entry.worker.on('message', (reply: WorkerReply) => {
			const job = entry.pending.get(reply.id);
			entry.pending.delete(reply.id);
			if ('error' in reply) {
				job?.reject(new Error(reply.error));
			} else {
				job?.resolve(reply.result);
			}
			this.#dispatch();
		});
		// a crashed worker fails its jobs rather than hanging the pack, and leaves the pool so queued jobs go
		// to the others or a replacement
		const fail = (error: Error) => {
			for (const job of entry.pending.values()) {
				job.reject(error);
			}
			entry.pending.clear();
			const index = this.#workers.indexOf(entry);
			if (index !== -1) {
				this.#workers.splice(index, 1);
				for (const [bundle, worker] of this.#affinity) {
					if (worker === entry) {
						this.#affinity.delete(bundle);
					}
				}
				this.#dispatch();
			}
		};
		entry.worker.on('error', fail);
		entry.worker.on('exit', (code) => fail(new Error(`conversion worker exited with code ${code}`)));
		return entry;
	}
}
