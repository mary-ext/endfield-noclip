import { promisify } from 'node:util';
import { constants, zstdCompress, zstdCompressSync } from 'node:zlib';

const zstdCompressAsync = promisify(zstdCompress);

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
	const packed = await zstdCompressAsync(data, atLevel(level));
	return new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength);
};
