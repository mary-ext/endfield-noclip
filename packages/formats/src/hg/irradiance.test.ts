import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { IRRADIANCE_INDEX_MAGIC, parseIrradianceIndex } from './irradiance.ts';

const fixture = () => {
	const bytes: number[] = [];
	const word = (value: number) => {
		const at = bytes.length;
		bytes.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24);
		return at;
	};
	const string = (value: string) => {
		word(value.length * 2);
		for (const char of value) {
			const code = char.charCodeAt(0);
			bytes.push(code & 255, code >>> 8);
		}
	};
	word(IRRADIANCE_INDEX_MAGIC);
	word(1);
	string('scenario');
	word(2);
	word(0);
	word(0);
	word(123);
	word(1);
	const member = word(0);
	word(2);
	string('iv_123_0.bytes');
	string('iv_0_0.bytes');
	word(1);
	word(1);
	word(0);
	word(0);
	word(3);
	const rows: number[] = [];
	// records are interleaved, and file 1 precedes file 0: order and offset resets cannot identify files.
	for (const [key, file, offset] of [
		[1, 1, 0],
		[2, 0, 0],
		[3, 1, 16],
	]) {
		rows.push(bytes.length);
		for (const value of [key, 0, offset, 16, 16, 8, 8, (7 << 16) | file, 0]) {
			word(value);
		}
	}
	word(1);
	for (let i = 0; i < 5; i++) {
		word(0);
	}
	return { bytes: Uint8Array.from(bytes), rows, member };
};

test('irradiance frames scenario groups and uses explicit file indices', () => {
	const index = parseIrradianceIndex(fixture().bytes);
	assert.deepEqual(index.scenarioGroups, [
		{ hash: 0, scenarios: [] },
		{ hash: 123, scenarios: [0] },
	]);
	assert.deepEqual(index.fileGroups, [1, 0]);
	assert.deepEqual(
		index.records.map(({ file, offset }) => [file, offset]),
		[
			[1, 0],
			[0, 0],
			[1, 16],
		],
	);
});

test('irradiance rejects invalid scenario indices without scanning ahead for filenames', () => {
	const { bytes, member } = fixture();
	new DataView(bytes.buffer).setUint32(member, 1, true);
	assert.throws(() => parseIrradianceIndex(bytes), FormatError);
});

test('irradiance rejects missing files, gaps, overlaps and empty records', () => {
	for (const [row, field, value] of [
		[0, 7, 2],
		[0, 2, 8],
		[2, 2, 8],
		[2, 2, 32],
		[0, 3, 0],
	]) {
		const { bytes, rows } = fixture();
		new DataView(bytes.buffer).setUint32(rows[row] + field * 4, value, true);
		assert.throws(() => parseIrradianceIndex(bytes), FormatError);
	}
});

test('irradiance accepts the older scene magic and rejects others', () => {
	for (const [magic, accepted] of [
		[0x03000003, true],
		[0x03000002, false],
		[0x01000043, false],
	] as const) {
		const { bytes } = fixture();
		new DataView(bytes.buffer).setUint32(0, magic, true);
		if (accepted) {
			assert.equal(parseIrradianceIndex(bytes).records.length, 3);
		} else {
			assert.throws(() => parseIrradianceIndex(bytes), FormatError);
		}
	}
});

test("irradiance moves the older magic's keys to the shared origin", () => {
	const key = ((2 << 24) | (60 << 16) | (67 << 8) | 62) >>> 0;
	for (const [magic, expected] of [
		[0x03000003, ((2 << 24) | (124 << 16) | (131 << 8) | 126) >>> 0],
		[IRRADIANCE_INDEX_MAGIC, key],
	] as const) {
		const { bytes, rows } = fixture();
		const view = new DataView(bytes.buffer);
		view.setUint32(0, magic, true);
		view.setUint32(rows[0], key, true);
		assert.equal(parseIrradianceIndex(bytes).records[0].key, expected);
	}
});

test('irradiance requires the final table and exact EOF', () => {
	const { bytes } = fixture();
	assert.throws(() => parseIrradianceIndex(bytes.subarray(0, bytes.length - 4)), FormatError);
	assert.throws(() => parseIrradianceIndex(Uint8Array.from([...bytes, 0])), FormatError);
});
