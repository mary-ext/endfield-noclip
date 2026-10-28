/**
 * a small pool of decode workers; jobs go to the least busy worker.
 *
 * @module
 */

import type { Decoded, DecodeRequest, DecodeResponse } from './decode-protocol.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** a {@link DecodeRequest} before the pool numbers it */
export type DecodeJob = DistributiveOmit<DecodeRequest, 'id'>;

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
	#jobs = new Map<number, Pending>();
	#nextId = 1;

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
	 * @param request the job; its `data` buffer is transferred
	 * @returns the decoded blob, of the job's kind
	 */
	run<J extends DecodeJob>(request: J): Promise<Extract<Decoded, { kind: J['kind'] }>> {
		const id = this.#nextId++;
		let worker = 0;
		for (let i = 1; i < this.#workers.length; i++) {
			if (this.#busy[i] < this.#busy[worker]) {
				worker = i;
			}
		}
		this.#busy[worker]++;
		return new Promise((resolve, reject) => {
			this.#jobs.set(id, {
				kind: request.kind,
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- #settle checks the answer's kind
				resolve: resolve as (value: Decoded) => void,
				reject,
				worker,
			});
			this.#workers[worker].postMessage({ ...request, id }, [request.data]);
		});
	}

	/** terminates the workers; pending jobs never settle */
	destroy(): void {
		for (const worker of this.#workers) {
			worker.terminate();
		}
		this.#jobs.clear();
	}

	#settle(response: DecodeResponse): void {
		const job = this.#jobs.get(response.id);
		if (job === undefined) {
			return;
		}
		this.#jobs.delete(response.id);
		this.#busy[job.worker]--;
		if (response.kind === 'error') {
			job.reject(new Error(response.message));
		} else if (response.kind !== job.kind) {
			job.reject(new Error(`decode worker answered a ${job.kind} job with ${response.kind}`));
		} else {
			job.resolve(response);
		}
	}
}
