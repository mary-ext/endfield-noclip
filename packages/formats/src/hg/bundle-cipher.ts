/**
 * Endfield's bundle block cipher.
 *
 * it's AES-128 encryption with a custom S-box, run in an OFB-like chain whose next IV comes from the
 * keystream rather than the ciphertext. it only ever touches the first 256 bytes' worth of sampled positions,
 * so the whole cipher reduces to one fixed 256-byte XOR pad plus a sampling rule. the pad is derived once
 * from user-supplied key material.
 */

/** key material for {@link deriveBundlePad} */
export interface BundleCipherParams {
	/** 256-byte substitution box */
	sbox: Uint8Array;
	/** 16-byte AES key */
	key: Uint8Array;
	/** 16-byte initial chain value */
	iv: Uint8Array;
	/** 64-bit constant mixed into each chain step */
	chainXor: bigint;
}

/**
 * @param params cipher key material
 * @returns the 256-byte XOR pad shared by every bundle
 */
export const deriveBundlePad = (params: BundleCipherParams): Uint8Array => {
	const { sbox, key, iv, chainXor } = params;
	const roundKeys = expandKey(key, sbox);
	const pad = new Uint8Array(256);
	let previous = iv;
	for (let block = 0; block < 16; block++) {
		const out = encryptBlock(previous, roundKeys, sbox);
		pad.set(out, block * 16);
		const next = new Uint8Array(16);
		for (let i = 0; i < 16; i++) {
			const mix = Number((chainXor >> BigInt((8 * i) & 0x38)) & 0xffn);
			const t = (out[i] ^ ((31 * i) & 0xff) ^ mix) & 0xff;
			next[i] = sbox[((t >> 5) | (t << 3)) & 0xff];
		}
		previous = next;
	}
	return pad;
};

/**
 * XORs the sampled positions of `buffer` with the pad, in place. the operation is its own inverse. buffers of
 * up to 256 bytes are XORed whole; longer ones get `256 / blocks` bytes XORed at the start of each of their
 * first 256 sixteen-byte blocks.
 *
 * @param buffer data to transform; mutated
 * @param pad result of {@link deriveBundlePad}
 */
export const applyBundlePad = (buffer: Uint8Array, pad: Uint8Array): void => {
	const length = buffer.length;
	if (length <= 256) {
		for (let i = 0; i < length; i++) {
			buffer[i] ^= pad[i];
		}
		return;
	}
	const blocks = Math.floor(length / 16);
	const step = blocks > 256 ? 1 : Math.floor(256 / blocks);
	const count = Math.min(blocks, 256);
	for (let i = 0; i < count; i++) {
		for (let j = 0; j < step; j++) {
			buffer[i * 16 + j] ^= pad[i * step + j];
		}
	}
};

// #region AES-128 with a substitutable S-box

const xtime = (a: number): number => {
	return a & 0x80 ? ((a << 1) ^ 0x1b) & 0xff : a << 1;
};

const expandKey = (key: Uint8Array, sbox: Uint8Array): Uint8Array[] => {
	const rcon = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
	const words = new Uint8Array(176);
	words.set(key);
	for (let i = 4, r = 1; i < 44; i++) {
		const w = words.slice((i - 1) * 4, i * 4);
		if (i % 4 === 0) {
			const first = w[0];
			w[0] = sbox[w[1]] ^ rcon[r++];
			w[1] = sbox[w[2]];
			w[2] = sbox[w[3]];
			w[3] = sbox[first];
		}
		for (let k = 0; k < 4; k++) {
			words[i * 4 + k] = w[k] ^ words[(i - 4) * 4 + k];
		}
	}
	return Array.from({ length: 11 }, (_, round) => words.subarray(round * 16, round * 16 + 16));
};

const encryptBlock = (input: Uint8Array, roundKeys: Uint8Array[], sbox: Uint8Array): Uint8Array => {
	// column-major state matching the input byte order. copied explicitly, since a node Buffer's slice() is a view
	const s = Uint8Array.from(input.subarray(0, 16));
	const addRoundKey = (k: Uint8Array): void => {
		for (let i = 0; i < 16; i++) {
			s[i] ^= k[i];
		}
	};
	const subBytes = (): void => {
		for (let i = 0; i < 16; i++) {
			s[i] = sbox[s[i]];
		}
	};
	const shiftRows = (): void => {
		const t = s.slice();
		for (let c = 0; c < 4; c++) {
			for (let r = 1; r < 4; r++) {
				s[c * 4 + r] = t[((c + r) % 4) * 4 + r];
			}
		}
	};
	const mixColumns = (): void => {
		for (let c = 0; c < 4; c++) {
			const a0 = s[c * 4];
			const a1 = s[c * 4 + 1];
			const a2 = s[c * 4 + 2];
			const a3 = s[c * 4 + 3];
			const t = a0 ^ a1 ^ a2 ^ a3;
			s[c * 4] = a0 ^ t ^ xtime(a0 ^ a1);
			s[c * 4 + 1] = a1 ^ t ^ xtime(a1 ^ a2);
			s[c * 4 + 2] = a2 ^ t ^ xtime(a2 ^ a3);
			s[c * 4 + 3] = a3 ^ t ^ xtime(a3 ^ a0);
		}
	};

	addRoundKey(roundKeys[0]);
	for (let round = 1; round < 10; round++) {
		subBytes();
		shiftRows();
		mixColumns();
		addRoundKey(roundKeys[round]);
	}
	subBytes();
	shiftRows();
	addRoundKey(roundKeys[10]);
	return s;
};

// #endregion
