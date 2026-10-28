import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { Component, DrawFlags, parseInitChunk, readChunkEntities } from './init-chunk-data.ts';

// #region synthetic FlatBuffer writer

/** forward-only writer: everything a table references is written after it, so uoffsets stay positive */
class Writer {
	bytes = new Uint8Array(1 << 16);
	view = new DataView(this.bytes.buffer);
	pos = 0;

	reserve(size: number, align = 4): number {
		this.pos = Math.ceil(this.pos / align) * align;
		const at = this.pos;
		this.pos += size;
		return at;
	}

	/** writes a vtable + table; returns the table position and each field's position (`-1` if absent) */
	table(sizes: number[]): { at: number; fields: number[] } {
		const vtable = this.reserve(4 + sizes.length * 2, 2);
		const offsets: number[] = [];
		let cursor = 4;
		for (const size of sizes) {
			if (size === 0) {
				offsets.push(0);
				continue;
			}
			cursor = Math.ceil(cursor / Math.min(size, 4)) * Math.min(size, 4);
			offsets.push(cursor);
			cursor += size;
		}
		const at = this.reserve(cursor, 4);
		this.view.setUint16(vtable, 4 + sizes.length * 2, true);
		this.view.setUint16(vtable + 2, cursor, true);
		offsets.forEach((offset, i) => this.view.setUint16(vtable + 4 + i * 2, offset, true));
		this.view.setInt32(at, at - vtable, true);
		return { at, fields: offsets.map((offset) => (offset === 0 ? -1 : at + offset)) };
	}

	/** writes `u32 length` + elements; returns the vector position and element start */
	vector(elementSize: number, length: number): { at: number; start: number } {
		const at = this.reserve(4 + elementSize * length, 4);
		this.view.setUint32(at, length, true);
		return { at, start: at + 4 };
	}

	link(at: number, target: number): void {
		this.view.setUint32(at, target - at, true);
	}

	finish(): Uint8Array {
		return this.bytes.slice(0, this.pos);
	}
}

const encoder = new TextEncoder();

/**
 * builds a chunk with one object row per entity and one component group holding them, with components 0–5
 * (bounds), 18 (instance data), 21 (name), 67 (lod ranges), 9 + 69 (two draws)
 */
