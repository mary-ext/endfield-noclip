import { Worker } from 'node:worker_threads';

import type { ReadyGeometry } from '@endfield-noclip/package-format/geometry';

import type { Keys } from '../../config.ts';
import type { AssetRef, ObjectLocator } from '../../game/assets/assets.ts';
import type { BlobMeta } from '../store/blob-file.ts';

import type { SwayReach } from './geometry.ts';
import type { ConvertedTexture } from './textures.ts';

// mesh and texture conversion is CPU-bound (LZ4, meshopt, zstd, SHA-256), so it runs on worker threads
// (`convert-worker.ts`). each worker opens the install itself and writes blobs straight to the blob directory.

// #region protocol

/** what a worker needs to open the install */
export interface ConvertWorkerData {
	gameData: string;
	keys: Keys;
	/** the {@link BlobDir} root blobs are written to */
	blobDir: string;
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

/** a conversion's output and what it read: it holds for as long as those bundles' md5s do */
export type ConvertResult = ConvertOutput & { sources: BundleSource[] };

/** a job's result type */
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

interface PoolWorker {
	worker: Worker;
	pending: Map<number, { resolve: (result: ConvertResult) => void; reject: (error: Error) => void }>;
}

/**
 * up to a fixed number of conversion workers, started as jobs need them (a pack that finds everything in its
 * cache starts none); jobs go to the least busy one
 */
export class ConvertPool {
	readonly size: number;
	readonly #data: ConvertWorkerData;
	readonly #workers: PoolWorker[] = [];
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
	 * @returns the converted asset
	 * @throws {Error} with the worker's message if conversion fails
	 */
	run(job: ConvertJob): Promise<ConvertResult> {
		let target: PoolWorker | undefined;
		for (const entry of this.#workers) {
			if (target === undefined || entry.pending.size < target.pending.size) {
				target = entry;
			}
		}
		if (target === undefined || (target.pending.size > 0 && this.#workers.length < this.size)) {
			target = this.#start();
			this.#workers.push(target);
		}
		const chosen = target;
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			chosen.pending.set(id, { resolve, reject });
			// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a node worker, not a window
			chosen.worker.postMessage({ type: 'job', id, job } satisfies WorkerRequest);
		});
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
		});
		// a crashed worker fails its jobs rather than hanging the pack
		const fail = (error: Error) => {
			for (const job of entry.pending.values()) {
				job.reject(error);
			}
			entry.pending.clear();
		};
		entry.worker.on('error', fail);
		entry.worker.on('exit', (code) => fail(new Error(`conversion worker exited with code ${code}`)));
		return entry;
	}
}
