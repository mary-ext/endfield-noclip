import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSparkTable, SparkType } from './spark-buffer.ts';

/** little byte-buffer builder with natural alignment */
class Buffer {
	bytes: number[] = [];

	get pos(): number {
		return this.bytes.length;
	}
	align(to: number): void {
		while (this.bytes.length % to !== 0) {
			this.bytes.push(0);
		}
	}
	u8(value: number): void {
		this.bytes.push(value);
	}
	u32(value: number): number {
		this.align(4);
		const at = this.pos;
		this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
		return at;
	}
	i64(value: bigint): void {
		this.align(8);
		for (let i = 0n; i < 8n; i++) {
			this.bytes.push(Number((BigInt.asUintN(64, value) >> (i * 8n)) & 0xffn));
		}
	}
	cString(text: string): number {
		const at = this.pos;
		this.bytes.push(...new TextEncoder().encode(text), 0);
		return at;
	}
	patch(at: number, value: number): void {
		this.bytes[at] = value & 0xff;
		this.bytes[at + 1] = (value >>> 8) & 0xff;
		this.bytes[at + 2] = (value >>> 16) & 0xff;
		this.bytes[at + 3] = (value >>> 24) & 0xff;
	}
}

/** a LevelDescTable-like table: string key → bean { id: string, showName: bean I18nText { id: i64, text } } */
const buildBeanTable = (idType: number = SparkType.String): Uint8Array => {
	const b = new Buffer();
	const header = [b.u32(12), b.u32(0), b.u32(0)];

	// types
	b.u32(2);
	b.u8(SparkType.Bean);
	b.u32(0xaaaa);
	b.cString('LevelDescData');
	b.u32(2);
	b.cString('id');
	b.u8(idType);
	b.cString('showName');
	b.u8(SparkType.Bean);
	b.u32(0xbbbb);
	b.u8(SparkType.Bean);
	b.u32(0xbbbb);
	b.cString('I18nText');
	b.u32(2);
	b.cString('id');
	b.u8(SparkType.Int64);
	b.cString('text');
	b.u8(SparkType.String);

	// root
	b.patch(header[1], b.pos);
	b.u8(SparkType.Dictionary);
	b.cString('LevelDescTable');
	b.u8(SparkType.String);
	b.u8(SparkType.Bean);
	b.u32(0xaaaa);

	// strings
	const key = b.cString('map02_lv001');

	// values
	b.align(8);
	const bean = b.u32(key);
	const showPointer = b.u32(0);
	b.align(8);
	b.patch(showPointer, b.pos);
	b.i64(-5n);
	b.u32(0xffffffff);

	// data: one slot with one entry
	b.align(4);
	b.patch(header[2], b.pos);
	b.u32(1);
	const slot = b.u32(0);
	b.u32(1);
	b.patch(slot, b.pos);
	b.u32(key);
	b.u32(bean);
	return new Uint8Array(b.bytes);
};

test('decodes a string-keyed bean table', () => {
	const table = parseSparkTable(buildBeanTable());
	assert.equal(table.name, 'LevelDescTable');
	assert.deepEqual(table.entries, [
		['map02_lv001', { id: 'map02_lv001', showName: { id: -5n, text: null } }],
	]);
});

test('decodes an int64-keyed string table', () => {
	const b = new Buffer();
	const header = [b.u32(12), b.u32(0), b.u32(0)];
	b.u32(0);
	b.patch(header[1], b.pos);
	b.u8(SparkType.Dictionary);
	b.cString('I18nTextTable_EN');
	b.u8(SparkType.Int64);
	b.u8(SparkType.String);
	const hello = b.cString('hello');
	const world = b.cString('world');
	b.align(4);
	b.patch(header[2], b.pos);
	b.u32(2);
	const slot0 = b.u32(0);
	b.u32(2);
	b.u32(0);
	b.u32(0);
	b.patch(slot0, b.pos);
	b.i64(10n);
	b.u32(hello);
	b.i64(12n);
	b.u32(world);
	assert.deepEqual(parseSparkTable(new Uint8Array(b.bytes)).entries, [
		[10n, 'hello'],
		[12n, 'world'],
	]);
});

test('rejects unsupported field types', () => {
	assert.throws(() => parseSparkTable(buildBeanTable(42)), /unsupported spark field type 42/);
});
