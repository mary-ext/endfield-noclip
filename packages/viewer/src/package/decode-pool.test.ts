import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';

import { BlobCodec } from '@endfield-noclip/package-format/blobs';

import { DecodePool, POSTED_PER_WORKER, SharedBytes } from './decode-pool.ts';
import type { WorkerMessage } from './decode-protocol.ts';

/** records what the pool posts, and answers when told to */
class FakeWorker extends EventTarget {
	static made: FakeWorker[] = [];
	posted: { message: WorkerMessage; transfer: unknown[] }[] = [];

	constructor() {
		super();
		FakeWorker.made.push(this);
	}

	postMessage(message: WorkerMessage, transfer: unknown[]): void {
		this.posted.push({ message, transfer });
	}

	terminate(): void {}

	/** answers a decode request as a decoded texture */
	answer(id: number): void {
		this.dispatchEvent(
			new MessageEvent('message', { data: { id, kind: 'texture', data: new ArrayBuffer(0) } }),
		);
	}
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
before(() => {
	Object.defineProperty(globalThis, 'Worker', { value: FakeWorker, configurable: true, writable: true });
});
after(() => {
	if (original === undefined) {
		Reflect.deleteProperty(globalThis, 'Worker');
	} else {
		Object.defineProperty(globalThis, 'Worker', original);
	}
});

const job = (bytes: SharedBytes, offset: number, length: number) => ({
	kind: 'texture' as const,
	bytes,
	offset,
	length,
	codec: BlobCodec.None,
	rawLength: length,
});

const types = (worker: FakeWorker): string[] => worker.posted.map(({ message }) => message.type);

it("sends a read's buffer once to the worker taking its first job, and its other jobs there too", async () => {
	FakeWorker.made = [];
	const pool = new DecodePool(2);
	const [first, second] = FakeWorker.made;
	const signal = new AbortController().signal;
	const read = new SharedBytes(new ArrayBuffer(32), 2);
	const other = new SharedBytes(new ArrayBuffer(16), 1);

	const decoded = pool.run(job(read, 0, 16), signal);
	pool.run(job(read, 16, 16), signal);
	pool.run(job(other, 0, 16), signal);

	assert.deepEqual(types(first), ['buffer', 'decode', 'decode']);
	assert.deepEqual(types(second), ['buffer', 'decode']);
	const [buffer, a, b] = first.posted;
	assert.deepEqual(buffer.transfer, [read.data], 'transferred whole');
	assert.ok(a.message.type === 'decode' && b.message.type === 'decode');
	assert.deepEqual([a.message.request.offset, a.message.request.last], [0, false]);
	assert.deepEqual([b.message.request.offset, b.message.request.last], [16, true]);

	first.answer(a.message.request.id);
	assert.equal((await decoded).kind, 'texture');
	pool.destroy();
});

it('tells the worker to free a buffer once its remaining jobs are released instead of run', () => {
	FakeWorker.made = [];
	const pool = new DecodePool(1);
	const [worker] = FakeWorker.made;
	const read = new SharedBytes(new ArrayBuffer(32), 3);

	pool.run(job(read, 0, 16), new AbortController().signal);
	pool.release(read);
	assert.deepEqual(types(worker), ['buffer', 'decode']);
	pool.release(read);
	assert.deepEqual(types(worker), ['buffer', 'decode', 'release']);

	// bytes no job reached stay on the main thread
	const unused = new SharedBytes(new ArrayBuffer(16), 1);
	pool.release(unused);
	assert.equal(worker.posted.length, 3);
	pool.destroy();
});

it('keeps a job for a full worker queued while others go to idle workers', () => {
	FakeWorker.made = [];
	const pool = new DecodePool(2);
	const [first, second] = FakeWorker.made;
	const signal = new AbortController().signal;
	const jobs = POSTED_PER_WORKER + 1;
	const read = new SharedBytes(new ArrayBuffer(16 * (jobs + 1)), jobs + 1);

	for (let i = 0; i < jobs; i++) {
		pool.run(job(read, i * 16, 16), signal);
	}
	const other = new SharedBytes(new ArrayBuffer(16), 1);
	pool.run(job(other, 0, 16), signal);
	// a worker's fill posted to the first worker, one waiting for it; the other read went to the idle worker
	assert.equal(types(first).filter((type) => type === 'decode').length, POSTED_PER_WORKER);
	assert.deepEqual(types(second), ['buffer', 'decode']);

	const posted = first.posted[1].message;
	assert.ok(posted.type === 'decode');
	first.answer(posted.request.id);
	assert.equal(types(first).filter((type) => type === 'decode').length, jobs);
	pool.release(read);
	assert.equal(types(first).at(-1), 'release');
	pool.destroy();
});
