import { FormatError } from './binary-reader.ts';

/**
 * decodes one raw LZ4 block.
 *
 * Endfield's encoder may end a block on a match, which strict decoders (liblz4) reject, so this decoder
 * doesn't enforce the "last 5 bytes are literals" rule.
 *
 * @param src compressed block
 * @param decompressedSize exact expected output size
 * @returns decompressed bytes
 * @throws {FormatError} if the stream is malformed or the output size differs
 */
export const decodeLz4Block = (src: Uint8Array, decompressedSize: number): Uint8Array => {
	return decode(src, decompressedSize, false);
};

/**
 * decodes one "inverted" LZ4 block, used by Endfield bundles, terrain and streaming payloads. the token's
 * nibbles are bit-interleaved (literal length = bits 0,1,4,5; match length = bits 2,3,6,7) and match offsets
 * are big-endian; otherwise it's ordinary LZ4.
 *
 * @see decodeLz4Block for parameters and errors
 */
export const decodeInvertedLz4Block = (src: Uint8Array, decompressedSize: number): Uint8Array => {
	return decode(src, decompressedSize, true);
};

/** limits for {@link decodeInvertedLz4Prefix} */
export interface Lz4PrefixLimits {
	/** input offset at which decoding stops; bytes from here on are never read */
	inputEnd: number;
	/** output length after which decoding stops */
	outputLength: number;
}

/**
 * decodes the start of an inverted-LZ4 block, for when only a prefix of the input can be trusted (e.g. it's
 * only partly decrypted). decoding stops at the input limit, once the output limit is reached, or at the
 * first malformed sequence; a literal run crossing the input limit is cut there.
 *
 * @param src compressed block
 * @param limits where to stop
 * @returns whatever output was decoded, at least `limits.outputLength` bytes when the prefix allows it
 */
export const decodeInvertedLz4Prefix = (src: Uint8Array, limits: Lz4PrefixLimits): Uint8Array => {
	const stop = Math.min(limits.inputEnd, src.length);
	const out: number[] = [];
	let s = 0;
	while (s < stop && out.length < limits.outputLength) {
		const token = src[s++];
		let literalLength = (token & 0b11) | ((token >> 2) & 0b1100);
		let matchLength = ((token >> 2) & 0b11) | ((token >> 4) & 0b1100);
		if (literalLength === 15) {
			let byte: number;
			do {
				if (s >= stop) {
					return Uint8Array.from(out);
				}
				byte = src[s++];
				literalLength += byte;
			} while (byte === 255);
		}
		const literalEnd = Math.min(s + literalLength, stop);
		while (s < literalEnd) {
			out.push(src[s++]);
		}
		if (s + 2 > stop) {
			break;
		}
		const offset = (src[s] << 8) | src[s + 1];
		s += 2;
		if (matchLength === 15) {
			let byte: number;
			do {
				if (s >= stop) {
					return Uint8Array.from(out);
				}
				byte = src[s++];
				matchLength += byte;
			} while (byte === 255);
		}
		matchLength += 4;
		if (offset === 0 || offset > out.length) {
			break;
		}
		let from = out.length - offset;
		for (let i = 0; i < matchLength; i++) {
			out.push(out[from++]);
		}
	}
	return Uint8Array.from(out);
};

const decode = (src: Uint8Array, size: number, inverted: boolean): Uint8Array => {
	const out = new Uint8Array(size);
	const srcLength = src.length;
	let s = 0;
	let d = 0;

	while (s < srcLength) {
		const token = src[s++];
		let literalLength: number;
		let matchLength: number;
		if (inverted) {
			literalLength = (token & 0b11) | ((token >> 2) & 0b1100);
			matchLength = ((token >> 2) & 0b11) | ((token >> 4) & 0b1100);
		} else {
			literalLength = token >> 4;
			matchLength = token & 15;
		}

		if (literalLength === 15) {
			let byte: number;
			do {
				if (s >= srcLength) {
					throw new FormatError('lz4: truncated literal length');
				}
				byte = src[s++];
				literalLength += byte;
			} while (byte === 255);
		}

		if (s + literalLength > srcLength || d + literalLength > size) {
			throw new FormatError('lz4: literal run overflows');
		}
		// short runs dominate; a plain loop beats set() + subarray() allocation there (~2× overall)
		if (literalLength < 32) {
			for (let i = 0; i < literalLength; i++) {
				out[d++] = src[s++];
			}
		} else {
			out.set(src.subarray(s, s + literalLength), d);
			s += literalLength;
			d += literalLength;
		}

		if (s >= srcLength) {
			break;
		}
		if (s + 2 > srcLength) {
			throw new FormatError('lz4: truncated match offset');
		}

		const offset = inverted ? (src[s] << 8) | src[s + 1] : src[s] | (src[s + 1] << 8);
		s += 2;
		if (offset === 0 || offset > d) {
			throw new FormatError(`lz4: invalid match offset ${offset} at output ${d}`);
		}

		if (matchLength === 15) {
			let byte: number;
			do {
				if (s >= srcLength) {
					throw new FormatError('lz4: truncated match length');
				}
				byte = src[s++];
				matchLength += byte;
			} while (byte === 255);
		}
		matchLength += 4;

		if (d + matchLength > size) {
			throw new FormatError('lz4: match overflows output');
		}
		// matches may overlap their own output, so copy byte by byte when they do (and when they're short,
		// for the same reason as literals)
		let from = d - offset;
		if (offset >= matchLength && matchLength >= 32) {
			out.copyWithin(d, from, from + matchLength);
			d += matchLength;
		} else {
			for (let i = 0; i < matchLength; i++) {
				out[d++] = out[from++];
			}
		}
	}

	if (d !== size) {
		throw new FormatError(`lz4: decoded ${d} bytes, expected ${size}`);
	}
	return out;
};
