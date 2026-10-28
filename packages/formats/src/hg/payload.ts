import { FormatError } from '../binary/binary-reader.ts';
import { decodeInvertedLz4Block } from '../binary/lz4.ts';

/**
 * unwraps Hypergryph's compressed-file envelope, used by Streaming-group files and terrain: `u32 decodedSize
 * (little-endian) ‖ inverted LZ4 block`
 *
 * @param packed the logical file as stored
 * @returns the decoded bytes
 * @throws {FormatError} if the size prefix is missing or the LZ4 stream is malformed
 */
export const unpackHgPayload = (packed: Uint8Array): Uint8Array => {
	if (packed.length < 4) {
		throw new FormatError(`${packed.length}-byte payload has no size prefix`);
	}
	const size = new DataView(packed.buffer, packed.byteOffset, 4).getUint32(0, true);
	return decodeInvertedLz4Block(packed.subarray(4), size);
};