const buildChunk = (options: { version?: number; drawCount?: number } = {}): Uint8Array => {
	const w = new Writer();
	const ids = [(1 << 27) | 0x123, (2 << 27) | 0x456];
	const names = ['P_rock#1_123', 'P_tree#2_456'];
	const root = w.reserve(4);
	const table = w.table([4, 8, 0, 4, 4, 4, 4, 4]);
	w.link(root, table.at);
	w.view.setUint32(table.fields[0], options.version ?? 49, true);
	w.view.setInt32(table.fields[1], -1152, true);
	w.view.setInt32(table.fields[1] + 4, -1792, true);

	// object vectors
	const idVector = w.vector(4, ids.length);
	w.link(table.fields[3], idVector.at);
	ids.forEach((id, i) => w.view.setUint32(idVector.start + i * 4, id, true));
	const kinds = w.vector(1, ids.length);
	w.link(table.fields[4], kinds.at);
	ids.forEach((_, i) => (w.bytes[kinds.start + i] = 2));
	const rows = w.vector(4, ids.length);
	w.link(table.fields[5], rows.at);
	names.forEach((name, i) => {
		const row = w.table([4]);
		w.link(rows.start + i * 4, row.at);
		const bytes = encoder.encode(name);
		// FlatBuffers strings: the length excludes the trailing NUL
		const vector = w.vector(1, bytes.length);
		w.bytes.set(bytes, vector.start);
		w.reserve(1, 1);
		w.link(row.fields[0], vector.at);
	});

	// group
	const idWrappers = w.vector(4, 1);
	w.link(table.fields[6], idWrappers.at);
	const wrapper = w.table([4]);
	w.link(idWrappers.start, wrapper.at);
	const groupIds = w.vector(4, ids.length);
	w.link(wrapper.fields[0], groupIds.at);
	ids.forEach((id, i) => w.view.setUint32(groupIds.start + i * 4, id, true));

	const groups = w.vector(4, 1);
	w.link(table.fields[7], groups.at);
	const group = w.table([16, 4, 24, 4, 4]);
	w.link(groups.start, group.at);
	w.view.setUint32(group.fields[1], ids.length, true);

	const descriptors: [number, number][] = [
		[0, 4],
		[1, 4],
		[2, 4],
		[3, 4],
		[4, 4],
		[5, 4],
		[Component.InstanceData, 256],
		[Component.Name, 64],
		[Component.LodRanges, 24],
		[9, 4 + 32 * 2],
		[69, 8 + 40 * 2],
	];
	const descriptorVector = w.vector(8, descriptors.length);
	w.link(group.fields[3], descriptorVector.at);
	descriptors.forEach(([id, stride], i) => {
		w.view.setUint16(descriptorVector.start + i * 8, id, true);
		w.view.setUint16(descriptorVector.start + i * 8 + 2, stride, true);
	});

	const blobWrapper = w.table([4]);
	w.link(group.fields[4], blobWrapper.at);
	const blobSize = descriptors.reduce((sum, [, stride]) => sum + stride * ids.length, 0);
	const blob = w.vector(1, blobSize);
	w.link(blobWrapper.fields[0], blob.at);
	let column = blob.start;
	const drawCount = options.drawCount ?? 2;
	for (const [id, stride] of descriptors) {
		for (let e = 0; e < ids.length; e++) {
			const at = column + e * stride;
			switch (id) {
				case 0:
				case 1:
				case 2:
				case 3:
				case 4:
				case 5: {
					w.view.setFloat32(at, id + e * 10, true);
					break;
				}
				case Component.InstanceData: {
					for (let k = 0; k < 16; k++) {
						w.view.setFloat32(at + k * 4, k % 5 === 0 ? 1 : 0, true);
					}
					w.view.setFloat32(at + 48, 100 + e, true);
					w.view.setFloat32(at + 56, -200 - e, true);
					break;
				}
				case Component.Name: {
					w.bytes.set(encoder.encode('truncated'), at);
					break;
				}
				case Component.LodRanges: {
					w.bytes[at] = 2;
					w.bytes[at + 16] = 1;
					w.bytes[at + 17] = 2;
					break;
				}
				case 9: {
					w.view.setUint32(at, drawCount, true);
					w.bytes[at + 4 + 24 + 2] = 3;
					w.view.setUint32(at + 4 + 24 + 16, DrawFlags.ShadowOnly, true);
					w.view.setFloat32(at + 4 + 48, 3.4e38, true);
					w.view.setFloat32(at + 4 + 48 + 4, 0.25, true);
					w.view.setFloat32(at + 4 + 56, 0.25, true);
					w.view.setFloat32(at + 4 + 56 + 4, -1, true);
					break;
				}
				case 69: {
					w.view.setBigUint64(at, 2n, true);
					w.view.setBigUint64(at + 8, 0x1111n, true);
					w.view.setBigUint64(at + 16, 0x2222n, true);
					w.view.setBigUint64(at + 48, 0x3333n, true);
					w.view.setBigUint64(at + 56, 0x4444n, true);
					break;
				}
			}
		}
		column += stride * ids.length;
	}
	return w.finish();
};

// #endregion

test('parseInitChunk reads root, objects and groups', () => {
	const chunk = parseInitChunk(buildChunk());
	assert.equal(chunk.version, 49);
	assert.deepEqual(chunk.origin, { x: -1152, z: -1792 });
	assert.deepEqual(
		chunk.objects.map((o) => [o.kind, o.name]),
		[
			[2, 'P_rock#1_123'],
			[2, 'P_tree#2_456'],
		],
	);
	assert.equal(chunk.groups.length, 1);
	assert.deepEqual([...chunk.groups[0].ids], [(1 << 27) | 0x123, (2 << 27) | 0x456]);
	assert.equal(chunk.groups[0].bounds, null);
});

test('readChunkEntities decodes transforms, bounds, names and draws', () => {
	const [first, second] = readChunkEntities(parseInitChunk(buildChunk()));
	assert.equal(first.levelTag, 1);
	assert.equal(second.levelTag, 2);
	assert.equal(first.name, 'P_rock#1_123');
	assert.deepEqual(first.bounds, { center: [0, 1, 2], extents: [3, 4, 5] });
	assert.deepEqual(second.bounds?.center, [10, 11, 12]);
	assert.deepEqual([first.matrix?.[12], first.matrix?.[14]], [100, -200]);
	assert.equal(second.matrix?.[12], 101);

	const draws = first.renderer?.draws ?? [];
	assert.equal(first.renderer?.lodCount, 2);
	assert.deepEqual(
		draws.map((d) => [d.materialHash, d.meshHash, d.submesh, d.lod, d.lodMinSquared]),
		[
			[0x1111n, 0x2222n, 0, 0, 0.25],
			[0x3333n, 0x4444n, 3, 1, -1],
		],
	);
	assert.equal(draws[1].flags & DrawFlags.ShadowOnly, DrawFlags.ShadowOnly);
});

test('parseInitChunk rejects unknown versions', () => {
	assert.throws(() => parseInitChunk(buildChunk({ version: 46 })), FormatError);
});

test('readChunkEntities rejects draw counts beyond capacity', () => {
	assert.throws(() => readChunkEntities(parseInitChunk(buildChunk({ drawCount: 3 }))), FormatError);
});
