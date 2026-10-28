import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fromHex, toHex } from '../binary/binary-reader.ts';

import { applyBundlePad, deriveBundlePad } from './bundle-cipher.ts';

/** the standard AES S-box, computed (multiplicative inverse in GF(2^8), then the affine map) */
const aesSbox = (): Uint8Array => {
	const sbox = new Uint8Array(256);
	const multiply = (a: number, b: number): number => {
		let product = 0;
		for (let i = 0; i < 8; i++) {
			if (b & 1) {
				product ^= a;
			}
			a = a & 0x80 ? ((a << 1) ^ 0x11b) & 0xff : a << 1;
			b >>= 1;
		}
		return product;
	};
	for (let x = 0; x < 256; x++) {
		// 0 has no inverse and maps to 0 by convention
		let inverse = 0;
		for (let y = 1; y < 256; y++) {
			if (multiply(x, y) === 1) {
				inverse = y;
				break;
			}
		}
		let s = inverse;
		for (let shift = 1; shift <= 4; shift++) {
			s ^= ((inverse << shift) | (inverse >> (8 - shift))) & 0xff;
		}
		sbox[x] = s ^ 0x63;
	}
	return sbox;
};

/** a pad whose byte i is distinct from every other, to make sampled positions visible */
const testPad = (): Uint8Array => Uint8Array.from({ length: 256 }, (_, i) => (i * 13 + 1) & 0xff);

describe('deriveBundlePad', () => {
	it('starts with AES-128 of the iv when given the standard S-box', () => {
		// FIPS-197 appendix C.1
		const pad = deriveBundlePad({
			sbox: aesSbox(),
			key: fromHex('000102030405060708090a0b0c0d0e0f'),
			iv: fromHex('00112233445566778899aabbccddeeff'),
			chainXor: 0n,
		});
		assert.equal(pad.length, 256);
		assert.equal(toHex(pad.subarray(0, 16)), '69C4E0D86A7B0430D8CDB78070B4C55A');
	});
});

describe('applyBundlePad', () => {
	it('XORs short buffers whole', () => {
		const pad = testPad();
		const buffer = new Uint8Array(100);
		applyBundlePad(buffer, pad);
		assert.deepEqual(buffer, pad.subarray(0, 100));
	});

	it('samples the start of each 16-byte block in longer buffers', () => {
		const pad = testPad();
		// 1000 bytes = 62 blocks, so 256 / 62 = 4 bytes per block
		const buffer = new Uint8Array(1000);
		applyBundlePad(buffer, pad);
		for (let i = 0; i < buffer.length; i++) {
			const block = Math.floor(i / 16);
			const within = i % 16;
			const expected = block < 62 && within < 4 ? pad[block * 4 + within] : 0;
			assert.equal(buffer[i], expected, `byte ${i}`);
		}
	});

	it('touches one byte in each of the first 256 blocks of large buffers', () => {
		const pad = testPad();
		const buffer = new Uint8Array(16 * 600);
		applyBundlePad(buffer, pad);
		for (let i = 0; i < buffer.length; i++) {
			const block = i / 16;
			const expected = i % 16 === 0 && block < 256 ? pad[block] : 0;
			assert.equal(buffer[i], expected, `byte ${i}`);
		}
	});

	it('is its own inverse', () => {
		const pad = testPad();
		for (const length of [0, 1, 256, 257, 4095, 4096, 70_000]) {
			const original = Uint8Array.from({ length }, (_, i) => (i * 31) & 0xff);
			const buffer = original.slice();
			applyBundlePad(buffer, pad);
			applyBundlePad(buffer, pad);
			assert.deepEqual(buffer, original, `length ${length}`);
		}
	});
});
