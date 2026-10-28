import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FormatError } from './binary-reader.ts';
import { decodeInvertedLz4Block, decodeInvertedLz4Prefix, decodeLz4Block } from './lz4.ts';

/** one LZ4 sequence: literals, then an optional match */
interface Sequence {
	literals: number[];
	match?: { offset: number; length: number };
}

/** encodes sequences as a standard or inverted LZ4 block, without any end-of-block rules */
const encode = (sequences: Sequence[], inverted: boolean): Uint8Array => {
	const out: number[] = [];
	const lengthBytes = (value: number): void => {
		let rest = value - 15;
		while (rest >= 255) {
			out.push(255);
			rest -= 255;
		}
		out.push(rest);
	};
	for (const { literals, match } of sequences) {
		const lit = Math.min(literals.length, 15);
		const mat = match === undefined ? 0 : Math.min(match.length - 4, 15);
		let token: number;
		if (inverted) {
			// literal length in bits 0,1,4,5; match length in bits 2,3,6,7
			token = (lit & 0b11) | ((mat & 0b11) << 2) | ((lit & 0b1100) << 2) | ((mat & 0b1100) << 4);
		} else {
			token = (lit << 4) | mat;
		}
		out.push(token);
		if (lit === 15) {
			lengthBytes(literals.length);
		}
		out.push(...literals);
		if (match !== undefined) {
			if (inverted) {
				out.push(match.offset >> 8, match.offset & 0xff);
			} else {
				out.push(match.offset & 0xff, match.offset >> 8);
			}
			if (mat === 15) {
				lengthBytes(match.length - 4);
			}
		}
	}
	return new Uint8Array(out);
};

const variants = [
	{ name: 'standard', inverted: false, decode: decodeLz4Block },
	{ name: 'inverted', inverted: true, decode: decodeInvertedLz4Block },
] as const;

for (const { name, inverted, decode } of variants) {
	describe(`${name} lz4`, () => {
		it('decodes a literal-only block', () => {
			const block = encode([{ literals: [1, 2, 3] }], inverted);
			assert.deepEqual(decode(block, 3), new Uint8Array([1, 2, 3]));
		});

		it('decodes extended literal and match lengths', () => {
			const literals = Array.from({ length: 300 }, (_, i) => i & 0xff);
			const block = encode([{ literals, match: { offset: 300, length: 600 } }, { literals: [9] }], inverted);
			const expected = [...literals, ...literals, ...literals, 9];
			assert.deepEqual(decode(block, expected.length), new Uint8Array(expected));
		});

		it('decodes overlapping matches as run-length repeats', () => {
			const block = encode(
				[{ literals: [7, 8], match: { offset: 2, length: 9 } }, { literals: [0] }],
				inverted,
			);
			assert.deepEqual(decode(block, 12), new Uint8Array([7, 8, 7, 8, 7, 8, 7, 8, 7, 8, 7, 0]));
		});

		it('accepts a block that ends on a match', () => {
			const block = encode([{ literals: [5], match: { offset: 1, length: 4 } }], inverted);
			assert.deepEqual(decode(block, 5), new Uint8Array([5, 5, 5, 5, 5]));
		});

		it('decodes a match with a 16-bit offset', () => {
			const literals = Array.from({ length: 0x1234 }, (_, i) => (i * 7) & 0xff);
			const block = encode([{ literals, match: { offset: 0x1234, length: 4 } }], inverted);
			const out = decode(block, literals.length + 4);
			assert.deepEqual(out.subarray(literals.length), new Uint8Array(literals.slice(0, 4)));
		});

		it('rejects offsets reaching before the output start', () => {
			const block = encode([{ literals: [1], match: { offset: 2, length: 4 } }], inverted);
			assert.throws(() => decode(block, 5), FormatError);
		});

		it('rejects output size mismatches', () => {
			const block = encode([{ literals: [1, 2, 3] }], inverted);
			assert.throws(() => decode(block, 4), FormatError);
			assert.throws(() => decode(block, 2), FormatError);
		});
	});
}

describe('decodeInvertedLz4Prefix', () => {
	const block = encode(
		[
			{ literals: [1, 2, 3], match: { offset: 3, length: 6 } },
			{ literals: [9, 9], match: { offset: 1, length: 4 } },
		],
		true,
	);

	it('decodes the whole block when the limits allow', () => {
		const full = decodeInvertedLz4Block(block, 15);
		assert.deepEqual(decodeInvertedLz4Prefix(block, { inputEnd: block.length, outputLength: 100 }), full);
	});

	it('stops once the output limit is reached', () => {
		const prefix = decodeInvertedLz4Prefix(block, { inputEnd: block.length, outputLength: 5 });
		assert.deepEqual(prefix, new Uint8Array([1, 2, 3, 1, 2, 3, 1, 2, 3]));
	});

	it('never reads past the input limit', () => {
		// token + 2 of the 3 literals
		assert.deepEqual(
			decodeInvertedLz4Prefix(block, { inputEnd: 3, outputLength: 100 }),
			new Uint8Array([1, 2]),
		);
		// the first sequence's match offset is cut off
		assert.deepEqual(
			decodeInvertedLz4Prefix(block, { inputEnd: 5, outputLength: 100 }),
			new Uint8Array([1, 2, 3]),
		);
	});

	it('stops at a match reaching before the output start', () => {
		const bad = encode([{ literals: [1], match: { offset: 2, length: 4 } }], true);
		assert.deepEqual(
			decodeInvertedLz4Prefix(bad, { inputEnd: bad.length, outputLength: 100 }),
			new Uint8Array([1]),
		);
	});
});

it('distinguishes the two token layouts', () => {
	// the standard decoder reads token 0x31 as 3 literals, the inverted one as 13, which overruns the block
	const standard = encode([{ literals: [1, 2, 3], match: { offset: 3, length: 4 } }], false);
	assert.deepEqual(decodeLz4Block(standard, 7), new Uint8Array([1, 2, 3, 1, 2, 3, 1]));
	assert.throws(() => decodeInvertedLz4Block(standard, 7), FormatError);
});
