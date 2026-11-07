import type {
	BlobEncoding,
	Decoded,
	DecodeRequest,
	DecodeResponse,
	WorkerMessage,
} from './decode-protocol.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * stored bytes that decode jobs read ranges of, such as one coalesced range read. the pool transfers the
 * buffer whole to the worker that takes its first job, so its later jobs go to that worker too
 */
export class SharedBytes {
	/** the bytes; detached once a worker has them */
	readonly data: ArrayBuffer;
	/** jobs that may still read the bytes and haven't been posted; the pool counts them down */
	users: number;
	/** the pool's id for the buffer once posted, else 0 */
	id = 0;
	/** the worker holding the buffer, or -1 before it's posted */
	worker = -1;

	/**
	 * @param data the bytes; the pool transfers the buffer, so nothing else may keep using it
	 * @param users how many jobs will read it: each is passed to {@link DecodePool.run} or
	 *   {@link DecodePool.release} once
	 */
	constructor(data: ArrayBuffer, users: number) {
		this.data = data;
		this.users = users;
	}
}

/** a blob as stored, which every decode job carries */
export interface StoredBlob extends BlobEncoding {
	bytes: SharedBytes;
	/** the stored bytes' range in {@link bytes} */
	offset: number;
	length: number;
}

/** a {@link DecodeRequest} before the pool posts it */
export type DecodeJob = DistributiveOmit<DecodeRequest, keyof StoredBlob | 'id' | 'buffer' | 'last'> &
	StoredBlob;

/**
 * jobs posted to a worker at most at once; the rest wait in the pool, where they can still be cancelled. a
 * worker's answer waits for the main thread, which is busy for most of a frame while streaming, so a worker
 * with one job in hand would idle between them
 */
const POSTED_PER_WORKER = 4;

interface Queued {
	request: DecodeJob;
	signal: AbortSignal;
	resolve: (value: Decoded) => void;
	reject: (reason: unknown) => void;
}

interface Pending {
	kind: DecodeJob['kind'];
	resolve: (value: Decoded) => void;
	reject: (reason: Error) => void;
	worker: number;
}

/** runs {@link DecodeRequest}s on worker threads */
export class DecodePool {
	#workers: Worker[] = [];
	#busy: number[] = [];
	#queue: Queued[] = [];
	#jobs = new Map<number, Pending>();
	/** signals whose abort drops their queued jobs */
	#watched = new WeakSet<AbortSignal>();
	#nextId = 1;
	#nextBuffer = 1;

	/** @param size worker count */
	constructor(size: number) {
		for (let i = 0; i < size; i++) {
			const worker = new Worker(new URL('./decode-worker.ts', import.meta.url), {
				type: 'module',
				name: `decode-${i}`,
			});
			worker.addEventListener('message', (event: MessageEvent<DecodeResponse>) => this.#settle(event.data));
			worker.addEventListener('error', (event) => console.error('decode worker:', event.message));
			this.#workers.push(worker);
			this.#busy.push(0);
		}
	}

	/**
	 * queues a job for the least busy worker, or for the worker already holding its bytes.
	 *
	 * @param request the job; it's one of its bytes' users
	 * @param signal aborting it rejects the job with its reason, unless a worker has already taken it
	 * @returns the decoded blob, of the job's kind
	 */
	run<J extends DecodeJob>(request: J, signal: AbortSignal): Promise<Extract<Decoded, { kind: J['kind'] }>> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) {
				this.release(request.bytes);
				reject(signal.reason);
				return;
			}
			if (!this.#watched.has(signal)) {
				this.#watched.add(signal);
				signal.addEventListener('abort', () => this.#dropAborted(), { once: true });
			}
			this.#queue.push({
				request,
				signal,
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- #settle checks the answer's kind
				resolve: resolve as (value: Decoded) => void,
				reject,
			});
			this.#post();
		});
	}

	/**
	 * gives up a use of the bytes without running a job on them, so the worker holding them can free them once
	 * no job will read them
	 *
	 * @param bytes the bytes
	 */
	release(bytes: SharedBytes): void {
		bytes.users--;
		if (bytes.users === 0 && bytes.worker >= 0) {
			this.#send(bytes.worker, { type: 'release', buffer: bytes.id });
		}
	}

	/**
	 * jobs {@link run} can take now without waiting in the pool, so a caller that orders its own work can hand
	 * it over as late as possible
	 */
	get free(): number {
		return this.#workers.length * POSTED_PER_WORKER - this.#jobs.size - this.#queue.length;
	}

	/** terminates the workers; pending jobs never settle */
	destroy(): void {
		for (const worker of this.#workers) {
			worker.terminate();
		}
		this.#queue = [];
		this.#jobs.clear();
	}

	/** hands queued jobs to workers with room, in queue order except where a job's worker is full */
	#post(): void {
		let kept = 0;
		for (const job of this.#queue) {
			const worker = this.#workerFor(job.request.bytes);
			if (worker < 0) {
				this.#queue[kept++] = job;
			} else {
				this.#start(job, worker);
			}
		}
		this.#queue.length = kept;
	}

	/** @returns the worker a job on these bytes can be posted to now, or -1 */
	#workerFor(bytes: SharedBytes): number {
		let worker = bytes.worker;
		if (worker < 0) {
			worker = 0;
			for (let i = 1; i < this.#workers.length; i++) {
				if (this.#busy[i] < this.#busy[worker]) {
					worker = i;
				}
			}
		}
		return this.#busy[worker] < POSTED_PER_WORKER ? worker : -1;
	}

	#start(job: Queued, worker: number): void {
		const { bytes, ...fields } = job.request;
		if (bytes.worker < 0) {
			bytes.worker = worker;
			bytes.id = this.#nextBuffer++;
			this.#send(worker, { type: 'buffer', buffer: bytes.id, data: bytes.data }, [bytes.data]);
		}
		bytes.users--;
		const id = this.#nextId++;
		this.#busy[worker]++;
		this.#jobs.set(id, { kind: fields.kind, resolve: job.resolve, reject: job.reject, worker });
		const request: DecodeRequest = { ...fields, id, buffer: bytes.id, last: bytes.users === 0 };
		this.#send(worker, { type: 'decode', request });
	}

	#send(worker: number, message: WorkerMessage, transfer: Transferable[] = []): void {
		this.#workers[worker].postMessage(message, transfer);
	}

	/** rejects and drops the queued jobs whose signal was aborted */
	#dropAborted(): void {
		const kept: Queued[] = [];
		for (const job of this.#queue) {
			if (job.signal.aborted) {
				this.release(job.request.bytes);
				job.reject(job.signal.reason);
			} else {
				kept.push(job);
			}
		}
		this.#queue = kept;
	}

	#settle(response: DecodeResponse): void {
		const job = this.#jobs.get(response.id);
		if (job === undefined) {
			return;
		}
		this.#jobs.delete(response.id);
		this.#busy[job.worker]--;
		this.#post();
		if (response.kind === 'error') {
			job.reject(new Error(response.message));
		} else if (response.kind !== job.kind) {
			job.reject(new Error(`decode worker answered a ${job.kind} job with ${response.kind}`));
		} else {
			job.resolve(response);
		}
	}
}
