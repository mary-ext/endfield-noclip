import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FormatError } from './binary-reader.ts';
import {
	AES_SBOX,
	bytesEqual,
	dataSections,
	findBytePermutations,
	offsetToRva,
	parsePe,
	type PeSection,
} from './pe.ts';

/** builds a minimal PE32+ image with the given sections, enough for the parser and the scanners */
const buildPe = (
	imageBase: bigint,
	sections: { name: string; rva: number; characteristics: number; body: Uint8Array }[],
): Uint8Array => {
	const headerSize = 0x200;
	const total = headerSize + sections.reduce((sum, s) => sum + s.body.length, 0);
	const data = new Uint8Array(total);
	const view = new DataView(data.buffer);
	data[0] = 0x4d;
	data[1] = 0x5a;
	const peOffset = 0x80;
	view.setUint32(0x3c, peOffset, true);
	view.setUint32(peOffset, 0x0000_4550, true);
	view.setUint16(peOffset + 6, sections.length, true);
	const optionalSize = 240;
	view.setUint16(peOffset + 20, optionalSize, true);
	const optional = peOffset + 24;
	view.setUint16(optional, 0x020b, true);
	view.setBigUint64(optional + 24, imageBase, true);

	let raw = headerSize;
	const table = optional + optionalSize;
	for (const [i, section] of sections.entries()) {
		const base = table + 40 * i;
		for (let j = 0; j < section.name.length; j++) {
			data[base + j] = section.name.charCodeAt(j);
		}
		view.setUint32(base + 8, section.body.length, true);
		view.setUint32(base + 12, section.rva, true);
		view.setUint32(base + 16, section.body.length, true);
		view.setUint32(base + 20, raw, true);
		view.setUint32(base + 36, section.characteristics, true);
		data.set(section.body, raw);
		raw += section.body.length;
	}
	return data;
};

describe('AES_SBOX', () => {
	it('matches the standard Rijndael table', () => {
		assert.equal(AES_SBOX[0], 0x63);
		assert.deepEqual([...AES_SBOX.subarray(0, 4)], [0x63, 0x7c, 0x77, 0x7b]);
		assert.equal(AES_SBOX[255], 0x16);
		assert.equal(new Set(AES_SBOX).size, 256);
	});
});

describe('parsePe', () => {
	it('reads the image base and section table', () => {
		const body = new Uint8Array(16).fill(0xaa);
		const image = parsePe(
			buildPe(0x1_8000_0000n, [{ name: '.data', rva: 0x1000, characteristics: 0xc000_0040, body }]),
		);
		assert.equal(image.imageBase, 0x1_8000_0000n);
		assert.equal(image.sections.length, 1);
		assert.equal(image.sections[0].name, '.data');
		assert.equal(offsetToRva(image, image.sections[0].rawOffset), 0x1000);
	});

	it('rejects non-PE input', () => {
		assert.throws(() => parsePe(new Uint8Array(64)), FormatError);
	});
});

describe('dataSections', () => {
	it('keeps initialized data, drops code', () => {
		const sections: { name: string; rva: number; characteristics: number; body: Uint8Array }[] = [
			{ name: '.text', rva: 0x1000, characteristics: 0x6000_0020, body: new Uint8Array(16) },
			{ name: '.rdata', rva: 0x2000, characteristics: 0x4000_0040, body: new Uint8Array(16) },
		];
		const names = dataSections(parsePe(buildPe(0n, sections))).map((section: PeSection) => section.name);
		assert.deepEqual(names, ['.rdata']);
	});
});

describe('findBytePermutations', () => {
	it('finds exactly the 256-byte permutation window, padding excluded', () => {
		const permutation = Uint8Array.from({ length: 256 }, (_, i) => (i * 7 + 13) & 0xff);
		assert.equal(new Set(permutation).size, 256, 'test fixture must be a permutation');
		const data = new Uint8Array(400);
		data.set(permutation, 32);
		const hits = findBytePermutations(data, 0, data.length);
		assert.deepEqual(hits, [32]);
	});

	it('returns nothing when no window is a permutation', () => {
		assert.deepEqual(findBytePermutations(new Uint8Array(1000), 0, 1000), []);
	});
});

describe('bytesEqual', () => {
	it('compares contents, not identity', () => {
		assert.ok(bytesEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3)));
		assert.ok(!bytesEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4)));
		assert.ok(!bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3)));
	});
});
