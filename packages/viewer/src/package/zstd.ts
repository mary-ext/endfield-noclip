/**
 * zstd decoding through zstddec's wasm build, which is an order of magnitude faster than a JS decoder on
 * texture blobs. the module instance is per realm, so each worker initializes its own.
 *
 * @module
 */

import { ZSTDDecoder } from 'zstddec';

const decoder = new ZSTDDecoder();

/** resolves once the decoder's wasm is instantiated; await before {@link decompressZstd} */
export const zstdReady: Promise<void> = decoder.init();

/**
 * @param frame one zstd frame
 * @param rawLength the decoded length, if known; otherwise read from the frame header
 * @returns the decoded bytes, in a buffer of their own
 * @throws {Error} if the frame doesn't decode to `rawLength` bytes
 */
export const decompressZstd = (frame: Uint8Array, rawLength?: number): Uint8Array<ArrayBuffer> => {
	// zstddec doesn't report errors; a failed frame shows up as a short or empty result
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- zstddec returns a slice of its wasm heap
	const raw = decoder.decode(frame, rawLength ?? 0) as Uint8Array<ArrayBuffer>;
	if (rawLength === undefined ? raw.byteLength === 0 : raw.byteLength !== rawLength) {
		throw new Error(`zstd frame decoded to ${raw.byteLength} bytes, expected ${rawLength ?? 'more'}`);
	}
	return raw;
};
