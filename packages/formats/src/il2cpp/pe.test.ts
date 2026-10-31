import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { PeImage } from './pe.ts';

/** a PE32+ image with one `.data` section at RVA 0x2000, raw at file offset 0x400 */
const image = (): Uint8Array => {
	const bytes = new Uint8Array(0x600);
	const view = new DataView(bytes.buffer);
	view.setUint16(0, 0x5a4d, true);
	const pe = 0x80;
	view.setUint32(0x3c, pe, true);
	view.setUint32(pe, 0x4550, true);
	view.setUint16(pe + 6, 1, true);
	view.setUint16(pe + 20, 0xf0, true);
	view.setUint16(pe + 24, 0x20b, true);
	view.setBigUint64(pe + 24 + 24, 0x180000000n, true);
	const section = pe + 24 + 0xf0;
	bytes.set(new TextEncoder().encode('.data'), section);
	view.setUint32(section + 8, 0x300, true);
	view.setUint32(section + 12, 0x2000, true);
	view.setUint32(section + 16, 0x200, true);
	view.setUint32(section + 20, 0x400, true);
	view.setBigUint64(0x410, 0x1234n, true);
	return bytes;
};

test('maps virtual addresses to file offsets within raw section data', () => {
	const pe = new PeImage(image());
	assert.deepEqual(
		pe.sections.map(({ name, address, rawOffset }) => [name, address, rawOffset]),
		[['.data', 0x2000, 0x400]],
	);
	assert.equal(pe.offsetOf(0x180002010n), 0x410);
	assert.equal(pe.u64(0x180002010n), 0x1234n);
	// past the raw data (virtual size is larger) and before the image
	assert.equal(pe.offsetOf(0x180002200n), undefined);
	assert.equal(pe.offsetOf(0x17fffffffn), undefined);
	assert.throws(() => pe.at(0x180002200n), FormatError);
	assert.throws(() => new PeImage(new Uint8Array(0x100)), FormatError);
});
