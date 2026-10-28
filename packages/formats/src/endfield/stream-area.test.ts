import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FormatError } from '../binary/binary-reader.ts';

import { parseStreamAreas, triggerContains, visibleAreasAt } from './stream-area.ts';

// #region synthetic FlatBuffer writer

/** forward-only writer: referenced data follows its referrer, so uoffsets stay positive */
class Writer {
	bytes = new Uint8Array(1 << 12);
	view = new DataView(this.bytes.buffer);
	pos = 0;

	reserve(size: number, align = 4): number {
		this.pos = Math.ceil(this.pos / align) * align;
		const at = this.pos;
		this.pos += size;
		return at;
	}

	/** vtable + table with 4-byte (or larger inline) fields; returns field positions (`-1` if absent) */
	table(sizes: number[]): { at: number; fields: number[] } {
		const vtable = this.reserve(4 + sizes.length * 2, 2);
		const offsets: number[] = [];
		let cursor = 4;
		for (const size of sizes) {
			offsets.push(size === 0 ? 0 : cursor);
			cursor += size;
		}
		const at = this.reserve(cursor);
		this.view.setUint16(vtable, 4 + sizes.length * 2, true);
		this.view.setUint16(vtable + 2, cursor, true);
		offsets.forEach((offset, i) => this.view.setUint16(vtable + 4 + i * 2, offset, true));
		this.view.setInt32(at, at - vtable, true);
		return { at, fields: offsets.map((offset) => (offset === 0 ? -1 : at + offset)) };
	}

	/** writes `values` as a vector of `width`-word elements and links it from `field` */
	vector(field: number, values: number[], options: { kind?: 'i32' | 'f32'; width?: number } = {}): void {
		const { kind = 'i32', width = 1 } = options;
		const at = this.reserve(4 + values.length * 4);
		this.view.setUint32(at, values.length / width, true);
		values.forEach((value, i) => {
			if (kind === 'i32') {
				this.view.setInt32(at + 4 + i * 4, value, true);
			} else {
				this.view.setFloat32(at + 4 + i * 4, value, true);
			}
		});
		this.view.setUint32(field, at - field, true);
	}

	finish(): Uint8Array {
		return this.bytes.slice(0, this.pos);
	}
}

// #endregion

const square = [
	[0, 0],
	[10, 0],
	[10, 10],
	[0, 10],
].flat();

/** one trigger zone (id 9, a 10 m square at heights 0–5) revealing area 7 */
const build = (options: { badSlice?: boolean } = {}): Uint8Array => {
	const w = new Writer();
	const root = w.reserve(4);
	const table = w.table([4, 4, 4, 24, 4, 4, 4]);
	w.view.setUint32(root, table.at - root, true);
	const [totalAreas, rootVisible, groups, bounds, areas, triggers, points] = table.fields;
	[-50, -50, 50, 50, -10, 100].forEach((value, i) => w.view.setFloat32(bounds + i * 4, value, true));
	w.vector(totalAreas, [0, 7, 8, 9]);
	w.vector(rootVisible, [0, 8]);
	w.vector(groups, [0, 7]);
	// Area { id, visibleStart, visibleNum }
	w.vector(areas, [9, 0, options.badSlice ? 3 : 2], { width: 3 });
	// Trigger { id, pointStart, pointNum, Bounds }; floats are written as their bit patterns
	const trigger = [9, 0, 4, ...[0, 0, 10, 10, 0, 5].map(floatBits)];
	w.vector(triggers, trigger, { width: 9 });
	w.vector(points, square, { kind: 'f32', width: 2 });
	return w.finish();
};

const floatBits = (value: number): number => {
	const view = new DataView(new ArrayBuffer(4));
	view.setFloat32(0, value, true);
	return view.getInt32(0, true);
};

test('parses areas, visible slices and trigger polygons', () => {
	const table = parseStreamAreas(build());
	assert.deepEqual(table.totalAreas, [0, 7, 8, 9]);
	assert.deepEqual(table.rootVisible, [0, 8]);
	assert.deepEqual(table.visibleWhileInside.get(9), [0, 7]);
	assert.equal(table.triggers.length, 1);
	assert.equal(table.triggers[0].areaId, 9);
	assert.deepEqual(table.triggers[0].polygon[2], { x: 10, z: 10 });
	assert.deepEqual(table.triggers[0].bounds, {
		min: { x: 0, z: 0 },
		max: { x: 10, z: 10 },
		minHeight: 0,
		maxHeight: 5,
	});
	assert.equal(table.bounds.maxHeight, 100);
});

test('visible areas switch from the root set to the zone slice inside a trigger', () => {
	const table = parseStreamAreas(build());
	assert.deepEqual([...visibleAreasAt(table, { x: 5, y: 1, z: 5 })], [0, 7]);
	assert.deepEqual([...visibleAreasAt(table, { x: 20, y: 1, z: 5 })], [0, 8]);
	// above the trigger's height range
	assert.equal(triggerContains(table.triggers[0], { x: 5, y: 6, z: 5 }), false);
});

test('rejects a visible slice past the group vector', () => {
	assert.throws(() => parseStreamAreas(build({ badSlice: true })), FormatError);
});
