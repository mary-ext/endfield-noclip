import { promisify } from 'node:util';
import { constants, zstdCompress, zstdCompressSync } from 'node:zlib';

import { Queue } from '@mary-ext/ds-queue';

const zstdCompressAsync = promisify(zstdCompress);

/**
 * zstd calls handed to the libuv pool at once. node allocates each call's compression context when it's
 * queued, not when a thread takes it, so an unbounded batch of level-19 calls holds gigabytes while the pool
 * works through them
 */
const MAX_IN_FLIGHT = Number(process.env.UV_THREADPOOL_SIZE ?? 4) + 2;

let inFlight = 0;
const waiting = new Queue<() => void>();

/** @returns zlib options for a compression level */
const atLevel = (level: number) => ({ params: { [constants.ZSTD_c_compressionLevel]: level } });

/**
 * @param data bytes to compress
 * @param level zstd compression level
 * @returns one zstd frame
 */
export const zstdSync = (data: Uint8Array, level: number): Uint8Array => {
	return new Uint8Array(zstdCompressSync(data, atLevel(level)));
};

/**
 * compresses on the libuv thread pool
 *
 * @param data bytes to compress
 * @param level zstd compression level
 * @returns one zstd frame
 */
export const zstd = async (data: Uint8Array, level: number): Promise<Uint8Array> => {
	if (inFlight < MAX_IN_FLIGHT) {
		inFlight++;
	} else {
		const { promise, resolve } = Promise.withResolvers<void>();
		waiting.enqueue(resolve);
		await promise;
	}
	try {
		const packed = await zstdCompressAsync(data, atLevel(level));
		return new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength);
	} finally {
		// a waiter takes over this slot, so the count only drops when none is left
		const next = waiting.dequeue();
		if (next === undefined) {
			inFlight--;
		} else {
			next();
		}
	}
};
